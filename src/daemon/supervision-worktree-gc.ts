import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { TASK_PAIR_WORKTREE_PREFIX } from '../../shared/task-pair.js';
import type { SupervisionRetentionGcResult } from './supervision-retention-gc.js';
import {
  SUPERVISION_QUARANTINE_GRACE_MS,
  SUPERVISION_WORKTREE_HANDOFF_GRACE_MS,
  isTerminalSupervisionWorktreeAssignmentStatus,
  isTerminalSupervisionWorktreeTaskStatus,
} from '../../shared/supervision-retention.js';
import { execFileOffMain as execFileAsync } from '../util/exec-helper.js';
import { imcodesStateDir } from '../util/imcodes-state-dir.js';


export const SUPERVISION_WORKTREE_GC_DEFAULT_LIMIT = 25 as const;
export const SUPERVISION_WORKTREE_GC_MAX_LIMIT = 100 as const;
export const SUPERVISION_WORKTREE_GC_MAX_PROJECTS = 32 as const;
export const SUPERVISION_WORKTREE_GC_MAX_SESSIONS = 128 as const;
export const SUPERVISION_WORKTREE_GC_MAX_ASSIGNMENTS = 512 as const;
export const SUPERVISION_WORKTREE_GC_MAX_COMMON_DIRS = 4 as const;
export const SUPERVISION_WORKTREE_GC_LOCK_STALE_MS = 10 * 60_000;
export const SUPERVISION_WORKTREE_GC_ORPHAN_GRACE_MS = 24 * 60 * 60_000;
export const SUPERVISION_WORKTREE_GC_MAX_BACKUP_PATCH_BYTES = 16 * 1024 * 1024;

// Pair worktrees (`pair_<taskId>`, task-pairs/workspace.ts) are registered here
// too; their owner is the pair store, not the legacy registry.
const ASSIGNMENT_NAME = new RegExp(`^(?:supervision_assignment_[0-9a-z-]+|asg_[0-9a-z]+|${TASK_PAIR_WORKTREE_PREFIX}[0-9a-z_-]+)$`);
const SESSION_NAME = /^deck_[0-9a-z_-]+$/i;
const EVIDENCE_NAME = /^evidence(?:-[0-9a-z_.-]+)?$/i;
const METADATA_MAX_BYTES = 16 * 1024;
const JOURNAL_VERSION = 1 as const;
const QUARANTINED_ASSIGNMENT_NAME = new RegExp(`^((?:supervision_assignment_[0-9a-z-]+|asg_[0-9a-z]+|${TASK_PAIR_WORKTREE_PREFIX}[0-9a-z_-]+))\\.gc-[0-9a-z-]+$`);

export const SUPERVISION_WORKTREE_GC_REASONS = Object.freeze({
  ELIGIBLE: 'eligible',
  REGISTRY_UNAVAILABLE: 'registry_unavailable',
  UNKNOWN_OWNER: 'unknown_owner',
  PROJECT_MISMATCH: 'project_mismatch',
  ACTIVE_REFERENCE: 'active_reference',
  ACTIVE_LEASE: 'active_lease',
  ACTIVE_CLAIMS: 'active_claims',
  INCOMPLETE_AUTHORITY: 'incomplete_authority',
  PENDING_COMPLETION_EVIDENCE: 'pending_completion_evidence',
  MANIFEST_MISMATCH: 'manifest_mismatch',
  INVALID_LAYOUT: 'invalid_layout',
  UNIQUE_EVIDENCE: 'unique_evidence',
  UNKNOWN_CONTENT: 'unknown_content',
  GIT_UNAVAILABLE: 'git_unavailable',
  GIT_UNREGISTERED: 'git_unregistered',
  GIT_LOCKED: 'git_locked',
  DIRTY: 'dirty',
  UNTRACKED: 'untracked',
  BRANCH_ONLY: 'branch_only',
  UNPUSHED_BRANCH: 'unpushed_branch',
  PROTECTED_PATH: 'protected_path',
  CONCURRENT_RUN: 'concurrent_run',
  APPLY_FAILED: 'apply_failed',
  RECOVERY_BLOCKED: 'recovery_blocked',
  BACKUP_FAILED: 'backup_failed',
} as const);

export type SupervisionWorktreeGcReason =
  typeof SUPERVISION_WORKTREE_GC_REASONS[keyof typeof SUPERVISION_WORKTREE_GC_REASONS];
export type SupervisionWorktreeGcMode = 'dryRun' | 'apply';

export interface SupervisionWorktreeMetadata {
  taskId: string;
  assignmentId: string;
  sessionName: string;
  baseRevision: string;
  repoPath: string;
  createdAt: string;
}

export interface SupervisionWorktreeRegistryReference {
  available: boolean;
  assignment?: {
    assignmentId: string;
    taskId: string;
    status: string;
    leaseId: string;
    role?: string;
    auditAttemptId?: string;
    auditRevision?: string;
    verdict?: string;
    updatedAt?: number;
  };
  task?: {
    taskId: string;
    projectName: string;
    status: string;
    archivedAt?: number;
    commitSha?: string;
    pushRemoteRef?: string;
    finalization?: {
      revision: string;
      auditAttemptId: string;
      auditRevision: string;
      verdict: string;
      integrationManifest: ReadonlyArray<{ path: string; sha256: string }>;
      commitSha: string;
      pushResult: string;
      pushRemoteRef: string;
      ciResult?: import('../../shared/supervision-config.js').SupervisionCiSmokeStatus;
    };
    assignments: ReadonlyArray<{
      assignmentId: string;
      status: string;
      leaseId: string;
      role?: string;
      auditAttemptId?: string;
      auditRevision?: string;
      verdict?: string;
      updatedAt?: number;
    }>;
  };
  claims?: ReadonlyArray<{ assignmentId: string; path: string }>;
  auditReceipts?: ReadonlyArray<{
    assignmentId: string;
    attemptId: string;
    revision: string;
    receiptKind: string;
    verdict?: string;
  }>;
  completionEvidence?: ReadonlyArray<{
    sourceAssignmentId: string;
    status: string;
    adoptedByAssignmentId?: string;
    revision?: string;
    files?: ReadonlyArray<{ path: string; sha256?: string; deleted?: true }>;
  }>;
}

/** What the pair store knows about the pair that owns a `pair_…` worktree. */
export interface TaskPairWorktreeReference {
  available: boolean;
  found?: boolean;
  projectName?: string;
  /** DONE or CANCEL: the worktree is no longer in use. */
  terminal?: boolean;
  /** The pair ended at least the workspace retention (7 days) ago. */
  retentionElapsed?: boolean;
}

export interface SupervisionWorktreeGitInspection {
  ok: boolean;
  reason?: SupervisionWorktreeGcReason;
  commonDir?: string;
  registered?: boolean;
  locked?: boolean;
  dirty?: boolean;
  untracked?: boolean;
  branchOnly?: boolean;
  unpushed?: boolean;
  /** Test/embedding seam: caller already verified the immutable finalization. */
  finalizationVerified?: boolean;
}

export interface SupervisionWorktreeGcEntry {
  key: string;
  assignmentId: string;
  taskId?: string;
  path: string;
  repoPath: string;
  action: 'retain' | 'delete';
  reason: SupervisionWorktreeGcReason;
  detail?: string;
}

export interface SupervisionWorktreeGcResult {
  mode: SupervisionWorktreeGcMode;
  runId: string;
  root: string;
  scanned: number;
  mutations: number;
  deleted: number;
  releasedBytes: number;
  retained: number;
  hasMore: boolean;
  nextCursor?: string;
  lock: 'acquired' | 'not_required' | 'busy';
  registryAvailable: boolean;
  entries: SupervisionWorktreeGcEntry[];
  staleRegistrations: string[];
  diagnostics: Array<{ code: string; assignmentId?: string }>;
  /** Bounded scratch/bundle retention page, exposed by the housekeeping tool. */
  artifactRetention?: SupervisionRetentionGcResult;
}

export interface SupervisionWorktreeGcInput {
  projectName: string;
  mode?: SupervisionWorktreeGcMode;
  cursor?: string;
  limit?: number;
  worktreesRoot?: string;
}

interface GitRunResult { ok: boolean; stdout: string; stderr: string }

export interface SupervisionWorktreeGcDeps {
  resolveRegistryReference: (
    metadata: SupervisionWorktreeMetadata,
  ) => Promise<SupervisionWorktreeRegistryReference> | SupervisionWorktreeRegistryReference;
  resolveRegistryReferenceByAssignment?: (input: {
    assignmentId: string;
    sessionName: string;
    repoPath: string;
  }) => Promise<SupervisionWorktreeRegistryReference> | SupervisionWorktreeRegistryReference;
  countTaskPairUnpushedCommits?: (repoPath: string, baseRevision: string) => Promise<number | undefined>;
  /** Count pair commits not integrated into any local or remote branch. */
  countTaskPairCommitsNotInAnyBranch?: (repoPath: string, baseRevision: string) => Promise<number | undefined>;
  /** @deprecated Use countTaskPairCommitsNotInAnyBranch. Kept for test/extension compatibility. */
  countTaskPairCommitsNotInDev?: (repoPath: string, baseRevision: string) => Promise<number | undefined>;
  /** Owner lookup for pair worktrees; without it they are never touched. */
  resolveTaskPairWorktree?: (input: { taskId: string; repoPath: string }) => Promise<TaskPairWorktreeReference> | TaskPairWorktreeReference;
  protectedPaths?: readonly string[];
  /** Production-only opt-in: preserve local-only bytes, then reclaim terminal owners. */
  preserveTerminalChanges?: boolean;
  /** Production-only opt-in: reclaim old paths whose durable owner no longer exists. */
  reclaimOrphans?: boolean;
  backupsRoot?: string;
  orphanGraceMs?: number;
  handoffGraceMs?: number;
  quarantineGraceMs?: number;
  maxBackupPatchBytes?: number;
  listExternalOrphanWorktrees?: (projectName: string) => Promise<readonly string[]> | readonly string[];
  now?: () => number;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
  yieldControl?: () => Promise<void>;
  inspectGit?: (repoPath: string) => Promise<SupervisionWorktreeGitInspection>;
  removeRegisteredWorktree?: (inspection: SupervisionWorktreeGitInspection, repoPath: string) => Promise<boolean>;
  pruneRegistrations?: (commonDir: string, apply: boolean) => Promise<string[]>;
  removeDirectory?: (path: string) => Promise<void>;
  measureDirectoryBytes?: (path: string) => Promise<number>;
  onScanOperation?: (operation: 'project' | 'session' | 'assignment' | 'registry' | 'git') => void;
  sweepRetainedArtifacts?: (
    mode: SupervisionWorktreeGcMode,
    limit: number,
  ) => Promise<SupervisionRetentionGcResult>;
}

interface CandidatePath {
  key: string;
  assignmentId: string;
  candidatePath: string;
  repoPath: string;
  sessionName: string;
  external?: boolean;
  quarantine?: boolean;
}

interface GcJournal {
  version: typeof JOURNAL_VERSION;
  runId: string;
  state: 'planned' | 'git_removed' | 'quarantined';
  candidatePath: string;
  repoPath: string;
  assignmentId: string;
  taskId: string;
  projectName: string;
  metadataText: string;
  sessionName?: string;
  quarantinePath?: string;
  updatedAt: number;
  candidateBytes?: number;
  orphan?: boolean;
  external?: boolean;
}

/** Where the daemon puts every pair worktree (`~/.imcodes/worktrees`). */
export function defaultWorktreesRoot(): string {
  return resolve(imcodesStateDir(), 'worktrees');
}

function defaultBackupsRoot(): string {
  return resolve(imcodesStateDir(), 'worktree-backups');
}

async function safeExternalIntegrationPath(path: string): Promise<boolean> {
  const candidate = await realpath(path).catch(() => resolve(path));
  const temporaryRoot = await realpath(tmpdir()).catch(() => resolve(tmpdir()));
  return relative(temporaryRoot, candidate).split(/[\\/]/)[0] !== '..'
    && /^imcodes-integration-[0-9a-z._-]+$/i.test(basename(candidate));
}

function boundedLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return SUPERVISION_WORKTREE_GC_DEFAULT_LIMIT;
  return Math.max(1, Math.min(SUPERVISION_WORKTREE_GC_MAX_LIMIT, Math.floor(value!)));
}

function safeErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'worktree_gc_failed';
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function nextTurn(): Promise<void> {
  return new Promise((resolveTurn) => setImmediate(resolveTurn));
}

async function runGit(cwd: string, args: readonly string[]): Promise<GitRunResult> {
  try {
    const result = await execFileAsync('git', [...args], {
      cwd,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const candidate = error as { stdout?: unknown; stderr?: unknown };
    return {
      ok: false,
      stdout: typeof candidate.stdout === 'string' ? candidate.stdout : '',
      stderr: typeof candidate.stderr === 'string' ? candidate.stderr : '',
    };
  }
}

async function runGitWithIndex(
  repoPath: string,
  indexPath: string,
  args: readonly string[],
  maxBuffer = 1024 * 1024,
): Promise<{ ok: boolean; stdout: Buffer }> {
  try {
    const result = await execFileAsync('git', ['-C', repoPath, ...args], {
      timeout: 30_000,
      maxBuffer,
      encoding: 'buffer',
      env: { ...process.env, GIT_INDEX_FILE: indexPath },
    });
    return {
      ok: true,
      stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout),
    };
  } catch {
    return { ok: false, stdout: Buffer.alloc(0) };
  }
}

function safeBackupSegment(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^0-9a-z._-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized.slice(0, 96) || 'unknown';
}

async function preserveCandidateState(
  candidate: CandidatePath,
  inspection: SupervisionWorktreeGitInspection,
  projectName: string,
  deps: SupervisionWorktreeGcDeps,
): Promise<{ ok: boolean; detail?: string }> {
  const backupRoot = resolve(deps.backupsRoot ?? defaultBackupsRoot());
  const assignment = safeBackupSegment(candidate.assignmentId);
  const targetDir = join(backupRoot, safeBackupSegment(projectName), safeBackupSegment(candidate.sessionName));
  await mkdir(targetDir, { recursive: true, mode: 0o700 });

  const head = await runGit(candidate.repoPath, ['rev-parse', '--verify', 'HEAD']);
  if (!head.ok || !/^[0-9a-f]{40}$/.test(head.stdout.trim())) return { ok: false, detail: 'head_unavailable' };
  const headSha = head.stdout.trim();
  const artifacts: string[] = [];
  if (inspection.branchOnly || inspection.unpushed) {
    const ref = `refs/backup/worktrees/${assignment}-${headSha.slice(0, 12)}`;
    const saved = await runGit(candidate.repoPath, ['update-ref', ref, headSha]);
    if (!saved.ok) return { ok: false, detail: 'backup_ref_failed' };
    artifacts.push(ref);
  }

  if (inspection.dirty || inspection.untracked) {
    const maxBytes = Math.max(1024, Math.min(
      deps.maxBackupPatchBytes ?? SUPERVISION_WORKTREE_GC_MAX_BACKUP_PATCH_BYTES,
      SUPERVISION_WORKTREE_GC_MAX_BACKUP_PATCH_BYTES,
    ));
    const nonce = randomUUID();
    const indexPath = join(targetDir, `.${assignment}-${nonce}.index`);
    try {
      const readTree = await runGitWithIndex(candidate.repoPath, indexPath, ['read-tree', 'HEAD']);
      if (!readTree.ok) return { ok: false, detail: 'backup_index_failed' };
      const staged = await runGitWithIndex(candidate.repoPath, indexPath, ['add', '-A', '--', '.']);
      if (!staged.ok) return { ok: false, detail: 'backup_stage_failed' };
      const diff = await runGitWithIndex(
        candidate.repoPath,
        indexPath,
        ['diff', '--cached', '--binary', '--full-index', 'HEAD', '--'],
        maxBytes + 1,
      );
      if (!diff.ok || diff.stdout.length > maxBytes) return { ok: false, detail: 'backup_patch_too_large' };
      if (diff.stdout.length === 0) return { ok: false, detail: 'backup_patch_empty' };
      const patchPath = join(targetDir, `${assignment}-${headSha.slice(0, 12)}-${nonce}.patch`);
      await writeFile(patchPath, diff.stdout, { mode: 0o600 });
      artifacts.push(patchPath);
    } finally {
      await unlink(indexPath).catch(() => {});
      await unlink(`${indexPath}.lock`).catch(() => {});
    }
  }
  return { ok: true, detail: artifacts.join(',') || 'no_local_only_bytes' };
}

async function directoryBytes(path: string): Promise<number> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return info.size;
  if (!info.isDirectory()) return info.size;
  let total = info.size;
  const handle = await opendir(path);
  try {
    for await (const entry of handle) total += await directoryBytes(join(path, entry.name));
  } finally {
    await handle.close().catch(() => {});
  }
  return total;
}

function terminalAssignmentReason(
  reference: SupervisionWorktreeRegistryReference,
  assignmentId: string,
  now: number,
  handoffGraceMs: number,
): SupervisionWorktreeGcReason | undefined {
  const assignment = reference.assignment;
  const task = reference.task;
  if (!assignment || !task || assignment.assignmentId !== assignmentId) {
    return SUPERVISION_WORKTREE_GC_REASONS.INCOMPLETE_AUTHORITY;
  }
  if (assignment.leaseId) return SUPERVISION_WORKTREE_GC_REASONS.ACTIVE_LEASE;
  if (!isTerminalSupervisionWorktreeAssignmentStatus(assignment.status)) {
    return SUPERVISION_WORKTREE_GC_REASONS.ACTIVE_REFERENCE;
  }
  if ((reference.claims ?? []).some((claim) => claim.assignmentId === assignmentId)) {
    return SUPERVISION_WORKTREE_GC_REASONS.ACTIVE_CLAIMS;
  }
  if ((reference.completionEvidence ?? []).some((record) => (
    record.sourceAssignmentId === assignmentId && record.status === 'pending'
  ))) return SUPERVISION_WORKTREE_GC_REASONS.PENDING_COMPLETION_EVIDENCE;
  if (assignment.status === 'cancelled' || assignment.status === 'recovered') {
    const completionResolved = (reference.completionEvidence ?? []).some((record) => (
      record.sourceAssignmentId === assignmentId
      && (record.status === 'adopted' || record.status === 'discarded')
    ));
    if (!completionResolved && !isTerminalSupervisionWorktreeTaskStatus(task.status)) {
      const activeSibling = task.assignments.some((candidate) => (
        candidate.assignmentId !== assignmentId
        && !isTerminalSupervisionWorktreeAssignmentStatus(candidate.status)
      ));
      const age = typeof assignment.updatedAt === 'number' ? now - assignment.updatedAt : 0;
      if (activeSibling && age < handoffGraceMs) {
        return SUPERVISION_WORKTREE_GC_REASONS.ACTIVE_REFERENCE;
      }
    }
  }
  return undefined;
}

function taskHasMergedAuthority(reference: SupervisionWorktreeRegistryReference): boolean {
  const task = reference.task;
  const finalization = task?.finalization;
  if (task?.status !== 'finalized' || !finalization) return false;
  if (!/^[0-9a-f]{40}$/.test(task.commitSha ?? '')
    || finalization.commitSha !== task.commitSha) return false;
  return finalization.pushResult === 'pushed' || finalization.pushResult === 'already_present';
}

async function getWorktreeBlocksByCanonicalPath(
  repoPath: string,
  cache?: TaskPairBranchPatchCacheImpl,
): Promise<Map<string, string> | undefined> {
  const buildMap = async () => {
    const worktreeResult = await runGit(repoPath, ['worktree', 'list', '--porcelain']);
    if (!worktreeResult.ok) return undefined;
    const blocks = worktreeResult.stdout.split(/\n\n+/u);
    const resolved = await Promise.all(blocks.map(async (block) => {
      const worktreeLine = block.split('\n').find((line) => line.startsWith('worktree '));
      if (!worktreeLine) return undefined;
      const listed = await realpath(worktreeLine.slice('worktree '.length)).catch(() => undefined);
      return listed ? [listed, block] as const : undefined;
    }));
    const map = new Map<string, string>();
    for (const entry of resolved) {
      if (entry) map.set(entry[0], entry[1]);
    }
    return map;
  };
  if (!cache) return buildMap();
  const commonDir = await resolveGitCommonDir(repoPath, cache);
  let promise = cache.worktreeBlocksByCommonDir.get(commonDir);
  if (!promise) {
    promise = buildMap();
    cache.worktreeBlocksByCommonDir.set(commonDir, promise);
  }
  return promise;
}

