import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  lstatSync, openSync, closeSync, readFileSync, readdirSync, realpathSync, statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const COMMIT_RE = /^[0-9a-f]{40}$/;

/**
 * Every bound here exists because production had none.
 *
 * Measured on 172.16.253.215 (PID 6092, V8 sampling profiler, 12s / 22286
 * samples): 98.0% of daemon MAIN-THREAD self time sat in `spawn` (native),
 * reached from this module via `matchingRemoteDelivery` and
 * `inspectSupervisionAssignmentWorktree`, at a sustained 30-59 forks/s with
 * ~100MB/s RssAnon churn across 138 worktrees. The daemon logged 1157
 * event-loop stalls and delegation replies timed out at 10s.
 *
 * The cost had two shapes: it was synchronous (execFileSync/spawnSync on the
 * daemon's only thread) and it was O(tracked + refs x files). Both are gone:
 * every git call is asynchronous, globally rate-limited, output-capped and
 * deadlined, and a cold inspection now spends a constant number of them.
 */
const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
/** Content budget for one remote-match probe; a ref that exceeds it cannot match. */
const REMOTE_MATCH_MAX_BYTES = 64 * 1024 * 1024;
/** Global ceiling on concurrent git processes across every worktree. */
const GIT_MAX_CONCURRENCY = 4;
/** Remote refs considered, highest priority first. Unchanged from the original. */
const REMOTE_REF_LIMIT = 64;
const CACHE_MAX_ENTRIES = 256;
/**
 * Working-tree CONTENT is the one dimension no fork-free identity can cover:
 * git does not touch `.git/index` when a tracked file is edited. The identity
 * below pins the worktree path, HEAD, the index, every remote ref and every
 * already-reported path; this TTL bounds only what remains. It stays short on
 * purpose — it exists to collapse a storm of repeated inspections of the SAME
 * worktree inside one tick, never to hold evidence across time.
 */
const CACHE_TTL_MS = 1_000;
/**
 * Total budget for ONE inspection, measured from the caller's first ask and
 * INCLUDING time spent queued for a git slot. The delegation-reply window this
 * incident is meant to protect is 10s, so the whole inspection must fail closed
 * well inside it rather than waiting through other callers' timeout waves.
 */
const INSPECTION_TOTAL_DEADLINE_MS = 8_000;
/** Hard ceiling on queued git requests; saturation is refused, never absorbed. */
const GIT_MAX_QUEUE = 512;

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
  /** Remote authority whose committed bytes exactly match every manifest row. */
  matchingRemoteCommitSha?: string;
  matchingRemoteRef?: string;
}

export type SupervisionWorktreeInspectionResult =
  | { ok: true; snapshot: SupervisionWorktreeSnapshot }
  | { ok: false; reason: 'worktree_unavailable' | 'worktree_unsafe' };

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function validRepoPath(path: string): boolean {
  return Boolean(path) && !path.startsWith('/') && !path.split('/').includes('..')
    && !CONTROL_CHARS.test(path);
}

// ---------------------------------------------------------------------------
// Bounded asynchronous git
// ---------------------------------------------------------------------------

let gitActive = 0;

interface GitWaiter { admit: () => void; refuse: (error: Error) => void; cancelled: boolean }
const gitWaiters: GitWaiter[] = [];

/**
 * Waiting for a slot is part of the request, so it is bounded twice: the queue
 * has a hard length cap, and the wait itself ends at the CALLER's deadline
 * rather than at some later per-child timeout. Without both, 138 cold
 * worktrees queue behind four slow children and the last of them can sit
 * through several timeout waves — well past the 10s delegation-reply window
 * this incident exists to protect.
 */
async function acquireGitSlot(deadlineAt: number): Promise<void> {
  if (Date.now() >= deadlineAt) throw new Error('git_deadline_exceeded');
  if (gitActive < GIT_MAX_CONCURRENCY) {
    gitActive += 1;
    return;
  }
  if (gitWaiters.length >= limits.maxQueue) throw new Error('git_queue_saturated');
  await new Promise<void>((admit, refuse) => {
    const waiter: GitWaiter = { admit, refuse, cancelled: false };
    gitWaiters.push(waiter);
    const timer = setTimeout(() => {
      waiter.cancelled = true;
      const at = gitWaiters.indexOf(waiter);
      if (at >= 0) gitWaiters.splice(at, 1);
      refuse(new Error('git_deadline_exceeded'));
    }, Math.max(0, deadlineAt - Date.now()));
    timer.unref?.();
    waiter.admit = () => { clearTimeout(timer); admit(); };
  });
  gitActive += 1;
}

