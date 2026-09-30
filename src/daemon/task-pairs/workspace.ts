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
 *
 * Disk hygiene (workspace-hygiene.ts): at once when the pair ends, and again for
 * any ended pair the hourly sweep finds unstripped, the rebuildable git-ignored
 * weight (node_modules, build outputs) is removed while commits, tracked files
 * and uncommitted work stay. A low-space volume strips the oldest ended pairs
 * first. A pair reopened afterwards keeps its worktree but not that weight: its
 * executor reinstalls what it needs.
 */
import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rm, rmdir, stat, writeFile } from 'node:fs/promises';
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
import { isSessionBusy } from './pool.js';
import { resolveSupervisionAssignmentWorktree, resolveSupervisionWorktreesRoot } from '../supervision-worktree-inspector.js';
import { ensureSupervisionAssignmentWorktree } from '../supervision-worktree-provision.js';
import {
  countTaskPairCommitsNotInDev,
  inspectSupervisionGitWorktree,
  removeRegisteredGitWorktree,
  type SupervisionWorktreeGitInspection,
  type SupervisionWorktreeMetadata,
} from '../supervision-worktree-gc.js';

const GIT_PROBE_TIMEOUT_MS = 5_000;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

export function gitBranch(repoPath: string): Promise<string | undefined> {
  return new Promise((resolve) => execFile('git', ['-C', repoPath, 'symbolic-ref', '--short', '-q', 'HEAD'], { timeout: GIT_PROBE_TIMEOUT_MS }, (error, stdout) => {
    const value = String(stdout ?? '').trim();
    resolve(!error && value ? value : undefined);
  }));
}

/** Resolve `ref` to a full commit sha inside `repoRoot`, or undefined if it does not exist. */
function resolveCommit(repoRoot: string, ref: string): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    execFile('git', ['-C', repoRoot, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { timeout: GIT_PROBE_TIMEOUT_MS }, (error, stdout) => {
      const value = String(stdout ?? '').trim().toLowerCase();
      resolvePromise(!error && COMMIT_SHA_RE.test(value) ? value : undefined);
    });
  });
}

/** Best-effort: attach a freshly-created detached worktree to an existing local branch. */
function checkoutExistingBranch(worktreePath: string, branch: string): Promise<void> {
  return new Promise((resolvePromise) => {
    execFile('git', ['-C', worktreePath, 'checkout', '--ignore-other-worktrees', branch], { timeout: GIT_PROBE_TIMEOUT_MS }, () => resolvePromise());
  });
}

/**
 * Best-effort: drop a stale `git worktree` registration for a path whose
 * directory is already gone. The generic assignment provisioner refuses to
 * recreate a registered worktree at a revision other than its last known
 * HEAD (a legacy-assignment safety rule: an assignment worktree never moves
 * off its original base) -- but a pair's self-heal rebuild legitimately
 * targets a DIFFERENT, more current revision (lastHead/material.head) than
 * whatever the worktree last had. Only ever called against a path already
 * confirmed missing on disk, so there is no live data this could discard.
 */
function pruneStaleWorktreeRegistration(projectRoot: string, worktreePath: string): Promise<void> {
  return new Promise((resolvePromise) => {
    execFile('git', ['-C', projectRoot, 'worktree', 'remove', '--force', '--', worktreePath], { timeout: GIT_PROBE_TIMEOUT_MS }, () => resolvePromise());
  });
}

export type TaskPairWorkspaceRevisionSource = 'branch' | 'lastHead' | 'materialHead' | 'base' | 'default' | 'directory';

interface ResolvedWorkspaceRevision {
  revision: string;
  source: TaskPairWorkspaceRevisionSource;
  branch?: string;
}

/**
 * Where a rebuilt (or freshly provisioned) workspace's worktree starts from,
 * first that resolves: the pair's own existing branch (re-attached, not
 * detached, so further commits continue its history), then the most
 * recently observed head, then the material relay's head, then the
 * recorded/dispatched base, then the project's default branch (its own
 * current HEAD). A fresh pair has no `workspace` yet, so branch/lastHead are
 * simply skipped -- the same order still applies.
 */
