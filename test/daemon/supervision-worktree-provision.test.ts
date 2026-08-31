import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureSupervisionAssignmentWorktree,
  resolveSupervisionWorktreeBase,
} from '../../src/daemon/supervision-worktree-provision.js';

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'imcodes-supervision-provision-'));
  roots.push(root);
  const source = join(root, 'source');
  mkdirSync(source);
  git(source, 'init', '-q');
  git(source, 'config', 'user.email', 'test@example.invalid');
  git(source, 'config', 'user.name', 'Test');
  writeFileSync(join(source, 'base.txt'), 'base\n');
  git(source, 'add', 'base.txt');
  git(source, 'commit', '-qm', 'base');
  return { root, source, baseRevision: git(source, 'rev-parse', 'HEAD') };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('supervision assignment worktree provisioning', () => {
  it.each([
    'asg_2',
    'supervision_assignment_22222222-2222-4222-8222-222222222222',
  ])('provisions a safe worktree path for assignment id %s', async (assignmentId) => {
    const shape = fixture();
    const worktreePath = join(shape.root, 'worktrees', 'imcodes', 'deck_sub_worker', assignmentId, 'repo');
    await expect(ensureSupervisionAssignmentWorktree({
      projectRoot: shape.source, sessionName: 'deck_sub_worker', assignmentId,
      baseRevision: shape.baseRevision, worktreePath,
    })).resolves.toEqual({
      ok: true, worktreePath, baseRevision: shape.baseRevision, created: true,
    });
    expect(git(worktreePath, 'rev-parse', 'HEAD')).toBe(shape.baseRevision);
  });

  it('creates the exact detached base and replays without rebuilding it', async () => {
    const shape = fixture();
    const worktreePath = join(shape.root, 'worktrees', 'imcodes', 'deck_sub_worker', 'supervision_assignment_one', 'repo');
    const first = await ensureSupervisionAssignmentWorktree({
      projectRoot: shape.source, sessionName: 'deck_sub_worker', assignmentId: 'supervision_assignment_one',
      baseRevision: shape.baseRevision, worktreePath,
    });
    expect(first).toEqual({ ok: true, worktreePath, baseRevision: shape.baseRevision, created: true });
    expect(git(worktreePath, 'rev-parse', 'HEAD')).toBe(shape.baseRevision);
    const gitFile = readFileSync(join(worktreePath, '.git'), 'utf8');

    const replay = await ensureSupervisionAssignmentWorktree({
      projectRoot: shape.source, sessionName: 'deck_sub_worker', assignmentId: 'supervision_assignment_one',
      baseRevision: shape.baseRevision, worktreePath,
    });
    expect(replay).toEqual({ ok: true, worktreePath, baseRevision: shape.baseRevision, created: false });
    expect(readFileSync(join(worktreePath, '.git'), 'utf8')).toBe(gitFile);
  });

  it('recovers the same missing path after an interrupted journal-only attempt', async () => {
    const shape = fixture();
    const assignmentRoot = join(shape.root, 'worktrees', 'imcodes', 'deck_sub_worker', 'supervision_assignment_restart');
    const worktreePath = join(assignmentRoot, 'repo');
    mkdirSync(assignmentRoot, { recursive: true });
    writeFileSync(join(assignmentRoot, '.worktree-provision.json'), JSON.stringify({
      version: 1,
      assignmentId: 'supervision_assignment_restart',
      baseRevision: shape.baseRevision,
      worktreePath,
    }));

    await expect(ensureSupervisionAssignmentWorktree({
      projectRoot: shape.source, sessionName: 'deck_sub_worker', assignmentId: 'supervision_assignment_restart',
      baseRevision: shape.baseRevision, worktreePath,
    })).resolves.toMatchObject({ ok: true, created: true, worktreePath, baseRevision: shape.baseRevision });
  });

  it('fails closed without changing dirty, wrong-base, or foreign existing paths', async () => {
    const shape = fixture();
    const worktreePath = join(shape.root, 'worktrees', 'imcodes', 'deck_sub_worker', 'supervision_assignment_dirty', 'repo');
    await ensureSupervisionAssignmentWorktree({
      projectRoot: shape.source, sessionName: 'deck_sub_worker', assignmentId: 'supervision_assignment_dirty',
      baseRevision: shape.baseRevision, worktreePath,
    });
    writeFileSync(join(worktreePath, 'base.txt'), 'user bytes\n');
    await expect(ensureSupervisionAssignmentWorktree({
      projectRoot: shape.source, sessionName: 'deck_sub_worker', assignmentId: 'supervision_assignment_dirty',
      baseRevision: shape.baseRevision, worktreePath,
    })).resolves.toMatchObject({ ok: false, reason: 'existing_dirty' });
    expect(readFileSync(join(worktreePath, 'base.txt'), 'utf8')).toBe('user bytes\n');

    writeFileSync(join(worktreePath, 'base.txt'), 'base\n');
    writeFileSync(join(shape.source, 'next.txt'), 'next\n');
    git(shape.source, 'add', 'next.txt');
    git(shape.source, 'commit', '-qm', 'next');
    const next = git(shape.source, 'rev-parse', 'HEAD');
    await expect(ensureSupervisionAssignmentWorktree({
      projectRoot: shape.source, sessionName: 'deck_sub_worker', assignmentId: 'supervision_assignment_dirty',
      baseRevision: next, worktreePath,
    })).resolves.toMatchObject({ ok: false, reason: 'base_mismatch' });
    expect(git(worktreePath, 'rev-parse', 'HEAD')).toBe(shape.baseRevision);

    const foreign = join(shape.root, 'foreign');
    mkdirSync(foreign);
    git(foreign, 'init', '-q');
    await expect(ensureSupervisionAssignmentWorktree({
      projectRoot: shape.source, sessionName: 'deck_sub_worker', assignmentId: 'supervision_assignment_foreign',
      baseRevision: shape.baseRevision, worktreePath: foreign,
    })).resolves.toMatchObject({ ok: false, reason: 'existing_unsafe' });
  });

  it('resolves an exact commit and rejects a stale explicit base', async () => {
    const shape = fixture();
    await expect(resolveSupervisionWorktreeBase({ projectRoot: shape.source }))
      .resolves.toEqual({ ok: true, baseRevision: shape.baseRevision });
    await expect(resolveSupervisionWorktreeBase({ projectRoot: shape.source, requestedBaseRevision: 'missing-ref' }))
      .resolves.toMatchObject({ ok: false, reason: 'base_unavailable' });
  });
});