export async function inspectSupervisionGitWorktree(
  repoPath: string,
  options?: { cache?: TaskPairBranchPatchCache; skipRemoteCheck?: boolean },
): Promise<SupervisionWorktreeGitInspection> {
  const cache = options?.cache instanceof TaskPairBranchPatchCacheImpl ? options.cache : undefined;
  const [inside, statusResult, commonResult] = await Promise.all([
    runGit(repoPath, ['rev-parse', '--is-inside-work-tree']),
    runGit(repoPath, ['status', '--porcelain=v2', '--untracked-files=all']),
    runGit(repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  ]);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return { ok: false, reason: SUPERVISION_WORKTREE_GC_REASONS.GIT_UNAVAILABLE };
  }
  if (!statusResult.ok) return { ok: false, reason: SUPERVISION_WORKTREE_GC_REASONS.GIT_UNAVAILABLE };
  const statusLines = statusResult.stdout.split('\n').filter(Boolean);
  const untracked = statusLines.some((line) => line.startsWith('? '));
  const dirty = statusLines.some((line) => !line.startsWith('? '));

  if (!commonResult.ok || !commonResult.stdout.trim()) {
    return { ok: false, reason: SUPERVISION_WORKTREE_GC_REASONS.GIT_UNAVAILABLE };
  }
  const commonDir = resolve(repoPath, commonResult.stdout.trim());
  const blockMap = await getWorktreeBlocksByCanonicalPath(repoPath, cache);
  if (!blockMap) return { ok: false, reason: SUPERVISION_WORKTREE_GC_REASONS.GIT_UNAVAILABLE };
  const canonicalRepoPath = await realpath(repoPath).catch(() => undefined);
  const block = canonicalRepoPath ? blockMap.get(canonicalRepoPath) : undefined;
  const locked = block?.split('\n').some((line) => line === 'locked' || line.startsWith('locked ')) ?? false;

  let branchOnly = false;
  let unpushed = false;
  if (!options?.skipRemoteCheck) {
    const branch = await runGit(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (branch.ok && branch.stdout.trim()) {
      const upstream = await runGit(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
      if (!upstream.ok || !upstream.stdout.trim()) {
        branchOnly = true;
      } else {
        const ahead = await runGit(repoPath, ['rev-list', '--count', '@{upstream}..HEAD']);
        unpushed = !ahead.ok || Number.parseInt(ahead.stdout.trim(), 10) > 0;
      }
    } else {
      const remoteContains = await runGit(repoPath, ['for-each-ref', '--format=%(refname)', '--contains', 'HEAD', 'refs/remotes']);
      unpushed = !remoteContains.ok || remoteContains.stdout.trim().length === 0;
    }
  }

  return {
    ok: true,
    commonDir,
    registered: Boolean(block),
    locked,
    dirty,
    untracked,
    branchOnly,
    unpushed,
  };
}

/**
 * Commits a pair's executor made (`base..HEAD`) that no remote has. Unlike the
 * generic `unpushed` check this ignores the base itself, so a worktree at an
 * untouched base in a project without any remote holds nothing unique.
 * Undefined when git cannot answer (callers then keep the worktree).
 */
export async function countTaskPairUnpushedCommits(repoPath: string, baseRevision: string): Promise<number | undefined> {
  const result = await runGit(repoPath, ['rev-list', '--count', `${baseRevision}..HEAD`, '--not', '--remotes']);
  if (!result.ok) return undefined;
  const count = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(count) ? count : undefined;
}

/** The integration ref a worktree's commits are measured against unless a caller names another. */
export const TASK_PAIR_DEFAULT_INTEGRATION_REF = 'origin/dev' as const;

/**
 * The executor commits after `baseRevision` (up to `head`, default HEAD) that are neither reachable from nor
 * patch-equivalent to `integrationRef` (default origin/dev): what Brain has not integrated yet. Oldest first.
 * `undefined` when git cannot tell (unknown revision, missing ref, timeout).
 */
export async function listTaskPairCommitsNotInIntegration(
  repoPath: string,
  baseRevision: string,
  options: { integrationRef?: string; head?: string } = {},
): Promise<string[] | undefined> {
  const head = options.head ?? 'HEAD';
  const integrationRef = options.integrationRef ?? TASK_PAIR_DEFAULT_INTEGRATION_REF;
  const commits = await runGit(repoPath, ['rev-list', '--reverse', `${baseRevision}..${head}`]);
  if (!commits.ok) return undefined;
  const hashes = commits.stdout.trim().split(/\s+/u).filter(Boolean);
  if (hashes.length === 0) return [];
  const cherry = await runGit(repoPath, ['cherry', integrationRef, head]);
  if (!cherry.ok) return undefined;
  const unique = new Set(cherry.stdout.split(/\r?\n/u).flatMap((line) => {
    const match = /^\+\s+([0-9a-f]{40})$/u.exec(line.trim());
    return match ? [match[1]] : [];
  }));
  return hashes.filter((hash) => unique.has(hash));
}

/** Runs one git command in `cwd`; the worktree GC's own `runGit` by default, a caller's off-main/injected runner otherwise. */
export type TaskPairGitRunner = (cwd: string, args: readonly string[]) => Promise<{ ok: boolean; stdout: string }>;

export interface TaskPairBranchRef {
  /** Full ref name (`refs/heads/dev`, `refs/remotes/origin/dev`). */
  ref: string;
  /** The commit the branch points at. */
  tip: string;
}

/** `refs/heads/dev` -> `dev`, `refs/remotes/origin/dev` -> `origin/dev`. */
export function shortTaskPairBranchName(ref: string): string {
  return ref.replace(/^refs\/(?:heads|remotes)\//u, '');
}

/**
 * Every local and remote branch (newest commit first, at most `limit`; a remote's symbolic `HEAD` is left out, it only repeats another
 * branch). The one enumeration shared by the worktree GC and the integration reminder, so both read the same set of "branches".
 * `undefined` when git cannot tell.
 */
export async function listTaskPairBranchRefs(
  repoPath: string,
  options: { limit?: number; run?: TaskPairGitRunner } = {},
): Promise<TaskPairBranchRef[] | undefined> {
  const run = options.run ?? runGit;
  const out = await run(repoPath, ['for-each-ref', '--sort=-committerdate', `--count=${options.limit ?? 2_000}`, '--format=%(objectname) %(refname)', 'refs/heads', 'refs/remotes']);
  if (!out.ok) return undefined;
  const refs: TaskPairBranchRef[] = [];
  for (const line of out.stdout.split(/\r?\n/u)) {
    const match = /^([0-9a-f]{40,64}) (\S+)$/u.exec(line.trim());
    if (!match || /^refs\/remotes\/[^/]+\/HEAD$/u.test(match[2]!)) continue;
    refs.push({ ref: match[2]!, tip: match[1]! });
  }
  return refs;
}

/**
 * The branches (local and remote) that contain `head` as an ancestor, in ONE git call however many branches the repository has.
 * `undefined` when git cannot tell.
 */
export async function listTaskPairBranchesContaining(
  repoPath: string,
  head: string,
  options: { run?: TaskPairGitRunner } = {},
): Promise<string[] | undefined> {
  const run = options.run ?? runGit;
  const out = await run(repoPath, ['for-each-ref', '--contains', head, '--format=%(refname)', 'refs/heads', 'refs/remotes']);
  if (!out.ok) return undefined;
  return out.stdout.split(/\r?\n/u).map((ref) => ref.trim()).filter((ref) => ref && !/^refs\/remotes\/[^/]+\/HEAD$/u.test(ref));
}

const PRIMARY_TASK_PAIR_INTEGRATION_REFS = [
  'refs/heads/dev',
  'refs/remotes/origin/dev',
  'refs/heads/main',
  'refs/remotes/origin/main',
  'refs/heads/master',
  'refs/remotes/origin/master',
] as const;
const PATCH_ID_STREAM_TIMEOUT_MS = 60_000;
const CONTAINS_BATCH_SIZE = 64;
const CHERRY_FALLBACK_CONCURRENCY = 8;
const PATCH_INDEX_SHARD_MIN_COMMITS = 64;
const PATCH_INDEX_MAX_SHARDS = 6;
const EMPTY_DIFF_PATCH_KEY = '__empty_diff__';

export interface TaskPairBranchPatchCache {
  /** Register a worktree and its base revision before scanning a sweep so the repo anchor can be computed once. */
  registerWorktreeBase(worktreePath: string, baseRevision: string): void;
}

interface CommonDirPatchIndex {
  ready: Promise<void>;
  anchor: string | undefined;
  patchIdToCommits: Promise<Map<string, string[]> | undefined>;
}

class TaskPairBranchPatchCacheImpl implements TaskPairBranchPatchCache {
  readonly commonDirPromises = new Map<string, Promise<string | undefined>>();
  readonly branchRefsByCommonDir = new Map<string, Promise<TaskPairBranchRef[] | undefined>>();
  readonly worktreeBlocksByCommonDir = new Map<string, Promise<Map<string, string> | undefined>>();
  readonly containsRefsByCommonDirKey = new Map<string, Promise<Set<string> | undefined>>();
  readonly patchIndexByCommonDir = new Map<string, CommonDirPatchIndex>();
  readonly registeredWorktrees: Array<{ worktreePath: string; baseRevision: string }> = [];

  registerWorktreeBase(worktreePath: string, baseRevision: string): void {
    if (!worktreePath || !baseRevision) return;
    this.registeredWorktrees.push({ worktreePath, baseRevision });
  }
}

/** Create a sweep-scoped cache sharing branch ref enumerations and patch-id scans per git commonDir. */
export function createTaskPairBranchPatchCache(): TaskPairBranchPatchCache {
  return new TaskPairBranchPatchCacheImpl();
}

function parseGitCherryUnique(stdout: string): Set<string> {
  return new Set(stdout.split(/\r?\n/u).flatMap((line) => {
    const match = /^\+\s+([0-9a-f]{40,64})$/u.exec(line.trim());
    return match ? [match[1]!] : [];
  }));
}

async function resolveGitCommonDir(repoPath: string, cache?: TaskPairBranchPatchCacheImpl): Promise<string> {
  if (!cache) {
    const out = await runGit(repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    return out.ok && out.stdout.trim() ? out.stdout.trim() : repoPath;
  }
  let promise = cache.commonDirPromises.get(repoPath);
  if (!promise) {
    promise = runGit(repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
      .then((out) => (out.ok && out.stdout.trim() ? out.stdout.trim() : repoPath));
    cache.commonDirPromises.set(repoPath, promise);
  }
  return (await promise) ?? repoPath;
}

function streamPatchIdPipeline(
  repoPath: string,
  producerArgs: readonly string[],
  stdinInput?: string,
  timeoutMs = PATCH_ID_STREAM_TIMEOUT_MS,
): Promise<Map<string, string> | undefined> {
  return new Promise((resolvePromise) => {
    const producerChild = spawn(
      'git',
      ['-C', repoPath, '-c', 'color.ui=false', '-c', 'log.showSignature=false', ...producerArgs],
      { stdio: [stdinInput !== undefined ? 'pipe' : 'ignore', 'pipe', 'ignore'] },
    );
    const patchChild = spawn(
      'git',
      ['patch-id', '--stable'],
      { cwd: repoPath, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    let settled = false;
    let producerExited = false;
    let producerCode: number | null = null;
    let patchExited = false;
    let patchCode: number | null = null;
    let stdout = '';
    const finish = (result: Map<string, string> | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const killBoth = () => {
      try { if (!producerChild.killed && producerChild.exitCode === null) producerChild.kill('SIGKILL'); } catch { /* ignore */ }
      try { if (!patchChild.killed && patchChild.exitCode === null) patchChild.kill('SIGKILL'); } catch { /* ignore */ }
    };
    const timer = setTimeout(() => {
      killBoth();
      finish(undefined);
    }, timeoutMs);
    timer.unref?.();

    const maybeComplete = () => {
      if (!producerExited || !patchExited) return;
      if (producerCode !== 0 || patchCode !== 0) {
        finish(undefined);
        return;
      }
      const map = new Map<string, string>();
      for (const line of stdout.split(/\r?\n/u)) {
        const match = /^([0-9a-f]{40,64})\s+([0-9a-f]{40,64})$/u.exec(line.trim());
        if (match) map.set(match[2]!, match[1]!);
      }
      finish(map);
    };

    if (!producerChild.stdout || !patchChild.stdin || !patchChild.stdout) {
      killBoth();
      finish(undefined);
      return;
    }
    producerChild.stdout.pipe(patchChild.stdin);
    producerChild.stdout.on('error', () => { killBoth(); finish(undefined); });
    if (stdinInput !== undefined && producerChild.stdin) {
      producerChild.stdin.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'EPIPE') return;
        killBoth();
        finish(undefined);
      });
      producerChild.stdin.end(stdinInput);
    }
    patchChild.stdin.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'EPIPE') return;
      killBoth();
      finish(undefined);
    });
    patchChild.stdout.setEncoding('utf8');
    patchChild.stdout.on('data', (chunk: string) => { stdout += chunk; });
    producerChild.on('error', () => { killBoth(); finish(undefined); });
    patchChild.on('error', () => { killBoth(); finish(undefined); });
    producerChild.on('close', (code) => { producerExited = true; producerCode = code; maybeComplete(); });
    patchChild.on('close', (code) => { patchExited = true; patchCode = code; maybeComplete(); });
  });
}

function streamCommitPatchIdsFromList(
  repoPath: string,
  commits: readonly string[],
  timeoutMs = PATCH_ID_STREAM_TIMEOUT_MS,
): Promise<Map<string, string> | undefined> {
  if (commits.length === 0) return Promise.resolve(new Map());
  return streamPatchIdPipeline(
    repoPath,
    ['diff-tree', '--stdin', '-p', '--root', '--no-ext-diff', '--no-color', '--no-merges'],
    `${commits.join('\n')}\n`,
    timeoutMs,
  );
}

function dedupeBranchRefsByTip(listed: readonly TaskPairBranchRef[]): {
  primaryRefs: TaskPairBranchRef[];
  remainingRefs: TaskPairBranchRef[];
} {
  const byRef = new Map<string, TaskPairBranchRef>();
  for (const entry of listed) {
    if (!byRef.has(entry.ref)) byRef.set(entry.ref, entry);
  }
  const seenTips = new Set<string>();
  const primaryRefs: TaskPairBranchRef[] = [];
  for (const name of PRIMARY_TASK_PAIR_INTEGRATION_REFS) {
    const entry = byRef.get(name);
    if (!entry || seenTips.has(entry.tip)) continue;
    seenTips.add(entry.tip);
    primaryRefs.push(entry);
  }
  const remainingRefs: TaskPairBranchRef[] = [];
  for (const entry of listed) {
    if (seenTips.has(entry.tip)) continue;
    seenTips.add(entry.tip);
    remainingRefs.push(entry);
  }
  return { primaryRefs, remainingRefs };
}

async function checkRefsWithCherry(
  repoPath: string,
  head: string,
  refs: readonly TaskPairBranchRef[],
  hashes: readonly string[],
  initialBest: string[],
  concurrency = 1,
): Promise<string[]> {
  let best = initialBest;
  if (refs.length === 0 || best.length === 0) return best;
  if (concurrency <= 1) {
    for (const entry of refs) {
      const cherry = await runGit(repoPath, ['cherry', entry.ref, head]);
      if (!cherry.ok) continue;
      const unique = parseGitCherryUnique(cherry.stdout);
      const uniquePairCommits = hashes.filter((hash) => unique.has(hash));
      if (uniquePairCommits.length === 0) return [];
      if (uniquePairCommits.length < best.length) best = uniquePairCommits;
    }
    return best;
  }
  let index = 0;
  let stopped = false;
  const workerCount = Math.min(concurrency, refs.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (!stopped) {
      const currentIndex = index++;
      if (currentIndex >= refs.length) return;
      const entry = refs[currentIndex]!;
      const cherry = await runGit(repoPath, ['cherry', entry.ref, head]);
      if (stopped || !cherry.ok) continue;
      const unique = parseGitCherryUnique(cherry.stdout);
      const uniquePairCommits = hashes.filter((hash) => unique.has(hash));
      if (uniquePairCommits.length === 0) {
        best = [];
        stopped = true;
        return;
      }
      if (uniquePairCommits.length < best.length) best = uniquePairCommits;
    }
  }));
  return best;
}

