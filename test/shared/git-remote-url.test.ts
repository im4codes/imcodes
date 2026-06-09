import { describe, expect, it } from 'vitest';
import {
  assertSupportedGitRemoteUrl,
  isSupportedGitRemoteUrl,
  normalizeOptionalGitRemoteUrl,
  redactGitRemoteUrl,
} from '../../shared/git-remote-url.js';

describe('git remote URL helpers', () => {
  it('accepts URL and scp-style git remotes', () => {
    expect(isSupportedGitRemoteUrl('https://github.com/acme/app.git')).toBe(true);
    expect(isSupportedGitRemoteUrl('ssh://git@example.com/acme/app.git')).toBe(true);
    expect(isSupportedGitRemoteUrl('git@example.com:acme/app.git')).toBe(true);
  });

  it('rejects blank, local, whitespace, and unsupported remotes', () => {
    expect(isSupportedGitRemoteUrl('')).toBe(false);
    expect(isSupportedGitRemoteUrl('/tmp/app.git')).toBe(false);
    expect(isSupportedGitRemoteUrl('file:///tmp/app.git')).toBe(false);
    expect(isSupportedGitRemoteUrl('https://github.com/acme/my app.git')).toBe(false);
    expect(isSupportedGitRemoteUrl('javascript:alert(1)')).toBe(false);
    expect(() => assertSupportedGitRemoteUrl('file:///tmp/app.git')).toThrow('invalid_git_remote');
  });

  it('normalizes optional values without accepting non-strings', () => {
    expect(normalizeOptionalGitRemoteUrl(undefined)).toBeUndefined();
    expect(normalizeOptionalGitRemoteUrl(null)).toBeUndefined();
    expect(normalizeOptionalGitRemoteUrl('   ')).toBeUndefined();
    expect(normalizeOptionalGitRemoteUrl(42)).toBeUndefined();
    expect(normalizeOptionalGitRemoteUrl('  https://github.com/acme/app.git  '))
      .toBe('https://github.com/acme/app.git');
  });

  it('redacts credentials from git remotes before surfacing errors', () => {
    expect(redactGitRemoteUrl('https://user:secret@example.com/acme/app.git'))
      .toBe('https://redacted:redacted@example.com/acme/app.git');
    expect(redactGitRemoteUrl('git@example.com:acme/app.git'))
      .toBe('redacted@example.com:acme/app.git');
  });
});
