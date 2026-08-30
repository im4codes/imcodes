import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const SUPERVISION_WORKTREE_GC_DEFAULT_LIMIT = 25 as const;
export const SUPERVISION_WORKTREE_GC_MAX_LIMIT = 100 as const;
export const SUPERVISION_WORKTREE_GC_MAX_PROJECTS = 32 as const;
export const SUPERVISION_WORKTREE_GC_MAX_SESSIONS = 128 as const;
export const SUPERVISION_WORKTREE_GC_MAX_ASSIGNMENTS = 512 as const;
export const SUPERVISION_WORKTREE_GC_MAX_COMMON_DIRS = 4 as const;
export const SUPERVISION_WORKTREE_GC_LOCK_STALE_MS = 10 * 60_000;

const ASSIGNMENT_NAME = /^supervision_assignment_[0-9a-z-]+$/;
const SESSION_NAME = /^deck_[0-9a-z_-]+$/i;
const EVIDENCE_NAME = /^evidence(?:-[0-9a-z_.-]+)?$/i;
const METADATA_MAX_BYTES = 16 * 1024;
const JOURNAL_VERSION = 1 as const;
const TERMINAL_ASSIGNMENT = new Set(['finalized', 'cancelled']);
const ACTIVE_ASSIGNMENT = new Set([
  'planned', 'delegated', 'implementing', 'retrying_external_ci', 'recovered',
  'validated', 'ready_for_audit', 'auditing', 'rework', 'ready_for_integration',
]);

export const SUPERVISION_WORKTREE_GC_REASONS = Object.freeze({
  ELIGIBLE: 'eligible',
  REGISTRY_UNAVAILABLE: 'registry_unavailable',
  UNKNOWN_OWNER: 'unknown_owner',
  PROJECT_MISMATCH: 'project_mismatch',
  ACTIVE_REFERENCE: 'active_reference',
  ACTIVE_LEASE: 'active_lease',
  ACTIVE_CLAIMS: 'active_claims',
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
  };
  task?: {
    taskId: string;
    projectName: string;
    status: string;
    archivedAt?: number;
    assignments: ReadonlyArray<{ assignmentId: string; status: string; leaseId: string }>;
  };
  claims?: ReadonlyArray<{ assignmentId: string; path: string }>;
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
  retained: number;
  hasMore: boolean;
  nextCursor?: string;
  lock: 'acquired' | 'not_required' | 'busy';
  registryAvailable: boolean;
  entries: SupervisionWorktreeGcEntry[];
  staleRegistrations: string[];
  diagnostics: Array<{ code: string; assignmentId?: string }>;
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
  protectedPaths?: readonly string[];
  now?: () => number;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
  yieldControl?: () => Promise<void>;
  inspectGit?: (repoPath: string) => Promise<SupervisionWorktreeGitInspection>;
  removeRegisteredWorktree?: (inspection: SupervisionWorktreeGitInspection, repoPath: string) => Promise<boolean>;
  pruneRegistrations?: (commonDir: string, apply: boolean) => Promise<string[]>;
  removeDirectory?: (path: string) => Promise<void>;
  onScanOperation?: (operation: 'project' | 'session' | 'assignment' | 'registry' | 'git') => void;
}

interface CandidatePath {
  key: string;
  assignmentId: string;
  candidatePath: string;
  repoPath: string;
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
  quarantinePath?: string;
  updatedAt: number;
}