function releaseGitSlot(): void {
  gitActive -= 1;
  // Skip anyone who already gave up, so a released slot is never handed to a
  // cancelled waiter while live requests keep queueing behind it.
  for (;;) {
    const next = gitWaiters.shift();
    if (!next) break;
    if (next.cancelled) continue;
    next.admit();
    break;
  }
}

interface GitRun { stdout: Buffer; status: number }

/**
 * Never blocks the event loop. A non-zero exit is returned as data only when
 * the caller opts in; spawn failure, timeout, output-cap overflow, queue
 * saturation and deadline expiry all reject, so the inspection above fails
 * closed rather than reporting partial Git state as authoritative.
 */
async function runGit(
  worktreePath: string,
  args: string[],
  options: { input?: string; maxBuffer?: number; allowExitCode?: boolean; deadlineAt: number },
): Promise<GitRun> {
  await acquireGitSlot(options.deadlineAt);
  try {
    const remaining = options.deadlineAt - Date.now();
    if (remaining <= 0) throw new Error('git_deadline_exceeded');
    return await new Promise<GitRun>((settle, fail) => {
      const child = execFile('git', ['-C', worktreePath, ...args], {
        encoding: 'buffer',
        // The child never gets longer than what is left of the caller's budget.
        timeout: Math.min(GIT_TIMEOUT_MS, remaining),
        maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER_BYTES,
        windowsHide: true,
      }, (error, stdout) => {
        const raw = (error as { code?: unknown } | null)?.code;
        const status = typeof raw === 'number' ? raw : (error ? -1 : 0);
        if (error && !(options.allowExitCode === true && status > 0)) {
          fail(error instanceof Error ? error : new Error('git failed'));
          return;
        }
        settle({ stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? '')), status });
      });
      if (options.input !== undefined) {
        child.stdin?.on('error', () => { /* reported through the callback */ });
        child.stdin?.end(options.input);
      }
    });
  } finally {
    releaseGitSlot();
  }
}

async function gitText(worktreePath: string, args: string[], deadlineAt: number): Promise<string> {
  return (await runGit(worktreePath, args, { deadlineAt })).stdout.toString('utf8');
}

function lines(value: string): string[] {
  return [...new Set(value.split('\n').map((line) => line.trim()).filter(Boolean))].sort();
}

function fileSha256(path: string): string {
  const fd = openSync(path, 'r');
  try {
    return createHash('sha256').update(readFileSync(fd)).digest('hex');
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Fork-free worktree identity (cache key)
// ---------------------------------------------------------------------------

function gitDirs(worktreePath: string): { gitDir: string; commonDir: string } {
  const dotGit = join(worktreePath, '.git');
  const stat = lstatSync(dotGit);
  let gitDir = dotGit;
  if (!stat.isDirectory()) {
    // A linked assignment worktree: `.git` is a file holding `gitdir: <path>`.
    const declared = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    if (!declared) throw new Error('unreadable gitdir');
    gitDir = resolve(worktreePath, declared[1].trim());
  }
  let commonDir = gitDir;
  try {
    const declared = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
    if (declared) commonDir = resolve(gitDir, declared);
  } catch { /* main worktree: the git dir is already the common dir */ }
  return { gitDir, commonDir };
}

function statSignature(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  } catch {
    return 'absent';
  }
}

/** Signature of every remote ref, loose and packed, without spawning git. */
function remoteRefsSignature(commonDir: string): string {
  const parts = [`packed=${statSignature(join(commonDir, 'packed-refs'))}`];
  const root = join(commonDir, 'refs', 'remotes');
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else parts.push(`${relative(commonDir, path)}=${statSignature(path)}`);
    }
  };
  walk(root, 0);
  return parts.join('|');
}

/**
 * Identity of everything a cached snapshot depends on that can be observed
 * without forking: the worktree, HEAD, the index, all remote refs, and the
 * exact paths the cached snapshot already reported. Any change to any of them
 * invalidates precisely.
 */
