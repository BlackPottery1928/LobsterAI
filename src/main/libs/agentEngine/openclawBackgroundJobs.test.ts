import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { CoworkBackgroundJob } from '../../../shared/cowork/backgroundJobs';
import type { BackgroundJobStore } from '../../backgroundJobStore';
import {
  extractOpenClawBackgroundExecStart,
  mapOpenClawTaskToBackgroundJob,
  OpenClawBackgroundJobSync,
} from './openclawBackgroundJobs';

/** In-memory mirror with the same semantics as the SQLite store for the methods the sync uses. */
class MemoryStore implements Pick<
  BackgroundJobStore,
  'replaceSessionJobs' | 'listBySession' | 'hasLiveJobs' | 'deleteBySession' | 'deleteSettled' | 'listSessionIdsWithLiveJobs'
> {
  readonly bySession = new Map<string, Map<string, CoworkBackgroundJob>>();
  replaceSessionJobs(sessionId: string, engine: CoworkBackgroundJob['engine'], jobs: readonly Omit<CoworkBackgroundJob, 'sessionId' | 'engine'>[]) {
    const bucket = this.bySession.get(sessionId) ?? new Map<string, CoworkBackgroundJob>();
    const seen = new Set(jobs.map(job => job.id));
    for (const job of jobs) bucket.set(job.id, { ...job, sessionId, engine });
    for (const [id, job] of bucket) {
      if (!seen.has(id) && (job.status === 'running' || job.status === 'stopping')) bucket.set(id, { ...job, status: 'interrupted' });
    }
    this.bySession.set(sessionId, bucket);
    return this.listBySession(sessionId);
  }
  listBySession(sessionId: string) { return [...(this.bySession.get(sessionId)?.values() ?? [])]; }
  hasLiveJobs(sessionId: string) { return this.listBySession(sessionId).some(job => job.status === 'running' || job.status === 'stopping'); }
  deleteBySession(sessionId: string) { this.bySession.delete(sessionId); }
  deleteSettled(sessionId: string) {
    const bucket = this.bySession.get(sessionId);
    for (const [id, job] of bucket ?? []) if (job.status !== 'running' && job.status !== 'stopping') bucket?.delete(id);
    return this.listBySession(sessionId);
  }
  listSessionIdsWithLiveJobs() { return [...this.bySession.keys()].filter(sessionId => this.hasLiveJobs(sessionId)); }
}

describe('mapOpenClawTaskToBackgroundJob', () => {
  test('mirrors exec task runs with the command label resolved from the exec tool result', () => {
    const labels = new Map([['proc-1', 'pwsh -File build.ps1']]);
    expect(mapOpenClawTaskToBackgroundJob({
      taskId: 'task-1', kind: 'exec', status: 'running', title: 'CLI command', sourceId: 'proc-1',
      createdAt: 10, startedAt: 12, progressSummary: 'Command running',
    }, labels)).toEqual({
      id: 'task-1', engineJobId: 'task-1', kind: 'exec', label: 'pwsh -File build.ps1', status: 'running', detail: 'Command running', startedAt: 12,
    });
    expect(mapOpenClawTaskToBackgroundJob({
      taskId: 'task-2', kind: 'exec', status: 'completed', title: 'CLI command', startedAt: 1, endedAt: 9, terminalSummary: 'Command completed',
    })).toEqual({ id: 'task-2', engineJobId: 'task-2', kind: 'exec', label: 'CLI command', status: 'completed', detail: 'Command completed', startedAt: 1, finishedAt: 9 });
  });

  test('maps ledger terminal states and ignores non-exec runs', () => {
    const base = { taskId: 't', kind: 'exec', startedAt: 1, endedAt: 2 };
    expect(mapOpenClawTaskToBackgroundJob({ ...base, status: 'cancelled' })?.status).toBe('killed');
    expect(mapOpenClawTaskToBackgroundJob({ ...base, status: 'timed_out' })).toMatchObject({ status: 'failed', detail: 'timed out' });
    expect(mapOpenClawTaskToBackgroundJob({ ...base, status: 'failed', error: 'boom' })).toMatchObject({ status: 'failed', detail: 'boom' });
    expect(mapOpenClawTaskToBackgroundJob({ ...base, status: 'lost' })?.status).toBe('interrupted');
    expect(mapOpenClawTaskToBackgroundJob({ ...base, status: 'queued', endedAt: undefined })?.status).toBe('running');
    expect(mapOpenClawTaskToBackgroundJob({ taskId: 'sub', kind: 'subagent', runtime: 'subagent', status: 'running', startedAt: 1 })).toBeNull();
    expect(mapOpenClawTaskToBackgroundJob({ kind: 'exec', status: 'running' })).toBeNull();
  });
});

