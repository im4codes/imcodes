import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildBranchName } from '../../src/autofix/branch-manager.js';

// buildBranchName is a pure function we can test directly.
// createBranch/mergeBranch/pushBranch require git — test branch naming only.

describe('buildBranchName', () => {
  it('formats as fix/<id>-<slug>', () => {
    expect(buildBranchName('42', 'Fix login redirect')).toBe('fix/42-fix-login-redirect');
  });

  it('sanitizes special chars in title', () => {
    expect(buildBranchName('7', 'feat: [WIP] Add OAuth2 & PKCE')).toBe('fix/7-feat-wip-add-oauth2-pkce');
  });

  it('handles numeric issue ID', () => {
    const result = buildBranchName('123', 'Simple fix');
    expect(result).toMatch(/^fix\/123-/);
  });

  it('truncates long titles', () => {
    const result = buildBranchName('1', 'A'.repeat(200));
    // slug part should be max 50 chars
    const slug = result.replace('fix/1-', '');
    expect(slug.length).toBeLessThanOrEqual(50);
  });

  it('collapses multiple spaces and special chars', () => {
    expect(buildBranchName('5', 'Fix   bug --- now')).toBe('fix/5-fix-bug-now');
  });

  it('does not end with hyphen', () => {
    const result = buildBranchName('1', 'test');
    expect(result).not.toMatch(/-$/);
  });
});

// Integration-style tests for createBranch/mergeBranch are skipped (require real git)
describe.skip('createBranch (requires git)', () => {
  it('creates a new branch from base');
  it('handles already-existing branch gracefully');
});

describe.skip('mergeBranch (requires git)', () => {
  it('merges feature branch into base');
  it('aborts on conflict');
});

describe.skip('pushBranch (requires git remote)', () => {
  it('pushes branch with set-upstream');
});
