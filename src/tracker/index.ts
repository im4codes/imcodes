/**
 * Tracker factory — creates the right IssueTracker implementation.
 */
import type { IssueTracker } from './interface.js';
import { GitHubTracker } from './github.js';
import { GitLabTracker } from './gitlab.js';

export type { IssueTracker, TrackerIssue, FetchIssueOptions, Priority } from './interface.js';
export { extractPriority, priorityName, sortByPriority } from './priority.js';
export { buildBranchName, slugify, isValidBranchName } from './branch.js';

export function createTracker(type: string, apiUrl?: string): IssueTracker {
  const token = process.env.TRACKER_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GITLAB_TOKEN ?? '';
  const repo = process.env.TRACKER_REPO ?? process.env.GITHUB_REPO ?? '';
  const projectId = process.env.TRACKER_PROJECT_ID ?? process.env.GITLAB_PROJECT_ID ?? '';

  switch (type) {
    case 'github':
      return new GitHubTracker({ apiUrl, token, repo });
    case 'gitlab':
      return new GitLabTracker({ apiUrl, token, projectId });
    default:
      throw new Error(`Unknown tracker type: ${type}`);
  }
}
