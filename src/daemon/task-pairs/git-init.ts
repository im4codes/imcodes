/**
 * A non-git project gets a git repository, in place (owner 2026-09-30: "设备有安装git的 你可以创建git项目的"), and the normal git
 * worktree flow then runs unchanged. What makes that acceptable for a directory that was never a repo:
 *  - the repo is LOCAL only: a repo-local identity (the global config is never touched), no remote, never a push;
 *  - heavy directories and every file over a threshold stay untracked, listed in a marked block of the project's .gitignore
 *    (an existing .gitignore is kept and extended; the block is replaced, never duplicated);
 *  - a size cap on what would be tracked: over it nothing is committed and every change the init made is rolled back;
 *  - line endings are never converted (core.autocrlf=false locally) and the baseline commit skips hooks;
 *  - exactly once per project, even when two pairs start at the same moment (an in-process lock per project), and an
 *    init that a crash left half-made is detected by its marker and rolled back before starting over.
 * At DONE {@link mergePairIntoProject} brings the pair's commits into the project: it refuses to touch any file the user has
 * uncommitted edits in, and never overwrites.
 */
import { execFile } from 'node:child_process';
import { lstat, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import {
  TASK_PAIR_CLONE_EXCLUDE_DIR_NAMES,
  TASK_PAIR_GITIGNORE_BLOCK_END,
  TASK_PAIR_GITIGNORE_BLOCK_START,
  TASK_PAIR_GIT_INIT_ENABLE_ENV,
  TASK_PAIR_GIT_INIT_LARGE_FILE_BYTES,
  TASK_PAIR_GIT_INIT_LARGE_FILE_BYTES_ENV,
  TASK_PAIR_GIT_INIT_MAX_TRACKED_BYTES,
  TASK_PAIR_GIT_INIT_MAX_TRACKED_BYTES_ENV,
} from '../../../shared/task-pair.js';

const GIT_TIMEOUT_MS = 10 * 60_000;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const MARKER_NAME = 'imcodes-init.json';
/** The baseline branch when git would otherwise pick a name from the user's global config. */
const BASELINE_BRANCH = 'main';

interface GitResult { ok: boolean; stdout: string; stderr: string; missing: boolean }

function git(cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    execFile('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true, ...(env ? { env } : {}) }, (error, stdout, stderr) => {
      resolvePromise({
        ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
        missing: (error as NodeJS.ErrnoException | null)?.code === 'ENOENT',
      });
    });
  });
}

