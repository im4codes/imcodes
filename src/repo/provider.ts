/** Repo provider interface — read-only V1. */

import type {
  RepoContext,
  RepoListResult,
  RepoIssue,
  RepoPR,
  RepoBranch,
  RepoCommit,
  RepoWorkflowRun,
  RepoActionDetail,
  RepoCommitDetail,
  RepoPRDetail,
  RepoIssueDetail,
} from './types.js';

export interface ListOptions {
  state?: string;
  page?: number;
  perPage?: number;
}

export interface CommitListOptions {
  branch?: string;
  page?: number;
  perPage?: number;
}

export interface RepoProvider {
  /** Detect repo platform, CLI availability, auth status. */
  detect(projectDir: string): Promise<RepoContext>;

  /** List issues. Default page size: 20. */
  listIssues(opts?: ListOptions): Promise<RepoListResult<RepoIssue>>;

  /** List pull requests / merge requests. Default page size: 20. */
  listPRs(opts?: ListOptions): Promise<RepoListResult<RepoPR>>;

  /** List branches. */
  listBranches(): Promise<RepoListResult<RepoBranch>>;

  /** List commits, optionally filtered by branch. Default page size: 20. */
  listCommits(opts?: CommitListOptions): Promise<RepoListResult<RepoCommit>>;

  /** List CI/CD workflow runs (Actions / Pipelines). Default page size: 20. */
  listActions(opts?: ListOptions): Promise<RepoListResult<RepoWorkflowRun>>;

  /** Get detailed CI/CD run info including jobs and steps. */
  getActionDetail(runId: number): Promise<RepoActionDetail>;

  /** Get detailed commit info including stats and file list. */
  getCommitDetail(sha: string): Promise<RepoCommitDetail>;

  /** Get detailed pull request / merge request info. */
  getPRDetail(number: number): Promise<RepoPRDetail>;

  /** Get detailed issue info including comments. */
  getIssueDetail(number: number): Promise<RepoIssueDetail>;
}

export const DEFAULT_PAGE_SIZE = 5;
