import { useCallback, useEffect, useRef, useState } from 'react';

import { type BackgroundJobKillResult, isLiveBackgroundJobStatus } from '../../../shared/cowork/backgroundJobs';
import type { CoworkBackgroundJob } from '../../types/cowork';

const POLL_INTERVAL_MS = 5_000;

export interface UseBackgroundJobsOptions {
  /** Whether the session is still running (main agent busy). */
  sessionRunning: boolean;
  /** Whether the task panel is in the foreground; when hidden only pushed frames are applied. */
  panelActive: boolean;
}

/**
 * Background jobs of a session. Frames pushed from the main process are the
 * primary source; a low-frequency fetch only runs while a job is live or the
 * session is running with the panel open, to cover a missed push.
 */
export const useBackgroundJobs = (
  sessionId: string | null | undefined,
  { sessionRunning, panelActive }: UseBackgroundJobsOptions,
) => {
  const [jobs, setJobs] = useState<CoworkBackgroundJob[]>([]);
  const [loading, setLoading] = useState(false);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const refresh = useCallback(async (options: { showLoading?: boolean } = {}) => {
    const target = sessionIdRef.current;
    if (!target) return;
    if (options.showLoading) setLoading(true);
    try {
      const result = await window.electron?.cowork?.listBackgroundJobs?.(target);
      if (sessionIdRef.current !== target || !result?.success) return;
      setJobs(current => (JSON.stringify(current) === JSON.stringify(result.jobs) ? current : result.jobs));
    } catch {
      // Keep the previous frame; the next push will overwrite it.
    } finally {
      if (sessionIdRef.current === target) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setJobs([]);
    if (!sessionId) return;
    void refresh({ showLoading: true });
  }, [refresh, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const unsubscribe = window.electron?.cowork?.onBackgroundJobsEvent?.(event => {
      if (event.sessionId !== sessionIdRef.current) return;
      setJobs(event.jobs);
    });
    return () => { unsubscribe?.(); };
  }, [sessionId]);

  const hasLive = jobs.some(job => isLiveBackgroundJobStatus(job.status));
  const shouldPoll = hasLive || (sessionRunning && panelActive);
  useEffect(() => {
    if (!sessionId || !shouldPoll) return;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh, sessionId, shouldPoll]);

  const kill = useCallback(async (jobId: string): Promise<BackgroundJobKillResult & { success: boolean; error?: string }> => {
    const target = sessionIdRef.current;
    if (!target) return { success: false, outcome: 'unsupported' };
    try {
      const result = await window.electron?.cowork?.killBackgroundJob?.({ sessionId: target, jobId });
      if (!result) return { success: false, outcome: 'unsupported' };
      if (result.jobs && sessionIdRef.current === target) setJobs(result.jobs);
      return { success: result.success, outcome: result.outcome ?? 'unsupported', error: result.error };
    } catch (error) {
      return { success: false, outcome: 'unsupported', error: error instanceof Error ? error.message : String(error) };
    }
  }, []);

  const clearSettled = useCallback(async (): Promise<void> => {
    const target = sessionIdRef.current;
    if (!target) return;
    try {
      const result = await window.electron?.cowork?.clearSettledBackgroundJobs?.(target);
      if (result?.success && sessionIdRef.current === target) setJobs(result.jobs);
    } catch {
      // Keep the current list; the next push will overwrite it.
    }
  }, []);

  return {
    jobs,
    loading,
    refresh,
    kill,
    clearSettled,
    liveCount: jobs.filter(job => isLiveBackgroundJobStatus(job.status)).length,
  };
};
