import { lstat, opendir, readFile, realpath, rename, rm, unlink, utimes } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  SUPERVISION_ARTIFACT_ORPHAN_GRACE_MS,
  SUPERVISION_BUNDLE_TERMINAL_RETENTION_MS,
  SUPERVISION_FINALIZED_BUNDLE_RETENTION_MS,
  SUPERVISION_FINALIZED_SCRATCH_RETENTION_MS,
  SUPERVISION_QUARANTINE_GRACE_MS,
  SUPERVISION_RETENTION_ENV,
  SUPERVISION_RETENTION_MAX_CANDIDATES_PER_ROOT,
  SUPERVISION_RETENTION_MAX_DESCENT_DEPTH,
  SUPERVISION_RETENTION_ROTATION_MS,
  SUPERVISION_RETENTION_SCAN_LIMIT,
  SUPERVISION_SCRATCH_TERMINAL_RETENTION_MS,
  SUPERVISION_WORKTREE_BACKUP_RETENTION_MS,
  isTerminalSupervisionWorktreeAssignmentStatus,
  isTerminalSupervisionWorktreeTaskStatus,
} from '../../shared/supervision-retention.js';

export type SupervisionRetentionMode = 'dryRun' | 'apply';
export type SupervisionRetentionReason =
  | 'terminal_retention_elapsed'
  | 'backup_retention_elapsed'
  | 'orphan_grace_elapsed'
  | 'active_owner'
  | 'retention_window'
  | 'unknown_owner'
  | 'invalid_layout'
  | 'quarantine_grace';

export interface SupervisionRetentionTask {
  taskId: string;
  status: string;
  updatedAt: number;
  archivedAt?: number;
  integrationBundlePath?: string;
  assignments: ReadonlyArray<{
    assignmentId: string;
    status: string;
    leaseId: string;
  }>;
}

export interface SupervisionRetentionEntry {
  kind: 'scratch' | 'bundle' | 'backup';
  key: string;
  path: string;
  action: 'retain' | 'delete';
  reason: SupervisionRetentionReason;
  bytes: number;
}

export interface SupervisionRetentionGcResult {
  mode: SupervisionRetentionMode;
  scanned: number;
  deleted: number;
  releasedBytes: number;
  retained: number;
  hasMore: boolean;
  entries: SupervisionRetentionEntry[];
}

export interface SupervisionRetentionGcInput {
  mode: SupervisionRetentionMode;
  tasks: readonly SupervisionRetentionTask[];
  scratchRoot?: string;
  bundlesRoot?: string;
  backupsRoot?: string;
  limit?: number;
  now?: number;
  /** Override defaults for deployments with different retention requirements. */
  scratchRetentionMs?: number;
  bundleRetentionMs?: number;
  finalizedScratchRetentionMs?: number;
  finalizedBundleRetentionMs?: number;
  backupRetentionMs?: number;
  orphanGraceMs?: number;
  quarantineGraceMs?: number;
  resolveTask?: (taskId: string) => SupervisionRetentionTask | undefined;
  resolveAssignment?: (assignmentId: string) => {
    task: SupervisionRetentionTask;
    assignment: SupervisionRetentionTask['assignments'][number];
  } | undefined;
}

const TASK_NAME = /^tsk_[0-9a-z]+$/;
const ASSIGNMENT_NAME = /^asg_[0-9a-z]+$/;
const BUNDLE_BUCKET = /^[0-9a-f]{2}$/;
const BUNDLE_DIGEST = /^[0-9a-f]{64}$/;
const MANIFEST_MAX_BYTES = 1024 * 1024;
const ARTIFACT_QUARANTINE = /^(.+)\.gc-[0-9]+-[0-9]+$/;
const BACKUP_PATCH = /^[0-9a-z._-]+\.patch$/i;

interface RetentionCandidate { path: string; key: string; quarantine: boolean }

interface TreeActivity { mtimeMs: number; truncated: boolean }

function imcodesHome(): string {
  return resolve(process.env.IMCODES_HOME?.trim() || join(homedir(), '.imcodes'));
}

