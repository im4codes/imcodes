/**
 * The workspace a pair's executor works in.
 *
 * A code task in a git project gets a git worktree, created under the same root
 * and layout as legacy assignment worktrees (`~/.imcodes/worktrees/<namespace>/
 * <executor session>/pair_<taskId>/repo`, with a `metadata.json` beside it that
 * registers it with the worktree GC). Anything else -- a project that is not a
 * git repo, or a task Brain dispatched with `workspace=dir` -- gets a plain task
 * directory, `~/.imcodes/works/<project>/<taskId>/`. The daemon hands the path
 * to the executor at dispatch and to the auditor at READY_FOR_AUDIT. Never the
 * main checkout, never /tmp, and a non-git project is never turned into one.
 *
 * Lifecycle, by markers only: when the pair ends (DONE, CANCEL, Brain's DONE
 * force=true) the workspace is marked ended, a deliverable named on DONE
 * (`output=`) is copied into the project directory, and seven days later the
 * pair sweep removes the workspace -- except a worktree that still holds work
 * existing nowhere else (uncommitted or untracked files, or commits no remote
 * has), which is kept and reported to Brain. The worktree GC is the backstop.
 */
import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { getSession } from '../../store/session-store.js';
import {
  TASK_PAIR_WORKS_DIR,
  TASK_PAIR_WORKS_ROOT_ENV,
  TASK_PAIR_WORKTREE_PREFIX,
  type TaskPairState,
  type TaskPairWorkspaceKind,
} from '../../../shared/task-pair.js';
import { resolveSupervisionAssignmentWorktree } from '../supervision-worktree-inspector.js';
import {
  ensureSupervisionAssignmentWorktree,
  resolveSupervisionWorktreeBase,
} from '../supervision-worktree-provision.js';
import {
  countTaskPairUnpushedCommits,
  inspectSupervisionGitWorktree,
  removeRegisteredGitWorktree,
  type SupervisionWorktreeGitInspection,
  type SupervisionWorktreeMetadata,
} from '../supervision-worktree-gc.js';

const GIT_PROBE_TIMEOUT_MS = 5_000;

function gitBranch(repoPath: string): Promise<string | undefined> {
  return new Promise((resolve) => execFile('git', ['-C', repoPath, 'symbolic-ref', '--short', '-q', 'HEAD'], { timeout: GIT_PROBE_TIMEOUT_MS }, (error, stdout) => {
    const value = String(stdout ?? '').trim();
    resolve(!error && value ? value : undefined);
  }));
}


/** Path-safe directory name for a pair's worktree (task ids may be Brain-named). */
export function taskPairWorktreeName(taskId: string): string {
  return `${TASK_PAIR_WORKTREE_PREFIX}${taskId.toLowerCase().replace(/[^0-9a-z_-]/g, '-')}`;
}

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^0-9A-Za-z_.-]/g, '-').replace(/^\.+/, '-');
  return cleaned || '-';
}

/** `~/.imcodes/works` (or the override): the root of every pair task directory. */
export function resolveTaskPairWorksRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env[TASK_PAIR_WORKS_ROOT_ENV]?.trim() || join(homedir(), '.imcodes', TASK_PAIR_WORKS_DIR));
}

/** `~/.imcodes/works/<project>/<taskId>/` */
export function resolveTaskPairTaskDir(project: string, taskId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveTaskPairWorksRoot(env), safeSegment(project), safeSegment(taskId));
}

export type TaskPairWorkspaceProvision =
  | { ok: true; kind: TaskPairWorkspaceKind; path: string; base?: string; branch?: string }
  | { ok: false; detail: string };

export type TaskPairWorkspaceRelease =
  | { action: 'removed' }
  | { action: 'absent' }
  /** The pair changed while release was in flight; nothing was removed. */
  | { action: 'skipped' }
  | { action: 'kept'; reason: 'dirty' | 'untracked' | 'unpushed' | 'locked' | 'unreadable' };

export type TaskPairOutputCopy =
  | { ok: true; dest: string }
  | { ok: false; reason: 'no_workspace' | 'no_project' | 'missing' | 'outside_workspace' | 'outside_project' | 'exists' | 'copy_failed' };

export interface TaskPairWorkspaceDeps {
  env?: NodeJS.ProcessEnv;
  projectRootOf?: (pair: TaskPairState) => string | undefined;
  inspectGit?: (repoPath: string) => Promise<SupervisionWorktreeGitInspection>;
  /** Re-check ownership/liveness immediately before deleting the workspace. */
  beforeRemove?: () => boolean | Promise<boolean>;
}

function allowWorkspaceRemoval(deps: TaskPairWorkspaceDeps): boolean | Promise<boolean> {
  if (!deps.beforeRemove) return true;
  // Keep synchronous checks synchronous: the service's ownership check reads
  // the same in-process store, and yielding between it and rmSync() would
  // re-open a window where a marker can win the race after the final check.
  const result = deps.beforeRemove();
  if (typeof result === 'boolean') return result;
  return result;
}

