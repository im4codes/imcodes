import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { resolveSupervisionAssignmentWorktree } from './supervision-worktree-inspector.js';

const execFileAsync = promisify(execFile);
const COMMIT_RE = /^[0-9a-f]{40}$/;
const JOURNAL_NAME = '.worktree-provision.json';
const LEASE_NAME = '.worktree-provision.lock';
const LEASE_VERSION = 1 as const;
const PROCESS_STARTED_AT = Math.floor(Date.now() - process.uptime() * 1_000);
const CONVERGENCE_ATTEMPTS = 200;
const CONVERGENCE_INTERVAL_MS = 25;

interface InFlightProvision {
  fingerprint: string;
  result: Promise<SupervisionWorktreeProvisionResult>;
}

interface ProvisionLease {
  version: typeof LEASE_VERSION;
  token: string;
  fingerprint: string;
  pid: number;
  processStartedAt: number;
  acquiredAt: number;
}

type ProvisionLeaseRead =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'valid'; lease: ProvisionLease };

type ProvisionLeaseAdmission =
  | { acquired: true; lease: ProvisionLease }
  | { acquired: false; result: SupervisionWorktreeProvisionResult };

interface RegisteredWorktree {
  path: string;
  head?: string;
  locked: boolean;
  prunable: boolean;
}

// Coalesce callers inside one daemon before the durable O_EXCL lease below
// arbitrates independent daemon/process instances for the same path.
const inFlightProvisions = new Map<string, InFlightProvision>();

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

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

function isLeaseOwnerAlive(lease: ProvisionLease): boolean {
  // A stale file from an earlier lifetime of this PID must not become live
  // merely because the operating system later reused the number.
  if (lease.pid === process.pid) {
    return Math.abs(lease.processStartedAt - PROCESS_STARTED_AT) < 2_000;
  }
  return isProcessAlive(lease.pid);
}

async function readProvisionLease(path: string): Promise<ProvisionLeaseRead> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'invalid' };
  }
  try {
    const value = JSON.parse(raw) as Partial<ProvisionLease>;
    if (value.version !== LEASE_VERSION || typeof value.token !== 'string' || !value.token
      || typeof value.fingerprint !== 'string' || !value.fingerprint
      || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
      || !Number.isFinite(value.processStartedAt) || Number(value.processStartedAt) <= 0
      || !Number.isFinite(value.acquiredAt) || Number(value.acquiredAt) <= 0) {
      return { kind: 'invalid' };
    }
    return { kind: 'valid', lease: value as ProvisionLease };
  } catch {
    return { kind: 'invalid' };
  }
}

