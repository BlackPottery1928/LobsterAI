import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';

import { BackgroundJobStore } from './backgroundJobStore';
import { createBackgroundJobsTable } from './backgroundJobStore.schema';

describe('BackgroundJobStore', () => {
  let db: Database.Database | null = null;
  afterEach(() => { db?.close(); db = null; });

  const open = () => {
    db = new Database(':memory:');
    createBackgroundJobsTable(db);
    return new BackgroundJobStore(db);
  };

  test('mirrors a frame, keeps history, and interrupts jobs the runtime stopped declaring', () => {
    const store = open();
    store.replaceSessionJobs('s1', 'openclaw', [
      { id: 'task-1', kind: 'exec', label: 'sleep 60', status: 'running', startedAt: 1000 },
      { id: 'task-2', kind: 'exec', label: 'ls', status: 'completed', detail: 'exit code: 0', startedAt: 500, finishedAt: 600 },
    ]);
    expect(store.hasLiveJobs('s1')).toBe(true);
    // The next frame only contains task-2: task-1 vanished from the ledger and
    // must not stay "running" forever.
    const jobs = store.replaceSessionJobs('s1', 'openclaw', [
      { id: 'task-2', kind: 'exec', label: 'ls', status: 'completed', detail: 'exit code: 0', startedAt: 500, finishedAt: 600 },
    ]);
    // Without live jobs the order falls back to started_at desc.
    expect(jobs.map(job => [job.id, job.status])).toEqual([['task-1', 'interrupted'], ['task-2', 'completed']]);
    expect(jobs.find(job => job.id === 'task-1')?.finishedAt).toBeTypeOf('number');
    expect(store.hasLiveJobs('s1')).toBe(false);
  });

  test('lists sessions that still have live jobs', () => {
    const store = open();
    store.replaceSessionJobs('s1', 'openclaw', [{ id: 'a', kind: 'exec', label: 'a', status: 'running', startedAt: 1 }]);
    store.replaceSessionJobs('s2', 'openclaw', [{ id: 'b', kind: 'exec', label: 'b', status: 'completed', startedAt: 1, finishedAt: 2 }]);
    store.replaceSessionJobs('s3', 'openclaw', [{ id: 'c', kind: 'exec', label: 'c', status: 'stopping', startedAt: 1 }]);
    expect(store.listSessionIdsWithLiveJobs('openclaw').sort()).toEqual(['s1', 's3']);
    store.deleteBySession('s1');
    expect(store.listSessionIdsWithLiveJobs('openclaw')).toEqual(['s3']);
  });

  test('exposes the runtime job id separately from the mirror key', () => {
    const store = open();
    const jobs = store.replaceSessionJobs('s1', 'openclaw', [
      { id: 'task-1@900', engineJobId: 'task-1', kind: 'exec', label: 'sleep 120', status: 'running', startedAt: 900 },
      { id: 'plain', kind: 'exec', label: 'ls', status: 'completed', startedAt: 100, finishedAt: 175 },
    ]);
    expect(jobs.map(job => [job.id, job.engineJobId])).toEqual([['task-1@900', 'task-1'], ['plain', 'plain']]);
  });

  test('deleteSettled keeps only live jobs', () => {
    const store = open();
    store.replaceSessionJobs('s1', 'openclaw', [
      { id: 'live', kind: 'exec', label: 'a', status: 'running', startedAt: 1 },
      { id: 'done', kind: 'exec', label: 'b', status: 'completed', startedAt: 1, finishedAt: 2 },
      { id: 'dead', kind: 'exec', label: 'c', status: 'interrupted', startedAt: 1, finishedAt: 2 },
    ]);
    expect(store.deleteSettled('s1').map(job => job.id)).toEqual(['live']);
    expect(store.listBySession('s1')).toHaveLength(1);
  });

  test('orders live jobs first and truncates oversized text', () => {
    const store = open();
    const jobs = store.replaceSessionJobs('s1', 'openclaw', [
      { id: 'old', kind: 'exec', label: 'x'.repeat(5000), status: 'completed', detail: 'y'.repeat(600), startedAt: 10, finishedAt: 20 },
      { id: 'live', kind: 'exec', label: 'live', status: 'running', startedAt: 5 },
    ]);
    expect(jobs.map(job => job.id)).toEqual(['live', 'old']);
    expect(jobs[1].label).toHaveLength(4096);
    expect(jobs[1].detail).toHaveLength(512);
  });
});
