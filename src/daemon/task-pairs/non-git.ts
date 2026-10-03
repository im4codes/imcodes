/**
 * Pairs on a project that is NOT a git repository (owner 2026-09-30: "不是git就直接改", "支持cow的可以复制", "几十g的你也复制吧
 * 这个不太合适！"). Never a real full copy, never a private git (its objects would store every file again).
 *
 *  - COW mode: when the project can be cloned copy-on-write into the task directory (probe: one project file cloned with
 *    COPYFILE_FICLONE_FORCE; APFS clonefile, Btrfs/XFS reflink, same volume only), the pair works on the clone. A manifest
 *    (size + mtime of every file, project side and clone side) is written at clone time. The changed files are found by
 *    comparing the clone with that manifest, the auditor gets a per-file diff against the project original, and at DONE
 *    {@link applyBackCow} copies the changes back: all-or-nothing, refusing any file whose project copy changed since
 *    the base, with a backup of every file it overwrites or deletes and a journal that lets a restart roll back cleanly.
 *  - In-place mode: everything else. The project directory is the working location; nothing is cloned here.
 *
 * Symlinks are cloned as links and never followed. The project is only read until an apply-back.
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmod, constants as fsConstants, copyFile, lstat, lutimes, mkdir, readFile, readdir, readlink, rename, rm, rmdir, statfs, symlink, unlink, utimes, writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  TASK_PAIR_APPLY_BACK_DIR,
  TASK_PAIR_CLONE_EXCLUDE_DIR_NAMES,
  TASK_PAIR_COW_MANIFEST_DIR,
  TASK_PAIR_REVIEW_DIFF_MAX_BYTES,
} from '../../../shared/task-pair.js';

const EXCLUDED = new Set<string>(TASK_PAIR_CLONE_EXCLUDE_DIR_NAMES);
/** Entries of the task directory that belong to the daemon, never to the pair's work. */
const INTERNAL_TOP = new Set<string>([TASK_PAIR_COW_MANIFEST_DIR, TASK_PAIR_APPLY_BACK_DIR]);
const MANIFEST_NAME = 'manifest.json';
const JOURNAL_NAME = 'journal.json';
const REVIEW_FILE = 'review.diff';
const MANIFEST_VERSION = 1;
const JOURNAL_VERSION = 2;
/** File times of a cloned file and its source can differ by filesystem rounding: within this they are "unchanged". */
const MTIME_TOLERANCE_MS = 2;
/** More files than this and the project is not cloned (in-place instead): the walk itself would be the cost. */
export const COW_CLONE_MAX_FILES = 400_000;
const REVIEW_FILE_MAX_BYTES = 8 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8000;

const sameMtime = (a: number, b: number): boolean => Math.abs(a - b) <= MTIME_TOLERANCE_MS;
const isInside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};
const parts = (rel: string): string[] => rel.split('/');

// ── manifest ────────────────────────────────────────────────────────────────

export interface CowManifestEntry {
  kind: 'file' | 'link';
  /** Project side at clone time: the identity the project file must still have at apply-back. */
  size: number;
  mtimeMs: number;
  mode: number;
  /** Symlink target (links only). */
  target?: string;
  /** Clone side right after cloning: a later difference means the pair touched the file. */
  cloneSize?: number;
  cloneMtimeMs?: number;
  cloneMode?: number;
}

export interface CowManifest {
  version: number;
  projectRoot: string;
  createdAt: number;
  entries: Record<string, CowManifestEntry>;
}

const manifestPath = (taskDir: string): string => join(taskDir, TASK_PAIR_COW_MANIFEST_DIR, MANIFEST_NAME);

export async function readCowManifest(taskDir: string): Promise<CowManifest | undefined> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath(taskDir), 'utf8')) as CowManifest;
    return parsed?.version === MANIFEST_VERSION ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeAtomic(target: string, content: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, target);
}

// ── copy-on-write probe and clone ───────────────────────────────────────────

/** One file cloned by the filesystem (no data read or written); fails where the volume or filesystem cannot. */
export type CloneFile = (from: string, to: string) => Promise<void>;

/**
 * How this platform clones. Node's COPYFILE_FICLONE_FORCE only works on Linux (macOS answers ENOSYS), so macOS uses
 * `cp -c` (clonefile(2)), which also clones a whole directory tree in one call: the optional bulk operations let a
 * directory without excluded content be cloned as one unit instead of file by file.
 */
export interface CloneEngine {
  name: string;
  cloneFile: CloneFile;
  /** Clone a whole directory (recursively, links as links) to a path that does not exist yet. */
  cloneTree?: (from: string, to: string) => Promise<void>;
  /** Clone several files into an existing directory keeping their names. */
  cloneFilesInto?: (files: readonly string[], destDir: string) => Promise<void>;
}

