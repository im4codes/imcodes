import { execFileSync } from 'node:child_process';
import {
  chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetSupervisionWorktreeInspectionCacheForTests,
  __setSupervisionWorktreeInspectionLimitsForTests,
  inspectSupervisionAssignmentWorktree,
} from '../../src/daemon/supervision-worktree-inspector.js';

/**
 * Authority and availability contracts.
 *
 * `matchingRemoteCommitSha` is the single most consequential value this module
 * produces: `#convergeAlreadyPresentDelivery` persists it as commitSha /
 * pushRemoteRef, i.e. it declares an assignment's work already delivered. A
 * stale positive here marks undelivered bytes as delivered, so the cache may
 * never carry that answer across a change in the worktree's dirty set.
 *
 * The queue cases exist because "bounded" has to mean bounded end to end: a
 * request that sits in a slot queue is still a request, and the deadline this
 * P0 is meant to protect (the 10s delegation-reply window) is measured from
 * the caller's first ask, not from whenever a slot happens to free up.
 */

const roots: string[] = [];
let originalPath = '';

beforeEach(() => { originalPath = process.env.PATH ?? ''; });
afterEach(() => {
  process.env.PATH = originalPath;
  __setSupervisionWorktreeInspectionLimitsForTests(undefined);
  __resetSupervisionWorktreeInspectionCacheForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repoAt(prefix: string): { root: string; repo: string; git: (args: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  const repo = join(root, 'imcodes', 'deck_worker', 'assignment_one', 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'Test']);
  return { root, repo, git };
}

const inspect = (repo: string) => inspectSupervisionAssignmentWorktree({
  sessionName: 'deck_worker', assignmentId: 'assignment_one', worktreePath: repo,
});

describe('remote-delivery authority is never served stale', () => {
  /** HEAD at base, worktree carrying the exact bytes origin/dev delivered. */
  function deliveredMatch() {
    const { repo, git } = repoAt('imcodes-authority-');
    writeFileSync(join(repo, 'anchor.txt'), 'anchor\n');
    git(['add', '-A']); git(['commit', '-qm', 'base']);
    const baseSha = git(['rev-parse', 'HEAD']);
    writeFileSync(join(repo, 'a.txt'), 'alpha\n');
    git(['add', '-A']); git(['commit', '-qm', 'delivered']);
    const deliveredSha = git(['rev-parse', 'HEAD']).toLowerCase();
    git(['update-ref', 'refs/remotes/origin/dev', deliveredSha]);
    git(['reset', '-q', '--hard', baseSha]);
    writeFileSync(join(repo, 'a.txt'), 'alpha\n');
    return { repo, git, deliveredSha };
  }

  it('drops the positive match when a NEW untracked path appears', async () => {
    const { repo, deliveredSha } = deliveredMatch();
    const first = await inspect(repo);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.snapshot.matchingRemoteCommitSha).toBe(deliveredSha);

    // An undelivered file. The remote does not carry it, so the delivery is
    // no longer complete and the authority must not survive.
    writeFileSync(join(repo, 'b.txt'), 'undelivered\n');
    const second = await inspect(repo);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(
      second.snapshot.files.map((file) => file.path),
      'a new untracked path must be visible immediately',
    ).toEqual(['a.txt', 'b.txt']);
    expect(
      second.snapshot.matchingRemoteCommitSha,
      'an undelivered path must not keep a positive delivery authority',
    ).toBeUndefined();
  });

  it('drops the positive match when a previously CLEAN tracked path becomes dirty', async () => {
    const { repo, deliveredSha } = deliveredMatch();
    const first = await inspect(repo);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.snapshot.matchingRemoteCommitSha).toBe(deliveredSha);

    // anchor.txt was committed and clean, so it is in no cached path stat.
    writeFileSync(join(repo, 'anchor.txt'), 'anchor edited\n');
    const second = await inspect(repo);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(
      second.snapshot.files.map((file) => file.path),
      'a newly dirty tracked path must be visible immediately',
    ).toEqual(['a.txt', 'anchor.txt']);
    expect(second.snapshot.matchingRemoteCommitSha).toBeUndefined();
  });

  it('drops the positive match when a reported path changes content in place', async () => {
    const { repo, deliveredSha } = deliveredMatch();
    const first = await inspect(repo);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.snapshot.matchingRemoteCommitSha).toBe(deliveredSha);

    writeFileSync(join(repo, 'a.txt'), 'alphaX\n');
    const second = await inspect(repo);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.snapshot.matchingRemoteCommitSha).toBeUndefined();
  });

  it('still answers an unchanged worktree without re-reading it from scratch', async () => {
    const { repo, deliveredSha } = deliveredMatch();
    const first = await inspect(repo);
    const second = await inspect(repo);
    expect(second).toEqual(first);
    if (!second.ok) return;
    expect(second.snapshot.matchingRemoteCommitSha).toBe(deliveredSha);
  });
});