async function removalAllowed(deps: TaskPairWorkspaceDeps): Promise<boolean> {
  const result = allowWorkspaceRemoval(deps);
  return typeof result === 'boolean' ? result : await result;
}

let testDeps: TaskPairWorkspaceDeps | undefined;

export function setTaskPairWorkspaceDepsForTests(deps: TaskPairWorkspaceDeps | undefined): void {
  testDeps = deps;
}

function defaultProjectRoot(pair: TaskPairState): string | undefined {
  return (pair.executor ? getSession(pair.executor)?.projectDir : undefined) || getSession(pair.brain)?.projectDir;
}

/** The project directory of a pair: where kept deliverables go. */
export function taskPairProjectRoot(pair: TaskPairState, deps: TaskPairWorkspaceDeps = testDeps ?? {}): string | undefined {
  return (deps.projectRootOf ?? defaultProjectRoot)(pair);
}

function isGitWorkTree(root: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    execFile('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { timeout: GIT_PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      resolvePromise(!error && String(stdout ?? '').trim() === 'true');
    });
  });
}

async function provisionTaskDir(project: string, pair: TaskPairState, env?: NodeJS.ProcessEnv): Promise<TaskPairWorkspaceProvision> {
  const path = resolveTaskPairTaskDir(project, pair.taskId, env);
  await mkdir(path, { recursive: true });
  return { ok: true, kind: 'dir', path };
}

/**
 * Create (or reuse) the pair's workspace: a worktree from the project
 * checkout's HEAD for code in a git project, a task directory otherwise.
 */
export async function provisionTaskPairWorkspace(
  project: string,
  pair: TaskPairState,
  deps: TaskPairWorkspaceDeps = testDeps ?? {},
): Promise<TaskPairWorkspaceProvision> {
  if (!pair.executor) return { ok: false, detail: 'no executor yet' };
  const projectRoot = taskPairProjectRoot(pair, deps);
  if (!projectRoot) return { ok: false, detail: 'no project directory for the pair' };
  if (!(await stat(projectRoot).catch(() => undefined))?.isDirectory()) return { ok: false, detail: 'the project directory does not exist' };
  // Only a git checkout gets a worktree; a non-git project is never git-initialised.
  if (pair.workspaceKind === 'dir' || !(await isGitWorkTree(projectRoot))) return provisionTaskDir(project, pair, deps.env);
  const assignmentId = taskPairWorktreeName(pair.taskId);
  const requestedBase = pair.workspace?.base ?? pair.material?.base ?? pair.material?.head;
  const base = await resolveSupervisionWorktreeBase({ projectRoot, requestedBaseRevision: requestedBase });
  // A git repo without a commit has nothing to branch from: a task directory still works.
  if (!base.ok) return provisionTaskDir(project, pair, deps.env);
  const repoPath = resolveSupervisionAssignmentWorktree({ sessionName: pair.executor, assignmentId, env: deps.env });
  const result = await ensureSupervisionAssignmentWorktree({
    projectRoot, sessionName: pair.executor, assignmentId, baseRevision: base.baseRevision, worktreePath: repoPath, env: deps.env,
  });
  if (!result.ok) return { ok: false, detail: `${result.reason}: ${result.detail}` };
  // Registration with the worktree GC: the same metadata legacy worktrees carry.
  const metadata: SupervisionWorktreeMetadata = {
    taskId: pair.taskId,
    assignmentId,
    sessionName: pair.executor,
    baseRevision: result.baseRevision,
    repoPath: result.worktreePath,
    createdAt: new Date().toISOString(),
  };
  await mkdir(dirname(result.worktreePath), { recursive: true });
  await writeFile(join(dirname(result.worktreePath), 'metadata.json'), JSON.stringify(metadata));
  const branch = await gitBranch(result.worktreePath);
  return { ok: true, kind: 'worktree', path: result.worktreePath, base: result.baseRevision, ...(branch ? { branch } : {}) };
}

/**
 * Remove the pair's workspace (its retention elapsed). A task directory always
 * goes; a worktree is kept while that would lose work.
 */