async function resolveWorkspaceRebuildRevision(
  projectRoot: string,
  pair: TaskPairState,
): Promise<ResolvedWorkspaceRevision | undefined> {
  const branch = pair.workspace?.branch;
  if (branch) {
    const revision = await resolveCommit(projectRoot, `refs/heads/${branch}`);
    if (revision) return { revision, source: 'branch', branch };
  }
  const lastHead = pair.workspace?.lastHead;
  if (lastHead) {
    const revision = await resolveCommit(projectRoot, lastHead);
    if (revision) return { revision, source: 'lastHead' };
  }
  const materialHead = pair.material?.head;
  if (materialHead) {
    const revision = await resolveCommit(projectRoot, materialHead);
    if (revision) return { revision, source: 'materialHead' };
  }
  const base = pair.workspace?.base ?? pair.material?.base;
  if (base) {
    const revision = await resolveCommit(projectRoot, base);
    if (revision) return { revision, source: 'base' };
  }
  const revision = await resolveCommit(projectRoot, 'HEAD');
  return revision ? { revision, source: 'default' } : undefined;
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
  | { ok: true; kind: TaskPairWorkspaceKind; path: string; base?: string; branch?: string; source: TaskPairWorkspaceRevisionSource }
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
  countCommitsNotInDev?: (repoPath: string, baseRevision: string) => Promise<number | undefined>;
  /** Rehome: is this session mid-turn (or has queued work)? */
  isBusy?: (sessionName: string) => boolean;
  /** Rehome: does any live process have its working directory inside `path`? */
  hasProcessInside?: (path: string) => Promise<boolean>;
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
  return { ok: true, kind: 'dir', path, source: 'directory' };
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
  const resolved = await resolveWorkspaceRebuildRevision(projectRoot, pair);
  // A git repo without a commit has nothing to branch from: a task directory still works.
  if (!resolved) return provisionTaskDir(project, pair, deps.env);
  const repoPath = resolveSupervisionAssignmentWorktree({ sessionName: pair.executor, assignmentId, env: deps.env });
  if (!(await lstat(repoPath).catch(() => undefined))) await pruneStaleWorktreeRegistration(projectRoot, repoPath);
  const result = await ensureSupervisionAssignmentWorktree({
    projectRoot, sessionName: pair.executor, assignmentId, baseRevision: resolved.revision, worktreePath: repoPath, env: deps.env,
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
  // The generic provisioner always creates a detached worktree. When we
  // resolved via the pair's own existing branch, re-attach to it (best
  // effort) so commits the executor makes continue that branch's history
  // instead of drifting into a detached HEAD no one is tracking.
  if (resolved.source === 'branch' && resolved.branch) await checkoutExistingBranch(result.worktreePath, resolved.branch);
  const branch = await gitBranch(result.worktreePath);
  return { ok: true, kind: 'worktree', path: result.worktreePath, base: result.baseRevision, source: resolved.source, ...(branch ? { branch } : {}) };
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
  // Commits the executor made that Brain has not integrated into origin/dev
  // would be lost. A cherry-picked equivalent in dev is safe to remove.
  const notInDev = workspace.base
    ? await (deps.countCommitsNotInDev ?? countTaskPairCommitsNotInDev)(repoPath, workspace.base)
    : undefined;
  if (notInDev === undefined || notInDev > 0) return { action: 'kept', reason: 'unpushed' };
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


// ---- executor change: keep exactly one authoritative workspace -------------

export type TaskPairWorkspaceRehome =
  | { action: 'unchanged' }
  | { action: 'moved'; from: string; to: string; branch?: string }
  /** The recorded path is gone and the new executor's worktree already exists there: it becomes the workspace. */
  | { action: 'adopted'; from: string; to: string }
  /** Both exist: the recorded worktree stays authoritative and the other one is only registered. */
  | { action: 'duplicate'; kept: string; duplicate: string }
  | { action: 'deferred'; reason: 'session_busy' | 'process_inside'; detail: string }
  | { action: 'failed'; detail: string };

/** Who owns a daemon-layout worktree path: `<root>/<namespace>/<session>/<assignmentId>/repo`. */
function worktreeOwnerSession(repoPath: string, assignmentId: string): string | undefined {
  if (basename(repoPath) !== 'repo') return undefined;
  const assignmentRoot = dirname(repoPath);
  if (basename(assignmentRoot) !== assignmentId) return undefined;
  return basename(dirname(assignmentRoot)) || undefined;
}

/** Live processes whose working directory is inside `path` (a shell or test run the move would break). */
async function defaultHasProcessInside(path: string): Promise<boolean> {
  const inside = (cwd: string) => cwd === path || cwd.startsWith(path + sep);
  if (process.platform === 'linux') {
    const pids = await readdir('/proc').catch(() => [] as string[]);
    for (const pid of pids) {
      if (!/^\d+$/.test(pid)) continue;
      const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => undefined);
      if (cwd && inside(cwd)) return true;
    }
    return false;
  }
  if (process.platform === 'win32') return false; // no cheap equivalent; the busy-session check still applies
  return new Promise((resolvePromise) => {
    execFile('lsof', ['-a', '-d', 'cwd', '-Fn'], { timeout: GIT_PROBE_TIMEOUT_MS * 2, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      // lsof exits 1 when nothing matched its filters; other failures mean "unknown": do not block on them.
      if (error && !String(stdout ?? '')) return resolvePromise(false);
      resolvePromise(String(stdout ?? '').split('\n').some((line) => line.startsWith('n') && inside(line.slice(1))));
    });
  });
}

function gitCommonDirOf(repoPath: string): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    execFile('git', ['-C', repoPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: GIT_PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      const value = String(stdout ?? '').trim();
      resolvePromise(!error && value ? value : undefined);
    });
  });
}