function worktreeIdentity(
  worktreePath: string,
  reportedPaths: readonly string[],
): string {
  const { gitDir, commonDir } = gitDirs(worktreePath);
  const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
  const parts = [
    `worktree=${worktreePath}`,
    `index=${statSignature(join(gitDir, 'index'))}`,
    `head=${head}`,
  ];
  const symbolic = /^ref:\s*(.+)$/.exec(head);
  if (symbolic) parts.push(`headref=${statSignature(join(commonDir, symbolic[1].trim()))}`);
  parts.push(`refs=${remoteRefsSignature(commonDir)}`);
  for (const path of reportedPaths) {
    parts.push(`path:${path}=${statSignature(resolve(worktreePath, path))}`);
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

// ---------------------------------------------------------------------------
// Remote delivery match: constant git processes, no refs x files amplification
// ---------------------------------------------------------------------------

interface BatchCheckRow { oid: string; type: string; size: number } // absent => missing

function parseBatchCheck(stdout: string, expected: number): (BatchCheckRow | null)[] {
  const rows = stdout.split('\n').filter((line) => line.length > 0);
  if (rows.length !== expected) throw new Error('git cat-file --batch-check row mismatch');
  return rows.map((row) => {
    // `<oid> <type> <size>` for a present object, `<input> missing` otherwise.
    const parts = row.split(' ');
    const tail = parts.slice(-3);
    if (parts[parts.length - 1] === 'missing') return null;
    if (tail.length !== 3) return null;
    const size = Number(tail[2]);
    if (!Number.isSafeInteger(size) || size < 0) return null;
    return { oid: tail[0], type: tail[1], size };
  });
}

/** Streams `<oid> <type> <size>\n<contents>\n` records out of `cat-file --batch`. */
function parseBatchContents(stdout: Buffer, oids: readonly string[]): Map<string, Buffer> {
  const contents = new Map<string, Buffer>();
  let offset = 0;
  for (let index = 0; index < oids.length; index += 1) {
    const newline = stdout.indexOf(0x0a, offset);
    if (newline < 0) break;
    const header = stdout.toString('utf8', offset, newline);
    offset = newline + 1;
    const parts = header.split(' ');
    if (parts[parts.length - 1] === 'missing') continue;
    const size = Number(parts[2]);
    if (!Number.isSafeInteger(size) || size < 0) break;
    contents.set(parts[0], stdout.subarray(offset, offset + size));
    offset += size + 1;
  }
  return contents;
}

async function matchingRemoteDelivery(
  worktreePath: string,
  files: readonly SupervisionWorktreeFileSnapshot[],
  sizes: ReadonlyMap<string, number>,
  deadlineAt: number,
): Promise<{ matchingRemoteCommitSha: string; matchingRemoteRef: string } | undefined> {
  if (files.length === 0) return undefined;
  const refs = lines(await gitText(worktreePath, ['for-each-ref', '--format=%(refname)', 'refs/remotes'], deadlineAt))
    .sort((left, right) => Number(right === 'refs/remotes/origin/dev') - Number(left === 'refs/remotes/origin/dev'))
    .slice(0, REMOTE_REF_LIMIT);
  if (refs.length === 0) return undefined;

  // ONE process replaces refs x files `git show`. `--batch-check` returns only
  // object id, type and size, so its output stays tiny regardless of content.
  const probes: string[] = [];
  for (const ref of refs) for (const file of files) probes.push(`${ref}:${file.path}`);
  const checked = parseBatchCheck(
    (await runGit(worktreePath, ['cat-file', '--batch-check'], {
      input: `${probes.join('\n')}\n`, allowExitCode: true, deadlineAt,
    })).stdout.toString('utf8'),
    probes.length,
  );

  // Size is a free, exact pre-filter: identical content implies identical
  // length, so any ref that disagrees on a single length cannot match and
  // never costs a byte of content.
  const candidates: { ref: string; needed: Map<string, string> }[] = [];
  for (let refIndex = 0; refIndex < refs.length; refIndex += 1) {
    const needed = new Map<string, string>();
    let viable = true;
    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      const file = files[fileIndex];
      const row = checked[refIndex * files.length + fileIndex];
      if (file.deleted === true) {
        // The original treated a readable object as proof the ref still has it.
        if (row !== null) { viable = false; break; }
        continue;
      }
      if (row === null || row.type !== 'blob' || row.size !== sizes.get(file.path)) {
        viable = false;
        break;
      }
      needed.set(file.path, row.oid);
    }
    if (viable) candidates.push({ ref: refs[refIndex], needed });
  }
  if (candidates.length === 0) return undefined;

  // Fetch each distinct blob at most once, under a hard byte budget. A ref
  // whose bytes do not fit is reported as NOT matching — never as matching —
  // so an unverified ref can never be promoted to authority.
  const sizeByOid = new Map<string, number>();
  for (let refIndex = 0; refIndex < refs.length; refIndex += 1) {
    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      const row = checked[refIndex * files.length + fileIndex];
      if (row) sizeByOid.set(row.oid, row.size);
    }
  }
  const wanted: string[] = [];
  let budget = 0;
  const affordable = new Set<string>();
  for (const candidate of candidates) {
    const distinct = [...new Set(candidate.needed.values())].filter((oid) => !affordable.has(oid));
    const cost = distinct.reduce((total, oid) => total + (sizeByOid.get(oid) ?? 0), 0);
    if (budget + cost > limits.remoteMatchMaxBytes) continue;
    budget += cost;
    for (const oid of distinct) { affordable.add(oid); wanted.push(oid); }
  }
  // A deletion-only manifest needs no bytes at all: every row was already
  // proven absent from the ref by cat-file. Returning early here would drop
  // that whole class of delivery, which the per-ref implementation accepted.
  const digests = new Map<string, string>();
  if (wanted.length > 0) {
    const contents = parseBatchContents(
      (await runGit(worktreePath, ['cat-file', '--batch'], {
        input: `${wanted.join('\n')}\n`,
        maxBuffer: limits.remoteMatchMaxBytes + 1024 * 1024,
        allowExitCode: true,
        deadlineAt,
      })).stdout,
      wanted,
    );
    for (const [oid, buffer] of contents) {
      digests.set(oid, createHash('sha256').update(buffer).digest('hex'));
    }
  }

  for (const candidate of candidates) {
    let matches = true;
    for (const file of files) {
      if (file.deleted === true) continue;
      const oid = candidate.needed.get(file.path);
      const digest = oid === undefined ? undefined : digests.get(oid);
      if (digest === undefined || digest !== file.sha256) { matches = false; break; }
    }
    if (!matches) continue;
    const commitSha = (await gitText(worktreePath, ['rev-parse', `${candidate.ref}^{commit}`], deadlineAt)).trim().toLowerCase();
    if (COMMIT_RE.test(commitSha)) {
      return { matchingRemoteCommitSha: commitSha, matchingRemoteRef: candidate.ref };
    }
  }
  return undefined;
}