async function resolveCommonAnchor(repoPath: string, candidateBases: readonly string[]): Promise<string | undefined> {
  const unique = [...new Set(candidateBases.filter(Boolean))];
  if (unique.length === 0) return undefined;
  if (unique.length === 1) return unique[0];
  const octopus = await runGit(repoPath, ['merge-base', '--octopus', ...unique]);
  if (octopus.ok && octopus.stdout.trim()) {
    return octopus.stdout.trim().split(/\s+/u)[0];
  }
  let current = unique[0]!;
  for (let i = 1; i < unique.length; i++) {
    const pairBase = await runGit(repoPath, ['merge-base', current, unique[i]!]);
    if (!pairBase.ok || !pairBase.stdout.trim()) return undefined;
    current = pairBase.stdout.trim().split(/\s+/u)[0]!;
  }
  return current;
}

function streamGitNonMergeHashes(
  repoPath: string,
  anchor: string | undefined,
  timeoutMs = PATCH_ID_STREAM_TIMEOUT_MS,
): Promise<string[] | undefined> {
  return new Promise((resolvePromise) => {
    const child = spawn(
      'git',
      ['-C', repoPath, 'rev-list', '--no-merges', '--branches', '--remotes', ...(anchor ? ['--not', anchor] : [])],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let settled = false;
    let stdout = '';
    const finish = (result: string[] | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      try { if (!child.killed && child.exitCode === null) child.kill('SIGKILL'); } catch { /* ignore */ }
      finish(undefined);
    }, timeoutMs);
    timer.unref?.();
    if (!child.stdout) {
      finish(undefined);
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.on('error', () => finish(undefined));
    child.on('close', (code) => {
      if (code !== 0) {
        finish(undefined);
        return;
      }
      finish(stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean));
    });
  });
}

async function getBranchPatchIndex(
  repoPath: string,
  baseRevision: string,
  cache?: TaskPairBranchPatchCacheImpl,
): Promise<Map<string, string[]> | undefined> {
  const buildForAnchor = async (anchor: string | undefined): Promise<Map<string, string[]> | undefined> => {
    const allNonMergeHashes = await streamGitNonMergeHashes(repoPath, anchor);
    if (!allNonMergeHashes) return undefined;
    if (allNonMergeHashes.length === 0) return new Map();

    const shardCount = allNonMergeHashes.length < PATCH_INDEX_SHARD_MIN_COMMITS
      ? 1
      : Math.min(PATCH_INDEX_MAX_SHARDS, Math.max(1, cpus().length), Math.ceil(allNonMergeHashes.length / PATCH_INDEX_SHARD_MIN_COMMITS));
    const shards: string[][] = Array.from({ length: shardCount }, () => []);
    for (let i = 0; i < allNonMergeHashes.length; i++) {
      shards[i % shardCount]!.push(allNonMergeHashes[i]!);
    }
    const shardMaps = await Promise.all(
      shards.filter((shard) => shard.length > 0).map((shard) => streamCommitPatchIdsFromList(repoPath, shard)),
    );
    if (shardMaps.some((map) => !map)) return undefined;

    const commitToPatch = new Map<string, string>();
    for (const shardMap of shardMaps) {
      if (!shardMap) continue;
      for (const [sha, patchId] of shardMap) commitToPatch.set(sha, patchId);
    }

    const patchToCommits = new Map<string, string[]>();
    for (const [sha, patchId] of commitToPatch) {
      const list = patchToCommits.get(patchId);
      if (list) list.push(sha);
      else patchToCommits.set(patchId, [sha]);
    }
    for (const sha of allNonMergeHashes) {
      if (commitToPatch.has(sha)) continue;
      const list = patchToCommits.get(EMPTY_DIFF_PATCH_KEY);
      if (list) list.push(sha);
      else patchToCommits.set(EMPTY_DIFF_PATCH_KEY, [sha]);
    }
    return patchToCommits;
  };

  if (!cache) return buildForAnchor(baseRevision);

  const commonDir = await resolveGitCommonDir(repoPath, cache);
  const existing = cache.patchIndexByCommonDir.get(commonDir);
  if (existing) {
    await existing.ready;
    if (existing.anchor === undefined) return existing.patchIdToCommits;
    const isAncestor = await runGit(repoPath, ['merge-base', '--is-ancestor', existing.anchor, baseRevision]);
    if (isAncestor.ok) return existing.patchIdToCommits;
  }

  // Register the index entry synchronously before awaiting anchor resolution so concurrent
  // dryRun workers share the single patch-id scan instead of rebuilding it in parallel.
  const entry: CommonDirPatchIndex = {
    ready: Promise.resolve(),
    anchor: undefined,
    patchIdToCommits: Promise.resolve(undefined),
  };
  const anchorPromise = (async (): Promise<string | undefined> => {
    const seededBases: string[] = [baseRevision];
    if (existing?.anchor) seededBases.push(existing.anchor);
    const registeredBases = await Promise.all(
      cache.registeredWorktrees.map(async (item) => (
        (await resolveGitCommonDir(item.worktreePath, cache)) === commonDir ? item.baseRevision : undefined
      )),
    );
    for (const base of registeredBases) {
      if (base) seededBases.push(base);
    }
    const anchor = await resolveCommonAnchor(repoPath, seededBases);
    entry.anchor = anchor;
    return anchor;
  })();
  entry.ready = anchorPromise.then(() => undefined);
  entry.patchIdToCommits = anchorPromise.then((anchor) => buildForAnchor(anchor));
  cache.patchIndexByCommonDir.set(commonDir, entry);
  return entry.patchIdToCommits;
}

async function listBranchesContainingAnyCommit(
  repoPath: string,
  commitShas: readonly string[],
  cache?: TaskPairBranchPatchCacheImpl,
): Promise<Set<string> | undefined> {
  const runUncached = async () => {
    const matching = new Set<string>();
    for (let i = 0; i < commitShas.length; i += CONTAINS_BATCH_SIZE) {
      const batch = commitShas.slice(i, i + CONTAINS_BATCH_SIZE);
      const containsArgs = batch.flatMap((sha) => ['--contains', sha]);
      const out = await runGit(repoPath, ['for-each-ref', ...containsArgs, '--format=%(refname)', 'refs/heads', 'refs/remotes']);
      if (!out.ok) return undefined;
      for (const line of out.stdout.split(/\r?\n/u)) {
        const ref = line.trim();
        if (ref && !/^refs\/remotes\/[^/]+\/HEAD$/u.test(ref)) matching.add(ref);
      }
    }
    return matching;
  };
  if (!cache) return runUncached();
  const commonDir = await resolveGitCommonDir(repoPath, cache);
  const key = `${commonDir}\0${[...commitShas].sort().join(',')}`;
  let promise = cache.containsRefsByCommonDirKey.get(key);
  if (!promise) {
    promise = runUncached();
    cache.containsRefsByCommonDirKey.set(key, promise);
  }
  return promise;
}

/**
 * The executor commits after `baseRevision` that are not represented by any
 * local or remote branch. A cherry-picked equivalent is considered
 * integrated. Worktrees are shared with the project repository, so checking
 * every branch is the safe rule: a pair may be merged to a release or feature
 * branch instead of the project's preferred integration branch.
 * A head already reachable from a branch is answered by one git call (no per-branch cherry).
 */
export async function listTaskPairCommitsNotInAnyBranch(
  repoPath: string,
  baseRevision: string,
  options: { head?: string; cache?: TaskPairBranchPatchCache } = {},
): Promise<string[] | undefined> {
  const head = options.head ?? 'HEAD';
  const cache = options.cache instanceof TaskPairBranchPatchCacheImpl ? options.cache : undefined;
  const [commits, containingBranches] = await Promise.all([
    runGit(repoPath, ['rev-list', '--reverse', `${baseRevision}..${head}`]),
    listTaskPairBranchesContaining(repoPath, head),
  ]);
  if (!commits.ok) return undefined;
  const hashes = commits.stdout.trim().split(/\s+/u).filter(Boolean);
  if (hashes.length === 0) return [];

  if (containingBranches?.length) return [];
  let listed: TaskPairBranchRef[] | undefined;
  if (cache) {
    const commonDir = await resolveGitCommonDir(repoPath, cache);
    let refPromise = cache.branchRefsByCommonDir.get(commonDir);
    if (!refPromise) {
      refPromise = listTaskPairBranchRefs(repoPath);
      cache.branchRefsByCommonDir.set(commonDir, refPromise);
    }
    listed = await refPromise;
  } else {
    listed = await listTaskPairBranchRefs(repoPath);
  }
  if (!listed) return undefined;
  if (listed.length === 0) return hashes;

  const { primaryRefs, remainingRefs } = dedupeBranchRefsByTip(listed);
  const allDedupedRefs = [...primaryRefs, ...remainingRefs];
  if (allDedupedRefs.length <= 8) {
    const best = await checkRefsWithCherry(repoPath, head, primaryRefs, hashes, hashes, 1);
    if (best.length === 0 || remainingRefs.length === 0) return best;
    return checkRefsWithCherry(repoPath, head, remainingRefs, hashes, best, CHERRY_FALLBACK_CONCURRENCY);
  }

  const primarySet = new Set(primaryRefs);
  const fallbackRefs = async (initialBest: string[], refsToCheck: readonly TaskPairBranchRef[]) => {
    const orderedPrimary = refsToCheck.filter((entry) => primarySet.has(entry));
    const orderedRemaining = refsToCheck.filter((entry) => !primarySet.has(entry));
    const currentBest = await checkRefsWithCherry(repoPath, head, orderedPrimary, hashes, initialBest, 1);
    if (currentBest.length === 0 || orderedRemaining.length === 0) return currentBest;
    return checkRefsWithCherry(repoPath, head, orderedRemaining, hashes, currentBest, CHERRY_FALLBACK_CONCURRENCY);
  };

  const topPrimaryTip = primaryRefs[0]?.tip;
  const nonMergeResult = await runGit(repoPath, [
    'rev-list',
    '--reverse',
    '--no-merges',
    `${baseRevision}..${head}`,
    ...(topPrimaryTip ? ['--not', topPrimaryTip] : []),
  ]);
  if (!nonMergeResult.ok) return fallbackRefs(hashes, allDedupedRefs);
  const nonMergeHashes = nonMergeResult.stdout.trim().split(/\s+/u).filter(Boolean);
  if (nonMergeHashes.length === 0) return [];

  const nonMergeSet = new Set(nonMergeHashes);
  let best = hashes.filter((hash) => nonMergeSet.has(hash));
  let uncheckedRefs = allDedupedRefs;

  const baseAncestorCheck = await runGit(repoPath, ['merge-base', '--is-ancestor', baseRevision, head]);
  if (!baseAncestorCheck.ok) {
    return fallbackRefs(best, uncheckedRefs);
  }

  const headPatchIds = await streamCommitPatchIdsFromList(repoPath, best);
  if (!headPatchIds) {
    return fallbackRefs(best, uncheckedRefs);
  }

  const patchIndex = await getBranchPatchIndex(repoPath, baseRevision, cache);
  if (!patchIndex) {
    return fallbackRefs(best, uncheckedRefs);
  }

  const collectMatchingBranchShas = (targetHashes: readonly string[]) => {
    const shas = new Set<string>();
    for (const hash of targetHashes) {
      const patchId = headPatchIds.get(hash) ?? EMPTY_DIFF_PATCH_KEY;
      const candidates = patchIndex.get(patchId);
      if (!candidates) continue;
      for (const sha of candidates) shas.add(sha);
    }
    return shas;
  };

  let matchingBranchShas = collectMatchingBranchShas(best);
  if (matchingBranchShas.size === 0) return best;

  let candidateRefNames = await listBranchesContainingAnyCommit(repoPath, [...matchingBranchShas], cache);
  if (!candidateRefNames) {
    return fallbackRefs(best, uncheckedRefs);
  }
  let matchingRefs = uncheckedRefs.filter((entry) => candidateRefNames!.has(entry.ref));
  if (matchingRefs.length === 0) return best;

  if (matchingRefs.length > 2 && primaryRefs.length > 0 && candidateRefNames.has(primaryRefs[0]!.ref)) {
    const topPrimary = primaryRefs[0]!;
    best = await checkRefsWithCherry(repoPath, head, [topPrimary], hashes, best, 1);
    if (best.length === 0) return [];
    uncheckedRefs = uncheckedRefs.filter((entry) => entry.ref !== topPrimary.ref);
    matchingBranchShas = collectMatchingBranchShas(best);
    if (matchingBranchShas.size === 0) return best;
    candidateRefNames = await listBranchesContainingAnyCommit(repoPath, [...matchingBranchShas], cache);
    if (!candidateRefNames) {
      return fallbackRefs(best, uncheckedRefs);
    }
    matchingRefs = uncheckedRefs.filter((entry) => candidateRefNames!.has(entry.ref));
    if (matchingRefs.length === 0) return best;
  }

  return checkRefsWithCherry(repoPath, head, matchingRefs, hashes, best, CHERRY_FALLBACK_CONCURRENCY);
}

