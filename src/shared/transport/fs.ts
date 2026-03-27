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
}

export interface FsGitStatusResponse extends FsBaseResponse {
  type: 'fs.git_status_response';
  files?: GitStatusEntry[];
}

export interface FsGitDiffResponse extends FsBaseResponse {
  type: 'fs.git_diff_response';
  diff?: string;
}