function runCp(args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile('cp', [...args], { timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (!error) return resolvePromise();
      const text = String(stderr ?? '');
      const code = /cross-device|Invalid cross-device/i.test(text) ? 'EXDEV' : /not supported|Operation not supported/i.test(text) ? 'ENOTSUP' : (error as NodeJS.ErrnoException).code ?? 'ECP';
      reject(Object.assign(new Error(text.trim() || String(error)), { code }));
    });
  });
}

const nodeCloneEngine: CloneEngine = {
  name: 'node-ficlone',
  cloneFile: (from, to) => copyFile(from, to, fsConstants.COPYFILE_FICLONE_FORCE),
};

const macCloneEngine: CloneEngine = {
  name: 'cp-c',
  cloneFile: (from, to) => runCp(['-c', '-P', '--', from, to]),
  cloneTree: (from, to) => runCp(['-c', '-R', '-P', '--', from, to]),
  cloneFilesInto: async (files, destDir) => {
    // Bounded argument lists: a directory with thousands of files is several calls, not thousands.
    for (let i = 0; i < files.length; i += 200) await runCp(['-c', '-P', '--', ...files.slice(i, i + 200), `${destDir}/`]);
  },
};

/** The clone primitive of this platform: macOS `cp -c`, Linux in-process FICLONE, none elsewhere (Windows -> in-place). */
export function defaultCloneEngine(): CloneEngine {
  if (process.platform === 'darwin') return macCloneEngine;
  if (process.platform === 'linux') return nodeCloneEngine;
  return { name: 'unsupported', cloneFile: async () => { throw Object.assign(new Error('no copy-on-write clone on this platform'), { code: 'ENOTSUP' }); } };
}

const asEngine = (value: CloneEngine | CloneFile | undefined): CloneEngine => (typeof value === 'function' ? { name: 'injected', cloneFile: value } : value ?? defaultCloneEngine());

async function findProbeFile(projectRoot: string): Promise<string | undefined> {
  const queue: string[] = [projectRoot];
  let seen = 0;
  while (queue.length > 0 && seen < 2_000) {
    const dir = queue.shift()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      seen += 1;
      const absolute = join(dir, entry.name);
      if (entry.isFile() && (await lstat(absolute).catch(() => undefined))?.size) return absolute;
      if (entry.isDirectory() && !EXCLUDED.has(entry.name) && entry.name !== '.git') queue.push(absolute);
    }
  }
  return undefined;
}

/**
 * Can a file of the project be cloned into `targetDir` (the same volume, on a filesystem with clones)? Reads one
 * project file as the clone source; writes only inside `targetDir`, and removes it again.
 */
export async function probeCopyOnWrite(projectRoot: string, targetDir: string, engineOrClone?: CloneEngine | CloneFile): Promise<{ supported: boolean; reason?: string }> {
  const engine = asEngine(engineOrClone);
  const source = await findProbeFile(projectRoot);
  if (!source) return { supported: false, reason: 'no_file_to_probe' };
  await mkdir(targetDir, { recursive: true });
  const probe = join(targetDir, `.imcodes-clone-probe-${randomBytes(3).toString('hex')}`);
  try {
    await engine.cloneFile(source, probe);
    return { supported: true };
  } catch (error) {
    return { supported: false, reason: `clone_unsupported:${(error as NodeJS.ErrnoException).code ?? 'error'}` };
  } finally {
    await rm(probe, { force: true }).catch(() => undefined);
  }
}

interface WalkEntry { rel: string; kind: 'dir' | 'file' | 'link'; size: number; mtimeMs: number; mode: number }

/**
 * Every directory, file and link of `root` (excluded names, `.git`, `skipDir` and the daemon's own top-level dirs left out);
 * stops past `maxFiles`. `dirty` holds the directories (`''` is the root) whose subtree had something left out: only a
 * directory that is NOT dirty can be cloned as one unit.
 */
async function walk(root: string, skipDir: string | undefined, maxFiles: number, skipInternal: boolean): Promise<{ entries: WalkEntry[]; files: number; dirty: Set<string> } | { tooMany: true }> {
  const entries: WalkEntry[] = [];
  const dirty = new Set<string>();
  const markDirty = (relDir: string) => {
    let dir = relDir;
    for (;;) {
      dirty.add(dir);
      if (dir === '') return;
      const slash = dir.lastIndexOf('/');
      dir = slash < 0 ? '' : dir.slice(0, slash);
    }
  };
  let files = 0;
  const stack: string[] = [''];
  while (stack.length > 0) {
    const relDir = stack.pop()!;
    const dirents = await readdir(relDir ? join(root, ...parts(relDir)) : root, { withFileTypes: true });
    for (const dirent of dirents) {
      const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name;
      if (skipInternal && !relDir && INTERNAL_TOP.has(dirent.name)) continue;
      const absolute = join(root, ...parts(rel));
      if (skipDir && resolve(absolute) === skipDir) { markDirty(relDir); continue; }
      if (dirent.isDirectory()) {
        if (EXCLUDED.has(dirent.name) || dirent.name === '.git') { markDirty(relDir); continue; }
        const info = await lstat(absolute);
        entries.push({ rel, kind: 'dir', size: 0, mtimeMs: info.mtimeMs, mode: info.mode & 0o777 });
        stack.push(rel);
      } else if (dirent.isSymbolicLink()) {
        const info = await lstat(absolute);
        entries.push({ rel, kind: 'link', size: 0, mtimeMs: info.mtimeMs, mode: info.mode & 0o777 });
        files += 1;
      } else if (dirent.isFile()) {
        const info = await lstat(absolute);
        entries.push({ rel, kind: 'file', size: info.size, mtimeMs: info.mtimeMs, mode: info.mode & 0o777 });
        files += 1;
      } else {
        markDirty(relDir); // sockets, fifos and devices are not project content
      }
      if (files > maxFiles) return { tooMany: true };
    }
  }
  return { entries, files, dirty };
}

