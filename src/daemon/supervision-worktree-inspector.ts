import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, openSync, closeSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const COMMIT_RE = /^[0-9a-f]{40}$/;

export interface SupervisionWorktreeFileSnapshot {
  path: string;
  sha256?: string;
  deleted?: true;
}

export interface SupervisionWorktreeSnapshot {
  worktreePath: string;
  headSha: string;
  files: SupervisionWorktreeFileSnapshot[];
  stagedPaths: string[];
  conflictedPaths: string[];
  untrackedPaths: string[];
}

export type SupervisionWorktreeInspectionResult =
  | { ok: true; snapshot: SupervisionWorktreeSnapshot }
  | { ok: false; reason: 'worktree_unavailable' | 'worktree_unsafe' };

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function validRepoPath(path: string): boolean {
  return Boolean(path) && !path.startsWith('/') && !path.split('/').includes('..')
    && !/[\u0000-\u001f\u007f]/.test(path);
}

function git(worktreePath: string, args: string[]): string {
  return execFileSync('git', ['-C', worktreePath, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024,
  });
}

function lines(value: string): string[] {
  return [...new Set(value.split('\n').map((line) => line.trim()).filter(Boolean))].sort();
}

function semanticallyDiffers(worktreePath: string, path: string): boolean {
  const result = spawnSync('git', [
    '-C', worktreePath, 'diff', '--quiet', '--ignore-cr-at-eol', 'HEAD', '--', path,
  ], { stdio: 'ignore' });
  if (result.error || (result.status !== 0 && result.status !== 1)) throw new Error('git diff failed');
  return result.status === 1;
}

function fileSha256(path: string): string {
  const fd = openSync(path, 'r');
  try {
    return createHash('sha256').update(readFileSync(fd)).digest('hex');
  } finally {
    closeSync(fd);
  }
}

export function resolveSupervisionAssignmentWorktree(input: {
  sessionName: string;
  assignmentId: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = input.env ?? process.env;
  const root = resolve(env.IMCODES_WORKTREES_ROOT?.trim() || join(homedir(), '.imcodes', 'worktrees'));
  const projectDir = env.IMCODES_PROJECT_WORKTREE_NAMESPACE?.trim() || 'imcodes';
  return join(root, projectDir, input.sessionName, input.assignmentId, 'repo');
}

/**
 * Inspect the exact assignment worktree. Registry file metadata is deliberately
 * absent from this API: callers cannot use it to fabricate or veto Git state.
 */
export function inspectSupervisionAssignmentWorktree(input: {
  sessionName: string;
  assignmentId: string;
  worktreePath?: string;
  env?: NodeJS.ProcessEnv;
}): SupervisionWorktreeInspectionResult {
  const configured = resolve(input.worktreePath ?? resolveSupervisionAssignmentWorktree(input));
  try {
    const worktreePath = realpathSync(configured);
    const assignmentRoot = realpathSync(dirname(worktreePath));
    if (basename(worktreePath) !== 'repo' || !within(assignmentRoot, worktreePath)) {
      return { ok: false, reason: 'worktree_unsafe' };
    }
    const root = realpathSync(git(worktreePath, ['rev-parse', '--show-toplevel']).trim());
    if (root !== worktreePath) return { ok: false, reason: 'worktree_unsafe' };
    const headSha = git(worktreePath, ['rev-parse', 'HEAD']).trim().toLowerCase();
    if (!COMMIT_RE.test(headSha)) return { ok: false, reason: 'worktree_unsafe' };
    // --ignore-cr-at-eol excludes checkout-only CRLF normalization noise while
    // retaining every semantic byte change. Untracked files are always exact.
    const tracked = lines(git(worktreePath, ['diff', '--name-only', 'HEAD', '--']))
      .filter((path) => semanticallyDiffers(worktreePath, path));
    const stagedPaths = lines(git(worktreePath, ['diff', '--cached', '--name-only', 'HEAD', '--']));
    const conflictedPaths = lines(git(worktreePath, ['diff', '--name-only', '--diff-filter=U', '--']));
    const rawUntrackedPaths = lines(git(worktreePath, ['ls-files', '--others', '--exclude-standard']));
    if (![...tracked, ...stagedPaths, ...rawUntrackedPaths, ...conflictedPaths].every(validRepoPath)) {
      return { ok: false, reason: 'worktree_unsafe' };
    }
    // Tooling caches may be linked into an isolated worktree for local builds.
    // They are neither source evidence nor safe to follow. Inspect the link
    // itself and omit every untracked symlink without naming special folders.
    const untrackedPaths = rawUntrackedPaths.filter((path) => {
      const absolute = resolve(worktreePath, path);
      if (!within(worktreePath, absolute)) throw new Error('unsafe worktree path');
      try { return !lstatSync(absolute).isSymbolicLink(); } catch { return true; }
    });
    const changedPaths = [...new Set([...tracked, ...stagedPaths, ...untrackedPaths])].sort();
    const files = changedPaths.map((path): SupervisionWorktreeFileSnapshot => {
      const absolute = resolve(worktreePath, path);
      if (!within(worktreePath, absolute)) throw new Error('unsafe worktree path');
      let stat;
      try { stat = lstatSync(absolute); } catch { return { path, deleted: true }; }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe worktree entry');
      return { path, sha256: fileSha256(absolute) };
    });
    return {
      ok: true,
      snapshot: {
        worktreePath, headSha, files, stagedPaths, conflictedPaths, untrackedPaths,
      },
    };
  } catch {
    return { ok: false, reason: 'worktree_unavailable' };
  }
}
