import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';

import { ReviewSourceStatus } from '../../shared/artifactPreview/reviewSource';
import { ChangeCaptureState, ChangeReviewScope } from '../../shared/artifactPreview/turnChanges';
import { artifactContentRevision } from '../../shared/artifactPreview/workspace';
import { parseWorkspaceDiff } from '../../shared/artifactPreview/workspaceDiff';
import { TurnChangesStore } from './turnChanges';
const roots: string[] = []; const databases: Database.Database[] = [];
afterEach(() => { vi.restoreAllMocks(); databases.splice(0).forEach(db => db.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture(repository = true) {
  const root = mkdtempSync(path.join(tmpdir(), 'cowork-turn-changes-test-')); roots.push(root);
  const cwd = path.join(root, 'workspace'); mkdirSync(cwd);
  const db = new Database(':memory:'); databases.push(db); db.exec('CREATE TABLE cowork_sessions (id TEXT PRIMARY KEY); INSERT INTO cowork_sessions VALUES (\'one\'),(\'two\');');
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  const write = (name: string, text: string | Buffer) => { mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true }); writeFileSync(path.join(cwd, name), text); };
  if (repository) { git('init', '-q', '-b', 'main'); git('config', 'user.name', 'QA'); git('config', 'user.email', 'qa@example.invalid'); write('notes.md', 'before\n'); git('add', '.'); git('commit', '-qm', 'fixture'); }
  const cache = path.join(root, 'blobs'); const store = new TurnChangesStore(db, cache);
  const begin = (id = 'dispatch-1', session = 'one') => store.begin({ id, coworkSessionId: session, userMessageId: 'user-' + id }, cwd);
  return { root, cwd, db, cache, store, write, git, begin };
}
test('fresh sessions never inherit repository dirty or untracked files', async () => {
  const f = fixture(); f.write('notes.md', 'old dirty\n'); f.write('existing.html', 'old\n'.repeat(304));
  expect(await f.store.latest('two')).toBeNull();
  await f.begin(); const review = await f.store.latest('one');
  expect(review?.workspaceChanges).toMatchObject({ scope: ChangeReviewScope.Turn, totalChangedFiles: 0, added: 0, removed: 0 });
  await f.store.finish('one'); expect(await f.store.latest('two')).toBeNull();
});
test('diffs actual dirty content at admission; never writes index, HEAD or source files', async () => {
  const f = fixture(); f.write('notes.md', 'already dirty\nkeep\n'); f.write('old.txt', 'untracked existing\n');
  const index = readFileSync(path.join(f.cwd, '.git/index')); const head = f.git('rev-parse', 'HEAD');
  await f.begin(); f.write('notes.md', 'this turn\nkeep\n');
  await f.store.finish('one'); const review = (await f.store.latest('one'))!;
  expect(review.workspaceChanges).toMatchObject({ totalChangedFiles: 1, added: 1, removed: 1 });
  expect(review.content).toContain('-already dirty'); expect(review.content).toContain('+this turn'); expect(review.content).not.toContain('untracked existing');
  expect(readFileSync(path.join(f.cwd, '.git/index'))).toEqual(index); expect(f.git('rev-parse', 'HEAD')).toBe(head);
  const file = parseWorkspaceDiff(review.content).files[0];
  expect(await f.store.source({ sessionId: 'one', artifactId: review.id, revision: artifactContentRevision(review), fileId: file.id })).toMatchObject({ status: ReviewSourceStatus.Ready, oldSource: 'already dirty\nkeep\n', newSource: 'this turn\nkeep\n' });
});
test('retry retains its original baseline and a second turn has a separate baseline', async () => {
  const f = fixture(); await f.begin(); f.write('notes.md', 'first\n'); await f.begin(); await f.store.finish('one');
  expect((await f.store.latest('one'))?.content).toContain('-before');
  await f.begin('dispatch-2'); f.write('notes.md', 'before\n'); await f.store.finish('one');
  const second = (await f.store.latest('one'))!; expect(second.content).toContain('-first'); expect(second.content).toContain('+before');
  expect(second.messageId).toBe('user-dispatch-2');
});
test('returning to an earlier content revision updates the current pointer', async () => {
  const f = fixture(); await f.begin(); f.write('notes.md', 'A\n'); const a = (await f.store.latest('one'))!;
  f.write('notes.md', 'B\n'); await f.store.latest('one'); f.write('notes.md', 'A\n'); await f.store.finish('one');
  expect(f.store.resolve('one', a.id)?.content).toBe(a.content);
});
test('completed reviews and source versions survive restart and later edits, and are session scoped', async () => {
  const f = fixture(); await f.begin(); f.write('notes.md', 'accepted\n'); await f.store.finish('one');
  const review = (await f.store.latest('one'))!; const request = { sessionId: 'one', artifactId: review.id, revision: artifactContentRevision(review), fileId: parseWorkspaceDiff(review.content).files[0].id };
  f.write('notes.md', 'later edit\n'); const restored = new TurnChangesStore(f.db, f.cache);
  expect((await restored.latest('one'))?.content).toBe(review.content);
  expect(await restored.source(request)).toMatchObject({ oldSource: 'before\n', newSource: 'accepted\n' });
  expect(restored.resolve('two', review.id)).toBeNull(); expect((await restored.source({ ...request, sessionId: 'two' })).status).not.toBe(ReviewSourceStatus.Ready);
});
test('stopped host does not attribute later edits to an interrupted task or recapture its baseline', async () => {
  const f = fixture(); await f.begin(); f.write('notes.md', 'observed\n'); const last = await f.store.latest('one');
  const restarted = new TurnChangesStore(f.db, f.cache); f.write('notes.md', 'external after restart\n');
  await restarted.begin({ id: 'dispatch-1', coworkSessionId: 'one', userMessageId: 'user-dispatch-1' }, f.cwd);
  expect((await restarted.latest('one'))?.content).toBe(last?.content);
});
test('plain office directories, deletion, spaces and CRLF retain accurate content', async () => {
  const f = fixture(false); f.write('folder/old file.md', 'old\r\n'); await f.begin(); rmSync(path.join(f.cwd, 'folder'), { recursive: true }); f.write('新文件.md', 'new\r\n');
  await f.store.finish('one'); const review = (await f.store.latest('one'))!;
  expect(review.workspaceChanges).toMatchObject({ totalChangedFiles: 2, added: 1, removed: 1 });
  expect(parseWorkspaceDiff(review.content).files.map(file => file.path).sort()).toEqual(['folder/old file.md', '新文件.md']);
});
test('symlinks capture only link text; binary data is never passed to the tokenizer', async () => {
  const f = fixture(); await f.begin(); f.write('bin.dat', Buffer.from([0, 10, 22]));
  const secret = path.join(f.root, 'secret.txt'); writeFileSync(secret, 'not in review'); symlinkSync(secret, path.join(f.cwd, 'link'));
  await f.store.finish('one'); const review = (await f.store.latest('one'))!;
  expect(review.content).not.toContain('not in review');
  const binary = parseWorkspaceDiff(review.content).files.find(file => file.path === 'bin.dat')!;
  expect(await f.store.source({ sessionId: 'one', artifactId: review.id, revision: artifactContentRevision(review), fileId: binary.id })).toMatchObject({ status: ReviewSourceStatus.Unavailable, reason: 'binary' });
});
test('oversized baseline files are not falsely counted as edits', async () => {
  const f = fixture(false); f.write('large.bin', Buffer.alloc(2_000_001)); await f.begin(); await f.store.finish('one');
  expect((await f.store.latest('one'))?.workspaceChanges).toMatchObject({ totalChangedFiles: 0, statsIncomplete: true });
});

test('clean Git CRLF checkout uses actual old bytes rather than normalized index text', async () => {
  const f = fixture(); f.git('config', 'core.autocrlf', 'true');
  f.write('notes.md', 'before\r\nkeep\r\n'); f.git('add', '.'); f.git('commit', '-qm', 'CRLF fixture');
  expect(f.git('status', '--porcelain')).toBe('');
  await f.begin(); f.write('notes.md', 'after\r\nkeep\r\n'); await f.store.finish('one');
  const review = (await f.store.latest('one'))!;
  expect(review.workspaceChanges).toMatchObject({ totalChangedFiles: 1, added: 1, removed: 1 });
  expect(await f.store.source({ sessionId: 'one', artifactId: review.id, revision: artifactContentRevision(review), fileId: parseWorkspaceDiff(review.content).files[0].id }))
    .toMatchObject({ oldSource: 'before\r\nkeep\r\n', newSource: 'after\r\nkeep\r\n' });
});

test('clean Git filtered checkout preserves actual old source without rerunning filters for review', async () => {
  const f = fixture();
  f.git('config', 'filter.fixture.clean', 'sed s/CHECKOUT/INDEX/g');
  f.git('config', 'filter.fixture.smudge', 'sed s/INDEX/CHECKOUT/g');
  f.write('.gitattributes', '*.md filter=fixture\n'); f.write('notes.md', 'CHECKOUT\nkeep\n');
  f.git('add', '.'); f.git('commit', '-qm', 'filtered fixture');
  expect(f.git('status', '--porcelain')).toBe('');
  expect(f.git('show', 'HEAD:notes.md')).toBe('INDEX\nkeep\n');
  await f.begin(); f.write('notes.md', 'AFTER\nkeep\n'); await f.store.finish('one');
  const review = (await f.store.latest('one'))!;
  expect(await f.store.source({ sessionId: 'one', artifactId: review.id, revision: artifactContentRevision(review), fileId: parseWorkspaceDiff(review.content).files[0].id }))
    .toMatchObject({ oldSource: 'CHECKOUT\nkeep\n', newSource: 'AFTER\nkeep\n' });
});

test('failed final capture preserves the last review and its sources with explicit incomplete status', async () => {
  const f = fixture(); await f.begin(); f.write('notes.md', 'observed intermediate\n');
  const observed = (await f.store.latest('one'))!;
  rmSync(f.cwd, { recursive: true });
  await f.store.finish('one');
  const final = (await f.store.latest('one'))!;
  expect(final.content).toBe(observed.content);
  expect(final.workspaceChanges).toMatchObject({ statsIncomplete: true, captureIncomplete: true });
  expect(artifactContentRevision(final)).not.toBe(artifactContentRevision(observed));
  expect(f.db.prepare('SELECT state FROM cowork_change_captures WHERE dispatch_id=?').get('dispatch-1'))
    .toEqual({ state: ChangeCaptureState.Interrupted });
  const fileId = parseWorkspaceDiff(final.content).files[0].id;
  for (const revision of [artifactContentRevision(observed), artifactContentRevision(final)]) {
    expect(await f.store.source({ sessionId: 'one', artifactId: final.id, revision, fileId }))
      .toMatchObject({ status: ReviewSourceStatus.Ready, oldSource: 'before\n', newSource: 'observed intermediate\n' });
  }
  const restored = new TurnChangesStore(f.db, f.cache);
  expect((await restored.latest('one'))?.workspaceChanges).toMatchObject({ statsIncomplete: true, captureIncomplete: true });
});

test('a changed Git root during capture cannot seal a stale review as complete', async () => {
  const f = fixture(false); f.write('notes.md', 'before\n'); await f.begin();
  f.write('notes.md', 'observed\n'); const observed = (await f.store.latest('one'))!;
  // Another operation creates a containing repository while this plain-folder turn runs.
  execFileSync('git', ['-C', f.root, 'init', '-q', '-b', 'main']);
  await f.store.finish('one');
  const final = (await f.store.latest('one'))!;
  expect(final.content).toBe(observed.content);
  expect(final.workspaceChanges).toMatchObject({ statsIncomplete: true, captureIncomplete: true });
  expect(f.db.prepare('SELECT state FROM cowork_change_captures').get()).toEqual({ state: ChangeCaptureState.Interrupted });
});

test('cancelling during an asynchronous baseline never reactivates the cancelled capture', async () => {
  const f = fixture();
  const target = f.store as unknown as { snapshot: (cwd: string) => Promise<unknown> };
  const captured = await target.snapshot(f.cwd);
  let release!: () => void; let enter!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const snapshot = vi.spyOn(target, 'snapshot').mockImplementationOnce(async () => { enter(); await gate; return captured; });
  const beginning = f.begin(); await entered;
  try {
    f.store.cancelPending('two');
    expect(f.db.prepare('SELECT state FROM cowork_change_captures').get()).toEqual({ state: ChangeCaptureState.Capturing });
    f.store.cancelPending('one');
  } finally { release(); await beginning; }
  expect(f.db.prepare('SELECT state,before_json FROM cowork_change_captures').get())
    .toEqual({ state: ChangeCaptureState.Interrupted, before_json: null });
  f.write('notes.md', 'later external edit\n');
  await f.store.finish('one'); expect(await f.store.latest('one')).toBeNull();
  expect(snapshot).toHaveBeenCalledOnce();
  await f.begin('dispatch-2');
  expect(f.db.prepare('SELECT state FROM cowork_change_captures WHERE dispatch_id=?').get('dispatch-2'))
    .toEqual({ state: ChangeCaptureState.Active });
  await f.store.finish('one');
  expect((await f.store.latest('one'))?.workspaceChanges).toMatchObject({ totalChangedFiles: 0 });
});

test('an older admission cancellation callback does not interrupt a newer baseline capture', async () => {
  const f = fixture();
  const target = f.store as unknown as { snapshot: (cwd: string) => Promise<unknown> };
  const captured = await target.snapshot(f.cwd);
  const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
  const firstGate = deferred(); const firstEntered = deferred(); const secondGate = deferred(); const secondEntered = deferred();
  vi.spyOn(target, 'snapshot')
    .mockImplementationOnce(async () => { firstEntered.resolve(); await firstGate.promise; return captured; })
    .mockImplementationOnce(async () => { secondEntered.resolve(); await secondGate.promise; return captured; });
  const first = f.begin(); await firstEntered.promise;
  f.store.cancelPending('one'); // User stops the first admission.
  const second = f.begin('dispatch-2'); await secondEntered.promise;
  try {
    firstGate.resolve(); await first;
    f.store.cancelPending('one', 'dispatch-1'); // Delayed onAdmissionCancelled callback for the first admission.
    await f.store.finish('one', 'dispatch-1');
    expect(f.db.prepare('SELECT state FROM cowork_change_captures WHERE dispatch_id=?').get('dispatch-2'))
      .toEqual({ state: ChangeCaptureState.Capturing });
  } finally { firstGate.resolve(); secondGate.resolve(); await Promise.all([first, second]); }
  expect(f.db.prepare('SELECT state FROM cowork_change_captures WHERE dispatch_id=?').get('dispatch-1'))
    .toEqual({ state: ChangeCaptureState.Interrupted });
  expect(f.db.prepare('SELECT state FROM cowork_change_captures WHERE dispatch_id=?').get('dispatch-2'))
    .toEqual({ state: ChangeCaptureState.Active });
  f.write('notes.md', 'second turn output\n'); await f.store.finish('one', 'dispatch-2');
  expect((await f.store.latest('one'))?.content).toContain('+second turn output');
});

test('a delayed finish for an older dispatch or another session cannot seal the newer turn', async () => {
  const f = fixture(); await f.begin(); f.write('notes.md', 'first turn\n'); await f.store.finish('one', 'dispatch-1');
  const first = (await f.store.latest('one'))!;
  await f.begin('dispatch-2'); f.write('notes.md', 'second intermediate\n');
  await f.store.finish('one', 'dispatch-1'); await f.store.finish('two', 'dispatch-2');
  expect(f.db.prepare('SELECT state FROM cowork_change_captures WHERE dispatch_id=?').get('dispatch-2'))
    .toEqual({ state: ChangeCaptureState.Active });
  expect(f.store.resolve('one', first.id)?.content).toBe(first.content);
  f.write('notes.md', 'second final\n'); await f.store.finish('one', 'dispatch-2');
  const second = (await f.store.latest('one'))!;
  expect(second.messageId).toBe('user-dispatch-2');
  expect(second.content).toContain('-first turn'); expect(second.content).toContain('+second final');
  f.write('notes.md', 'external after completion\n');
  expect((await f.store.latest('one'))?.content).toBe(second.content);
});

test('removing a session drops its captures and reviews without touching other sessions', async () => {
  const f = fixture(); await f.begin(); f.write('notes.md', 'one\n'); await f.store.finish('one');
  await f.begin('dispatch-2', 'two'); await f.store.finish('two');
  await f.store.remove('one');
  expect(await f.store.latest('one')).toBeNull();
  expect(f.db.prepare('SELECT COUNT(*) AS count FROM cowork_change_reviews').get()).toEqual({ count: 1 });
  expect(f.db.prepare('SELECT session_id FROM cowork_change_captures').all()).toEqual([{ session_id: 'two' }]);
});