export type CowCloneResult =
  | { ok: true; files: number; logicalBytes: number; ms: number; extraDiskBytes?: number; skipped: string[] }
  | { ok: false; reason: 'too_many_files' | 'clone_failed' | 'read_failed'; detail: string };

async function freeBytes(path: string): Promise<number | undefined> {
  try { const stats = await statfs(path); return Number(stats.bavail) * Number(stats.bsize); } catch { return undefined; }
}

/**
 * Clone the project into `taskDir` file by file (no data is read or written) and write the base manifest. A clone
 * that cannot complete leaves nothing behind. `extraDiskBytes` is the drop in free space on the volume, best effort.
 */
export async function createCowClone(
  projectRoot: string,
  taskDir: string,
  options: { engine?: CloneEngine | CloneFile; maxFiles?: number; now?: () => number } = {},
): Promise<CowCloneResult> {
  const root = resolve(projectRoot);
  const target = resolve(taskDir);
  const engine = asEngine(options.engine);
  const clock = options.now ?? Date.now;
  const started = clock();
  const freeBefore = await freeBytes(target);
  const walked = await walk(root, isInside(root, target) ? target : undefined, options.maxFiles ?? COW_CLONE_MAX_FILES, false)
    .catch((error: unknown) => ({ error: (error as Error).message }));
  if ('error' in walked) return { ok: false, reason: 'read_failed', detail: `reading the project failed: ${walked.error}` };
  if ('tooMany' in walked) return { ok: false, reason: 'too_many_files', detail: `the project has more than ${options.maxFiles ?? COW_CLONE_MAX_FILES} files` };
  const children = new Map<string, WalkEntry[]>();
  for (const entry of walked.entries) {
    const slash = entry.rel.lastIndexOf('/');
    const parent = slash < 0 ? '' : entry.rel.slice(0, slash);
    const list = children.get(parent) ?? [];
    list.push(entry);
    children.set(parent, list);
  }
  const skipped: string[] = [];
  const abs = (base: string, rel: string) => (rel ? join(base, ...parts(rel)) : base);
  // Clone `relDir` (already known to exist in the workspace): a directory with nothing left out below it is one clone call.
  const cloneDir = async (relDir: string): Promise<void> => {
    const list = children.get(relDir) ?? [];
    const files = list.filter((entry) => entry.kind === 'file');
    if (engine.cloneFilesInto && files.length > 1) {
      await engine.cloneFilesInto(files.map((entry) => abs(root, entry.rel)), abs(target, relDir));
    } else {
      for (const entry of files) await engine.cloneFile(abs(root, entry.rel), abs(target, entry.rel));
    }
    for (const entry of list) {
      if (entry.kind === 'link') {
        try { await symlink(await readlink(abs(root, entry.rel)), abs(target, entry.rel)); } catch { skipped.push(entry.rel); }
      } else if (entry.kind === 'dir') {
        if (engine.cloneTree && !walked.dirty.has(entry.rel)) {
          await engine.cloneTree(abs(root, entry.rel), abs(target, entry.rel));
        } else {
          await mkdir(abs(target, entry.rel), { recursive: true });
          await cloneDir(entry.rel);
        }
      }
    }
  };
  const entries: Record<string, CowManifestEntry> = {};
  let logicalBytes = 0;
  try {
    await mkdir(target, { recursive: true });
    if (engine.cloneTree && !walked.dirty.has('') && walked.entries.length > 0) {
      // Nothing to leave out anywhere: the whole project, one call, into the (empty) task directory.
      for (const child of children.get('') ?? []) {
        if (child.kind === 'dir') await engine.cloneTree(abs(root, child.rel), abs(target, child.rel));
      }
      const topFiles = (children.get('') ?? []).filter((entry) => entry.kind === 'file');
      if (engine.cloneFilesInto && topFiles.length > 0) await engine.cloneFilesInto(topFiles.map((entry) => abs(root, entry.rel)), target);
      else for (const entry of topFiles) await engine.cloneFile(abs(root, entry.rel), abs(target, entry.rel));
      for (const entry of children.get('') ?? []) {
        if (entry.kind === 'link') { try { await symlink(await readlink(abs(root, entry.rel)), abs(target, entry.rel)); } catch { skipped.push(entry.rel); } }
      }
    } else {
      await cloneDir('');
    }
    for (const entry of walked.entries) {
      if (entry.kind === 'file') {
        const cloned = await lstat(abs(target, entry.rel));
        entries[entry.rel] = { kind: 'file', size: entry.size, mtimeMs: entry.mtimeMs, mode: entry.mode, cloneSize: cloned.size, cloneMtimeMs: cloned.mtimeMs, cloneMode: cloned.mode & 0o777 };
        logicalBytes += entry.size;
      } else if (entry.kind === 'link' && !skipped.includes(entry.rel)) {
        entries[entry.rel] = { kind: 'link', size: 0, mtimeMs: entry.mtimeMs, mode: entry.mode, target: await readlink(abs(root, entry.rel)) };
      }
    }
    await writeAtomic(manifestPath(target), JSON.stringify({ version: MANIFEST_VERSION, projectRoot: root, createdAt: clock(), entries } satisfies CowManifest));
  } catch (error) {
    // Never a half workspace: whatever was cloned is removed (the clone is a set of new files; the project is untouched).
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, reason: 'clone_failed', detail: `cloning failed: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}` };
  }
  const freeAfter = await freeBytes(target);
  return {
    ok: true, files: walked.files, logicalBytes, ms: clock() - started, skipped,
    ...(freeBefore !== undefined && freeAfter !== undefined ? { extraDiskBytes: Math.max(0, freeBefore - freeAfter) } : {}),
  };
}

