import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod,lstat, mkdir, mkdtemp, open, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type Database from 'better-sqlite3';

import { MAX_REVIEW_SOURCE_BYTES, ReviewSourceReason, type ReviewSourceRequest, type ReviewSourceResponse,ReviewSourceStatus } from '../../shared/artifactPreview/reviewSource';
import { ChangeCaptureState, ChangeReviewScope, TURN_CHANGES_PREFIX } from '../../shared/artifactPreview/turnChanges';
import { artifactContentRevision, type ResolvedArtifactOutput } from '../../shared/artifactPreview/workspace';
import { buildWorkspaceChangesArtifact } from '../../shared/artifactPreview/workspaceChanges';
import { parseWorkspaceDiff } from '../../shared/artifactPreview/workspaceDiff';

/** Identity of one admitted user turn. The dispatch ID must stay stable across retries of the same turn. */
export interface TurnChangesDispatch { id: string; coworkSessionId: string; userMessageId: string }

const exec = promisify(execFile);
const MAX_FILES = 30_000;
const MAX_DIRTY_FILES = 500;
const MAX_CAPTURE_FILES = 5000;
const MAX_CAPTURE_BYTES = 64_000_000;
const MAX_DIFF_BYTES = 500_000;
const EntryKind = { Git: 'git', Blob: 'blob', Unknown: 'unknown' } as const;
type Entry = { kind: typeof EntryKind[keyof typeof EntryKind]; hash: string; mode: string; blob?: string };
type Snapshot = { cwd: string; branch: string | null; git: boolean; files: Record<string, Entry>; incomplete: boolean };
type Capture = { dispatch_id: string; session_id: string; user_message_id: string; cwd: string; before_json: string | null; state: string; created_at: number };
type Sources = Record<string, { old?: Entry; next?: Entry; oldPath: string; newPath: string }>;
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const safePath = (root: string, name: string): string => {
  const result = path.resolve(root, name);
  if (!name || name.includes('\0') || !result.startsWith(root + path.sep)) throw new Error('Invalid workspace review path');
  return result;
};
const git = async (cwd: string, args: string[], maxBuffer = 8_000_000): Promise<Buffer> => (await exec('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
  encoding: 'buffer', maxBuffer, timeout: 10_000, windowsHide: true,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
})).stdout;

/** NUL-delimited stdin avoids OS argv limits for large checkouts. Output remains bounded. */
const checkoutAttributes = (cwd: string, names: string[]): Promise<string> => new Promise((resolve, reject) => {
  const child = spawn('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, 'check-attr', '-z', '--stdin', 'filter', 'ident', 'working-tree-encoding'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const chunks: Buffer[] = []; let size = 0;
  const timer = setTimeout(() => { child.kill(); reject(new Error('Workspace attributes timed out')); }, 10_000);
  child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 16_000_000) { child.kill(); reject(new Error('Workspace attributes exceeded limits')); } else chunks.push(chunk); });
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.stdin.on('error', () => {});
  child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(Buffer.concat(chunks).toString()); else reject(new Error('Workspace attributes unavailable')); });
  child.stdin.end(names.join('\0') + '\0');
});