async function directoryBytes(path: string): Promise<number> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) return info.size;
  let total = info.size;
  const dir = await opendir(path);
  try {
    for await (const entry of dir) total += await directoryBytes(join(path, entry.name));
  } finally { await dir.close().catch(() => {}); }
  return total;
}

async function latestTreeActivity(path: string): Promise<TreeActivity> {
  const pending = [{ path, depth: 0 }];
  let visited = 0;
  let mtimeMs = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    const info = await lstat(current.path);
    mtimeMs = Math.max(mtimeMs, info.mtimeMs);
    visited += 1;
    if (visited > SUPERVISION_RETENTION_MAX_CANDIDATES_PER_ROOT) {
      return { mtimeMs, truncated: true };
    }
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    if (current.depth >= SUPERVISION_RETENTION_MAX_DESCENT_DEPTH) {
      return { mtimeMs, truncated: true };
    }
    const dir = await opendir(current.path);
    try {
      for await (const entry of dir) pending.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
    } finally { await dir.close().catch(() => {}); }
  }
  return { mtimeMs, truncated: false };
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
}

async function removeManagedDirectory(root: string, path: string): Promise<void> {
  const rootReal = await realpath(root);
  const pathReal = await realpath(path);
  if (!within(rootReal, pathReal)) throw new Error('retention_path_outside_root');
  const info = await lstat(pathReal);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('retention_path_invalid');
  const quarantine = `${pathReal}.gc-${process.pid}-${Date.now()}`;
  await rename(pathReal, quarantine);
  await utimes(quarantine, new Date(), new Date());
  await rm(quarantine, { recursive: true, force: false });
}

async function listScratchCandidates(root: string): Promise<{ candidates: RetentionCandidate[]; truncated: boolean }> {
  const candidates: RetentionCandidate[] = [];
  const rootInfo = await lstat(root).catch(() => undefined);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) return { candidates, truncated: false };
  const agents = await opendir(root);
  let truncated = false;
  try {
    for await (const agent of agents) {
      if (agent.name.startsWith('.')) continue;
      const agentPath = join(root, agent.name);
      const info = await lstat(agentPath).catch(() => undefined);
      if (!info?.isDirectory() || info.isSymbolicLink()) continue;
      const entries = await opendir(agentPath);
      try {
        for await (const entry of entries) {
          if (candidates.length >= SUPERVISION_RETENTION_MAX_CANDIDATES_PER_ROOT) { truncated = true; break; }
          const path = join(agentPath, entry.name);
          const childInfo = await lstat(path).catch(() => undefined);
          if (childInfo?.isDirectory() && !childInfo.isSymbolicLink()) {
            const quarantine = ARTIFACT_QUARANTINE.exec(entry.name);
            candidates.push({ path, key: quarantine?.[1] ?? entry.name, quarantine: Boolean(quarantine) });
          }
        }
      } finally { await entries.close().catch(() => {}); }
      if (truncated) break;
    }
  } finally { await agents.close().catch(() => {}); }
  return { candidates: candidates.sort((left, right) => left.path.localeCompare(right.path)), truncated };
}

async function listBundleCandidates(root: string): Promise<{ candidates: RetentionCandidate[]; truncated: boolean }> {
  const candidates: RetentionCandidate[] = [];
  const rootInfo = await lstat(root).catch(() => undefined);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) return { candidates, truncated: false };
  const buckets = await opendir(root);
  let truncated = false;
  try {
    for await (const bucket of buckets) {
      if (!BUNDLE_BUCKET.test(bucket.name)) continue;
      const bucketPath = join(root, bucket.name);
      const info = await lstat(bucketPath).catch(() => undefined);
      if (!info?.isDirectory() || info.isSymbolicLink()) continue;
      const entries = await opendir(bucketPath);
      try {
        for await (const entry of entries) {
          if (candidates.length >= SUPERVISION_RETENTION_MAX_CANDIDATES_PER_ROOT) { truncated = true; break; }
          const quarantine = ARTIFACT_QUARANTINE.exec(entry.name);
          const key = quarantine?.[1] ?? entry.name;
          if (!BUNDLE_DIGEST.test(key) || !key.startsWith(bucket.name)) continue;
          const path = join(bucketPath, entry.name);
          const childInfo = await lstat(path).catch(() => undefined);
          if (childInfo?.isDirectory() && !childInfo.isSymbolicLink()) {
            candidates.push({ path, key, quarantine: Boolean(quarantine) });
          }
        }
      } finally { await entries.close().catch(() => {}); }
      if (truncated) break;
    }
  } finally { await buckets.close().catch(() => {}); }
  return { candidates: candidates.sort((left, right) => left.path.localeCompare(right.path)), truncated };
}