// ── what the pair changed ───────────────────────────────────────────────────

export interface CowChange {
  path: string;
  kind: 'added' | 'modified' | 'deleted';
  isLink?: boolean;
  sizeBefore?: number;
  sizeAfter?: number;
  /** Mode change only (same content). */
  modeOnly?: boolean;
}

async function sameBytes(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([lstat(a).catch(() => undefined), lstat(b).catch(() => undefined)]);
  if (!sa || !sb || sa.size !== sb.size) return false;
  const [ba, bb] = await Promise.all([readFile(a).catch(() => undefined), readFile(b).catch(() => undefined)]);
  return Boolean(ba && bb && ba.equals(bb));
}

/** The project file still has the size and mtime it had when the clone was made. */
async function projectMatchesBase(abs: string, entry: CowManifestEntry): Promise<boolean> {
  const info = await lstat(abs).catch(() => undefined);
  if (!info) return false;
  if (entry.kind === 'link') return info.isSymbolicLink() && (await readlink(abs).catch(() => undefined)) === entry.target;
  return info.isFile() && info.size === entry.size && sameMtime(info.mtimeMs, entry.mtimeMs);
}

/**
 * Files added, modified or deleted in the clone since it was made, judged against the manifest. A file whose
 * clone-side fingerprint changed but whose bytes still equal the project original (a `touch`) is not a change.
 */
