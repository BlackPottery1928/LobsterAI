/**
 * Background jobs shown in the "Background tasks" section of the task panel.
 *
 * The source of truth is the runtime's own job ledger, not the conversation
 * transcript. For OpenClaw the main process polls the gateway task ledger
 * (`tasks.list`) for background `exec` runs, mirrors the latest frame into
 * SQLite so history survives restarts, and pushes it to the renderer.
 */

export const BACKGROUND_JOB_EVENT_CHANNEL = 'cowork:backgroundJob:event';

export const BackgroundJobStatus = {
  Running: 'running',
  Stopping: 'stopping',
  Completed: 'completed',
  Killed: 'killed',
  Failed: 'failed',
  /** The runtime stopped declaring the job before a terminal state was seen. */
  Interrupted: 'interrupted',
} as const;
export type BackgroundJobStatus = typeof BackgroundJobStatus[keyof typeof BackgroundJobStatus];

export const BACKGROUND_JOB_LIVE_STATUSES: ReadonlySet<BackgroundJobStatus> = new Set([
  BackgroundJobStatus.Running,
  BackgroundJobStatus.Stopping,
]);

export const isLiveBackgroundJobStatus = (status: BackgroundJobStatus): boolean =>
  BACKGROUND_JOB_LIVE_STATUSES.has(status);

export type BackgroundJobEngine = 'openclaw';

export interface CoworkBackgroundJob {
  /** Mirror key, unique within a session and stable across runtime restarts. */
  id: string;
  /** Raw job id inside the runtime; used for kill requests. Defaults to `id`. */
  engineJobId?: string;
  sessionId: string;
  engine: BackgroundJobEngine;
  /** Producer kind, e.g. `exec`. */
  kind: string;
  /** One-line human readable label, usually the command text. */
  label: string;
  status: BackgroundJobStatus;
  /** Terminal detail from the producer, e.g. `exit code: 0`. */
  detail?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface CoworkBackgroundJobsEvent {
  sessionId: string;
  jobs: CoworkBackgroundJob[];
  timestamp: number;
}

export const BackgroundJobKillOutcome = {
  Requested: 'requested',
  AlreadyFinished: 'already-finished',
  NotFound: 'not-found',
  /** The runtime cannot stop the job right now (for example: gateway not connected). */
  Unsupported: 'unsupported',
} as const;
export type BackgroundJobKillOutcome = typeof BackgroundJobKillOutcome[keyof typeof BackgroundJobKillOutcome];

export interface BackgroundJobKillResult {
  outcome: BackgroundJobKillOutcome;
  /** Latest mirror after the kill request; may still be running/stopping while the runtime settles. */
  jobs?: CoworkBackgroundJob[];
  error?: string;
}

export const BACKGROUND_JOB_LABEL_MAX_CHARS = 4096;
export const BACKGROUND_JOB_DETAIL_MAX_CHARS = 512;
