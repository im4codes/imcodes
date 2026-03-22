/**
 * Contract test: verifies that daemon response types, bridge relay types,
 * and browser message types all agree on the same type name strings.
 *
 * Prevents the "type name drift" bug where daemon sends repo.issues_response
 * but bridge expects repo.list_issues_response — causing silent message drops.
 */
import { describe, it, expect } from 'vitest';
import { REPO_MSG, REPO_RELAY_TYPES } from '../../shared/repo-types.js';

describe('Repo message type contract', () => {
  it('REPO_MSG constants are non-empty strings', () => {
    for (const [key, value] of Object.entries(REPO_MSG)) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
      expect(value).toMatch(/^repo\./);
    }
  });

  it('all response types are in REPO_RELAY_TYPES', () => {
    const responseTypes = [
      REPO_MSG.DETECT_RESPONSE,
      REPO_MSG.DETECTED,
      REPO_MSG.ISSUES_RESPONSE,
      REPO_MSG.PRS_RESPONSE,
      REPO_MSG.BRANCHES_RESPONSE,
      REPO_MSG.COMMITS_RESPONSE,
      REPO_MSG.ERROR,
    ];

    for (const t of responseTypes) {
      expect(REPO_RELAY_TYPES.has(t), `${t} should be in REPO_RELAY_TYPES`).toBe(true);
    }
  });

  it('request types are NOT in REPO_RELAY_TYPES (they go browser→daemon, not relayed back)', () => {
    const requestTypes = [
      REPO_MSG.DETECT,
      REPO_MSG.LIST_ISSUES,
      REPO_MSG.LIST_PRS,
      REPO_MSG.LIST_BRANCHES,
      REPO_MSG.LIST_COMMITS,
    ];

    for (const t of requestTypes) {
      expect((REPO_RELAY_TYPES as Set<string>).has(t), `${t} should NOT be in REPO_RELAY_TYPES`).toBe(false);
    }
  });

  it('response type names match expected pattern (no list_ prefix)', () => {
    // This test explicitly catches the bug: someone adding "list_" prefix to response types
    expect(REPO_MSG.ISSUES_RESPONSE).toBe('repo.issues_response');
    expect(REPO_MSG.PRS_RESPONSE).toBe('repo.prs_response');
    expect(REPO_MSG.BRANCHES_RESPONSE).toBe('repo.branches_response');
    expect(REPO_MSG.COMMITS_RESPONSE).toBe('repo.commits_response');

    // Request types DO have list_ prefix
    expect(REPO_MSG.LIST_ISSUES).toBe('repo.list_issues');
    expect(REPO_MSG.LIST_PRS).toBe('repo.list_prs');
  });

  it('REPO_RELAY_TYPES has exactly 7 entries', () => {
    expect(REPO_RELAY_TYPES.size).toBe(7);
  });
});