/**
 * After an executor change the pair's worktree still sits under the previous
 * executor's session directory. Move it (git worktree move: branch, HEAD,
 * uncommitted work and stashes stay) under the new executor so there is one
 * authoritative workspace under the executor that uses it.
 *
 * - Never while the old or new executor is busy, or any process has its cwd
 *   inside the worktree: a running shell would lose its directory. Deferred;
 *   the heartbeat asks again.
 * - Crash safe: a move that finished on disk but not on the pair (the old path
 *   is gone and the target exists) is adopted, never redone.
 * - Never overwrites: a worktree already at the target is registered as a
 *   duplicate and left alone.
 * Paths that are not in the daemon's `<session>/pair_<task>/repo` layout (Brain
 * named its own) are left where they are.
 */
export async function rehomeTaskPairWorkspace(
  pair: TaskPairState,
  deps: TaskPairWorkspaceDeps = testDeps ?? {},
): Promise<TaskPairWorkspaceRehome> {
  const workspace = pair.workspace;
  if (!workspace || workspace.kind !== 'worktree' || workspace.status === 'removed' || !pair.executor) return { action: 'unchanged' };
  const assignmentId = taskPairWorktreeName(pair.taskId);
  const target = resolveSupervisionAssignmentWorktree({ sessionName: pair.executor, assignmentId, env: deps.env });
  if (resolve(workspace.path) === resolve(target)) return { action: 'unchanged' };
  const owner = worktreeOwnerSession(workspace.path, assignmentId);
  if (!owner || owner === pair.executor) return { action: 'unchanged' };
  const oldPresent = Boolean(await lstat(workspace.path).catch(() => undefined));
  const newPresent = Boolean(await lstat(target).catch(() => undefined));
  if (!oldPresent) return newPresent && await isGitWorkTree(target) ? { action: 'adopted', from: workspace.path, to: target } : { action: 'unchanged' };
  if (newPresent) return { action: 'duplicate', kept: workspace.path, duplicate: target };
  const busy = deps.isBusy ?? ((name: string) => isSessionBusy(name));
  for (const name of new Set([owner, pair.executor])) {
    if (busy(name)) return { action: 'deferred', reason: 'session_busy', detail: name };
  }
  if (await (deps.hasProcessInside ?? defaultHasProcessInside)(workspace.path)) {
    return { action: 'deferred', reason: 'process_inside', detail: workspace.path };
  }
  const commonDir = await gitCommonDirOf(workspace.path);
  if (!commonDir) return { action: 'failed', detail: 'the worktree is not readable by git' };
  await mkdir(dirname(target), { recursive: true });
  const moved = await new Promise<{ ok: boolean; detail: string }>((resolvePromise) => {
    execFile('git', [`--git-dir=${commonDir}`, 'worktree', 'move', '--', workspace.path, target], { timeout: 30_000, windowsHide: true }, (error, _stdout, stderr) => {
      resolvePromise({ ok: !error, detail: String(stderr ?? error?.message ?? '').trim().slice(0, 300) });
    });
  });
  // Windows refuses to rename a directory some process still holds as its cwd (there is no cheap probe for that
  // on Windows): that is "busy", not a failure -- retry later instead of alarming Brain.
  if (!moved.ok && process.platform === 'win32' && /permission denied|used by another process|access is denied|invalid argument/i.test(moved.detail)) {
    return { action: 'deferred', reason: 'process_inside', detail: workspace.path };
  }
  if (!moved.ok) return { action: 'failed', detail: moved.detail || 'git worktree move failed' };
  // Keep the GC registration (metadata.json) beside the worktree it describes.
  const oldRoot = dirname(workspace.path);
  try {
    const previous = JSON.parse(await readFile(join(oldRoot, 'metadata.json'), 'utf8')) as SupervisionWorktreeMetadata;
    await writeFile(join(dirname(target), 'metadata.json'), JSON.stringify({ ...previous, sessionName: pair.executor, repoPath: target }));
  } catch {
    const metadata: SupervisionWorktreeMetadata = {
      taskId: pair.taskId, assignmentId, sessionName: pair.executor, baseRevision: workspace.base ?? '', repoPath: target, createdAt: new Date().toISOString(),
    };
    await writeFile(join(dirname(target), 'metadata.json'), JSON.stringify(metadata)).catch(() => undefined);
  }
  await rm(join(oldRoot, 'metadata.json'), { force: true }).catch(() => undefined);
  await rmdir(oldRoot).catch(() => undefined); // only when empty: never deletes leftovers
  const branch = await gitBranch(target);
  return { action: 'moved', from: workspace.path, to: target, ...(branch ? { branch } : {}) };
}