const numberFromEnv = (name: string, fallback: number, env: NodeJS.ProcessEnv): number => {
  const parsed = Number(env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const gitInitEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env[TASK_PAIR_GIT_INIT_ENABLE_ENV]?.trim().toLowerCase() !== 'off';

export async function isInsideGitWorkTree(dir: string): Promise<boolean> {
  const result = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  return result.ok && result.stdout.trim() === 'true';
}

// ── marker ──────────────────────────────────────────────────────────────────

interface InitMarker {
  state: 'initializing' | 'ready';
  startedAt: number;
  taskId: string;
  /** The project's .gitignore before the init (undefined: there was none), so a rollback restores it exactly. */
  gitignore: { existed: boolean; original?: string };
  stats?: { trackedFiles: number; trackedBytes: number; ignoredLargeFiles: number; ignoredHeavyDirs: string[] };
  /** The project branch head after the last commit IM.codes itself made (baseline, snapshot, merge): a different head means the user committed. */
  ownHead?: string;
}

const markerPath = (root: string): string => join(root, '.git', MARKER_NAME);

async function readMarker(root: string): Promise<InitMarker | undefined> {
  try { return JSON.parse(await readFile(markerPath(root), 'utf8')) as InitMarker; } catch { return undefined; }
}

/** Remember the head IM.codes itself left the project branch at (best effort). */
async function recordOwnHead(root: string): Promise<void> {
  const marker = await readMarker(root);
  const head = await git(root, ['rev-parse', '--verify', 'HEAD']);
  if (!marker || !head.ok) return;
  await writeFile(markerPath(root), JSON.stringify({ ...marker, ownHead: head.stdout.trim() })).catch(() => undefined);
}

/** The project's repo was created by IM.codes (and completed). */
export async function isImcodesInitRepo(root: string): Promise<boolean> {
  return (await readMarker(root))?.state === 'ready';
}

// ── .gitignore block ────────────────────────────────────────────────────────

/** A path as a literal .gitignore pattern (glob characters and a leading `#`/`!`/space escaped). */
function escapePattern(path: string): string {
  return path.replace(/([\\*?[\]])/g, '\\$1').replace(/^([#! ])/, '\\$1');
}

export function buildGitignoreBlock(heavyDirs: readonly string[], largeFiles: readonly string[], thresholdBytes: number): string {
  return [
    TASK_PAIR_GITIGNORE_BLOCK_START,
    '# Rebuildable directories and files over ' + `${Math.round(thresholdBytes / 1024 / 1024)} MiB are not tracked by the local repository IM.codes created for its task pairs.`,
    ...heavyDirs.map((name) => `${name}/`),
    ...(largeFiles.length > 0 ? ['# Large files (listed explicitly):', ...largeFiles.map((path) => `/${escapePattern(path)}`)] : []),
    TASK_PAIR_GITIGNORE_BLOCK_END,
  ].join('\n');
}

/** `existing` with the IM.codes block replaced (or appended); everything else untouched byte for byte. */
export function withGitignoreBlock(existing: string | undefined, block: string): string {
  if (existing === undefined || existing === '') return `${block}\n`;
  const start = existing.indexOf(TASK_PAIR_GITIGNORE_BLOCK_START);
  const end = start >= 0 ? existing.indexOf(TASK_PAIR_GITIGNORE_BLOCK_END, start) : -1;
  if (start >= 0 && end >= 0) {
    return `${existing.slice(0, start)}${block}${existing.slice(end + TASK_PAIR_GITIGNORE_BLOCK_END.length)}`;
  }
  const lineEnd = existing.includes('\r\n') ? '\r\n' : '\n';
  return `${existing}${existing.endsWith('\n') ? '' : lineEnd}${block.split('\n').join(lineEnd)}${lineEnd}`;
}

// ── which directories may become a repo at all ─────────────────────────────

export interface RootRefusal { reason: 'container_root'; detail: string }

async function realOrSelf(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

/**
 * A directory that must never be turned into a repo, cloned or edited in place on behalf of one pair: it is not "a project" but a
 * CONTAINER of other things. Refused: a filesystem/volume root, the user's home directory or any ancestor of it (a home holds every
 * other project and TCC-protected folders), and any directory that strictly contains another registered session's project directory
 * (initialising it would make every project below it read as "inside a git work tree", and their pairs would work in a worktree of
 * the whole container whose work never lands in the project). A refused root falls back to a plain task directory.
 */
export async function nonGitRootRefusal(
  projectRoot: string,
  options: { home?: string; otherProjectDirs?: readonly string[] } = {},
): Promise<RootRefusal | undefined> {
  const root = await realOrSelf(projectRoot);
  if (dirname(root) === root || /^[A-Za-z]:[\\/]?$/.test(root)) return { reason: 'container_root', detail: `${root} is a filesystem root` };
  const home = await realOrSelf(options.home ?? homedir());
  if (root === home) return { reason: 'container_root', detail: `${root} is the home directory` };
  if (home.startsWith(root.endsWith(sep) ? root : root + sep)) return { reason: 'container_root', detail: `${root} contains the home directory` };
  for (const other of options.otherProjectDirs ?? []) {
    const dir = await realOrSelf(other);
    if (dir !== root && dir.startsWith(root.endsWith(sep) ? root : root + sep)) return { reason: 'container_root', detail: `${root} contains another project (${dir})` };
  }
  return undefined;
}

// ── the init ────────────────────────────────────────────────────────────────

export type GitInitResult =
  | {
    ok: true;
    /** This call made the repository (false: an earlier pair did). */
    created: boolean;
    trackedFiles: number;
    trackedBytes: number;
    ignoredLargeFiles: number;
    ignoredHeavyDirs: string[];
    ms: number;
    /** A later pair's start found the user's current files uncommitted and committed them as "imcodes: snapshot before pair". */
    snapshot?: { committed: boolean; files: number; skipped?: 'over_cap' | 'not_ours' | 'failed' };
  }
  | { ok: false; reason: 'disabled' | 'git_unavailable' | 'inside_git' | 'over_cap' | 'foreign_git_dir' | 'nested_repo' | 'init_failed'; detail: string };

const locks = new Map<string, Promise<unknown>>();

/** Serialize work per project directory (two pairs starting at once must init exactly once). */
function withProjectLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  locks.set(key, next);
  void next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => undefined);
  return next;
}

async function rollbackInit(root: string, marker: InitMarker | undefined): Promise<void> {
  // Only what this init created: the .git it made and the .gitignore as it was.
  await rm(join(root, '.git'), { recursive: true, force: true }).catch(() => undefined);
  const path = join(root, '.gitignore');
  if (marker?.gitignore.existed) await writeFile(path, marker.gitignore.original ?? '').catch(() => undefined);
  else await rm(path, { force: true }).catch(() => undefined);
}

/**
 * Make `projectRoot` a local git repository with a baseline commit, or say why not. Idempotent: an already-initialised
 * project (ours) returns `created: false`. Never called for a directory inside a git work tree.
 */
export function initProjectRepo(
  projectRoot: string,
  options: { taskId: string; env?: NodeJS.ProcessEnv; now?: () => number },
): Promise<GitInitResult> {
  const root = resolve(projectRoot);
  return withProjectLock(root, () => doInit(root, options));
}

async function doInit(root: string, options: { taskId: string; env?: NodeJS.ProcessEnv; now?: () => number }): Promise<GitInitResult> {
  const env = options.env ?? process.env;
  const clock = options.now ?? Date.now;
  const started = clock();
  if (!gitInitEnabled(env)) return { ok: false, reason: 'disabled', detail: `${TASK_PAIR_GIT_INIT_ENABLE_ENV}=off` };
  const version = await git(root, ['--version']);
  if (!version.ok) return { ok: false, reason: 'git_unavailable', detail: version.missing ? 'git is not installed' : version.stderr.trim().slice(0, 200) };
  const largeBytes = numberFromEnv(TASK_PAIR_GIT_INIT_LARGE_FILE_BYTES_ENV, TASK_PAIR_GIT_INIT_LARGE_FILE_BYTES, env);
  const maxTracked = numberFromEnv(TASK_PAIR_GIT_INIT_MAX_TRACKED_BYTES_ENV, TASK_PAIR_GIT_INIT_MAX_TRACKED_BYTES, env);

  let existingMarker = await readMarker(root);
  // A crash left a half-made repo of ours (the marker says it never finished): roll it back first, then start over.
  if (existingMarker?.state === 'initializing' && (await lstat(join(root, '.git')).catch(() => undefined))?.isDirectory()) {
    await rollbackInit(root, existingMarker);
    existingMarker = undefined;
  }
  if (await isInsideGitWorkTree(root)) {
    if (existingMarker?.state === 'ready' && (await lstat(join(root, '.git')).catch(() => undefined))?.isDirectory()) {
      const stats = existingMarker.stats;
      // The owner does not use git, so files edited since the baseline are still uncommitted: the next pair's worktree is cut
      // from HEAD and would start from OUTDATED content (and its merge would then be refused forever). Commit the current state.
      const snapshot = await commitCurrentState(root, options.taskId, largeBytes, maxTracked);
      return { ok: true, created: false, trackedFiles: stats?.trackedFiles ?? 0, trackedBytes: stats?.trackedBytes ?? 0, ignoredLargeFiles: stats?.ignoredLargeFiles ?? 0, ignoredHeavyDirs: stats?.ignoredHeavyDirs ?? [], ms: 0, snapshot };
    }
    return { ok: false, reason: 'inside_git', detail: 'the project is inside a git work tree that IM.codes did not create' };
  }
  const gitEntry = await lstat(join(root, '.git')).catch(() => undefined);
  if (gitEntry) {
    // A .git that is not a usable work tree and not ours: left alone.
    return { ok: false, reason: 'foreign_git_dir', detail: 'a .git exists here that IM.codes did not create and is not a usable work tree' };
  }

  const gitignorePath = join(root, '.gitignore');
  const original = await readFile(gitignorePath, 'utf8').catch(() => undefined);
  const marker: InitMarker = { state: 'initializing', startedAt: clock(), taskId: options.taskId, gitignore: { existed: original !== undefined, ...(original !== undefined ? { original } : {}) } };
  try {
    // Only the in-process lock serialises two inits of one project (`git init` on an existing .git re-initialises it and succeeds);
    // two daemons on one project directory are not a supported setup.
    const init = await git(root, ['init', '-q']);
    if (!init.ok) throw new Error(`git init failed: ${init.stderr.trim().slice(0, 200)}`);
    await git(root, ['symbolic-ref', 'HEAD', `refs/heads/${BASELINE_BRANCH}`]);
    await writeFile(markerPath(root), JSON.stringify(marker));
    for (const [key, value] of [
      ['user.name', 'IM.codes'], ['user.email', 'imcodes@localhost.invalid'], ['commit.gpgsign', 'false'],
      ['core.autocrlf', 'false'], ['core.safecrlf', 'false'], ['core.longpaths', 'true'], ['core.quotepath', 'false'],
    ] as const) await git(root, ['config', '--local', key, value]);

    // 1. ignore the heavy directories, 2. see what would be tracked, 3. add the over-threshold files to the ignore list, 4. commit.
    const heavy = [...TASK_PAIR_CLONE_EXCLUDE_DIR_NAMES];
    await writeFile(gitignorePath, withGitignoreBlock(original, buildGitignoreBlock(heavy, [], largeBytes)));
    const listed = await git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
    if (!listed.ok) throw new Error(`listing the project files failed: ${listed.stderr.trim().slice(0, 200)}`);
    const large: string[] = [];
    const nested: string[] = [];
    let trackedFiles = 0;
    let trackedBytes = 0;
    for (const rel of listed.stdout.split('\0').filter(Boolean)) {
      // git lists an embedded repository as "dir/": the sure sign that this directory holds other projects.
      if (rel.endsWith('/')) { nested.push(rel); continue; }
      const info = await lstat(join(root, ...rel.split('/'))).catch(() => undefined);
      if (!info || info.isDirectory()) continue;
      if (info.isFile() && info.size > largeBytes) { large.push(rel); continue; }
      trackedFiles += 1;
      trackedBytes += info.isFile() ? info.size : 0;
    }
    if (nested.length > 0) {
      await rollbackInit(root, marker);
      return { ok: false, reason: 'nested_repo', detail: `${root} contains other git repositories (${nested.slice(0, 3).join(', ')}): it is a container, not a project` };
    }
    if (trackedBytes > maxTracked) {
      await rollbackInit(root, marker);
      return { ok: false, reason: 'over_cap', detail: `${Math.round(trackedBytes / 1024 / 1024)} MiB would be tracked, over the ${Math.round(maxTracked / 1024 / 1024)} MiB cap` };
    }
    if (large.length > 0) await writeFile(gitignorePath, withGitignoreBlock(original, buildGitignoreBlock(heavy, large, largeBytes)));
    const add = await git(root, ['add', '-A']);
    if (!add.ok) throw new Error(`git add failed: ${add.stderr.trim().slice(0, 200)}`);
    const commit = await git(root, ['commit', '-q', '--allow-empty', '--no-verify', '-m', `imcodes: baseline before pair ${options.taskId}`]);
    if (!commit.ok) throw new Error(`git commit failed: ${commit.stderr.trim().slice(0, 200)}`);
    const stats = { trackedFiles, trackedBytes, ignoredLargeFiles: large.length, ignoredHeavyDirs: heavy };
    const baselineHead = (await git(root, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
    await writeFile(markerPath(root), JSON.stringify({ ...marker, state: 'ready', stats, ownHead: baselineHead } satisfies InitMarker));
    return { ok: true, created: true, ...stats, ms: clock() - started };
  } catch (error) {
    await rollbackInit(root, marker);
    return { ok: false, reason: 'init_failed', detail: (error as Error).message };
  }
}

/**
 * A later pair is starting on a repo IM.codes made: if the working tree has uncommitted changes and every commit so far is
 * IM.codes' own (the owner is not using git in it), commit them as "imcodes: snapshot before pair <id>" so the pair's worktree
 * starts from what is on disk. Skipped, and said so, when the user has committed themselves (their history is theirs), when the
 * changes are over the size cap, or when anything fails. New files over the size threshold are added to the ignore block first.
 */
async function commitCurrentState(root: string, taskId: string, largeBytes: number, maxTracked: number): Promise<{ committed: boolean; files: number; skipped?: 'over_cap' | 'not_ours' | 'failed' }> {
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!status.ok) return { committed: false, files: 0, skipped: 'failed' };
  const entries = status.stdout.split('\0').filter(Boolean);
  if (entries.length === 0) return { committed: false, files: 0 };
  // Only while the branch head is still where IM.codes left it: a head somebody else moved means the user uses git here.
  const marker = await readMarker(root);
  const head = await git(root, ['rev-parse', '--verify', 'HEAD']);
  if (!marker?.ownHead || !head.ok || head.stdout.trim() !== marker.ownHead) return { committed: false, files: entries.length, skipped: 'not_ours' };
  const large: string[] = [];
  let bytes = 0;
  for (const entry of entries) {
    const path = entry.slice(3);
    if (entry.startsWith('??') && path.endsWith('/')) return { committed: false, files: entries.length, skipped: 'failed' }; // a nested repo appeared
    const info = await lstat(join(root, ...path.split('/'))).catch(() => undefined);
    if (!info || info.isDirectory()) continue;
    if (entry.startsWith('??') && info.isFile() && info.size > largeBytes) { large.push(path); continue; }
    bytes += info.isFile() ? info.size : 0;
  }
  if (bytes > maxTracked) return { committed: false, files: entries.length, skipped: 'over_cap' };
  if (large.length > 0) {
    const gitignorePath = join(root, '.gitignore');
    const current = await readFile(gitignorePath, 'utf8').catch(() => '');
    const lineEnd = current.includes('\r\n') ? '\r\n' : '\n';
    const extra = large.map((path) => `/${escapePattern(path)}`).join(lineEnd);
    const end = current.indexOf(TASK_PAIR_GITIGNORE_BLOCK_END);
    await writeFile(gitignorePath, end >= 0 ? `${current.slice(0, end)}${extra}${lineEnd}${current.slice(end)}` : `${current}${current && !current.endsWith('\n') ? lineEnd : ''}${extra}${lineEnd}`);
  }
  const add = await git(root, ['add', '-A']);
  if (!add.ok) return { committed: false, files: entries.length, skipped: 'failed' };
  const commit = await git(root, ['commit', '-q', '--allow-empty', '--no-verify', '-m', `imcodes: snapshot before pair ${taskId}`]);
  if (!commit.ok) return { committed: false, files: entries.length, skipped: 'failed' };
  await recordOwnHead(root);
  return { committed: true, files: entries.length };
}

// ── DONE: bring the pair's work into the project ────────────────────────────

export type MergeResult =
  | { status: 'noop'; detail: string }
  | { status: 'merged'; head: string; fastForward: boolean; files: string[] }
  /** The user has uncommitted edits in files the pair changed (or staged changes): nothing was touched. */
  | { status: 'refused_uncommitted'; files: string[]; detail: string }
  /** The commits themselves conflict with what the project's branch holds: aborted, nothing changed. */
  | { status: 'conflict'; files: string[]; detail: string }
  | { status: 'failed'; detail: string };

/** Paths with any uncommitted state in the project (modified, staged, untracked), and whether anything is staged. */
async function dirtyPaths(root: string): Promise<{ paths: Set<string>; staged: string[] } | undefined> {
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!status.ok) return undefined;
  const entries = status.stdout.split('\0').filter(Boolean);
  const paths = new Set<string>();
  const staged: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    const x = entry[0]!;
    const y = entry[1]!;
    const path = entry.slice(3);
    paths.add(path);
    if (x !== ' ' && x !== '?' && x !== '!') staged.push(path);
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') { const origin = entries[i + 1]; if (origin) { paths.add(origin); i += 1; } }
  }
  return { paths, staged };
}

/**
 * Merge the pair's head into the project's current branch, in the project directory. Refuses (touching nothing) when the user
 * has uncommitted edits in any file the pair changed, or anything staged; a fast-forward when possible, otherwise a merge
 * commit; a merge that conflicts is aborted. Serialized per project.
 */
export function mergePairIntoProject(projectRoot: string, worktreePath: string, taskId: string): Promise<MergeResult> {
  const root = resolve(projectRoot);
  return withProjectLock(`merge:${root}`, () => doMerge(root, worktreePath, taskId));
}

async function doMerge(root: string, worktreePath: string, taskId: string): Promise<MergeResult> {
  const headResult = await git(worktreePath, ['rev-parse', '--verify', 'HEAD']);
  if (!headResult.ok) return { status: 'failed', detail: 'the pair worktree has no readable HEAD' };
  const head = headResult.stdout.trim();
  const branch = await git(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
  if (!branch.ok || !branch.stdout.trim()) return { status: 'failed', detail: 'the project is on a detached HEAD: nothing to merge into' };
  // A merge left in progress (a crash, or the user's own): never touched from here.
  const mergeInProgress = await git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (mergeInProgress.ok) return { status: 'failed', detail: 'the project has a merge in progress: finish or abort it (git merge --abort), the daemon retries' };
  const contained = await git(root, ['merge-base', '--is-ancestor', head, 'HEAD']);
  if (contained.ok) return { status: 'noop', detail: 'the pair has no commits that the project does not already have' };
  const base = await git(root, ['merge-base', 'HEAD', head]);
  const changed = await git(root, ['diff', '--name-only', '-z', base.ok ? base.stdout.trim() : 'HEAD', head]);
  if (!changed.ok) return { status: 'failed', detail: `the pair's changes could not be listed: ${changed.stderr.trim().slice(0, 200)}` };
  const files = changed.stdout.split('\0').filter(Boolean);
  const dirty = await dirtyPaths(root);
  if (!dirty) return { status: 'failed', detail: 'the project status could not be read' };
  if (dirty.staged.length > 0) {
    return { status: 'refused_uncommitted', files: dirty.staged, detail: 'the project has staged changes: a merge commit would sweep them in' };
  }
  const overlap = files.filter((path) => dirty.paths.has(path) || [...dirty.paths].some((dirtyPath) => path.startsWith(`${dirtyPath}/`) || dirtyPath.startsWith(`${path}/`)));
  if (overlap.length > 0) return { status: 'refused_uncommitted', files: overlap, detail: 'the project has uncommitted edits in files the pair changed' };
  const fastForward = await git(root, ['merge', '--ff-only', '-q', head]);
  if (fastForward.ok) { await recordOwnHead(root); return { status: 'merged', head, fastForward: true, files }; }
  const merged = await git(root, ['merge', '--no-edit', '-q', '-m', `imcodes: merge pair ${taskId}`, head]);
  if (merged.ok) { await recordOwnHead(root); return { status: 'merged', head, fastForward: false, files }; }
  const conflicted = await git(root, ['diff', '--name-only', '--diff-filter=U', '-z']);
  await git(root, ['merge', '--abort']);
  return { status: 'conflict', files: conflicted.stdout.split('\0').filter(Boolean), detail: merged.stderr.trim().slice(0, 200) || 'the pair commits conflict with the project branch' };
}

