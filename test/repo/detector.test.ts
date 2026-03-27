import { describe, it, expect } from 'vitest';
import { parseRemoteUrl, parseRemotes, compareSemver, extractVersion } from '../../src/repo/detector.js';

describe('parseRemoteUrl', () => {
  it('parses HTTPS github URL', () => {
    const result = parseRemoteUrl('https://github.com/acme/repo.git');
    expect(result).toEqual({ host: 'github.com', owner: 'acme', repo: 'repo' });
  });

  it('parses HTTPS github URL without .git suffix', () => {
    const result = parseRemoteUrl('https://github.com/acme/repo');
    expect(result).toEqual({ host: 'github.com', owner: 'acme', repo: 'repo' });
  });

  it('parses SSH github URL', () => {
    const result = parseRemoteUrl('git@github.com:acme/repo.git');
    expect(result).toEqual({ host: 'github.com', owner: 'acme', repo: 'repo' });
  });

  it('parses SSH gitlab URL', () => {
    const result = parseRemoteUrl('git@gitlab.com:org/project.git');
    expect(result).toEqual({ host: 'gitlab.com', owner: 'org', repo: 'project' });
  });

  it('parses ssh:// prefix URL', () => {
    const result = parseRemoteUrl('ssh://git@github.com/acme/repo.git');
    expect(result).toEqual({ host: 'github.com', owner: 'acme', repo: 'repo' });
  });

  it('parses self-hosted URL', () => {
    const result = parseRemoteUrl('https://git.corp.example.com/team/internal-tool.git');
    expect(result).toEqual({ host: 'git.corp.example.com', owner: 'team', repo: 'internal-tool' });
  });

  it('parses SSH alias format (e.g. github-work)', () => {
    const result = parseRemoteUrl('git@github-work:org/repo.git');
    expect(result).toEqual({ host: 'github-work', owner: 'org', repo: 'repo' });
  });

  it('parses SSH alias with hyphenated host and nested owner', () => {
    const result = parseRemoteUrl('git@gitlab-personal:myteam/backend.git');
    expect(result).toEqual({ host: 'gitlab-personal', owner: 'myteam', repo: 'backend' });
  });

  it('parses SSH alias without .git suffix', () => {
    const result = parseRemoteUrl('git@github-work:org/repo');
    expect(result).toEqual({ host: 'github-work', owner: 'org', repo: 'repo' });
  });

  it('returns null for invalid URL', () => {
    expect(parseRemoteUrl('not-a-url')).toBeNull();
    expect(parseRemoteUrl('')).toBeNull();
    expect(parseRemoteUrl('ftp://example.com/a/b')).toBeNull();
  });
});

describe('parseRemotes', () => {
  it('parses multi-line git remote -v output', () => {
    const output = [
      'origin\thttps://github.com/acme/repo.git (fetch)',
      'origin\thttps://github.com/acme/repo.git (push)',
      'upstream\tgit@github.com:upstream/repo.git (fetch)',
      'upstream\tgit@github.com:upstream/repo.git (push)',
    ].join('\n');

    const remotes = parseRemotes(output);
    expect(remotes).toHaveLength(2);
    expect(remotes[0]).toMatchObject({ name: 'origin', host: 'github.com', owner: 'acme', repo: 'repo' });
    expect(remotes[1]).toMatchObject({ name: 'upstream', host: 'github.com', owner: 'upstream', repo: 'repo' });
  });

  it('only uses fetch lines and deduplicates by name', () => {
    const output = [
      'origin\thttps://github.com/a/b.git (fetch)',
      'origin\thttps://github.com/a/b.git (push)',
    ].join('\n');

    const remotes = parseRemotes(output);
    expect(remotes).toHaveLength(1);
  });

  it('skips push-only lines', () => {
    const output = 'deploy\thttps://github.com/a/b.git (push)\n';
    const remotes = parseRemotes(output);
    expect(remotes).toHaveLength(0);
  });

  it('handles empty output', () => {
    expect(parseRemotes('')).toEqual([]);
  });
});

describe('compareSemver', () => {
  it('returns 0 for equal versions', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });

  it('returns 1 when first is greater (major)', () => {
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
  });

  it('returns -1 when first is less (minor)', () => {
    expect(compareSemver('1.2.3', '1.3.0')).toBe(-1);
  });

  it('returns 1 when first is greater (patch)', () => {
    expect(compareSemver('1.2.4', '1.2.3')).toBe(1);
  });

  it('handles missing patch component', () => {
    expect(compareSemver('2.0', '1.9.9')).toBe(1);
    expect(compareSemver('1.0', '1.0.0')).toBe(0);
  });
});

describe('extractVersion', () => {
  it('extracts version from gh --version output', () => {
    expect(extractVersion('gh version 2.45.0 (2024-03-01)')).toBe('2.45.0');
  });

  it('extracts version from glab --version output', () => {
    expect(extractVersion('glab version 1.25.0 (2024-01-15)')).toBe('1.25.0');
  });

  it('returns null when no version present', () => {
    expect(extractVersion('no version info here')).toBeNull();
    expect(extractVersion('')).toBeNull();
  });
});