/** Actual bytes, with symlink-parent and replace-during-read checks. Never follows a file symlink. */
async function workspaceBytes(root: string, name: string): Promise<{ bytes: Buffer; mode: string } | null> {
  const file = safePath(root, name);
  const parent = await realpath(path.dirname(file)).catch((error: NodeJS.ErrnoException): null => { if (error.code === 'ENOENT') return null; throw error; });
  if (!parent) return null;
  if (parent !== root && !parent.startsWith(root + path.sep)) throw new Error('Workspace path escaped its root');
  const info = await lstat(file).catch((error: NodeJS.ErrnoException): null => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return null;
  if (info.isSymbolicLink()) return { bytes: await readlink(file, { encoding: 'buffer' }), mode: '120000' };
  if (!info.isFile() || info.size > MAX_REVIEW_SOURCE_BYTES) throw new Error('Workspace source exceeds capture limits');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (before.ino !== info.ino || before.dev !== info.dev || !before.isFile()) throw new Error('Workspace source changed');
    const buffer = Buffer.alloc(MAX_REVIEW_SOURCE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat(); const current = await lstat(file);
    if (length > MAX_REVIEW_SOURCE_BYTES || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || current.ino !== before.ino || current.dev !== before.dev || await realpath(path.dirname(file)) !== parent) throw new Error('Workspace source changed');
    return { bytes: buffer.subarray(0, length), mode: info.mode & 0o111 ? '100755' : '100644' };
  } finally { await handle.close(); }
}

/** Append-only task baselines and versioned reviews; source blobs live outside the user's repository. */
export class TurnChangesStore {
  private pending = new Map<string, Promise<ResolvedArtifactOutput | null>>();
  private active = new Map<string, string>();
  private finishing = new Map<string, Promise<void>>();
  private captureFailures = new Set<string>();
  constructor(private db: Database.Database, private cacheDir: string, private title: () => string = () => 'Turn workspace changes') {
    db.exec(`CREATE TABLE IF NOT EXISTS cowork_change_captures (
      dispatch_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_message_id TEXT NOT NULL, cwd TEXT NOT NULL,
      before_json TEXT, state TEXT NOT NULL, created_at INTEGER NOT NULL, latest_revision TEXT,
      FOREIGN KEY(session_id) REFERENCES cowork_sessions(id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS cowork_change_capture_session ON cowork_change_captures(session_id,created_at);
      CREATE TABLE IF NOT EXISTS cowork_change_reviews (
      artifact_id TEXT NOT NULL, revision TEXT NOT NULL, dispatch_id TEXT NOT NULL, artifact_json TEXT NOT NULL, sources_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(artifact_id,revision), FOREIGN KEY(dispatch_id) REFERENCES cowork_change_captures(dispatch_id) ON DELETE CASCADE);`);
    // After a host restart, do not attribute later external edits to an interrupted task.
    const interrupted = db.prepare('SELECT dispatch_id FROM cowork_change_captures WHERE state IN (?,?)').all(ChangeCaptureState.Active, ChangeCaptureState.Capturing) as { dispatch_id: string }[];
    for (const record of interrupted) this.markIncomplete(record.dispatch_id);
    db.prepare('UPDATE cowork_change_captures SET state = ? WHERE state IN (?,?)').run(ChangeCaptureState.Interrupted, ChangeCaptureState.Active, ChangeCaptureState.Capturing);
  }
  private async blob(bytes: Buffer): Promise<string> {
    const hash = digest(bytes); await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(this.cacheDir, hash), bytes, { flag: 'wx', mode: 0o600 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    return hash;
  }
  private async bytes(root: string, entry?: Entry): Promise<Buffer> {
    if (!entry) return Buffer.alloc(0);
    if (entry.kind === EntryKind.Unknown) throw new Error('Workspace source unavailable');
    if (entry.blob) {
      if (!/^[a-f0-9]{64}$/.test(entry.blob)) throw new Error('Invalid review blob');
      const bytes = await readFile(path.join(this.cacheDir, entry.blob));
      if (bytes.length > MAX_REVIEW_SOURCE_BYTES || digest(bytes) !== entry.blob) throw new Error('Review blob changed');
      return bytes;
    }
    if (!/^[a-f0-9]{40,64}$/.test(entry.hash)) throw new Error('Invalid Git blob');
    const size = Number((await git(root, ['cat-file', '-s', entry.hash])).toString().trim());
    if (size > MAX_REVIEW_SOURCE_BYTES) throw new Error('Workspace source too large');
    return git(root, ['cat-file', 'blob', entry.hash], MAX_REVIEW_SOURCE_BYTES + 1);
  }
  private async snapshot(cwd: string): Promise<Snapshot> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.captureSnapshot(cwd), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Workspace capture timed out')), 8000); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  private async captureSnapshot(cwd: string): Promise<Snapshot> {
    const deadline = Date.now() + 7500;
    const checkBudget = () => { if (Date.now() > deadline) throw new Error('Workspace capture timed out'); };
    let root = await realpath(cwd); let isGit = false; let branch: string | null = null;
    try { root = await realpath((await git(root, ['rev-parse', '--show-toplevel'])).toString().trim()); isGit = true; } catch { /* A plain document folder is supported too. */ }
    const files: Record<string, Entry> = Object.create(null);
    const dirty = new Set<string>(); let incomplete = false; let objectFormat = 'sha1';
    if (isGit) {
      const [index, status, format, branchName, eols] = await Promise.all([
        git(root, ['ls-files', '--stage', '-z']), git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
        git(root, ['rev-parse', '--show-object-format']), git(root, ['symbolic-ref', '--short', 'HEAD']).catch(() => Buffer.from('HEAD')), git(root, ['ls-files', '--eol', '-z']),
      ]);
      objectFormat = format.toString().trim() === 'sha256' ? 'sha256' : 'sha1'; branch = branchName.toString().trim();
      let fileCount = 0;
      for (const item of index.toString().split('\0').filter(Boolean)) {
        const tab = item.indexOf('\t'); const [mode, hash, stage] = item.slice(0, tab).split(' '); const name = item.slice(tab + 1);
        if (++fileCount > MAX_FILES) { incomplete = true; break; }
        files[name] = { kind: mode === '160000' ? EntryKind.Unknown : EntryKind.Git, hash, mode };
        if (stage !== '0') dirty.add(name);
      }
      // The Git index is reusable only where checkout conversion preserves actual bytes.
      for (const entry of eols.toString().split('\0').filter(Boolean)) {
        const tab = entry.indexOf('\t'); const [indexEol, worktreeEol] = entry.slice(0, tab).trim().split(/\s+/);
        if (indexEol?.slice(2) !== worktreeEol?.slice(2)) dirty.add(entry.slice(tab + 1));
      }
      const attrs = Object.keys(files).length ? (await checkoutAttributes(root, Object.keys(files))).split('\0') : [];
      for (let index = 0; index + 2 < attrs.length; index += 3) {
        if (!['unspecified', 'unset'].includes(attrs[index + 2])) dirty.add(attrs[index]);
      }
      const parts = status.toString().split('\0');
      for (let index = 0; index < parts.length; index++) {
        if (!parts[index]) continue;
        const state = parts[index].slice(0, 2); dirty.add(parts[index].slice(3));
        if (/[RC]/.test(state)) dirty.add(parts[++index]);
      }
    } else {
      let directoryCount = 0;
      const walk = async (directory: string, prefix: string): Promise<void> => {
        checkBudget(); if (++directoryCount > 2000) { incomplete = true; return; }
        for (const item of await readdir(directory, { withFileTypes: true })) {
          if (dirty.size >= MAX_FILES) { incomplete = true; return; }
          if (item.isDirectory()) {
            if (!['.git', 'node_modules', '.cache', '.venv'].includes(item.name)) await walk(path.join(directory, item.name), prefix + item.name + '/');
          } else dirty.add(prefix + item.name);
        }
      };
      await walk(root, '');
    }
    let count = 0; let bytes = 0;
    for (const name of dirty) {
      try {
        checkBudget();
        if (++count > MAX_CAPTURE_FILES || bytes > MAX_CAPTURE_BYTES) throw new Error('Workspace capture limit');
        const source = await workspaceBytes(root, name);
        if (!source) { delete files[name]; continue; }
        bytes += source.bytes.length;
        if (bytes > MAX_CAPTURE_BYTES) throw new Error('Workspace capture limit');
        const hash = createHash(objectFormat).update(`blob ${source.bytes.length}\0`).update(source.bytes).digest('hex');
        files[name] = { kind: EntryKind.Blob, mode: source.mode, hash, blob: await this.blob(source.bytes) };
      } catch { files[name] = { kind: EntryKind.Unknown, mode: '', hash: '' }; incomplete = true; }
    }
    return { cwd: root, branch, git: isGit, files, incomplete };
  }
  async begin(dispatch: TurnChangesDispatch, cwd: string): Promise<void> {
    await this.finishing.get(dispatch.coworkSessionId);
    const exists = this.db.prepare('SELECT 1 FROM cowork_change_captures WHERE dispatch_id = ?').get(dispatch.id);
    if (exists) return;
    this.db.prepare('INSERT INTO cowork_change_captures(dispatch_id,session_id,user_message_id,cwd,before_json,state,created_at) VALUES (?,?,?,?,?,?,?)').run(dispatch.id, dispatch.coworkSessionId, dispatch.userMessageId, cwd, null, ChangeCaptureState.Capturing, Date.now());
    try {
      // Complete and persist BEFORE admission. Retrying a dispatch never replaces its baseline.
      const before = await this.snapshot(cwd);
      if (this.record(dispatch.id)?.state !== ChangeCaptureState.Capturing) return;
      this.db.prepare('UPDATE cowork_change_captures SET before_json = ?, cwd = ?, state = ? WHERE dispatch_id = ?').run(JSON.stringify(before), before.cwd, ChangeCaptureState.Active, dispatch.id);
      this.active.set(dispatch.coworkSessionId, dispatch.id);
    } catch {
      this.db.prepare('UPDATE cowork_change_captures SET state = ? WHERE dispatch_id = ?').run(ChangeCaptureState.Unavailable, dispatch.id);
    }
  }
  cancelPending(sessionId: string, dispatchId?: string): void {
    // A cancelled preflight must not become active after its asynchronous read completes.
    this.db.prepare('UPDATE cowork_change_captures SET state=? WHERE session_id=? AND state=? AND (? IS NULL OR dispatch_id=?)').run(ChangeCaptureState.Interrupted, sessionId, ChangeCaptureState.Capturing, dispatchId ?? null, dispatchId ?? null);
  }
  /** Drop every capture and review of a deleted session. Cached blobs are content addressed and may be shared. */
  async remove(sessionId: string): Promise<void> {
    this.cancelPending(sessionId);
    this.active.delete(sessionId);
    await this.finishing.get(sessionId);
    this.db.prepare('DELETE FROM cowork_change_reviews WHERE dispatch_id IN (SELECT dispatch_id FROM cowork_change_captures WHERE session_id=?)').run(sessionId);
    this.db.prepare('DELETE FROM cowork_change_captures WHERE session_id=?').run(sessionId);
  }
  private record(id: string): Capture | undefined { return this.db.prepare('SELECT * FROM cowork_change_captures WHERE dispatch_id = ?').get(id) as Capture | undefined; }
  private saved(id: string): ResolvedArtifactOutput | null {
    const row = this.db.prepare('SELECT r.artifact_json FROM cowork_change_reviews r JOIN cowork_change_captures c ON c.dispatch_id=r.dispatch_id AND c.latest_revision=r.revision WHERE c.dispatch_id = ?').get(id) as { artifact_json: string } | undefined;
    return row ? JSON.parse(row.artifact_json) : null;
  }
  async latest(sessionId: string): Promise<ResolvedArtifactOutput | null> {
    const record = this.db.prepare('SELECT * FROM cowork_change_captures WHERE session_id = ? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(sessionId) as Capture | undefined;
    if (!record) return null;
    return record.state === ChangeCaptureState.Active ? this.refresh(record.dispatch_id) : this.saved(record.dispatch_id);
  }
  finish(sessionId: string, dispatchId?: string): Promise<void> {
    const id = this.active.get(sessionId);
    if (dispatchId && id !== dispatchId) return Promise.resolve();
    if (!id) return this.finishing.get(sessionId) ?? Promise.resolve();
    this.active.delete(sessionId);
    const operation = (async () => {
      await this.pending.get(id);
      await this.refresh(id);
      this.db.prepare('UPDATE cowork_change_captures SET state = ? WHERE dispatch_id = ?').run(this.captureFailures.has(id) ? ChangeCaptureState.Interrupted : ChangeCaptureState.Completed, id);
    })().finally(() => { if (this.finishing.get(sessionId) === operation) this.finishing.delete(sessionId); });
    this.finishing.set(sessionId, operation);
    return operation;
  }
  private markIncomplete(id: string): ResolvedArtifactOutput | null {
    const artifact = this.saved(id); if (!artifact?.workspaceChanges) return null;
    const prior = this.db.prepare('SELECT sources_json FROM cowork_change_reviews WHERE artifact_id=? AND revision=?').get(artifact.id, artifactContentRevision(artifact)) as { sources_json: string };
    artifact.workspaceChanges = { ...artifact.workspaceChanges, statsIncomplete: true, captureIncomplete: true };
    artifact.contentVersion = parseInt(digest(JSON.stringify(artifact.workspaceChanges) + '\n' + artifact.content).slice(0, 13), 16);
    this.db.prepare('INSERT OR IGNORE INTO cowork_change_reviews VALUES (?,?,?,?,?,?)').run(artifact.id, artifactContentRevision(artifact), id, JSON.stringify(artifact), prior.sources_json, Date.now());
    this.db.prepare('UPDATE cowork_change_captures SET latest_revision=? WHERE dispatch_id=?').run(artifactContentRevision(artifact), id);
    return artifact;
  }
  private refresh(id: string): Promise<ResolvedArtifactOutput | null> {
    const existing = this.pending.get(id); if (existing) return existing;
    const task = this.build(id).then(artifact => { this.captureFailures.delete(id); return artifact; }).catch(() => { this.captureFailures.add(id); return this.markIncomplete(id); }).finally(() => this.pending.delete(id));
    this.pending.set(id, task); return task;
  }
  private async build(id: string): Promise<ResolvedArtifactOutput | null> {
    const record = this.record(id); if (!record?.before_json) return null;
    const before = JSON.parse(record.before_json) as Snapshot; const after = await this.snapshot(record.cwd);
    if (before.cwd !== after.cwd) throw new Error('Workspace review root changed');
    const names = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].filter(name => {
      const a = before.files[name]; const b = after.files[name];
      return a?.hash !== b?.hash || a?.mode !== b?.mode || a?.kind === EntryKind.Unknown || b?.kind === EntryKind.Unknown;
    });
    const dir = await mkdtemp(path.join(tmpdir(), 'cowork-turn-review-'));
    const sources: Sources = Object.create(null); let incomplete = before.incomplete || after.incomplete;
    let materializedCount = 0;
    await Promise.all(['a', 'b'].map(side => mkdir(path.join(dir, side))));
    const materialized: Record<string, { old?: Entry; next?: Entry }> = Object.create(null);
    try {
      let total = 0;
      for (const name of names) {
        const old = before.files[name]; const next = after.files[name];
        try {
          if (old?.kind === EntryKind.Unknown || next?.kind === EntryKind.Unknown || materializedCount >= MAX_DIRTY_FILES) throw new Error('Incomplete review');
          const data = await Promise.all([this.bytes(before.cwd, old), this.bytes(after.cwd, next)]);
          total += data[0].length + data[1].length;
          if (total > MAX_CAPTURE_BYTES) throw new Error('Review size limit');
          for (const [index, entry] of [old, next].entries()) {
            if (!entry) continue;
            entry.blob = await this.blob(data[index]); // Freeze clean Git sources before GC or branch changes.
            const file = safePath(path.join(dir, index ? 'b' : 'a'), name); await mkdir(path.dirname(file), { recursive: true });
            if (entry.mode === '120000') await symlink(data[index].toString(), file);
            else { await writeFile(file, data[index]); if (entry.mode === '100755') await chmod(file, 0o755); }
          }
          materialized[name] = { old, next }; materializedCount += 1;
        } catch {
          incomplete = true;
          await Promise.all(['a', 'b'].map(side => rm(safePath(path.join(dir, side), name), { force: true }).catch(() => {})));
        }
      }
      let truncated = false;
      const patch = await git(dir, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=', '--dst-prefix=', '--', 'a', 'b'], MAX_DIFF_BYTES + 1).catch((error: { code?: number | string; stdout?: Buffer }) => {
        if (error.code === 1 && error.stdout) return error.stdout;
        if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && error.stdout) { truncated = true; return error.stdout; }
        throw error;
      });
      const text = patch.subarray(0, MAX_DIFF_BYTES).toString(); truncated ||= patch.length > MAX_DIFF_BYTES;
      const parsed = parseWorkspaceDiff(text); const changedFiles = parsed.files.map(file => {
        sources[file.id] = { old: materialized[file.oldPath ?? file.path]?.old, next: materialized[file.path]?.next, oldPath: file.oldPath ?? file.path, newPath: file.path };
        return { path: file.path, status: file.status, added: file.binary ? null : file.added, removed: file.binary ? null : file.removed };
      });
      const artifact = buildWorkspaceChangesArtifact(record.session_id, this.title(), {
        cwd: before.cwd, branch: before.branch, added: changedFiles.reduce((sum, file) => sum + (file.added ?? 0), 0), removed: changedFiles.reduce((sum, file) => sum + (file.removed ?? 0), 0),
        changedFiles, diff: text, statsIncomplete: incomplete || truncated, truncated,
      });
      artifact.id = TURN_CHANGES_PREFIX + id; artifact.messageId = record.user_message_id; artifact.createdAt = record.created_at;
      artifact.workspaceChanges!.scope = ChangeReviewScope.Turn;
      artifact.contentVersion = parseInt(digest(JSON.stringify(artifact.workspaceChanges) + '\n' + text).slice(0, 13), 16);
      this.db.prepare('INSERT OR IGNORE INTO cowork_change_reviews VALUES (?,?,?,?,?,?)').run(artifact.id, artifactContentRevision(artifact), id, JSON.stringify(artifact), JSON.stringify(sources), Date.now());
      this.db.prepare('UPDATE cowork_change_captures SET latest_revision = ? WHERE dispatch_id = ?').run(artifactContentRevision(artifact), id);
      return artifact;
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  list(sessionId: string): ResolvedArtifactOutput[] {
    const rows = this.db.prepare('SELECT r.artifact_json FROM cowork_change_reviews r JOIN cowork_change_captures c ON c.dispatch_id=r.dispatch_id AND r.revision=c.latest_revision WHERE c.session_id=? ORDER BY c.created_at DESC').all(sessionId) as { artifact_json: string }[];
    return rows.map(row => JSON.parse(row.artifact_json) as ResolvedArtifactOutput).filter(artifact => artifact.workspaceChanges!.files.length > 0);
  }
  resolve(sessionId: string, artifactId: string): ResolvedArtifactOutput | null {
    const row = this.db.prepare('SELECT r.artifact_json FROM cowork_change_reviews r JOIN cowork_change_captures c ON c.dispatch_id=r.dispatch_id WHERE c.session_id=? AND r.artifact_id=? AND r.revision=c.latest_revision').get(sessionId, artifactId) as { artifact_json: string } | undefined;
    return row ? JSON.parse(row.artifact_json) : null;
  }
  async source(input: ReviewSourceRequest): Promise<ReviewSourceResponse> {
    const unavailable = (reason: typeof ReviewSourceReason[keyof typeof ReviewSourceReason]): ReviewSourceResponse => ({ ...input, status: ReviewSourceStatus.Unavailable, reason });
    const row = this.db.prepare('SELECT r.artifact_json,r.sources_json FROM cowork_change_reviews r JOIN cowork_change_captures c ON c.dispatch_id=r.dispatch_id WHERE c.session_id=? AND r.artifact_id=? AND r.revision=?').get(input.sessionId, input.artifactId, input.revision) as { artifact_json: string; sources_json: string } | undefined;
    if (!row) return unavailable(ReviewSourceReason.RevisionMismatch);
    const artifact = JSON.parse(row.artifact_json) as ResolvedArtifactOutput; const file = (JSON.parse(row.sources_json) as Sources)[input.fileId];
    if (!file || !Object.prototype.hasOwnProperty.call(JSON.parse(row.sources_json), input.fileId)) return unavailable(ReviewSourceReason.NotFound);
    try {
      const bytes = await Promise.all([this.bytes(artifact.workspaceChanges!.cwd, file.old), this.bytes(artifact.workspaceChanges!.cwd, file.next)]);
      if (bytes.some(data => data.includes(0))) return unavailable(ReviewSourceReason.Binary);
      const decode = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      return { ...input, status: ReviewSourceStatus.Ready, path: file.newPath, oldPath: file.oldPath, newPath: file.newPath, oldSource: decode.decode(bytes[0]), newSource: decode.decode(bytes[1]) };
    } catch { return unavailable(ReviewSourceReason.NotFound); }
  }
}
