import type { FsReadErrorCode, FsReadPreviewReason } from '../../../shared/fs-read-error-codes.js';
import { FS_TRANSPORT_MSG } from '../../../shared/fs-transport-messages.js';

/** Virtual path used by shared clients that are not allowed to learn projectDir before browsing. */
export const FS_SESSION_ROOT_PATH = ':session-root:';

export interface FsEntry {
  name: string;
  /** Absolute path for this entry when the parent is a virtual root (e.g. Windows drives). */
  path?: string;
  isDir: boolean;
  hidden: boolean;
  /** File size in bytes (only when includeMetadata requested). */
  size?: number;
  /** Last-modified / creation time in epoch ms; only a controlled node's listing query supplies them. */
  mtimeMs?: number;
  birthtimeMs?: number;
  /** MIME type inferred from extension (only for files with includeMetadata). */
  mime?: string;
  /** Controlled download handle ID (only when includeMetadata requested). */
  downloadId?: string;
  /** OpenSpec task checkbox summary, only when explicitly requested for openspec/changes. */
  openSpecTaskStats?: OpenSpecTaskStats;
  /**
   * Capacity of the volume this entry IS, populated only for volume roots.
   * Measuring per entry would be one syscall per row for a value identical
   * across every row in the listing.
   */
  totalBytes?: number;
  freeBytes?: number;
}

export interface OpenSpecTaskStats {
  total: number;
  checked: number;
  unchecked: number;
}

export interface GitStatusEntry {
  path: string;
  code: string;
  additions?: number;
  deletions?: number;
}

/** Hard cap on per-response changed-file entries returned by `fs.git_status` to keep WS frames bounded on huge repos. */
export const FS_GIT_STATUS_MAX_FILES = 1000;

/**
 * Cap changed-file entries to `maxFiles` while keeping `totalCount` exact.
 * Tracked/staged changes (codes other than `??` and `!!`) are prioritized ahead of untracked (`??`) and ignored (`!!`) entries.
 */
export function capFsGitStatusFiles<T extends { code: string }>(
  files: readonly T[],
  maxFiles = FS_GIT_STATUS_MAX_FILES,
): { files: T[]; totalCount: number; truncated: boolean } {
  const totalCount = files.length;
  if (totalCount <= maxFiles) {
    return { files: [...files], totalCount, truncated: false };
  }
  const tracked: T[] = [];
  const untracked: T[] = [];
  const ignored: T[] = [];
  for (const file of files) {
    if (file.code === '??') untracked.push(file);
    else if (file.code === '!!') ignored.push(file);
    else tracked.push(file);
  }
  const prioritized: T[] = [];
  for (const bucket of [tracked, untracked, ignored]) {
    for (const file of bucket) {
      if (prioritized.length >= maxFiles) break;
      prioritized.push(file);
    }
    if (prioritized.length >= maxFiles) break;
  }
  return { files: prioritized, totalCount, truncated: true };
}

export const FS_WRITE_ERROR = {
  FILE_EXISTS: 'file_exists',
} as const;

interface FsBaseResponse {
  requestId: string;
  path: string;
  resolvedPath?: string;
  status: 'ok' | 'error';
  error?: string;
}

export interface FsLsResponse extends FsBaseResponse {
  type: 'fs.ls_response';
  entries?: FsEntry[];
  /** A controlled node's listing query matched more entries than `entries` carries. */
  truncated?: boolean;
  /** How many entries matched, when `truncated`. */
  total?: number;
  /** The order was computed over only part of the matches. */
  partial?: boolean;
}

export interface FsReadResponse extends FsBaseResponse {
  type: 'fs.read_response';
  content?: string;
  encoding?: 'base64';
  mimeType?: string;
  previewMode?: 'stream';
  /** Preview metadata: why preview is unavailable. */
  previewReason?: FsReadPreviewReason;
  error?: FsReadErrorCode | string;
  /** Controlled download handle ID for this file. */
  downloadId?: string;
  /** File's last modified time in milliseconds (for conflict detection). */
  mtime?: number;
  /** File size in bytes when the daemon returns stream/download metadata. */
  size?: number;
  /** Redacted daemon-side candidate labels for a chat file reference. */
  attemptedLocations?: string[];
  /** Number of bounded filename-search matches; newest mtime is selected. */
  resolutionMatchCount?: number;
}

export interface FsWriteRequest {
  type: 'fs.write';
  requestId: string;
  path: string;
  content: string;
  /** mtime from last read; omit = force write */
  expectedMtime?: number;
  /** Create a new file only; fail if the target already exists. */
  createOnly?: boolean;
  /** Session whose project directory scopes this write, when available. */
  sessionName?: string;
}

export interface FsWriteOptions {
  /** mtime from last read; omit = force write */
  expectedMtime?: number;
  /** Create a new file only; fail if the target already exists. */
  createOnly?: boolean;
  /** Session whose project directory scopes this write, when available. */
  sessionName?: string;
}

export interface FsWriteResponse extends Omit<FsBaseResponse, 'status'> {
  type: 'fs.write_response';
  status: 'ok' | 'error' | 'conflict';
  /** New mtime after successful write */
  mtime?: number;
  /** Conflict: current file content on disk (capped at 1MB) */
  diskContent?: string;
  /** Conflict: current mtime on disk */
  diskMtime?: number;
}

export interface FsGitStatusResponse extends FsBaseResponse {
  type: 'fs.git_status_response';
  files?: GitStatusEntry[];
  /** Exact number of matching changed files before truncation (or in summaryOnly mode). */
  totalCount?: number;
  /** True when `files` was truncated or omitted (summaryOnly) relative to `totalCount`. */
  truncated?: boolean;
}

export interface FsGitDiffResponse extends FsBaseResponse {
  type: 'fs.git_diff_response';
  diff?: string;
}

export interface FsMkdirResponse extends FsBaseResponse {
  type: 'fs.mkdir_response';
}

export interface FsRenameRequest {
  type: typeof FS_TRANSPORT_MSG.RENAME;
  requestId: string;
  path: string;
  newPath: string;
  /** Session whose project directory scopes this write, when available. */
  sessionName?: string;
}

export interface FsRenameResponse extends FsBaseResponse {
  type: typeof FS_TRANSPORT_MSG.RENAME_RESPONSE;
  newPath?: string;
}

export interface FsDeleteRequest {
  type: typeof FS_TRANSPORT_MSG.DELETE;
  requestId: string;
  path: string;
  /** Session whose project directory scopes this write, when available. */
  sessionName?: string;
}

export interface FsDeleteResponse extends FsBaseResponse {
  type: typeof FS_TRANSPORT_MSG.DELETE_RESPONSE;
}
