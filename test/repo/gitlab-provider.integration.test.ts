/**
 * Integration tests for GitLabProvider against real public repos.
 *
 * Requires: `glab` CLI installed and authenticated.
 * Skipped automatically when `glab` is not available or not authed.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

import { GitLabProvider } from '../../src/repo/gitlab-provider.js';
import type { RepoIssue, RepoPR, RepoBranch, RepoCommit } from '../../src/repo/types.js';

// glab requires auth even for public repos — check both installed and authed
let glabAvailable = false;
try {
  execFileSync('glab', ['auth', 'status'], { timeout: 10_000, stdio: 'pipe' });
  glabAvailable = true;
} catch {
  // glab not installed or not authenticated — skip tests
}

// Famous public GitLab repos
const REPOS = {
  gitlab: { owner: 'gitlab-org', repo: 'gitlab' },
  fdroid: { owner: 'fdroid', repo: 'fdroidclient' },
} as const;

describe.skipIf(!glabAvailable)('GitLabProvider integration — gitlab-org/gitlab', () => {
  const provider = new GitLabProvider(REPOS.gitlab.owner, REPOS.gitlab.repo, process.cwd());

  describe('listIssues', () => {
    it('returns issues with correct shape', async () => {
      const result = await provider.listIssues({ perPage: 5 });

      expect(result.items.length).toBeGreaterThan(0);
      expect(result.items.length).toBeLessThanOrEqual(5);
      expect(result.page).toBe(1);
      expect(typeof result.hasMore).toBe('boolean');

      const issue: RepoIssue = result.items[0];
      expect(issue.id).toBeTruthy();
      expect(typeof issue.number).toBe('number');
      expect(issue.number).toBeGreaterThan(0);
      expect(issue.title).toBeTruthy();
      expect(typeof issue.body).toBe('string');
      expect(issue.state).toBe('open');
      expect(issue.author).toBeTruthy();
      expect(Array.isArray(issue.labels)).toBe(true);
      expect(issue.url).toContain('gitlab.com');
      expect(typeof issue.createdAt).toBe('number');
      expect(issue.createdAt).toBeGreaterThan(0);
      expect(typeof issue.updatedAt).toBe('number');
    });

    it('supports state=closed filter', async () => {
      const result = await provider.listIssues({ state: 'closed', perPage: 3 });

      expect(result.items.length).toBeGreaterThan(0);
      for (const issue of result.items) {
        expect(issue.state).toBe('closed');
      }
    });

    it('supports pagination', async () => {
      const page1 = await provider.listIssues({ page: 1, perPage: 3 });
      const page2 = await provider.listIssues({ page: 2, perPage: 3 });

      expect(page1.page).toBe(1);
      expect(page2.page).toBe(2);

      const ids1 = new Set(page1.items.map((i) => i.number));
      const ids2 = new Set(page2.items.map((i) => i.number));
      const overlap = [...ids1].filter((id) => ids2.has(id));
      expect(overlap.length).toBe(0);
    });
  });

  describe('listPRs (Merge Requests)', () => {
    it('returns MRs with correct shape', async () => {
      const result = await provider.listPRs({ perPage: 5 });

      expect(result.items.length).toBeGreaterThan(0);

      const pr: RepoPR = result.items[0];
      expect(typeof pr.number).toBe('number');
      expect(pr.number).toBeGreaterThan(0);
      expect(pr.title).toBeTruthy();
      expect(['open', 'merged', 'closed']).toContain(pr.state);
      expect(pr.author).toBeTruthy();
      expect(pr.head).toBeTruthy();
      expect(pr.base).toBeTruthy();
      expect(pr.url).toContain('gitlab.com');
      expect(typeof pr.createdAt).toBe('number');
      expect(typeof pr.updatedAt).toBe('number');
      expect(typeof pr.draft).toBe('boolean');
      expect(Array.isArray(pr.labels)).toBe(true);
    });

    it('supports state=merged filter', async () => {
      const result = await provider.listPRs({ state: 'merged', perPage: 3 });

      expect(result.items.length).toBeGreaterThan(0);
      for (const pr of result.items) {
        expect(pr.state).toBe('merged');
      }
    });
  });

  describe('listBranches', () => {
    it('returns branches with correct shape', async () => {
      const result = await provider.listBranches();

      expect(result.items.length).toBeGreaterThan(0);

      const branch: RepoBranch = result.items[0];
      expect(branch.name).toBeTruthy();
      expect(typeof branch.isDefault).toBe('boolean');
      expect(typeof branch.isCurrent).toBe('boolean');
    });

    it('returns multiple branches', async () => {
      const result = await provider.listBranches();

      // gitlab-org/gitlab has many branches
      expect(result.items.length).toBeGreaterThan(5);
    });
  });

  describe('listCommits', () => {
    it('returns commits with correct shape', async () => {
      const result = await provider.listCommits({ perPage: 5 });

      expect(result.items.length).toBeGreaterThan(0);

      const commit: RepoCommit = result.items[0];
      expect(commit.sha).toHaveLength(40);
      expect(commit.shortSha.length).toBeGreaterThan(0);
      expect(commit.shortSha.length).toBeLessThanOrEqual(11);
      expect(commit.message).toBeTruthy();
      expect(commit.author).toBeTruthy();
      expect(typeof commit.date).toBe('number');
      expect(commit.date).toBeGreaterThan(0);
      expect(commit.url).toContain('gitlab.com');
    });

    it('supports branch filter', async () => {
      const result = await provider.listCommits({ branch: 'master', perPage: 3 });

      expect(result.items.length).toBeGreaterThan(0);
      for (const commit of result.items) {
        expect(commit.sha).toHaveLength(40);
      }
    });

    it('supports pagination', async () => {
      const page1 = await provider.listCommits({ page: 1, perPage: 3 });
      const page2 = await provider.listCommits({ page: 2, perPage: 3 });

      const shas1 = new Set(page1.items.map((c) => c.sha));
      const shas2 = new Set(page2.items.map((c) => c.sha));
      const overlap = [...shas1].filter((s) => shas2.has(s));
      expect(overlap.length).toBe(0);
    });
  });
});

describe.skipIf(!glabAvailable)('GitLabProvider integration — fdroid/fdroidclient', () => {
  const provider = new GitLabProvider(REPOS.fdroid.owner, REPOS.fdroid.repo, process.cwd());

  it('lists issues from fdroidclient', async () => {
    const result = await provider.listIssues({ perPage: 3 });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0].url).toContain('gitlab.com');
  });

  it('lists MRs from fdroidclient', async () => {
    const result = await provider.listPRs({ perPage: 3 });
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('lists branches from fdroidclient', async () => {
    const result = await provider.listBranches();
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('lists commits from fdroidclient', async () => {
    const result = await provider.listCommits({ perPage: 3 });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0].sha).toHaveLength(40);
  });
});