/** Count executor commits after base that are not integrated into any branch. */
export async function countTaskPairCommitsNotInAnyBranch(
  repoPath: string,
  baseRevision: string,
  options: { head?: string; cache?: TaskPairBranchPatchCache } = {},
): Promise<number | undefined> {
  return (await listTaskPairCommitsNotInAnyBranch(repoPath, baseRevision, options))?.length;
}

/** Count executor commits after base that are not patch-equivalent to origin/dev. */
export async function countTaskPairCommitsNotInDev(repoPath: string, baseRevision: string): Promise<number | undefined> {
  return (await listTaskPairCommitsNotInIntegration(repoPath, baseRevision))?.length;
}

export async function removeRegisteredGitWorktree(
  inspection: SupervisionWorktreeGitInspection,
  repoPath: string,
): Promise<boolean> {
  if (!inspection.commonDir) return false;
  if (inspection.registered === false) {
    await rm(repoPath, { recursive: true, force: false });
    return true;
  }
  const removed = await runGit(dirname(inspection.commonDir), [
    `--git-dir=${inspection.commonDir}`,
    'worktree',
    'remove',
    '--force',
    repoPath,
  ]);
  return removed.ok;
}

async function pruneGitRegistrations(commonDir: string, apply: boolean): Promise<string[]> {
  const args = [
    `--git-dir=${commonDir}`,
    'worktree',
    'prune',
    '--verbose',
    '--expire',
    'now',
    ...(apply ? [] : ['--dry-run']),
  ];
  const result = await runGit(dirname(commonDir), args);
  if (!result.ok) return [];
  return result.stderr.concat(result.stdout).split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 128);
}

async function readMetadata(candidatePath: string): Promise<{ metadata: SupervisionWorktreeMetadata; text: string } | undefined> {
  const metadataPath = join(candidatePath, 'metadata.json');
  const metadataStat = await lstat(metadataPath);
  if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.size > METADATA_MAX_BYTES) return undefined;
  const text = await readFile(metadataPath, 'utf8');
  const raw = JSON.parse(text) as Partial<SupervisionWorktreeMetadata>;
  if (!raw || typeof raw !== 'object'
    || typeof raw.taskId !== 'string' || !raw.taskId
    || typeof raw.assignmentId !== 'string' || !raw.assignmentId
    || typeof raw.sessionName !== 'string' || !raw.sessionName
    || typeof raw.baseRevision !== 'string' || !raw.baseRevision
    || typeof raw.repoPath !== 'string' || !raw.repoPath
    || typeof raw.createdAt !== 'string' || !raw.createdAt) return undefined;
  return { metadata: raw as SupervisionWorktreeMetadata, text };
}