async function listBackupCandidates(root: string): Promise<{ candidates: RetentionCandidate[]; truncated: boolean }> {
  const candidates: RetentionCandidate[] = [];
  const rootInfo = await lstat(root).catch(() => undefined);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) return { candidates, truncated: false };
  const pending = [{ path: root, depth: 0 }];
  let truncated = false;
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    const dir = await opendir(current.path);
    try {
      for await (const entry of dir) {
        visited += 1;
        if (visited > SUPERVISION_RETENTION_MAX_CANDIDATES_PER_ROOT
          || candidates.length >= SUPERVISION_RETENTION_MAX_CANDIDATES_PER_ROOT) {
          truncated = true;
          break;
        }
        const path = join(current.path, entry.name);
        const info = await lstat(path).catch(() => undefined);
        if (!info || info.isSymbolicLink()) continue;
        if (info.isDirectory()) {
          if (current.depth < SUPERVISION_RETENTION_MAX_DESCENT_DEPTH) {
            pending.push({ path, depth: current.depth + 1 });
          } else truncated = true;
        } else if (info.isFile() && BACKUP_PATCH.test(entry.name)) {
          candidates.push({ path, key: relative(root, path), quarantine: false });
        }
      }
    } finally { await dir.close().catch(() => {}); }
    if (truncated) break;
  }
  return { candidates: candidates.sort((left, right) => left.path.localeCompare(right.path)), truncated };
}

function rotatingPage<T>(items: readonly T[], limit: number, now: number): T[] {
  if (items.length <= limit) return [...items];
  const offset = (Math.floor(now / SUPERVISION_RETENTION_ROTATION_MS) * limit) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)].slice(0, limit);
}

function ownerAge(task: SupervisionRetentionTask | undefined, mtimeMs: number, now: number): number {
  return now - Math.max(mtimeMs, task?.archivedAt ?? 0, task?.updatedAt ?? 0);
}

function runtimeRetentionMs(explicit: number | undefined, envName: string, fallback: number): number {
  const environment = Number.parseInt(process.env[envName] ?? '', 10);
  const configured = explicit ?? (Number.isFinite(environment) ? environment : fallback);
  return Math.max(60_000, configured);
}

async function removeManagedFile(root: string, path: string): Promise<void> {
  const rootReal = await realpath(root);
  const pathReal = await realpath(path);
  if (!within(rootReal, pathReal)) throw new Error('retention_path_outside_root');
  const info = await lstat(pathReal);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('retention_path_invalid');
  await unlink(pathReal);
}