describe('deletion-only remote delivery parity', () => {
  it('matches a remote commit that delivers exactly the deletion', async () => {
    const { repo, git } = repoAt('imcodes-deletion-parity-');
    writeFileSync(join(repo, 'anchor.txt'), 'anchor\n');
    writeFileSync(join(repo, 'gone.txt'), 'to be removed\n');
    git(['add', '-A']); git(['commit', '-qm', 'base']);
    const baseSha = git(['rev-parse', 'HEAD']);
    git(['rm', '-q', 'gone.txt']);
    git(['commit', '-qm', 'delivered deletion']);
    const deletedSha = git(['rev-parse', 'HEAD']).toLowerCase();
    git(['update-ref', 'refs/remotes/origin/dev', deletedSha]);
    // Back to base, then reproduce the delivered deletion in the worktree.
    git(['reset', '-q', '--hard', baseSha]);
    rmSync(join(repo, 'gone.txt'));

    const result = await inspect(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.files).toEqual([{ path: 'gone.txt', deleted: true }]);
    expect(
      result.snapshot.matchingRemoteRef,
      'a manifest of pure deletions still has a remote authority',
    ).toBe('refs/remotes/origin/dev');
    expect(result.snapshot.matchingRemoteCommitSha).toBe(deletedSha);
  });

  it('does not match a remote that still carries the deleted path', async () => {
    const { repo, git } = repoAt('imcodes-deletion-negative-');
    writeFileSync(join(repo, 'anchor.txt'), 'anchor\n');
    writeFileSync(join(repo, 'gone.txt'), 'to be removed\n');
    git(['add', '-A']); git(['commit', '-qm', 'base']);
    git(['update-ref', 'refs/remotes/origin/dev', 'HEAD']);
    rmSync(join(repo, 'gone.txt'));

    const result = await inspect(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.files).toEqual([{ path: 'gone.txt', deleted: true }]);
    expect(result.snapshot.matchingRemoteCommitSha).toBeUndefined();
  });
});