describe('extractOpenClawBackgroundExecStart', () => {
  test('only recognises a successful backgrounded shell result', () => {
    const details = { status: 'running', sessionId: 'proc-9', pid: 42, startedAt: 1 };
    expect(extractOpenClawBackgroundExecStart('exec', { command: 'sleep 60' }, details, false))
      .toEqual({ processSessionId: 'proc-9', command: 'sleep 60' });
    expect(extractOpenClawBackgroundExecStart('Bash', { command: 'x' }, details, false)?.processSessionId).toBe('proc-9');
    expect(extractOpenClawBackgroundExecStart('exec', { command: 'x' }, details, true)).toBeNull();
    expect(extractOpenClawBackgroundExecStart('exec', { command: 'x' }, { status: 'completed', sessionId: 'p' }, false)).toBeNull();
    expect(extractOpenClawBackgroundExecStart('write', {}, details, false)).toBeNull();
    expect(extractOpenClawBackgroundExecStart('exec', {}, { status: 'running' }, false)).toBeNull();
  });
});

describe('OpenClawBackgroundJobSync', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const setup = (responses: Array<Record<string, unknown>>) => {
    const store = new MemoryStore();
    const request = vi.fn(async () => responses.shift() ?? { tasks: [] });
    const emitted: CoworkBackgroundJob[][] = [];
    const sync = new OpenClawBackgroundJobSync({
      store: store as unknown as BackgroundJobStore,
      getGatewayRequest: () => request as never,
      getSessionKeys: () => ['agent:main:s1'],
      emit: (_sessionId, jobs) => emitted.push(jobs),
      pollIntervalMs: 1_000,
    });
    return { store, request, emitted, sync };
  };

  test('refreshes on a backgrounded exec, polls while live, and stops once settled', async () => {
    const running = { tasks: [{ taskId: 'task-1', kind: 'exec', status: 'running', title: 'CLI command', sourceId: 'proc-1', startedAt: 5 }] };
    const done = { tasks: [{ taskId: 'task-1', kind: 'exec', status: 'succeeded', title: 'CLI command', sourceId: 'proc-1', startedAt: 5, endedAt: 9, terminalSummary: 'Command completed' }] };
    const { request, emitted, sync } = setup([running, running, done]);

    sync.observeToolResult('s1', 'exec', { command: 'sleep 60' }, { status: 'running', sessionId: 'proc-1' }, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]).toEqual(['tasks.list', { sessionKey: 'agent:main:s1', limit: 100 }, { timeoutMs: 8_000 }]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0][0]).toMatchObject({ id: 'task-1', label: 'sleep 60', status: 'running', engine: 'openclaw', sessionId: 's1' });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(2);
    // An identical frame is not re-emitted.
    expect(emitted).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(3);
    expect(emitted).toHaveLength(2);
    expect(emitted[1][0]).toMatchObject({ status: 'completed', detail: 'Command completed', finishedAt: 9 });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(3);
  });

  test('list() reuses a frame refreshed moments ago instead of hitting the gateway again', async () => {
    const { request, sync } = setup([{ tasks: [] }, { tasks: [] }]);
    await sync.list('s1');
    await sync.list('s1');
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await sync.list('s1');
    expect(request).toHaveBeenCalledTimes(2);
  });

  test('kill() cancels through the gateway ledger and refreshes; clearSettled() drops finished rows', async () => {
    const store = new MemoryStore();
    const emitted: CoworkBackgroundJob[][] = [];
    const request = vi.fn(async (method: string) => method === 'tasks.cancel'
      ? { found: true, cancelled: true }
      : { tasks: [{ taskId: 'task-1', kind: 'exec', status: 'cancelled', startedAt: 1, endedAt: 5 }, { taskId: 'task-2', kind: 'exec', status: 'running', startedAt: 3 }] });
    const sync = new OpenClawBackgroundJobSync({
      store: store as unknown as BackgroundJobStore,
      getGatewayRequest: () => request as never,
      getSessionKeys: () => ['k'],
      emit: (_s, jobs) => emitted.push(jobs),
    });
    const result = await sync.kill('s1', 'task-1');
    expect(request.mock.calls[0]).toEqual(['tasks.cancel', { taskId: 'task-1', reason: 'user' }, { timeoutMs: 8_000 }]);
    expect(result.outcome).toBe('requested');
    expect(result.jobs?.find(job => job.id === 'task-1')?.status).toBe('killed');
    expect(sync.clearSettled('s1').map(job => job.id)).toEqual(['task-2']);
    expect(emitted.at(-1)?.map(job => job.id)).toEqual(['task-2']);
    request.mockResolvedValueOnce({ found: false, cancelled: false });
    await expect(sync.kill('s1', 'missing')).resolves.toMatchObject({ outcome: 'not-found' });
    sync.dispose();
  });

  test('list() falls back to the local mirror when the gateway is unavailable', async () => {
    const store = new MemoryStore();
    store.replaceSessionJobs('s1', 'openclaw', [{ id: 'old', kind: 'exec', label: 'ls', status: 'completed', startedAt: 1, finishedAt: 2 }]);
    const sync = new OpenClawBackgroundJobSync({
      store: store as unknown as BackgroundJobStore,
      getGatewayRequest: () => null,
      getSessionKeys: () => ['k'],
      emit: () => undefined,
    });
    await expect(sync.list('s1')).resolves.toMatchObject([{ id: 'old', status: 'completed' }]);
    await expect(sync.kill('s1', 'old')).resolves.toMatchObject({ outcome: 'unsupported' });
  });

  test('onGatewayConnected() resumes polling for sessions whose jobs were still live', async () => {
    const store = new MemoryStore();
    store.replaceSessionJobs('s1', 'openclaw', [{ id: 'task-1', kind: 'exec', label: 'sleep 60', status: 'running', startedAt: 1 }]);
    store.replaceSessionJobs('s2', 'openclaw', [{ id: 'done', kind: 'exec', label: 'ls', status: 'completed', startedAt: 1, finishedAt: 2 }]);
    const request = vi.fn(async () => ({ tasks: [] }));
    const emitted: Array<[string, CoworkBackgroundJob[]]> = [];
    const sync = new OpenClawBackgroundJobSync({
      store: store as unknown as BackgroundJobStore,
      getGatewayRequest: () => request as never,
      getSessionKeys: sessionId => [`agent:main:${sessionId}`],
      emit: (sessionId, jobs) => emitted.push([sessionId, jobs]),
    });
    sync.onGatewayConnected();
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]).toMatchObject({ sessionKey: 'agent:main:s1' });
    // The ledger no longer knows task-1, so the mirror settles it as interrupted.
    expect(emitted).toEqual([['s1', [expect.objectContaining({ id: 'task-1', status: 'interrupted' })]]]);
    sync.dispose();
  });

  test('tolerates a failing session key and follows pagination cursors', async () => {
    const store = new MemoryStore();
    const request = vi.fn(async (_method: string, params: { sessionKey: string; cursor?: string }) => {
      if (params.sessionKey === 'bad') throw new Error('unknown session');
      if (!params.cursor) return { tasks: [{ taskId: 'a', kind: 'exec', status: 'running', startedAt: 1 }], nextCursor: '1' };
      return { tasks: [{ taskId: 'b', kind: 'exec', status: 'succeeded', startedAt: 1, endedAt: 2 }] };
    });
    const sync = new OpenClawBackgroundJobSync({
      store: store as unknown as BackgroundJobStore,
      getGatewayRequest: () => request as never,
      getSessionKeys: () => ['bad', 'good'],
      emit: () => undefined,
    });
    const jobs = await sync.list('s1');
    expect(jobs.map(job => job.id).sort()).toEqual(['a', 'b']);
    expect(request).toHaveBeenCalledTimes(3);
    sync.dispose();
  });
});
