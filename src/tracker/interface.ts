/**
 * IssueTracker interface — adapter pattern for GitHub and GitLab.
 * Supports self-hosted instances via apiUrl configuration.
 */

export type Priority = 0 | 1 | 2 | 3; // 0=critical, 1=high, 2=medium, 3=low

export interface TrackerIssue {
  id: string;
  title: string;
  body: string;
  priority: Priority;
  labels: string[];
  url: string;
  assignee?: string;
  state: 'open' | 'closed';
  createdAt: number;
  updatedAt: number;
}

export interface FetchIssueOptions {
  status?: 'open' | 'closed' | 'all';
  assignedToMe?: boolean;
  labels?: string[];
  milestone?: string;
  limit?: number;
}

export interface IssueTracker {
  /** Fetch issues matching the given filters, sorted by priority. */
  fetchIssues(opts?: FetchIssueOptions): Promise<TrackerIssue[]>;

  /** Claim an issue by assigning it and adding in-progress label. */
  claimIssue(issueId: string): Promise<void>;

  /** Update issue status (add/remove labels, reopen). */
  updateStatus(issueId: string, status: 'in-progress' | 'review' | 'open' | 'done'): Promise<void>;

  /** Post a comment to an issue. */
  postComment(issueId: string, body: string): Promise<void>;

  /** Close an issue with a resolution comment. */
  closeIssue(issueId: string, resolution?: string): Promise<void>;

  /** Create a branch for the issue in the repository. */
  createBranch(issueId: string, branchName: string, fromBranch?: string): Promise<void>;
}
