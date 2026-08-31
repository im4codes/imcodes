import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectSupervisionAssignmentWorktree } from '../../src/daemon/supervision-worktree-inspector.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'imcodes-worktree-authority-'));
  roots.push(root);
  const assignmentRoot = join(root, 'imcodes', 'deck_worker', 'assignment_one');
  const repo = join(assignmentRoot, 'repo');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  execFileSync('git', ['add', 'base.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo });
  mkdirSync(join(assignmentRoot, 'evidence'), { recursive: true });
  return { root, repo, assignmentRoot };
}

describe('authoritative supervision worktree inspection', () => {
  it('accepts an exact clean zero-source worktree without metadata paths', () => {
    const shape = fixture();
    expect(inspectSupervisionAssignmentWorktree({
      sessionName: 'deck_worker', assignmentId: 'assignment_one',
      env: { IMCODES_WORKTREES_ROOT: shape.root, IMCODES_PROJECT_WORKTREE_NAMESPACE: 'imcodes' },
    })).toMatchObject({
      ok: true,
      snapshot: { worktreePath: realpathSync(shape.repo), files: [], stagedPaths: [], conflictedPaths: [], untrackedPaths: [] },
    });
  });

  it('derives tracked and untracked exact paths and hashes from bytes, never registry metadata', () => {
    const shape = fixture();
    writeFileSync(join(shape.repo, 'base.txt'), 'changed\n');
    writeFileSync(join(shape.repo, 'new.txt'), 'new\n');
    const files = [
      { path: 'base.txt', sha256: createHash('sha256').update('changed\n').digest('hex') },
      { path: 'new.txt', sha256: createHash('sha256').update('new\n').digest('hex') },
    ];
    const result = inspectSupervisionAssignmentWorktree({
      sessionName: 'ignored', assignmentId: 'ignored', worktreePath: shape.repo,
    });
    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        files,
        untrackedPaths: ['new.txt'],
      },
    });
  });

  it('ignores stale evidence metadata and binds current worktree bytes without mutation', () => {
    const shape = fixture();
    const evidence = join(shape.assignmentRoot, 'evidence', 'candidate-manifest.sha256');
    writeFileSync(evidence, `${'0'.repeat(64)}  base.txt\n`);
    const evidenceBefore = readFileSync(evidence);
    writeFileSync(join(shape.repo, 'base.txt'), 'changed after freeze\n');
    expect(inspectSupervisionAssignmentWorktree({
      sessionName: 'ignored', assignmentId: 'ignored', worktreePath: shape.repo,
    })).toMatchObject({
      ok: true,
      snapshot: { files: [{
        path: 'base.txt',
        sha256: createHash('sha256').update('changed after freeze\n').digest('hex'),
      }] },
    });
    expect(readFileSync(join(shape.repo, 'base.txt'), 'utf8')).toBe('changed after freeze\n');
    expect(readFileSync(evidence)).toEqual(evidenceBefore);
  });

  it('computes deletion markers directly from the current worktree', () => {
    const shape = fixture();
    rmSync(join(shape.repo, 'base.txt'));
    expect(inspectSupervisionAssignmentWorktree({
      sessionName: 'ignored', assignmentId: 'ignored', worktreePath: shape.repo,
    })).toMatchObject({ ok: true, snapshot: { files: [{ path: 'base.txt', deleted: true }] } });
  });

  it('reports staged state for the registry gate', () => {
    const shape = fixture();
    writeFileSync(join(shape.repo, 'base.txt'), 'staged\n');
    execFileSync('git', ['add', 'base.txt'], { cwd: shape.repo });
    expect(inspectSupervisionAssignmentWorktree({
      sessionName: 'ignored', assignmentId: 'ignored', worktreePath: shape.repo,
    })).toMatchObject({ ok: true, snapshot: { stagedPaths: ['base.txt'] } });
  });
});
