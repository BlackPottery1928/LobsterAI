import {
  BackgroundJobKillOutcome,
  type BackgroundJobKillResult,
  type BackgroundJobStatus,
  BackgroundJobStatus as JobStatus,
  type CoworkBackgroundJob,
  isLiveBackgroundJobStatus,
} from '../../../shared/cowork/backgroundJobs';
import type { BackgroundJobStore } from '../../backgroundJobStore';
import { OpenClawGatewayMethod } from './constants';

/**
 * OpenClaw background job sync.
 *
 * OpenClaw does not push job updates. A backgrounded `exec` registers a task
 * run (`taskKind: "exec"`, `sourceId` = process session id) in the gateway task
 * ledger, which can only be read through `tasks.list { sessionKey }`. The
 * ledger summary does not carry the command text, so the exec tool result
 * (`details.sessionId` → command) is remembered here to label the row.
 * The ledger is polled at a fixed interval only while a job is live.
 */

export type OpenClawTaskSummaryLike = {
  id?: unknown;
  taskId?: unknown;
  kind?: unknown;
  runtime?: unknown;
  status?: unknown;
  title?: unknown;
  sourceId?: unknown;
  createdAt?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  progressSummary?: unknown;
  terminalSummary?: unknown;
  error?: unknown;
};

export type OpenClawBackgroundJobDraft = Omit<CoworkBackgroundJob, 'sessionId' | 'engine'>;

export type OpenClawGatewayRequest = <T = Record<string, unknown>>(
  method: string,
  params?: unknown,
  opts?: { timeoutMs?: number | null },
) => Promise<T>;

