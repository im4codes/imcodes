import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetSupervisionWorktreeInspectionCacheForTests,
  inspectSupervisionAssignmentWorktree,
} from '../../src/daemon/supervision-worktree-inspector.js';

/**
 * Remote-delivery matching against REAL git.
 *
 * This is the highest-stakes answer the inspector gives: a match is what makes
 * `#convergeAlreadyPresentDelivery` write `commitSha`/`pushRemoteRef` and treat
 * an assignment's work as already delivered. A false positive silently marks
 * undelivered work as delivered.
 *
 * The implementation no longer runs `git show` per ref x file; it asks
 * `cat-file --batch-check` for object ids and SIZES, uses size only to discard
 * impossible refs, and then compares full sha256 of the actual bytes. These
 * cases pin that size can never stand in for content.
 */

const roots: string[] = [];
afterEach(() => {
  __resetSupervisionWorktreeInspectionCacheForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Delivered { repo: string; deliveredSha: string }

/**
 * A worktree whose HEAD is the base commit but whose working tree carries the
 * bytes of a later "delivered" commit that a remote ref points at. That is the
 * exact production shape: dirty against HEAD, byte-identical to a remote.
 */
function deliveredShape(options: {
  delivered: Record<string, string>;
  worktree: Record<string, string>;
  extraRefs?: string[];
}): Delivered {
  const root = mkdtempSync(join(tmpdir(), 'imcodes-remote-match-'));
  roots.push(root);
  const repo = join(root, 'imcodes', 'deck_worker', 'assignment_one', 'repo');
  mkdirSync(repo, { recursive: true });
  const run = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  run(['init', '-q']);
  run(['config', 'user.email', 'test@example.invalid']);
  run(['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'anchor.txt'), 'anchor\n');
  run(['add', '-A']);
  run(['commit', '-qm', 'base']);
  const baseSha = run(['rev-parse', 'HEAD']);

  for (const [path, content] of Object.entries(options.delivered)) {
    writeFileSync(join(repo, path), content);
  }
  run(['add', '-A']);
  run(['commit', '-qm', 'delivered']);
  const deliveredSha = run(['rev-parse', 'HEAD']).toLowerCase();
  run(['update-ref', 'refs/remotes/origin/dev', deliveredSha]);
  for (const ref of options.extraRefs ?? []) run(['update-ref', ref, baseSha]);

  // Move HEAD back to base, then lay down the working-tree bytes under test.
  run(['reset', '-q', '--hard', baseSha]);
  for (const [path, content] of Object.entries(options.worktree)) {
    writeFileSync(join(repo, path), content);
  }
  return { repo, deliveredSha };
}

const inspect = (repo: string) => inspectSupervisionAssignmentWorktree({
  sessionName: 'deck_worker', assignmentId: 'assignment_one', worktreePath: repo,
});

describe('remote delivery matching against real git', () => {
  it('matches the remote ref whose committed bytes are exactly the worktree bytes', async () => {
    const { repo, deliveredSha } = deliveredShape({
      delivered: { 'a.txt': 'alpha\n', 'b.txt': 'beta\n' },
      worktree: { 'a.txt': 'alpha\n', 'b.txt': 'beta\n' },
    });
    const result = await inspect(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.files.map((file) => file.path)).toEqual(['a.txt', 'b.txt']);
    expect(result.snapshot.matchingRemoteRef).toBe('refs/remotes/origin/dev');
    expect(result.snapshot.matchingRemoteCommitSha).toBe(deliveredSha);
  });

  it('reports no match when a single byte differs', async () => {
    const { repo } = deliveredShape({
      delivered: { 'a.txt': 'alpha\n', 'b.txt': 'beta\n' },
      worktree: { 'a.txt': 'alpha\n', 'b.txt': 'betaX\n' },
    });
    const result = await inspect(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.matchingRemoteCommitSha).toBeUndefined();
    expect(result.snapshot.matchingRemoteRef).toBeUndefined();
  });

  it('reports no match when the bytes differ but the LENGTH is identical', async () => {
    // The size pre-filter exists only to discard impossible refs cheaply. If it
    // were ever allowed to stand in for the content comparison, this case would
    // be reported as an already-present delivery.
    const { repo } = deliveredShape({
      delivered: { 'a.txt': 'alpha\n', 'b.txt': 'beta\n' },
      worktree: { 'a.txt': 'alpha\n', 'b.txt': 'atef\n' },
    });
    const result = await inspect(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.matchingRemoteCommitSha, 'equal length must never imply equal bytes').toBeUndefined();
  });

  it('requires every manifest row to match, not merely one of them', async () => {
    const { repo } = deliveredShape({
      delivered: { 'a.txt': 'alpha\n', 'b.txt': 'beta\n' },
      worktree: { 'a.txt': 'alpha\n', 'b.txt': 'beta\n', 'c.txt': 'gamma-untracked\n' },
    });
    const result = await inspect(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // c.txt is untracked and absent from the remote, so the delivery is partial.
    expect(result.snapshot.untrackedPaths).toContain('c.txt');
    expect(result.snapshot.matchingRemoteCommitSha).toBeUndefined();
  });

  it('treats a path the remote still carries as disproving a deletion', async () => {
    const { repo } = deliveredShape({
      delivered: { 'a.txt': 'alpha\n', 'b.txt': 'beta\n' },
      worktree: { 'a.txt': 'alpha\n', 'b.txt': 'beta\n' },
    });
    // Stage a deletion of a path the remote still has: the ref cannot be the
    // authority for a manifest that says the file is gone.
    execFileSync('git', ['-C', repo, 'rm', '-q', '--cached', 'anchor.txt']);
    rmSync(join(repo, 'anchor.txt'));
    const result = await inspect(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.files.some((file) => file.path === 'anchor.txt' && file.deleted === true)).toBe(true);
    expect(result.snapshot.matchingRemoteCommitSha).toBeUndefined();
  });

  it('still finds a non-preferred remote ref when origin/dev is not the match', async () => {
    const root = mkdtempSync(join(tmpdir(), 'imcodes-remote-match-alt-'));
    roots.push(root);
    const repo = join(root, 'imcodes', 'deck_worker', 'assignment_one', 'repo');
    mkdirSync(repo, { recursive: true });
    const run = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    run(['init', '-q']);
    run(['config', 'user.email', 'test@example.invalid']);
    run(['config', 'user.name', 'Test']);
    writeFileSync(join(repo, 'anchor.txt'), 'anchor\n');
    run(['add', '-A']);
    run(['commit', '-qm', 'base']);
    const baseSha = run(['rev-parse', 'HEAD']);
    writeFileSync(join(repo, 'a.txt'), 'alpha\n');
    run(['add', '-A']);
    run(['commit', '-qm', 'delivered']);
    const deliveredSha = run(['rev-parse', 'HEAD']).toLowerCase();
    // origin/dev deliberately points at the WRONG commit; the real delivery
    // only exists on a lower-priority ref.
    run(['update-ref', 'refs/remotes/origin/dev', baseSha]);
    run(['update-ref', 'refs/remotes/origin/release', deliveredSha]);
    run(['reset', '-q', '--hard', baseSha]);
    writeFileSync(join(repo, 'a.txt'), 'alpha\n');

    const result = await inspect(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.matchingRemoteRef).toBe('refs/remotes/origin/release');
    expect(result.snapshot.matchingRemoteCommitSha).toBe(deliveredSha);
  });

  it('fails closed when git cannot answer', async () => {
    const { repo } = deliveredShape({
      delivered: { 'a.txt': 'alpha\n' },
      worktree: { 'a.txt': 'alpha\n' },
    });
    rmSync(join(repo, '.git'), { recursive: true, force: true });
    __resetSupervisionWorktreeInspectionCacheForTests();
    const result = await inspect(repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('worktree_unavailable');
  });
});
