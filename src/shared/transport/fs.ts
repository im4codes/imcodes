export interface FsEntry {
  name: string;
  isDir: boolean;
  hidden: boolean;
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
}

export interface FsGitStatusResponse extends FsBaseResponse {
  type: 'fs.git_status_response';
  files?: GitStatusEntry[];
}

export interface FsGitDiffResponse extends FsBaseResponse {
  type: 'fs.git_diff_response';
  diff?: string;
}
