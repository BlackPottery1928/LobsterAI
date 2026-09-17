import { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { isTurnChangesArtifact } from '../../../shared/artifactPreview/turnChanges';
import { artifactContentRevision, type ResolvedArtifactOutput } from '../../../shared/artifactPreview/workspace';
import type { RootState } from '../../store';
import { addArtifact } from '../../store/slices/artifactSlice';

/** Refresh an existing review in place; discovery and tab activation remain explicit user actions. */
export function useSyncTurnReview(sessionId?: string, latest?: ResolvedArtifactOutput | null): void {
  const dispatch = useDispatch();
  const existing = useSelector((state: RootState) => sessionId && latest?.sessionId === sessionId
    ? state.artifact.artifactsBySession[sessionId]?.find(artifact => artifact.id === latest.id)
    : undefined);

  useEffect(() => {
    if (!sessionId || !latest || latest.sessionId !== sessionId || !isTurnChangesArtifact(latest.id)
      || !existing || existing.sessionId !== sessionId
      || artifactContentRevision(existing) === artifactContentRevision(latest)) return;
    // Preserve the localized label chosen when the user first opened this review.
    dispatch(addArtifact({ sessionId, artifact: { ...latest, title: existing.title } }));
  }, [dispatch, sessionId, latest, existing]);
}