export async function releaseTaskPairWorkspace(
  pair: TaskPairState,
  deps: TaskPairWorkspaceDeps = testDeps ?? {},
): Promise<TaskPairWorkspaceRelease> {
  const workspace = pair.workspace;
  if (!workspace) return { action: 'absent' };
  if (workspace.kind === 'dir') {
    const allowed = allowWorkspaceRemoval(deps);
    if (typeof allowed === 'boolean' ? !allowed : !(await allowed)) return { action: 'skipped' };
    // A plain task directory has no git bookkeeping to settle.  Delete it
    // synchronously after the ownership check so a reopen cannot interleave
    // between the check and the filesystem mutation.
    rmSync(workspace.path, { recursive: true, force: true });
    return { action: 'removed' };
  }
  const repoPath = workspace.path;
  const assignmentRoot = dirname(repoPath);
  const repoStat = await lstat(repoPath).catch(() => undefined);
  if (!repoStat) {
    await rm(assignmentRoot, { recursive: true, force: true });
    return { action: 'removed' };
  }
  const inspection = await (deps.inspectGit ?? inspectSupervisionGitWorktree)(repoPath);
  if (!inspection.ok) return { action: 'kept', reason: 'unreadable' };
  if (inspection.locked) return { action: 'kept', reason: 'locked' };
  if (inspection.dirty) return { action: 'kept', reason: 'dirty' };
  if (inspection.untracked) return { action: 'kept', reason: 'untracked' };
  // Commits the executor made that no remote has would be lost with a
  // detached worktree; a pushed branch, or an untouched base, would not.
  const unpushed = workspace.base ? await countTaskPairUnpushedCommits(repoPath, workspace.base) : undefined;
  if (unpushed === undefined || unpushed > 0) return { action: 'kept', reason: 'unpushed' };
  if (!(await removalAllowed(deps))) return { action: 'skipped' };
  if (!(await removeRegisteredGitWorktree(inspection, repoPath))) return { action: 'kept', reason: 'unreadable' };
  await rm(assignmentRoot, { recursive: true, force: true });
  return { action: 'removed' };
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && rel.split(sep)[0] !== '..';
}

async function freeDestination(dest: string, taskId: string): Promise<string | undefined> {
  const exists = async (path: string) => Boolean(await lstat(path).catch(() => undefined));
  if (!(await exists(dest))) return dest;
  const extension = extname(dest);
  const stem = extension ? dest.slice(0, -extension.length) : dest;
  const suffix = safeSegment(taskId);
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const candidate = `${stem}.${suffix}${attempt > 1 ? `-${attempt}` : ''}${extension}`;
    if (!(await exists(candidate))) return candidate;
  }
  return undefined;
}

/**
 * Copy the deliverable named on DONE (`output=`, optional `dest=`) from the
 * workspace into the project directory. Both paths must stay inside their
 * directory; an existing destination is never overwritten (the copy takes a
 * task-suffixed name beside it).
 */
export async function copyTaskPairOutput(
  pair: TaskPairState,
  deps: TaskPairWorkspaceDeps = testDeps ?? {},
): Promise<TaskPairOutputCopy> {
  const workspace = pair.workspace;
  if (!workspace || workspace.status === 'removed' || !pair.output) return { ok: false, reason: 'no_workspace' };
  const projectRoot = taskPairProjectRoot(pair, deps);
  if (!projectRoot) return { ok: false, reason: 'no_project' };
  const workspaceRoot = await realpath(workspace.path).catch(() => undefined);
  const projectReal = await realpath(projectRoot).catch(() => undefined);
  if (!workspaceRoot) return { ok: false, reason: 'no_workspace' };
  if (!projectReal) return { ok: false, reason: 'no_project' };
  const sourceResolved = resolve(workspaceRoot, pair.output.path);
  const source = await realpath(sourceResolved).catch(() => undefined);
  if (!source) return { ok: false, reason: isInside(workspaceRoot, sourceResolved) ? 'missing' : 'outside_workspace' };
  if (!isInside(workspaceRoot, source)) return { ok: false, reason: 'outside_workspace' };
  const destRelative = pair.output.dest ?? relative(workspaceRoot, source);
  const wanted = resolve(projectReal, destRelative);
  if (!isInside(projectReal, wanted)) return { ok: false, reason: 'outside_project' };
  // Lexical containment is insufficient when an existing destination parent is
  // a symlink. Resolve the nearest existing parent and rebuild below its real
  // path before creating anything.
  let existingParent = dirname(wanted);
  while (!(await lstat(existingParent).catch(() => undefined))) {
    const parent = dirname(existingParent);
    if (parent === existingParent) return { ok: false, reason: 'outside_project' };
    existingParent = parent;
  }
  const existingParentReal = await realpath(existingParent).catch(() => undefined);
  if (!existingParentReal || (existingParentReal !== projectReal && !isInside(projectReal, existingParentReal))) return { ok: false, reason: 'outside_project' };
  const wantedParentRelative = relative(existingParent, dirname(wanted));
  const safeWanted = resolve(existingParentReal, wantedParentRelative, basename(wanted));
  if (!isInside(projectReal, safeWanted)) return { ok: false, reason: 'outside_project' };
  const dest = await freeDestination(safeWanted, pair.taskId);
  if (!dest) return { ok: false, reason: 'exists' };
  try {
    await mkdir(dirname(dest), { recursive: true });
    await cp(source, dest, { recursive: true, errorOnExist: true, force: false });
    return { ok: true, dest };
  } catch {
    return { ok: false, reason: 'copy_failed' };
  }
}