/** Plan and optionally apply one bounded page. Unknown/recent bytes fail safe. */
export async function runSupervisionRetentionGc(
  input: SupervisionRetentionGcInput,
): Promise<SupervisionRetentionGcResult> {
  const now = input.now ?? Date.now();
  const scratchRetentionMs = runtimeRetentionMs(
    input.scratchRetentionMs,
    SUPERVISION_RETENTION_ENV.scratchMs,
    SUPERVISION_SCRATCH_TERMINAL_RETENTION_MS,
  );
  const bundleRetentionMs = runtimeRetentionMs(
    input.bundleRetentionMs,
    SUPERVISION_RETENTION_ENV.bundleMs,
    SUPERVISION_BUNDLE_TERMINAL_RETENTION_MS,
  );
  const finalizedScratchRetentionMs = runtimeRetentionMs(
    input.finalizedScratchRetentionMs,
    SUPERVISION_RETENTION_ENV.finalizedScratchMs,
    SUPERVISION_FINALIZED_SCRATCH_RETENTION_MS,
  );
  const finalizedBundleRetentionMs = runtimeRetentionMs(
    input.finalizedBundleRetentionMs,
    SUPERVISION_RETENTION_ENV.finalizedBundleMs,
    SUPERVISION_FINALIZED_BUNDLE_RETENTION_MS,
  );
  const backupRetentionMs = runtimeRetentionMs(
    input.backupRetentionMs,
    SUPERVISION_RETENTION_ENV.worktreeBackupMs,
    SUPERVISION_WORKTREE_BACKUP_RETENTION_MS,
  );
  const orphanGraceMs = Math.max(60_000, input.orphanGraceMs ?? SUPERVISION_ARTIFACT_ORPHAN_GRACE_MS);
  const quarantineGraceMs = Math.max(60_000, input.quarantineGraceMs ?? SUPERVISION_QUARANTINE_GRACE_MS);
  const limit = Math.max(1, Math.min(SUPERVISION_RETENTION_SCAN_LIMIT, Math.floor(input.limit ?? SUPERVISION_RETENTION_SCAN_LIMIT)));
  const scratchRoot = resolve(input.scratchRoot ?? join(imcodesHome(), 'scratch'));
  const bundlesRoot = resolve(input.bundlesRoot ?? join(imcodesHome(), 'supervision-integration-bundles'));
  const backupsRoot = resolve(input.backupsRoot ?? join(imcodesHome(), 'worktree-backups'));
  const tasks = new Map(input.tasks.map((task) => [task.taskId, task]));
  const assignments = new Map(input.tasks.flatMap((task) => (
    task.assignments.map((assignment) => [assignment.assignmentId, { task, assignment }] as const)
  )));
  const referencedBundles = new Map(input.tasks.flatMap((task) => (
    task.integrationBundlePath ? [[resolve(task.integrationBundlePath), task] as const] : []
  )));
  const scratch = await listScratchCandidates(scratchRoot);
  // Each independently managed root gets one bounded page. A crowded scratch
  // root must never starve immutable-bundle retention indefinitely.
  const bundles = await listBundleCandidates(bundlesRoot);
  const backups = await listBackupCandidates(backupsRoot);
  const scratchCandidates = rotatingPage(scratch.candidates, limit, now);
  const bundleCandidates = rotatingPage(bundles.candidates, limit, now);
  const backupCandidates = rotatingPage(backups.candidates, limit, now);
  const entries: SupervisionRetentionEntry[] = [];

  for (const candidate of scratchCandidates) {
    const { path, key } = candidate;
    const info = await lstat(path);
    const assignmentOwner = ASSIGNMENT_NAME.test(key)
      ? assignments.get(key) ?? input.resolveAssignment?.(key)
      : undefined;
    const taskOwner = TASK_NAME.test(key)
      ? tasks.get(key) ?? input.resolveTask?.(key)
      : assignmentOwner?.task;
    const terminal = assignmentOwner
      ? isTerminalSupervisionWorktreeAssignmentStatus(assignmentOwner.assignment.status) && !assignmentOwner.assignment.leaseId
      : taskOwner ? isTerminalSupervisionWorktreeTaskStatus(taskOwner.status) && taskOwner.assignments.every((item) => !item.leaseId) : false;
    // Ad-hoc scratch names have no durable owner. Inspect bounded descendant
    // activity so a recently edited nested file prevents deletion even when
    // the top-level directory mtime is old. A crowded tree fails safe.
    const treeActivity = !taskOwner && !assignmentOwner
      ? await latestTreeActivity(path).catch((): TreeActivity => ({ mtimeMs: info.mtimeMs, truncated: true }))
      : { mtimeMs: info.mtimeMs, truncated: false };
    const age = ownerAge(taskOwner, treeActivity.mtimeMs, now);
    const candidateScratchRetentionMs = taskOwner?.status === 'finalized'
      ? finalizedScratchRetentionMs : scratchRetentionMs;
    const reason: SupervisionRetentionReason = candidate.quarantine
      ? age < quarantineGraceMs ? 'quarantine_grace'
        : terminal ? 'terminal_retention_elapsed'
          : taskOwner || assignmentOwner ? 'active_owner'
            : treeActivity.truncated ? 'unknown_owner'
            : age >= orphanGraceMs ? 'orphan_grace_elapsed' : 'unknown_owner'
      : terminal
      ? age >= candidateScratchRetentionMs ? 'terminal_retention_elapsed' : 'retention_window'
      : taskOwner || assignmentOwner ? 'active_owner'
        : treeActivity.truncated ? 'unknown_owner'
        : age >= orphanGraceMs ? 'orphan_grace_elapsed' : 'unknown_owner';
    const action = reason === 'terminal_retention_elapsed' || reason === 'orphan_grace_elapsed' ? 'delete' : 'retain';
    const bytes = action === 'delete' ? await directoryBytes(path) : 0;
    if (input.mode === 'apply' && action === 'delete') await removeManagedDirectory(scratchRoot, path);
    entries.push({ kind: 'scratch', key, path, action, reason, bytes });
  }

  for (const candidate of bundleCandidates) {
    const { path, key } = candidate;
    const info = await lstat(path);
    let manifestTaskId: string | undefined;
    try {
      const manifestPath = join(path, 'manifest.json');
      const manifestInfo = await lstat(manifestPath);
      if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > MANIFEST_MAX_BYTES) throw new Error();
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { taskId?: unknown };
      if (typeof manifest.taskId === 'string') manifestTaskId = manifest.taskId;
    } catch { /* invalid manifests fail safe below */ }
    const task = referencedBundles.get(resolve(path))
      ?? (manifestTaskId ? tasks.get(manifestTaskId) ?? input.resolveTask?.(manifestTaskId) : undefined);
    const terminal = Boolean(task && isTerminalSupervisionWorktreeTaskStatus(task.status)
      && task.assignments.every((item) => !item.leaseId));
    const age = ownerAge(task, info.mtimeMs, now);
    const candidateBundleRetentionMs = task?.status === 'finalized'
      ? finalizedBundleRetentionMs : bundleRetentionMs;
    const reason: SupervisionRetentionReason = candidate.quarantine
      ? age < quarantineGraceMs ? 'quarantine_grace'
        : terminal ? 'terminal_retention_elapsed'
          : task ? 'active_owner'
            : age >= orphanGraceMs ? 'orphan_grace_elapsed'
              : manifestTaskId ? 'unknown_owner' : 'invalid_layout'
      : terminal
      ? age >= candidateBundleRetentionMs ? 'terminal_retention_elapsed' : 'retention_window'
      : task ? 'active_owner'
        : age >= orphanGraceMs ? 'orphan_grace_elapsed'
            : manifestTaskId ? 'unknown_owner' : 'invalid_layout';
    const action = reason === 'terminal_retention_elapsed' || reason === 'orphan_grace_elapsed' ? 'delete' : 'retain';
    const bytes = action === 'delete' ? await directoryBytes(path) : 0;
    if (input.mode === 'apply' && action === 'delete') await removeManagedDirectory(bundlesRoot, path);
    entries.push({ kind: 'bundle', key, path, action, reason, bytes });
  }

  for (const candidate of backupCandidates) {
    const info = await lstat(candidate.path);
    const expired = now - info.mtimeMs >= backupRetentionMs;
    const action = expired ? 'delete' : 'retain';
    const reason: SupervisionRetentionReason = expired ? 'backup_retention_elapsed' : 'retention_window';
    const bytes = action === 'delete' ? info.size : 0;
    if (input.mode === 'apply' && action === 'delete') await removeManagedFile(backupsRoot, candidate.path);
    entries.push({ kind: 'backup', key: candidate.key, path: candidate.path, action, reason, bytes });
  }

  return {
    mode: input.mode,
    scanned: entries.length,
    deleted: entries.filter((entry) => entry.action === 'delete').length,
    releasedBytes: entries.filter((entry) => entry.action === 'delete').reduce((sum, entry) => sum + entry.bytes, 0),
    retained: entries.filter((entry) => entry.action === 'retain').length,
    hasMore: scratch.truncated || bundles.truncated || backups.truncated
      || scratch.candidates.length > scratchCandidates.length
      || bundles.candidates.length > bundleCandidates.length
      || backups.candidates.length > backupCandidates.length,
    entries,
  };
}