export interface OpenClawBackgroundJobSyncOptions {
  store: BackgroundJobStore;
  getGatewayRequest: () => OpenClawGatewayRequest | null;
  getSessionKeys: (sessionId: string) => string[];
  emit: (sessionId: string, jobs: CoworkBackgroundJob[]) => void;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  pageLimit?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_TASK_PAGES = 5;
/** A panel fetch and the poll timer may land together; reuse the last frame inside this window. */
const REFRESH_FRESHNESS_MS = 1_500;
/** Only background shells are mirrored; subagents already have their own panel section. */
const BACKGROUND_EXEC_TASK_KIND = 'exec';

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;
const asEpoch = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

const LEDGER_STATUS_TO_JOB: Record<string, { status: BackgroundJobStatus; detail?: string }> = {
  queued: { status: JobStatus.Running },
  running: { status: JobStatus.Running },
  succeeded: { status: JobStatus.Completed },
  completed: { status: JobStatus.Completed },
  failed: { status: JobStatus.Failed },
  timed_out: { status: JobStatus.Failed, detail: 'timed out' },
  cancelled: { status: JobStatus.Killed },
  lost: { status: JobStatus.Interrupted },
};

export const isOpenClawBashLikeToolName = (toolName: string | undefined): boolean => {
  const normalized = (toolName ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized === 'bash' || normalized === 'exec' || normalized === 'shell';
};

/** Extract the process session id from a backgrounded exec result (`details.status === 'running'` with a sessionId). */
export const extractOpenClawBackgroundExecStart = (
  toolName: string | undefined,
  toolArgs: unknown,
  details: unknown,
  isError: boolean,
): { processSessionId: string; command: string } | null => {
  if (isError || !isOpenClawBashLikeToolName(toolName)) return null;
  if (!details || typeof details !== 'object') return null;
  const record = details as Record<string, unknown>;
  if (record.status !== 'running') return null;
  const processSessionId = asString(record.sessionId);
  if (!processSessionId) return null;
  const args = toolArgs && typeof toolArgs === 'object' ? toolArgs as Record<string, unknown> : {};
  const command = asString(args.command) ?? asString(args.cmd) ?? '';
  return { processSessionId, command };
};

export const mapOpenClawTaskToBackgroundJob = (
  task: OpenClawTaskSummaryLike,
  labelBySourceId?: ReadonlyMap<string, string>,
): OpenClawBackgroundJobDraft | null => {
  const id = asString(task.taskId) ?? asString(task.id);
  if (!id) return null;
  const kind = asString(task.kind) ?? asString(task.runtime) ?? '';
  if (kind !== BACKGROUND_EXEC_TASK_KIND) return null;
  const ledgerStatus = asString(task.status) ?? '';
  const mapped = LEDGER_STATUS_TO_JOB[ledgerStatus] ?? { status: JobStatus.Failed };
  const sourceId = asString(task.sourceId);
  const label = (sourceId ? labelBySourceId?.get(sourceId) : undefined)
    ?? asString(task.title)
    ?? asString(task.progressSummary)
    ?? kind;
  const terminal = asString(task.terminalSummary) ?? asString(task.error);
  const detail = isLiveBackgroundJobStatus(mapped.status)
    ? asString(task.progressSummary)
    : (mapped.detail ?? terminal);
  const startedAt = asEpoch(task.startedAt) ?? asEpoch(task.createdAt) ?? Date.now();
  const finishedAt = asEpoch(task.endedAt);
  return {
    id,
    engineJobId: id,
    kind,
    label,
    status: mapped.status,
    ...(detail ? { detail } : {}),
    startedAt,
    ...(finishedAt === undefined ? {} : { finishedAt }),
  };
};

export class OpenClawBackgroundJobSync {
  private readonly labelBySession = new Map<string, Map<string, string>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Map<string, Promise<CoworkBackgroundJob[]>>();
  private readonly lastFrameBySession = new Map<string, string>();
  private readonly lastRefreshAtBySession = new Map<string, number>();
  private disposed = false;

  constructor(private readonly options: OpenClawBackgroundJobSyncOptions) {}

  /** Tool result observation point: remember the label of a backgrounded exec and refresh right away. */
  observeToolResult(
    sessionId: string,
    toolName: string | undefined,
    toolArgs: unknown,
    details: unknown,
    isError: boolean,
  ): void {
    const start = extractOpenClawBackgroundExecStart(toolName, toolArgs, details, isError);
    if (!start) return;
    let labels = this.labelBySession.get(sessionId);
    if (!labels) {
      labels = new Map();
      this.labelBySession.set(sessionId, labels);
    }
    if (start.command) labels.set(start.processSessionId, start.command);
    this.schedule(sessionId, 0);
  }

  /** Turn ended: a background job may have just been killed or exited, so refresh once more. */
  noteSessionSettled(sessionId: string): void {
    if (this.labelBySession.has(sessionId) || this.options.store.hasLiveJobs(sessionId)) {
      this.schedule(sessionId, 0);
    }
  }

  /**
   * Gateway (re)connected: jobs that were live before the gateway went away
   * can only settle through the ledger, so resume polling for those sessions.
   */
  onGatewayConnected(): void {
    for (const sessionId of this.options.store.listSessionIdsWithLiveJobs('openclaw')) {
      this.schedule(sessionId, 0);
    }
  }

  /** Panel fetch: reconcile with the gateway ledger first, fall back to the local mirror. */
  async list(sessionId: string): Promise<CoworkBackgroundJob[]> {
    const lastRefreshAt = this.lastRefreshAtBySession.get(sessionId);
    if (lastRefreshAt !== undefined && Date.now() - lastRefreshAt < REFRESH_FRESHNESS_MS) {
      return this.options.store.listBySession(sessionId);
    }
    return this.refresh(sessionId);
  }

  /** Kill through the gateway `tasks.cancel` and refresh the ledger right after. */
  async kill(sessionId: string, jobId: string): Promise<BackgroundJobKillResult> {
    const request = this.options.getGatewayRequest();
    if (!request) return { outcome: BackgroundJobKillOutcome.Unsupported, error: 'OpenClaw gateway is not connected.' };
    let result: Record<string, unknown>;
    try {
      result = await request(
        OpenClawGatewayMethod.TasksCancel,
        { taskId: jobId, reason: 'user' },
        { timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS },
      );
    } catch (error) {
      return { outcome: BackgroundJobKillOutcome.Unsupported, error: error instanceof Error ? error.message : String(error) };
    }
    const outcome = result?.found === false
      ? BackgroundJobKillOutcome.NotFound
      : result?.cancelled === true ? BackgroundJobKillOutcome.Requested : BackgroundJobKillOutcome.AlreadyFinished;
    const jobs = await this.refresh(sessionId).catch(() => this.options.store.listBySession(sessionId));
    return { outcome, jobs };
  }

  clearSettled(sessionId: string): CoworkBackgroundJob[] {
    const jobs = this.options.store.deleteSettled(sessionId);
    this.lastFrameBySession.set(sessionId, JSON.stringify(jobs));
    this.options.emit(sessionId, jobs);
    return jobs;
  }

  onSessionDeleted(sessionId: string): void {
    this.clearTimer(sessionId);
    this.options.store.deleteBySession(sessionId);
    this.labelBySession.delete(sessionId);
    this.lastFrameBySession.delete(sessionId);
    this.lastRefreshAtBySession.delete(sessionId);
  }

  dispose(): void {
    this.disposed = true;
    for (const sessionId of [...this.timers.keys()]) this.clearTimer(sessionId);
  }

  private schedule(sessionId: string, delayMs: number): void {
    if (this.disposed) return;
    this.clearTimer(sessionId);
    this.timers.set(sessionId, setTimeout((): void => {
      this.timers.delete(sessionId);
      void this.refresh(sessionId).catch((): undefined => undefined);
    }, delayMs));
  }

  private clearTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
  }

  private refresh(sessionId: string): Promise<CoworkBackgroundJob[]> {
    const existing = this.inFlight.get(sessionId);
    if (existing) return existing;
    const run: Promise<CoworkBackgroundJob[]> = this.refreshNow(sessionId).finally((): void => {
      if (this.inFlight.get(sessionId) === run) this.inFlight.delete(sessionId);
    });
    this.inFlight.set(sessionId, run);
    return run;
  }

  private async refreshNow(sessionId: string): Promise<CoworkBackgroundJob[]> {
    const request = this.options.getGatewayRequest();
    const keys = request ? this.options.getSessionKeys(sessionId) : [];
    if (!request || keys.length === 0) return this.options.store.listBySession(sessionId);

    const labels = this.labelBySession.get(sessionId);
    const drafts = new Map<string, OpenClawBackgroundJobDraft>();
    let reachedGateway = false;
    for (const sessionKey of keys) {
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TASK_PAGES; page += 1) {
        let result: Record<string, unknown>;
        try {
          result = await request(OpenClawGatewayMethod.TasksList, {
            sessionKey,
            limit: this.options.pageLimit ?? DEFAULT_PAGE_LIMIT,
            ...(cursor ? { cursor } : {}),
          }, { timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS });
        } catch {
          // A key the gateway cannot resolve (e.g. an alias) must not block the other keys.
          break;
        }
        reachedGateway = true;
        const tasks = Array.isArray(result?.tasks) ? result.tasks as OpenClawTaskSummaryLike[] : [];
        for (const task of tasks) {
          const draft = mapOpenClawTaskToBackgroundJob(task, labels);
          if (draft) drafts.set(draft.id, draft);
        }
        cursor = asString(result?.nextCursor);
        if (!cursor) break;
      }
    }
    if (!reachedGateway) return this.options.store.listBySession(sessionId);

    this.lastRefreshAtBySession.set(sessionId, Date.now());
    const jobs = this.options.store.replaceSessionJobs(sessionId, 'openclaw', [...drafts.values()]);
    const frame = JSON.stringify(jobs);
    if (this.lastFrameBySession.get(sessionId) !== frame) {
      this.lastFrameBySession.set(sessionId, frame);
      this.options.emit(sessionId, jobs);
    }
    if (jobs.some(job => isLiveBackgroundJobStatus(job.status))) {
      this.schedule(sessionId, this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    } else {
      this.clearTimer(sessionId);
    }
    return jobs;
  }
}
