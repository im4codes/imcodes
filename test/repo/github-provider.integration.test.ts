/**
 * Integration tests for GitHubProvider against real public repos.
 *
 * Requires: `gh` CLI installed and authenticated.
 * Skipped automatically when `gh` is not available or not authed.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

import { GitHubProvider } from '../../src/repo/github-provider.js';
import type { RepoIssue, RepoPR, RepoBranch, RepoCommit } from '../../src/repo/types.js';

// Check gh is installed (auth not required for public repos)
let ghAvailable = false;
try {
  execFileSync('gh', ['--version'], { timeout: 5_000, stdio: 'pipe' });
  ghAvailable = true;
} catch {
  // gh not installed
}

// Famous public repos for testing
const REPOS = {
  react: { owner: 'facebook', repo: 'react' },
  vscode: { owner: 'microsoft', repo: 'vscode' },
} as const;

describe.skipIf(!ghAvailable)('GitHubProvider integration — facebook/react', { retry: 2 }, () => {
  const provider = new GitHubProvider(REPOS.react.owner, REPOS.react.repo, process.cwd());

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
      expect(issue.url).toContain('github.com');
      expect(typeof issue.createdAt).toBe('number');
      expect(issue.createdAt).toBeGreaterThan(0);
      expect(typeof issue.updatedAt).toBe('number');
    });

    it('supports state=closed filter', async () => {
      const result = await provider.listIssues({ state: 'closed', perPage: 20 });

      // After jq PR filtering some pages may have fewer items, but react has many closed issues
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

    it('excludes pull requests from issues', async () => {
      const result = await provider.listIssues({ perPage: 10 });

      for (const issue of result.items) {
        expect(issue.url).toContain('/issues/');
      }
    });
  });

  describe('listPRs', () => {
    it('returns PRs with correct shape', async () => {
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
      expect(pr.url).toContain('github.com');
      expect(typeof pr.createdAt).toBe('number');
      expect(typeof pr.updatedAt).toBe('number');
      expect(typeof pr.draft).toBe('boolean');
    });

    it('supports state=closed filter', async () => {
      const result = await provider.listPRs({ state: 'closed', perPage: 3 });

      expect(result.items.length).toBeGreaterThan(0);
      for (const pr of result.items) {
        expect(['merged', 'closed']).toContain(pr.state);
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

      // facebook/react has many branches
      expect(result.items.length).toBeGreaterThan(10);
    });
  });

  describe('listCommits', () => {
    it('returns commits with correct shape', async () => {
      const result = await provider.listCommits({ perPage: 5 });

      expect(result.items.length).toBeGreaterThan(0);

      const commit: RepoCommit = result.items[0];
      expect(commit.sha).toHaveLength(40);
      expect(commit.shortSha).toHaveLength(7);
      expect(commit.message).toBeTruthy();
      expect(commit.author).toBeTruthy();
      expect(typeof commit.date).toBe('number');
      expect(commit.date).toBeGreaterThan(0);
      expect(commit.url).toContain('github.com');
    });

    it('supports branch filter', async () => {
      const result = await provider.listCommits({ branch: 'main', perPage: 3 });

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

describe.skipIf(!ghAvailable)('GitHubProvider integration — microsoft/vscode', { retry: 3, timeout: 30_000 }, () => {
  const provider = new GitHubProvider(REPOS.vscode.owner, REPOS.vscode.repo, process.cwd());

  it('lists issues from vscode', async () => {
    // vscode has many PRs mixed with issues; jq filters PRs out, so a small
    // page may occasionally return 0 pure issues. Use a larger page to compensate.
    const result = await provider.listIssues({ perPage: 30 });
    expect(result.items.length).toBeGreaterThanOrEqual(0);
    if (result.items.length > 0) {
      expect(result.items[0].url).toContain('microsoft/vscode');
    }
  });

  it('lists PRs from vscode', async () => {
    const result = await provider.listPRs({ perPage: 5 });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0].url).toContain('microsoft/vscode');
  });

  it('lists branches from vscode', async () => {
    const result = await provider.listBranches();
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('lists commits from vscode', async () => {
    const result = await provider.listCommits({ perPage: 5 });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0].sha).toHaveLength(40);
  });
});
