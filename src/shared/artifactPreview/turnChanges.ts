export const ChangeCaptureState = { Capturing: 'capturing', Active: 'active', Completed: 'completed', Interrupted: 'interrupted', Unavailable: 'unavailable' } as const;
export const ChangeReviewScope = { Repository: 'repository', Turn: 'turn' } as const;
export const TURN_CHANGES_PREFIX = 'turn-changes:';
export const isTurnChangesArtifact = (id: string): boolean => id.startsWith(TURN_CHANGES_PREFIX);