async function writeProvisionLease(path: string, fingerprint: string): Promise<ProvisionLease> {
  const lease: ProvisionLease = {
    version: LEASE_VERSION,
    token: randomUUID(),
    fingerprint,
    pid: process.pid,
    processStartedAt: PROCESS_STARTED_AT,
    acquiredAt: Date.now(),
  };
  // Publish only complete JSON. `writeFile(..., { flag: 'wx' })` reserves its
  // destination before all bytes are visible, so a competing process can see
  // an empty/partial lease. A fully written unique inode plus atomic hard-link
  // publication preserves O_EXCL ownership without that malformed-read gap.
  const pendingPath = `${path}.pending-${lease.token}`;
  try {
    await writeFile(pendingPath, `${JSON.stringify(lease)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await link(pendingPath, path);
    return lease;
  } finally {
    await rm(pendingPath, { force: true });
  }
}

async function retireDeadProvisionLease(path: string, expected: ProvisionLease): Promise<boolean> {
  // The hard link is an inode-stable compare-and-delete witness. If another
  // contender already created it, a crash cannot strand recovery: every later
  // contender can verify and retire the same dead inode. A newly acquired live
  // lease has a different token/inode and is never removed.
  const recoveryClaim = `${path}.recover-${expected.token}`;
  try {
    await link(path, recoveryClaim);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return true;
    // Only the contender that atomically creates this inode witness may
    // retire the dead lease. Other contenders keep waiting; allowing all
    // EEXIST observers to delete would let a delayed observer remove a new
    // live owner's lease after the first recovery completed.
    return false;
  }
  try {
    const claimed = await readProvisionLease(recoveryClaim);
    const current = await readProvisionLease(path);
    if (claimed.kind !== 'valid' || claimed.lease.token !== expected.token
      || current.kind !== 'valid' || current.lease.token !== expected.token
      || isLeaseOwnerAlive(current.lease)) return false;
    let claimedStat: Awaited<ReturnType<typeof stat>>;
    let currentStat: Awaited<ReturnType<typeof stat>>;
    try {
      [claimedStat, currentStat] = await Promise.all([stat(recoveryClaim), stat(path)]);
    } catch (error) {
      // Another recovery contender can retire the witnessed dead inode between
      // the token reads and these stats. Missing means convergence, while any
      // other filesystem failure remains fail-closed and retryable.
      if (errorCode(error) === 'ENOENT') return !await exists(path);
      return false;
    }
    if (claimedStat.dev !== currentStat.dev || claimedStat.ino !== currentStat.ino) return false;
    try {
      await rm(path);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') return false;
    }
    return true;
  } finally {
    await rm(recoveryClaim, { force: true });
  }
}

async function releaseProvisionLease(path: string, lease: ProvisionLease): Promise<void> {
  const current = await readProvisionLease(path);
  if (current.kind === 'valid' && current.lease.token === lease.token) {
    await rm(path, { force: true });
  }
}

async function commonDir(repo: string): Promise<string> {
  const raw = (await git(repo, ['rev-parse', '--git-common-dir'])).trim();
  return realpath(resolve(repo, raw));
}

async function gitDir(repo: string): Promise<string> {
  const raw = (await git(repo, ['rev-parse', '--git-dir'])).trim();
  return realpath(resolve(repo, raw));
}

async function inspectExistingWorktree(input: {
  worktreePath: string;
  assignmentRoot: string;
  sourceCommonDir: string;
  baseRevision: string;
}): Promise<SupervisionWorktreeProvisionResult | undefined> {
  if (!await exists(input.worktreePath)) return undefined;
  try {
    const actualRoot = await realpath(input.worktreePath);
    const actualAssignmentRoot = await realpath(input.assignmentRoot);
    if (basename(actualRoot) !== 'repo' || dirname(actualRoot) !== actualAssignmentRoot
      || !within(actualAssignmentRoot, actualRoot) || await commonDir(actualRoot) !== input.sourceCommonDir) {
      throw new Error('existing path is not the expected repository worktree');
    }
    const actualGitDir = await gitDir(actualRoot);
    // Never inspect through, delete, or otherwise "repair" an index lock. It
    // may belong to a live Git process. A later idempotent retry continues the
    // same object after the owner removes its lock.
    if (await exists(join(actualGitDir, 'index.lock'))) {
      return {
        ok: false,
        reason: SUPERVISION_WORKTREE_PROVISION_REASONS.CREATE_FAILED,
        detail: 'existing assignment worktree index is locked',
      };
    }
    const head = (await git(actualRoot, ['rev-parse', 'HEAD'], 5_000)).trim().toLowerCase();
    if (head !== input.baseRevision) {
      return { ok: false, reason: SUPERVISION_WORKTREE_PROVISION_REASONS.BASE_MISMATCH, detail: `existing HEAD ${head} does not match ${input.baseRevision}` };
    }
    const dirty = (await git(actualRoot, ['status', '--porcelain=v1', '--untracked-files=all'], 5_000)).trim();
    if (await exists(join(actualGitDir, 'index.lock'))) {
      return {
        ok: false,
        reason: SUPERVISION_WORKTREE_PROVISION_REASONS.CREATE_FAILED,
        detail: 'existing assignment worktree index is locked',
      };
    }
    if (dirty) {
      return { ok: false, reason: SUPERVISION_WORKTREE_PROVISION_REASONS.EXISTING_DIRTY, detail: 'existing assignment worktree has tracked or untracked changes' };
    }
    return { ok: true, worktreePath: input.worktreePath, baseRevision: head, created: false };
  } catch (error) {
    return { ok: false, reason: SUPERVISION_WORKTREE_PROVISION_REASONS.EXISTING_UNSAFE, detail: error instanceof Error ? error.message : 'existing worktree is unsafe' };
  }
}

function parseRegisteredWorktrees(raw: string): RegisteredWorktree[] {
  return raw.split('\0\0').flatMap((record) => {
    const fields = record.split('\0').filter(Boolean);
    const pathField = fields.find((field) => field.startsWith('worktree '));
    if (!pathField) return [];
    const headField = fields.find((field) => field.startsWith('HEAD '));
    return [{
      path: pathField.slice('worktree '.length),
      ...(headField ? { head: headField.slice('HEAD '.length).trim().toLowerCase() } : {}),
      locked: fields.some((field) => field === 'locked' || field.startsWith('locked ')),
      prunable: fields.some((field) => field === 'prunable' || field.startsWith('prunable ')),
    }];
  });
}

async function findRegisteredWorktree(
  projectRoot: string,
  worktreePath: string,
): Promise<RegisteredWorktree | undefined> {
  const entries = parseRegisteredWorktrees(await git(projectRoot, ['worktree', 'list', '--porcelain', '-z']));
  const targetParent = await realpath(dirname(worktreePath));
  const target = join(targetParent, basename(worktreePath));
  for (const entry of entries) {
    try {
      const candidate = join(await realpath(dirname(entry.path)), basename(entry.path));
      if (candidate === target) return entry;
    } catch {
      // An unrelated stale entry with a missing parent is not this assignment.
    }
  }
  return undefined;
}

async function convergeConcurrentProvision(input: {
  worktreePath: string;
  assignmentRoot: string;
  sourceCommonDir: string;
  baseRevision: string;
}): Promise<SupervisionWorktreeProvisionResult | undefined> {
  // A separate process can win `git worktree add` after our command has
  // already observed its destination. Give that exact winner a bounded window
  // to finish checkout, then validate the same base/common-dir/cleanliness
  // contract as an ordinary replay. Nothing is removed while waiting.
  let latest: SupervisionWorktreeProvisionResult | undefined;
  for (let attempt = 0; attempt < CONVERGENCE_ATTEMPTS; attempt += 1) {
    const inspected = await inspectExistingWorktree(input);
    if (inspected?.ok) return inspected;
    if (inspected && !inspected.ok
      && inspected.reason === SUPERVISION_WORKTREE_PROVISION_REASONS.BASE_MISMATCH) {
      return inspected;
    }
    latest = inspected;
    await new Promise((resolveWait) => setTimeout(resolveWait, CONVERGENCE_INTERVAL_MS));
  }
  return latest;
}

async function acquireProvisionLease(input: {
  leasePath: string;
  fingerprint: string;
  worktreePath: string;
  assignmentRoot: string;
  sourceCommonDir: string;
  baseRevision: string;
}): Promise<ProvisionLeaseAdmission> {
  let latest: SupervisionWorktreeProvisionResult | undefined;
  for (let attempt = 0; attempt < CONVERGENCE_ATTEMPTS; attempt += 1) {
    try {
      return { acquired: true, lease: await writeProvisionLease(input.leasePath, input.fingerprint) };
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        return {
          acquired: false,
          result: {
            ok: false,
            reason: SUPERVISION_WORKTREE_PROVISION_REASONS.CREATE_FAILED,
            detail: error instanceof Error ? error.message : 'worktree provision lease failed',
          },
        };
      }
    }
    const current = await readProvisionLease(input.leasePath);
    if (current.kind === 'missing') continue;
    if (current.kind !== 'valid') {
      // O_EXCL reserves the pathname before writeFile finishes publishing its
      // JSON bytes. Treat an unreadable/partial lease as a bounded transient;
      // a persistently malformed foreign file still fails closed at timeout.
      latest = {
        ok: false,
        reason: SUPERVISION_WORKTREE_PROVISION_REASONS.EXISTING_UNSAFE,
        detail: 'worktree provision lease is malformed',
      };
      await new Promise((resolveWait) => setTimeout(resolveWait, CONVERGENCE_INTERVAL_MS));
      continue;
    }
    if (current.lease.fingerprint !== input.fingerprint) {
      return {
        acquired: false,
        result: {
          ok: false,
          reason: SUPERVISION_WORKTREE_PROVISION_REASONS.EXISTING_UNSAFE,
          detail: 'concurrent worktree provision conflicts with this assignment',
        },
      };
    }
    if (!isLeaseOwnerAlive(current.lease)) {
      await retireDeadProvisionLease(input.leasePath, current.lease);
      continue;
    }
    // The live owner exclusively controls this tuple. Even read-only Git
    // inspection can race its checkout/index initialization and make the
    // owner's `worktree add` report a partial failure. Wait for lease release,
    // then acquire and inspect the fully materialized result ourselves.
    await new Promise((resolveWait) => setTimeout(resolveWait, CONVERGENCE_INTERVAL_MS));
  }
  return {
    acquired: false,
    result: latest ?? {
      ok: false,
      reason: SUPERVISION_WORKTREE_PROVISION_REASONS.CREATE_FAILED,
      detail: 'timed out waiting for the same worktree provision owner',
    },
  };
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
  const fingerprint = JSON.stringify({
    projectRoot: resolve(input.projectRoot),
    sessionName: input.sessionName,
    assignmentId: input.assignmentId,
    baseRevision: input.baseRevision,
    worktreePath,
  });
  const inFlight = inFlightProvisions.get(worktreePath);
  if (inFlight) {
    if (inFlight.fingerprint !== fingerprint) {
      return {
        ok: false,
        reason: SUPERVISION_WORKTREE_PROVISION_REASONS.EXISTING_UNSAFE,
        detail: 'concurrent worktree provision conflicts with this assignment',
      };
    }
    const replay = await inFlight.result;
    return replay.ok ? { ...replay, created: false } : replay;
  }

  const result = ensureSupervisionAssignmentWorktreeOnce({ ...input, worktreePath, fingerprint });
  inFlightProvisions.set(worktreePath, { fingerprint, result });
  try {
    return await result;
  } finally {
    if (inFlightProvisions.get(worktreePath)?.result === result) {
      inFlightProvisions.delete(worktreePath);
    }
  }
}

async function ensureSupervisionAssignmentWorktreeOnce(input: {
  projectRoot: string;
  sessionName: string;
  assignmentId: string;
  baseRevision: string;
  worktreePath: string;
  fingerprint: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SupervisionWorktreeProvisionResult> {
  const worktreePath = input.worktreePath;
  const assignmentRoot = dirname(worktreePath);
  const journalPath = join(assignmentRoot, JOURNAL_NAME);
  const leasePath = join(assignmentRoot, LEASE_NAME);
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
  await mkdir(assignmentRoot, { recursive: true });
  const leaseAdmission = await acquireProvisionLease({
    leasePath,
    fingerprint: input.fingerprint,
    worktreePath,
    assignmentRoot,
    sourceCommonDir,
    baseRevision: input.baseRevision,
  });
  if (!leaseAdmission.acquired) return leaseAdmission.result;
  try {
    const existing = await inspectExistingWorktree({
      worktreePath, assignmentRoot, sourceCommonDir, baseRevision: input.baseRevision,
    });
    if (existing) {
      if (existing.ok) {
        await rm(journalPath, { force: true });
        return existing;
      }
      if (existing.reason === SUPERVISION_WORKTREE_PROVISION_REASONS.CREATE_FAILED
        && existing.detail === 'existing assignment worktree index is locked') {
        const converged = await convergeConcurrentProvision({
          worktreePath, assignmentRoot, sourceCommonDir, baseRevision: input.baseRevision,
        });
        if (converged?.ok) await rm(journalPath, { force: true });
        return converged ?? existing;
      }
      return existing;
    }
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
    const registered = await findRegisteredWorktree(projectRoot, worktreePath);
    if (registered && (registered.head !== input.baseRevision || registered.locked || !registered.prunable)) {
      return {
        ok: false,
        reason: registered.head !== input.baseRevision
          ? SUPERVISION_WORKTREE_PROVISION_REASONS.BASE_MISMATCH
          : SUPERVISION_WORKTREE_PROVISION_REASONS.CREATE_FAILED,
        detail: registered.head !== input.baseRevision
          ? `registered HEAD ${registered.head ?? 'unknown'} does not match ${input.baseRevision}`
          : 'registered assignment worktree is still live or locked',
      };
    }
    // `--force` is Git's scoped recovery for one prunable registration. It
    // does not delete or overwrite a destination that reappeared with user
    // bytes; Git refuses that race. No global `worktree prune` is used.
    await git(projectRoot, [
      'worktree', 'add', ...(registered ? ['--force'] : []),
      '--detach', '--', worktreePath, input.baseRevision,
    ]);
    const head = (await git(worktreePath, ['rev-parse', 'HEAD'], 5_000)).trim().toLowerCase();
    const createdGitDir = await gitDir(worktreePath);
    if (head !== input.baseRevision || await commonDir(worktreePath) !== sourceCommonDir
      || await exists(join(createdGitDir, 'index.lock'))) {
      throw new Error('created worktree failed base/common-dir verification');
    }
    await rm(journalPath, { force: true });
    return { ok: true, worktreePath, baseRevision: head, created: true };
  } catch (error) {
    const concurrent = await convergeConcurrentProvision({
      worktreePath, assignmentRoot, sourceCommonDir, baseRevision: input.baseRevision,
    });
    if (concurrent) {
      if (concurrent.ok) await rm(journalPath, { force: true });
      return concurrent;
    }
    // Never remove an extant directory here: a crash may have been followed by
    // user writes. The journal makes the interrupted state explicit and retryable
    // when the repo path is still absent; otherwise recovery fails closed.
    return { ok: false, reason: SUPERVISION_WORKTREE_PROVISION_REASONS.CREATE_FAILED, detail: error instanceof Error ? error.message : 'git worktree add failed' };
  } finally {
    await releaseProvisionLease(leasePath, leaseAdmission.lease);
  }
}
