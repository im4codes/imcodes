import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, it, expect } from 'vitest';
import { detectRepo, parseRemoteUrl, parseRemotes, compareSemver, extractVersion, __clearDetectRepoCacheForTests } from '../../src/repo/detector.js';
import { __resetRepoGenerationsForTests } from '../../src/repo/generation.js';

const execFileAsync = promisify(execFile);

beforeEach(() => {
  __clearDetectRepoCacheForTests();
  __resetRepoGenerationsForTests();
});

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

  it('parses ssh:// URLs with explicit SSH transport ports without using the port as canonical host', () => {
    const result = parseRemoteUrl('ssh://git@172.16.253.211:2224/Hermit/ai_purchase2.git');
    expect(result).toEqual({ host: '172.16.253.211', owner: 'Hermit', repo: 'ai_purchase2' });
  });

  it('parses self-hosted URL', () => {
    const result = parseRemoteUrl('https://git.corp.example.com/team/internal-tool.git');
    expect(result).toEqual({ host: 'git.corp.example.com', owner: 'team', repo: 'internal-tool' });
  });

  it('preserves explicit HTTP(S) service ports for self-hosted remotes', () => {
    const result = parseRemoteUrl('https://git.corp.example.com:8443/team/internal-tool.git');
    expect(result).toEqual({ host: 'git.corp.example.com:8443', owner: 'team', repo: 'internal-tool' });
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

describe('detectRepo local branch context', () => {
  it('includes local currentBranch when provider CLI is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-detect-'));
    const repoDir = join(root, 'repo');
    const binDir = join(root, 'bin');
    const oldPath = process.env.PATH;
    try {
      await mkdir(repoDir, { recursive: true });
      await mkdir(binDir, { recursive: true });
      const { stdout: gitPathRaw } = await execFileAsync('which', ['git']);
      const gitPath = gitPathRaw.trim();
      await symlink(gitPath, join(binDir, 'git'));

      await execFileAsync(gitPath, ['init'], { cwd: repoDir });
      await execFileAsync(gitPath, ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
      await execFileAsync(gitPath, ['config', 'user.name', 'Test User'], { cwd: repoDir });
      await execFileAsync(gitPath, ['checkout', '-b', 'feature/local'], { cwd: repoDir });
      await writeFile(join(repoDir, 'file.txt'), 'hello\n');
      await execFileAsync(gitPath, ['add', 'file.txt'], { cwd: repoDir });
      await execFileAsync(gitPath, ['commit', '-m', 'initial'], { cwd: repoDir });
      await execFileAsync(gitPath, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'], { cwd: repoDir });

      process.env.PATH = binDir;
      const result = await detectRepo(repoDir);

      expect(result.status).toBe('cli_missing');
      expect(result.info?.currentBranch).toBe('feature/local');
      expect(result.info?.owner).toBe('acme');
      expect(result.info?.repo).toBe('widgets');
    } finally {
      process.env.PATH = oldPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('deduplicates concurrent detection for the same project directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-detect-cache-'));
    const repoDir = join(root, 'repo');
    const binDir = join(root, 'bin');
    const countFile = join(root, 'gh-count');
    const oldPath = process.env.PATH;
    try {
      await mkdir(repoDir, { recursive: true });
      await mkdir(binDir, { recursive: true });
      await writeFile(countFile, '0\n');

      const gitScript = `#!/bin/bash
set -e
cmd="$*"
if [ "$cmd" = "remote -v" ]; then
  printf 'origin\\thttps://github.com/acme/widgets.git (fetch)\\n'
elif [ "$cmd" = "symbolic-ref refs/remotes/origin/HEAD --short" ]; then
  printf 'origin/main\\n'
elif [ "$cmd" = "symbolic-ref --quiet --short HEAD" ]; then
  printf 'main\\n'
else
  echo "unexpected git command: $cmd" >&2
  exit 1
fi
`;
      const ghScript = `#!/bin/bash
set -e
count="$(<"${countFile}")"
printf '%s\\n' "$((count + 1))" > "${countFile}"
if [ "$1" = "--version" ]; then
  printf 'gh version 2.45.0 (2024-03-01)\\n'
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
echo "unexpected gh command: $*" >&2
exit 1
`;
      const whichScript = `#!/bin/bash
set -e
if [ "$1" = "gh" ]; then
  printf '${join(binDir, 'gh')}\\n'
  exit 0
fi
exit 1
`;
      await writeFile(join(binDir, 'git'), gitScript);
      await writeFile(join(binDir, 'gh'), ghScript);
      await writeFile(join(binDir, 'which'), whichScript);
      await chmod(join(binDir, 'git'), 0o755);
      await chmod(join(binDir, 'gh'), 0o755);
      await chmod(join(binDir, 'which'), 0o755);

      process.env.PATH = binDir;
      const [first, second] = await Promise.all([
        detectRepo(repoDir),
        detectRepo(repoDir),
      ]);

      expect(first.status).toBe('ok');
      expect(second.status).toBe('ok');
      expect(first.info?.repo).toBe('widgets');
      expect(second.info?.repo).toBe('widgets');
      expect((await readFile(countFile, 'utf8')).trim()).toBe('2');
    } finally {
      process.env.PATH = oldPath;
      await rm(root, { recursive: true, force: true });
    }
  });
});
