export interface FsEntry {
  name: string;
  isDir: boolean;
  hidden: boolean;
  /** File size in bytes (only when includeMetadata requested). */
  size?: number;
  /** MIME type inferred from extension (only for files with includeMetadata). */
  mime?: string;
  /** Controlled download handle ID (only when includeMetadata requested). */
  downloadId?: string;
}

export interface GitStatusEntry {
  path: string;
  code: string;
}

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
  /** Preview metadata: why preview is unavailable. */
  previewReason?: 'too_large' | 'binary' | 'unknown_type';
  /** Controlled download handle ID for this file. */
  downloadId?: string;
  /** File's last modified time in milliseconds (for conflict detection). */
  mtime?: number;
}

export interface FsWriteRequest {
  type: 'fs.write';
  requestId: string;
  path: string;
  content: string;
  /** mtime from last read; omit = force write */
  expectedMtime?: number;
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