function defaultWorktreesRoot(): string {
  const imcodesHome = process.env.IMCODES_HOME?.trim() || join(homedir(), '.imcodes');
  return resolve(imcodesHome, 'worktrees');
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

async function worktreeBlock(porcelain: string, repoPath: string): Promise<string | undefined> {
  const canonical = await realpath(repoPath);
  for (const block of porcelain.split(/\n\n+/)) {
    const worktreeLine = block.split('\n').find((line) => line.startsWith('worktree '));
    if (!worktreeLine) continue;
    const listed = await realpath(worktreeLine.slice('worktree '.length)).catch(() => undefined);
    if (listed === canonical) return block;
  }
  return undefined;
}

export async function inspectSupervisionGitWorktree(repoPath: string): Promise<SupervisionWorktreeGitInspection> {
  const inside = await runGit(repoPath, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return { ok: false, reason: SUPERVISION_WORKTREE_GC_REASONS.GIT_UNAVAILABLE };
  }
  const statusResult = await runGit(repoPath, ['status', '--porcelain=v2', '--untracked-files=all']);
  if (!statusResult.ok) return { ok: false, reason: SUPERVISION_WORKTREE_GC_REASONS.GIT_UNAVAILABLE };
  const statusLines = statusResult.stdout.split('\n').filter(Boolean);
  const untracked = statusLines.some((line) => line.startsWith('? '));
  const dirty = statusLines.some((line) => !line.startsWith('? '));

  const commonResult = await runGit(repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!commonResult.ok || !commonResult.stdout.trim()) {
    return { ok: false, reason: SUPERVISION_WORKTREE_GC_REASONS.GIT_UNAVAILABLE };
  }
  const commonDir = resolve(repoPath, commonResult.stdout.trim());
  const worktreeResult = await runGit(repoPath, ['worktree', 'list', '--porcelain']);
  if (!worktreeResult.ok) return { ok: false, reason: SUPERVISION_WORKTREE_GC_REASONS.GIT_UNAVAILABLE };
  const block = await worktreeBlock(worktreeResult.stdout, repoPath);
  if (!block) {
    return { ok: false, commonDir, registered: false, reason: SUPERVISION_WORKTREE_GC_REASONS.GIT_UNREGISTERED };
  }
  const locked = block.split('\n').some((line) => line === 'locked' || line.startsWith('locked '));

  let branchOnly = false;
  let unpushed = false;
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

  return {
    ok: true,
    commonDir,
    registered: true,
    locked,
    dirty,
    untracked,
    branchOnly,
    unpushed,
  };
}

async function removeRegisteredGitWorktree(
  inspection: SupervisionWorktreeGitInspection,
  repoPath: string,
): Promise<boolean> {
  if (!inspection.commonDir) return false;
  const removed = await runGit(dirname(inspection.commonDir), [
    `--git-dir=${inspection.commonDir}`,
    'worktree',
    'remove',
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
              if (!ASSIGNMENT_NAME.test(assignmentEntry.name)) continue;
              const candidatePath = join(sessionPath, assignmentEntry.name);
              const candidateStat = await lstat(candidatePath).catch(() => undefined);
              if (!candidateStat?.isDirectory() || candidateStat.isSymbolicLink()) continue;
              const repoPath = join(candidatePath, 'repo');
              const key = [projectEntry.name, sessionEntry.name, assignmentEntry.name].join('/');
              candidates.push({ key, assignmentId: assignmentEntry.name, candidatePath, repoPath });
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

function protectedCandidate(candidatePath: string, protectedPaths: readonly string[]): boolean {
  return protectedPaths.some((path) => {
    const canonical = resolve(path);
    return canonical === candidatePath || relative(candidatePath, canonical).split(/[\\/]/)[0] !== '..';
  });
}

async function evaluateCandidate(
  candidate: CandidatePath,
  projectName: string,
  deps: SupervisionWorktreeGcDeps,
): Promise<{ entry: SupervisionWorktreeGcEntry; metadataText?: string; inspection?: SupervisionWorktreeGitInspection }> {
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
  if (protectedCandidate(candidate.candidatePath, deps.protectedPaths ?? [process.cwd()])) {
    return retain(SUPERVISION_WORKTREE_GC_REASONS.PROTECTED_PATH);
  }
  let parsed: Awaited<ReturnType<typeof readMetadata>>;
  try { parsed = await readMetadata(candidate.candidatePath); } catch { return retain(SUPERVISION_WORKTREE_GC_REASONS.INVALID_LAYOUT); }
  const metadataRepoPath = parsed
    ? await realpath(parsed.metadata.repoPath).catch(() => undefined)
    : undefined;
  const candidateRepoPath = await realpath(candidate.repoPath).catch(() => undefined);
  if (!parsed
    || parsed.metadata.assignmentId !== candidate.assignmentId
    || !metadataRepoPath || metadataRepoPath !== candidateRepoPath
    || parsed.metadata.sessionName !== basename(dirname(candidate.candidatePath))) {
    return retain(SUPERVISION_WORKTREE_GC_REASONS.INVALID_LAYOUT);
  }
  const taskId = parsed.metadata.taskId;
  let reference: SupervisionWorktreeRegistryReference;
  try {
    deps.onScanOperation?.('registry');
    reference = await deps.resolveRegistryReference(parsed.metadata);
  } catch {
    return retain(SUPERVISION_WORKTREE_GC_REASONS.REGISTRY_UNAVAILABLE, taskId);
  }
  if (!reference.available) return retain(SUPERVISION_WORKTREE_GC_REASONS.REGISTRY_UNAVAILABLE, taskId);
  if (!reference.assignment || !reference.task
    || reference.assignment.assignmentId !== parsed.metadata.assignmentId
    || reference.assignment.taskId !== taskId
    || reference.task.taskId !== taskId
    || !reference.task.assignments.some((assignment) => assignment.assignmentId === parsed.metadata.assignmentId)) {
    return retain(SUPERVISION_WORKTREE_GC_REASONS.UNKNOWN_OWNER, taskId);
  }
  if (reference.task.projectName !== projectName) {
    return retain(SUPERVISION_WORKTREE_GC_REASONS.PROJECT_MISMATCH, taskId);
  }
  if (reference.assignment.leaseId) return retain(SUPERVISION_WORKTREE_GC_REASONS.ACTIVE_LEASE, taskId);
  if ((reference.claims ?? []).some((claim) => claim.assignmentId === parsed.metadata.assignmentId)) {
    return retain(SUPERVISION_WORKTREE_GC_REASONS.ACTIVE_CLAIMS, taskId);
  }
  const taskArchived = Number.isFinite(reference.task.archivedAt);
  if (ACTIVE_ASSIGNMENT.has(reference.assignment.status)
    || reference.task.assignments.some((assignment) => ACTIVE_ASSIGNMENT.has(assignment.status))
    || (!TERMINAL_ASSIGNMENT.has(reference.assignment.status) && !taskArchived)) {
    return retain(SUPERVISION_WORKTREE_GC_REASONS.ACTIVE_REFERENCE, taskId);
  }
  let contentReason: SupervisionWorktreeGcReason | undefined;
  try { contentReason = await inspectCandidateContents(candidate.candidatePath, true); } catch {
    return retain(SUPERVISION_WORKTREE_GC_REASONS.INVALID_LAYOUT, taskId);
  }
  if (contentReason) return retain(contentReason, taskId);
  const repoStat = await lstat(candidate.repoPath).catch(() => undefined);
  if (!repoStat?.isDirectory() || repoStat.isSymbolicLink()) {
    return retain(SUPERVISION_WORKTREE_GC_REASONS.INVALID_LAYOUT, taskId);
  }
  deps.onScanOperation?.('git');
  const inspection = await (deps.inspectGit ?? inspectSupervisionGitWorktree)(candidate.repoPath);
  if (!inspection.ok) return retain(inspection.reason ?? SUPERVISION_WORKTREE_GC_REASONS.GIT_UNAVAILABLE, taskId);
  if (!inspection.registered) return retain(SUPERVISION_WORKTREE_GC_REASONS.GIT_UNREGISTERED, taskId);
  if (inspection.locked) return retain(SUPERVISION_WORKTREE_GC_REASONS.GIT_LOCKED, taskId);
  if (inspection.untracked) return retain(SUPERVISION_WORKTREE_GC_REASONS.UNTRACKED, taskId);
  if (inspection.dirty) return retain(SUPERVISION_WORKTREE_GC_REASONS.DIRTY, taskId);
  if (inspection.branchOnly) return retain(SUPERVISION_WORKTREE_GC_REASONS.BRANCH_ONLY, taskId);
  if (inspection.unpushed) return retain(SUPERVISION_WORKTREE_GC_REASONS.UNPUSHED_BRANCH, taskId);
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
    metadataText: parsed.text,
    inspection,
  };
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

async function postGitRemoveCandidate(
  journalPath: string,
  journal: GcJournal,
  worktreesRoot: string,
  projectName: string,
  deps: SupervisionWorktreeGcDeps,
): Promise<boolean> {
  const candidatePath = resolve(journal.candidatePath);
  const root = await realpath(worktreesRoot).catch(() => resolve(worktreesRoot));
  if (relative(root, candidatePath).startsWith('..') || basename(candidatePath) !== journal.assignmentId) return false;
  if (protectedCandidate(candidatePath, deps.protectedPaths ?? [process.cwd()])) return false;
  const candidateStat = await lstat(candidatePath).catch(() => undefined);
  if (!candidateStat) return true;
  if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) return false;
  const parsed = await readMetadata(candidatePath).catch(() => undefined);
  if (!parsed || parsed.text !== journal.metadataText || parsed.metadata.taskId !== journal.taskId
    || parsed.metadata.assignmentId !== journal.assignmentId) return false;
  const reference = await Promise.resolve(deps.resolveRegistryReference(parsed.metadata))
    .catch((): SupervisionWorktreeRegistryReference => ({ available: false }));
  if (!reference.available || !reference.assignment || !reference.task
    || reference.assignment.assignmentId !== journal.assignmentId
    || reference.assignment.taskId !== journal.taskId
    || reference.task.taskId !== journal.taskId
    || reference.task.projectName !== projectName
    || !reference.task.assignments.some((assignment) => assignment.assignmentId === journal.assignmentId)
    || reference.assignment.leaseId
    || ACTIVE_ASSIGNMENT.has(reference.assignment.status)
    || reference.task.assignments.some((assignment) => ACTIVE_ASSIGNMENT.has(assignment.status))
    || (!TERMINAL_ASSIGNMENT.has(reference.assignment.status) && !Number.isFinite(reference.task.archivedAt))
    || (reference.claims ?? []).some((claim) => claim.assignmentId === journal.assignmentId)) return false;
  if (await lstat(journal.repoPath).then(() => true, () => false)) return false;
  const contentReason = await inspectCandidateContents(candidatePath, false).catch(
    () => SUPERVISION_WORKTREE_GC_REASONS.UNKNOWN_CONTENT,
  );
  if (contentReason) return false;
  const quarantinePath = `${candidatePath}.gc-${journal.runId}`;
  await rename(candidatePath, quarantinePath);
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
): Promise<{ ok: boolean; deleted: number; mutations: number; assignmentId?: string }> {
  const journal = await readJournal(journalPath);
  if (!journal) return { ok: true, deleted: 0, mutations: 0 };
  if (journal.projectName !== projectName) {
    return { ok: false, deleted: 0, mutations: 0, assignmentId: journal.assignmentId };
  }
  if (journal.state === 'planned') {
    const repoExists = await lstat(journal.repoPath).then(() => true, () => false);
    if (repoExists) {
      const inspection = await (deps.inspectGit ?? inspectSupervisionGitWorktree)(journal.repoPath)
        .catch((): SupervisionWorktreeGitInspection => ({ ok: false }));
      if (!inspection.ok || !inspection.registered) {
        return { ok: false, deleted: 0, mutations: 0, assignmentId: journal.assignmentId };
      }
      await unlink(journalPath).catch(() => {});
      return { ok: true, deleted: 0, mutations: 1 };
    }
    const promoted = { ...journal, state: 'git_removed' as const };
    const removed = await postGitRemoveCandidate(
      journalPath, promoted, worktreesRoot, projectName, deps,
    ).catch(() => false);
    if (!removed) return { ok: false, deleted: 0, mutations: 0, assignmentId: journal.assignmentId };
    await unlink(journalPath).catch(() => {});
    return { ok: true, deleted: 1, mutations: 1, assignmentId: journal.assignmentId };
  }
  if (journal.state === 'quarantined' && journal.quarantinePath) {
    const root = await realpath(worktreesRoot).catch(() => resolve(worktreesRoot));
    const quarantinePath = resolve(journal.quarantinePath);
    const expectedQuarantine = `${resolve(journal.candidatePath)}.gc-${journal.runId}`;
    if (quarantinePath !== expectedQuarantine || relative(root, quarantinePath).startsWith('..')
      || await lstat(journal.candidatePath).then(() => true, () => false)) {
      return { ok: false, deleted: 0, mutations: 0, assignmentId: journal.assignmentId };
    }
    const quarantineStat = await lstat(journal.quarantinePath).catch(() => undefined);
    if (!quarantineStat) {
      await unlink(journalPath).catch(() => {});
      return { ok: true, deleted: 1, mutations: 1, assignmentId: journal.assignmentId };
    }
    const parsed = await readMetadata(journal.quarantinePath).catch(() => undefined);
    const reference = parsed
      ? await Promise.resolve(deps.resolveRegistryReference(parsed.metadata))
        .catch((): SupervisionWorktreeRegistryReference => ({ available: false }))
      : undefined;
    if (!quarantineStat.isDirectory() || quarantineStat.isSymbolicLink()
      || !parsed || parsed.text !== journal.metadataText
      || parsed.metadata.assignmentId !== journal.assignmentId || parsed.metadata.taskId !== journal.taskId
      || !reference?.available || !reference.assignment || !reference.task
      || reference.assignment.assignmentId !== journal.assignmentId
      || reference.assignment.taskId !== journal.taskId
      || reference.task.taskId !== journal.taskId || reference.task.projectName !== projectName
      || !reference.task.assignments.some((assignment) => assignment.assignmentId === journal.assignmentId)
      || reference.assignment.leaseId
      || ACTIVE_ASSIGNMENT.has(reference.assignment.status)
      || reference.task.assignments.some((assignment) => ACTIVE_ASSIGNMENT.has(assignment.status))
      || (!TERMINAL_ASSIGNMENT.has(reference.assignment.status) && !Number.isFinite(reference.task.archivedAt))
      || (reference.claims ?? []).some((claim) => claim.assignmentId === journal.assignmentId)
      || await inspectCandidateContents(journal.quarantinePath, false).catch(() => SUPERVISION_WORKTREE_GC_REASONS.UNKNOWN_CONTENT)) {
      return { ok: false, deleted: 0, mutations: 0, assignmentId: journal.assignmentId };
    }
    await (deps.removeDirectory ?? ((path) => rm(path, { recursive: true, force: false })))(journal.quarantinePath);
    await unlink(journalPath).catch(() => {});
    return { ok: true, deleted: 1, mutations: 1, assignmentId: journal.assignmentId };
  }
  const removed = await postGitRemoveCandidate(journalPath, journal, worktreesRoot, projectName, deps).catch(() => false);
  if (!removed) return { ok: false, deleted: 0, mutations: 0, assignmentId: journal.assignmentId };
  await unlink(journalPath).catch(() => {});
  return { ok: true, deleted: 1, mutations: 1, assignmentId: journal.assignmentId };
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
    mode, runId, root, scanned: 0, mutations: 0, deleted: 0,
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
      if (mode === 'dryRun' || evaluated.entry.action !== 'delete' || !evaluated.inspection || !evaluated.metadataText) {
        entries.push(evaluated.entry);
        continue;
      }

      // Repeat every registry, evidence and Git admission gate immediately
      // before mutation. A dirty/re-activated candidate is retained.
      const revalidated = await evaluateCandidate(candidate, input.projectName, deps);
      if (revalidated.entry.action !== 'delete' || !revalidated.inspection || !revalidated.metadataText) {
        entries.push(revalidated.entry);
        await (deps.yieldControl ?? nextTurn)();
        continue;
      }
      const journal: GcJournal = {
        version: JOURNAL_VERSION,
        runId,
        state: 'planned',
        candidatePath: candidate.candidatePath,
        repoPath: candidate.repoPath,
        assignmentId: candidate.assignmentId,
        taskId: revalidated.entry.taskId!,
        projectName: input.projectName,
        metadataText: revalidated.metadataText,
        updatedAt: deps.now?.() ?? Date.now(),
      };
      mutations += 1;
      await writeJsonAtomic(journalPath, journal, runId);
      const removedGit = await (deps.removeRegisteredWorktree ?? removeRegisteredGitWorktree)(
        revalidated.inspection,
        candidate.repoPath,
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
    return {
      mode,
      runId,
      root,
      scanned: batch.length,
      mutations,
      deleted,
      retained: entries.filter((entry) => entry.action === 'retain').length,
      hasMore,
      ...(hasMore && batch.length ? { nextCursor: batch.at(-1)!.key } : {}),
      lock: mode === 'apply' ? 'acquired' : 'not_required',
      registryAvailable,
      entries,
      staleRegistrations,
      diagnostics,
    };
  } finally {
    if (lockAcquired) await releaseRunLock(lockPath, runId);
  }
}