async function directoryHasEntry(path: string): Promise<boolean> {
  const handle = await opendir(path);
  try {
    const first = await handle.read();
    return first !== null;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function inspectCandidateContents(candidatePath: string, repoRequired: boolean): Promise<SupervisionWorktreeGcReason | undefined> {
  const handle = await opendir(candidatePath);
  let entries = 0;
  try {
    for await (const entry of handle) {
      entries += 1;
      if (entries > 64) return SUPERVISION_WORKTREE_GC_REASONS.UNKNOWN_CONTENT;
      if (entry.name === 'metadata.json') continue;
      if (entry.name === 'repo') {
        if (!repoRequired) return SUPERVISION_WORKTREE_GC_REASONS.UNKNOWN_CONTENT;
        continue;
      }
      if (EVIDENCE_NAME.test(entry.name)) {
        const evidencePath = join(candidatePath, entry.name);
        const evidenceStat = await lstat(evidencePath);
        if (evidenceStat.isSymbolicLink() || !evidenceStat.isDirectory()) {
          return SUPERVISION_WORKTREE_GC_REASONS.UNKNOWN_CONTENT;
        }
        if (await directoryHasEntry(evidencePath)) return SUPERVISION_WORKTREE_GC_REASONS.UNIQUE_EVIDENCE;
        continue;
      }
      return SUPERVISION_WORKTREE_GC_REASONS.UNKNOWN_CONTENT;
    }
  } finally {
    await handle.close().catch(() => {});
  }
  return undefined;
}

async function scanCandidatePaths(
  worktreesRoot: string,
  deps: SupervisionWorktreeGcDeps,
): Promise<{ candidates: CandidatePath[]; truncated: boolean }> {
  const rootReal = await realpath(worktreesRoot);
  const rootStat = await lstat(worktreesRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('worktrees_root_not_canonical');
  const candidates: CandidatePath[] = [];
  let projects = 0;
  let sessions = 0;
  let assignments = 0;
  let observed = 0;
  let truncated = false;
  const projectHandle = await opendir(rootReal);
  try {
    for await (const projectEntry of projectHandle) {
      if (projects >= SUPERVISION_WORKTREE_GC_MAX_PROJECTS) { truncated = true; break; }
      projects += 1;
      observed += 1;
      deps.onScanOperation?.('project');
      if (observed % 32 === 0) await (deps.yieldControl ?? nextTurn)();
      if (projectEntry.name.startsWith('.')) continue;
      const projectPath = join(rootReal, projectEntry.name);
      const projectStat = await lstat(projectPath).catch(() => undefined);
      if (!projectStat?.isDirectory() || projectStat.isSymbolicLink()) continue;
      const sessionHandle = await opendir(projectPath).catch(() => undefined);
      if (!sessionHandle) continue;
      try {
        for await (const sessionEntry of sessionHandle) {
          if (sessions >= SUPERVISION_WORKTREE_GC_MAX_SESSIONS) { truncated = true; break; }
          sessions += 1;
          observed += 1;
          deps.onScanOperation?.('session');
          if (observed % 32 === 0) await (deps.yieldControl ?? nextTurn)();
          if (!SESSION_NAME.test(sessionEntry.name)) continue;
          const sessionPath = join(projectPath, sessionEntry.name);
          const sessionStat = await lstat(sessionPath).catch(() => undefined);
          if (!sessionStat?.isDirectory() || sessionStat.isSymbolicLink()) continue;
          const assignmentHandle = await opendir(sessionPath).catch(() => undefined);
          if (!assignmentHandle) continue;
          try {
            for await (const assignmentEntry of assignmentHandle) {
              if (assignments >= SUPERVISION_WORKTREE_GC_MAX_ASSIGNMENTS) { truncated = true; break; }
              assignments += 1;
              observed += 1;
              deps.onScanOperation?.('assignment');
              if (observed % 32 === 0) await (deps.yieldControl ?? nextTurn)();
              const quarantineMatch = QUARANTINED_ASSIGNMENT_NAME.exec(assignmentEntry.name);
              if (!ASSIGNMENT_NAME.test(assignmentEntry.name) && !quarantineMatch) continue;
              const candidatePath = join(sessionPath, assignmentEntry.name);
              const candidateStat = await lstat(candidatePath).catch(() => undefined);
              if (!candidateStat?.isDirectory() || candidateStat.isSymbolicLink()) continue;
              const repoPath = join(candidatePath, 'repo');
              const key = [projectEntry.name, sessionEntry.name, assignmentEntry.name].join('/');
              candidates.push({
                key, assignmentId: quarantineMatch?.[1] ?? assignmentEntry.name, candidatePath, repoPath,
                sessionName: sessionEntry.name,
                ...(quarantineMatch ? { quarantine: true } : {}),
              });
            }
          } finally {
            await assignmentHandle.close().catch(() => {});
          }
          if (truncated) break;
        }
      } finally {
        await sessionHandle.close().catch(() => {});
      }
      if (truncated) break;
    }
  } finally {
    await projectHandle.close().catch(() => {});
  }
  return { candidates: candidates.sort((left, right) => left.key.localeCompare(right.key)), truncated };
}

async function protectedCandidate(candidatePath: string, protectedPaths: readonly string[]): Promise<boolean> {
  const candidateCanonical = await realpath(candidatePath).catch(() => resolve(candidatePath));
  for (const path of protectedPaths) {
    const canonical = await realpath(path).catch(() => resolve(path));
    if (canonical === candidateCanonical
      || relative(candidateCanonical, canonical).split(/[\\/]/)[0] !== '..') return true;
  }
  return false;
}

async function evaluateCandidate(
  candidate: CandidatePath,
  projectName: string,
  deps: SupervisionWorktreeGcDeps,
): Promise<{
  entry: SupervisionWorktreeGcEntry;
  metadataText?: string;
  inspection?: SupervisionWorktreeGitInspection;
  repoMissing?: boolean;
  orphan?: boolean;
  backupRequired?: boolean;
}> {
  const retain = (reason: SupervisionWorktreeGcReason, taskId?: string, detail?: string) => ({
    entry: {
      key: candidate.key,
      assignmentId: candidate.assignmentId,
      ...(taskId ? { taskId } : {}),
      path: candidate.candidatePath,
      repoPath: candidate.repoPath,
      action: 'retain' as const,
      reason,
      ...(detail ? { detail } : {}),
    },
  });
  if (await protectedCandidate(candidate.candidatePath, deps.protectedPaths ?? [process.cwd()])) {
    return retain(SUPERVISION_WORKTREE_GC_REASONS.PROTECTED_PATH);
  }
  const parsed = await readMetadata(candidate.candidatePath).catch(() => undefined);
  const candidateRepoPath = await realpath(candidate.repoPath).catch(() => undefined);
  const metadataRepoPath = parsed
    ? await realpath(parsed.metadata.repoPath).catch(() => undefined)
    : candidateRepoPath;
  const originalCandidatePath = parsed ? dirname(resolve(parsed.metadata.repoPath)) : undefined;
  const quarantineMetadataMatches = Boolean(parsed && candidate.quarantine && !candidateRepoPath
    && originalCandidatePath
    && basename(originalCandidatePath) === candidate.assignmentId
    && basename(candidate.candidatePath).startsWith(`${basename(originalCandidatePath)}.gc-`)
    && basename(resolve(parsed.metadata.repoPath)) === 'repo');
  const missingRepoMetadataMatches = Boolean(parsed && !candidateRepoPath
    && resolve(parsed.metadata.repoPath) === resolve(candidate.repoPath));
  if (parsed && (
    parsed.metadata.assignmentId !== candidate.assignmentId
    || ((!metadataRepoPath || metadataRepoPath !== candidateRepoPath)
      && !missingRepoMetadataMatches && !quarantineMetadataMatches)
    || parsed.metadata.sessionName !== candidate.sessionName
  )) {
    return retain(SUPERVISION_WORKTREE_GC_REASONS.INVALID_LAYOUT, undefined, 'metadata_layout');
  }
  if (candidate.assignmentId.startsWith(TASK_PAIR_WORKTREE_PREFIX)) {
    return evaluateTaskPairCandidate(candidate, parsed, projectName, deps, candidateRepoPath, retain);
  }
  let reference: SupervisionWorktreeRegistryReference;
  try {
    deps.onScanOperation?.('registry');
    if (parsed) reference = await deps.resolveRegistryReference(parsed.metadata);
    else if (deps.resolveRegistryReferenceByAssignment) {
      reference = await deps.resolveRegistryReferenceByAssignment({
        assignmentId: candidate.assignmentId,
        sessionName: candidate.sessionName,
        repoPath: candidate.repoPath,
      });
    } else return retain(SUPERVISION_WORKTREE_GC_REASONS.INVALID_LAYOUT);
  } catch {
    return retain(SUPERVISION_WORKTREE_GC_REASONS.REGISTRY_UNAVAILABLE, parsed?.metadata.taskId);
  }
  const taskId = parsed?.metadata.taskId ?? reference.assignment?.taskId;
  if (!reference.available) return retain(SUPERVISION_WORKTREE_GC_REASONS.REGISTRY_UNAVAILABLE, taskId);
  if (candidate.quarantine) {
    const candidateStat = await lstat(candidate.candidatePath).catch(() => undefined);
    const graceMs = Math.max(60_000, deps.quarantineGraceMs ?? SUPERVISION_QUARANTINE_GRACE_MS);
    if (!candidateStat || (deps.now?.() ?? Date.now()) - candidateStat.mtimeMs < graceMs) {
      return retain(SUPERVISION_WORKTREE_GC_REASONS.RECOVERY_BLOCKED, taskId, 'quarantine_grace');
    }
  }
  if (!reference.assignment && !reference.task && deps.reclaimOrphans) {
    const candidateStat = await lstat(candidate.candidatePath).catch(() => undefined);
    const createdAt = parsed ? Date.parse(parsed.metadata.createdAt) : Number.NaN;
    const observedAt = Number.isFinite(createdAt) ? createdAt : candidateStat?.mtimeMs;
    const graceMs = Math.max(60_000, deps.orphanGraceMs ?? SUPERVISION_WORKTREE_GC_ORPHAN_GRACE_MS);
    if (!observedAt || (deps.now?.() ?? Date.now()) - observedAt < graceMs) {
      return retain(SUPERVISION_WORKTREE_GC_REASONS.UNKNOWN_OWNER, taskId);
    }
    if (!candidate.external) {
      let contentReason: SupervisionWorktreeGcReason | undefined;
      try { contentReason = await inspectCandidateContents(candidate.candidatePath, Boolean(candidateRepoPath)); } catch {
        return retain(SUPERVISION_WORKTREE_GC_REASONS.INVALID_LAYOUT, taskId);
      }
      if (contentReason) return retain(contentReason, taskId);
    }
    if (!candidateRepoPath) {
      return {
        entry: {
          key: candidate.key, assignmentId: candidate.assignmentId,
          taskId: taskId ?? `orphan-${candidate.assignmentId}`,
          path: candidate.candidatePath, repoPath: candidate.repoPath,
          action: 'delete', reason: SUPERVISION_WORKTREE_GC_REASONS.ELIGIBLE,
          detail: 'orphan_shell',
        },
        metadataText: parsed?.text ?? '', repoMissing: true, orphan: true,
      };
    }
    deps.onScanOperation?.('git');
    const inspection = await (deps.inspectGit ?? inspectSupervisionGitWorktree)(candidate.repoPath);
    if (!inspection.ok) return retain(inspection.reason ?? SUPERVISION_WORKTREE_GC_REASONS.GIT_UNAVAILABLE, taskId);
    if (inspection.locked) return retain(SUPERVISION_WORKTREE_GC_REASONS.GIT_LOCKED, taskId);
    return {
      entry: {
        key: candidate.key, assignmentId: candidate.assignmentId,
        taskId: taskId ?? `orphan-${candidate.assignmentId}`,
        path: candidate.candidatePath, repoPath: candidate.repoPath,
        action: 'delete', reason: SUPERVISION_WORKTREE_GC_REASONS.ELIGIBLE,
        detail: inspection.dirty || inspection.untracked || inspection.branchOnly || inspection.unpushed
          ? 'orphan_backup_required' : 'orphan',
      },
      metadataText: parsed?.text ?? '', inspection, orphan: true,
      backupRequired: Boolean(inspection.dirty || inspection.untracked || inspection.branchOnly || inspection.unpushed),
    };
  }
  if (!reference.assignment || !reference.task
    || reference.assignment.assignmentId !== candidate.assignmentId
    || reference.assignment.taskId !== taskId
    || reference.task.taskId !== taskId
    || !reference.task.assignments.some((assignment) => assignment.assignmentId === candidate.assignmentId)
    || (!parsed && reference.assignment.assignmentId !== candidate.assignmentId)) {
    return retain(SUPERVISION_WORKTREE_GC_REASONS.UNKNOWN_OWNER, taskId);
  }
  if (reference.task.projectName !== projectName) {
    return retain(SUPERVISION_WORKTREE_GC_REASONS.PROJECT_MISMATCH, taskId);
  }
  const terminalReason = terminalAssignmentReason(
    reference,
    candidate.assignmentId,
    deps.now?.() ?? Date.now(),
    Math.max(60_000, deps.handoffGraceMs ?? SUPERVISION_WORKTREE_HANDOFF_GRACE_MS),
  );
  if (terminalReason) return retain(terminalReason, taskId);
  let contentReason: SupervisionWorktreeGcReason | undefined;
  try { contentReason = await inspectCandidateContents(candidate.candidatePath, Boolean(candidateRepoPath)); } catch {
    return retain(SUPERVISION_WORKTREE_GC_REASONS.INVALID_LAYOUT, taskId, 'content_inspection');
  }
  if (contentReason) return retain(contentReason, taskId);
  // Legacy/partially-completed GC layouts can retain only the assignment shell
  // after Git already removed `repo/`. Query the registry by immutable
  // assignment id and apply every authority/evidence/lease/content gate above;
  // an empty shell is then recoverable work, not a permanent invalid_layout.
  if (!candidateRepoPath) {
    return {
      entry: {
        key: candidate.key,
        assignmentId: candidate.assignmentId,
        taskId,
        path: candidate.candidatePath,
        repoPath: candidate.repoPath,
        action: 'delete',
        reason: SUPERVISION_WORKTREE_GC_REASONS.ELIGIBLE,
        detail: 'legacy_shell_without_repo',
      },
      metadataText: parsed?.text ?? '',
      repoMissing: true,
    };
  }
  const repoStat = await lstat(candidate.repoPath).catch(() => undefined);
  if (!repoStat?.isDirectory() || repoStat.isSymbolicLink()) {
    return retain(SUPERVISION_WORKTREE_GC_REASONS.INVALID_LAYOUT, taskId);
  }
  deps.onScanOperation?.('git');
  const inspection = await (deps.inspectGit ?? inspectSupervisionGitWorktree)(candidate.repoPath);
  if (!inspection.ok) return retain(inspection.reason ?? SUPERVISION_WORKTREE_GC_REASONS.GIT_UNAVAILABLE, taskId);
  const merged = taskHasMergedAuthority(reference);
  if (!inspection.registered && !deps.preserveTerminalChanges) {
    return retain(SUPERVISION_WORKTREE_GC_REASONS.GIT_UNREGISTERED, taskId);
  }
  if (inspection.locked) return retain(SUPERVISION_WORKTREE_GC_REASONS.GIT_LOCKED, taskId);
  if (!deps.preserveTerminalChanges && !merged) {
    if (inspection.untracked) return retain(SUPERVISION_WORKTREE_GC_REASONS.UNTRACKED, taskId);
    if (inspection.dirty) return retain(SUPERVISION_WORKTREE_GC_REASONS.DIRTY, taskId);
    if (inspection.branchOnly) return retain(SUPERVISION_WORKTREE_GC_REASONS.BRANCH_ONLY, taskId);
    if (inspection.unpushed) return retain(SUPERVISION_WORKTREE_GC_REASONS.UNPUSHED_BRANCH, taskId);
  }
  // Terminal assignment state is the durable lifecycle authority for its
  // disposable worktree. Audit/finalization evidence belongs to the task and
  // is often held by a different assignment; requiring it here permanently
  // retained auditors, integration owners, and cancelled predecessors. Local
  // dirty/unpushed bytes are preserved above before any removal.
  return {
    entry: {
      key: candidate.key,
      assignmentId: candidate.assignmentId,
      taskId,
      path: candidate.candidatePath,
      repoPath: candidate.repoPath,
      action: 'delete',
      reason: SUPERVISION_WORKTREE_GC_REASONS.ELIGIBLE,
    },
    metadataText: parsed?.text ?? '',
    inspection,
    // Once the registry proves the task finalized with a pushed/already-present
    // commit, repository bytes are authoritative. Local dirt no longer merits
    // a duplicate patch. Uncertain or unmerged owners keep the fail-safe backup.
    backupRequired: !merged && Boolean(
      inspection.dirty || inspection.untracked || inspection.branchOnly || inspection.unpushed
    ),
  };
}

/**
 * A pair worktree is removed only once its pair ended and only when nothing in
 * it exists solely there. Unlike terminal legacy worktrees it is never backed up
 * and deleted: uncommitted, untracked or unpushed work keeps it (the pair engine
 * has told Brain), and a later pass removes it once it is clean.
 */
async function evaluateTaskPairCandidate(
  candidate: CandidatePath,
  parsed: { metadata: SupervisionWorktreeMetadata; text: string } | undefined,
  projectName: string,
  deps: SupervisionWorktreeGcDeps,
  candidateRepoPath: string | undefined,
  retain: (reason: SupervisionWorktreeGcReason, taskId?: string, detail?: string) => { entry: SupervisionWorktreeGcEntry },
): Promise<{ entry: SupervisionWorktreeGcEntry; metadataText?: string; inspection?: SupervisionWorktreeGitInspection; repoMissing?: boolean }> {
  if (!parsed) return retain(SUPERVISION_WORKTREE_GC_REASONS.INVALID_LAYOUT, undefined, 'pair_metadata');
  const taskId = parsed.metadata.taskId;
  if (!deps.resolveTaskPairWorktree) return retain(SUPERVISION_WORKTREE_GC_REASONS.UNKNOWN_OWNER, taskId, 'pair');
  let reference: TaskPairWorktreeReference;
  try {
    deps.onScanOperation?.('registry');
    reference = await deps.resolveTaskPairWorktree({ taskId, repoPath: parsed.metadata.repoPath });
  } catch {
    return retain(SUPERVISION_WORKTREE_GC_REASONS.REGISTRY_UNAVAILABLE, taskId);
  }
  if (!reference.available) return retain(SUPERVISION_WORKTREE_GC_REASONS.REGISTRY_UNAVAILABLE, taskId);
  if (!reference.found) return retain(SUPERVISION_WORKTREE_GC_REASONS.UNKNOWN_OWNER, taskId, 'pair');
  if (reference.projectName !== projectName) return retain(SUPERVISION_WORKTREE_GC_REASONS.PROJECT_MISMATCH, taskId);
  if (!reference.terminal) return retain(SUPERVISION_WORKTREE_GC_REASONS.ACTIVE_REFERENCE, taskId, 'pair_open');
  // An ended pair keeps its worktree for the retention period.
  if (!reference.retentionElapsed) return retain(SUPERVISION_WORKTREE_GC_REASONS.ACTIVE_REFERENCE, taskId, 'pair_retention');
  const deleteEntry = (detail?: string): SupervisionWorktreeGcEntry => ({
    key: candidate.key, assignmentId: candidate.assignmentId, taskId,
    path: candidate.candidatePath, repoPath: candidate.repoPath,
    action: 'delete', reason: SUPERVISION_WORKTREE_GC_REASONS.ELIGIBLE, ...(detail ? { detail } : {}),
  });
  if (!candidateRepoPath) return { entry: deleteEntry('pair_shell_without_repo'), metadataText: parsed.text, repoMissing: true };
  deps.onScanOperation?.('git');
  const inspection = await (deps.inspectGit ?? inspectSupervisionGitWorktree)(candidate.repoPath);
  if (!inspection.ok) return retain(inspection.reason ?? SUPERVISION_WORKTREE_GC_REASONS.GIT_UNAVAILABLE, taskId);
  if (inspection.locked) return retain(SUPERVISION_WORKTREE_GC_REASONS.GIT_LOCKED, taskId);
  if (inspection.dirty) return retain(SUPERVISION_WORKTREE_GC_REASONS.DIRTY, taskId, 'pair_kept');
  if (inspection.untracked) return retain(SUPERVISION_WORKTREE_GC_REASONS.UNTRACKED, taskId, 'pair_kept');
  const notInAnyBranch = await (
    deps.countTaskPairCommitsNotInAnyBranch
    ?? deps.countTaskPairCommitsNotInDev
    ?? countTaskPairCommitsNotInAnyBranch
  )(candidate.repoPath, parsed.metadata.baseRevision);
  if (notInAnyBranch === undefined || notInAnyBranch > 0) return retain(SUPERVISION_WORKTREE_GC_REASONS.UNPUSHED_BRANCH, taskId, 'pair_kept');
  return { entry: deleteEntry('pair_ended'), metadataText: parsed.text, inspection };
}

async function writeJsonAtomic(path: string, value: unknown, runId: string): Promise<void> {
  const temporary = `${path}.${runId}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function readJournal(path: string): Promise<GcJournal | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > METADATA_MAX_BYTES) return undefined;
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<GcJournal>;
    if (parsed.version !== JOURNAL_VERSION || typeof parsed.runId !== 'string'
      || typeof parsed.candidatePath !== 'string' || typeof parsed.repoPath !== 'string'
      || typeof parsed.assignmentId !== 'string' || typeof parsed.taskId !== 'string'
      || typeof parsed.projectName !== 'string' || !parsed.projectName
      || typeof parsed.metadataText !== 'string'
      || !['planned', 'git_removed', 'quarantined'].includes(String(parsed.state))) return undefined;
    return parsed as GcJournal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return undefined;
  }
}

async function acquireRunLock(
  path: string,
  runId: string,
  now: number,
  pid: number,
  isProcessAlive: (pid: number) => boolean,
): Promise<boolean> {
  const payload = `${JSON.stringify({ runId, pid, startedAt: now })}\n`;
  try {
    const handle = await open(path, 'wx', 0o600);
    await handle.writeFile(payload);
    await handle.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
  }
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > METADATA_MAX_BYTES) return false;
    const lock = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown; startedAt?: unknown };
    const ownerPid = Number(lock.pid);
    const startedAt = Number(lock.startedAt);
    if (!Number.isFinite(startedAt) || now - startedAt < SUPERVISION_WORKTREE_GC_LOCK_STALE_MS
      || isProcessAlive(ownerPid)) return false;
    const stalePath = `${path}.stale.${runId}`;
    await rename(path, stalePath);
    const handle = await open(path, 'wx', 0o600);
    await handle.writeFile(payload);
    await handle.close();
    await unlink(stalePath).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function releaseRunLock(path: string, runId: string): Promise<void> {
  try {
    const lock = JSON.parse(await readFile(path, 'utf8')) as { runId?: unknown };
    if (lock.runId === runId) await unlink(path);
  } catch { /* a lost/replaced lock must never be removed */ }
}

/** Apply-time re-check for a pair worktree: its pair still exists, in this project, and has ended. */
async function taskPairRemovalStillAuthorized(
  metadata: SupervisionWorktreeMetadata | undefined,
  assignmentId: string,
  projectName: string,
  deps: SupervisionWorktreeGcDeps,
): Promise<boolean> {
  if (!assignmentId.startsWith(TASK_PAIR_WORKTREE_PREFIX) || !metadata || !deps.resolveTaskPairWorktree) return false;
  const reference = await Promise.resolve(deps.resolveTaskPairWorktree({ taskId: metadata.taskId, repoPath: metadata.repoPath }))
    .catch((): TaskPairWorktreeReference => ({ available: false }));
  return reference.available && reference.found === true && reference.terminal === true
    && reference.retentionElapsed === true && reference.projectName === projectName;
}

async function postGitRemoveCandidate(
  journalPath: string,
  journal: GcJournal,
  worktreesRoot: string,
  projectName: string,
  deps: SupervisionWorktreeGcDeps,
): Promise<boolean> {
  const candidatePath = resolve(journal.candidatePath);
  const root = await realpath(worktreesRoot).catch(() => resolve(worktreesRoot));
  if (journal.external) {
    if (!await safeExternalIntegrationPath(candidatePath)) return false;
  } else if (relative(root, candidatePath).startsWith('..')
    || (basename(candidatePath) !== journal.assignmentId
      && !basename(candidatePath).startsWith(`${journal.assignmentId}.gc-`))) {
    return false;
  }
  if (await protectedCandidate(candidatePath, deps.protectedPaths ?? [process.cwd()])) return false;
  const candidateStat = await lstat(candidatePath).catch(() => undefined);
  if (!candidateStat) return true;
  if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) return false;
  const parsed = await readMetadata(candidatePath).catch(() => undefined);
  if (journal.metadataText
    ? (!parsed || parsed.text !== journal.metadataText || parsed.metadata.taskId !== journal.taskId
      || parsed.metadata.assignmentId !== journal.assignmentId)
    : Boolean(parsed)) return false;
  const reference = await Promise.resolve(parsed
    ? deps.resolveRegistryReference(parsed.metadata)
    : deps.resolveRegistryReferenceByAssignment?.({
      assignmentId: journal.assignmentId,
      sessionName: journal.sessionName ?? basename(dirname(candidatePath)),
      repoPath: journal.repoPath,
    }) ?? { available: false })
    .catch((): SupervisionWorktreeRegistryReference => ({ available: false }));
  const orphanStillUnknown = journal.orphan && reference.available
    && !reference.assignment && !reference.task;
  const terminalStillAuthorized = !journal.orphan && reference.available
    && Boolean(reference.assignment) && Boolean(reference.task)
    && reference.assignment!.assignmentId === journal.assignmentId
    && reference.assignment!.taskId === journal.taskId
    && reference.task!.taskId === journal.taskId
    && reference.task!.projectName === projectName
    && reference.task!.assignments.some((assignment) => assignment.assignmentId === journal.assignmentId)
    && !terminalAssignmentReason(
      reference,
      journal.assignmentId,
      deps.now?.() ?? Date.now(),
      Math.max(60_000, deps.handoffGraceMs ?? SUPERVISION_WORKTREE_HANDOFF_GRACE_MS),
    );
  const pairStillEnded = await taskPairRemovalStillAuthorized(parsed?.metadata, journal.assignmentId, projectName, deps);
  if (!orphanStillUnknown && !terminalStillAuthorized && !pairStillEnded) return false;
  if (await lstat(journal.repoPath).then(() => true, () => false)) return false;
  const contentReason = await inspectCandidateContents(candidatePath, false).catch(
    () => SUPERVISION_WORKTREE_GC_REASONS.UNKNOWN_CONTENT,
  );
  if (contentReason) return false;
  const quarantinePath = `${candidatePath}.gc-${journal.runId}`;
  await rename(candidatePath, quarantinePath);
  await utimes(quarantinePath, new Date(), new Date());
  await writeJsonAtomic(journalPath, {
    ...journal,
    state: 'quarantined',
    quarantinePath,
    updatedAt: deps.now?.() ?? Date.now(),
  } satisfies GcJournal, journal.runId);
  if (await inspectCandidateContents(quarantinePath, false).catch(() => SUPERVISION_WORKTREE_GC_REASONS.UNKNOWN_CONTENT)) {
    if (!await lstat(candidatePath).then(() => true, () => false)) await rename(quarantinePath, candidatePath).catch(() => {});
    return false;
  }
  await (deps.removeDirectory ?? ((path) => rm(path, { recursive: true, force: false })))(quarantinePath);
  return true;
}

async function recoverInterruptedApply(
  journalPath: string,
  worktreesRoot: string,
  projectName: string,
  deps: SupervisionWorktreeGcDeps,
): Promise<{ ok: boolean; deleted: number; mutations: number; releasedBytes: number; assignmentId?: string }> {
  const journal = await readJournal(journalPath);
  if (!journal) return { ok: true, deleted: 0, mutations: 0, releasedBytes: 0 };
  if (journal.projectName !== projectName) {
    return { ok: false, deleted: 0, mutations: 0, releasedBytes: 0, assignmentId: journal.assignmentId };
  }
  if (journal.state === 'planned') {
    const repoExists = await lstat(journal.repoPath).then(() => true, () => false);
    if (repoExists) {
      const inspection = await (deps.inspectGit ?? inspectSupervisionGitWorktree)(journal.repoPath)
        .catch((): SupervisionWorktreeGitInspection => ({ ok: false }));
      if (!inspection.ok) {
        return { ok: false, deleted: 0, mutations: 0, releasedBytes: 0, assignmentId: journal.assignmentId };
      }
      await unlink(journalPath).catch(() => {});
      return { ok: true, deleted: 0, mutations: 1, releasedBytes: 0 };
    }
    const promoted = { ...journal, state: 'git_removed' as const };
    const removed = await postGitRemoveCandidate(
      journalPath, promoted, worktreesRoot, projectName, deps,
    ).catch(() => false);
    if (!removed) return { ok: false, deleted: 0, mutations: 0, releasedBytes: 0, assignmentId: journal.assignmentId };
    await unlink(journalPath).catch(() => {});
    return { ok: true, deleted: 1, mutations: 1, releasedBytes: journal.candidateBytes ?? 0, assignmentId: journal.assignmentId };
  }
  if (journal.state === 'quarantined' && journal.quarantinePath) {
    const root = await realpath(worktreesRoot).catch(() => resolve(worktreesRoot));
    const quarantinePath = resolve(journal.quarantinePath);
    const expectedQuarantine = `${resolve(journal.candidatePath)}.gc-${journal.runId}`;
    if (quarantinePath !== expectedQuarantine || relative(root, quarantinePath).startsWith('..')
      || await lstat(journal.candidatePath).then(() => true, () => false)) {
      return { ok: false, deleted: 0, mutations: 0, releasedBytes: 0, assignmentId: journal.assignmentId };
    }
    const quarantineStat = await lstat(journal.quarantinePath).catch(() => undefined);
    if (!quarantineStat) {
      await unlink(journalPath).catch(() => {});
      return { ok: true, deleted: 1, mutations: 1, releasedBytes: journal.candidateBytes ?? 0, assignmentId: journal.assignmentId };
    }
    const parsed = await readMetadata(journal.quarantinePath).catch(() => undefined);
    const metadataMatches = journal.metadataText ? Boolean(parsed && parsed.text === journal.metadataText) : !parsed;
    const reference = metadataMatches
      ? await Promise.resolve(parsed
        ? deps.resolveRegistryReference(parsed.metadata)
        : deps.resolveRegistryReferenceByAssignment?.({
          assignmentId: journal.assignmentId,
          sessionName: journal.sessionName ?? basename(dirname(journal.candidatePath)),
          repoPath: journal.repoPath,
        }) ?? { available: false })
        .catch((): SupervisionWorktreeRegistryReference => ({ available: false }))
      : undefined;
    const orphanStillUnknown = journal.orphan && reference?.available
      && !reference.assignment && !reference.task;
    const terminalStillAuthorized = !journal.orphan && Boolean(reference?.available)
      && Boolean(reference?.assignment) && Boolean(reference?.task)
      && reference!.assignment!.assignmentId === journal.assignmentId
      && reference!.assignment!.taskId === journal.taskId
      && reference!.task!.taskId === journal.taskId
      && reference!.task!.projectName === projectName
      && reference!.task!.assignments.some((assignment) => assignment.assignmentId === journal.assignmentId)
      && !terminalAssignmentReason(
        reference!,
        journal.assignmentId,
        deps.now?.() ?? Date.now(),
        Math.max(60_000, deps.handoffGraceMs ?? SUPERVISION_WORKTREE_HANDOFF_GRACE_MS),
      );
    const pairStillEnded = metadataMatches
      && await taskPairRemovalStillAuthorized(parsed?.metadata, journal.assignmentId, projectName, deps);
    if (!quarantineStat.isDirectory() || quarantineStat.isSymbolicLink()
      || !metadataMatches
      || (parsed && (parsed.metadata.assignmentId !== journal.assignmentId || parsed.metadata.taskId !== journal.taskId))
      || (!orphanStillUnknown && !terminalStillAuthorized && !pairStillEnded)
      || await inspectCandidateContents(journal.quarantinePath, false).catch(() => SUPERVISION_WORKTREE_GC_REASONS.UNKNOWN_CONTENT)) {
      return { ok: false, deleted: 0, mutations: 0, releasedBytes: 0, assignmentId: journal.assignmentId };
    }
    await (deps.removeDirectory ?? ((path) => rm(path, { recursive: true, force: false })))(journal.quarantinePath);
    await unlink(journalPath).catch(() => {});
    return { ok: true, deleted: 1, mutations: 1, releasedBytes: journal.candidateBytes ?? 0, assignmentId: journal.assignmentId };
  }
  const removed = await postGitRemoveCandidate(journalPath, journal, worktreesRoot, projectName, deps).catch(() => false);
  if (!removed) return { ok: false, deleted: 0, mutations: 0, releasedBytes: 0, assignmentId: journal.assignmentId };
  await unlink(journalPath).catch(() => {});
  return { ok: true, deleted: 1, mutations: 1, releasedBytes: journal.candidateBytes ?? 0, assignmentId: journal.assignmentId };
}

export async function runSupervisionWorktreeGc(
  input: SupervisionWorktreeGcInput,
  deps: SupervisionWorktreeGcDeps,
): Promise<SupervisionWorktreeGcResult> {
  const mode = input.mode ?? 'dryRun';
  const runId = randomUUID();
  const root = resolve(input.worktreesRoot ?? defaultWorktreesRoot());
  const limit = boundedLimit(input.limit);
  const now = deps.now?.() ?? Date.now();
  const diagnostics: SupervisionWorktreeGcResult['diagnostics'] = [];
  const empty = (reason: SupervisionWorktreeGcReason, lock: SupervisionWorktreeGcResult['lock']): SupervisionWorktreeGcResult => ({
    mode, runId, root, scanned: 0, mutations: 0, deleted: 0, releasedBytes: 0,
    retained: reason === SUPERVISION_WORKTREE_GC_REASONS.CONCURRENT_RUN ? 1 : 0,
    hasMore: false, lock, registryAvailable: reason !== SUPERVISION_WORKTREE_GC_REASONS.REGISTRY_UNAVAILABLE,
    entries: reason === SUPERVISION_WORKTREE_GC_REASONS.CONCURRENT_RUN ? [{
      key: '', assignmentId: '', path: root, repoPath: '', action: 'retain', reason,
    }] : [], staleRegistrations: [], diagnostics,
  });

  const rootStat = await lstat(root).catch(() => undefined);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    diagnostics.push({ code: 'worktrees_root_invalid' });
    return empty(SUPERVISION_WORKTREE_GC_REASONS.INVALID_LAYOUT, 'not_required');
  }

  const lockPath = join(root, '.supervision-worktree-gc.lock');
  const journalPath = join(root, '.supervision-worktree-gc-journal.json');
  let lockAcquired = false;
  if (mode === 'apply') {
    try {
      lockAcquired = await acquireRunLock(
        lockPath,
        runId,
        now,
        deps.pid ?? process.pid,
        deps.isProcessAlive ?? defaultIsProcessAlive,
      );
    } catch { lockAcquired = false; }
    if (!lockAcquired) return empty(SUPERVISION_WORKTREE_GC_REASONS.CONCURRENT_RUN, 'busy');
  }

  try {
    let recoveredDeleted = 0;
    let recoveredMutations = 0;
    let releasedBytes = 0;
    if (mode === 'apply') {
      const recovery = await recoverInterruptedApply(journalPath, root, input.projectName, deps);
      if (!recovery.ok) {
        return {
          ...empty(SUPERVISION_WORKTREE_GC_REASONS.RECOVERY_BLOCKED, 'acquired'),
          retained: 1,
          entries: [{
            key: '', assignmentId: recovery.assignmentId ?? '', path: root, repoPath: '', action: 'retain',
            reason: SUPERVISION_WORKTREE_GC_REASONS.RECOVERY_BLOCKED,
          }],
        };
      }
      recoveredDeleted = recovery.deleted;
      recoveredMutations = recovery.mutations;
      releasedBytes = recovery.releasedBytes;
    }

    if (mode === 'apply' && recoveredMutations >= limit) {
      // Do not even enumerate a fresh candidate after recovery consumes the
      // page. The conservative hasMore signal asks the caller for one bounded
      // follow-up, which can safely discover whether any candidate remains.
      return {
        mode,
        runId,
        root,
        scanned: 0,
        mutations: recoveredMutations,
        deleted: recoveredDeleted,
        releasedBytes,
        retained: 0,
        hasMore: true,
        lock: 'acquired',
        registryAvailable: true,
        entries: [],
        staleRegistrations: [],
        diagnostics,
      };
    }

    let scannedPaths: Awaited<ReturnType<typeof scanCandidatePaths>>;
    try { scannedPaths = await scanCandidatePaths(root, deps); } catch (error) {
      diagnostics.push({ code: safeErrorCode(error) });
      return { ...empty(SUPERVISION_WORKTREE_GC_REASONS.REGISTRY_UNAVAILABLE, mode === 'apply' ? 'acquired' : 'not_required'), diagnostics };
    }
    if (deps.reclaimOrphans && deps.listExternalOrphanWorktrees) {
      const externalPaths = await Promise.resolve(deps.listExternalOrphanWorktrees(input.projectName))
        .catch((): readonly string[] => []);
      for (const externalPath of externalPaths.slice(0, SUPERVISION_WORKTREE_GC_MAX_ASSIGNMENTS)) {
        if (!await safeExternalIntegrationPath(externalPath)) continue;
        const canonical = await realpath(externalPath).catch(() => undefined);
        const info = canonical ? await lstat(canonical).catch(() => undefined) : undefined;
        if (!canonical || !info?.isDirectory() || info.isSymbolicLink()) continue;
        const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
        scannedPaths.candidates.push({
          key: `~external/${digest}`,
          assignmentId: `asg_external${digest}`,
          candidatePath: canonical,
          repoPath: canonical,
          sessionName: 'deck_external_integration',
          external: true,
        });
      }
      scannedPaths.candidates.sort((left, right) => left.key.localeCompare(right.key));
    }
    const afterCursor = scannedPaths.candidates.filter((candidate) => !input.cursor || candidate.key > input.cursor);
    // Crash recovery and fresh candidates share one apply mutation budget.
    // A successful recovery mutation consumes capacity before the page is
    // evaluated, so limit=1 can never recover one directory and delete a
    // second directory in the same run.
    const remainingMutationBudget = mode === 'apply'
      ? Math.max(0, limit - recoveredMutations)
      : limit;
    const batch = afterCursor.slice(0, remainingMutationBudget);
    const entries: SupervisionWorktreeGcEntry[] = [];
    const commonDirs = new Set<string>();
    let deleted = recoveredDeleted;
    let mutations = recoveredMutations;
    let registryAvailable = true;
    const evaluatedBatch: Array<{
      candidate: CandidatePath;
      evaluated: Awaited<ReturnType<typeof evaluateCandidate>>;
    }> = [];
    for (const candidate of batch) {
      const evaluated = await evaluateCandidate(candidate, input.projectName, deps);
      if (evaluated.entry.reason === SUPERVISION_WORKTREE_GC_REASONS.REGISTRY_UNAVAILABLE) registryAvailable = false;
      if (evaluated.inspection?.commonDir && commonDirs.size < SUPERVISION_WORKTREE_GC_MAX_COMMON_DIRS) {
        commonDirs.add(evaluated.inspection.commonDir);
      }
      evaluatedBatch.push({ candidate, evaluated });
      await (deps.yieldControl ?? nextTurn)();
    }

    // Registry availability is a run-wide deletion authority. If any lookup
    // cannot be proven, apply deletes nothing from this page; it must never
    // partially delete before discovering that the authority source is down.
    if (mode === 'apply' && !registryAvailable) {
      for (const { evaluated } of evaluatedBatch) {
        entries.push(evaluated.entry.action === 'delete'
          ? { ...evaluated.entry, action: 'retain', reason: SUPERVISION_WORKTREE_GC_REASONS.REGISTRY_UNAVAILABLE }
          : evaluated.entry);
      }
    }

    for (const { candidate, evaluated } of evaluatedBatch) {
      if (mode === 'apply' && !registryAvailable) break;
      if (mode === 'dryRun' || evaluated.entry.action !== 'delete'
        || (!evaluated.inspection && !evaluated.repoMissing)
        || evaluated.metadataText === undefined) {
        entries.push(evaluated.entry);
        continue;
      }

      // Repeat every registry, evidence and Git admission gate immediately
      // before mutation. A dirty/re-activated candidate is retained.
      const revalidated = await evaluateCandidate(candidate, input.projectName, deps);
      if (revalidated.entry.action !== 'delete'
        || (!revalidated.inspection && !revalidated.repoMissing)
        || revalidated.metadataText === undefined) {
        entries.push(revalidated.entry);
        await (deps.yieldControl ?? nextTurn)();
        continue;
      }
      if (revalidated.inspection && revalidated.backupRequired) {
        const preserved = await preserveCandidateState(
          candidate, revalidated.inspection, input.projectName, deps,
        ).catch(() => ({ ok: false, detail: 'backup_exception' }));
        if (!preserved.ok) {
          diagnostics.push({ code: preserved.detail ?? 'backup_failed', assignmentId: candidate.assignmentId });
          entries.push({
            ...revalidated.entry,
            action: 'retain',
            reason: SUPERVISION_WORKTREE_GC_REASONS.BACKUP_FAILED,
            detail: preserved.detail,
          });
          await (deps.yieldControl ?? nextTurn)();
          continue;
        }
      }
      const journal: GcJournal = {
        version: JOURNAL_VERSION,
        runId,
        state: revalidated.repoMissing ? 'git_removed' : 'planned',
        candidatePath: candidate.candidatePath,
        repoPath: candidate.repoPath,
        assignmentId: candidate.assignmentId,
        taskId: revalidated.entry.taskId!,
        projectName: input.projectName,
        metadataText: revalidated.metadataText,
        sessionName: candidate.sessionName,
        candidateBytes: Math.max(0, await (deps.measureDirectoryBytes ?? directoryBytes)(candidate.candidatePath)),
        ...(revalidated.orphan ? { orphan: true } : {}),
        ...(candidate.external ? { external: true } : {}),
        updatedAt: deps.now?.() ?? Date.now(),
      };
      mutations += 1;
      await writeJsonAtomic(journalPath, journal, runId);
      const removedGit = revalidated.repoMissing || await (deps.removeRegisteredWorktree ?? removeRegisteredGitWorktree)(
        revalidated.inspection!, candidate.repoPath,
      );
      if (!removedGit) {
        diagnostics.push({ code: 'git_worktree_remove_failed', assignmentId: candidate.assignmentId });
        const postFailure = await (deps.inspectGit ?? inspectSupervisionGitWorktree)(candidate.repoPath)
          .catch((): SupervisionWorktreeGitInspection => ({ ok: false }));
        const safelyUnchanged = postFailure.ok && postFailure.registered === true;
        entries.push({
          ...revalidated.entry,
          action: 'retain',
          reason: safelyUnchanged
            ? SUPERVISION_WORKTREE_GC_REASONS.APPLY_FAILED
            : SUPERVISION_WORKTREE_GC_REASONS.RECOVERY_BLOCKED,
        });
        if (safelyUnchanged) await unlink(journalPath).catch(() => {});
        await (deps.yieldControl ?? nextTurn)();
        if (!safelyUnchanged) break;
        continue;
      }
      const gitRemovedJournal: GcJournal = {
        ...journal,
        state: 'git_removed',
        updatedAt: deps.now?.() ?? Date.now(),
      };
      await writeJsonAtomic(journalPath, gitRemovedJournal, runId);
      const removedCandidate = await postGitRemoveCandidate(
        journalPath, gitRemovedJournal, root, input.projectName, deps,
      ).catch(() => false);
      if (!removedCandidate) {
        diagnostics.push({ code: 'post_git_remove_revalidation_failed', assignmentId: candidate.assignmentId });
        entries.push({ ...revalidated.entry, action: 'retain', reason: SUPERVISION_WORKTREE_GC_REASONS.RECOVERY_BLOCKED });
        break;
      }
      await unlink(journalPath).catch(() => {});
      deleted += 1;
      releasedBytes += journal.candidateBytes ?? 0;
      entries.push(revalidated.entry);
      await (deps.yieldControl ?? nextTurn)();
    }

    const staleRegistrations: string[] = [];
    for (const commonDir of mode === 'apply' && !registryAvailable ? [] : commonDirs) {
      const rows = await (deps.pruneRegistrations ?? pruneGitRegistrations)(commonDir, mode === 'apply');
      for (const row of rows) if (staleRegistrations.length < 128) staleRegistrations.push(row);
      await (deps.yieldControl ?? nextTurn)();
    }
    const hasMore = scannedPaths.truncated || afterCursor.length > batch.length;
    const artifactRetention = await deps.sweepRetainedArtifacts?.(mode, limit).catch((error) => {
      diagnostics.push({ code: safeErrorCode(error) });
      return undefined;
    });
    return {
      mode,
      runId,
      root,
      scanned: batch.length,
      mutations,
      deleted,
      releasedBytes,
      retained: entries.filter((entry) => entry.action === 'retain').length,
      hasMore,
      ...(hasMore && batch.length ? { nextCursor: batch.at(-1)!.key } : {}),
      lock: mode === 'apply' ? 'acquired' : 'not_required',
      registryAvailable,
      entries,
      staleRegistrations,
      diagnostics,
      ...(artifactRetention ? { artifactRetention } : {}),
    };
  } finally {
    if (lockAcquired) await releaseRunLock(lockPath, runId);
  }
}
