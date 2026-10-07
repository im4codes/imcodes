/**
 * Where a pair's audit material is.
 *
 * A pair has no bundle, attempt or registry binding: the material is the
 * executor's workspace. For a worktree that is the worktree at a HEAD: the
 * executor names it on READY_FOR_AUDIT (`worktree=`, `head=`, `base=`); what
 * it leaves out the daemon fills in from the pair's own daemon-provisioned
 * worktree (`pair.workspace`), reading that worktree's HEAD with one
 * bounded, asynchronous `git rev-parse`. For a task directory it is a path
 * (`path=`, else the directory itself) and there is no HEAD. It NEVER falls
 * back to the executor session's raw project checkout -- an unresolved
 * pair reports its material as `pending` instead, and the daemon asks the
 * executor to resend rather than hand the auditor a project-wide checkout
 * that was never scoped to this task.
 */
import { execFileOffMainCallback as execFile } from '../../util/exec-helper.js';
import { existsSync } from 'node:fs';
import { redirectTaskPairWorkspacePath, sameTaskPairCommit, type TaskPairState } from '../../../shared/task-pair.js';
import { buildCowReview } from './non-git.js';

const GIT_HEAD_TIMEOUT_MS = 5_000;

export interface ResolvedTaskPairMaterial {
  worktree?: string;
  head?: string;
  base?: string;
  /** Task-directory material. */
  path?: string;
  /** Non-git project (cow clone / in-place): which way it is handled, so the audit request says how to review. */
  nonGit?: { mode: 'cow' | 'in_place'; projectRoot: string };
  /** In-place mode: the changed files the executor stated on READY (comma separated). */
  files?: string;
  /** COW mode: the daemon's comparison of the clone with its manifest, and the per-file diff against the project original. */
  review?: { changes: Array<{ kind: 'added' | 'modified' | 'deleted'; path: string }>; diff: string; diffTruncated: boolean; diffFile?: string; summaries: string[] };
  intentionalNote?: string;
  /** Rebase-only ownership context; never persisted in pair material. */
  ownershipBase?: string;
  ownershipHead?: string;
  /** Who named the material: the executor's marker, or the daemon's fallback. */
  source: 'executor' | 'workspace' | 'pending';
}

export interface TaskPairMaterialDeps {
  gitHead?: (worktree: string) => Promise<string | undefined>;
  /** True when `ancestor` is reachable from `descendant`, false when it is not, undefined when git cannot tell (unknown commit, no repo, timeout). */
  gitIsAncestor?: (worktree: string, ancestor: string, descendant: string) => Promise<boolean | undefined>;
}

function defaultGitHead(worktree: string): Promise<string | undefined> {
  // No process for a directory that is not there (a session without a checkout).
  if (!existsSync(worktree)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile('git', ['-C', worktree, 'rev-parse', 'HEAD'], { timeout: GIT_HEAD_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      const head = String(stdout ?? '').trim();
      resolve(!error && /^[0-9a-f]{7,64}$/i.test(head) ? head : undefined);
    });
  });
}

function defaultGitIsAncestor(worktree: string, ancestor: string, descendant: string): Promise<boolean | undefined> {
  if (!existsSync(worktree)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile('git', ['-C', worktree, 'merge-base', '--is-ancestor', ancestor, descendant], { timeout: GIT_HEAD_TIMEOUT_MS, windowsHide: true }, (error) => {
      if (!error) return resolve(true);
      // Exit 1 is git's definite "not an ancestor"; anything else (128 for an
      // unknown object, a timeout, a missing git) is "cannot tell".
      resolve((error as unknown as { code?: number | string }).code === 1 ? false : undefined);
    });
  });
}

let testDeps: TaskPairMaterialDeps | undefined;

export function setTaskPairMaterialDepsForTests(deps: TaskPairMaterialDeps | undefined): void {
  testDeps = deps;
}

