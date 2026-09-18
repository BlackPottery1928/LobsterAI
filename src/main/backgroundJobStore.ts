import type Database from 'better-sqlite3';

import {
  BACKGROUND_JOB_DETAIL_MAX_CHARS,
  BACKGROUND_JOB_LABEL_MAX_CHARS,
  type BackgroundJobEngine,
  BackgroundJobStatus,
  type CoworkBackgroundJob,
  isLiveBackgroundJobStatus,
} from '../shared/cowork/backgroundJobs';

interface BackgroundJobRow {
  id: string;
  engine_job_id: string | null;
  session_id: string;
  engine: string;
  kind: string;
  label: string;
  status: string;
  detail: string | null;
  started_at: number;
  finished_at: number | null;
}

const STATUS_VALUES = new Set<string>(Object.values(BackgroundJobStatus));

const rowToJob = (row: BackgroundJobRow): CoworkBackgroundJob => ({
  id: row.id,
  engineJobId: row.engine_job_id ?? row.id,
  sessionId: row.session_id,
  engine: row.engine as BackgroundJobEngine,
  kind: row.kind,
  label: row.label,
  status: STATUS_VALUES.has(row.status) ? row.status as CoworkBackgroundJob['status'] : BackgroundJobStatus.Interrupted,
  ...(row.detail ? { detail: row.detail } : {}),
  startedAt: row.started_at,
  ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
});

/**
 * Local mirror of a session's background jobs. The runtime ledger stays
 * authoritative; this store only persists the last observed frame so the task
 * panel can show history after a runtime restart, session switch or cold start.
 */
export class BackgroundJobStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Overwrite the mirror with one complete frame of session jobs: every job is
   * upserted, and jobs that are still live locally but missing from the frame
   * are marked interrupted (the runtime no longer declares them, so their
   * terminal state was never observed).
   */
  replaceSessionJobs(
    sessionId: string,
    engine: BackgroundJobEngine,
    jobs: readonly Omit<CoworkBackgroundJob, 'sessionId' | 'engine'>[],
  ): CoworkBackgroundJob[] {
    const now = Date.now();
    const upsert = this.db.prepare(
      `INSERT INTO cowork_background_jobs (
         session_id, id, engine_job_id, engine, kind, label, status, detail, started_at, finished_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, id) DO UPDATE SET
         engine_job_id = excluded.engine_job_id,
         engine = excluded.engine,
         kind = excluded.kind,
         label = excluded.label,
         status = excluded.status,
         detail = excluded.detail,
         started_at = excluded.started_at,
         finished_at = excluded.finished_at,
         updated_at = excluded.updated_at`,
    );
    const interruptMissing = this.db.prepare(
      `UPDATE cowork_background_jobs
         SET status = ?, finished_at = COALESCE(finished_at, ?), updated_at = ?
       WHERE session_id = ? AND engine = ? AND status IN ('running', 'stopping')
         AND id NOT IN (SELECT value FROM json_each(?))`,
    );
    this.db.transaction(() => {
      for (const job of jobs) {
        upsert.run(
          sessionId,
          job.id,
          job.engineJobId ?? job.id,
          engine,
          job.kind,
          job.label.slice(0, BACKGROUND_JOB_LABEL_MAX_CHARS),
          job.status,
          job.detail ? job.detail.slice(0, BACKGROUND_JOB_DETAIL_MAX_CHARS) : null,
          job.startedAt,
          job.finishedAt ?? null,
          now,
        );
      }
      interruptMissing.run(
        BackgroundJobStatus.Interrupted,
        now,
        now,
        sessionId,
        engine,
        JSON.stringify(jobs.map(job => job.id)),
      );
    })();
    return this.listBySession(sessionId);
  }

  listBySession(sessionId: string): CoworkBackgroundJob[] {
    const rows = this.db
      .prepare(
        `SELECT id, engine_job_id, session_id, engine, kind, label, status, detail, started_at, finished_at
           FROM cowork_background_jobs WHERE session_id = ?
          ORDER BY CASE WHEN status IN ('running', 'stopping') THEN 0 ELSE 1 END, started_at DESC, id DESC`,
      )
      .all(sessionId) as BackgroundJobRow[];
    return rows.map(rowToJob);
  }

  hasLiveJobs(sessionId: string): boolean {
    return this.listBySession(sessionId).some(job => isLiveBackgroundJobStatus(job.status));
  }

  /** Sessions that still have a running/stopping job in the mirror. */
  listSessionIdsWithLiveJobs(engine: BackgroundJobEngine): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT session_id FROM cowork_background_jobs
          WHERE engine = ? AND status IN ('running', 'stopping')`,
      )
      .all(engine) as Array<{ session_id: string }>;
    return rows.map(row => row.session_id);
  }

  /** Drop finished records and keep only live jobs; returns the remaining list. */
  deleteSettled(sessionId: string): CoworkBackgroundJob[] {
    this.db.prepare(`DELETE FROM cowork_background_jobs WHERE session_id = ? AND status NOT IN ('running', 'stopping')`).run(sessionId);
    return this.listBySession(sessionId);
  }

  deleteBySession(sessionId: string): void {
    this.db.prepare('DELETE FROM cowork_background_jobs WHERE session_id = ?').run(sessionId);
  }
}
