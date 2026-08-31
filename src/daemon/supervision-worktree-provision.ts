import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { resolveSupervisionAssignmentWorktree } from './supervision-worktree-inspector.js';

const execFileAsync = promisify(execFile);
const COMMIT_RE = /^[0-9a-f]{40}$/;
const JOURNAL_NAME = '.worktree-provision.json';

export const SUPERVISION_WORKTREE_PROVISION_REASONS = Object.freeze({
  PROJECT_UNAVAILABLE: 'project_unavailable',
  BASE_UNAVAILABLE: 'base_unavailable',
  EXISTING_UNSAFE: 'existing_unsafe',
  EXISTING_DIRTY: 'existing_dirty',
  BASE_MISMATCH: 'base_mismatch',
  CREATE_FAILED: 'create_failed',
} as const);

export type SupervisionWorktreeProvisionReason =
  typeof SUPERVISION_WORKTREE_PROVISION_REASONS[keyof typeof SUPERVISION_WORKTREE_PROVISION_REASONS];

export type SupervisionWorktreeProvisionResult =
  | { ok: true; worktreePath: string; baseRevision: string; created: boolean }
  | { ok: false; reason: SupervisionWorktreeProvisionReason; detail: string };

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..');
}

async function git(cwd: string, args: string[], timeout = 20_000): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd, timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function commonDir(repo: string): Promise<string> {
  const raw = (await git(repo, ['rev-parse', '--git-common-dir'])).trim();
  return realpath(resolve(repo, raw));
}

export async function resolveSupervisionWorktreeBase(input: {
  projectRoot: string;
  requestedBaseRevision?: string | null;
}): Promise<{ ok: true; baseRevision: string } | { ok: false; reason: SupervisionWorktreeProvisionReason; detail: string }> {
  try {
    const root = await realpath(resolve(input.projectRoot));
    if ((await git(root, ['rev-parse', '--is-inside-work-tree'], 5_000)).trim() !== 'true') {
      return { ok: false, reason: SUPERVISION_WORKTREE_PROVISION_REASONS.PROJECT_UNAVAILABLE, detail: 'project root is not a Git worktree' };
    }
    const requested = input.requestedBaseRevision?.trim() || 'HEAD';
    const baseRevision = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${requested}^{commit}`], 5_000)).trim().toLowerCase();
    if (!COMMIT_RE.test(baseRevision)) throw new Error('resolved base is not a commit');
    return { ok: true, baseRevision };
  } catch (error) {
    return {
      ok: false,
      reason: input.requestedBaseRevision?.trim()
        ? SUPERVISION_WORKTREE_PROVISION_REASONS.BASE_UNAVAILABLE
        : SUPERVISION_WORKTREE_PROVISION_REASONS.PROJECT_UNAVAILABLE,
      detail: error instanceof Error ? error.message : 'Git base resolution failed',
    };
  }
}

/**
 * Ensure one detached assignment worktree before its first message is delivered.
 * Existing bytes are never reset, cleaned, or overwritten. A tiny journal only
 * distinguishes a daemon-created missing-path retry; it never authorizes removal.
 */
export async function ensureSupervisionAssignmentWorktree(input: {
  projectRoot: string;
  sessionName: string;
  assignmentId: string;
  baseRevision: string;
  worktreePath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SupervisionWorktreeProvisionResult> {
  const worktreePath = resolve(input.worktreePath ?? resolveSupervisionAssignmentWorktree(input));
  const assignmentRoot = dirname(worktreePath);
  const journalPath = join(assignmentRoot, JOURNAL_NAME);
  let projectRoot: string;
  let sourceCommonDir: string;
  try {
    projectRoot = await realpath(resolve(input.projectRoot));
    sourceCommonDir = await commonDir(projectRoot);
  } catch (error) {
    return { ok: false, reason: SUPERVISION_WORKTREE_PROVISION_REASONS.PROJECT_UNAVAILABLE, detail: error instanceof Error ? error.message : 'project unavailable' };
  }
  if (!COMMIT_RE.test(input.baseRevision) || !within(assignmentRoot, worktreePath)) {
    return { ok: false, reason: SUPERVISION_WORKTREE_PROVISION_REASONS.EXISTING_UNSAFE, detail: 'invalid assignment worktree path/base' };
  }

  if (await exists(worktreePath)) {
    try {
      const actualRoot = await realpath(worktreePath);
      const actualAssignmentRoot = await realpath(assignmentRoot);
      if (basename(actualRoot) !== 'repo' || dirname(actualRoot) !== actualAssignmentRoot
        || !within(actualAssignmentRoot, actualRoot) || await commonDir(actualRoot) !== sourceCommonDir) {
        throw new Error('existing path is not the expected repository worktree');
      }
      const head = (await git(actualRoot, ['rev-parse', 'HEAD'], 5_000)).trim().toLowerCase();
      if (head !== input.baseRevision) {
        return { ok: false, reason: SUPERVISION_WORKTREE_PROVISION_REASONS.BASE_MISMATCH, detail: `existing HEAD ${head} does not match ${input.baseRevision}` };
      }
      const dirty = (await git(actualRoot, ['status', '--porcelain=v1', '--untracked-files=all'], 5_000)).trim();
      if (dirty) {
        return { ok: false, reason: SUPERVISION_WORKTREE_PROVISION_REASONS.EXISTING_DIRTY, detail: 'existing assignment worktree has tracked or untracked changes' };
      }
      await rm(journalPath, { force: true });
      return { ok: true, worktreePath, baseRevision: head, created: false };
    } catch (error) {
      return { ok: false, reason: SUPERVISION_WORKTREE_PROVISION_REASONS.EXISTING_UNSAFE, detail: error instanceof Error ? error.message : 'existing worktree is unsafe' };
    }
  }

  try {
    await mkdir(assignmentRoot, { recursive: true });
    if (await exists(journalPath)) {
      const prior = JSON.parse(await readFile(journalPath, 'utf8')) as Record<string, unknown>;
      if (prior.assignmentId !== input.assignmentId || prior.baseRevision !== input.baseRevision || prior.worktreePath !== worktreePath) {
        return { ok: false, reason: SUPERVISION_WORKTREE_PROVISION_REASONS.EXISTING_UNSAFE, detail: 'worktree provision journal conflicts with this assignment' };
      }
    } else {
      await writeFile(journalPath, JSON.stringify({
        version: 1,
        assignmentId: input.assignmentId,
        baseRevision: input.baseRevision,
        worktreePath,
      }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    }
    await git(projectRoot, ['worktree', 'add', '--detach', '--', worktreePath, input.baseRevision]);
    const head = (await git(worktreePath, ['rev-parse', 'HEAD'], 5_000)).trim().toLowerCase();
    if (head !== input.baseRevision || await commonDir(worktreePath) !== sourceCommonDir) {
      throw new Error('created worktree failed base/common-dir verification');
    }
    await rm(journalPath, { force: true });
    return { ok: true, worktreePath, baseRevision: head, created: true };
  } catch (error) {
    // Never remove an extant directory here: a crash may have been followed by
    // user writes. The journal makes the interrupted state explicit and retryable
    // when the repo path is still absent; otherwise recovery fails closed.
    return { ok: false, reason: SUPERVISION_WORKTREE_PROVISION_REASONS.CREATE_FAILED, detail: error instanceof Error ? error.message : 'git worktree add failed' };
  }
}
