export const ReviewScope = { Turn: 'turn', Repository: 'repository', Unstaged: 'unstaged', Staged: 'staged', Branch: 'branch', Commit: 'commit' } as const;
export type ReviewScope = typeof ReviewScope[keyof typeof ReviewScope];
export const ReviewIpc = {
  /** Build a review artifact for a scope (this turn, working tree, staged, branch or commit). */
  Read: 'cowork:review:read',
  /** Read the complete old/new source of one reviewed file for syntax highlighting and context expansion. */
  Source: 'cowork:review:source',
  /** Latest turn review of a session, refreshed while the turn is still running. */
  Latest: 'cowork:review:latest',
  /** Main to renderer: a turn review of the given session was finalized. */
  Changed: 'cowork:review:changed',
} as const;
export const SCOPED_REVIEW_PREFIX = 'scoped-review:';
export interface ReviewScopeRequest { sessionId: string; scope: ReviewScope; reference?: string }
export interface ReviewScopeDescriptor { refreshedOnRestore?: boolean; scope: ReviewScope; reference?: string; baseRevision?: string | null; targetRevision?: string | null }