export async function computeCowChanges(taskDir: string, manifest?: CowManifest): Promise<CowChange[] | undefined> {
  const base = manifest ?? await readCowManifest(taskDir);
  if (!base) return undefined;
  const current = await walk(taskDir, undefined, Number.MAX_SAFE_INTEGER, true).catch(() => undefined);
  if (!current || 'tooMany' in current) return undefined;
  const changes: CowChange[] = [];
  const present = new Set<string>();
  for (const entry of current.entries) {
    if (entry.kind === 'dir') continue;
    present.add(entry.rel);
    const before = base.entries[entry.rel];
    if (!before) { changes.push({ path: entry.rel, kind: 'added', isLink: entry.kind === 'link', sizeAfter: entry.size }); continue; }
    if (entry.kind === 'link' || before.kind === 'link') {
      const target = entry.kind === 'link' ? await readlink(join(taskDir, ...parts(entry.rel))).catch(() => undefined) : undefined;
      if (entry.kind !== before.kind || target !== before.target) changes.push({ path: entry.rel, kind: 'modified', isLink: entry.kind === 'link', sizeBefore: before.size, sizeAfter: entry.size });
      continue;
    }
    const untouched = entry.size === before.cloneSize && before.cloneMtimeMs !== undefined && sameMtime(entry.mtimeMs, before.cloneMtimeMs);
    const modeChanged = before.cloneMode !== undefined && entry.mode !== before.cloneMode;
    if (untouched && !modeChanged) continue;
    const original = join(base.projectRoot, ...parts(entry.rel));
    const contentSame = untouched || (await projectMatchesBase(original, before) && await sameBytes(original, join(taskDir, ...parts(entry.rel))));
    if (contentSame && !modeChanged) continue;
    changes.push({ path: entry.rel, kind: 'modified', sizeBefore: before.size, sizeAfter: entry.size, ...(contentSame ? { modeOnly: true } : {}) });
  }
  for (const [path, entry] of Object.entries(base.entries)) {
    if (!present.has(path)) changes.push({ path, kind: 'deleted', isLink: entry.kind === 'link', sizeBefore: entry.size });
  }
  // Code-point order: the same list on every machine and locale.
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ── review for the auditor ──────────────────────────────────────────────────

export interface CowReview {
  changes: CowChange[];
  /** The per-file diff clone vs project original, cut at TASK_PAIR_REVIEW_DIFF_MAX_BYTES. */
  diff: string;
  diffTruncated: boolean;
  /** The full diff, written in the task directory (absent when there was nothing to diff). */
  diffFile?: string;
  /** One line per binary or over-large file (size or hash summary instead of a text diff). */
  summaries: string[];
}

function run(file: string, args: readonly string[]): Promise<{ stdout: string; missing: boolean }> {
  return new Promise((resolvePromise) => {
    execFile(file, [...args], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      resolvePromise({ stdout: String(stdout ?? ''), missing: (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' });
    });
  });
}

const isBinary = (buffer: Buffer): boolean => buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);

/** A unified diff of two files labelled a/<rel> b/<rel>: `git diff --no-index` (stateless, stores nothing) or `diff -u`. */
async function unifiedDiff(rel: string, before: string | undefined, after: string | undefined): Promise<string | undefined> {
  const emptyish = before === undefined ? (process.platform === 'win32' ? 'NUL' : '/dev/null') : before;
  const other = after === undefined ? (process.platform === 'win32' ? 'NUL' : '/dev/null') : after;
  let result = await run('git', ['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '--', emptyish, other]);
  let output = result.stdout;
  if (result.missing) {
    result = await run('diff', ['-u', '-L', `a/${rel}`, '-L', `b/${rel}`, emptyish, other]);
    if (result.missing) return undefined;
    return result.stdout;
  }
  // git prints the real paths; show a/<rel> and b/<rel> like any patch. Only the header (before the first hunk) is rewritten:
  // a removed line that starts with "-- " must stay what it is.
  const lines = output.split('\n');
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'));
  for (let i = 0; i < (firstHunk < 0 ? lines.length : firstHunk); i += 1) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) lines[i] = `diff --git a/${rel} b/${rel}`;
    else if (line.startsWith('--- ')) lines[i] = before === undefined ? '--- /dev/null' : `--- a/${rel}`;
    else if (line.startsWith('+++ ')) lines[i] = after === undefined ? '+++ /dev/null' : `+++ b/${rel}`;
  }
  return lines.join('\n');
}

/**
 * Per-file review of the clone against the project original: a unified diff for text files, a size/hash summary
 * for binary or huge ones. The project is only read. Also writes the full diff to `<task dir>/.imcodes-cow/review.diff`.
 */
export async function buildCowReview(taskDir: string, manifest?: CowManifest, precomputed?: CowChange[]): Promise<CowReview | undefined> {
  const base = manifest ?? await readCowManifest(taskDir);
  if (!base) return undefined;
  const changes = precomputed ?? await computeCowChanges(taskDir, base);
  if (!changes) return undefined;
  const chunks: string[] = [];
  const summaries: string[] = [];
  for (const change of changes) {
    const original = join(base.projectRoot, ...parts(change.path));
    const clone = join(taskDir, ...parts(change.path));
    if (change.isLink) { summaries.push(`${change.kind} link ${change.path}`); continue; }
    if (change.modeOnly) { summaries.push(`mode changed ${change.path}`); continue; }
    const before = change.kind === 'added' ? undefined : await readFile(original).catch(() => undefined);
    const after = change.kind === 'deleted' ? undefined : await readFile(clone).catch(() => undefined);
    if ((change.kind !== 'added' && !before) || (change.kind !== 'deleted' && !after)) { summaries.push(`${change.kind} ${change.path} (unreadable)`); continue; }
    const hash = (buffer: Buffer | undefined) => buffer ? createHash('sha256').update(buffer).digest('hex').slice(0, 12) : '-';
    if ((before && isBinary(before)) || (after && isBinary(after)) || (before?.length ?? 0) > REVIEW_FILE_MAX_BYTES || (after?.length ?? 0) > REVIEW_FILE_MAX_BYTES) {
      summaries.push(`${change.kind} binary/large ${change.path}: ${before?.length ?? 0} -> ${after?.length ?? 0} bytes, sha256 ${hash(before)} -> ${hash(after)}`);
      continue;
    }
    const diff = await unifiedDiff(change.path, before ? original : undefined, after ? clone : undefined);
    if (diff === undefined) { summaries.push(`${change.kind} ${change.path}: ${before?.length ?? 0} -> ${after?.length ?? 0} bytes (no diff tool available)`); continue; }
    if (diff.trim()) chunks.push(diff.endsWith('\n') ? diff : `${diff}\n`);
  }
  const full = chunks.join('');
  const truncated = Buffer.byteLength(full) > TASK_PAIR_REVIEW_DIFF_MAX_BYTES;
  let diffFile: string | undefined;
  if (full) {
    diffFile = join(taskDir, TASK_PAIR_COW_MANIFEST_DIR, REVIEW_FILE);
    await writeAtomic(diffFile, full).catch(() => { diffFile = undefined; });
  }
  return { changes, diff: truncated ? `${Buffer.from(full).subarray(0, TASK_PAIR_REVIEW_DIFF_MAX_BYTES).toString('utf8')}\n... (cut)` : full, diffTruncated: truncated, ...(diffFile ? { diffFile } : {}), summaries };
}

// ── apply-back ──────────────────────────────────────────────────────────────

/** Test seam: thrown from `beforeWrite` to stop the apply dead, as a killed process would (no rollback). */
export class ApplyBackAbort extends Error {}

export interface ApplyBackConflict {
  path: string;
  reason: 'changed_in_project' | 'missing_in_project' | 'exists_in_project' | 'blocked_by_file' | 'unsafe_path' | 'is_directory';
}

interface JournalEntry {
  path: string;
  op: 'add' | 'modify' | 'delete';
  isLink: boolean;
  /** The project had this path (a backup of it exists). */
  hadOld: boolean;
  /** What the project file was at the base (manifest), for a modify/delete. */
  base?: Pick<CowManifestEntry, 'kind' | 'size' | 'mtimeMs' | 'target'>;
  /** The new link target (links). */
  newTarget?: string;
  /** Size/mtime of the project file right after the apply wrote it. */
  written?: { size: number; mtimeMs: number };
  done: boolean;
}

export interface ApplyBackJournal {
  version: number;
  applyId: string;
  projectRoot: string;
  status: 'applying' | 'applied' | 'rolled_back' | 'undone';
  startedAt: number;
  entries: JournalEntry[];
  createdDirs: string[];
  tempFiles: string[];
  finishedAt?: number;
}

export type ApplyBackResult =
  | { status: 'noop' }
  | { status: 'applied'; files: string[]; applyId: string; deleted: string[] }
  | { status: 'conflict'; conflicts: ApplyBackConflict[]; files: string[] }
  | { status: 'failed'; detail: string; rolledBack: boolean; files: string[] };

const backupRoot = (taskDir: string): string => join(taskDir, TASK_PAIR_APPLY_BACK_DIR, 'backup');
const journalPath = (taskDir: string): string => join(taskDir, TASK_PAIR_APPLY_BACK_DIR, JOURNAL_NAME);

export async function readApplyBackJournal(taskDir: string): Promise<ApplyBackJournal | undefined> {
  try {
    const parsed = JSON.parse(await readFile(journalPath(taskDir), 'utf8')) as ApplyBackJournal;
    return parsed?.version === JOURNAL_VERSION ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const writeJournal = (taskDir: string, journal: ApplyBackJournal): Promise<void> => writeAtomic(journalPath(taskDir), JSON.stringify(journal));

/** Absolute path of `rel` in the project, or a reason it is unsafe (escapes the project or goes through a symlink). */
async function safeProjectPath(projectRoot: string, rel: string): Promise<{ ok: true; abs: string } | { ok: false }> {
  const segments = parts(rel);
  if (!rel || isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || segments.some((segment) => segment === '' || segment === '..' || segment === '.')) return { ok: false };
  if (segments[0] === '.git' || INTERNAL_TOP.has(segments[0]!)) return { ok: false };
  let current = projectRoot;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    const info = await lstat(current).catch(() => undefined);
    if (!info) break; // the rest will be created below a real directory
    if (info.isSymbolicLink()) return { ok: false };
    if (!info.isDirectory()) break; // a plain file in the way is a conflict (blocked_by_file), not a path escape
  }
  return { ok: true, abs: join(projectRoot, ...segments) };
}

/** Copy keeping links, permission bits and timestamps (a restored file must look untouched to the next fingerprint check). */
async function copyPreserving(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  const info = await lstat(from);
  await rm(to, { force: true, recursive: true });
  if (info.isSymbolicLink()) {
    await symlink(await readlink(from), to);
    await lutimes(to, info.atime, info.mtime).catch(() => undefined);
  } else {
    await copyFile(from, to, fsConstants.COPYFILE_FICLONE);
    await chmod(to, info.mode & 0o777).catch(() => undefined);
    await utimes(to, info.atime, info.mtime).catch(() => undefined);
  }
}

async function mkdirTracked(dir: string, projectRoot: string, journal: ApplyBackJournal): Promise<void> {
  const missing: string[] = [];
  let probe = dir;
  while (probe !== projectRoot && isInside(projectRoot, probe) && !(await lstat(probe).catch(() => undefined))) {
    missing.push(probe);
    probe = dirname(probe);
  }
  for (const created of missing.reverse()) {
    await mkdir(created);
    journal.createdDirs.push(created);
  }
}

/** Which changes cannot be copied back because the project file no longer matches the base manifest. Reads only. */
export async function findApplyBackConflicts(taskDir: string, manifest: CowManifest, changes: readonly CowChange[]): Promise<ApplyBackConflict[]> {
  const conflicts: ApplyBackConflict[] = [];
  for (const change of changes) {
    const safe = await safeProjectPath(manifest.projectRoot, change.path);
    if (!safe.ok) { conflicts.push({ path: change.path, reason: 'unsafe_path' }); continue; }
    const info = await lstat(safe.abs).catch(() => undefined);
    if (info?.isDirectory()) { conflicts.push({ path: change.path, reason: 'is_directory' }); continue; }
    const base = manifest.entries[change.path];
    if (change.kind === 'added' || !base) {
      if (!info) {
        let probe = manifest.projectRoot;
        for (const segment of parts(change.path).slice(0, -1)) {
          probe = join(probe, segment);
          const parent = await lstat(probe).catch(() => undefined);
          if (!parent) break;
          if (!parent.isDirectory()) { conflicts.push({ path: change.path, reason: 'blocked_by_file' }); break; }
        }
      } else if (!(await sameBytes(safe.abs, join(taskDir, ...parts(change.path))))) {
        conflicts.push({ path: change.path, reason: 'exists_in_project' });
      }
      continue;
    }
    if (!info) { conflicts.push({ path: change.path, reason: 'missing_in_project' }); continue; }
    if (!(await projectMatchesBase(safe.abs, base))) conflicts.push({ path: change.path, reason: 'changed_in_project' });
  }
  return conflicts;
}

/**
 * Copy the clone's changes into the project. All-or-nothing: any conflict writes nothing; a failure midway rolls
 * back from the backup. `beforeWrite` is a test seam (crash injection).
 */
export async function applyBackCow(
  taskDir: string,
  options: { beforeWrite?: (path: string, index: number) => Promise<void> | void; now?: () => number } = {},
): Promise<ApplyBackResult> {
  const manifest = await readCowManifest(taskDir);
  if (!manifest) return { status: 'failed', detail: 'the workspace has no clone manifest', rolledBack: false, files: [] };
  const changes = await computeCowChanges(taskDir, manifest);
  if (!changes) return { status: 'failed', detail: 'the clone could not be compared with its manifest', rolledBack: false, files: [] };
  if (changes.length === 0) return { status: 'noop' };
  const files = changes.map((change) => change.path);
  const conflicts = await findApplyBackConflicts(taskDir, manifest, changes);
  if (conflicts.length > 0) return { status: 'conflict', conflicts, files };

  const projectRoot = manifest.projectRoot;
  const journal: ApplyBackJournal = {
    version: JOURNAL_VERSION, applyId: randomBytes(6).toString('hex'), projectRoot, status: 'applying',
    startedAt: (options.now ?? Date.now)(), entries: [], createdDirs: [], tempFiles: [],
  };
  try {
    await rm(backupRoot(taskDir), { recursive: true, force: true });
    // 1. Back up everything that will be overwritten or deleted, before the first project write.
    for (const change of changes) {
      const safe = await safeProjectPath(projectRoot, change.path);
      if (!safe.ok) throw new Error(`unsafe path ${change.path}`);
      const existing = await lstat(safe.abs).catch(() => undefined);
      const base = manifest.entries[change.path];
      const entry: JournalEntry = {
        path: change.path,
        op: change.kind === 'added' ? 'add' : change.kind === 'deleted' ? 'delete' : 'modify',
        isLink: Boolean(change.isLink),
        hadOld: Boolean(existing),
        ...(base ? { base: { kind: base.kind, size: base.size, mtimeMs: base.mtimeMs, ...(base.target !== undefined ? { target: base.target } : {}) } } : {}),
        done: false,
      };
      if (change.isLink && change.kind !== 'deleted') entry.newTarget = await readlink(join(taskDir, ...parts(change.path)));
      if (entry.hadOld) await copyPreserving(safe.abs, join(backupRoot(taskDir), ...parts(change.path)));
      journal.entries.push(entry);
    }
    await writeJournal(taskDir, journal);
    // 2. Write.
    let index = 0;
    for (const entry of journal.entries) {
      const safe = await safeProjectPath(projectRoot, entry.path);
      if (!safe.ok) throw new Error(`unsafe path ${entry.path}`);
      await options.beforeWrite?.(entry.path, index);
      index += 1;
      if (entry.op === 'delete') {
        await unlink(safe.abs);
      } else {
        await mkdirTracked(dirname(safe.abs), projectRoot, journal);
        const temporary = join(dirname(safe.abs), `.imcodes-apply-${randomBytes(4).toString('hex')}.tmp`);
        journal.tempFiles.push(temporary);
        await writeJournal(taskDir, journal);
        if (entry.isLink) {
          await symlink(entry.newTarget!, temporary);
        } else {
          const from = join(taskDir, ...parts(entry.path));
          await copyFile(from, temporary, fsConstants.COPYFILE_FICLONE);
          await chmod(temporary, (await lstat(from)).mode & 0o777).catch(() => undefined);
        }
        await rename(temporary, safe.abs);
        journal.tempFiles = journal.tempFiles.filter((name) => name !== temporary);
        const written = await lstat(safe.abs);
        entry.written = { size: written.size, mtimeMs: written.mtimeMs };
      }
      entry.done = true;
      await writeJournal(taskDir, journal);
    }
    journal.status = 'applied';
    journal.finishedAt = (options.now ?? Date.now)();
    await writeJournal(taskDir, journal);
    return { status: 'applied', files, applyId: journal.applyId, deleted: changes.filter((change) => change.kind === 'deleted').map((change) => change.path) };
  } catch (error) {
    if (error instanceof ApplyBackAbort) throw error;
    const detail = (error as Error).message;
    const rolledBack = await rollbackApplyBack(taskDir, { journal }).then((result) => result.ok).catch(() => false);
    return { status: 'failed', detail, rolledBack, files };
  }
}

export interface RollbackResult {
  ok: boolean;
  restored: string[];
  removed: string[];
  /** Files left alone because the project changed them after the apply (never overwritten). */
  skipped: Array<{ path: string; reason: 'changed_since_apply' | 'no_backup' }>;
}

/**
 * Undo a (possibly half-done) apply from its backup. A file is only touched when it still holds exactly what the
 * apply wrote (or the original): anything changed since is left alone and reported. Used for a crash mid-apply
 * (journal status `applying`) and for an explicit undo of an applied change.
 */
export async function rollbackApplyBack(
  taskDir: string,
  options: { journal?: ApplyBackJournal; finalStatus?: 'rolled_back' | 'undone' } = {},
): Promise<RollbackResult> {
  const journal = options.journal ?? await readApplyBackJournal(taskDir);
  const result: RollbackResult = { ok: true, restored: [], removed: [], skipped: [] };
  if (!journal) return result;
  const projectRoot = journal.projectRoot;
  for (const temporary of journal.tempFiles) await rm(temporary, { force: true }).catch(() => undefined);
  journal.tempFiles = [];
  for (const entry of [...journal.entries].reverse()) {
    const safe = await safeProjectPath(projectRoot, entry.path);
    if (!safe.ok) { result.skipped.push({ path: entry.path, reason: 'changed_since_apply' }); continue; }
    const info = await lstat(safe.abs).catch(() => undefined);
    const present = Boolean(info && !info.isDirectory());
    const holdsNew = entry.op !== 'delete' && present && info !== undefined && (entry.isLink
      ? info.isSymbolicLink() && (await readlink(safe.abs).catch(() => undefined)) === entry.newTarget
      : Boolean(entry.written && info.size === entry.written.size && sameMtime(info.mtimeMs, entry.written.mtimeMs)));
    const holdsOld = entry.hadOld && present && entry.base !== undefined && await projectMatchesBase(safe.abs, { ...entry.base, mode: 0 });
    if (entry.hadOld) {
      if (holdsOld && !holdsNew) continue; // never written (or already restored)
      // Only what the apply wrote, or a deletion the apply made, is restored over.
      if (!holdsNew && !holdsOld && present) { result.skipped.push({ path: entry.path, reason: 'changed_since_apply' }); continue; }
      const backup = join(backupRoot(taskDir), ...parts(entry.path));
      if (!(await lstat(backup).catch(() => undefined))) { result.skipped.push({ path: entry.path, reason: 'no_backup' }); result.ok = false; continue; }
      await mkdir(dirname(safe.abs), { recursive: true });
      const temporary = join(dirname(safe.abs), `.imcodes-restore-${randomBytes(4).toString('hex')}.tmp`);
      await copyPreserving(backup, temporary);
      await rename(temporary, safe.abs);
      result.restored.push(entry.path);
    } else if (holdsNew) {
      await unlink(safe.abs);
      result.removed.push(entry.path);
    } else if (present) {
      result.skipped.push({ path: entry.path, reason: 'changed_since_apply' });
    }
  }
  for (const dir of [...journal.createdDirs].reverse()) await rmdir(dir).catch(() => undefined);
  journal.status = options.finalStatus ?? 'rolled_back';
  journal.finishedAt = Date.now();
  await writeJournal(taskDir, journal).catch(() => undefined);
  return result;
}

/** Undo an applied change from its backup (files changed in the project since are left alone and listed). */
export function undoApplyBack(taskDir: string): Promise<RollbackResult> {
  return rollbackApplyBack(taskDir, { finalStatus: 'undone' });
}

/** True when the task directory has a journal saying an apply was started and never finished. */
export async function hasUnfinishedApplyBack(taskDir: string): Promise<boolean> {
  return (await readApplyBackJournal(taskDir))?.status === 'applying';
}