/**
 * The EXACT set of paths git currently considers dirty, in one process.
 *
 * A fork-free key cannot see this: git does not touch `.git/index` when a
 * tracked file is edited, and a brand new untracked file is in no cached stat.
 * That gap let a cached snapshot keep a positive `matchingRemoteCommitSha`
 * after the worktree gained an undelivered path, which
 * `#convergeAlreadyPresentDelivery` would then persist as commitSha /
 * pushRemoteRef — undelivered bytes recorded as delivered. One bounded probe
 * per reuse is the price of never doing that.
 *
 * `--porcelain -z` never quotes or renames-away a path, and rename records
 * carry their source as the following NUL field; both endpoints are collected
 * because either one entering or leaving the dirty set matters.
 */
async function dirtyPathProbe(worktreePath: string, deadlineAt: number): Promise<Set<string>> {
  const raw = (await runGit(worktreePath, [
    'status', '--porcelain', '-z', '--untracked-files=all', '--ignore-submodules=all',
  ], { deadlineAt })).stdout.toString('utf8');
  const fields = raw.split('\u0000');
  const paths = new Set<string>();
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.length < 4) continue;
    const status = field.slice(0, 2);
    paths.add(field.slice(3));
    // `R`/`C` records are followed by their source path in the next field.
    if (status.includes('R') || status.includes('C')) {
      index += 1;
      const source = fields[index];
      if (source) paths.add(source);
    }
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

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

