import { describe, it, expect } from 'vitest';
import { buildBranchName, slugify, isValidBranchName } from '../../src/tracker/branch.js';

describe('slugify', () => {
  it('lowercases the text', () => {
    expect(slugify('UPPERCASE')).toBe('uppercase');
  });

  it('replaces spaces with hyphens', () => {
    expect(slugify('hello world')).toBe('hello-world');
  });

  it('replaces special characters with hyphens', () => {
    expect(slugify('feat: add auth & login')).toBe('feat-add-auth-login');
  });

  it('collapses consecutive hyphens', () => {
    expect(slugify('a---b')).toBe('a-b');
    expect(slugify('foo  bar  baz')).toBe('foo-bar-baz');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('  hello  ')).toBe('hello');
    expect(slugify('---hello---')).toBe('hello');
  });

  it('truncates to maxLength', () => {
    const result = slugify('a'.repeat(100), 50);
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it('does not end with hyphen after truncation', () => {
    const result = slugify('hello-world-foo-bar-baz-qux-quux', 10);
    expect(result).not.toMatch(/-$/);
  });

  it('handles empty string', () => {
    expect(slugify('')).toBe('');
  });

  it('handles only special chars', () => {
    expect(slugify('---')).toBe('');
  });
});

describe('buildBranchName', () => {
  it('produces fix/<id>-<slug> format', () => {
    const result = buildBranchName('42', 'Fix login redirect bug');
    expect(result).toBe('fix/42-fix-login-redirect-bug');
  });

  it('truncates long titles in the slug portion', () => {
    const longTitle = 'A'.repeat(200);
    const result = buildBranchName('1', longTitle);
    expect(result.length).toBeLessThanOrEqual('fix/1-'.length + 50);
  });

  it('sanitizes special chars in title', () => {
    const result = buildBranchName('7', 'feat: [WIP] Add OAuth2 & PKCE support');
    expect(result).toBe('fix/7-feat-wip-add-oauth2-pkce-support');
  });
});

describe('isValidBranchName', () => {
  it('accepts normal branch names', () => {
    expect(isValidBranchName('fix/42-some-bug')).toBe(true);
    expect(isValidBranchName('feature/add-oauth')).toBe(true);
    expect(isValidBranchName('main')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidBranchName('')).toBe(false);
  });

  it('rejects names with spaces', () => {
    expect(isValidBranchName('fix/ 42')).toBe(false);
  });

  it('rejects names starting or ending with /', () => {
    expect(isValidBranchName('/fix/42')).toBe(false);
    expect(isValidBranchName('fix/42/')).toBe(false);
  });

  it('rejects names ending with .lock', () => {
    expect(isValidBranchName('fix/42.lock')).toBe(false);
  });

  it('rejects names with ..', () => {
    expect(isValidBranchName('fix/..42')).toBe(false);
  });

  it('rejects names with ~, ^, :', () => {
    expect(isValidBranchName('fix~42')).toBe(false);
    expect(isValidBranchName('fix^42')).toBe(false);
    expect(isValidBranchName('fix:42')).toBe(false);
  });
});