/**
 * Other worktrees for this task under any executor's session directory
 * (`<root>/<namespace>/<session>/pair_<task>/repo`) besides the pair's own.
 * A previous executor's rebuild or an executor's private copy shows up here;
 * the daemon names them in the brief and registers them, it never uses or
 * deletes them. Reads one directory listing, so it is called on executor
 * changes only, not per heartbeat.
 */
export async function listTaskPairSiblingWorktrees(
  pair: TaskPairState,
  deps: TaskPairWorkspaceDeps = testDeps ?? {},
): Promise<string[]> {
  const assignmentId = taskPairWorktreeName(pair.taskId);
  const env = deps.env ?? process.env;
  const namespaceDir = join(resolveSupervisionWorktreesRoot(env), env.IMCODES_PROJECT_WORKTREE_NAMESPACE?.trim() || 'imcodes');
  const own = pair.workspace?.path ? resolve(pair.workspace.path) : undefined;
  const sessions = await readdir(namespaceDir).catch(() => [] as string[]);
  const found: string[] = [];
  for (const sessionName of sessions) {
    const candidate = join(namespaceDir, sessionName, assignmentId, 'repo');
    if (own && resolve(candidate) === own) continue;
    if (await lstat(candidate).catch(() => undefined)) found.push(candidate);
  }
  return found.sort();
}