interface CacheEntry {
  identity: string;
  reportedPaths: string[];
  /** Exact dirty set observed when the snapshot was taken. */
  dirtyPaths: string[];
  result: SupervisionWorktreeInspectionResult;
  storedAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<SupervisionWorktreeInspectionResult>>();

async function cachedResult(
  worktreePath: string,
  deadlineAt: number,
): Promise<SupervisionWorktreeInspectionResult | undefined> {
  const entry = cache.get(worktreePath);
  if (!entry) return undefined;
  if (Date.now() - entry.storedAt > CACHE_TTL_MS) {
    cache.delete(worktreePath);
    return undefined;
  }
  let identity: string;
  try {
    identity = worktreeIdentity(worktreePath, entry.reportedPaths);
  } catch {
    cache.delete(worktreePath);
    return undefined;
  }
  if (identity !== entry.identity) {
    cache.delete(worktreePath);
    return undefined;
  }
  // The fork-free key proves HEAD, the index, every remote ref and every path
  // the snapshot already reported. It cannot prove that NO OTHER path became
  // dirty, and that is exactly what would turn a stale reuse into a false
  // delivery authority — so it is proven directly, every time.
  let dirty: Set<string>;
  try {
    dirty = await dirtyPathProbe(worktreePath, deadlineAt);
  } catch {
    cache.delete(worktreePath);
    return undefined;
  }
  if (dirty.size !== entry.dirtyPaths.length
    || entry.dirtyPaths.some((path) => !dirty.has(path))) {
    cache.delete(worktreePath);
    return undefined;
  }
  // Refresh recency for the LRU bound.
  cache.delete(worktreePath);
  cache.set(worktreePath, entry);
  return entry.result;
}

function storeResult(
  worktreePath: string,
  reportedPaths: string[],
  dirtyPaths: string[],
  result: SupervisionWorktreeInspectionResult,
): void {
  let identity: string;
  try {
    identity = worktreeIdentity(worktreePath, reportedPaths);
  } catch {
    return; // Un-keyable worktree: never cache it.
  }
  cache.delete(worktreePath);
  cache.set(worktreePath, { identity, reportedPaths, dirtyPaths, result, storedAt: Date.now() });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function inspectUncached(worktreePath: string, deadlineAt: number): Promise<{
  result: SupervisionWorktreeInspectionResult;
  reportedPaths: string[];
  dirtyPaths: string[];
}> {
  const assignmentRoot = realpathSync(dirname(worktreePath));
  if (basename(worktreePath) !== 'repo' || !within(assignmentRoot, worktreePath)) {
    return { result: { ok: false, reason: 'worktree_unsafe' }, reportedPaths: [], dirtyPaths: [] };
  }
  // One process yields both the toplevel and HEAD. Order is significant, so
  // this deliberately does not go through `lines()`, which sorts and dedupes.
  const revParsed = (await gitText(worktreePath, ['rev-parse', '--show-toplevel', 'HEAD'], deadlineAt))
    .split('\n').map((line) => line.trim()).filter(Boolean);
  if (revParsed.length !== 2) return { result: { ok: false, reason: 'worktree_unsafe' }, reportedPaths: [], dirtyPaths: [] };
  const root = realpathSync(revParsed[0]);
  if (root !== worktreePath) return { result: { ok: false, reason: 'worktree_unsafe' }, reportedPaths: [], dirtyPaths: [] };
  const headSha = revParsed[1].toLowerCase();
  if (!COMMIT_RE.test(headSha)) return { result: { ok: false, reason: 'worktree_unsafe' }, reportedPaths: [], dirtyPaths: [] };

  // --ignore-cr-at-eol excludes checkout-only CRLF normalization noise while
  // retaining every semantic byte change. Asking git for the name list under
  // that same flag is exactly the old "list, then re-test each path" pair,
  // without one process per tracked path. Untracked files are always exact.
  const dirtyPaths = [...await dirtyPathProbe(worktreePath, deadlineAt)].sort();
  const [trackedText, stagedText, conflictedText, untrackedText] = await Promise.all([
    gitText(worktreePath, ['diff', '--name-only', '--ignore-cr-at-eol', 'HEAD', '--'], deadlineAt),
    gitText(worktreePath, ['diff', '--cached', '--name-only', 'HEAD', '--'], deadlineAt),
    gitText(worktreePath, ['diff', '--name-only', '--diff-filter=U', '--'], deadlineAt),
    gitText(worktreePath, ['ls-files', '--others', '--exclude-standard'], deadlineAt),
  ]);
  const tracked = lines(trackedText);
  const stagedPaths = lines(stagedText);
  const conflictedPaths = lines(conflictedText);
  const rawUntrackedPaths = lines(untrackedText);
  if (![...tracked, ...stagedPaths, ...rawUntrackedPaths, ...conflictedPaths].every(validRepoPath)) {
    return { result: { ok: false, reason: 'worktree_unsafe' }, reportedPaths: [], dirtyPaths: [] };
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
  const sizes = new Map<string, number>();
  const files = changedPaths.map((path): SupervisionWorktreeFileSnapshot => {
    const absolute = resolve(worktreePath, path);
    if (!within(worktreePath, absolute)) throw new Error('unsafe worktree path');
    let stat;
    try { stat = lstatSync(absolute); } catch { return { path, deleted: true }; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe worktree entry');
    sizes.set(path, stat.size);
    return { path, sha256: fileSha256(absolute) };
  });
  return {
    result: {
      ok: true,
      snapshot: {
        worktreePath,
        headSha,
        files,
        stagedPaths,
        conflictedPaths,
        untrackedPaths,
        ...(await matchingRemoteDelivery(worktreePath, files, sizes, deadlineAt)),
      },
    },
    reportedPaths: changedPaths,
    dirtyPaths,
  };
}

/**
 * Inspect the exact assignment worktree. Registry file metadata is deliberately
 * absent from this API: callers cannot use it to fabricate or veto Git state.
 *
 * Asynchronous by contract. Concurrent callers for the same worktree share one
 * underlying pass, and an unchanged worktree is answered without spawning git.
 */
export function inspectSupervisionAssignmentWorktree(input: {
  sessionName: string;
  assignmentId: string;
  worktreePath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SupervisionWorktreeInspectionResult> {
  const configured = resolve(input.worktreePath ?? resolveSupervisionAssignmentWorktree(input));
  let worktreePath: string;
  try {
    worktreePath = realpathSync(configured);
  } catch {
    return Promise.resolve({ ok: false, reason: 'worktree_unavailable' });
  }
  // Coalescing comes first so that concurrent callers share even the cheap
  // reuse probe, and the deadline starts at the caller's ask, not at a slot.
  const running = inFlight.get(worktreePath);
  if (running) return running;
  const deadlineAt = Date.now() + limits.totalDeadlineMs;

  const pass = (async (): Promise<SupervisionWorktreeInspectionResult> => {
    try {
      const hit = await cachedResult(worktreePath, deadlineAt);
      if (hit) return hit;
      const { result, reportedPaths, dirtyPaths } = await inspectUncached(worktreePath, deadlineAt);
      storeResult(worktreePath, reportedPaths, dirtyPaths, result);
      return result;
    } catch {
      // Saturation, deadline expiry, git failure and output overflow all land
      // here: an inspection that could not be completed is never a snapshot.
      return { ok: false, reason: 'worktree_unavailable' };
    } finally {
      inFlight.delete(worktreePath);
    }
  })();
  inFlight.set(worktreePath, pass);
  return pass;
}

interface InspectionLimits {
  totalDeadlineMs: number;
  maxQueue: number;
  remoteMatchMaxBytes: number;
}

const DEFAULT_LIMITS: InspectionLimits = {
  totalDeadlineMs: INSPECTION_TOTAL_DEADLINE_MS,
  maxQueue: GIT_MAX_QUEUE,
  remoteMatchMaxBytes: REMOTE_MATCH_MAX_BYTES,
};
let limits: InspectionLimits = DEFAULT_LIMITS;

/** Test seam: tighten the bounds so saturation and deadlines are reachable. */
export function __setSupervisionWorktreeInspectionLimitsForTests(
  override: Partial<InspectionLimits> | undefined,
): void {
  if (process.env.NODE_ENV !== 'test') return;
  limits = override ? { ...DEFAULT_LIMITS, ...override } : DEFAULT_LIMITS;
}

/** Test seam: drop every cached inspection so a case starts cold. */
export function __resetSupervisionWorktreeInspectionCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}
