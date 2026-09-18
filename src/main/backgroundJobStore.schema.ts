import type Database from 'better-sqlite3';

/** Shared with `SqliteStore.initSchema`; tests can create the table on an in-memory database. */
export function createBackgroundJobsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cowork_background_jobs (
      session_id TEXT NOT NULL,
      id TEXT NOT NULL,
      engine_job_id TEXT,
      engine TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'running',
      detail TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, id)
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cowork_background_jobs_session_status
    ON cowork_background_jobs(session_id, status);
  `);
}
