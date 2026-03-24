/** Repo Management View — shared types. */

export type RepoPlatform = 'github' | 'gitlab' | 'unknown';

export type RepoStatus =
  | 'ok'
  | 'no_repo'
  | 'cli_missing'
  | 'cli_outdated'
  | 'unauthorized'
  | 'multiple_remotes'
  | 'unknown_platform';

export interface RepoRemote {
  name: string;       // e.g. 'origin'
  url: string;
  platform: RepoPlatform;
}

export interface RepoInfo {
  platform: RepoPlatform;
  owner: string;
  repo: string;
  remoteUrl: string;
  apiUrl?: string;          // for self-hosted
  defaultBranch?: string;
  currentBranch?: string;
}

export interface RepoContext {
  info: RepoInfo | null;
  status: RepoStatus;
  cliVersion?: string;
  cliMinVersion?: string;
  cliAuth?: boolean;
  remotes?: RepoRemote[];   // present when status='multiple_remotes'
}

export interface RepoListResult<T> {
  items: T[];
  page: number;
  hasMore: boolean;
  projectDir: string;
}

// Independent of TrackerIssue — no import from src/tracker/
export interface RepoIssue {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  author: string;
  labels: string[];
  url: string;
  assignee?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RepoPR {
  number: number;
  title: string;
  state: 'open' | 'merged' | 'closed';
  author: string;
  head: string;
  base: string;
  url: string;
  createdAt: number;
  updatedAt: number;
  reviewDecision?: string;
  draft?: boolean;
  labels?: string[];
}

export interface RepoBranch {
  name: string;
  isDefault: boolean;
  isCurrent: boolean;
  aheadBy?: number;
  behindBy?: number;
  lastCommitDate?: number;
}

export interface RepoCommit {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: number;
  url: string;
}

export interface RepoWorkflowRun {
  id: number;
  name: string;           // workflow name
  status: 'queued' | 'running' | 'success' | 'failure' | 'cancelled';
  branch: string;
  commitSha: string;
  commitMessage: string;
  actor: string;          // who triggered it
  url: string;
  createdAt: number;
  updatedAt: number;
  duration?: number;      // seconds
}

export interface RepoCommitDetailFile {
  filename: string;
  status: string;
  additions?: number;
  deletions?: number;
}

export interface RepoCommitDetail extends RepoCommit {
  body: string;
  stats: { additions: number; deletions: number; filesChanged: number };
  files: RepoCommitDetailFile[];
  hasMoreFiles: boolean;
}

export interface RepoPRDetail extends RepoPR {
  body: string;
  bodyTruncated: boolean;
  checksStatus: 'success' | 'failure' | 'pending' | 'none';
  additions: number;
  deletions: number;
  changedFiles: number;
  comments: number;
  mergeable: boolean | null;
}

export interface RepoIssueComment {
  author: string;
  body: string;
  createdAt: number;
}

export interface RepoIssueDetail extends RepoIssue {
  comments: RepoIssueComment[];
  bodyTruncated: boolean;
}

/** Structured error from providers — never exposes raw CLI output. */
export type RepoError =
  | 'unauthorized'
  | 'rate_limited'
  | 'cli_error'
  | 'cli_missing'
  | 'cli_outdated'
  | 'unknown_project'
  | 'invalid_params'
  | 'not_detected';
