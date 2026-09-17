import { useCallback, useEffect, useState } from 'react';

import type { ResolvedArtifactOutput } from '../../../shared/artifactPreview/workspace';
import type { CoworkSession } from '../../types/cowork';

export interface CoworkTurnReviewState {
  /** Latest turn review of the current session; refreshed while the turn runs and when the host finalizes it. */
  latest: ResolvedArtifactOutput | null;
  refresh: () => void;
}

/** One source for the conversation changes badge. Streaming text deltas never trigger workspace reads. */
export function useCoworkTurnReview(session?: CoworkSession | null, enabled = true): CoworkTurnReviewState {
  const sessionId = session?.id;
  const cwd = session?.cwd;
  const status = session?.status;
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const [state, setState] = useState<{ sessionId: string; cwd: string; latest: ResolvedArtifactOutput | null } | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId || !cwd) return;
    let cancelled = false;
    let sequence = 0;
    const load = async () => {
      const request = ++sequence;
      try {
        const latest = await window.electron?.workspaceReview?.latest?.(sessionId);
        if (!cancelled && request === sequence) setState({ sessionId, cwd, latest: latest ?? null });
      } catch {
        if (!cancelled && request === sequence) setState({ sessionId, cwd, latest: null });
      }
    };
    void load();
    const onFocus = () => { void load(); };
    window.addEventListener('focus', onFocus);
    const unsubscribe = window.electron?.workspaceReview?.onChanged?.(changedSessionId => { if (changedSessionId === sessionId) void load(); });
    const timer = status === 'running' ? window.setInterval(onFocus, 5000) : undefined;
    return () => {
      cancelled = true;
      unsubscribe?.();
      window.removeEventListener('focus', onFocus);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [enabled, sessionId, cwd, status, revision]);

  const current = enabled && state?.sessionId === sessionId && state?.cwd === cwd ? state : null;
  return { latest: current?.latest ?? null, refresh };
}
