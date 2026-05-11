import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectInProgressOperation,
  getCurrentBranch,
  getLocalCommitDetail,
  getWorktreeState,
  listLocalBranches,
  listLocalCommits,
  resolveCheckoutTarget,
  switchLocalBranch,
} from '../../src/repo/local-git.js';

const execFileAsync = promisify(execFile);

let repoDir: string;

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repoDir });
  return stdout;
}

async function write(path: string, content: string): Promise<void> {
  await writeFile(join(repoDir, path), content);
}

async function initRepo(): Promise<void> {
  await git(['init']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test User']);
  await git(['checkout', '-b', 'main']);
  await write('file.txt', 'one\n');
  await git(['add', 'file.txt']);
  await git(['commit', '-m', 'initial']);
}

describe('local-git helper', () => {
  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'imcodes-local-git-'));
    await initRepo();
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('detects current branch and local branch inventory', async () => {
    await git(['checkout', '-b', 'feature/a']);

    await expect(getCurrentBranch(repoDir)).resolves.toBe('feature/a');
    const branches = await listLocalBranches(repoDir);
    expect(branches).toEqual(expect.arrayContaining([
      { name: 'main', isCurrent: false },
      { name: 'feature/a', isCurrent: true },
    ]));
  });

  it('reports unstaged, staged, and untracked dirty states', async () => {
    await write('file.txt', 'two\n');
    let state = await getWorktreeState(repoDir);
    expect(state.dirty).toBe(true);
    expect(state.unstaged).toBe(true);

    await git(['add', 'file.txt']);
    state = await getWorktreeState(repoDir);
    expect(state.dirty).toBe(true);
    expect(state.staged).toBe(true);

    await git(['commit', '-m', 'update']);
    await write('new.txt', 'new\n');
    state = await getWorktreeState(repoDir);
    expect(state.dirty).toBe(true);
    expect(state.untracked).toBe(true);
  });

  it('detects in-progress git operations from git-dir state', async () => {
    expect(await detectInProgressOperation(repoDir)).toBeNull();
    const gitDir = (await git(['rev-parse', '--git-dir'])).trim();
    await writeFile(join(repoDir, gitDir, 'MERGE_HEAD'), 'deadbeef\n');
    expect(await detectInProgressOperation(repoDir)).toBe('merge');
  });

  it('resolves only local branch targets and rejects unsafe refs', async () => {
    await git(['checkout', '-b', 'feature/safe']);
    await git(['checkout', '-b', '_scratch']);
    await git(['checkout', 'main']);
    await git(['tag', 'v1']);
    await git(['update-ref', 'refs/remotes/origin/remote-only', 'HEAD']);
    const sha = (await git(['rev-parse', 'HEAD'])).trim();

    await expect(resolveCheckoutTarget(repoDir, 'feature/safe')).resolves.toEqual({
      branch: 'feature/safe',
      ref: 'refs/heads/feature/safe',
    });
    await expect(resolveCheckoutTarget(repoDir, '_scratch')).resolves.toEqual({
      branch: '_scratch',
      ref: 'refs/heads/_scratch',
    });
    await expect(resolveCheckoutTarget(repoDir, 'v1')).rejects.toMatchObject({ code: 'invalid_checkout_target' });
    await expect(resolveCheckoutTarget(repoDir, 'remote-only')).rejects.toMatchObject({ code: 'invalid_checkout_target' });
    await expect(resolveCheckoutTarget(repoDir, sha.slice(0, 8))).rejects.toMatchObject({ code: 'invalid_checkout_target' });
    await expect(resolveCheckoutTarget(repoDir, '-bad')).rejects.toMatchObject({ code: 'invalid_checkout_target' });
    await expect(resolveCheckoutTarget(repoDir, ' feature/safe ')).rejects.toMatchObject({ code: 'invalid_checkout_target' });
  });

  it('switches using a resolved local target and reads local commit fallback data', async () => {
    await git(['checkout', '-b', 'feature/switch']);
    await write('file.txt', 'feature\n');
    await git(['add', 'file.txt']);
    await git(['commit', '-m', 'feature commit']);
    await git(['checkout', 'main']);

    const target = await resolveCheckoutTarget(repoDir, 'feature/switch');
    await switchLocalBranch(repoDir, target);
    await expect(getCurrentBranch(repoDir)).resolves.toBe('feature/switch');

    const commits = await listLocalCommits(repoDir, 'feature/switch', 1, 5);
    expect(commits.items[0]?.message).toBe('feature commit');
    const detail = await getLocalCommitDetail(repoDir, commits.items[0]!.sha);
    expect(detail.message).toBe('feature commit');
    expect(detail.stats.filesChanged).toBeGreaterThanOrEqual(1);
  });
});