describe('the git queue is bounded end to end', () => {
  /** Installs a `git` that sleeps before delegating, to hold slots open. */
  function slowGit(root: string, seconds: number): void {
    const realGit = execFileSync('/usr/bin/env', ['sh', '-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const bin = join(root, 'slowbin');
    mkdirSync(bin, { recursive: true });
    const shim = join(bin, 'git');
    writeFileSync(shim, `#!/bin/sh\nsleep ${seconds}\nexec ${JSON.stringify(realGit)} "$@"\n`);
    chmodSync(shim, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
  }

  function plainRepo(prefix: string): string {
    const { repo, git } = repoAt(prefix);
    writeFileSync(join(repo, 'a.txt'), 'alpha\n');
    git(['add', '-A']); git(['commit', '-qm', 'base']);
    writeFileSync(join(repo, 'a.txt'), 'dirty\n');
    return repo;
  }

  it('fails closed when a request cannot start before its total deadline', async () => {
    const repos = Array.from({ length: 12 }, (_, index) => plainRepo(`imcodes-deadline-${index}-`));
    // The deadline is the caller's, and it starts now — not when a slot frees.
    __setSupervisionWorktreeInspectionLimitsForTests({ totalDeadlineMs: 900 });
    slowGit(roots[0], 1);

    const started = Date.now();
    const results = await Promise.all(repos.map((repo) => inspect(repo)));
    const elapsed = Date.now() - started;

    expect(
      results.some((result) => !result.ok),
      'a backlog that cannot be served inside the deadline must fail closed',
    ).toBe(true);
    for (const result of results) {
      if (!result.ok) expect(result.reason).toBe('worktree_unavailable');
    }
    expect(
      elapsed,
      `queued work must not outlive the deadline by waves (took ${elapsed}ms)`,
    ).toBeLessThan(6_000);
  });

  it('rejects immediately once the queue hits its hard cap, and stays bounded', async () => {
    const repos = Array.from({ length: 24 }, (_, index) => plainRepo(`imcodes-cap-${index}-`));
    __setSupervisionWorktreeInspectionLimitsForTests({ maxQueue: 4, totalDeadlineMs: 30_000 });
    slowGit(roots[0], 1);

    const results = await Promise.all(repos.map((repo) => inspect(repo)));
    const refused = results.filter((result) => !result.ok);
    expect(refused.length, 'saturation must be refused, not absorbed').toBeGreaterThan(0);
    for (const result of refused) expect(result.reason).toBe('worktree_unavailable');
  });
});

describe('git failure, deadline and output cap all fail closed', () => {
  function deliveredBig(bytes: number) {
    const { repo, git } = repoAt('imcodes-outputcap-');
    writeFileSync(join(repo, 'anchor.txt'), 'anchor\n');
    git(['add', '-A']); git(['commit', '-qm', 'base']);
    const baseSha = git(['rev-parse', 'HEAD']);
    const payload = 'x'.repeat(bytes);
    writeFileSync(join(repo, 'big.bin'), payload);
    git(['add', '-A']); git(['commit', '-qm', 'delivered']);
    const deliveredSha = git(['rev-parse', 'HEAD']).toLowerCase();
    git(['update-ref', 'refs/remotes/origin/dev', deliveredSha]);
    git(['reset', '-q', '--hard', baseSha]);
    writeFileSync(join(repo, 'big.bin'), payload);
    return { repo, deliveredSha };
  }

  it('never claims a delivery it could not afford to read', async () => {
    const { repo, deliveredSha } = deliveredBig(256 * 1024);
    // With a real budget the bytes are read and the match is genuine.
    const generous = await inspect(repo);
    expect(generous.ok).toBe(true);
    if (!generous.ok) return;
    expect(generous.snapshot.matchingRemoteCommitSha).toBe(deliveredSha);

    // Under a budget too small to read them, the ref is NOT promoted to
    // authority. An unverified ref must never become a delivery record.
    __resetSupervisionWorktreeInspectionCacheForTests();
    __setSupervisionWorktreeInspectionLimitsForTests({ remoteMatchMaxBytes: 1024 });
    const capped = await inspect(repo);
    expect(capped.ok).toBe(true);
    if (!capped.ok) return;
    expect(
      capped.snapshot.matchingRemoteCommitSha,
      'an unread ref must never be reported as the delivery authority',
    ).toBeUndefined();
    expect(capped.snapshot.files.map((file) => file.path)).toEqual(['big.bin']);
  });

  it('fails closed when git itself cannot answer', async () => {
    const { repo } = repoAt('imcodes-gitfail-');
    writeFileSync(join(repo, 'a.txt'), 'alpha\n');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'base']);
    rmSync(join(repo, '.git'), { recursive: true, force: true });
    const result = await inspect(repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('worktree_unavailable');
  });

  it('fails closed — and stays bounded — when a single git call outlives the deadline', async () => {
    const { repo, git } = repoAt('imcodes-hang-');
    writeFileSync(join(repo, 'a.txt'), 'alpha\n');
    git(['add', '-A']); git(['commit', '-qm', 'base']);
    writeFileSync(join(repo, 'a.txt'), 'dirty\n');
    const realGit = execFileSync('/usr/bin/env', ['sh', '-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const bin = join(roots[roots.length - 1], 'hangbin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nsleep 30\nexec ${JSON.stringify(realGit)} "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    __setSupervisionWorktreeInspectionLimitsForTests({ totalDeadlineMs: 700 });

    const started = Date.now();
    const result = await inspect(repo);
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('worktree_unavailable');
    expect(elapsed, `a hung git must not outlive the deadline (took ${elapsed}ms)`).toBeLessThan(5_000);
  });
});
