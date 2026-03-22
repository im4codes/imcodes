/**
 * Shared repo message type constants — single source of truth.
 * Used by daemon (sender) and server bridge (relay) to avoid type name drift.
 */

export const REPO_MSG = {
  // Browser → Daemon (requests)
  DETECT: 'repo.detect',
  LIST_ISSUES: 'repo.list_issues',
  LIST_PRS: 'repo.list_prs',
  LIST_BRANCHES: 'repo.list_branches',
  LIST_COMMITS: 'repo.list_commits',

  // Daemon → Browser (responses)
  DETECT_RESPONSE: 'repo.detect_response',
  DETECTED: 'repo.detected',
  ISSUES_RESPONSE: 'repo.issues_response',
  PRS_RESPONSE: 'repo.prs_response',
  BRANCHES_RESPONSE: 'repo.branches_response',
  COMMITS_RESPONSE: 'repo.commits_response',
  ERROR: 'repo.error',
} as const;

/** All response types that bridge should relay from daemon to browser. */
export const REPO_RELAY_TYPES = new Set([
  REPO_MSG.DETECT_RESPONSE,
  REPO_MSG.DETECTED,
  REPO_MSG.ISSUES_RESPONSE,
  REPO_MSG.PRS_RESPONSE,
  REPO_MSG.BRANCHES_RESPONSE,
  REPO_MSG.COMMITS_RESPONSE,
  REPO_MSG.ERROR,
]);
