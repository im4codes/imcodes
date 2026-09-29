/**
 * Disk hygiene for pair worktrees.
 *
 * A finished pair's worktree keeps its commits and any unsaved work for as long
 * as the workspace sweep decides (up to seven days, indefinitely when it holds
 * unintegrated commits), but its rebuildable weight -- node_modules above all,
 * 1-2.4 GB per pair -- has no reason to outlive the pair. This module removes
 * exactly that weight and nothing else:
 *
 *  - only paths git itself reports as ignored (`ls-files --others --ignored`),
 *    never tracked files and never untracked source;
 *  - only directories whose name is in TASK_PAIR_HEAVY_DIR_NAMES;
 *  - a path holding any tracked file (a force-added file under an ignored
 *    directory) is left alone;
 *  - a symlink is unlinked, never followed (the shared-testdeps pattern);
 *  - deletion runs out of process (`rm -rf`) or on libuv's thread pool, one
 *    directory at a time, so the daemon's main thread never walks the tree.
 *
 * It also reads free space on the worktree volume and classifies it, so the
 * scheduler can reclaim closed pairs oldest-first before the volume fills.
 */
import { execFile } from 'node:child_process';
import { lstat, realpath, rm, statfs, unlink } from 'node:fs/promises';
import path, { dirname, isAbsolute, sep } from 'node:path';
import {
  TASK_PAIR_DISK_CRITICAL_FREE_BYTES,
  TASK_PAIR_DISK_CRITICAL_FREE_FRACTION,
  TASK_PAIR_DISK_LEVELS,
  TASK_PAIR_DISK_LOW_FREE_BYTES,
  TASK_PAIR_DISK_LOW_FREE_FRACTION,
  TASK_PAIR_DISK_RECOVERY_FACTOR,
  TASK_PAIR_HEAVY_DIR_NAMES,
  type TaskPairDiskLevel,
} from '../../../shared/task-pair.js';

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const PATHSPEC_BATCH = 100;
/** A 2 GB node_modules tree removes in seconds; this only bounds a wedged filesystem. */
const REMOVE_TIMEOUT_MS = 10 * 60_000;
const HEAVY = new Set<string>(TASK_PAIR_HEAVY_DIR_NAMES);

function git(repoPath: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    execFile('git', ['--literal-pathspecs', '-C', repoPath, ...args], {
      timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true,
    }, (error, stdout) => resolvePromise(error ? undefined : String(stdout ?? '')));
  });
}

/** Ignored, untracked entries git lists for the worktree (fully ignored directories collapsed to `dir/`). */
export async function listIgnoredEntries(repoPath: string): Promise<string[] | undefined> {
  const out = await git(repoPath, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']);
  return out === undefined ? undefined : out.split('\0').filter(Boolean);
}

/** Which of the given repo-relative paths contain a tracked file. */
export async function trackedUnder(repoPath: string, paths: readonly string[]): Promise<Set<string> | undefined> {
  const holders = new Set<string>();
  for (let i = 0; i < paths.length; i += PATHSPEC_BATCH) {
    const batch = paths.slice(i, i + PATHSPEC_BATCH);
    const out = await git(repoPath, ['ls-files', '-z', '--', ...batch]);
    if (out === undefined) return undefined;
    for (const file of out.split('\0').filter(Boolean)) {
      for (const candidate of batch) if (file === candidate || file.startsWith(`${candidate}/`)) holders.add(candidate);
    }
  }
  return holders;
}

/** Repo-relative, slash-separated paths of the heavy ignored directories (or symlinks) in a worktree. */
export async function listStrippablePaths(
  repoPath: string,
  deps: { listIgnored?: typeof listIgnoredEntries; tracked?: typeof trackedUnder } = {},
): Promise<string[] | undefined> {
  const ignored = await (deps.listIgnored ?? listIgnoredEntries)(repoPath);
  if (!ignored) return undefined;
  const candidates = ignored
    .map((entry) => entry.replace(/\/+$/, ''))
    .filter((entry) => {
      if (!entry || isAbsolute(entry) || entry.split('/').includes('..')) return false;
      return HEAVY.has(entry.split('/').at(-1)!);
    });
  if (candidates.length === 0) return [];
  const holders = await (deps.tracked ?? trackedUnder)(repoPath, candidates);
  // Fail closed: if git cannot say whether a candidate holds tracked files, remove nothing.
  if (!holders) return undefined;
  return candidates.filter((entry) => !holders.has(entry));
}

function execRemove(path: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    execFile('rm', ['-rf', '--', path], { timeout: REMOVE_TIMEOUT_MS }, (error) => resolvePromise(!error));
  });
}

