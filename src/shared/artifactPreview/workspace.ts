import type { ReviewScopeDescriptor } from './reviewScopes';
import type { ChangeReviewScope } from './turnChanges';

export interface WorkspaceChangesSummary {
  review?: ReviewScopeDescriptor;
  scope?: typeof ChangeReviewScope[keyof typeof ChangeReviewScope];
  cwd: string;
  branch: string | null;
  /** Fixed Git baseline; null denotes an unborn repository. */
  baseRevision?: string | null;
  added: number;
  removed: number;
  totalChangedFiles: number;
  statsIncomplete: boolean;
  /** Only an intermediate capture was recovered; final filesystem state could not be recorded. */
  captureIncomplete?: boolean;
  truncated: boolean;
  files: Array<{ path: string; status: string; added: number | null; removed: number | null }>;
}

/** Lightweight persisted output identity. Bodies are resolved on demand. */
export interface ArtifactOutputReference {
  id: string;
  sessionId: string;
  messageId: string;
  type: 'html' | 'svg' | 'image' | 'video' | 'mermaid' | 'code' | 'markdown' | 'text' | 'document' | 'local-service';
  title: string;
  createdAt: number;
  filePath?: string;
  fileName?: string;
  url?: string;
  language?: string;
  contentVersion?: number;
  workspaceChanges?: WorkspaceChangesSummary;
}

export interface ResolvedArtifactOutput extends ArtifactOutputReference {
  content: string;
  source?: 'inline' | 'tool' | 'file';
  remoteUrl?: string;
}

export function artifactContentRevision(artifact: { contentVersion?: number; content?: string }): string {
  if (typeof artifact.contentVersion === 'number') return `v${artifact.contentVersion}`;
  if (!artifact.content) return 'unversioned';
  let hash = 2166136261;
  for (let index = 0; index < artifact.content.length; index += 1) hash = Math.imul(hash ^ artifact.content.charCodeAt(index), 16777619);
  return `content-${(hash >>> 0).toString(16)}`;
}

/** Media, fonts, archives and documents: edits to these are not "code or text" changes for the changes badge. */
const NON_TEXT_CHANGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns', 'tif', 'tiff', 'heic', 'heif', 'avif', 'psd',
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'dmg', 'exe', 'dll', 'so', 'dylib', 'bin', 'wasm',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'sqlite', 'db',
]);

/**
 * Whether a changed file counts as a code/text change. Binary diffs (no line stats) and
 * media-like extensions are left out of the changes badge; they still appear in the review.
 */
export const isTextLikeWorkspaceChange = (file: { path: string; added: number | null; removed: number | null }): boolean => {
  if (file.added === null && file.removed === null) return false;
  const name = file.path.split(/[\\/]/).pop() ?? file.path;
  const dot = name.lastIndexOf('.');
  const extension = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  return !NON_TEXT_CHANGE_EXTENSIONS.has(extension);
};