export async function resolveTaskPairMaterial(pair: TaskPairState, deps: TaskPairMaterialDeps = testDeps ?? {}): Promise<ResolvedTaskPairMaterial> {
  const workspace = pair.workspace && pair.workspace.status !== 'removed' ? pair.workspace : undefined;
  // A READY written after the worktree moved under a new executor may still
  // name the old path: it resolves to the workspace's current location, so an
  // audit request never carries a dead path.
  const named = pair.material && workspace?.previousPaths?.length
    ? {
        ...pair.material,
        ...(pair.material.worktree ? { worktree: redirectTaskPairWorkspacePath(workspace, pair.material.worktree) } : {}),
        ...(pair.material.path ? { path: redirectTaskPairWorkspacePath(workspace, pair.material.path) } : {}),
      }
    : pair.material;
  const nonGit = workspace?.kind === 'dir' ? workspace.nonGit : undefined;
  if (workspace && nonGit?.mode === 'cow' && !named?.worktree && !named?.head) {
    // The executor names the clone; the changed files are the daemon's own comparison with the manifest, never the executor's word.
    const review = await buildCowReview(workspace.path).catch(() => undefined);
    return {
      path: workspace.path, source: named?.path ? 'executor' : 'workspace', nonGit: { mode: 'cow', projectRoot: nonGit.projectRoot },
      ...(review ? { review: { changes: review.changes.map((change) => ({ kind: change.kind, path: change.path })), diff: review.diff, diffTruncated: review.diffTruncated, ...(review.diffFile ? { diffFile: review.diffFile } : {}), summaries: review.summaries } } : {}),
    };
  }
  if (workspace && nonGit?.mode === 'in_place' && !named?.worktree && !named?.head) {
    // The project directory itself is the material; there is no HEAD or base to flag.
    return {
      path: nonGit.projectRoot, source: named?.path ? 'executor' : 'workspace', nonGit: { mode: 'in_place', projectRoot: nonGit.projectRoot },
      ...(named?.files ? { files: named.files } : {}),
    };
  }
  if (workspace?.kind === 'dir' && !named?.worktree && !named?.head) {
    return { path: named?.path ?? workspace.path, source: named?.path ? 'executor' : 'workspace' };
  }
  // The executor's own words first, then the worktree the daemon created
  // for the pair. Never the raw executor session checkout -- unresolved is
  // 'pending', not a silent fallback to the project directory.
  const worktree = named?.worktree
    ?? (workspace?.kind === 'worktree' ? workspace.path : undefined);
  const head = named?.head ?? (worktree ? await (deps.gitHead ?? defaultGitHead)(worktree) : workspace?.lastHead ?? undefined);
  return {
    ...(worktree ? { worktree } : {}),
    ...(head ? { head } : {}),
    ...(named?.base ? { base: named.base } : workspace?.base ? { base: workspace.base } : {}),
    ...(named?.intentionalNote ? { intentionalNote: named.intentionalNote } : {}),
    source: named?.worktree || named?.head ? 'executor' : workspace ? 'workspace' : 'pending',
  };
}

export type TaskPairRoundBaseCheck =
  | { status: 'none' }
  | { status: 'ok'; base: string; head: string }
  /** head is the round base itself: no new commit was made in this round. */
  | { status: 'same_as_base'; base: string; head: string }
  | { status: 'not_ancestor'; base: string; head: string }
  | { status: 'unverifiable'; base: string; head?: string };

/**
 * A delivery round opened by NEXT_ROUND is built on `pair.roundBase`: the
 * material's head must descend from it. The state machine already checked the
 * named base= text; only git can check ancestry. Only a definite "not an
 * ancestor" blocks the audit request -- an unknown commit (for example a base
 * that exists on the daemon's dev checkout but not yet in this worktree) is
 * reported to the auditor as unverified instead of stalling the pair.
 */
export async function verifyTaskPairRoundBase(
  pair: TaskPairState,
  material: ResolvedTaskPairMaterial,
  deps: TaskPairMaterialDeps = testDeps ?? {},
): Promise<TaskPairRoundBaseCheck> {
  const base = pair.roundBase?.commit;
  if (!base) return { status: 'none' };
  if (!material.worktree || !material.head) return { status: 'unverifiable', base, ...(material.head ? { head: material.head } : {}) };
  if (sameTaskPairCommit(material.head, base)) return { status: 'same_as_base', base, head: material.head };
  const descends = await (deps.gitIsAncestor ?? defaultGitIsAncestor)(material.worktree, base, material.head);
  if (descends === undefined) return { status: 'unverifiable', base, head: material.head };
  return descends ? { status: 'ok', base, head: material.head } : { status: 'not_ancestor', base, head: material.head };
}