/**
 * Remove one directory tree without touching the main thread: `rm -rf` in a
 * child process where it exists, libuv's thread pool otherwise (Windows).
 * Never follows a symlink; a symlink is only unlinked.
 */
export async function removeTree(absolutePath: string): Promise<void> {
  const info = await lstat(absolutePath).catch(() => undefined);
  if (!info) return;
  if (info.isSymbolicLink() || info.isFile()) {
    await unlink(absolutePath);
    return;
  }
  if (!info.isDirectory()) return;
  if (process.platform !== 'win32' && await execRemove(absolutePath)) return;
  await rm(absolutePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

export interface StripDeps {
  listIgnored?: typeof listIgnoredEntries;
  tracked?: typeof trackedUnder;
  remove?: (absolutePath: string) => Promise<void>;
  /** Asked before every removal: false stops the strip (the pair was reopened or changed). */
  stillEligible?: () => boolean;
  /** Absolute paths that must survive, and everything above or below them (a deliverable not yet copied). */
  keepPaths?: readonly string[];
}

export interface StripResult {
  ok: boolean;
  /** Repo-relative paths removed. */
  removed: string[];
  /** Candidates left alone, with why. */
  skipped: Array<{ path: string; reason: 'kept_path' | 'outside_worktree' | 'symlinked_parent' | 'missing' | 'error' }>;
  /** The pair changed mid-strip; nothing further was removed. */
  aborted: boolean;
}

/**
 * Absolute path of a git-reported, slash-separated relative path inside the
 * worktree, or undefined when it would escape it. `pathApi` lets the Windows
 * spelling be tested on any host.
 */
export function toAbsoluteCandidate(repoPath: string, rel: string, pathApi: typeof path.posix = path): string | undefined {
  const segments = rel.split('/');
  if (!rel || pathApi.isAbsolute(rel) || segments.some((segment) => segment === '' || segment === '..')) return undefined;
  const absolute = pathApi.join(repoPath, ...segments);
  const inside = pathApi.relative(repoPath, absolute);
  return inside.startsWith('..') || pathApi.isAbsolute(inside) ? undefined : absolute;
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
}

/** Strip a worktree's rebuildable ignored directories. Commits, tracked files and uncommitted work are never touched. */
export async function stripHeavyIgnoredDirs(repoPath: string, deps: StripDeps = {}): Promise<StripResult> {
  const result: StripResult = { ok: false, removed: [], skipped: [], aborted: false };
  const candidates = await listStrippablePaths(repoPath, { listIgnored: deps.listIgnored, tracked: deps.tracked });
  if (!candidates) return result;
  result.ok = true;
  const root = await realpath(repoPath).catch(() => undefined);
  if (!root) return result;
  for (const rel of candidates) {
    if (deps.stillEligible && !deps.stillEligible()) { result.aborted = true; return result; }
    const absolute = toAbsoluteCandidate(repoPath, rel);
    if (!absolute) { result.skipped.push({ path: rel, reason: 'outside_worktree' }); continue; }
    if ((deps.keepPaths ?? []).some((keep) => overlaps(absolute, keep))) { result.skipped.push({ path: rel, reason: 'kept_path' }); continue; }
    // The parent chain must resolve inside the worktree: a symlinked parent
    // would make this delete somewhere else.
    const parent = await realpath(dirname(absolute)).catch(() => undefined);
    if (!parent || (parent !== root && !parent.startsWith(`${root}${sep}`))) { result.skipped.push({ path: rel, reason: 'symlinked_parent' }); continue; }
    if (!(await lstat(absolute).catch(() => undefined))) { result.skipped.push({ path: rel, reason: 'missing' }); continue; }
    try {
      await (deps.remove ?? removeTree)(absolute);
      result.removed.push(rel);
    } catch {
      result.skipped.push({ path: rel, reason: 'error' });
    }
    // One directory at a time, with the loop yielded between them.
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  }
  return result;
}

// ── free space ──────────────────────────────────────────────────────────────

export interface DiskReading {
  freeBytes: number;
  totalBytes: number;
}

/** Free space on the volume holding `path` (the nearest existing ancestor when it does not exist yet). */
export async function readVolumeSpace(path: string): Promise<DiskReading | undefined> {
  let probe = path;
  for (let depth = 0; depth < 32; depth += 1) {
    try {
      const stats = await statfs(probe);
      const totalBytes = Number(stats.blocks) * Number(stats.bsize);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      return Number.isFinite(totalBytes) && Number.isFinite(freeBytes) && totalBytes > 0 ? { freeBytes, totalBytes } : undefined;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return undefined;
      probe = parent;
    }
  }
  return undefined;
}

function classify(reading: DiskReading, factor: number): TaskPairDiskLevel {
  const fraction = reading.freeBytes / reading.totalBytes;
  if (reading.freeBytes < TASK_PAIR_DISK_CRITICAL_FREE_BYTES * factor
    || fraction < TASK_PAIR_DISK_CRITICAL_FREE_FRACTION * factor) return 'critical';
  if (reading.freeBytes < TASK_PAIR_DISK_LOW_FREE_BYTES * factor
    || fraction < TASK_PAIR_DISK_LOW_FREE_FRACTION * factor) return 'low';
  return 'ok';
}

export function diskLevelRank(level: TaskPairDiskLevel): number {
  return TASK_PAIR_DISK_LEVELS.indexOf(level);
}

export function isDiskLevel(value: unknown): value is TaskPairDiskLevel {
  return typeof value === 'string' && (TASK_PAIR_DISK_LEVELS as readonly string[]).includes(value);
}

/**
 * The level for a reading, given the last announced one. Getting worse is
 * immediate; getting better needs free space RECOVERY_FACTOR times above the
 * threshold, so a volume hovering at a boundary does not announce over and over.
 */
export function classifyDiskLevel(reading: DiskReading, previous: TaskPairDiskLevel = 'ok'): TaskPairDiskLevel {
  const raw = classify(reading, 1);
  if (diskLevelRank(previous) <= diskLevelRank(raw)) return raw;
  const relaxed = classify(reading, TASK_PAIR_DISK_RECOVERY_FACTOR);
  return diskLevelRank(relaxed) < diskLevelRank(previous) ? relaxed : previous;
}

// ── test seam ───────────────────────────────────────────────────────────────

export interface TaskPairHygieneDeps extends StripDeps {
  /** Free-space reader for the worktree volume. */
  readSpace?: (path: string) => Promise<DiskReading | undefined>;
  /** Overrides the worktrees root the reader is pointed at. */
  worktreesRoot?: string;
}

let testDeps: TaskPairHygieneDeps | undefined;

export function setTaskPairHygieneDepsForTests(deps: TaskPairHygieneDeps | undefined): void {
  testDeps = deps;
}

export function taskPairHygieneDeps(): TaskPairHygieneDeps {
  return testDeps ?? {};
}

/**
 * Free space for the worktree volume. Under Vitest the real machine's free
 * space is never consulted unless a test injects a reader: a nearly full dev
 * or CI disk must not make unrelated workspace tests reclaim and notify.
 */
export async function readWorktreeVolumeSpace(root: string, deps: TaskPairHygieneDeps = taskPairHygieneDeps()): Promise<DiskReading | undefined> {
  if (deps.readSpace) return deps.readSpace(root);
  if (process.env.VITEST) return undefined;
  return readVolumeSpace(root);
}
