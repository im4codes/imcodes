import type { FsReadErrorCode, FsReadPreviewReason } from '../../../shared/fs-read-error-codes.js';
import { FS_TRANSPORT_MSG } from '../../../shared/fs-transport-messages.js';

export interface FsEntry {
  name: string;
  /** Absolute path for this entry when the parent is a virtual root (e.g. Windows drives). */
  path?: string;
  isDir: boolean;
  hidden: boolean;
  /** File size in bytes (only when includeMetadata requested). */
  size?: number;
  /** MIME type inferred from extension (only for files with includeMetadata). */
  mime?: string;
  /** Controlled download handle ID (only when includeMetadata requested). */
  downloadId?: string;
  /** OpenSpec task checkbox summary, only when explicitly requested for openspec/changes. */
  openSpecTaskStats?: OpenSpecTaskStats;
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
}

export interface FsWriteOptions {
  /** mtime from last read; omit = force write */
  expectedMtime?: number;
  /** Create a new file only; fail if the target already exists. */
  createOnly?: boolean;
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
