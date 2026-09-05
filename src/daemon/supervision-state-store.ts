import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { PeerAuditReceiptKind, PeerAuditValidationItem, PeerAuditVerdict } from '../../shared/peer-audit.js';
import {
  supervisionIdentityMatches,
  isSupervisionTaskCoordinator,
} from '../../shared/supervision-participant-authority.js';
import { SUPERVISION_ID_PREFIXES } from '../../shared/supervision-durable-identity.js';
import { matchesProjectSessionConsumer } from '../../shared/actionable-consumer-scope.js';

import {
  canTransitionSupervisionTaskStatus,
  isTerminalSupervisionTaskStatus,
  isSupervisionTaskVisibleByDefault,
  isSupervisionTaskClassification,
  isSupervisionTaskAuditPolicy,
  isSupervisionTaskLifecycleStatus,
  SUPERVISION_TASK_ABANDONED_AFTER_MS,
  SUPERVISION_TASK_ARCHIVE_GRACE_MS,
  SUPERVISION_TASK_CLEANUP_VERSION,
  SUPERVISION_TASK_HOUSEKEEPING_DEFAULT_BATCH_SIZE,
  SUPERVISION_TASK_HOUSEKEEPING_MAX_BATCH_SIZE,
  SUPERVISION_BRAIN_COORDINATION_RECOVERY_STATUSES,
  SUPERVISION_RECOVERY_LEASE_ACTIONS,
  SUPERVISION_COMPLETION_EVIDENCE_DECISIONS,
  type SupervisionTaskArchiveReason,
  type SupervisionBrainCoordinationRecoveryStatus,
  type SupervisionRecoveryLeaseAction,
  type SupervisionCompletionEvidenceDecision,
  type SupervisionTaskAuditPolicy,
  type SessionSupervisionSnapshot,
} from '../../shared/supervision-config.js';
import type { SupervisionAuditDepth } from './supervision-broker.js';
import type {
  SupervisionAuditRoutingReason,
  SupervisionAuditDegradedReason,
  SupervisionEconomyTaskPolicy,
  SupervisionExecutionBinding,
  SupervisionProvisioningEvidence,
} from '../../shared/supervision-execution-pool.js';
import { mayFinalizeEconomyAssignment } from '../../shared/supervision-execution-pool.js';
import { suppressSqliteExperimentalWarning } from '../util/suppress-sqlite-warning.js';
import logger from '../util/logger.js';
import { mintSupervisionId } from './supervision-id-minter.js';
import type {
  SupervisionTaskLifecycleStatus,
  SupervisionTaskRegistryEventType,
} from '../../shared/supervision-config.js';
// Type-only: supervision-mcp-tools does not import this module, and the import
// is erased at runtime, so this cannot create a cycle.
import type { SupervisionRecoveryTargetStatus } from './supervision-mcp-tools.js';
import { SUPERVISION_INTEGRATION_FINALIZATION_STATUS_PATH } from './supervision-intent-ops.js';
import type { SupervisionWorktreeSnapshot } from './supervision-worktree-inspector.js';

const require = createRequire(import.meta.url);
suppressSqliteExperimentalWarning();
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

const DEFAULT_DB_PATH = join(homedir(), '.imcodes', 'supervision-state.sqlite');
export const SUPERVISION_STATE_VERSION = 1;

/**
 * Single path authority for the supervision task registry database.
 *
 * The live task console is a read/projection surface over this registry.  It
 * must open this exact database rather than inventing a second similarly named
 * SQLite file: migrations can add projection tables to an empty database, but
 * they cannot conjure the authoritative task/assignment rows into it.
 */
/** Exact roles whose identity may be rebound on the same object after a restart. */
const SUPERVISION_REBINDABLE_EXACT_ROLES = new Set<string>(['auditor', 'coordinator', 'integration_owner']);

export function resolveSupervisionTaskRegistryDbPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.IMCODES_SUPERVISION_STATE_DB_PATH?.trim()
    || (env.VITEST ? ':memory:' : DEFAULT_DB_PATH);
}

export type PersistedSupervisionWaitPhase = 'waiting' | 'auditing';

export interface PersistedSupervisionSessionIdentity {
  sessionName: string;
  sessionInstanceId: string;
  agentType: string;
  runtimeType: 'process' | 'transport';
  runtimeEpoch?: string;
  providerId?: string;
  providerSessionId?: string;
  providerResumeId?: string;
}

export interface PersistedSupervisionWaitState {
  version: typeof SUPERVISION_STATE_VERSION;
  owner: PersistedSupervisionSessionIdentity;
  commandId: string;
  snapshot: SessionSupervisionSnapshot;
  userText: string;
  phase: PersistedSupervisionWaitPhase;
  /**
   * The in-memory `TaskRunPhase` ('execution' | 'auditing' | 'finalizing')
   * at persist time, distinct from `phase` above (which only records the
   * *kind* of park: waiting-heartbeat-governed vs audit-deadline-governed).
   * Only meaningful when `phase === 'waiting'` and the run was parked while
   * finishing post-audit delivery work (deferred finalization). Omitted for
   * an ordinary execution-phase park. Restore must preserve this instead of
   * collapsing every 'waiting' park to 'execution': losing it after a daemon
   * restart silently downgrades a finalizing-phase wait back to a plain
   * execution-phase wait, changing what continue/advance prompts it gets.
   */
  runPhase?: 'execution' | 'finalizing';
  requiresAudit: boolean;
  freshAuditRequiredAfterRework: boolean;
  continueLoops: number;
  continueStreakCount: number;
  lastContinueBucket?: string;
  reworkDispatches: number;
  startedAt: number;
  auditDepth?: SupervisionAuditDepth;
  deferredFinalization?: {
    reason: string;
    nextAction: string;
    gap?: string;
  };
  waitingStartedAt?: number;
  waitingDeadlineAt?: number;
  waitingNextHeartbeatAt?: number;
  auditAttemptId?: string;
  auditDelegationId?: string;
  auditReplyCapability?: string;
  auditStartedAt?: number;
  auditDeadlineAt?: number;
  auditNextHeartbeatAt?: number;
  auditReplyObserved: boolean;
  auditTarget?: PersistedSupervisionSessionIdentity;
  auditRoutingReason?: SupervisionAuditRoutingReason;
  auditTargetDispatchObservedAt?: number;
  auditTargetObservedActive: boolean;
  auditTargetRecoveryAttempts: number;
  auditTargetRecoveryLimitNotified: boolean;
  trustedContractVersions?: readonly string[];
  auditVerdictCorrectionAttempts: number;
  auditMarkerWarningEmitted: boolean;
  pendingAssistantText?: string;
  pendingAssistantCompletionKey?: string;
  updatedAt: number;
}

export interface SupervisionStateStoreOptions {
  dbPath?: string;
  database?: DatabaseSyncInstance;
  busyTimeoutMs?: number;
  /**
   * Live, non-stopped runtimes for a project, supplied by the daemon's session
   * registry. The registry cannot observe runtimes itself, but the RULE for
   * accepting one stays here so no caller can widen it.
   */
  resolveLiveParticipants?: (projectName: string | null | undefined)
    => readonly PersistedSupervisionTaskAssignmentIdentity[];
}

export interface SupervisionWaitStateStore {
  close(): void;
  upsert(state: PersistedSupervisionWaitState): void;
  get(sessionName: string): PersistedSupervisionWaitState | undefined;
  list(): PersistedSupervisionWaitState[];
  delete(sessionName: string): void;
  clear(): void;
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseRecord(payload: string): PersistedSupervisionWaitState | undefined {
  try {
    const value = JSON.parse(payload) as Partial<PersistedSupervisionWaitState>;
    if (value.version !== SUPERVISION_STATE_VERSION) return undefined;
    if (!value.owner || typeof value.owner.sessionName !== 'string' || !value.owner.sessionName) return undefined;
    if (typeof value.owner.sessionInstanceId !== 'string' || !value.owner.sessionInstanceId) return undefined;
    if (typeof value.owner.agentType !== 'string' || !value.owner.agentType) return undefined;
    if (value.owner.runtimeType !== 'process' && value.owner.runtimeType !== 'transport') return undefined;
    if (typeof value.commandId !== 'string' || !value.commandId) return undefined;
    if (!value.snapshot || typeof value.snapshot !== 'object') return undefined;
    if (typeof value.userText !== 'string') return undefined;
    if (value.phase !== 'waiting' && value.phase !== 'auditing') return undefined;
    if (value.runPhase !== undefined && value.runPhase !== 'execution' && value.runPhase !== 'finalizing') {
      return undefined;
    }
    if (!isFiniteTimestamp(value.startedAt) || !isFiniteTimestamp(value.updatedAt)) return undefined;
    return value as PersistedSupervisionWaitState;
  } catch {
    return undefined;
  }
}

export class SupervisionStateStore implements SupervisionWaitStateStore {
  readonly #db: DatabaseSyncInstance;
  readonly #ownsDb: boolean;
  #closed = false;

  constructor(options: SupervisionStateStoreOptions = {}) {
    let db: DatabaseSyncInstance | undefined;
    let ownsDb = false;
    if (options.database) {
      db = options.database;
    } else {
      const dbPath = options.dbPath?.trim()
        || resolveSupervisionTaskRegistryDbPath();
      if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
      db = new DatabaseSync(dbPath);
      ownsDb = true;
    }
    if (!db) throw new Error('supervision state database was not initialized');
    try {
      const timeout = Math.max(0, Math.min(60_000, Math.floor(options.busyTimeoutMs ?? 5_000)));
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = ${timeout};
        CREATE TABLE IF NOT EXISTS supervision_wait_states (
          session_name TEXT PRIMARY KEY,
          session_instance_id TEXT NOT NULL,
          command_id TEXT NOT NULL,
          phase TEXT NOT NULL CHECK (phase IN ('waiting', 'auditing')),
          deadline_at INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS supervision_wait_states_deadline_idx
          ON supervision_wait_states(deadline_at);
      `);
    } catch (error) {
      if (ownsDb) {
        try {
          db.close();
        } catch {
          // Preserve the authoritative initialization error.
        }
      }
      throw error;
    }
    this.#db = db;
    this.#ownsDb = ownsDb;
  }

  close(): void {
    if (this.#ownsDb && !this.#closed) this.#db.close();
    this.#closed = true;
  }

  upsert(state: PersistedSupervisionWaitState): void {
    if (this.#closed) throw new Error('supervision state store is closed');
    const deadlineAt = state.phase === 'waiting'
      ? state.waitingNextHeartbeatAt
      : state.auditNextHeartbeatAt ?? state.auditDeadlineAt;
    if (!isFiniteTimestamp(deadlineAt)) throw new Error('supervision wait state requires a finite deadline');
    this.#db.prepare(`
      INSERT INTO supervision_wait_states (
        session_name, session_instance_id, command_id, phase,
        deadline_at, payload_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_name) DO UPDATE SET
        session_instance_id = excluded.session_instance_id,
        command_id = excluded.command_id,
        phase = excluded.phase,
        deadline_at = excluded.deadline_at,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(
      state.owner.sessionName,
      state.owner.sessionInstanceId,
      state.commandId,
      state.phase,
      deadlineAt,
      JSON.stringify(state),
      state.updatedAt,
    );
  }

  get(sessionName: string): PersistedSupervisionWaitState | undefined {
    if (this.#closed) return undefined;
    const row = this.#db.prepare(`
      SELECT payload_json AS payloadJson
      FROM supervision_wait_states
      WHERE session_name = ?
    `).get(sessionName) as { payloadJson?: unknown } | undefined;
    return typeof row?.payloadJson === 'string' ? parseRecord(row.payloadJson) : undefined;
  }

  list(): PersistedSupervisionWaitState[] {
    if (this.#closed) return [];
    const rows = this.#db.prepare(`
      SELECT payload_json AS payloadJson
      FROM supervision_wait_states
      ORDER BY updated_at ASC
    `).all() as Array<{ payloadJson?: unknown }>;
    return rows
      .map((row) => typeof row.payloadJson === 'string' ? parseRecord(row.payloadJson) : undefined)
      .filter((row): row is PersistedSupervisionWaitState => row !== undefined);
  }

  delete(sessionName: string): void {
    if (this.#closed) return;
    this.#db.prepare('DELETE FROM supervision_wait_states WHERE session_name = ?').run(sessionName);
  }

  clear(): void {
    if (this.#closed) return;
    this.#db.exec('DELETE FROM supervision_wait_states');
  }
}

class DisabledSupervisionStateStore implements SupervisionWaitStateStore {
  close(): void {}
  upsert(_state: PersistedSupervisionWaitState): void {}
  get(_sessionName: string): PersistedSupervisionWaitState | undefined { return undefined; }
  list(): PersistedSupervisionWaitState[] { return []; }
  delete(_sessionName: string): void {}
  clear(): void {}
}

let supervisionStateStore: SupervisionWaitStateStore | undefined;

export function getSupervisionStateStore(): SupervisionWaitStateStore {
  if (supervisionStateStore) return supervisionStateStore;
  try {
    supervisionStateStore = new SupervisionStateStore();
  } catch (error) {
    // Durable supervision recovery is an optional resilience layer. A corrupt,
    // locked or unwritable local database must never prevent the daemon from
    // starting; this process continues without restart recovery and retries on
    // the next daemon start.
    logger.warn({ err: error }, 'Supervision durable state unavailable; continuing without persisted wait recovery');
    supervisionStateStore = new DisabledSupervisionStateStore();
  }
  return supervisionStateStore;
}

export function resetSupervisionStateStoreForTests(): void {
  supervisionStateStore?.close();
  supervisionStateStore = undefined;
}

export const SUPERVISION_TASK_REGISTRY_DB_VERSION = 1 as const;

export interface PersistedSupervisionTaskAssignmentIdentity {
  sessionName: string;
  sessionInstanceId: string;
  runtimeEpoch: string;
  agentType: string;
  providerFamily: string;
}

export interface SupervisionIntegrationManifestEntry {
  path: string;
  sha256: string;
}

export interface PersistedSupervisionIntegrationFinalization {
  revision: string;
  auditAttemptId: string;
  auditRevision: string;
  verdict: 'PASS';
  ownedFiles: string[];
  integrationManifest: SupervisionIntegrationManifestEntry[];
  integrationOwner: string;
  commitSha: string;
  pushResult: 'pushed' | 'already_present';
  pushRemoteRef: string;
  stagedPaths: string[];
  externalRunId?: string;
  externalHeadSha?: string;
  externalTaskId?: string;
  ciResult?: import('../../shared/supervision-config.js').SupervisionCiSmokeStatus;
  finalizedAt: number;
}

export interface PersistedSupervisionTaskRecord {
  /** Last recorded validation outcome for the task aggregate. */
  validationState?: string;
  version: typeof SUPERVISION_TASK_REGISTRY_DB_VERSION;
  taskId: string;
  /** Authoritative project audience. Legacy rows are deliberately unscoped. */
  projectName: string;
  topLevelTaskId: string;
  classification: import('../../shared/supervision-config.js').SupervisionTaskClassification;
  objective: string;
  acceptance: string[];
  /** Brain-owned creation snapshot. Missing keeps the legacy manual audit path. */
  auditPolicy?: SupervisionTaskAuditPolicy;
  integrationOwnerAssignmentId?: string;
  baseRevision?: string;
  currentRevision?: string;
  status: import('../../shared/supervision-config.js').SupervisionTaskLifecycleStatus;
  commitSha?: string;
  pushRemoteRef?: string;
  finalization?: PersistedSupervisionIntegrationFinalization;
  blocker?: string;
  archivedAt?: number;
  archiveReason?: SupervisionTaskArchiveReason;
  supersededBy?: string;
  duplicateCandidate?: boolean;
  duplicateCandidateOf?: string;
  cleanupVersion?: typeof SUPERVISION_TASK_CLEANUP_VERSION;
  createdAt: number;
  updatedAt: number;
}

export interface SupervisionLiveParticipantCandidate {
  projectName: string;
  identity: PersistedSupervisionTaskAssignmentIdentity;
}

const SUPERVISION_IMPLEMENTATION_CONTINUATION_STATUSES = new Set([
  'delegated', 'implementing', 'retrying_external_ci', 'rework',
]);
const SUPERVISION_OWNER_TERMINAL_STATUSES = new Set(['cancelled', 'finalized']);
const SUPERVISION_AUDITOR_TERMINAL_STATUSES = new Set(['cancelled', 'finalized', 'passed', 'ready_for_integration']);

/**
 * Durable participant identity is deliberately smaller than runtime fencing
 * metadata. A daemon/provider restart may rotate instance, epoch, agent type,
 * or provider family without changing who owns the assignment.
 */
export function matchesDurableSupervisionParticipant(input: {
  taskProjectName?: string | null;
  assignmentSessionName?: string | null;
  candidateProjectName?: string | null;
  candidateSessionName?: string | null;
}): boolean {
  return matchesProjectSessionConsumer({
    projectName: input.taskProjectName,
    sessionName: input.assignmentSessionName,
  }, {
    projectName: input.candidateProjectName,
    sessionName: input.candidateSessionName,
  });
}

/** One role/status/revision predicate shared by delivery and recovery. */
export function isSupervisionAssignmentContinuable(input: {
  taskCurrentRevision?: string;
  assignment: Pick<PersistedSupervisionTaskAssignment,
    'role' | 'status' | 'required' | 'auditAttemptId' | 'auditRevision'>;
}): boolean {
  const { assignment } = input;
  if (assignment.role === 'implementer') {
    return assignment.required && SUPERVISION_IMPLEMENTATION_CONTINUATION_STATUSES.has(assignment.status);
  }
  if (assignment.role === 'coordinator' || assignment.role === 'integration_owner') {
    return !SUPERVISION_OWNER_TERMINAL_STATUSES.has(assignment.status)
      && (!assignment.auditRevision || input.taskCurrentRevision === assignment.auditRevision);
  }
  if (assignment.role === 'auditor') {
    return !SUPERVISION_AUDITOR_TERMINAL_STATUSES.has(assignment.status)
      && Boolean(assignment.auditAttemptId)
      && Boolean(assignment.auditRevision)
      && input.taskCurrentRevision === assignment.auditRevision;
  }
  return false;
}

export interface PersistedSupervisionTaskAssignment {
  version: typeof SUPERVISION_TASK_REGISTRY_DB_VERSION;
  assignmentId: string;
  taskId: string;
  role: 'coordinator' | 'integration_owner' | 'implementer' | 'auditor';
  identity: PersistedSupervisionTaskAssignmentIdentity;
  scopeFiles: string[];
  required: boolean;
  status: import('../../shared/supervision-config.js').SupervisionTaskLifecycleStatus;
  /** Last durable liveness beat, ms epoch. Distinct from updatedAt: a beat
   *  proves the runtime is alive without claiming substantive progress. */
  heartbeatAt?: number;
  /** Last recorded validation outcome. The console projects this directly;
   *  leaving it unwritten makes every row read 'unknown'. */
  validationState?: string;
  leaseId: string;
  generation: number;
  auditAttemptId?: string;
  auditRevision?: string;
  verdict?: string;
  blocker?: string;
  externalRunId?: string;
  externalHeadSha?: string;
  externalTaskId?: string;
  executionBinding?: SupervisionExecutionBinding;
  economyPolicy?: SupervisionEconomyTaskPolicy;
  primaryReviewPassed?: boolean;
  crossVendorAuditPassed?: boolean;
  auditRoutingReason?: SupervisionAuditRoutingReason;
  auditDegradedReason?: SupervisionAuditDegradedReason;
  provisioning?: SupervisionProvisioningEvidence;
  cleanupVersion?: typeof SUPERVISION_TASK_CLEANUP_VERSION;
  createdAt: number;
  updatedAt: number;
}

export interface PersistedSupervisionTaskFileClaim {
  taskId: string;
  assignmentId: string;
  path: string;
  claimMode: 'exclusive' | 'shared' | 'read_only';
}

export interface PersistedSupervisionTaskEvent {
  id: number;
  taskId: string;
  assignmentId?: string;
  eventType: import('../../shared/supervision-config.js').SupervisionTaskRegistryEventType;
  status: import('../../shared/supervision-config.js').SupervisionTaskLifecycleStatus;
  payload?: Record<string, unknown>;
  createdAt: number;
}

export interface PersistedSupervisionTaskFileEvent {
  id: number;
  taskId: string;
  assignmentId: string;
  path: string;
  operation: import('../../shared/supervision-config.js').SupervisionTaskFileOperation;
  beforeHash?: string;
  afterHash?: string;
  tool?: string;
  source?: string;
  identity: PersistedSupervisionTaskAssignmentIdentity;
  createdAt: number;
}

export type PersistedSupervisionCompletionEvidenceStatus = 'pending' | 'adopted' | 'discarded';

/** Frozen implementation evidence observed after the worker was cancelled. */
export interface PersistedSupervisionCompletionEvidence {
  evidenceId: string;
  taskId: string;
  sourceAssignmentId: string;
  revision: string;
  manifestSha256: string;
  worktreePath: string;
  headSha: string;
  files: SupervisionWorktreeSnapshot['files'];
  evidence?: string;
  status: PersistedSupervisionCompletionEvidenceStatus;
  adoptedByAssignmentId?: string;
  resolutionReason?: string;
  createdAt: number;
  resolvedAt?: number;
}

/** One same-object forward step taken by {@link SupervisionTaskRegistry.convergeLifecycle}. */
/** Why a receipt may not bind to an auditor. */
export type SupervisionAuditReceiptAuthorityRejection =
  'not_found' | 'owner_mismatch' | 'old_audit_attempt' | 'old_revision' | 'invalid';

/**
 * THE authority rule for binding an audit receipt to an auditor.
 *
 * This is a pure predicate on purpose: `appendMatchingAuditReceipt` evaluates
 * it once before opening the write transaction and again on the locked rows
 * inside it, so the TOCTOU defence is preserved while the rule itself exists in
 * exactly one place. Relaxing any single clause here is therefore observable
 * from the real entry point rather than silently covered by a duplicate check.
 *
 * It binds, together: the auditor identity, the assignment, the attempt, the
 * revision (against BOTH the auditor and the task), and — for a final receipt —
 * a PASS/REWORK verdict.
 */
export function evaluateAuditReceiptAuthority(input: {
  task: Pick<PersistedSupervisionTaskRecord, 'taskId' | 'currentRevision'> | undefined;
  audit: Pick<PersistedSupervisionTaskAssignment,
    'taskId' | 'assignmentId' | 'role' | 'identity' | 'auditAttemptId' | 'auditRevision'> | undefined;
  taskId: string;
  assignmentId: string;
  attemptId: string;
  revision: string;
  receiptKind: PeerAuditReceiptKind;
  verdict?: PeerAuditVerdict;
  auditorIdentity: PersistedSupervisionTaskAssignmentIdentity;
  auditorSessionName: string;
}): { ok: true } | { ok: false; reason: SupervisionAuditReceiptAuthorityRejection } {
  const { task, audit } = input;
  if (!task || !audit || audit.taskId !== input.taskId || audit.role !== 'auditor') {
    return { ok: false, reason: 'not_found' };
  }
  if (audit.assignmentId !== input.assignmentId) return { ok: false, reason: 'not_found' };
  if (!identityMatches(audit.identity, input.auditorIdentity)
    || audit.identity.sessionName !== input.auditorSessionName) {
    return { ok: false, reason: 'owner_mismatch' };
  }
  if (audit.auditAttemptId !== input.attemptId) return { ok: false, reason: 'old_audit_attempt' };
  if (audit.auditRevision !== input.revision
    || (task.currentRevision && task.currentRevision !== input.revision)) {
    return { ok: false, reason: 'old_revision' };
  }
  if (input.receiptKind === 'final' && input.verdict !== 'PASS' && input.verdict !== 'REWORK') {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true };
}

export interface SupervisionLifecycleConvergenceAction {
  taskId: string;
  assignmentId?: string;
  action: 'retire_consumed_slice'
    | 'align_revision_projection'
    | 'align_validated_revision'
    | 'bind_zero_byte_base_revision'
    | 'restore_exact_rework_implementer'
    | 'project_validated_handoff'
    | 'close_recorded_audit_receipt'
    | 'rebind_stale_coordinator'
    | 'retire_consumed_finalized_implementer'
    | 'retire_stale_finalized_owner_projection'
    | 'clear_consumed_finalized_owner_pointer'
    | 'adopt_cancelled_completion_evidence'
    | 'request_cancelled_completion_evidence_decision'
    | 'record_already_present_delivery'
    | 'retire_terminal_stale_auditor';
}

/** Runtime authority the registry cannot know by itself. */
export interface SupervisionLifecycleConvergenceOptions {
  limit?: number;
  /** Read-only inspection of the assignment's authoritative worktree. */
  inspectAssignmentWorktree?: (
    assignment: PersistedSupervisionTaskAssignment,
  ) => SupervisionWorktreeSnapshot | undefined;
  /** The live runtime for the task's durable project + coordinator session. */
  resolveAuthoritativeBrain?: (
    projectName: string | null | undefined,
    sessionName?: string | null | undefined,
  ) =>
    PersistedSupervisionTaskAssignmentIdentity | undefined;
}

/** Bounded default so one tick can never walk the whole registry. */
export const SUPERVISION_LIFECYCLE_CONVERGENCE_LIMIT = 25;

export interface SupervisionTaskCreateInput {
  /** Runtime-resolved caller project; never accepted from model metadata. */
  projectName?: string | null;
  /**
   * Model/user PROPOSED semantic key, strict kebab-case. When present the
   * daemon mints the canonical id and `taskId` is ignored -- uniqueness is
   * never model-controlled. Prefer this over `taskId` for all new callers.
   */
  semanticTaskKey?: string | null;
  /** @deprecated Legacy caller-supplied id. Use `semanticTaskKey`. */
  taskId?: string | null;
  topLevelTaskId?: string | null;
  classification?: import('../../shared/supervision-config.js').SupervisionTaskClassification | null;
  objective?: string | null;
  acceptance?: readonly string[] | null;
  /** Internal Brain-derived value; never published on worker task metadata. */
  auditPolicy?: SupervisionTaskAuditPolicy | null;
  baseRevision?: string | null;
  currentRevision?: string | null;
  idempotencyKey?: string | null;
  now?: number;
}

export interface SupervisionTaskAssignmentInput {
  /** Proposed semantic key; daemon mints the canonical assignment id. */
  semanticAssignmentKey?: string | null;
  assignmentId?: string | null;
  taskId: string;
  role: PersistedSupervisionTaskAssignment['role'];
  identity: PersistedSupervisionTaskAssignmentIdentity;
  scopeFiles?: readonly string[] | null;
  claimMode?: PersistedSupervisionTaskFileClaim['claimMode'];
  required?: boolean;
  auditAttemptId?: string | null;
  auditRevision?: string | number | null;
  executionBinding?: SupervisionExecutionBinding | null;
  economyPolicy?: SupervisionEconomyTaskPolicy | null;
  auditRoutingReason?: SupervisionAuditRoutingReason | null;
  auditDegradedReason?: SupervisionAuditDegradedReason | null;
  provisioning?: SupervisionProvisioningEvidence | null;
  idempotencyKey?: string | null;
  now?: number;
}

export interface SupervisionTaskAssignmentUpdateInput {
  assignmentId: string;
  identity: PersistedSupervisionTaskAssignmentIdentity;
  status?: import('../../shared/supervision-config.js').SupervisionTaskLifecycleStatus;
  revision?: string | number | null;
  auditAttemptId?: string | null;
  auditRevision?: string | number | null;
  verdict?: string | null;
  blocker?: string | null;
  externalRunId?: string | null;
  externalHeadSha?: string | null;
  externalTaskId?: string | null;
  primaryReviewPassed?: boolean;
  crossVendorAuditPassed?: boolean;
  auditRoutingReason?: SupervisionAuditRoutingReason | null;
  now?: number;
}

export interface SupervisionMatchingAuditReceiptInput {
  taskId?: string;
  auditorAssignmentId?: string;
  attemptId: string;
  revision: string;
  receiptKind?: PeerAuditReceiptKind;
  verdict?: PeerAuditVerdict;
  auditedSessionName: string;
  auditorSessionName: string;
  auditorIdentity?: PersistedSupervisionTaskAssignmentIdentity;
  findings?: string;
  validations?: readonly PeerAuditValidationItem[];
  now?: number;
}

export interface PersistedSupervisionAuditReceipt {
  receiptId: string;
  taskId: string;
  assignmentId: string;
  attemptId: string;
  revision: string;
  sequence: number;
  receiptKind: PeerAuditReceiptKind;
  verdict?: PeerAuditVerdict;
  findings: string;
  validations: PeerAuditValidationItem[];
  supersedesReceiptId?: string;
  senderIdentity: PersistedSupervisionTaskAssignmentIdentity;
  createdAt: number;
}

export interface SupervisionTaskUpdateInput {
  taskId: string;
  status?: import('../../shared/supervision-config.js').SupervisionTaskLifecycleStatus;
  /** Internal Brain-authorized bind; an existing policy is immutable. */
  auditPolicy?: SupervisionTaskAuditPolicy | null;
  /** Immutable Git base selected before an assignment worktree is delivered. */
  baseRevision?: string | null;
  currentRevision?: string | number | null;
  commitSha?: string | null;
  pushRemoteRef?: string | null;
  blocker?: string | null;
  now?: number;
}

export interface SupervisionTaskAssignmentFinishInput {
  assignmentId: string;
  identity: PersistedSupervisionTaskAssignmentIdentity;
  revision?: string | null;
  evidence?: string | null;
  now?: number;
}

export interface SupervisionCancelledCompletionEvidenceInput {
  taskId: string;
  assignmentId: string;
  identity: PersistedSupervisionTaskAssignmentIdentity;
  revision?: string | null;
  worktreeSnapshot: SupervisionWorktreeSnapshot;
  evidence?: string | null;
  now?: number;
}

export interface SupervisionIntegrationFinalizationInput {
  assignmentId: string;
  identity: PersistedSupervisionTaskAssignmentIdentity;
  revision: string;
  auditAttemptId: string;
  auditRevision: string;
  verdict: 'PASS';
  ownedFiles: readonly string[];
  integrationManifest: readonly SupervisionIntegrationManifestEntry[];
  integrationOwner: string;
  commitSha: string;
  pushResult: 'pushed' | 'already_present';
  pushRemoteRef: string;
  stagedPaths: readonly string[];
  conflictedPaths: readonly string[];
  untrackedOtherOwnerPaths: readonly string[];
  externalRunId?: string;
  externalHeadSha?: string;
  externalTaskId?: string;
  ciResult?: import('../../shared/supervision-config.js').SupervisionCiSmokeStatus;
  evidence?: string;
  now?: number;
}

export interface SupervisionTaskFileEventInput {
  assignmentId: string;
  path: string;
  operation: import('../../shared/supervision-config.js').SupervisionTaskFileOperation;
  identity: PersistedSupervisionTaskAssignmentIdentity;
  beforeHash?: string | null;
  afterHash?: string | null;
  tool?: string | null;
  source?: string | null;
  idempotencyKey?: string | null;
  now?: number;
}

export interface SupervisionTaskScopeReconcileInput {
  taskId: string;
  assignmentId?: string | null;
  trackedPaths?: readonly string[] | null;
  untrackedPaths?: readonly string[] | null;
  deletedPaths?: readonly string[] | null;
  currentRevision?: string | null;
  now?: number;
}

export interface SupervisionTaskSnapshot extends PersistedSupervisionTaskRecord {
  assignments: PersistedSupervisionTaskAssignment[];
  fileClaims: PersistedSupervisionTaskFileClaim[];
  touchedFiles: string[];
  events?: PersistedSupervisionTaskEvent[];
  auditReceipts?: PersistedSupervisionAuditReceipt[];
  completionEvidence?: PersistedSupervisionCompletionEvidence[];
}

export type SupervisionHousekeepingMode = 'dryRun' | 'apply';
export type SupervisionHousekeepingActionKind =
  | 'backfill_orphan_project'
  | 'quarantine_orphan'
  | 'release_terminal_assignment'
  | 'retire_consumed_assignment'
  | 'repair_aggregate'
  | 'repair_revision'
  | 'archive_terminal'
  | 'archive_abandoned'
  | 'archive_superseded'
  | 'mark_duplicate_candidate';

export interface SupervisionHousekeepingAction {
  taskId: string;
  kind: SupervisionHousekeepingActionKind;
  assignmentId?: string;
  fromStatus?: SupervisionTaskLifecycleStatus;
  toStatus?: SupervisionTaskLifecycleStatus;
  fromRevision?: string;
  toRevision?: string;
  relatedTaskId?: string;
  projectName?: string;
  reason?: string;
}

/**
 * The scope a quarantined orphan is parked under.
 *
 * The SQLite guard installed by MIGRATION_3 refuses any supervision_tasks row
 * whose project_name is null or blank, and that guard is correct: an
 * unscoped task is exactly what housekeeping exists to eliminate. Quarantine
 * therefore has to name a scope, and it must not be a GUESS at a real project
 * — an orphan reached quarantine precisely because no authoritative lineage
 * could be established, so inventing one would launder an unknown into a
 * claim.
 *
 * This reserved value follows the `__…__` convention already used for
 * `__legacy_unscoped__`. It is not derivable from any session name (project
 * scope comes from `deck_{project}_{role}`, which cannot produce leading or
 * trailing underscores of this shape), so it cannot collide with, or be
 * addressed as, a caller's project.
 */
export const SUPERVISION_ORPHAN_QUARANTINE_SCOPE = '__orphan_quarantine__';

/** True for scopes that exist for bookkeeping and must never route as a project. */
export function isReservedSupervisionProjectScope(value: string | null | undefined): boolean {
  return value === SUPERVISION_ORPHAN_QUARANTINE_SCOPE;
}

/** An action that was planned but could not be applied, kept per action. */
export interface SupervisionHousekeepingActionFailure {
  taskId: string;
  kind: SupervisionHousekeepingActionKind;
  error: string;
}

export interface SupervisionHousekeepingDiagnostic {
  taskId: string;
  reason: 'orphan_project_backfill_ready' | 'orphan_project_ambiguous' | 'orphan_project_quarantine_ready';
  assignmentIds: string[];
  sessionNames: string[];
}

export interface SupervisionHousekeepingResult {
  mode: SupervisionHousekeepingMode;
  cursor?: string;
  nextCursor?: string;
  hasMore: boolean;
  scanned: number;
  activeCount: number;
  archivedCount: number;
  actionCounts: Partial<Record<SupervisionHousekeepingActionKind, number>>;
  actions: SupervisionHousekeepingAction[];
  orphanDiagnostics: SupervisionHousekeepingDiagnostic[];
  /** Whether this caller is PERMITTED to apply. Says nothing about whether the
   *  planned actions can actually execute. */
  applyAuthorized: boolean;
  /** Whether every planned action is executable. A dryRun that reports
   *  authorized-but-not-feasible is telling the caller that applying would
   *  fail, which is exactly what the two fields being conflated used to hide. */
  applyFeasible: boolean;
  /** Actions that were attempted and failed, one entry each. Their failure did
   *  not discard the actions that succeeded. */
  failedActions: SupervisionHousekeepingActionFailure[];
}

/**
 * Why a revision/attempt comparison failed, in terms the caller can act on.
 *
 * A bare reason string forced every caller to guess what was compared against
 * what; a whole session of `old_revision` rejections could not be diagnosed
 * from the response at all. These fields carry ONLY control-plane identifiers
 * and lifecycle status. Capabilities, tokens, evidence bytes and worktree paths
 * are deliberately absent: a rejection is not an oracle.
 */
export interface SupervisionTaskRegistryRejectDetail {
  taskStatus?: string;
  assignmentStatus?: string;
  expectedRevision?: string;
  actualRevision?: string;
  expectedAttemptId?: string;
  actualAttemptId?: string;
}

export type SupervisionTaskRegistryResult<T> =
  | { ok: true; value: T; replay?: boolean }
  | { ok: false; reason: 'invalid' | 'duplicate_task' | 'duplicate_assignment' | 'not_found' | 'invalid_transition' | 'owner_mismatch' | 'old_revision' | 'stale_audit_revision' | 'old_audit_attempt' | 'manifest_mismatch' | 'role_forbidden' | 'ambiguous_assignment' | 'economy_requires_primary_review' | 'receipt_closed' | 'conflicting_replay'; detail?: SupervisionTaskRegistryRejectDetail };

const COMPACT_ID_COLLISION_ATTEMPTS = 8;

function compactSequenceCandidate(sequence: string, attempt: number): string {
  return attempt === 0 ? sequence : `${sequence}-${attempt.toString(36)}`;
}

function normalizeTaskString(value: string | number | null | undefined): string | undefined {
  const text = typeof value === 'number' ? String(value) : value?.trim();
  return text ? text : undefined;
}

function normalizeTaskArray(values: readonly string[] | null | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();
}

function auditReceiptDigest(input: {
  taskId: string;
  assignmentId: string;
  attemptId: string;
  revision: string;
  receiptKind: PeerAuditReceiptKind;
  verdict?: PeerAuditVerdict;
  findings: string;
  validations: readonly PeerAuditValidationItem[];
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function validRepoPath(path: string): boolean {
  return Boolean(path) && !path.startsWith('/') && !path.split('/').includes('..') && !/[\u0000-\u001f\u007f]/.test(path);
}

const FINALIZATION_SHA256_RE = /^[0-9a-f]{64}$/;
const FINALIZATION_COMMIT_RE = /^[0-9a-f]{40}$/;

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assignmentHasLiveValidationOrAudit(
  assignment: PersistedSupervisionTaskAssignment,
): boolean {
  // REWORK is already an invalidated round. Additional observed paths remain
  // evidence and must not manufacture a new lifecycle transition.
  if (assignment.status === 'rework') return false;
  return !['delegated', 'implementing', 'retrying_external_ci'].includes(assignment.status)
    || Boolean(assignment.auditAttemptId || assignment.verdict
      || assignment.primaryReviewPassed || assignment.crossVendorAuditPassed);
}

const SCOPE_EVIDENCE_CLOSED_ASSIGNMENT_STATUSES = new Set<SupervisionTaskLifecycleStatus>([
  'ready_for_integration', 'integrating', 'final_audit', 'finalizing',
  'committed', 'pushed', 'recovered', 'finalized', 'blocked', 'cancelled',
]);
const SCOPE_EVIDENCE_CLOSED_TASK_STATUSES = new Set<SupervisionTaskLifecycleStatus>([
  'integrating', 'final_audit', 'finalizing', 'committed', 'pushed',
  'recovered', 'finalized', 'blocked', 'cancelled',
]);

function scopeEvidenceRoundIsClosed(
  task: PersistedSupervisionTaskRecord,
  assignment: PersistedSupervisionTaskAssignment,
): boolean {
  return task.archivedAt !== undefined
    || task.finalization !== undefined
    || task.commitSha !== undefined
    || task.pushRemoteRef !== undefined
    || SCOPE_EVIDENCE_CLOSED_TASK_STATUSES.has(task.status)
    || SCOPE_EVIDENCE_CLOSED_ASSIGNMENT_STATUSES.has(assignment.status);
}

function sameWorktreeManifest(
  left: unknown,
  right: readonly SupervisionWorktreeSnapshot['files'][number][],
): boolean {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  return left.every((value, index) => {
    if (!value || typeof value !== 'object') return false;
    const entry = value as { path?: unknown; sha256?: unknown; deleted?: unknown };
    const expected = right[index];
    return entry.path === expected?.path
      && entry.sha256 === expected.sha256
      && entry.deleted === expected.deleted;
  });
}

/**
 * Lifecycle paths by which an exact audit receipt may advance its target.
 * Keeping selection and transition on this same table prevents a stale
 * same-session assignment from becoming eligible merely because it was
 * returned first by SQLite.
 */
const AUDIT_RECEIPT_TO_AUDITING: Partial<Record<SupervisionTaskLifecycleStatus, readonly SupervisionTaskLifecycleStatus[]>> = {
  delegated: ['auditing'],
  implementing: ['validated', 'ready_for_audit', 'auditing'],
  retrying_external_ci: ['validated', 'ready_for_audit', 'auditing'],
  validated: ['ready_for_audit', 'auditing'],
  ready_for_audit: ['auditing'],
  rework: ['auditing'],
  auditing: [],
};

const AUDIT_RECEIPT_PENDING_TARGET_STATUSES = new Set<SupervisionTaskLifecycleStatus>([
  'validated',
  'ready_for_audit',
  'auditing',
  'rework',
]);

type FinalizedAuditAuthorityReplayPlan =
  | { kind: 'noop' }
  | { kind: 'repair'; target: PersistedSupervisionTaskAssignment; receipt: PersistedSupervisionAuditReceipt }
  | { kind: 'reject'; reason: 'invalid_transition' | 'owner_mismatch' | 'old_revision' | 'old_audit_attempt' | 'ambiguous_assignment' | 'receipt_closed' };

/**
 * Recognise the one historical shape left by daemons that finalized an exact
 * PASS auditor before copying the immutable receipt authority to the selected
 * implementer. This is deliberately not a general audit-target selector: a
 * repair is possible only for one required, still-open implementer whose
 * ready-for-integration projection already carries the exact PASS revision.
 */
function planFinalizedAuditAuthorityReplay(input: {
  task: PersistedSupervisionTaskRecord;
  auditor: PersistedSupervisionTaskAssignment;
  assignments: readonly PersistedSupervisionTaskAssignment[];
  receipts: readonly PersistedSupervisionAuditReceipt[];
  claimedAssignmentIds: ReadonlySet<string>;
}): FinalizedAuditAuthorityReplayPlan {
  const { task, auditor, assignments, receipts, claimedAssignmentIds } = input;
  const attemptId = normalizeTaskString(auditor.auditAttemptId);
  const revision = normalizeTaskString(auditor.auditRevision);
  const activeImplementers = assignments.filter((assignment) => (
    assignment.role === 'implementer'
    && assignment.required
    && !['cancelled', 'recovered', 'finalized'].includes(assignment.status)
  ));
  const alreadyBound = activeImplementers.length === 1
    && activeImplementers[0].status === 'ready_for_integration'
    && activeImplementers[0].auditAttemptId === attemptId
    && activeImplementers[0].auditRevision === revision
    && activeImplementers[0].verdict?.trim().toUpperCase() === 'PASS'
    && activeImplementers[0].crossVendorAuditPassed === true;
  if (alreadyBound || activeImplementers.length === 0) return { kind: 'noop' };

  const hasAuthorityGap = activeImplementers.some((assignment) => (
    assignment.status === 'ready_for_integration'
    && (assignment.auditAttemptId !== attemptId
      || assignment.auditRevision !== revision
      || assignment.verdict?.trim().toUpperCase() !== 'PASS'
      || assignment.crossVendorAuditPassed !== true)
  ));
  if (!hasAuthorityGap) return { kind: 'noop' };
  if (activeImplementers.length !== 1) return { kind: 'reject', reason: 'ambiguous_assignment' };
  if (activeImplementers[0].leaseId
    || claimedAssignmentIds.has(activeImplementers[0].assignmentId)) {
    return { kind: 'reject', reason: 'invalid_transition' };
  }

  const target = activeImplementers[0];
  const integrationHasClosedState = assignments.some((assignment) => (
    assignment.role === 'integration_owner'
    && ['integrating', 'final_audit', 'finalizing', 'committed', 'pushed', 'finalized'].includes(assignment.status)
  ));
  if (task.finalization || task.commitSha || task.pushRemoteRef || task.archivedAt
    || task.status !== 'ready_for_integration' || integrationHasClosedState) {
    return { kind: 'reject', reason: 'receipt_closed' };
  }
  if (!attemptId) return { kind: 'reject', reason: 'old_audit_attempt' };
  if (!revision || task.currentRevision !== revision || target.auditRevision !== revision) {
    return { kind: 'reject', reason: 'old_revision' };
  }
  if (target.status !== 'ready_for_integration') return { kind: 'reject', reason: 'invalid_transition' };
  if (target.identity.sessionName === auditor.identity.sessionName) {
    return { kind: 'reject', reason: 'owner_mismatch' };
  }
  if (target.auditAttemptId !== undefined
    || target.verdict?.trim().toUpperCase() !== 'PASS'
    || target.crossVendorAuditPassed !== undefined) {
    return { kind: 'reject', reason: 'old_audit_attempt' };
  }

  const latestFinal = receipts.filter((receipt) => (
    receipt.assignmentId === auditor.assignmentId
    && receipt.attemptId === attemptId
    && receipt.revision === revision
    && receipt.receiptKind === 'final'
  )).at(-1);
  if (!latestFinal || latestFinal.verdict !== 'PASS'
    || auditor.verdict?.trim().toUpperCase() !== 'PASS') {
    return { kind: 'reject', reason: 'old_audit_attempt' };
  }
  return { kind: 'repair', target, receipt: latestFinal };
}

function isExactAuditReceiptTarget(
  assignment: PersistedSupervisionTaskAssignment,
  attemptId: string,
  revision: string,
): boolean {
  const exactReceiptBinding = assignment.auditAttemptId === attemptId
    && assignment.auditRevision === revision;
  if (!exactReceiptBinding) return false;
  return assignment.status in AUDIT_RECEIPT_TO_AUDITING
    || assignment.status === 'passed'
    || assignment.status === 'ready_for_integration';
}

function safeJsonParseObject(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function parseTaskRow(row: Record<string, unknown>): PersistedSupervisionTaskRecord | undefined {
  const payload = safeJsonParseObject(typeof row.payloadJson === 'string' ? row.payloadJson : undefined);
  if (!payload || payload.version !== SUPERVISION_TASK_REGISTRY_DB_VERSION) return undefined;
  const record = payload as unknown as PersistedSupervisionTaskRecord;
  if (isSupervisionTaskAuditPolicy(payload.auditPolicy)) return { ...record, auditPolicy: payload.auditPolicy };
  const { auditPolicy: _invalidAuditPolicy, ...legacy } = record;
  return legacy;
}

function parseAssignmentRow(row: Record<string, unknown>): PersistedSupervisionTaskAssignment | undefined {
  const payload = safeJsonParseObject(typeof row.payloadJson === 'string' ? row.payloadJson : undefined);
  if (!payload || payload.version !== SUPERVISION_TASK_REGISTRY_DB_VERSION) return undefined;
  return payload as unknown as PersistedSupervisionTaskAssignment;
}

function parseCompletionEvidenceRow(row: Record<string, unknown>): PersistedSupervisionCompletionEvidence | undefined {
  const payload = safeJsonParseObject(typeof row.payloadJson === 'string' ? row.payloadJson : undefined);
  if (!payload || typeof payload.evidenceId !== 'string' || typeof payload.taskId !== 'string'
    || typeof payload.sourceAssignmentId !== 'string' || typeof payload.revision !== 'string'
    || typeof payload.manifestSha256 !== 'string' || !Array.isArray(payload.files)
    || !['pending', 'adopted', 'discarded'].includes(String(payload.status))) return undefined;
  return payload as unknown as PersistedSupervisionCompletionEvidence;
}

function parseEventRow(row: Record<string, unknown>): PersistedSupervisionTaskEvent {
  const payload = safeJsonParseObject(typeof row.payloadJson === 'string' ? row.payloadJson : undefined);
  const assignmentId = normalizeTaskString(row.assignmentId as string | undefined);
  return {
    id: Number(row.id ?? 0),
    taskId: String(row.taskId ?? ''),
    ...(assignmentId ? { assignmentId } : {}),
    eventType: String(row.eventType ?? 'created') as import('../../shared/supervision-config.js').SupervisionTaskRegistryEventType,
    status: String(row.status ?? 'planned') as import('../../shared/supervision-config.js').SupervisionTaskLifecycleStatus,
    ...(payload ? { payload } : {}),
    createdAt: Number(row.createdAt ?? 0),
  };
}

/** Re-exported from the ONE shared participant-authority boundary. Defining a
 *  second copy here is what let the task-visibility gate drift to name-only. */
const identityMatches = supervisionIdentityMatches;

function runtimeIdentityMetadataMatches(
  left: PersistedSupervisionTaskAssignmentIdentity,
  right: PersistedSupervisionTaskAssignmentIdentity,
): boolean {
  return left.sessionName === right.sessionName
    && left.sessionInstanceId === right.sessionInstanceId
    && left.runtimeEpoch === right.runtimeEpoch
    && left.agentType === right.agentType
    && left.providerFamily === right.providerFamily;
}

const HOUSEKEEPING_ASSIGNMENT_TERMINAL = new Set<SupervisionTaskLifecycleStatus>([
  'passed', 'ready_for_integration', 'committed', 'pushed', 'recovered', 'finalized', 'blocked', 'cancelled',
]);
const HOUSEKEEPING_ASSIGNMENT_AGGREGATE_TERMINAL = new Set<SupervisionTaskLifecycleStatus>([
  'committed', 'pushed', 'recovered', 'finalized', 'cancelled',
]);
const HOUSEKEEPING_ARCHIVABLE_TASK = new Set<SupervisionTaskLifecycleStatus>([
  'committed', 'pushed', 'recovered', 'finalized', 'cancelled',
]);

function normalizeObjectiveForHousekeeping(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function deterministicTerminalAggregate(
  assignments: readonly PersistedSupervisionTaskAssignment[],
): SupervisionTaskLifecycleStatus | undefined {
  const required = assignments.filter((assignment) => assignment.required);
  if (required.length === 0 || required.some((assignment) => !HOUSEKEEPING_ASSIGNMENT_AGGREGATE_TERMINAL.has(assignment.status))) {
    return undefined;
  }
  if (required.every((assignment) => assignment.status === 'cancelled')) return 'cancelled';
  if (required.some((assignment) => assignment.status === 'finalized')) return 'finalized';
  if (required.some((assignment) => assignment.status === 'recovered')) return 'recovered';
  if (required.some((assignment) => assignment.status === 'pushed')) return 'pushed';
  if (required.some((assignment) => assignment.status === 'committed')) return 'committed';
  return 'cancelled';
}

export class SupervisionTaskRegistry {
  readonly #db: DatabaseSyncInstance;
  readonly #ownsDb: boolean;
  readonly #resolveLiveParticipants?: SupervisionStateStoreOptions['resolveLiveParticipants'];
  #closed = false;

  constructor(options: SupervisionStateStoreOptions = {}) {
    this.#resolveLiveParticipants = options.resolveLiveParticipants;
    if (options.database) { this.#db = options.database; this.#ownsDb = false; }
    else {
      const dbPath = options.dbPath?.trim()
        || resolveSupervisionTaskRegistryDbPath();
      if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
      this.#db = new DatabaseSync(dbPath);
      this.#ownsDb = true;
    }
    const timeout = Math.max(0, Math.min(60_000, Math.floor(options.busyTimeoutMs ?? 5_000)));
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = ${timeout};
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS supervision_tasks (
        task_id TEXT PRIMARY KEY,
        project_name TEXT,
        top_level_task_id TEXT NOT NULL,
        classification TEXT NOT NULL,
        validation_state TEXT,
        status TEXT NOT NULL,
        current_revision TEXT,
        commit_sha TEXT,
        push_remote_ref TEXT,
        blocker TEXT,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS supervision_tasks_top_level_idx ON supervision_tasks(top_level_task_id, status);
      CREATE TABLE IF NOT EXISTS supervision_task_assignments (
        assignment_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        session_name TEXT NOT NULL,
        session_instance_id TEXT NOT NULL,
        runtime_epoch TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        provider_family TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        heartbeat_at INTEGER,
        validation_state TEXT,
        audit_attempt_id TEXT,
        audit_revision TEXT,
        verdict TEXT,
        blocker TEXT,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(task_id) REFERENCES supervision_tasks(task_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS supervision_task_assignments_task_idx ON supervision_task_assignments(task_id, role, status);
      CREATE INDEX IF NOT EXISTS supervision_task_assignments_identity_idx ON supervision_task_assignments(session_name, session_instance_id, runtime_epoch);
      CREATE TABLE IF NOT EXISTS supervision_task_file_claims (
        task_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        claim_mode TEXT NOT NULL CHECK (claim_mode IN ('exclusive','shared','read_only')),
        created_at INTEGER NOT NULL,
        PRIMARY KEY(task_id, assignment_id, file_path),
        FOREIGN KEY(task_id) REFERENCES supervision_tasks(task_id) ON DELETE CASCADE,
        FOREIGN KEY(assignment_id) REFERENCES supervision_task_assignments(assignment_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS supervision_task_file_claims_file_idx ON supervision_task_file_claims(file_path);
      CREATE TABLE IF NOT EXISTS supervision_task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        assignment_id TEXT,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(task_id) REFERENCES supervision_tasks(task_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS supervision_task_events_task_idx ON supervision_task_events(task_id, created_at);
      CREATE TABLE IF NOT EXISTS supervision_task_file_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        operation TEXT NOT NULL,
        before_hash TEXT,
        after_hash TEXT,
        tool TEXT,
        source TEXT,
        session_name TEXT NOT NULL,
        session_instance_id TEXT NOT NULL,
        runtime_epoch TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        provider_family TEXT NOT NULL,
        payload_json TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(task_id) REFERENCES supervision_tasks(task_id) ON DELETE CASCADE,
        FOREIGN KEY(assignment_id) REFERENCES supervision_task_assignments(assignment_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS supervision_task_file_events_task_idx ON supervision_task_file_events(task_id, assignment_id, created_at);
      CREATE INDEX IF NOT EXISTS supervision_task_file_events_file_idx ON supervision_task_file_events(file_path);
      CREATE TABLE IF NOT EXISTS supervision_task_idempotency (
        idempotency_key TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        assignment_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS supervision_audit_attestations (
        attempt_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        revision TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK (verdict IN ('PASS','REWORK')),
        auditor_session_name TEXT NOT NULL,
        findings TEXT,
        event_id INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS supervision_audit_attestations_task_idx
        ON supervision_audit_attestations(task_id, created_at);
      CREATE TABLE IF NOT EXISTS supervision_audit_receipts (
        receipt_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        revision TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        receipt_kind TEXT NOT NULL CHECK (receipt_kind IN ('progress','final')),
        verdict TEXT CHECK (verdict IS NULL OR verdict IN ('PASS','REWORK')),
        findings TEXT NOT NULL,
        validations_json TEXT NOT NULL,
        receipt_digest TEXT NOT NULL,
        supersedes_receipt_id TEXT,
        sender_identity_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(assignment_id, attempt_id, revision, sequence),
        UNIQUE(assignment_id, attempt_id, revision, receipt_digest),
        FOREIGN KEY(task_id) REFERENCES supervision_tasks(task_id) ON DELETE RESTRICT,
        FOREIGN KEY(assignment_id) REFERENCES supervision_task_assignments(assignment_id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS supervision_audit_receipts_attempt_idx
        ON supervision_audit_receipts(attempt_id, revision, sequence);
      CREATE INDEX IF NOT EXISTS supervision_audit_receipts_task_idx
        ON supervision_audit_receipts(task_id, created_at);
      CREATE TABLE IF NOT EXISTS supervision_task_completion_evidence (
        evidence_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        source_assignment_id TEXT NOT NULL,
        revision TEXT NOT NULL,
        manifest_sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','adopted','discarded')),
        adopted_by_assignment_id TEXT,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        UNIQUE(source_assignment_id, revision, manifest_sha256),
        FOREIGN KEY(task_id) REFERENCES supervision_tasks(task_id) ON DELETE RESTRICT,
        FOREIGN KEY(source_assignment_id) REFERENCES supervision_task_assignments(assignment_id) ON DELETE RESTRICT,
        FOREIGN KEY(adopted_by_assignment_id) REFERENCES supervision_task_assignments(assignment_id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS supervision_task_completion_evidence_task_idx
        ON supervision_task_completion_evidence(task_id, status, created_at);
      CREATE TABLE IF NOT EXISTS supervision_convergence_cursor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        task_id TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO supervision_convergence_cursor (id, task_id, updated_at)
        VALUES (1, '', 0);
      CREATE TABLE IF NOT EXISTS supervision_housekeeping_state (
        project_name TEXT PRIMARY KEY,
        apply_authorized INTEGER NOT NULL DEFAULT 0,
        cursor TEXT,
        next_due_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS supervision_worktree_gc_state (
        project_name TEXT PRIMARY KEY,
        cursor TEXT,
        next_due_at INTEGER NOT NULL DEFAULT 0,
        last_result_json TEXT,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
    `);
    const taskColumns = new Set((this.#db.prepare('PRAGMA table_info(supervision_tasks)').all() as Array<{ name?: unknown }>)
      .map((row) => String(row.name ?? '')));
    if (!taskColumns.has('project_name')) {
      this.#db.exec('ALTER TABLE supervision_tasks ADD COLUMN project_name TEXT;');
    }
    this.#db.exec('CREATE INDEX IF NOT EXISTS supervision_tasks_project_idx ON supervision_tasks(project_name, updated_at);');
    // File claims predate per-assignment worktrees. They are retained as a
    // compatibility table so older databases still open, but they are no
    // longer an admission authority and must not survive into projections.
    this.#db.exec('DELETE FROM supervision_task_file_claims;');
    // Preserve the pre-existing cancelled-task crash-window repair, but bound
    // it to one small page. Broader archive/aggregate cleanup remains inert
    // until Brain inspects dry-run counts and explicitly authorizes apply.
    this.#reconcileCancelledTaskResources();
    // A final authenticated receipt is durable authority, but older daemons
    // could crash (or reject the follow-up FINISHED edge) after persisting it
    // and before releasing the auditor/implementer leases. Repair only exact,
    // unambiguous rows through the ordinary finish path. Any refusal is a
    // zero-mutation no-op, leaving the same-object Brain/manual fallback live.
    this.#reconcileAcceptedFinalAuditReceipts();
  }

  /** Atomically repair rows left by the legacy task-only cancel write. */
  #reconcileCancelledTaskResources(): void {
    const taskIds = (this.#db.prepare(
      `SELECT task_id AS taskId FROM supervision_tasks WHERE status = 'cancelled'
       ORDER BY task_id LIMIT ${SUPERVISION_TASK_HOUSEKEEPING_DEFAULT_BATCH_SIZE}`,
    ).all() as Array<{ taskId?: unknown }>)
      .map((row) => typeof row.taskId === 'string' ? row.taskId : '')
      .filter(Boolean);
    if (taskIds.length === 0) return;
    const terminal = new Set<SupervisionTaskLifecycleStatus>(['finalized', 'pushed', 'cancelled']);
    const now = Date.now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const taskId of taskIds) {
        const task = this.getTaskRecord(taskId);
        if (!task) continue;
        const assignments = this.listAssignments(taskId);
        const staleAssignments = assignments.filter((assignment) => (
          assignment.leaseId || !terminal.has(assignment.status)
        ));
        if (staleAssignments.length === 0 && task.status === 'cancelled') continue;
        for (const assignment of staleAssignments) {
          const status = terminal.has(assignment.status) ? assignment.status : 'cancelled';
          this.#writeAssignment({
            ...assignment,
            status,
            leaseId: '',
            ...(status === 'cancelled' && !assignment.blocker
              ? { blocker: 'reconciled_cancelled_task' }
              : {}),
            updatedAt: now,
          }, 'cancelled', {
            source: 'startup_cancel_reconcile',
            leaseRevoked: true,
            assignmentStatusPreserved: status !== 'cancelled',
          });
        }
        this.#writeTask({ ...task, status: 'cancelled', updatedAt: now }, 'cancelled', {
          source: 'startup_cancel_reconcile',
          assignmentsCancelled: staleAssignments.filter((assignment) => !terminal.has(assignment.status)).length,
        });
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #reconcileAcceptedFinalAuditReceipts(): void {
    const rows = this.#db.prepare(`
      SELECT DISTINCT a.assignment_id AS assignmentId
      FROM supervision_task_assignments a
      INNER JOIN supervision_audit_receipts r
        ON r.assignment_id = a.assignment_id
       AND r.attempt_id = a.audit_attempt_id
       AND r.revision = a.audit_revision
       AND r.receipt_kind = 'final'
      WHERE a.role = 'auditor'
        AND a.status NOT IN ('finalized', 'cancelled', 'committed', 'pushed')
      ORDER BY a.updated_at ASC, a.assignment_id ASC
      LIMIT ${SUPERVISION_TASK_HOUSEKEEPING_DEFAULT_BATCH_SIZE}
    `).all() as Array<{ assignmentId?: unknown }>;
    for (const row of rows) {
      if (typeof row.assignmentId !== 'string') continue;
      const assignment = this.getAssignment(row.assignmentId);
      if (!assignment?.auditRevision) continue;
      // finishAssignment revalidates the latest final receipt, exact
      // attempt/revision, unique target, identity and legal transitions under
      // its own write transaction. A refusal preserves every byte of history.
      try {
        this.finishAssignment({
          assignmentId: assignment.assignmentId,
          identity: assignment.identity,
          revision: assignment.auditRevision,
        });
      } catch (error) {
        // Startup must remain available so Brain can use the same-object
        // manual recovery path. The receipt and every assignment stay intact
        // because finishAssignment owns an atomic transaction.
        logger.warn({ err: error, assignmentId: assignment.assignmentId },
          'Accepted supervision audit receipt reconciliation deferred');
      }
    }
  }


  close(): void { if (this.#ownsDb && !this.#closed) this.#db.close(); this.#closed = true; }

  /**
   * Reuse the already-durable AUTOINCREMENT sequence of the event that the
   * surrounding transaction is about to append. BEGIN IMMEDIATE serializes the
   * read with that append across connections, so clocks, restarts and process
   * counters cannot collide. No sequence table or migration is needed.
   */
  #nextEventSequence(): string {
    const row = this.#db.prepare(
      `SELECT CAST(COALESCE((SELECT seq FROM sqlite_sequence
        WHERE name = 'supervision_task_events'), 0) + 1 AS TEXT) AS nextSequence`,
    ).get() as { nextSequence?: unknown } | undefined;
    const next = typeof row?.nextSequence === 'string' ? BigInt(row.nextSequence) : 1n;
    return next.toString(36);
  }

  #mintOpaqueId(
    kind: 'task' | 'assignment' | 'lease',
    exists: (id: string) => boolean,
  ): string {
    const sequence = this.#nextEventSequence();
    const prefix = SUPERVISION_ID_PREFIXES[kind];
    for (let attempt = 0; attempt < COMPACT_ID_COLLISION_ATTEMPTS; attempt += 1) {
      const id = `${prefix}_${compactSequenceCandidate(sequence, attempt)}`;
      if (!exists(id)) return id;
    }
    throw new Error(`unable to mint unique ${kind} id from durable event sequence`);
  }

  #mintLeaseId(): string {
    return this.#mintOpaqueId('lease', (id) => Boolean(this.#db.prepare(
      'SELECT 1 AS found FROM supervision_task_assignments WHERE lease_id = ? LIMIT 1',
    ).get(id)));
  }

  #appendEvent(taskId: string, assignmentId: string | undefined, eventType: import('../../shared/supervision-config.js').SupervisionTaskRegistryEventType, status: import('../../shared/supervision-config.js').SupervisionTaskLifecycleStatus, payload: Record<string, unknown> | undefined, now: number): void {
    this.#db.prepare(`INSERT INTO supervision_task_events (task_id, assignment_id, event_type, status, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(taskId, assignmentId ?? null, eventType, status, payload ? JSON.stringify(payload) : null, now);
  }

  #writeTask(record: PersistedSupervisionTaskRecord, eventType: import('../../shared/supervision-config.js').SupervisionTaskRegistryEventType, payload?: Record<string, unknown>): void {
    this.#db.prepare(`
      INSERT INTO supervision_tasks (task_id, project_name, top_level_task_id, classification, status, current_revision, commit_sha, push_remote_ref, blocker, validation_state, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        project_name=excluded.project_name, top_level_task_id=excluded.top_level_task_id, classification=excluded.classification, status=excluded.status,
        current_revision=excluded.current_revision, commit_sha=excluded.commit_sha, push_remote_ref=excluded.push_remote_ref,
        blocker=excluded.blocker, validation_state=excluded.validation_state, payload_json=excluded.payload_json, updated_at=excluded.updated_at
    `).run(record.taskId, record.projectName, record.topLevelTaskId, record.classification, record.status, record.currentRevision ?? null, record.commitSha ?? null, record.pushRemoteRef ?? null, record.blocker ?? null, record.validationState ?? null, JSON.stringify(record), record.createdAt, record.updatedAt);
    this.#appendEvent(record.taskId, undefined, eventType, record.status, payload, record.updatedAt);
    if (['implementation_finished', 'committed', 'pushed', 'recovered', 'finalized', 'cancelled'].includes(eventType)) {
      this.#requestHousekeeping(record.projectName, record.updatedAt);
    }
  }

  #writeAssignment(record: PersistedSupervisionTaskAssignment, eventType: import('../../shared/supervision-config.js').SupervisionTaskRegistryEventType, payload?: Record<string, unknown>): void {
    const identity = record.identity;
    this.#db.prepare(`
      INSERT INTO supervision_task_assignments (assignment_id, task_id, role, status, session_name, session_instance_id, runtime_epoch, agent_type, provider_family, lease_id, generation, validation_state, audit_attempt_id, audit_revision, verdict, blocker, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(assignment_id) DO UPDATE SET
        role=excluded.role, status=excluded.status, session_name=excluded.session_name, session_instance_id=excluded.session_instance_id,
        runtime_epoch=excluded.runtime_epoch, agent_type=excluded.agent_type, provider_family=excluded.provider_family,
        lease_id=excluded.lease_id, generation=excluded.generation, validation_state=excluded.validation_state, audit_attempt_id=excluded.audit_attempt_id,
        audit_revision=excluded.audit_revision, verdict=excluded.verdict, blocker=excluded.blocker,
        payload_json=excluded.payload_json, updated_at=excluded.updated_at
    `).run(record.assignmentId, record.taskId, record.role, record.status, identity.sessionName, identity.sessionInstanceId, identity.runtimeEpoch, identity.agentType, identity.providerFamily, record.leaseId, record.generation, record.validationState ?? null, record.auditAttemptId ?? null, record.auditRevision ?? null, record.verdict ?? null, record.blocker ?? null, JSON.stringify(record), record.createdAt, record.updatedAt);
    this.#appendEvent(record.taskId, record.assignmentId, eventType, record.status, payload, record.updatedAt);
    if (['implementation_finished', 'committed', 'pushed', 'recovered', 'finalized', 'cancelled'].includes(eventType)) {
      const projectName = this.getTaskRecord(record.taskId)?.projectName;
      if (projectName) this.#requestHousekeeping(projectName, record.updatedAt);
    }
  }

  #writeCompletionEvidence(record: PersistedSupervisionCompletionEvidence): void {
    this.#db.prepare(
      `UPDATE supervision_task_completion_evidence
       SET status = ?, adopted_by_assignment_id = ?, payload_json = ?, resolved_at = ?
       WHERE evidence_id = ?`,
    ).run(record.status, record.adoptedByAssignmentId ?? null, JSON.stringify(record),
      record.resolvedAt ?? null, record.evidenceId);
  }

  #requestHousekeeping(projectName: string, now: number): void {
    this.#db.prepare(
      `UPDATE supervision_housekeeping_state
       SET next_due_at = CASE WHEN next_due_at = 0 THEN 0 ELSE MIN(next_due_at, ?) END,
           updated_at = ? WHERE project_name = ?`,
    ).run(now, now, projectName);
    this.#db.prepare(
      `INSERT INTO supervision_worktree_gc_state (project_name, cursor, next_due_at, updated_at)
       VALUES (?, NULL, ?, ?)
       ON CONFLICT(project_name) DO UPDATE SET
         next_due_at = MIN(next_due_at, excluded.next_due_at), updated_at = excluded.updated_at`,
    ).run(projectName, now, now);
  }

  get(taskId: string): SupervisionTaskSnapshot | undefined {
    const task = this.getTaskRecord(taskId);
    if (!task) return undefined;
    const assignments = this.listAssignments(taskId);
    const fileClaims = this.listFileClaims(taskId);
    const touchedFiles = [...new Set(this.listFileEvents(taskId).map((event) => event.path))].sort();
    const auditReceipts = this.listAuditReceipts(taskId);
    const completionEvidence = this.listCompletionEvidence(taskId);
    return {
      ...task, assignments, fileClaims, touchedFiles,
      ...(auditReceipts.length > 0 ? { auditReceipts } : {}),
      ...(completionEvidence.length > 0 ? { completionEvidence } : {}),
    };
  }

  getTaskRecord(taskId: string): PersistedSupervisionTaskRecord | undefined {
    if (this.#closed) return undefined;
    const row = this.#db.prepare('SELECT payload_json AS payloadJson FROM supervision_tasks WHERE task_id = ?').get(taskId) as Record<string, unknown> | undefined;
    return row ? parseTaskRow(row) : undefined;
  }

  getAssignment(assignmentId: string): PersistedSupervisionTaskAssignment | undefined {
    if (this.#closed) return undefined;
    const row = this.#db.prepare('SELECT payload_json AS payloadJson FROM supervision_task_assignments WHERE assignment_id = ?').get(assignmentId) as Record<string, unknown> | undefined;
    return row ? parseAssignmentRow(row) : undefined;
  }

  list(filter: {
    status?: import('../../shared/supervision-config.js').SupervisionTaskLifecycleStatus;
    topLevelTaskId?: string;
    ownerSessionName?: string;
    projectName?: string;
    includeArchived?: boolean;
    history?: boolean;
    cursor?: string;
    limit?: number;
  } = {}): SupervisionTaskSnapshot[] {
    if (this.#closed) return [];
    let sql = 'SELECT DISTINCT t.payload_json AS payloadJson FROM supervision_tasks t LEFT JOIN supervision_task_assignments a ON a.task_id = t.task_id WHERE 1=1';
    const params: Array<string | number> = [];
    if (filter.projectName) { sql += ' AND t.project_name = ?'; params.push(filter.projectName); }
    if (filter.status) { sql += ' AND t.status = ?'; params.push(filter.status); }
    if (filter.topLevelTaskId) { sql += ' AND t.top_level_task_id = ?'; params.push(filter.topLevelTaskId); }
    if (filter.ownerSessionName) { sql += ' AND a.session_name = ?'; params.push(filter.ownerSessionName); }
    if (filter.cursor) { sql += ' AND t.task_id > ?'; params.push(filter.cursor); }
    sql += ' ORDER BY t.task_id ASC';
    const limit = filter.limit === undefined
      ? undefined
      : Math.max(1, Math.min(SUPERVISION_TASK_HOUSEKEEPING_MAX_BATCH_SIZE + 1, Math.floor(filter.limit)));
    if (limit !== undefined) { sql += ' LIMIT ?'; params.push(limit); }
    return (this.#db.prepare(sql).all(...params) as Array<Record<string, unknown>>)
      .map(parseTaskRow)
      .filter((record): record is PersistedSupervisionTaskRecord => record !== undefined)
      .filter((record) => filter.history === true
        ? !isSupervisionTaskVisibleByDefault(record)
        : filter.includeArchived === true || isSupervisionTaskVisibleByDefault(record))
      .slice(0, limit ?? Number.MAX_SAFE_INTEGER)
      .map((record) => this.get(record.taskId))
      .filter((record): record is SupervisionTaskSnapshot => record !== undefined);
  }

  listAssignments(taskId: string): PersistedSupervisionTaskAssignment[] {
    if (this.#closed) return [];
    return (this.#db.prepare('SELECT payload_json AS payloadJson FROM supervision_task_assignments WHERE task_id = ? ORDER BY created_at ASC').all(taskId) as Array<Record<string, unknown>>)
      .map(parseAssignmentRow)
      .filter((record): record is PersistedSupervisionTaskAssignment => record !== undefined);
  }

  listAuditReceipts(taskId: string): PersistedSupervisionAuditReceipt[] {
    if (this.#closed) return [];
    const rows = this.#db.prepare(`
      SELECT receipt_id AS receiptId, task_id AS taskId, assignment_id AS assignmentId,
             attempt_id AS attemptId, revision, sequence, receipt_kind AS receiptKind,
             verdict, findings, validations_json AS validationsJson,
             supersedes_receipt_id AS supersedesReceiptId,
             sender_identity_json AS senderIdentityJson, created_at AS createdAt
      FROM supervision_audit_receipts
      WHERE task_id = ? ORDER BY created_at ASC, sequence ASC
    `).all(taskId) as Array<Record<string, unknown>>;
    return rows.flatMap((row) => {
      const senderIdentity = safeJsonParseObject(String(row.senderIdentityJson ?? ''));
      let validations: PeerAuditValidationItem[] = [];
      try {
        const parsed = JSON.parse(String(row.validationsJson ?? '[]')) as unknown;
        if (Array.isArray(parsed)) validations = parsed as PeerAuditValidationItem[];
      } catch { return []; }
      if (!senderIdentity) return [];
      const verdict = row.verdict === 'PASS' || row.verdict === 'REWORK' ? row.verdict : undefined;
      const supersedesReceiptId = normalizeTaskString(row.supersedesReceiptId as string | undefined);
      return [{
        receiptId: String(row.receiptId ?? ''),
        taskId: String(row.taskId ?? ''),
        assignmentId: String(row.assignmentId ?? ''),
        attemptId: String(row.attemptId ?? ''),
        revision: String(row.revision ?? ''),
        sequence: Number(row.sequence ?? 0),
        receiptKind: String(row.receiptKind ?? 'progress') as PeerAuditReceiptKind,
        ...(verdict ? { verdict } : {}),
        findings: String(row.findings ?? ''),
        validations,
        ...(supersedesReceiptId ? { supersedesReceiptId } : {}),
        senderIdentity: senderIdentity as unknown as PersistedSupervisionTaskAssignmentIdentity,
        createdAt: Number(row.createdAt ?? 0),
      }];
    });
  }

  listCompletionEvidence(taskId: string): PersistedSupervisionCompletionEvidence[] {
    if (this.#closed) return [];
    return (this.#db.prepare(
      `SELECT payload_json AS payloadJson FROM supervision_task_completion_evidence
       WHERE task_id = ? ORDER BY created_at ASC, evidence_id ASC`,
    ).all(taskId) as Array<Record<string, unknown>>)
      .map(parseCompletionEvidenceRow)
      .filter((record): record is PersistedSupervisionCompletionEvidence => record !== undefined);
  }

  listFileClaims(taskId: string): PersistedSupervisionTaskFileClaim[] {
    void taskId;
    return [];
  }

  /** Legacy claim rows stay hidden from the public evidence projection, but a
   * finalized-auditor repair must still treat them as active write authority. */
  #claimedAssignmentIds(taskId: string): Set<string> {
    if (this.#closed) return new Set();
    const rows = this.#db.prepare(`
      SELECT DISTINCT assignment_id AS assignmentId
      FROM supervision_task_file_claims WHERE task_id = ?
    `).all(taskId) as Array<{ assignmentId?: string }>;
    return new Set(rows.map((row) => normalizeTaskString(row.assignmentId)).filter((value): value is string => Boolean(value)));
  }

  listEvents(taskId: string): PersistedSupervisionTaskEvent[] {
    if (this.#closed) return [];
    return (this.#db.prepare('SELECT id, task_id AS taskId, assignment_id AS assignmentId, event_type AS eventType, status, payload_json AS payloadJson, created_at AS createdAt FROM supervision_task_events WHERE task_id = ? ORDER BY id ASC').all(taskId) as Array<Record<string, unknown>>).map(parseEventRow);
  }

  housekeepingApplyAuthorized(projectName: string): boolean {
    if (this.#closed) return false;
    const row = this.#db.prepare(
      'SELECT apply_authorized AS authorized FROM supervision_housekeeping_state WHERE project_name = ?',
    ).get(projectName) as { authorized?: number } | undefined;
    return row?.authorized === 1;
  }

  /**
   * Bounded, cursor-based retention/reconciliation. Dry-run and apply share the
   * exact planner; apply mutates only the returned batch and never deletes task,
   * assignment, audit, revision, event, or evidence provenance.
   */
  reconcileHousekeeping(input: {
    mode: SupervisionHousekeepingMode;
    projectName: string;
    cursor?: string;
    limit?: number;
    now?: number;
  }): SupervisionHousekeepingResult {
    const mode = input.mode;
    const projectName = normalizeTaskString(input.projectName);
    if (!projectName) throw new Error('housekeeping projectName is required');
    const now = input.now ?? Date.now();
    const limit = Math.max(1, Math.min(
      SUPERVISION_TASK_HOUSEKEEPING_MAX_BATCH_SIZE,
      Math.floor(input.limit ?? SUPERVISION_TASK_HOUSEKEEPING_DEFAULT_BATCH_SIZE),
    ));
    const orphanCursorPrefix = 'orphan:';
    const scanningOrphans = input.cursor?.startsWith(orphanCursorPrefix) === true;
    const orphanCursor = scanningOrphans ? input.cursor!.slice(orphanCursorPrefix.length) : '';
    const rows: SupervisionTaskSnapshot[] = scanningOrphans
      ? (this.#db.prepare(
          `SELECT payload_json AS payloadJson FROM supervision_tasks
           WHERE project_name IS NULL AND task_id > ?
           ORDER BY task_id ASC LIMIT ?`,
        ).all(orphanCursor, limit + 1) as Array<Record<string, unknown>>)
          .map(parseTaskRow)
          .filter((task): task is PersistedSupervisionTaskRecord => task !== undefined)
          .map((task) => this.get(task.taskId))
          .filter((task): task is SupervisionTaskSnapshot => task !== undefined)
      : this.list({
          includeArchived: true,
          projectName,
          ...(input.cursor ? { cursor: input.cursor } : {}),
          limit: limit + 1,
        });
    const pageHasMore = rows.length > limit;
    const batch = rows.slice(0, limit);
    const hasNullProjectRows = !scanningOrphans && !pageHasMore && Boolean(this.#db.prepare(
      'SELECT 1 AS found FROM supervision_tasks WHERE project_name IS NULL LIMIT 1',
    ).get());
    const hasMore = pageHasMore || hasNullProjectRows;
    const actions: SupervisionHousekeepingAction[] = [];
    const orphanDiagnostics: SupervisionHousekeepingDiagnostic[] = [];

    for (const task of batch) {
      const assignments = task.assignments;
      const taskEvents = this.listEvents(task.taskId);
      if (scanningOrphans) {
        const assignmentIds = assignments.map((assignment) => assignment.assignmentId).sort();
        const sessionNames = [...new Set(assignments.map((assignment) => assignment.identity.sessionName).filter(Boolean))].sort();
        const liveSessionNames = new Set(
          (this.#resolveLiveParticipants?.(projectName) ?? []).map((identity) => identity.sessionName),
        );
        const lineageProject = task.topLevelTaskId !== task.taskId
          ? normalizeTaskString(this.getTaskRecord(task.topLevelTaskId)?.projectName)
          : undefined;
        const liveMatches = sessionNames.filter((sessionName) => liveSessionNames.has(sessionName));
        const provenProject = lineageProject === projectName || liveMatches.length === 1;
        const hasLiveReference = assignments.some((assignment) => Boolean(assignment.leaseId)
          || !HOUSEKEEPING_ASSIGNMENT_TERMINAL.has(assignment.status));
        const hasDurableEvidence = Boolean(task.currentRevision || task.commitSha || task.pushRemoteRef || task.finalization)
          || taskEvents.some((event) => event.eventType !== 'created')
          || this.listAuditReceipts(task.taskId).length > 0
          || this.listCompletionEvidence(task.taskId).length > 0;
        if (provenProject) {
          actions.push({
            taskId: task.taskId,
            kind: 'backfill_orphan_project',
            projectName,
            reason: lineageProject === projectName ? 'top_level_project_lineage' : 'unique_live_session_lineage',
          });
          orphanDiagnostics.push({
            taskId: task.taskId,
            reason: 'orphan_project_backfill_ready', assignmentIds, sessionNames,
          });
        } else if (!hasLiveReference && !hasDurableEvidence) {
          actions.push({ taskId: task.taskId, kind: 'quarantine_orphan', reason: 'no_authoritative_project_lineage' });
          orphanDiagnostics.push({
            taskId: task.taskId,
            reason: 'orphan_project_quarantine_ready', assignmentIds, sessionNames,
          });
        } else {
          orphanDiagnostics.push({
            taskId: task.taskId,
            reason: 'orphan_project_ambiguous', assignmentIds, sessionNames,
          });
        }
        continue;
      }
      for (const assignment of assignments) {
        const implementationFinished = assignment.status === 'ready_for_audit'
          && taskEvents.some((event) => event.assignmentId === assignment.assignmentId
            && event.eventType === 'implementation_finished');
        if ((HOUSEKEEPING_ASSIGNMENT_TERMINAL.has(assignment.status) || implementationFinished)
          && (assignment.leaseId || assignment.cleanupVersion !== SUPERVISION_TASK_CLEANUP_VERSION)) {
          actions.push({
            taskId: task.taskId,
            assignmentId: assignment.assignmentId,
            kind: 'release_terminal_assignment',
          });
        }
      }

      const reworkProjectionRepair = this.#planReworkProjectionRepair(task, assignments);
      if (reworkProjectionRepair) actions.push(reworkProjectionRepair);

      const consumedLegacyAssignments = assignments.filter((assignment) => (
        this.#isLegacyAssignmentConsumedByFinalization(task, assignment)
      ));
      for (const assignment of consumedLegacyAssignments) {
        actions.push({
          taskId: task.taskId,
          assignmentId: assignment.assignmentId,
          kind: 'retire_consumed_assignment',
        });
      }
      const projectedAssignments = consumedLegacyAssignments.length === 0
        ? assignments
        : assignments.map((assignment) => (
          consumedLegacyAssignments.some((candidate) => candidate.assignmentId === assignment.assignmentId)
            ? { ...assignment, status: 'finalized' as const, leaseId: '' }
            : assignment
        ));
      const terminalAggregate = deterministicTerminalAggregate(projectedAssignments);
      if (terminalAggregate && terminalAggregate !== task.status) {
        actions.push({
          taskId: task.taskId,
          kind: 'repair_aggregate',
          fromStatus: task.status,
          toStatus: terminalAggregate,
        });
      }

      const effectiveStatus = terminalAggregate ?? task.status;
      const effectiveLeases = projectedAssignments.some((assignment) => (
        Boolean(assignment.leaseId) && !HOUSEKEEPING_ASSIGNMENT_TERMINAL.has(assignment.status)
      ));
      const oldEnough = now - task.updatedAt >= SUPERVISION_TASK_ARCHIVE_GRACE_MS;
      const archivablyShippedPass = effectiveStatus === 'passed' && Boolean(task.commitSha || task.pushRemoteRef);
      if (!task.archivedAt && oldEnough && !effectiveLeases
        && (HOUSEKEEPING_ARCHIVABLE_TASK.has(effectiveStatus) || archivablyShippedPass)) {
        actions.push({ taskId: task.taskId, kind: 'archive_terminal', fromStatus: effectiveStatus });
      } else if (!task.archivedAt
        && task.status === 'planned'
        && assignments.length === 0
        && !task.currentRevision
        && !task.commitSha
        && !task.pushRemoteRef
        && now - task.createdAt >= SUPERVISION_TASK_ABANDONED_AFTER_MS) {
        const audit = this.#db.prepare(
          'SELECT 1 AS ok FROM supervision_audit_attestations WHERE task_id = ? LIMIT 1',
        ).get(task.taskId) as { ok?: number } | undefined;
        if (!audit?.ok && taskEvents.every((event) => event.eventType === 'created')) {
          actions.push({ taskId: task.taskId, kind: 'archive_abandoned', fromStatus: task.status });
        }
      }

      if (!task.archivedAt) {
        const supersededBy = this.#supersedingFinalizedTaskId(task, projectedAssignments);
        if (supersededBy) {
          actions.push({ taskId: task.taskId, kind: 'archive_superseded', relatedTaskId: supersededBy });
        }
      }

      if (!task.archivedAt && !task.duplicateCandidate && task.objective.trim()) {
        const familyRows = this.#db.prepare(
          `SELECT payload_json AS payloadJson FROM supervision_tasks
           WHERE project_name = ? AND top_level_task_id = ? AND classification = ? AND task_id != ?
           ORDER BY created_at ASC, task_id ASC LIMIT 101`,
        ).all(task.projectName, task.topLevelTaskId, task.classification, task.taskId) as Array<Record<string, unknown>>;
        const objective = normalizeObjectiveForHousekeeping(task.objective);
        const matches = familyRows
          .map(parseTaskRow)
          .filter((candidate): candidate is PersistedSupervisionTaskRecord => candidate !== undefined
            && normalizeObjectiveForHousekeeping(candidate.objective) === objective);
        if (familyRows.length <= 100 && matches.length > 0) {
          const canonical = [...matches, task].sort((left, right) => (
            left.createdAt - right.createdAt || left.taskId.localeCompare(right.taskId)
          ))[0]!;
          if (canonical.taskId !== task.taskId) {
            actions.push({
              taskId: task.taskId,
              kind: 'mark_duplicate_candidate',
              relatedTaskId: canonical.taskId,
            });
          }
        }
      }
    }

    const failedActions: SupervisionHousekeepingActionFailure[] = [];
    if (mode === 'apply') {
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        // Per-action isolation. One unexecutable action used to abort the whole
        // batch, and the rollback discarded every action that had already
        // succeeded AND the cursor/next_due_at advance — so the scheduler
        // re-selected the same project and the same cursor forever. A savepoint
        // per action bounds the damage to that action: the rest still commit,
        // the pass still records progress, and the failure is reported instead
        // of being thrown away.
        for (let index = 0; index < actions.length; index++) {
          const action = actions[index]!;
          const savepoint = `hk_${index}`;
          this.#db.exec(`SAVEPOINT ${savepoint}`);
          try {
            this.#applyHousekeepingAction(action, now);
            this.#db.exec(`RELEASE ${savepoint}`);
          } catch (error) {
            this.#db.exec(`ROLLBACK TO ${savepoint}`);
            this.#db.exec(`RELEASE ${savepoint}`);
            failedActions.push({
              taskId: action.taskId,
              kind: action.kind,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        this.#db.prepare(
          `INSERT INTO supervision_housekeeping_state
             (project_name, apply_authorized, cursor, next_due_at, updated_at)
           VALUES (?, 1, ?, ?, ?)
           ON CONFLICT(project_name) DO UPDATE SET apply_authorized = 1, cursor = excluded.cursor,
             next_due_at = excluded.next_due_at, updated_at = excluded.updated_at`,
        ).run(projectName, hasMore
          ? (scanningOrphans ? `${orphanCursorPrefix}${batch.at(-1)?.taskId ?? ''}`
            : pageHasMore ? batch.at(-1)?.taskId ?? null : orphanCursorPrefix)
          : null,
          now + (hasMore ? 60_000 : 10 * 60_000), now);
        this.#db.exec('COMMIT');
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      }
    }

    const actionCounts: SupervisionHousekeepingResult['actionCounts'] = {};
    for (const action of actions) actionCounts[action.kind] = (actionCounts[action.kind] ?? 0) + 1;
    const counts = this.#canonicalVisibilityCounts(projectName);
    return {
      mode,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(hasMore ? {
        nextCursor: scanningOrphans
          ? `${orphanCursorPrefix}${batch.at(-1)?.taskId ?? orphanCursor}`
          : pageHasMore ? batch.at(-1)!.taskId : orphanCursorPrefix,
      } : {}),
      hasMore,
      scanned: batch.length,
      activeCount: counts.activeCount,
      archivedCount: counts.archivedCount,
      actionCounts,
      actions,
      orphanDiagnostics,
      applyAuthorized: mode === 'apply' || this.housekeepingApplyAuthorized(projectName),
      // Feasibility is about the PLAN, authorization is about the CALLER. They
      // are reported separately because conflating them is what let a dryRun
      // advertise actions whose apply was impossible.
      applyFeasible: actions.every((action) => this.#housekeepingActionFeasible(action)),
      failedActions,
    };
  }

  runApprovedHousekeepingBatch(now = Date.now()): SupervisionHousekeepingResult | undefined {
    const state = this.#db.prepare(
      `SELECT project_name AS projectName, cursor, next_due_at AS nextDueAt
       FROM supervision_housekeeping_state
       WHERE apply_authorized = 1 AND next_due_at <= ?
       ORDER BY next_due_at ASC, project_name ASC LIMIT 1`,
    ).get(now) as { projectName?: string; cursor?: string | null; nextDueAt?: number } | undefined;
    if (!state?.projectName) return undefined;
    return this.reconcileHousekeeping({
      mode: 'apply',
      projectName: state.projectName,
      ...(state?.cursor ? { cursor: state.cursor } : {}),
      limit: SUPERVISION_TASK_HOUSEKEEPING_DEFAULT_BATCH_SIZE,
      now,
    });
  }

  nextWorktreeGcBatch(now = Date.now()): { projectName: string; cursor?: string } | undefined {
    if (this.#closed) return undefined;
    const row = this.#db.prepare(
      `SELECT project_name AS projectName, cursor
       FROM supervision_worktree_gc_state
       WHERE next_due_at <= ?
       ORDER BY next_due_at ASC, project_name ASC LIMIT 1`,
    ).get(now) as { projectName?: unknown; cursor?: unknown } | undefined;
    if (typeof row?.projectName !== 'string' || !row.projectName) return undefined;
    return {
      projectName: row.projectName,
      ...(typeof row.cursor === 'string' && row.cursor ? { cursor: row.cursor } : {}),
    };
  }

  recordWorktreeGcBatch(input: {
    projectName: string;
    nextCursor?: string;
    hasMore: boolean;
    result: unknown;
    now?: number;
  }): void {
    const projectName = normalizeTaskString(input.projectName);
    if (!projectName || this.#closed) return;
    const now = input.now ?? Date.now();
    this.#db.prepare(
      `INSERT INTO supervision_worktree_gc_state
         (project_name, cursor, next_due_at, last_result_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_name) DO UPDATE SET cursor = excluded.cursor,
         next_due_at = excluded.next_due_at, last_result_json = excluded.last_result_json,
         updated_at = excluded.updated_at`,
    ).run(projectName, input.hasMore ? normalizeTaskString(input.nextCursor) ?? null : null,
      now + (input.hasMore ? 60_000 : 10 * 60_000), JSON.stringify(input.result), now);
  }

  #canonicalVisibilityCounts(projectName: string): { activeCount: number; archivedCount: number } {
    const row = this.#db.prepare(
      `SELECT
         SUM(CASE WHEN json_type(payload_json, '$.archivedAt') IS NULL THEN 1 ELSE 0 END) AS activeCount,
         SUM(CASE WHEN json_type(payload_json, '$.archivedAt') IS NOT NULL THEN 1 ELSE 0 END) AS archivedCount
       FROM supervision_tasks WHERE project_name = ?`,
    ).get(projectName) as { activeCount?: number; archivedCount?: number } | undefined;
    return {
      activeCount: Number(row?.activeCount ?? 0),
      archivedCount: Number(row?.archivedCount ?? 0),
    };
  }

  /**
   * Can this planned action actually execute?
   *
   * Deliberately a statement-shape question, not a permission question. A
   * backfill needs a project name to write; a quarantine needs the reserved
   * scope to exist so the row it targets can satisfy the project guard.
   */
  #housekeepingActionFeasible(action: SupervisionHousekeepingAction): boolean {
    if (action.kind === 'backfill_orphan_project') {
      return Boolean(action.projectName && action.projectName.trim());
    }
    if (action.kind === 'quarantine_orphan') {
      return SUPERVISION_ORPHAN_QUARANTINE_SCOPE.trim().length > 0;
    }
    return true;
  }

  #applyHousekeepingAction(action: SupervisionHousekeepingAction, now: number): void {
    if (action.kind === 'backfill_orphan_project' && action.projectName) {
      const row = this.#db.prepare(
        'SELECT project_name AS projectName FROM supervision_tasks WHERE task_id = ?',
      ).get(action.taskId) as { projectName?: string | null } | undefined;
      const task = this.getTaskRecord(action.taskId);
      if (!task || row?.projectName != null) return;
      const sessionNames = [...new Set(this.listAssignments(task.taskId)
        .map((assignment) => assignment.identity.sessionName).filter(Boolean))];
      const liveSessionNames = new Set(
        (this.#resolveLiveParticipants?.(action.projectName) ?? []).map((identity) => identity.sessionName),
      );
      const lineageProject = task.topLevelTaskId !== task.taskId
        ? normalizeTaskString(this.getTaskRecord(task.topLevelTaskId)?.projectName)
        : undefined;
      const liveMatches = sessionNames.filter((sessionName) => liveSessionNames.has(sessionName));
      if (lineageProject !== action.projectName && liveMatches.length !== 1) return;
      this.#writeTask({
        ...task,
        projectName: action.projectName,
        cleanupVersion: SUPERVISION_TASK_CLEANUP_VERSION,
        updatedAt: now,
      }, this.#taskEventFor(task.status), {
        source: 'housekeeping_orphan_project_backfill',
        reason: lineageProject === action.projectName ? 'top_level_project_lineage' : 'unique_live_session_lineage',
        projectName: action.projectName,
        identityRebound: false,
      });
      return;
    }
    if (action.kind === 'quarantine_orphan') {
      const row = this.#db.prepare(
        'SELECT project_name AS projectName FROM supervision_tasks WHERE task_id = ?',
      ).get(action.taskId) as { projectName?: string | null } | undefined;
      const task = this.getTaskRecord(action.taskId);
      if (!task || row?.projectName != null) return;
      const assignments = this.listAssignments(task.taskId);
      const taskEvents = this.listEvents(task.taskId);
      const hasLiveReference = assignments.some((assignment) => Boolean(assignment.leaseId)
        || !HOUSEKEEPING_ASSIGNMENT_TERMINAL.has(assignment.status));
      const hasDurableEvidence = Boolean(task.currentRevision || task.commitSha || task.pushRemoteRef || task.finalization)
        || taskEvents.some((event) => event.eventType !== 'created')
        || this.listAuditReceipts(task.taskId).length > 0
        || this.listCompletionEvidence(task.taskId).length > 0;
      if (hasLiveReference || hasDurableEvidence) return;
      const quarantined: PersistedSupervisionTaskRecord = {
        ...task,
        projectName: SUPERVISION_ORPHAN_QUARANTINE_SCOPE,
        status: 'blocked',
        blocker: 'orphan_project_unresolved',
        cleanupVersion: SUPERVISION_TASK_CLEANUP_VERSION,
        updatedAt: now,
      };
      // The row being quarantined is, by selection, one the project guard
      // refuses to leave unscoped. Writing the reserved scope in the SAME
      // statement is what lets the update through: previously the SET omitted
      // project_name while the WHERE targeted `project_name IS NULL`, so
      // NEW.project_name stayed null and the guard aborted every single time.
      this.#db.prepare(
        `UPDATE supervision_tasks
         SET status = ?, blocker = ?, payload_json = ?, project_name = ?, updated_at = ?
         WHERE task_id = ? AND project_name IS NULL`,
      ).run(quarantined.status, quarantined.blocker ?? 'orphan_project_unresolved', JSON.stringify(quarantined), SUPERVISION_ORPHAN_QUARANTINE_SCOPE, now, task.taskId);
      this.#appendEvent(task.taskId, undefined, 'blocked', 'blocked', {
        source: 'housekeeping_orphan_quarantine',
        reason: 'no_authoritative_project_lineage',
        identityRebound: false,
      }, now);
      return;
    }
    if (action.kind === 'retire_consumed_assignment' && action.assignmentId) {
      const task = this.getTaskRecord(action.taskId);
      const assignment = this.getAssignment(action.assignmentId);
      if (!task || !assignment || !this.#isLegacyAssignmentConsumedByFinalization(task, assignment)) return;
      this.#writeAssignment({
        ...assignment, status: 'finalized', leaseId: '', blocker: undefined,
        cleanupVersion: SUPERVISION_TASK_CLEANUP_VERSION, updatedAt: now,
      }, 'finalized', {
        source: 'housekeeping_consumed_finalization_projection',
        finalizedRevision: task.finalization!.revision,
        finalizedAuditAttemptId: task.finalization!.auditAttemptId,
      });
      this.#db.prepare('DELETE FROM supervision_task_file_claims WHERE assignment_id = ?')
        .run(assignment.assignmentId);
      return;
    }
    if (action.kind === 'release_terminal_assignment' && action.assignmentId) {
      const assignment = this.getAssignment(action.assignmentId);
      const implementationFinished = assignment?.status === 'ready_for_audit'
        && this.listEvents(action.taskId).some((event) => event.assignmentId === assignment.assignmentId
          && event.eventType === 'implementation_finished');
      if (!assignment || (!HOUSEKEEPING_ASSIGNMENT_TERMINAL.has(assignment.status) && !implementationFinished)) return;
      this.#writeAssignment({
        ...assignment,
        leaseId: '',
        cleanupVersion: SUPERVISION_TASK_CLEANUP_VERSION,
        updatedAt: now,
      }, this.#taskEventFor(assignment.status), {
        source: 'housekeeping',
        leaseRevoked: true,
        cleanupVersion: SUPERVISION_TASK_CLEANUP_VERSION,
      });
      this.#db.prepare('DELETE FROM supervision_task_file_claims WHERE assignment_id = ?').run(assignment.assignmentId);
      return;
    }
    const task = this.getTaskRecord(action.taskId);
    if (!task) return;
    if ((action.kind === 'repair_revision' || action.kind === 'repair_aggregate')
      && action.assignmentId) {
      // The planner ran before BEGIN IMMEDIATE. Re-evaluate the complete
      // evidence shape while holding the write transaction so an auditor or a
      // competing implementer appearing between plan and apply fails closed.
      const repair = this.#planReworkProjectionRepair(task, this.listAssignments(task.taskId));
      if (!repair
        || repair.kind !== action.kind
        || repair.assignmentId !== action.assignmentId
        || repair.fromStatus !== action.fromStatus
        || repair.fromRevision !== action.fromRevision
        || repair.toRevision !== action.toRevision) return;
      this.#writeTask({
        ...task,
        currentRevision: repair.toRevision,
        status: 'rework',
        cleanupVersion: SUPERVISION_TASK_CLEANUP_VERSION,
        updatedAt: now,
      }, 'rework', {
        source: 'housekeeping_rework_projection_repair',
        fromRevision: repair.fromRevision,
        toRevision: repair.toRevision,
        fromStatus: repair.fromStatus,
        assignmentId: repair.assignmentId,
      });
      return;
    }
    if (action.kind === 'repair_revision' && action.toRevision) {
      this.#writeTask({
        ...task,
        currentRevision: action.toRevision,
        status: action.toStatus ?? task.status,
        cleanupVersion: SUPERVISION_TASK_CLEANUP_VERSION,
        updatedAt: now,
      }, 'rework', {
        source: 'housekeeping_revision_repair',
        fromRevision: action.fromRevision,
        toRevision: action.toRevision,
        assignmentId: action.assignmentId,
      });
      return;
    }
    if (action.kind === 'repair_aggregate' && action.toStatus) {
      this.#writeTask({
        ...task,
        status: action.toStatus,
        cleanupVersion: SUPERVISION_TASK_CLEANUP_VERSION,
        updatedAt: now,
      }, this.#taskEventFor(action.toStatus), {
        source: 'housekeeping_aggregate_repair',
        fromStatus: action.fromStatus,
        toStatus: action.toStatus,
      });
      return;
    }
    if (action.kind === 'mark_duplicate_candidate' && action.relatedTaskId) {
      this.#writeTask({
        ...task,
        duplicateCandidate: true,
        duplicateCandidateOf: action.relatedTaskId,
        cleanupVersion: SUPERVISION_TASK_CLEANUP_VERSION,
        updatedAt: now,
      }, this.#taskEventFor(task.status), {
        source: 'housekeeping_duplicate_candidate',
        relatedTaskId: action.relatedTaskId,
      });
      return;
    }
    if (action.kind === 'archive_superseded' && action.relatedTaskId) {
      // The planner decided on a snapshot taken before this write. Anything can
      // have happened since: a worker can claim the aggregate, a lease can be
      // taken, bytes can be recorded. Re-checking only `archivedAt` would catch
      // none of that and would archive a row that is now actively referenced --
      // the console would simply lose it.
      //
      // So the COMPLETE evidence is re-read and re-planned inside the same
      // transaction that writes, and the result must still name the very same
      // successor the plan named. Anything else and we write nothing at all.
      // `reconcileHousekeeping` plans the whole batch BEFORE opening its
      // transaction and then applies inside it, so this runs in that same
      // BEGIN IMMEDIATE. No nested transaction is opened -- one already owns
      // this write, and re-reading here is what makes the decision atomic with
      // it rather than with the stale plan.
      const locked = this.getTaskRecord(action.taskId);
      if (!locked || locked.archivedAt) return;
      const stillSuperseded = this.#supersedingFinalizedTaskId(
        locked,
        this.listAssignments(action.taskId),
      );
      // Re-planned from scratch, and it must still name the SAME successor the
      // plan named. A different answer means the world moved: write nothing.
      if (!stillSuperseded || stillSuperseded !== action.relatedTaskId) return;
      this.#writeTask({
        ...locked,
        archivedAt: now,
        archiveReason: 'superseded',
        supersededBy: stillSuperseded,
        cleanupVersion: SUPERVISION_TASK_CLEANUP_VERSION,
        updatedAt: now,
      }, this.#taskEventFor(locked.status), {
        source: 'housekeeping_archive',
        archiveReason: 'superseded',
        supersededBy: stillSuperseded,
        provenanceDeleted: false,
      });
      return;
    }
    if ((action.kind === 'archive_terminal' || action.kind === 'archive_abandoned') && !task.archivedAt) {
      const archiveReason: SupervisionTaskArchiveReason = action.kind === 'archive_abandoned'
        ? 'abandoned_planned'
        : task.supersededBy ? 'superseded' : 'terminal_retention';
      this.#writeTask({
        ...task,
        archivedAt: now,
        archiveReason,
        cleanupVersion: SUPERVISION_TASK_CLEANUP_VERSION,
        updatedAt: now,
      }, this.#taskEventFor(task.status), {
        source: 'housekeeping_archive',
        archiveReason,
        provenanceDeleted: false,
      });
    }
  }

  /**
   * The task that DEMONSTRABLY superseded this stale aggregate, or undefined.
   *
   * Stale rows pile up whenever work is redone: an aggregate is abandoned
   * mid-flight and a successor ships the same change. The old row then sits in
   * the console for ever looking actionable, and a human has to re-decide it
   * every time. Archiving is the right answer, but ONLY against evidence that
   * cannot later turn out to be wrong.
   *
   * The evidence is a FINALIZED successor in the same family carrying a real
   * commit. Finalization is immutable here and already required a cross-vendor
   * PASS plus push evidence, so "somebody else shipped this" is a durable fact
   * rather than an inference. CI is deliberately NOT consulted: it is optional
   * smoke in this project, and a repository with no CI configured must still be
   * able to converge.
   *
   * Fail closed -- returns undefined, leaving the row exactly as it is -- on
   * every shape where archiving could hide something real:
   *   * the stale task shipped something itself (commit/push/finalization), in
   *     which case terminal retention owns it, not supersession;
   *   * any lease is still held, or any assignment is still non-terminal. A row
   *     something is actively working on is not stale;
   *   * the stale aggregate recorded file events the successor's manifest does
   *     NOT cover. Those bytes were never integrated by anyone, and hiding the
   *     only record of them is how work silently disappears;
   *   * anything other than exactly one finalized successor. Two candidates
   *     cannot both be "the" shipment, and picking one would be a guess.
   */
  #supersedingFinalizedTaskId(
    task: PersistedSupervisionTaskRecord,
    projectedAssignments: readonly PersistedSupervisionTaskAssignment[],
  ): string | undefined {
    if (task.archivedAt) return undefined;
    if (task.finalization || normalizeTaskString(task.commitSha)
      || normalizeTaskString(task.pushRemoteRef)) return undefined;
    // Any non-terminal assignment blocks. This deliberately SUBSUMES the
    // lease check the sibling archive branches use: `effectiveLeases` is
    // (leaseId && !terminal), so every leased row it could flag is already
    // non-terminal here. Carrying it as well would be a branch no test could
    // ever distinguish.
    if (projectedAssignments.some((assignment) => (
      !HOUSEKEEPING_ASSIGNMENT_TERMINAL.has(assignment.status)
    ))) return undefined;

    const objective = normalizeObjectiveForHousekeeping(task.objective);
    if (!objective) return undefined;
    const familyRows = this.#db.prepare(
      `SELECT payload_json AS payloadJson FROM supervision_tasks
       WHERE project_name = ? AND top_level_task_id = ? AND classification = ? AND task_id != ?
       ORDER BY created_at ASC, task_id ASC LIMIT 101`,
    ).all(task.projectName, task.topLevelTaskId, task.classification, task.taskId) as Array<Record<string, unknown>>;
    // A family larger than the bounded page is not evidence -- it is an
    // unscanned tail, and deciding from a partial view is a guess.
    if (familyRows.length > 100) return undefined;
    const successors = familyRows
      .map(parseTaskRow)
      .filter((candidate): candidate is PersistedSupervisionTaskRecord => candidate !== undefined
        && normalizeObjectiveForHousekeeping(candidate.objective) === objective
        && Boolean(candidate.finalization)
        && FINALIZATION_COMMIT_RE.test(normalizeTaskString(candidate.finalization?.commitSha) ?? ''));
    if (successors.length !== 1) return undefined;
    const successor = successors[0]!;

    const shipped = new Set<string>([
      ...(successor.finalization?.integrationManifest ?? []).map((entry) => entry.path),
      ...(successor.finalization?.ownedFiles ?? []),
    ]);
    const stalePaths = [...new Set(this.listFileEvents(task.taskId).map((event) => event.path))];
    if (stalePaths.some((path) => !shipped.has(path))) return undefined;
    return successor.taskId;
  }

  #isLegacyAssignmentConsumedByFinalization(
    task: PersistedSupervisionTaskRecord,
    assignment: PersistedSupervisionTaskAssignment,
  ): boolean {
    const finalization = task.finalization;
    if (!finalization || !assignment.required
      || (assignment.role !== 'implementer' && assignment.role !== 'integration_owner')
      || isTerminalSupervisionTaskStatus(assignment.status)
      || assignment.auditRevision !== finalization.revision
      || assignment.auditAttemptId !== finalization.auditAttemptId
      || assignment.verdict?.trim().toUpperCase() !== 'PASS'
      || assignment.crossVendorAuditPassed !== true) return false;
    const receipts = this.listAuditReceipts(task.taskId).filter((receipt) => (
      receipt.receiptKind === 'final' && receipt.verdict === 'PASS'
      && receipt.revision === finalization.revision
      && receipt.attemptId === finalization.auditAttemptId
    ));
    if (receipts.length !== 1) return false;
    const auditor = this.getAssignment(receipts[0]!.assignmentId);
    return Boolean(auditor && auditor.role === 'auditor' && auditor.status === 'finalized'
      && !auditor.leaseId && auditor.auditRevision === finalization.revision
      && auditor.auditAttemptId === finalization.auditAttemptId
      && auditor.verdict?.trim().toUpperCase() === 'PASS'
      && auditor.identity.providerFamily !== assignment.identity.providerFamily);
  }

  /**
   * Persist one implementation watchdog dispatch without pretending that the
   * reminder itself is implementation progress. The event is the durable
   * de-duplication/cooldown receipt used after SQLite reopen.
   */
  /**
   * Persist a liveness beat without moving the substantive progress clock.
   *
   * `updated_at` is the progress clock and must not move, but the console
   * projects `heartbeatAt` from `heartbeat_at`; leaving that column unwritten
   * is why an abandoned assignment could still look alive on lease presence
   * alone. Both the column and the payload copy are updated so a reopened
   * registry reports the same beat.
   */
  #recordAssignmentHeartbeat(assignment: PersistedSupervisionTaskAssignment, now: number): void {
    if (this.#closed) return;
    const next: PersistedSupervisionTaskAssignment = { ...assignment, heartbeatAt: now };
    this.#db.prepare(
      'UPDATE supervision_task_assignments SET heartbeat_at = ?, payload_json = ? WHERE assignment_id = ?',
    ).run(now, JSON.stringify(next), assignment.assignmentId);
  }

  recordImplementationHeartbeat(input: {
    assignmentId: string;
    now?: number;
    reminderNumber: number;
    clientMessageId: string;
  }): SupervisionTaskRegistryResult<PersistedSupervisionTaskEvent> {
    const assignment = this.getAssignment(input.assignmentId);
    if (!assignment) return { ok: false, reason: 'not_found' };
    if (assignment.role !== 'implementer'
      || (assignment.status !== 'delegated' && assignment.status !== 'implementing')) {
      return { ok: false, reason: 'invalid_transition' };
    }
    const now = input.now ?? Date.now();
    this.#appendEvent(assignment.taskId, assignment.assignmentId, 'implementation_heartbeat', assignment.status, {
      source: 'implementation_watchdog',
      substantiveProgress: false,
      reminderNumber: input.reminderNumber,
      clientMessageId: input.clientMessageId,
    }, now);
    this.#recordAssignmentHeartbeat(assignment, now);
    const event = this.listEvents(assignment.taskId).at(-1);
    return event ? { ok: true, value: event } : { ok: false, reason: 'not_found' };
  }

  recordImplementationHeartbeatUnavailable(input: {
    assignmentId: string;
    now?: number;
    retryNumber: number;
  }): SupervisionTaskRegistryResult<PersistedSupervisionTaskEvent> {
    const assignment = this.getAssignment(input.assignmentId);
    if (!assignment) return { ok: false, reason: 'not_found' };
    if (assignment.role !== 'implementer'
      || (assignment.status !== 'delegated' && assignment.status !== 'implementing')) {
      return { ok: false, reason: 'invalid_transition' };
    }
    this.#appendEvent(assignment.taskId, assignment.assignmentId, 'implementation_heartbeat', assignment.status, {
      source: 'implementation_watchdog_runtime_unavailable',
      substantiveProgress: false,
      retryNumber: input.retryNumber,
    }, input.now ?? Date.now());
    const event = this.listEvents(assignment.taskId).at(-1);
    return event ? { ok: true, value: event } : { ok: false, reason: 'not_found' };
  }

  listFileEvents(taskId: string): PersistedSupervisionTaskFileEvent[] {
    if (this.#closed) return [];
    return (this.#db.prepare(`SELECT id, task_id AS taskId, assignment_id AS assignmentId, file_path AS path, operation, before_hash AS beforeHash, after_hash AS afterHash, tool, source, session_name AS sessionName, session_instance_id AS sessionInstanceId, runtime_epoch AS runtimeEpoch, agent_type AS agentType, provider_family AS providerFamily, created_at AS createdAt FROM supervision_task_file_events WHERE task_id = ? ORDER BY id ASC`).all(taskId) as Array<Record<string, unknown>>)
      .map((row) => ({
        id: Number(row.id ?? 0), taskId: String(row.taskId ?? ''), assignmentId: String(row.assignmentId ?? ''), path: String(row.path ?? ''),
        operation: String(row.operation ?? 'modify') as import('../../shared/supervision-config.js').SupervisionTaskFileOperation,
        ...(normalizeTaskString(row.beforeHash as string | undefined) ? { beforeHash: normalizeTaskString(row.beforeHash as string | undefined) } : {}),
        ...(normalizeTaskString(row.afterHash as string | undefined) ? { afterHash: normalizeTaskString(row.afterHash as string | undefined) } : {}),
        ...(normalizeTaskString(row.tool as string | undefined) ? { tool: normalizeTaskString(row.tool as string | undefined) } : {}),
        ...(normalizeTaskString(row.source as string | undefined) ? { source: normalizeTaskString(row.source as string | undefined) } : {}),
        identity: { sessionName: String(row.sessionName ?? ''), sessionInstanceId: String(row.sessionInstanceId ?? ''), runtimeEpoch: String(row.runtimeEpoch ?? ''), agentType: String(row.agentType ?? ''), providerFamily: String(row.providerFamily ?? '') },
        createdAt: Number(row.createdAt ?? 0),
      }));
  }

  findByFile(filePath: string): SupervisionTaskSnapshot[] {
    void filePath;
    return [];
  }

  createOrGet(input: SupervisionTaskCreateInput): SupervisionTaskRegistryResult<PersistedSupervisionTaskRecord> {
    if (this.#closed) return { ok: false, reason: 'invalid' };
    const now = input.now ?? Date.now();
    const projectName = normalizeTaskString(input.projectName) ?? '__legacy_unscoped__';
    const key = normalizeTaskString(input.idempotencyKey);
    const taskIdempotencyKey = key ? `task\0${projectName}\0${key}` : '';
    if (key) {
      const row = this.#db.prepare('SELECT task_id AS taskId FROM supervision_task_idempotency WHERE idempotency_key = ?').get(taskIdempotencyKey) as { taskId?: unknown } | undefined;
      const replay = typeof row?.taskId === 'string' ? this.getTaskRecord(row.taskId) : undefined;
      if (replay) return { ok: true, value: replay, replay: true };
    }
    const classification = input.classification ?? 'integration_slice';
    if (!isSupervisionTaskClassification(classification)) return { ok: false, reason: 'invalid' };
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const proposedTaskKey = normalizeTaskString(input.semanticTaskKey);
      const sequence = this.#nextEventSequence();
      let suffixAttempt = 0;
      let taskId: string;
      if (proposedTaskKey) {
        // The semantic key stays readable; uniqueness comes from the same
        // durable event sequence used by opaque ids.
        const minted = mintSupervisionId(
          { kind: 'task', semanticKey: proposedTaskKey },
          {
            uniqueSuffix: () => compactSequenceCandidate(sequence, suffixAttempt++),
            exists: (id) => !!this.getTaskRecord(id),
          },
        );
        if (!minted.ok) {
          this.#db.exec('ROLLBACK');
          return { ok: false, reason: 'invalid' };
        }
        taskId = minted.id;
      } else {
        taskId = normalizeTaskString(input.taskId)
          ?? this.#mintOpaqueId('task', (id) => !!this.getTaskRecord(id));
      }
      if (this.getTaskRecord(taskId)) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'duplicate_task' };
      }
      const record: PersistedSupervisionTaskRecord = {
        version: SUPERVISION_TASK_REGISTRY_DB_VERSION,
        taskId,
        // Direct registry callers from before project scoping stay invisible to
        // every real project rather than being guessed into the caller's scope.
        projectName,
        topLevelTaskId: normalizeTaskString(input.topLevelTaskId) ?? taskId,
        classification,
        objective: normalizeTaskString(input.objective) ?? 'Delegated supervised task',
        acceptance: normalizeTaskArray(input.acceptance),
        ...(isSupervisionTaskAuditPolicy(input.auditPolicy) ? { auditPolicy: input.auditPolicy } : {}),
        ...(normalizeTaskString(input.baseRevision) ? { baseRevision: normalizeTaskString(input.baseRevision) } : {}),
        ...(normalizeTaskString(input.currentRevision) ? { currentRevision: normalizeTaskString(input.currentRevision) } : {}),
        status: 'planned',
        createdAt: now,
        updatedAt: now,
      };
      this.#writeTask(record, 'created', { source: 'task_start' });
      if (key) this.#db.prepare('INSERT INTO supervision_task_idempotency (idempotency_key, task_id, created_at) VALUES (?, ?, ?)').run(taskIdempotencyKey, taskId, now);
      this.#db.exec('COMMIT');
      return { ok: true, value: record };
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }

  createAssignment(input: SupervisionTaskAssignmentInput): SupervisionTaskRegistryResult<PersistedSupervisionTaskAssignment> {
    const task = this.getTaskRecord(input.taskId);
    if (!task) return { ok: false, reason: 'not_found' };
    const now = input.now ?? Date.now();
    const key = normalizeTaskString(input.idempotencyKey);
    const idem = key ? `assignment\0${input.taskId}\0${input.role}\0${input.identity.sessionName}\0${key}` : '';
    if (idem) {
      const row = this.#db.prepare('SELECT assignment_id AS assignmentId FROM supervision_task_idempotency WHERE idempotency_key = ?').get(idem) as { assignmentId?: unknown } | undefined;
      const replay = typeof row?.assignmentId === 'string' ? this.getAssignment(row.assignmentId) : undefined;
      if (replay) return { ok: true, value: replay, replay: true };
    }
    if (!['coordinator','integration_owner','implementer','auditor'].includes(input.role)) return { ok: false, reason: 'invalid' };
    if (input.role === 'integration_owner') {
      const exactOwners = this.listAssignments(task.taskId).filter((assignment) => (
        assignment.role === 'integration_owner' && identityMatches(assignment.identity, input.identity)
      ));
      if (exactOwners.length > 1) return { ok: false, reason: 'ambiguous_assignment' };
      if (exactOwners.length === 1) return { ok: true, value: exactOwners[0], replay: true };
    }
    // New integration slices hand validated bytes to their integration owner;
    // they never mint an auditor assignment or consume an audit attempt. The
    // idempotency replay above deliberately remains first so rows created by
    // older daemons can still be read/replayed without inventing a new audit.
    if (input.role === 'auditor' && task.classification === 'integration_slice') {
      return { ok: false, reason: 'role_forbidden' };
    }
    if (input.role === 'auditor' && this.listAssignments(task.taskId).some((assignment) => (
      assignment.role === 'auditor'
      && !['rework', 'cancelled', 'finalized'].includes(assignment.status)
    ))) {
      return { ok: false, reason: 'duplicate_assignment' };
    }
    const scopeFiles = normalizeTaskArray(input.scopeFiles).filter(validRepoPath);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const proposedAssignmentKey = normalizeTaskString(input.semanticAssignmentKey);
      const sequence = this.#nextEventSequence();
      let suffixAttempt = 0;
      let assignmentId: string;
      if (proposedAssignmentKey) {
        const minted = mintSupervisionId(
          { kind: 'assignment', semanticKey: proposedAssignmentKey },
          {
            uniqueSuffix: () => compactSequenceCandidate(sequence, suffixAttempt++),
            exists: (id) => !!this.getAssignment(id),
          },
        );
        if (!minted.ok) {
          this.#db.exec('ROLLBACK');
          return { ok: false, reason: 'invalid' };
        }
        assignmentId = minted.id;
      } else {
        assignmentId = normalizeTaskString(input.assignmentId)
          ?? this.#mintOpaqueId('assignment', (id) => !!this.getAssignment(id));
      }
      if (this.getAssignment(assignmentId)) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'duplicate_assignment' };
      }
      const record: PersistedSupervisionTaskAssignment = {
        version: SUPERVISION_TASK_REGISTRY_DB_VERSION,
        assignmentId,
        taskId: task.taskId,
        role: input.role,
        identity: input.identity,
        scopeFiles,
        required: input.required !== false,
        status: 'delegated',
        leaseId: this.#mintLeaseId(),
        generation: 1,
        ...(normalizeTaskString(input.auditAttemptId) ? { auditAttemptId: normalizeTaskString(input.auditAttemptId) } : {}),
        ...(normalizeTaskString(input.auditRevision) ? { auditRevision: normalizeTaskString(input.auditRevision) } : {}),
        ...(input.executionBinding ? { executionBinding: input.executionBinding } : {}),
        ...(input.economyPolicy ? { economyPolicy: input.economyPolicy } : {}),
        ...(input.auditRoutingReason ? { auditRoutingReason: input.auditRoutingReason } : {}),
        ...(input.auditDegradedReason ? { auditDegradedReason: input.auditDegradedReason } : {}),
        ...(input.provisioning ? { provisioning: input.provisioning } : {}),
        createdAt: now,
        updatedAt: now,
      };
      this.#writeAssignment(record, 'delegated', { source: 'assignment_start' });
      if (record.role === 'integration_owner' && !task.integrationOwnerAssignmentId) {
        this.#writeTask({ ...task, integrationOwnerAssignmentId: assignmentId, status: task.status === 'planned' ? 'delegated' : task.status, updatedAt: now }, 'delegated', { source: 'integration_owner_assignment' });
      } else if (task.status === 'planned') {
        this.#writeTask({ ...task, status: 'delegated', updatedAt: now }, 'delegated', { source: 'assignment_start' });
      }
      if (idem) this.#db.prepare('INSERT INTO supervision_task_idempotency (idempotency_key, task_id, assignment_id, created_at) VALUES (?, ?, ?, ?)').run(idem, task.taskId, assignmentId, now);
      this.#db.exec('COMMIT');
      return { ok: true, value: record };
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }

  updateTask(input: SupervisionTaskUpdateInput): SupervisionTaskRegistryResult<PersistedSupervisionTaskRecord> {
    const existing = this.getTaskRecord(input.taskId);
    if (!existing) return { ok: false, reason: 'not_found' };
    const nextStatus = input.status ?? existing.status;
    if (!isSupervisionTaskLifecycleStatus(nextStatus)) return { ok: false, reason: 'invalid' };
    if (!canTransitionSupervisionTaskStatus(existing.status, nextStatus)) return { ok: false, reason: 'invalid_transition' };
    const now = input.now ?? Date.now();
    const requestedAuditPolicy = input.auditPolicy ?? undefined;
    if (requestedAuditPolicy && !isSupervisionTaskAuditPolicy(requestedAuditPolicy)) {
      return { ok: false, reason: 'invalid' };
    }
    if (requestedAuditPolicy && !isSupervisionTaskClassification(existing.classification)) {
      return { ok: false, reason: 'invalid' };
    }
    if (requestedAuditPolicy && existing.classification === 'integration_slice') {
      return { ok: false, reason: 'role_forbidden' };
    }
    if (requestedAuditPolicy && existing.auditPolicy && existing.auditPolicy !== requestedAuditPolicy) {
      return { ok: false, reason: 'conflicting_replay' };
    }
    const requestedBaseRevision = normalizeTaskString(input.baseRevision);
    if (requestedBaseRevision && existing.baseRevision && requestedBaseRevision !== existing.baseRevision) {
      return { ok: false, reason: 'conflicting_replay' };
    }
    const record: PersistedSupervisionTaskRecord = {
      ...existing,
      status: nextStatus,
      ...(requestedAuditPolicy ? { auditPolicy: requestedAuditPolicy } : {}),
      ...(requestedBaseRevision ? { baseRevision: requestedBaseRevision } : {}),
      ...(normalizeTaskString(input.currentRevision) ? { currentRevision: normalizeTaskString(input.currentRevision) } : {}),
      ...(normalizeTaskString(input.commitSha) ? { commitSha: normalizeTaskString(input.commitSha) } : {}),
      ...(normalizeTaskString(input.pushRemoteRef) ? { pushRemoteRef: normalizeTaskString(input.pushRemoteRef) } : {}),
      ...(normalizeTaskString(input.blocker) ? { blocker: normalizeTaskString(input.blocker) } : {}),
      updatedAt: now,
    };
    const eventType = nextStatus === 'passed' || nextStatus === 'rework' ? 'audit_replied' : nextStatus;
    this.#writeTask(record, eventType as import('../../shared/supervision-config.js').SupervisionTaskRegistryEventType, { source: 'task_update' });
    return { ok: true, value: record };
  }

  updateAssignment(input: SupervisionTaskAssignmentUpdateInput): SupervisionTaskRegistryResult<PersistedSupervisionTaskAssignment> {
    const existing = this.getAssignment(input.assignmentId);
    if (!existing) return { ok: false, reason: 'not_found' };
    const authorizedIdentity = this.#authorizeParticipant(existing, input.identity);
    if (!authorizedIdentity) return { ok: false, reason: 'owner_mismatch' };
    const task = this.getTaskRecord(existing.taskId);
    if (!task) return { ok: false, reason: 'not_found' };
    const nextStatus = input.status ?? existing.status;
    if (!isSupervisionTaskLifecycleStatus(nextStatus)) return { ok: false, reason: 'invalid' };
    if (!canTransitionSupervisionTaskStatus(existing.status, nextStatus)) return { ok: false, reason: 'invalid_transition' };
    if (['ready_for_integration', 'integrating', 'final_audit', 'finalizing', 'committed', 'pushed', 'finalized'].includes(nextStatus)
      && !mayFinalizeEconomyAssignment({
        pool: existing.executionBinding?.pool,
        primaryReviewPassed: input.primaryReviewPassed ?? existing.primaryReviewPassed === true,
        crossVendorAuditPassed: input.crossVendorAuditPassed ?? existing.crossVendorAuditPassed === true,
      })) return { ok: false, reason: 'economy_requires_primary_review' };
    const isNewAuditAfterRework = existing.status === 'rework' && nextStatus === 'auditing';
    const requestedRevision = normalizeTaskString(input.revision);
    const requestedAuditRevision = normalizeTaskString(input.auditRevision);
    const requestedVerdict = normalizeTaskString(input.verdict);
    const isImplementationHandoffVerdict = requestedVerdict
      && requestedVerdict.toUpperCase() !== 'PASS'
      && requestedVerdict.toUpperCase() !== 'REWORK';
    if (existing.role !== 'auditor' && isImplementationHandoffVerdict && !requestedRevision) {
      return { ok: false, reason: 'old_revision' };
    }
    if (requestedRevision && requestedAuditRevision && requestedRevision !== requestedAuditRevision) {
      return { ok: false, reason: 'old_revision' };
    }
    if (!isNewAuditAfterRework && input.auditAttemptId && existing.auditAttemptId && input.auditAttemptId !== existing.auditAttemptId) return { ok: false, reason: 'old_audit_attempt' };
    // SUCCESSOR BIND. An owner that already carries an auditRevision from a
    // previous round must be able to bind its next frozen candidate. The old
    // rule rejected ANY revision differing from the stored one, so a strictly
    // new hash-anchored successor was indistinguishable from a stale replay and
    // the task deadlocked: the owner could not move forward, and the active
    // auditor could not reach a terminal state, so no fresh auditor could be
    // created either.
    //
    // A successor bind is allowed only for an implementation owner in an
    // implementation state. Auditors never rebind their own revision, and a
    // task that already carries Git/finalization authority is never rewritten
    // here.
    // A Brain coordination override back to implementing/rework RESETS the
    // audit anchor (`resetsAudit` clears auditAttemptId/auditRevision/verdict).
    // The owner is then anchorless, so this rule could not fire and the next
    // frozen revision was refused as `old_revision` -- the asg_4xi/R6 shape,
    // which needed a human to re-bind the anchor by hand every round. The
    // anchor is not lost, only unrecorded: it is recoverable from durable
    // evidence, namely the unique final receipt against the revision the task
    // still points at.
    const successorAnchor = normalizeTaskString(existing.auditRevision)
      ?? this.#derivedSuccessorAnchor(task, existing);
    const bindsSuccessorRevision = existing.role !== 'auditor'
      && Boolean(requestedRevision)
      && Boolean(successorAnchor)
      && requestedRevision !== successorAnchor
      && (existing.status === 'implementing' || existing.status === 'rework');
    // The owner is ALREADY on the successor -- an auditRevision-only update
    // binds it successfully -- while task.currentRevision still lags. By
    // construction bindsSuccessorRevision is false here (it requires the
    // requested revision to DIFFER from the stored one), so without this the
    // identical successor was refused as `old_revision` and the task revision
    // could never catch up: the same object deadlocked with the assignment on
    // R(n+1) and the task stuck on R(n). Same fail-closed boundary as a
    // successor bind; it only lets the task revision converge onto the
    // successor the assignment already carries.
    const completesSuccessorRevision = existing.role !== 'auditor'
      && Boolean(requestedRevision)
      && Boolean(existing.auditRevision)
      && requestedRevision === existing.auditRevision
      && (existing.status === 'implementing' || existing.status === 'rework')
      && Boolean(task.currentRevision)
      && task.currentRevision !== requestedRevision;
    if (!isNewAuditAfterRework && !bindsSuccessorRevision
      && requestedRevision && existing.auditRevision && requestedRevision !== existing.auditRevision) {
      return {
        ok: false,
        reason: 'old_revision',
        detail: {
          taskStatus: task.status,
          assignmentStatus: existing.status,
          expectedRevision: existing.auditRevision,
          actualRevision: requestedRevision,
        },
      };
    }
    // Predecessor auditors that must lose current authority when the successor
    // binds. Eligibility is deliberately narrow: still active, bound to exactly
    // the revision being superseded, and never carrying an accepted final PASS.
    // Anything outside that set makes the bind FAIL rather than be cancelled
    // silently -- a passed audit is authority, not noise.
    const supersededAuditors: PersistedSupervisionTaskAssignment[] = [];
    // ONE successor boundary for BOTH shapes.
    //
    // R1-R4 each guarded only the two-step catch-up
    // (completesSuccessorRevision), so a single
    // updateAssignment({revision, auditRevision}) took the
    // bindsSuccessorRevision path and skipped every gate. The property being
    // protected is not "which shape produced this write" but "this write moves
    // the TASK revision onto a successor", so it is defined once here and
    // applied to both.
    //
    // An integration_task is exempt because it keeps its combined revision with
    // the integration handoff: an assignment-only lineage bind there does not
    // move the task revision and needs no pointer authority.
    // A NEWLY AUTHORIZED successor owner is reporting the first revision it has
    // ever carried, so it has no auditRevision and `bindsSuccessorRevision`
    // cannot fire for it. `taskRevisionConflicts` then rejected that first
    // revision as `old_revision`, and the finalization guards below refuse any
    // successor bind on an aggregate that carries finalization/Git authority.
    // Combined, a finalized task could never record another round at all: Brain
    // could authorize the next implementer, and that implementer could never
    // report what it built.
    //
    // Projecting FORWARD past a closed round is not a rewrite OF that round.
    // The authority anchor is the recorded finalization evidence itself:
    // task.currentRevision must be EXACTLY the revision that finalization
    // covers. That is what makes this safe -- the predecessor round is closed by
    // real commit/push/CI evidence, so no in-flight audit or unconsumed
    // projection can be stolen, and the finalization record itself is carried
    // through untouched (the task row is spread, never rebuilt).
    const attemptsAdvancePastFinalizedRevision = existing.role !== 'auditor'
      && Boolean(requestedRevision)
      && !existing.auditRevision
      && (existing.status === 'implementing' || existing.status === 'rework')
      && task.classification !== 'integration_task'
      && Boolean(task.currentRevision)
      && task.currentRevision !== requestedRevision
      && Boolean(task.finalization)
      && task.finalization?.revision === task.currentRevision;
    const activeFinalizedSuccessors = attemptsAdvancePastFinalizedRevision
      ? this.listAssignments(existing.taskId).filter((candidate) => (
        candidate.required
        && (candidate.role === 'implementer' || candidate.role === 'integration_owner')
        && !isTerminalSupervisionTaskStatus(candidate.status)
        && !this.#assignmentConsumedByFinalization(task, candidate)
      ))
      : [];
    const isFinalizedPointerOwner = task.integrationOwnerAssignmentId === existing.assignmentId;
    if (attemptsAdvancePastFinalizedRevision && !existing.required && !isFinalizedPointerOwner) {
      return {
        ok: false,
        reason: 'owner_mismatch',
        detail: { taskStatus: task.status, assignmentStatus: existing.status },
      };
    }
    if (attemptsAdvancePastFinalizedRevision
      && (activeFinalizedSuccessors.length !== 1
        || activeFinalizedSuccessors[0]?.assignmentId !== existing.assignmentId)) {
      return {
        ok: false,
        reason: 'ambiguous_assignment',
        detail: { taskStatus: task.status, assignmentStatus: existing.status },
      };
    }
    const advancesPastFinalizedRevision = attemptsAdvancePastFinalizedRevision
      && activeFinalizedSuccessors.length === 1
      && activeFinalizedSuccessors[0]?.assignmentId === existing.assignmentId;
    const historicalFinalizationOnly = this.#historicalFinalizationOnly(task);
    const movesTaskRevisionToSuccessor = (bindsSuccessorRevision || completesSuccessorRevision)
      && task.classification !== 'integration_task'
      && Boolean(requestedRevision)
      && Boolean(task.currentRevision)
      && task.currentRevision !== requestedRevision;
    if (movesTaskRevisionToSuccessor) {
      const rejectDetail = { taskStatus: task.status, assignmentStatus: existing.status };
      // 1. Implementation role is a PRECONDITION of authority, not a substitute:
      //    a coordinator is an observer/orchestrator and owns none.
      if (existing.role !== 'implementer' && existing.role !== 'integration_owner') {
        return { ok: false, reason: 'role_forbidden', detail: rejectDetail };
      }
      // 2. Pointer / required authority.
      if (task.integrationOwnerAssignmentId) {
        if (task.integrationOwnerAssignmentId !== existing.assignmentId) {
          return { ok: false, reason: 'owner_mismatch', detail: rejectDetail };
        }
      } else if (!existing.required) {
        return { ok: false, reason: 'owner_mismatch', detail: rejectDetail };
      }
      // 3. Terminal and Git authority: never rewrite a revision the task has
      //    already committed to, and never move one that is blocked/cancelled.
      if (['blocked', 'cancelled'].includes(task.status)) {
        return { ok: false, reason: 'invalid_transition', detail: rejectDetail };
      }
      if (!historicalFinalizationOnly
        && (task.finalization || task.commitSha
        || ['committed', 'pushed', 'finalized'].includes(task.status))) {
        return { ok: false, reason: 'invalid_transition', detail: rejectDetail };
      }
      // 4. Downgrade, decided from existing object relations: the requested
      //    revision already carries accepted audit authority, so the task has
      //    moved past it.
      if (this.#revisionHasAcceptedAudit(existing.taskId, requestedRevision!)) {
        return {
          ok: false,
          reason: 'old_revision',
          detail: { ...rejectDetail, expectedRevision: task.currentRevision, actualRevision: requestedRevision },
        };
      }
    }
    if (advancesPastFinalizedRevision) {
      const rejectDetail = { taskStatus: task.status, assignmentStatus: existing.status };
      // Same preconditions as any other revision advance: implementation role,
      // real ownership, a task that is not blocked/cancelled, and a revision
      // that has not already been audited.
      if (existing.role !== 'implementer' && existing.role !== 'integration_owner') {
        return { ok: false, reason: 'role_forbidden', detail: rejectDetail };
      }
      // The integration-owner pointer still belongs to the FINALIZED round. It
      // keeps its veto only while that owner is itself non-terminal; once the
      // round it owned is closed it cannot gate the next one, or the aggregate
      // would be permanently frozen behind a finished assignment. A pointer
      // that is still live remains exclusive, and a non-required assignment
      // that is not the pointer owns nothing either way.
      const pointer = task.integrationOwnerAssignmentId
        ? this.getAssignment(task.integrationOwnerAssignmentId)
        : undefined;
      const isPointerOwner = task.integrationOwnerAssignmentId === existing.assignmentId;
      if (!isPointerOwner
        && (!existing.required || (pointer && !isTerminalSupervisionTaskStatus(pointer.status)))) {
        return { ok: false, reason: 'owner_mismatch', detail: rejectDetail };
      }
      if (['blocked', 'cancelled'].includes(task.status)) {
        return { ok: false, reason: 'invalid_transition', detail: rejectDetail };
      }
      if (this.#revisionHasAcceptedAudit(existing.taskId, requestedRevision!)) {
        return {
          ok: false,
          reason: 'old_revision',
          detail: { ...rejectDetail, expectedRevision: task.currentRevision, actualRevision: requestedRevision },
        };
      }
    }
    if (bindsSuccessorRevision || completesSuccessorRevision) {
      if (!historicalFinalizationOnly
        && (task.finalization || task.commitSha
        || ['committed', 'pushed', 'finalized'].includes(task.status))) {
        return {
          ok: false,
          reason: 'invalid_transition',
          detail: {
            taskStatus: task.status,
            assignmentStatus: existing.status,
            expectedRevision: existing.auditRevision,
            actualRevision: requestedRevision,
          },
        };
      }
      if (!bindsSuccessorRevision) {
        // Nothing is superseded: the assignment revision is unchanged.
      } else {
      const selection = this.#selectSupersedableAuditors({
        taskId: existing.taskId,
        taskStatus: task.status,
        supersededRevision: existing.auditRevision,
        successorRevision: requestedRevision,
      });
      if (!selection.ok) return selection;
      supersededAuditors.push(...selection.superseded);
      }
    }
    const bindsImplementationRevision = existing.role !== 'auditor' && Boolean(requestedRevision);
    // A slice/top-level implementer owns the task revision directly. An
    // integration_task may contain several implementer slice revisions, so its
    // combined task revision remains owned by the integration handoff.
    const bindsTaskRevision = bindsImplementationRevision && task.classification !== 'integration_task';
    // A legal successor bind is EXACTLY the case where task.currentRevision is
    // set and differs, so this gate cannot be evaluated before it. Previously it
    // rejected every real successor as `old_revision` -- the R1/R2 tests only
    // passed because they left task.currentRevision unset, which is not the
    // production shape. `bindsSuccessorRevision` has already enforced the
    // fail-closed boundary above (no Git/finalized authority, no accepted PASS,
    // owner in implementing/rework), so reaching here means the successor is
    // authorized and the task revision must move with it, atomically.
    // ONE definition of the conflict rule. It was previously written twice --
    // here and again inside the write-lock transaction below -- so exempting
    // only this copy silently left the authoritative copy rejecting every real
    // successor. A legal successor bind is EXACTLY "currentRevision is set and
    // differs", so the exemption must live with the rule, not beside it.
    const taskRevisionConflicts = (currentRevision: string | undefined): boolean => (
      bindsTaskRevision
      && !bindsSuccessorRevision
      && !completesSuccessorRevision
      && !advancesPastFinalizedRevision
      && Boolean(currentRevision)
      && currentRevision !== requestedRevision
    );
    if (taskRevisionConflicts(task.currentRevision)) {
      return { ok: false, reason: 'old_revision' };
    }
    const now = input.now ?? Date.now();
    const record: PersistedSupervisionTaskAssignment = {
      ...existing,
      // A converged instance/epoch is written in the SAME transaction as the
      // update it authorized, so no caller observes a half-rebound assignment.
      identity: authorizedIdentity,
      executionBinding: existing.executionBinding ? {
        ...existing.executionBinding,
        actual: {
          ...existing.executionBinding.actual,
          sessionName: authorizedIdentity.sessionName,
          sessionInstanceId: authorizedIdentity.sessionInstanceId,
          runtimeEpoch: authorizedIdentity.runtimeEpoch,
          agentType: authorizedIdentity.agentType,
          providerFamily: authorizedIdentity.providerFamily,
        },
      } : undefined,
      status: nextStatus,
      auditAttemptId: normalizeTaskString(input.auditAttemptId) ?? existing.auditAttemptId,
      auditRevision: requestedAuditRevision
        ?? (bindsImplementationRevision ? requestedRevision : undefined)
        ?? existing.auditRevision,
      verdict: requestedVerdict ?? (nextStatus === 'auditing' ? undefined : existing.verdict),
      blocker: normalizeTaskString(input.blocker)
        ?? (nextStatus === 'auditing' || nextStatus === 'passed' || nextStatus === 'ready_for_integration' ? undefined : existing.blocker),
      externalRunId: normalizeTaskString(input.externalRunId) ?? existing.externalRunId,
      externalHeadSha: normalizeTaskString(input.externalHeadSha) ?? existing.externalHeadSha,
      externalTaskId: normalizeTaskString(input.externalTaskId) ?? existing.externalTaskId,
      // Revision-scoped reviews do not cross a successor boundary on the
      // CALLER's own record either. The demotion loop below only retires OTHER
      // parked implementers, so without this an economy owner kept its own
      // predecessor primary review and a single fresh cross-vendor receipt was
      // enough to reach ready_for_integration on unaudited bytes. An explicitly
      // supplied value still wins: this clears inheritance, not new evidence.
      primaryReviewPassed: input.primaryReviewPassed
        ?? (movesTaskRevisionToSuccessor ? undefined : existing.primaryReviewPassed),
      crossVendorAuditPassed: input.crossVendorAuditPassed
        ?? (movesTaskRevisionToSuccessor ? undefined : existing.crossVendorAuditPassed),
      auditRoutingReason: input.auditRoutingReason ?? existing.auditRoutingReason,
      updatedAt: now,
    };
    const eventType = nextStatus === 'auditing' ? 'audit_requested'
      : nextStatus === 'passed' || nextStatus === 'rework' ? 'audit_replied'
      : nextStatus;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      if (bindsTaskRevision) {
        const lockedTask = this.getTaskRecord(existing.taskId);
        if (!lockedTask || taskRevisionConflicts(lockedTask.currentRevision)) {
          this.#db.exec('ROLLBACK');
          return { ok: false, reason: lockedTask ? 'old_revision' : 'not_found' };
        }
        if (lockedTask.currentRevision !== requestedRevision) {
          // The predecessor's integration-ready projection was earned by an
          // audit of DIFFERENT bytes. #deriveTaskStatus rebuilds the task status
          // from the required implementers, so demoting the task row alone would
          // be re-asserted immediately: the PROJECTION itself has to be revoked.
          // Every required implementer still parked on the predecessor revision
          // is returned to `implementing` and loses the PASS it earned against
          // those other bytes, in this same transaction.
          //
          // Applied to EVERY movesTaskRevisionToSuccessor write, not per shape:
          // R5 unified the guards but left this EFFECT on the catch-up branch, so
          // a one-call bind advanced the revision while the predecessor kept its
          // PASS and the task kept ready_for_integration.
          if (movesTaskRevisionToSuccessor) {
            for (const candidate of this.listAssignments(existing.taskId)) {
              if (candidate.role !== 'implementer' || !candidate.required) continue;
              if (candidate.status !== 'ready_for_integration' && candidate.status !== 'passed') continue;
              if (candidate.auditRevision !== lockedTask.currentRevision) continue;
              this.#writeAssignment({
                ...candidate,
                status: 'implementing',
                verdict: undefined,
                crossVendorAuditPassed: undefined,
                // primaryReviewPassed is revision-scoped too. Leaving it set let
                // an economy implementer carry its predecessor primary review
                // across the boundary, so a single fresh cross-vendor receipt
                // satisfied mayFinalizeEconomyAssignment and reached
                // ready_for_integration on unaudited successor bytes.
                primaryReviewPassed: undefined,
                updatedAt: now,
              }, 'implementing', {
                source: 'successor_revision_boundary',
                supersededRevision: lockedTask.currentRevision,
                successorRevision: requestedRevision,
              });
            }
          }
          // Same write: the revision moves AND the lifecycle drops out of the
          // predecessor's integration-ready projection. This is deliberately
          // scoped to this authorized catch-up transaction -- the shared
          // transition table is NOT widened, so an ordinary updateTask still
          // cannot walk ready_for_integration back to implementing.
          const catchUpStatus = movesTaskRevisionToSuccessor ? 'implementing' as const : lockedTask.status;
          this.#writeTask({ ...lockedTask, status: catchUpStatus, currentRevision: requestedRevision, updatedAt: now }, this.#taskEventFor(catchUpStatus), {
            source: 'assignment_update',
            assignmentId: existing.assignmentId,
            revisionBound: true,
            revision: requestedRevision,
          });
        }
      }
      // Atomic with the successor bind: either the owner moves to the new
      // revision AND every superseded auditor reaches `cancelled`, or neither
      // does. A partial commit would leave an auditor holding authority over a
      // revision nobody is implementing.
      //
      // The old assignment keeps its identity, auditAttemptId, auditRevision
      // and receipts EXACTLY as they were. It is retired, not rewritten:
      // re-pointing it at the successor would silently transfer authority
      // earned against different bytes.
      for (const superseded of supersededAuditors) {
        this.#writeAssignment({
          ...superseded,
          status: 'cancelled',
          blocker: JSON.stringify({
            supersededBySuccessorRevision: true,
            supersededRevision: superseded.auditRevision,
            supersededAttemptId: superseded.auditAttemptId,
            successorRevision: requestedRevision,
          }),
          updatedAt: now,
        }, 'cancelled', {
          source: 'assignment_update',
          supersededBySuccessorRevision: true,
          successorRevision: requestedRevision,
        });
      }
      this.#writeAssignment(record, eventType as import('../../shared/supervision-config.js').SupervisionTaskRegistryEventType, {
        source: 'assignment_update',
        ...(record.auditRoutingReason ? { auditRoutingReason: record.auditRoutingReason } : {}),
      });
      this.#deriveTaskStatus(record.taskId, now);
      this.#db.exec('COMMIT');
      return { ok: true, value: record };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Refresh observational runtime metadata for one durable participant before
   * a supervision continuation is delivered. Durable identity is exactly
   * projectName + sessionName; instance/epoch/agent/provider are fencing and
   * diagnostics only and may all rotate across a restart.
   *
   * This is intentionally below the ordinary participant gate so a legacy
   * NULL-project row can be repaired. Exactly one live candidate must resolve
   * by the durable key. No status, lease, revision, receipt or ownership
   * pointer changes.
   */
  convergeImplementationHeartbeatTarget(input: {
    taskId: string;
    assignmentId: string;
    candidates: readonly SupervisionLiveParticipantCandidate[];
    now?: number;
  }): SupervisionTaskRegistryResult<PersistedSupervisionTaskAssignment> {
    const assignment = this.getAssignment(input.assignmentId);
    const task = this.getTaskRecord(input.taskId);
    if (!assignment || !task || assignment.taskId !== task.taskId) return { ok: false, reason: 'not_found' };
    if (!isSupervisionAssignmentContinuable({
      taskCurrentRevision: task.currentRevision,
      assignment,
    })) {
      return { ok: false, reason: 'invalid_transition' };
    }
    const taskProject = normalizeTaskString(task.projectName);
    const matches = input.candidates.filter((candidate) => matchesDurableSupervisionParticipant({
      taskProjectName: taskProject,
      assignmentSessionName: assignment.identity.sessionName,
      candidateProjectName: candidate.projectName,
      candidateSessionName: candidate.identity.sessionName,
    }));
    if (matches.length !== 1) return { ok: false, reason: 'ambiguous_assignment' };
    const live = matches[0]!;
    const now = input.now ?? Date.now();
    const nextIdentity = live.identity;
    const nextProject = live.projectName.trim();
    const identityChanged = !runtimeIdentityMetadataMatches(assignment.identity, nextIdentity);
    const projectChanged = taskProject !== nextProject;
    if (!identityChanged && !projectChanged) return { ok: true, value: assignment, replay: true };

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const lockedAssignment = this.getAssignment(input.assignmentId);
      const lockedTask = this.getTaskRecord(input.taskId);
      if (!lockedAssignment || !lockedTask || lockedAssignment.taskId !== lockedTask.taskId
        || !isSupervisionAssignmentContinuable({
          taskCurrentRevision: lockedTask.currentRevision,
          assignment: lockedAssignment,
        })) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'invalid_transition' };
      }
      if (lockedAssignment.identity.sessionName !== assignment.identity.sessionName) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'owner_mismatch' };
      }
      const lockedProject = normalizeTaskString(lockedTask.projectName);
      if (lockedProject && lockedProject !== nextProject) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'owner_mismatch' };
      }
      const rebound = {
        ...lockedAssignment,
        identity: nextIdentity,
        executionBinding: lockedAssignment.executionBinding ? {
          ...lockedAssignment.executionBinding,
          actual: {
            ...lockedAssignment.executionBinding.actual,
            sessionName: nextIdentity.sessionName,
            sessionInstanceId: nextIdentity.sessionInstanceId,
            runtimeEpoch: nextIdentity.runtimeEpoch,
            agentType: nextIdentity.agentType,
            providerFamily: nextIdentity.providerFamily,
          },
        } : undefined,
        updatedAt: now,
      };
      this.#writeAssignment(rebound, 'recovered', {
        source: 'implementation_heartbeat_authoritative_rebind',
        providerFamilyNormalized: lockedAssignment.identity.providerFamily !== nextIdentity.providerFamily,
        agentTypeChanged: lockedAssignment.identity.agentType !== nextIdentity.agentType,
        runtimeIdentityRotated: lockedAssignment.identity.sessionInstanceId !== nextIdentity.sessionInstanceId
          || lockedAssignment.identity.runtimeEpoch !== nextIdentity.runtimeEpoch,
      });
      if (!lockedProject) {
        this.#writeTask({ ...lockedTask, projectName: nextProject, updatedAt: now }, this.#taskEventFor(lockedTask.status), {
          source: 'implementation_heartbeat_project_normalization',
          assignmentId: lockedAssignment.assignmentId,
        });
      }
      this.#db.exec('COMMIT');
      return { ok: true, value: rebound };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Close the caller's assignment through the machine-observed audit edge.
   *
   * The compatibility `task_finish` tool used to apply the generic `finish`
   * intent to the assignment's stale `delegated` status even when the task and
   * a matching auditor PASS had advanced. That edge was unreachable forever.
   * This method binds the exact revision/attempt, derives the role-specific
   * destination and revokes this assignment's lease in one SQLite transaction.
   * Scope metadata is never treated as audit evidence or an admission lock.
   */
  recordCancelledCompletionEvidence(
    input: SupervisionCancelledCompletionEvidenceInput,
  ): SupervisionTaskRegistryResult<PersistedSupervisionCompletionEvidence> {
    const taskId = normalizeTaskString(input.taskId);
    const assignmentId = normalizeTaskString(input.assignmentId);
    const requestedRevision = normalizeTaskString(input.revision);
    const assignment = assignmentId ? this.getAssignment(assignmentId) : undefined;
    if (!taskId || !assignmentId || !assignment || assignment.taskId !== taskId) {
      return { ok: false, reason: 'not_found' };
    }
    if (!identityMatches(assignment.identity, input.identity)) return { ok: false, reason: 'owner_mismatch' };
    if (assignment.role === 'auditor' || assignment.role === 'coordinator') {
      return { ok: false, reason: 'role_forbidden' };
    }
    const worktree = input.worktreeSnapshot;
    if (!worktree || !Array.isArray(worktree.files) || !Array.isArray(worktree.stagedPaths)
      || !Array.isArray(worktree.conflictedPaths) || !Array.isArray(worktree.untrackedPaths)) {
      return { ok: false, reason: 'manifest_mismatch' };
    }
    const files = [...worktree.files].sort((left, right) => left.path.localeCompare(right.path));
    const paths = files.map((file) => file.path);
    if (!FINALIZATION_COMMIT_RE.test(worktree.headSha)
      || !normalizeTaskString(worktree.worktreePath)?.startsWith('/')
      || worktree.stagedPaths.length !== 0 || worktree.conflictedPaths.length !== 0
      || paths.length !== new Set(paths).size
      || files.length === 0
      || files.some((file) => !validRepoPath(file.path)
        || (file.deleted === true ? file.sha256 !== undefined
          : !file.sha256 || !FINALIZATION_SHA256_RE.test(file.sha256)))
      || worktree.untrackedPaths.some((path) => !paths.includes(path))) {
      return { ok: false, reason: 'manifest_mismatch' };
    }
    const frozenDigest = createHash('sha256').update(JSON.stringify({
      headSha: worktree.headSha, files,
    })).digest('hex');
    const revision = requestedRevision ?? `late-completion-${frozenDigest.slice(0, 12)}`;
    const manifestSha256 = createHash('sha256').update(JSON.stringify({ revision, frozenDigest })).digest('hex');
    const evidenceId = `completion_evidence_${manifestSha256.slice(0, 24)}`;
    const existing = this.#db.prepare(
      `SELECT payload_json AS payloadJson FROM supervision_task_completion_evidence
       WHERE source_assignment_id = ? AND revision = ? AND manifest_sha256 = ?`,
    ).get(assignmentId, revision, manifestSha256) as Record<string, unknown> | undefined;
    if (existing) {
      const replay = parseCompletionEvidenceRow(existing);
      return replay ? { ok: true, value: replay, replay: true } : { ok: false, reason: 'conflicting_replay' };
    }
    const now = input.now ?? Date.now();
    const record: PersistedSupervisionCompletionEvidence = {
      evidenceId, taskId, sourceAssignmentId: assignmentId, revision, manifestSha256,
      worktreePath: worktree.worktreePath, headSha: worktree.headSha, files,
      ...(normalizeTaskString(input.evidence) ? { evidence: normalizeTaskString(input.evidence) } : {}),
      status: 'pending', createdAt: now,
    };
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const locked = this.getAssignment(assignmentId);
      // This atomic locked-state check is the sole cancelled-only authority
      // gate. Keeping an equivalent preflight check above made one safety
      // predicate untestable while adding no protection against cancellation
      // races; the transaction must decide from the current row either way.
      if (!locked || locked.taskId !== taskId || locked.status !== 'cancelled'
        || !identityMatches(locked.identity, input.identity)) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'invalid_transition' };
      }
      this.#db.prepare(
        `INSERT INTO supervision_task_completion_evidence
          (evidence_id, task_id, source_assignment_id, revision, manifest_sha256, status,
           adopted_by_assignment_id, payload_json, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
      ).run(evidenceId, taskId, assignmentId, revision, manifestSha256, record.status,
        JSON.stringify(record), now);
      this.#appendEvent(taskId, assignmentId, 'implementation_finished', 'cancelled', {
        source: 'cancelled_assignment_completion_evidence', evidenceId, revision, manifestSha256,
        worktreeHeadSha: worktree.headSha, worktreeManifest: files,
      }, now);
      this.#db.exec('COMMIT');
      return { ok: true, value: record };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  resolveCancelledCompletionEvidence(input: {
    taskId: string;
    evidenceId: string;
    targetAssignmentId: string;
    decision: SupervisionCompletionEvidenceDecision;
    reason: string;
    now?: number;
  }): SupervisionTaskRegistryResult<PersistedSupervisionCompletionEvidence> {
    const task = this.getTaskRecord(normalizeTaskString(input.taskId) ?? '');
    const evidenceId = normalizeTaskString(input.evidenceId);
    const targetAssignmentId = normalizeTaskString(input.targetAssignmentId);
    const reason = normalizeTaskString(input.reason);
    if (!task || !evidenceId || !targetAssignmentId || !reason
      || !SUPERVISION_COMPLETION_EVIDENCE_DECISIONS.includes(input.decision)) return { ok: false, reason: 'invalid' };
    const evidence = this.listCompletionEvidence(task.taskId)
      .find((record) => record.evidenceId === evidenceId);
    const target = this.getAssignment(targetAssignmentId);
    if (!evidence || !target || target.taskId !== task.taskId || target.role !== 'implementer') {
      return { ok: false, reason: 'not_found' };
    }
    const expectedStatus = input.decision === 'adopt' ? 'adopted' : 'discarded';
    if (evidence.status !== 'pending') {
      return evidence.status === expectedStatus && evidence.adoptedByAssignmentId === targetAssignmentId
        ? { ok: true, value: evidence, replay: true }
        : { ok: false, reason: 'conflicting_replay' };
    }
    if (isTerminalSupervisionTaskStatus(target.status)) return { ok: false, reason: 'invalid_transition' };
    const now = input.now ?? Date.now();
    const resolved: PersistedSupervisionCompletionEvidence = {
      ...evidence,
      status: expectedStatus,
      adoptedByAssignmentId: targetAssignmentId,
      resolutionReason: reason,
      resolvedAt: now,
    };
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const locked = this.listCompletionEvidence(task.taskId)
        .find((record) => record.evidenceId === evidenceId);
      if (!locked || locked.status !== 'pending') {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'conflicting_replay' };
      }
      this.#writeCompletionEvidence(resolved);
      const blocker = input.decision === 'adopt' ? JSON.stringify({
        kind: 'cancelled_completion_evidence', actionRequired: 'adopt',
        evidenceId, sourceAssignmentId: evidence.sourceAssignmentId,
        revision: evidence.revision, manifestSha256: evidence.manifestSha256,
        worktreePath: evidence.worktreePath,
      }) : undefined;
      this.#writeAssignment({
        ...target,
        ...(input.decision === 'adopt' ? {
          scopeFiles: normalizeTaskArray([...target.scopeFiles, ...evidence.files.map((file) => file.path)]),
        } : {}),
        blocker,
        updatedAt: now,
      }, this.#taskEventFor(target.status), {
        source: 'completion_evidence_resolution', evidenceId, decision: input.decision, reason,
      });
      const lockedTask = this.getTaskRecord(task.taskId) ?? task;
      const conflictBlocker = safeJsonParseObject(lockedTask.blocker);
      if (conflictBlocker?.kind === 'cancelled_completion_evidence_conflict'
        && conflictBlocker.evidenceId === evidenceId) {
        const previousBlocker = typeof conflictBlocker.previousBlocker === 'string'
          ? conflictBlocker.previousBlocker
          : undefined;
        this.#writeTask({ ...lockedTask, blocker: previousBlocker, updatedAt: now }, this.#taskEventFor(lockedTask.status), {
          source: 'completion_evidence_resolution', evidenceId, decision: input.decision,
        });
      }
      this.#db.exec('COMMIT');
      return { ok: true, value: resolved };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  finishAssignment(input: SupervisionTaskAssignmentFinishInput): SupervisionTaskRegistryResult<PersistedSupervisionTaskAssignment> {
    const existing = this.getAssignment(input.assignmentId);
    if (!existing) return { ok: false, reason: 'not_found' };
    if (!identityMatches(existing.identity, input.identity)) return { ok: false, reason: 'owner_mismatch' };
    const task = this.getTaskRecord(existing.taskId);
    if (!task) return { ok: false, reason: 'not_found' };
    const requestedRevision = normalizeTaskString(input.revision);
    const taskRevision = normalizeTaskString(task.currentRevision);
    const assignments = this.listAssignments(existing.taskId);

    let targetStatus: SupervisionTaskLifecycleStatus;
    let matchingAudit: PersistedSupervisionTaskAssignment | undefined;
    let authenticatedAuditTarget: PersistedSupervisionTaskAssignment | undefined;
    let authenticatedAuditVerdict: PeerAuditVerdict | undefined;
    let resolvedRevision: string | undefined;
    const validatedSliceHandoff = task.classification === 'integration_slice'
      && existing.role !== 'auditor'
      && (existing.status === 'validated' || existing.status === 'ready_for_integration');
    const completedMatchingPass = assignments.some((assignment) => (
      assignment.role === 'auditor'
      && assignment.verdict?.trim().toUpperCase() === 'PASS'
      && Boolean(assignment.auditAttemptId)
      && assignment.auditRevision === (requestedRevision ?? taskRevision)
      && (this.listAuditReceipts(existing.taskId).every((receipt) => receipt.assignmentId !== assignment.assignmentId)
        || assignment.status === 'finalized')
    ));
    const validatedTopLevelHandoff = task.classification !== 'integration_slice'
      && existing.role === 'implementer'
      && (existing.status === 'validated'
        || (existing.status === 'ready_for_audit' && !completedMatchingPass));
    const implementationHandoff = validatedSliceHandoff || validatedTopLevelHandoff;
    if (existing.role === 'auditor') {
      const receipts = this.listAuditReceipts(existing.taskId)
        .filter((receipt) => receipt.assignmentId === existing.assignmentId
          && receipt.attemptId === existing.auditAttemptId
          && receipt.revision === existing.auditRevision);
      const latestFinal = receipts.filter((receipt) => receipt.receiptKind === 'final').at(-1);
      const verdict = (latestFinal?.verdict ?? existing.verdict)?.trim().toUpperCase();
      if ((verdict !== 'PASS' && verdict !== 'REWORK')
        || !existing.auditAttemptId || !existing.auditRevision
        || (requestedRevision && requestedRevision !== existing.auditRevision)) {
        return { ok: false, reason: requestedRevision ? 'old_revision' : 'invalid_transition' };
      }
      if (receipts.length > 0 && !latestFinal) return { ok: false, reason: 'invalid_transition' };
      const claimedAssignmentIds = this.#claimedAssignmentIds(existing.taskId);
      if (existing.status === 'finalized' && !existing.leaseId
        && !claimedAssignmentIds.has(existing.assignmentId)) {
        const replayPlan = planFinalizedAuditAuthorityReplay({
          task,
          auditor: existing,
          assignments,
          receipts: this.listAuditReceipts(existing.taskId),
          claimedAssignmentIds,
        });
        if (replayPlan.kind === 'reject') return { ok: false, reason: replayPlan.reason };
        if (replayPlan.kind === 'repair') {
          const now = input.now ?? Date.now();
          this.#db.exec('BEGIN IMMEDIATE');
          try {
            const lockedTask = this.getTaskRecord(existing.taskId);
            const lockedAuditor = this.getAssignment(existing.assignmentId);
            if (!lockedTask || !lockedAuditor) {
              this.#db.exec('ROLLBACK');
              return { ok: false, reason: 'not_found' };
            }
            const lockedClaimedAssignmentIds = this.#claimedAssignmentIds(existing.taskId);
            if (lockedAuditor.status !== 'finalized' || lockedAuditor.leaseId
              || lockedAuditor.auditAttemptId !== existing.auditAttemptId
              || lockedAuditor.auditRevision !== existing.auditRevision
              || (requestedRevision && requestedRevision !== lockedAuditor.auditRevision)
              || lockedClaimedAssignmentIds.has(lockedAuditor.assignmentId)) {
              this.#db.exec('ROLLBACK');
              return { ok: false, reason: 'invalid_transition' };
            }
            const lockedPlan = planFinalizedAuditAuthorityReplay({
              task: lockedTask,
              auditor: lockedAuditor,
              assignments: this.listAssignments(existing.taskId),
              receipts: this.listAuditReceipts(existing.taskId),
              claimedAssignmentIds: lockedClaimedAssignmentIds,
            });
            if (lockedPlan.kind === 'reject') {
              this.#db.exec('ROLLBACK');
              return { ok: false, reason: lockedPlan.reason };
            }
            if (lockedPlan.kind === 'repair') {
              const repaired: PersistedSupervisionTaskAssignment = {
                ...lockedPlan.target,
                auditAttemptId: lockedAuditor.auditAttemptId,
                auditRevision: lockedAuditor.auditRevision,
                verdict: 'PASS',
                crossVendorAuditPassed: true,
                updatedAt: now,
              };
              this.#writeAssignment(repaired, 'recovered', {
                source: 'finalized_auditor_replay_audit_authority',
                auditorAssignmentId: lockedAuditor.assignmentId,
                auditAttemptId: lockedAuditor.auditAttemptId,
                auditRevision: lockedAuditor.auditRevision,
                receiptId: lockedPlan.receipt.receiptId,
                verdict: 'PASS',
              });
            }
            this.#db.exec('COMMIT');
          } catch (error) {
            this.#db.exec('ROLLBACK');
            throw error;
          }
        }
        return { ok: true, value: existing, replay: true };
      }
      authenticatedAuditVerdict = verdict;
      if (receipts.length > 0) {
        const exact = assignments.filter((assignment) => assignment.role === 'implementer'
          && assignment.auditAttemptId === existing.auditAttemptId
          && assignment.auditRevision === existing.auditRevision);
        const pendingImplementers = assignments.filter((assignment) => (
          assignment.role === 'implementer'
          && AUDIT_RECEIPT_PENDING_TARGET_STATUSES.has(assignment.status)
        ));
        if (exact.length === 0) {
          const boundFallbacks = pendingImplementers.filter((assignment) => (
            assignment.auditAttemptId !== undefined || assignment.auditRevision !== undefined
          ));
          if (boundFallbacks.some((assignment) => (
            assignment.auditAttemptId !== undefined
            && assignment.auditAttemptId !== existing.auditAttemptId
          ))) {
            return { ok: false, reason: 'old_audit_attempt' };
          }
          if (boundFallbacks.some((assignment) => assignment.auditRevision !== existing.auditRevision)) {
            return { ok: false, reason: 'old_revision' };
          }
        }
        const revisionOnly = pendingImplementers.filter((assignment) => (
          assignment.auditAttemptId === undefined
          && assignment.auditRevision === existing.auditRevision
        ));
        const unbound = pendingImplementers.filter((assignment) => (
          assignment.auditAttemptId === undefined && assignment.auditRevision === undefined
        ));
        // Normal open_audit handoff binds the immutable revision but not the
        // later auditor attempt. It is an exact fallback only when it is the
        // sole pending implementer; otherwise fail closed instead of choosing
        // by row order. Attempt-bound candidates retain strict precedence.
        const candidates = exact.length > 0
          ? exact
          : revisionOnly.length > 0
            ? (pendingImplementers.length === 1 ? revisionOnly : pendingImplementers)
            : unbound;
        if (candidates.length !== 1) return { ok: false, reason: 'ambiguous_assignment' };
        authenticatedAuditTarget = candidates[0];
      }
      targetStatus = 'finalized';
    } else if (existing.status === 'pushed') {
      targetStatus = 'finalized';
    } else if (implementationHandoff) {
      const assignmentRevision = normalizeTaskString(existing.auditRevision);
      resolvedRevision = requestedRevision ?? assignmentRevision ?? taskRevision;
      if (!resolvedRevision
        || (requestedRevision && assignmentRevision && requestedRevision !== assignmentRevision)
        || (requestedRevision && taskRevision && requestedRevision !== taskRevision)
        || (assignmentRevision && taskRevision && assignmentRevision !== taskRevision)) {
        return { ok: false, reason: 'old_revision' };
      }
      targetStatus = validatedSliceHandoff ? 'ready_for_integration' : 'ready_for_audit';
    } else {
      const assignmentRevision = normalizeTaskString(existing.auditRevision);
      resolvedRevision = requestedRevision ?? assignmentRevision ?? taskRevision;
      if (!resolvedRevision
        || (requestedRevision && assignmentRevision && requestedRevision !== assignmentRevision)
        || (requestedRevision && taskRevision && requestedRevision !== taskRevision)
        || (assignmentRevision && taskRevision && assignmentRevision !== taskRevision)) {
        return { ok: false, reason: 'old_revision' };
      }
      matchingAudit = assignments.find((assignment) => (
        assignment.role === 'auditor'
        && assignment.verdict?.trim().toUpperCase() === 'PASS'
        && Boolean(assignment.auditAttemptId)
        && assignment.auditRevision === resolvedRevision
        && (this.listAuditReceipts(existing.taskId).every((receipt) => receipt.assignmentId !== assignment.assignmentId)
          || assignment.status === 'finalized')
      ));
      if (!matchingAudit) return { ok: false, reason: 'old_revision' };
      if (!mayFinalizeEconomyAssignment({
        pool: existing.executionBinding?.pool,
        primaryReviewPassed: existing.primaryReviewPassed === true,
        crossVendorAuditPassed: true,
      })) return { ok: false, reason: 'economy_requires_primary_review' };
      targetStatus = 'ready_for_integration';
    }

    const hasClaims = this.listFileClaims(existing.taskId)
      .some((claim) => claim.assignmentId === existing.assignmentId);
    const alreadyApplied = existing.status === targetStatus && !existing.leaseId;
    const bindMissingTaskRevision = Boolean((matchingAudit || implementationHandoff)
      && resolvedRevision && !taskRevision);
    if (alreadyApplied && !bindMissingTaskRevision && !hasClaims) return { ok: true, value: existing, replay: true };

    const now = input.now ?? Date.now();
    const record: PersistedSupervisionTaskAssignment = {
      ...existing,
      status: targetStatus,
      leaseId: '',
      ...(matchingAudit ? {
        auditAttemptId: matchingAudit.auditAttemptId,
        auditRevision: matchingAudit.auditRevision,
        verdict: 'PASS',
        crossVendorAuditPassed: true,
      } : {}),
      updatedAt: now,
    };
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      if (!alreadyApplied) {
        this.#writeAssignment(
          record,
          implementationHandoff
            ? 'implementation_finished'
            : targetStatus === 'ready_for_integration' ? 'ready_for_integration' : 'finalized',
          {
          source: 'assignment_finish',
          leaseRevoked: true,
          ...(matchingAudit ? {
            matchingAuditAssignmentId: matchingAudit.assignmentId,
            auditAttemptId: matchingAudit.auditAttemptId,
            auditRevision: matchingAudit.auditRevision,
          } : {}),
          ...(implementationHandoff ? {
            validatedSliceHandoff,
            validatedTopLevelHandoff,
            implementationHandoff: 'FINISHED',
            auditVerdict: null,
            revision: resolvedRevision,
          } : {}),
          ...(normalizeTaskString(input.evidence) ? { evidence: normalizeTaskString(input.evidence) } : {}),
          },
        );
      }
      if (authenticatedAuditTarget && authenticatedAuditVerdict) {
        let current = authenticatedAuditTarget;
        const terminal = authenticatedAuditVerdict === 'PASS' ? 'ready_for_integration' : 'rework';
        const steps = [...(AUDIT_RECEIPT_TO_AUDITING[current.status] ?? [])];
        if (terminal === 'ready_for_integration') {
          if (current.status === 'passed') steps.push('ready_for_integration');
          else if (current.status !== 'ready_for_integration') steps.push('passed', 'ready_for_integration');
        } else if (current.status !== 'rework') {
          steps.push('rework');
        }
        for (const status of steps) {
          if (!canTransitionSupervisionTaskStatus(current.status, status)) {
            this.#db.exec('ROLLBACK');
            return { ok: false, reason: 'invalid_transition' };
          }
          current = {
            ...current,
            status,
            leaseId: '',
            cleanupVersion: SUPERVISION_TASK_CLEANUP_VERSION,
            auditAttemptId: existing.auditAttemptId,
            auditRevision: existing.auditRevision,
            verdict: authenticatedAuditVerdict,
            crossVendorAuditPassed: authenticatedAuditVerdict === 'PASS' ? true : undefined,
            blocker: status === 'rework' ? existing.blocker : undefined,
            updatedAt: now,
          };
          this.#writeAssignment(current,
            status === 'passed' || status === 'rework' ? 'audit_replied' : this.#taskEventFor(status),
            {
              source: 'auditor_finished',
              auditorAssignmentId: existing.assignmentId,
              auditAttemptId: existing.auditAttemptId,
              revision: existing.auditRevision,
              verdict: authenticatedAuditVerdict,
            });
        }
        this.#db.prepare('DELETE FROM supervision_task_file_claims WHERE assignment_id = ?')
          .run(authenticatedAuditTarget.assignmentId);
      }
      if (bindMissingTaskRevision) {
        this.#writeTask({ ...task, currentRevision: resolvedRevision, updatedAt: now }, this.#taskEventFor(task.status), {
          source: 'assignment_finish',
          revisionBound: true,
          ...(matchingAudit ? { auditAttemptId: matchingAudit.auditAttemptId } : {}),
          revision: resolvedRevision,
        });
      }
      if (validatedTopLevelHandoff) {
        const currentTask = this.getTaskRecord(task.taskId) ?? task;
        if (currentTask.status !== 'ready_for_audit') {
          if (!canTransitionSupervisionTaskStatus(currentTask.status, 'ready_for_audit')) {
            this.#db.exec('ROLLBACK');
            return { ok: false, reason: 'invalid_transition' };
          }
          this.#writeTask({
            ...currentTask,
            status: 'ready_for_audit',
            currentRevision: resolvedRevision,
            updatedAt: now,
          }, 'implementation_finished', {
            source: 'assignment_finish',
            assignmentId: existing.assignmentId,
            implementationHandoff: 'FINISHED',
            auditVerdict: null,
            revision: resolvedRevision,
          });
        }
      }
      this.#db.prepare('DELETE FROM supervision_task_file_claims WHERE assignment_id = ?').run(existing.assignmentId);
      this.#deriveTaskStatus(existing.taskId, now);
      this.#db.exec('COMMIT');
      return { ok: true, value: record, ...(alreadyApplied ? { replay: true } : {}) };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Narrow project-Brain completion for identities that cannot call the
   * ordinary owner-bound FINISHED edge after a daemon/runtime replacement.
   *
   * An auditor may only be cleaned after its exact immutable final receipt.
   * An implementer may only be rebound to the same logical session name while
   * both task and assignment still represent a validated, unaudited revision.
   * No caller-provided revision, PASS, Git, CI, or finalization evidence enters
   * this transaction.
   */
  finishAssignmentAsProjectBrain(input: {
    assignmentId: string;
    callerProjectName: string;
    /**
     * The caller's EXACT live identity. Project + brain role is not ownership:
     * a second unparented Brain in the same project (a cloned session group, a
     * replacement window) would otherwise inherit authority over a task it
     * never dispatched.
     */
    callerIdentity: PersistedSupervisionTaskAssignmentIdentity;
    rebindIdentity?: PersistedSupervisionTaskAssignmentIdentity;
    rebindProjectName?: string;
    now?: number;
  }): SupervisionTaskRegistryResult<PersistedSupervisionTaskAssignment> {
    const assignmentId = normalizeTaskString(input.assignmentId);
    const callerProjectName = normalizeTaskString(input.callerProjectName);
    if (!assignmentId || !callerProjectName) return { ok: false, reason: 'invalid' };
    const assignment = this.getAssignment(assignmentId);
    if (!assignment) return { ok: false, reason: 'not_found' };
    const task = this.getTaskRecord(assignment.taskId);
    if (!task) return { ok: false, reason: 'not_found' };
    if (task.projectName !== callerProjectName) return { ok: false, reason: 'owner_mismatch' };
    // Authority is the coordinator assignment bound to THIS task. The task
    // project was checked above; within it, sessionName is the durable owner.
    // Runtime metadata may rotate and cannot strand the coordinator.
    const callerIdentity = input.callerIdentity;
    if (!callerIdentity?.sessionName) {
      return { ok: false, reason: 'owner_mismatch' };
    }
    const coordinatorBound = isSupervisionTaskCoordinator(this.listAssignments(task.taskId), callerIdentity);
    if (!coordinatorBound) return { ok: false, reason: 'owner_mismatch' };

    if (assignment.role === 'auditor') {
      if (input.rebindIdentity) return { ok: false, reason: 'role_forbidden' };
      const final = this.listAuditReceipts(task.taskId).filter((receipt) => (
        receipt.assignmentId === assignment.assignmentId
        && receipt.attemptId === assignment.auditAttemptId
        && receipt.revision === assignment.auditRevision
        && receipt.receiptKind === 'final'
      )).at(-1);
      if (!final || (final.verdict !== 'PASS' && final.verdict !== 'REWORK')) {
        return { ok: false, reason: 'old_audit_attempt' };
      }
      return this.finishAssignment({
        assignmentId: assignment.assignmentId,
        identity: assignment.identity,
        revision: assignment.auditRevision,
        now: input.now,
      });
    }

    const rebindIdentity = input.rebindIdentity;
    const rebindProjectName = normalizeTaskString(input.rebindProjectName);
    if (assignment.role !== 'implementer' || !rebindIdentity || rebindProjectName !== task.projectName) {
      return { ok: false, reason: 'role_forbidden' };
    }
    if ([
      rebindIdentity.sessionName, rebindIdentity.sessionInstanceId, rebindIdentity.runtimeEpoch,
      rebindIdentity.agentType, rebindIdentity.providerFamily,
    ].some((value) => !normalizeTaskString(value))
      || rebindIdentity.sessionName !== assignment.identity.sessionName
      || rebindIdentity.agentType !== assignment.identity.agentType
      || rebindIdentity.providerFamily !== assignment.identity.providerFamily) {
      return { ok: false, reason: 'owner_mismatch' };
    }
    const revision = normalizeTaskString(task.currentRevision);
    if (!revision || normalizeTaskString(assignment.auditRevision) !== revision) {
      return { ok: false, reason: 'old_revision' };
    }
    if (task.finalization || task.commitSha || task.pushRemoteRef || task.archivedAt
      || assignment.verdict?.trim().toUpperCase() === 'PASS'
      || ['passed', 'ready_for_integration', 'integrating', 'final_audit', 'finalizing', 'committed', 'pushed', 'finalized']
        .includes(task.status)) {
      return { ok: false, reason: 'receipt_closed' };
    }
    const acceptedAudit = this.#db.prepare(`
      SELECT 1 AS ok FROM supervision_audit_receipts
      WHERE task_id = ? AND revision = ? AND receipt_kind = 'final' LIMIT 1
    `).get(task.taskId, revision) as { ok?: number } | undefined;
    const attestation = this.#db.prepare(`
      SELECT 1 AS ok FROM supervision_audit_attestations
      WHERE task_id = ? AND revision = ? LIMIT 1
    `).get(task.taskId, revision) as { ok?: number } | undefined;
    if (acceptedAudit?.ok === 1 || attestation?.ok === 1) return { ok: false, reason: 'receipt_closed' };
    if (!['validated', 'ready_for_audit'].includes(assignment.status)
      || !['implementing', 'validated', 'ready_for_audit'].includes(task.status)) {
      return { ok: false, reason: 'invalid_transition' };
    }

    const sameIdentity = identityMatches(assignment.identity, rebindIdentity);
    const hasClaims = this.listFileClaims(task.taskId)
      .some((claim) => claim.assignmentId === assignment.assignmentId);
    const alreadyApplied = sameIdentity && assignment.status === 'ready_for_audit'
      && !assignment.leaseId && task.status === 'ready_for_audit' && !hasClaims;
    if (alreadyApplied) return { ok: true, value: assignment, replay: true };

    const now = input.now ?? Date.now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const lockedTask = this.getTaskRecord(task.taskId);
      const locked = this.getAssignment(assignment.assignmentId);
      if (!lockedTask || !locked || lockedTask.projectName !== callerProjectName
        || locked.role !== 'implementer'
        || locked.identity.sessionName !== rebindIdentity.sessionName
        || locked.identity.agentType !== rebindIdentity.agentType
        || locked.identity.providerFamily !== rebindIdentity.providerFamily
        || normalizeTaskString(lockedTask.currentRevision) !== revision
        || normalizeTaskString(locked.auditRevision) !== revision
        || !['validated', 'ready_for_audit'].includes(locked.status)
        || !['implementing', 'validated', 'ready_for_audit'].includes(lockedTask.status)) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'owner_mismatch' };
      }
      const lockedAcceptedAudit = this.#db.prepare(`
        SELECT 1 AS ok FROM supervision_audit_receipts
        WHERE task_id = ? AND revision = ? AND receipt_kind = 'final' LIMIT 1
      `).get(lockedTask.taskId, revision) as { ok?: number } | undefined;
      const lockedAttestation = this.#db.prepare(`
        SELECT 1 AS ok FROM supervision_audit_attestations
        WHERE task_id = ? AND revision = ? LIMIT 1
      `).get(lockedTask.taskId, revision) as { ok?: number } | undefined;
      if (lockedTask.finalization || lockedTask.commitSha || lockedTask.pushRemoteRef || lockedTask.archivedAt
        || locked.verdict?.trim().toUpperCase() === 'PASS'
        || lockedAcceptedAudit?.ok === 1 || lockedAttestation?.ok === 1) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'receipt_closed' };
      }
      const record: PersistedSupervisionTaskAssignment = {
        ...locked,
        identity: rebindIdentity,
        status: 'ready_for_audit',
        leaseId: '',
        generation: locked.generation + 1,
        blocker: undefined,
        updatedAt: now,
      };
      this.#writeAssignment(record, 'implementation_finished', {
        source: 'project_brain_identity_rebind_finish',
        priorIdentity: locked.identity,
        identity: rebindIdentity,
        implementationHandoff: 'FINISHED',
        auditVerdict: null,
        revision,
      });
      this.#db.prepare('DELETE FROM supervision_task_file_claims WHERE assignment_id = ?')
        .run(locked.assignmentId);
      if (lockedTask.status !== 'ready_for_audit') {
        this.#writeTask({
          ...lockedTask,
          status: 'ready_for_audit',
          blocker: undefined,
          updatedAt: now,
        }, 'implementation_finished', {
          source: 'project_brain_identity_rebind_finish',
          assignmentId: locked.assignmentId,
          implementationHandoff: 'FINISHED',
          auditVerdict: null,
          revision,
        });
      }
      this.#db.exec('COMMIT');
      return { ok: true, value: record };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Finalize one exact audited integration from structured Git evidence and
   * optional exact-commit CI evidence.
   *
   * This is intentionally separate from finishAssignment: a normal worker or
   * auditor may close only its own assignment, while the canonical
   * integration owner may advance the whole task only after the authoritative
   * audit/Git identities agree. CI is consumed only when it identifies this
   * exact commit; every outcome, including failure, is auxiliary smoke and
   * never a finalization gate. Caller path metadata is recorded but never
   * grants or vetoes finalization. All checks run before BEGIN IMMEDIATE; the status
   * chain, provenance, lease cleanup, claim cleanup and archive projection are
   * then one idempotent transaction.
   */
  finalizeIntegration(
    input: SupervisionIntegrationFinalizationInput,
  ): SupervisionTaskRegistryResult<PersistedSupervisionTaskRecord> {
    const owner = this.getAssignment(input.assignmentId);
    if (!owner) return { ok: false, reason: 'not_found' };
    if (!identityMatches(owner.identity, input.identity)) return { ok: false, reason: 'owner_mismatch' };
    if (owner.role !== 'integration_owner') return { ok: false, reason: 'role_forbidden' };
    const task = this.getTaskRecord(owner.taskId);
    if (!task) return { ok: false, reason: 'not_found' };

    const revision = normalizeTaskString(input.revision);
    const auditAttemptId = normalizeTaskString(input.auditAttemptId);
    const auditRevision = normalizeTaskString(input.auditRevision);
    const integrationOwner = normalizeTaskString(input.integrationOwner);
    const commitSha = normalizeTaskString(input.commitSha)?.toLowerCase();
    const pushRemoteRef = normalizeTaskString(input.pushRemoteRef);
    const externalRunId = normalizeTaskString(input.externalRunId);
    const externalHeadSha = normalizeTaskString(input.externalHeadSha)?.toLowerCase();
    const externalTaskId = normalizeTaskString(input.externalTaskId);
    const ciResult = input.ciResult;
    const ownedFiles = normalizeTaskArray(input.ownedFiles);
    const stagedPaths = normalizeTaskArray(input.stagedPaths);
    const manifest = [...input.integrationManifest]
      .map((entry) => ({ path: entry.path.trim(), sha256: entry.sha256.trim().toLowerCase() }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const assignments = this.listAssignments(task.taskId);
    const requiredLineage = assignments.filter((assignment) => (
      assignment.required
      && (assignment.role === 'implementer' || assignment.role === 'integration_owner')
      && assignment.status !== 'cancelled'
      && assignment.status !== 'recovered'
    ));
    const hasExactCiRun = ciResult === 'success' || ciResult === 'pending' || ciResult === 'failure';
    // An exact queried run must bind to this commit so stale CI cannot leak
    // across revisions. Its outcome is deliberately absent from the authority
    // predicate below: PASS plus exact Git/push evidence controls finalization.
    const ciEvidenceValid = hasExactCiRun
      ? Boolean(externalRunId && externalHeadSha
        && FINALIZATION_COMMIT_RE.test(externalHeadSha!))
      : !externalRunId && !externalHeadSha && !externalTaskId;
    const structurallyValid = Boolean(
      revision && auditAttemptId && auditRevision && integrationOwner && commitSha
      && pushRemoteRef && input.verdict === 'PASS' && ciEvidenceValid
      && (input.pushResult === 'pushed' || input.pushResult === 'already_present')
      && FINALIZATION_COMMIT_RE.test(commitSha)
      && pushRemoteRef.startsWith('refs/')
    );
    if (!structurallyValid) return { ok: false, reason: 'invalid' };

    const finalizedAt = task.finalization?.finalizedAt ?? input.now ?? Date.now();
    const finalization: PersistedSupervisionIntegrationFinalization = {
      revision: revision!,
      auditAttemptId: auditAttemptId!,
      auditRevision: auditRevision!,
      verdict: 'PASS',
      ownedFiles,
      integrationManifest: manifest,
      integrationOwner: integrationOwner!,
      commitSha: commitSha!,
      pushResult: input.pushResult,
      pushRemoteRef: pushRemoteRef!,
      stagedPaths,
      ...(externalRunId ? { externalRunId } : {}),
      ...(externalHeadSha ? { externalHeadSha } : {}),
      ...(externalTaskId ? { externalTaskId } : {}),
      ...(ciResult ? { ciResult } : {}),
      finalizedAt,
    };
    if (task.status === 'finalized') {
      const prior = task.finalization;
      const sameAuthority = Boolean(prior
        && prior.revision === finalization.revision
        && prior.auditAttemptId === finalization.auditAttemptId
        && prior.auditRevision === finalization.auditRevision
        && prior.verdict === finalization.verdict
        && prior.integrationOwner === finalization.integrationOwner
        && prior.commitSha === finalization.commitSha
        && prior.pushResult === finalization.pushResult
        && prior.pushRemoteRef === finalization.pushRemoteRef
        && prior.externalRunId === finalization.externalRunId
        && prior.externalHeadSha === finalization.externalHeadSha
        && prior.externalTaskId === finalization.externalTaskId
        && prior.ciResult === finalization.ciResult);
      return sameAuthority
        ? { ok: true, value: task, replay: true }
        : { ok: false, reason: 'conflicting_replay' };
    }

    if (task.status !== 'ready_for_integration' || owner.status !== 'ready_for_integration') {
      return { ok: false, reason: 'invalid_transition' };
    }
    if (integrationOwner !== owner.identity.sessionName) return { ok: false, reason: 'owner_mismatch' };
    if (task.currentRevision !== revision || auditRevision !== revision
      || owner.auditRevision !== revision) return { ok: false, reason: 'old_revision' };
    if (owner.auditAttemptId !== auditAttemptId || owner.verdict?.trim().toUpperCase() !== 'PASS') {
      return { ok: false, reason: 'old_audit_attempt' };
    }
    if (hasExactCiRun && (owner.externalRunId !== externalRunId
      || owner.externalHeadSha?.toLowerCase() !== externalHeadSha
      || (externalTaskId && owner.externalTaskId !== externalTaskId)
      || externalHeadSha !== commitSha)) {
      return { ok: false, reason: 'manifest_mismatch' };
    }
    // A daemon restart changes the runtime identity tuple while preserving the
    // durable Brain session name. task_start therefore creates a fresh owner
    // assignment, but older registries leave the task pointer on the previous
    // runtime. Repair only that exact, evidence-equivalent shape. The pointer
    // update is written below in the same transaction as finalization; this is
    // not a general owner-selection or recovery mechanism.
    let integrationOwnerReboundFromAssignmentId: string | undefined;
    if (task.integrationOwnerAssignmentId !== owner.assignmentId) {
      const staleOwner = task.integrationOwnerAssignmentId
        ? assignments.find((assignment) => assignment.assignmentId === task.integrationOwnerAssignmentId)
        : undefined;
      const concurrentOwners = assignments.filter((assignment) => (
        assignment.role === 'integration_owner'
        && assignment.assignmentId !== owner.assignmentId
        && assignment.assignmentId !== staleOwner?.assignmentId
        && (assignment.leaseId !== '' || !['cancelled', 'finalized'].includes(assignment.status))
      ));
      if (concurrentOwners.length > 0) return { ok: false, reason: 'ambiguous_assignment' };
      const callerIsProjectBrain = assignments.some((assignment) => (
        assignment.role === 'coordinator'
        && assignment.identity.sessionName === owner.identity.sessionName
      ));
      const exactStaleRuntimeOwner = Boolean(
        staleOwner
        && staleOwner.role === 'integration_owner'
        && staleOwner.taskId === task.taskId
        && staleOwner.identity.sessionName === owner.identity.sessionName
        && !runtimeIdentityMetadataMatches(staleOwner.identity, owner.identity)
        && staleOwner.status === 'ready_for_integration'
        && staleOwner.leaseId === ''
        && staleOwner.auditRevision === revision
        && staleOwner.auditAttemptId === auditAttemptId
        && staleOwner.verdict?.trim().toUpperCase() === 'PASS'
        && staleOwner.crossVendorAuditPassed === true
        && owner.crossVendorAuditPassed === true
        && callerIsProjectBrain
      );
      if (!exactStaleRuntimeOwner) return { ok: false, reason: 'owner_mismatch' };
      integrationOwnerReboundFromAssignmentId = staleOwner!.assignmentId;
    }

    if (requiredLineage.some((assignment) => assignment.auditRevision !== revision)) {
      return { ok: false, reason: 'old_revision' };
    }
    if (requiredLineage.length === 0 || requiredLineage.some((assignment) => (
      !assignment.auditAttemptId
      || assignment.verdict?.trim().toUpperCase() !== 'PASS'
      || assignment.crossVendorAuditPassed !== true
    ))) return { ok: false, reason: 'old_audit_attempt' };

    const exactAuditors = assignments.filter((assignment) => (
      assignment.role === 'auditor'
      && assignment.auditAttemptId === auditAttemptId
      && assignment.auditRevision === revision
      && assignment.verdict?.trim().toUpperCase() === 'PASS'
    ));
    if (exactAuditors.length !== 1) return { ok: false, reason: 'ambiguous_assignment' };
    const auditor = exactAuditors[0];
    if (auditor.status !== 'finalized') return { ok: false, reason: 'invalid_transition' };
    if (auditor.identity.sessionName === owner.identity.sessionName) return { ok: false, reason: 'owner_mismatch' };
    const auditReceipts = this.listAuditReceipts(task.taskId)
      .filter((receipt) => receipt.assignmentId === auditor.assignmentId
        && receipt.attemptId === auditAttemptId && receipt.revision === revision);
    if (auditReceipts.length > 0) {
      const latestFinal = auditReceipts.filter((receipt) => receipt.receiptKind === 'final').at(-1);
      if (!latestFinal || latestFinal.verdict !== 'PASS') return { ok: false, reason: 'old_audit_attempt' };
    }

    const chain: readonly SupervisionTaskLifecycleStatus[] =
      SUPERVISION_INTEGRATION_FINALIZATION_STATUS_PATH.slice(1);
    let taskRecord = task;
    let ownerRecord = owner;
    for (const status of chain) {
      if (!canTransitionSupervisionTaskStatus(taskRecord.status, status)
        || !canTransitionSupervisionTaskStatus(ownerRecord.status, status)) {
        return { ok: false, reason: 'invalid_transition' };
      }
      taskRecord = { ...taskRecord, status };
      ownerRecord = { ...ownerRecord, status };
    }

    const now = input.now ?? Date.now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      taskRecord = integrationOwnerReboundFromAssignmentId
        ? { ...task, integrationOwnerAssignmentId: owner.assignmentId }
        : task;
      ownerRecord = owner;
      for (const status of chain) {
        ownerRecord = {
          ...ownerRecord,
          status,
          leaseId: status === 'finalized' ? '' : ownerRecord.leaseId,
          blocker: undefined,
          updatedAt: now,
        };
        taskRecord = {
          ...taskRecord,
          status,
          blocker: undefined,
          ...(status === 'committed' ? { commitSha } : {}),
          ...(status === 'pushed' ? { pushRemoteRef } : {}),
          ...(status === 'finalized' ? {
            commitSha,
            pushRemoteRef,
            finalization,
            archivedAt: now,
            archiveReason: 'terminal_retention' as const,
            cleanupVersion: SUPERVISION_TASK_CLEANUP_VERSION,
          } : {}),
          updatedAt: now,
        };
        const payload = {
          source: 'structured_integration_finalization',
          auditAttemptId,
          auditRevision,
          revision,
          integrationOwner,
          ...(integrationOwnerReboundFromAssignmentId ? {
            integrationOwnerReboundFromAssignmentId,
            integrationOwnerReboundToAssignmentId: owner.assignmentId,
          } : {}),
          ...(status === 'committed' ? { commitSha } : {}),
          ...(status === 'pushed' ? { pushResult: input.pushResult, pushRemoteRef } : {}),
          ...(status === 'finalized' ? {
            ...(externalRunId ? { externalRunId } : {}),
            ...(externalHeadSha ? { externalHeadSha } : {}),
            ...(ciResult ? { ciResult } : {}),
          } : {}),
        };
        this.#writeAssignment(ownerRecord, this.#taskEventFor(status), payload);
        this.#writeTask(taskRecord, this.#taskEventFor(status), payload);
      }
      for (const assignment of assignments) {
        if (assignment.assignmentId === owner.assignmentId || !assignment.leaseId) continue;
        this.#writeAssignment({ ...assignment, leaseId: '', updatedAt: now }, this.#taskEventFor(assignment.status), {
          source: 'structured_integration_finalization', leaseRevoked: true,
        });
      }
      this.#db.prepare('DELETE FROM supervision_task_file_claims WHERE task_id = ?').run(task.taskId);
      this.#db.exec('COMMIT');
      return { ok: true, value: taskRecord };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Brain-authorized audit-device recovery; preserves attempt/revision/history. */
  /**
   * Standalone Brain-authorized retirement of ONE exact stale auditor on the
   * CURRENT revision. Before this existed the only way to retire a live auditor
   * was to bind a successor revision, so a same-revision deadlock had no exit
   * (tsk_4dd). Audit history is append-only and untouched, no verdict is ever
   * written, and an accepted PASS is never cancellable.
   */
  cancelStaleAuditorAsProjectBrain(input: {
    taskId: string;
    auditorAssignmentId: string;
    callerProjectName: string;
    reason: string;
    now?: number;
  }): SupervisionTaskRegistryResult<PersistedSupervisionTaskAssignment> {
    const task = this.getTaskRecord(normalizeTaskString(input.taskId) ?? '');
    const auditor = this.getAssignment(normalizeTaskString(input.auditorAssignmentId) ?? '');
    const callerProjectName = normalizeTaskString(input.callerProjectName);
    const reason = normalizeTaskString(input.reason);
    if (!task || !auditor || auditor.taskId !== task.taskId) return { ok: false, reason: 'not_found' };
    if (!callerProjectName || task.projectName !== callerProjectName) return { ok: false, reason: 'owner_mismatch' };
    if (auditor.role !== 'auditor' || !reason) return { ok: false, reason: 'role_forbidden' };
    if (['cancelled', 'finalized'].includes(auditor.status)) {
      return { ok: false, reason: 'invalid_transition', detail: { taskStatus: task.status, assignmentStatus: auditor.status } };
    }
    if (task.commitSha || task.pushRemoteRef || task.finalization || task.archivedAt) {
      return { ok: false, reason: 'invalid_transition', detail: { taskStatus: task.status, assignmentStatus: auditor.status } };
    }
    const acceptedPass = auditor.verdict?.trim().toUpperCase() === 'PASS'
      || this.listAuditReceipts(task.taskId).some((receipt) => receipt.assignmentId === auditor.assignmentId
        && receipt.receiptKind === 'final'
        && receipt.verdict?.trim().toUpperCase() === 'PASS');
    if (acceptedPass) {
      return {
        ok: false,
        reason: 'receipt_closed',
        detail: {
          taskStatus: task.status,
          assignmentStatus: auditor.status,
          expectedRevision: auditor.auditRevision,
          expectedAttemptId: auditor.auditAttemptId,
        },
      };
    }
    const now = input.now ?? Date.now();
    const cancelled: PersistedSupervisionTaskAssignment = {
      ...auditor,
      status: 'cancelled',
      leaseId: '',
      blocker: JSON.stringify({ brainAuthorizedStaleAuditorCancel: true, reason, revision: auditor.auditRevision, attemptId: auditor.auditAttemptId }),
      updatedAt: now,
    };
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#writeAssignment(cancelled, 'cancelled', {
        source: 'brain_authorized_stale_auditor_cancel',
        reason,
        attemptId: auditor.auditAttemptId,
        revision: auditor.auditRevision,
      });
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return { ok: true, value: cancelled };
  }

  rebindAuditAssignment(input: {
    taskId: string;
    assignmentId: string;
    identity: PersistedSupervisionTaskAssignmentIdentity;
    /**
     * Authority layer. The registry is the authority of record and is reachable
     * from callers other than the MCP tool, so the project check lives HERE and
     * not only at that entry point. Without it a foreign project could rebind
     * another project's assignment straight through the port.
     */
    callerProjectName: string;
    reason: string;
    now?: number;
  }): SupervisionTaskRegistryResult<PersistedSupervisionTaskAssignment> {
    const task = this.getTaskRecord(input.taskId);
    const assignment = this.getAssignment(input.assignmentId);
    const reason = input.reason.trim();
    const callerProjectName = normalizeTaskString(input.callerProjectName);
    if (!task || !assignment || assignment.taskId !== task.taskId) return { ok: false, reason: 'not_found' };
    if (!callerProjectName || task.projectName !== callerProjectName) return { ok: false, reason: 'owner_mismatch' };
    // A daemon restart or runtime-epoch replacement strands the exact owner of
    // ANY long-lived role, not just auditors. Coordinator and integration_owner
    // are rebindable on the same object; attempt/revision provenance is
    // required for auditors, where it is the audit's identity.
    if (!SUPERVISION_REBINDABLE_EXACT_ROLES.has(assignment.role) || !reason) {
      return { ok: false, reason: 'role_forbidden' };
    }
    if (assignment.role === 'auditor' && (!assignment.auditAttemptId || !assignment.auditRevision)) {
      return { ok: false, reason: 'role_forbidden' };
    }
    if (assignment.auditRevision && task.currentRevision
      && task.currentRevision !== assignment.auditRevision) return { ok: false, reason: 'old_revision' };
    if (['finalized', 'cancelled', 'committed', 'pushed'].includes(assignment.status)
      || ['committed', 'pushed', 'finalized'].includes(task.status)) {
      return { ok: false, reason: 'receipt_closed' };
    }
    if (runtimeIdentityMetadataMatches(assignment.identity, input.identity)) {
      return { ok: true, value: assignment, replay: true };
    }
    const now = input.now ?? Date.now();
    const rebound: PersistedSupervisionTaskAssignment = {
      ...assignment,
      identity: input.identity,
      generation: assignment.generation + 1,
      updatedAt: now,
    };
    this.#writeAssignment(rebound, 'recovered', {
      source: 'brain_authorized_audit_identity_rebind',
      reason,
      priorIdentity: assignment.identity,
      attemptId: assignment.auditAttemptId,
      revision: assignment.auditRevision,
    });
    return { ok: true, value: rebound };
  }

  /**
   * Rebind a stale runtime on the one validated required implementer without
   * changing its lifecycle, lease, scope, revision, or assignment identity.
   * The live identity is daemon-observed by the MCP ingress; this transaction
   * only accepts the exact same logical session and frozen evidence binding.
   */
  rebindValidatedImplementerAssignment(input: {
    taskId: string;
    assignmentId: string;
    identity: PersistedSupervisionTaskAssignmentIdentity;
    expectedRevision: string;
    ownedFiles: readonly string[];
    evidenceManifestSha256: string;
    reason: string;
    now?: number;
  }): SupervisionTaskRegistryResult<PersistedSupervisionTaskAssignment> {
    const taskId = normalizeTaskString(input.taskId);
    const assignmentId = normalizeTaskString(input.assignmentId);
    const expectedRevision = normalizeTaskString(input.expectedRevision);
    const ownedFiles = normalizeTaskArray(input.ownedFiles);
    const evidenceManifestSha256 = normalizeTaskString(input.evidenceManifestSha256)?.toLowerCase();
    const reason = normalizeTaskString(input.reason);
    const targetIdentity: PersistedSupervisionTaskAssignmentIdentity = {
      sessionName: normalizeTaskString(input.identity.sessionName) ?? '',
      sessionInstanceId: normalizeTaskString(input.identity.sessionInstanceId) ?? '',
      runtimeEpoch: normalizeTaskString(input.identity.runtimeEpoch) ?? '',
      agentType: normalizeTaskString(input.identity.agentType) ?? '',
      providerFamily: normalizeTaskString(input.identity.providerFamily) ?? '',
    };
    if (!taskId || !assignmentId || !expectedRevision || !reason
      || !evidenceManifestSha256 || !FINALIZATION_SHA256_RE.test(evidenceManifestSha256)
      || ownedFiles.length === 0 || ownedFiles.length !== input.ownedFiles.length
      || !ownedFiles.every(validRepoPath)
      || Object.values(targetIdentity).some((value) => !value)) return { ok: false, reason: 'invalid' };

    const now = input.now ?? Date.now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.getTaskRecord(taskId);
      const assignment = this.getAssignment(assignmentId);
      if (!task || !assignment || assignment.taskId !== taskId) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'not_found' };
      }

      const recoveryEvents = this.listEvents(taskId).filter((event) => (
        event.assignmentId === assignmentId
        && event.eventType === 'recovered'
        && event.payload?.source === 'brain_authorized_implementer_identity_rebind'
        && event.payload?.revision === expectedRevision
        && event.payload?.evidenceManifestSha256 === evidenceManifestSha256
        && sameStringArray(
          Array.isArray(event.payload?.ownedFiles)
            ? event.payload.ownedFiles.map((path) => String(path))
            : [],
          ownedFiles,
        )
      ));
      const priorTargetingRequestedIdentity = recoveryEvents.some((event) => {
        const target = event.payload?.targetIdentity as Partial<PersistedSupervisionTaskAssignmentIdentity> | undefined;
        return Boolean(target && runtimeIdentityMetadataMatches(
          target as PersistedSupervisionTaskAssignmentIdentity,
          targetIdentity,
        ));
      });
      const identityAlreadyCurrent = runtimeIdentityMetadataMatches(assignment.identity, targetIdentity);

      const assignments = this.listAssignments(taskId);
      const activeImplementers = assignments.filter((candidate) => (
        candidate.required
        && candidate.role === 'implementer'
        && !['cancelled', 'recovered', 'finalized'].includes(candidate.status)
      ));
      const activeAuditor = assignments.some((candidate) => (
        candidate.role === 'auditor'
        && !['cancelled', 'finalized'].includes(candidate.status)
      ));
      const exactLifecycle = (task.status === 'validated' || task.status === 'ready_for_audit')
        && assignment.status === task.status;
      const exactIdentityFamily = assignment.identity.sessionName === targetIdentity.sessionName;
      const conflictingPassAssignment = assignments.some((candidate) => (
        candidate.auditRevision === expectedRevision
        && candidate.verdict?.trim().toUpperCase() === 'PASS'
      ));
      const conflictingAuditEvidence = Boolean(
        assignment.auditAttemptId
        || assignment.verdict
        || assignment.primaryReviewPassed
        || assignment.crossVendorAuditPassed
        || conflictingPassAssignment
        || this.listAuditReceipts(taskId).length > 0
        || this.#db.prepare(
          'SELECT 1 AS ok FROM supervision_audit_attestations WHERE task_id = ? AND revision = ? LIMIT 1',
        ).get(taskId, expectedRevision),
      );
      // Claims are retired from the public projection, but a legacy/corrupt
      // row must still block identity recovery rather than being laundered by
      // the compatibility `listFileClaims()` empty view.
      const legacyClaim = this.#db.prepare(
        'SELECT 1 AS ok FROM supervision_task_file_claims WHERE task_id = ? LIMIT 1',
      ).get(taskId) as { ok?: number } | undefined;
      const exactShape = Boolean(
        task.classification !== 'integration_slice'
        && assignment.role === 'implementer'
        && assignment.required
        && exactLifecycle
        && task.currentRevision === expectedRevision
        && assignment.auditRevision === expectedRevision
        && Boolean(assignment.leaseId)
        && activeImplementers.length === 1
        && activeImplementers[0]?.assignmentId === assignmentId
        && !activeAuditor
        && !conflictingAuditEvidence
        && exactIdentityFamily
        && sameStringArray(assignment.scopeFiles, ownedFiles)
        && !task.commitSha
        && !task.pushRemoteRef
        && !task.finalization
        && !task.archivedAt
        && legacyClaim?.ok !== 1
      );
      if (!exactShape) {
        this.#db.exec('ROLLBACK');
        return activeImplementers.length > 1 ? { ok: false, reason: 'ambiguous_assignment' }
          : !exactIdentityFamily ? { ok: false, reason: 'owner_mismatch' }
            : !sameStringArray(assignment.scopeFiles, ownedFiles) ? { ok: false, reason: 'manifest_mismatch' }
              : task.currentRevision !== expectedRevision || assignment.auditRevision !== expectedRevision
                ? { ok: false, reason: 'old_revision' }
                : ['committed', 'pushed', 'finalized'].includes(task.status) || Boolean(task.finalization)
                  ? { ok: false, reason: 'receipt_closed' }
                  : { ok: false, reason: 'invalid_transition' };
      }
      if (identityAlreadyCurrent) {
        this.#db.exec('ROLLBACK');
        return priorTargetingRequestedIdentity
          ? { ok: true, value: assignment, replay: true }
          : { ok: false, reason: 'invalid_transition' };
      }
      if (priorTargetingRequestedIdentity) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'conflicting_replay' };
      }

      const rebound: PersistedSupervisionTaskAssignment = {
        ...assignment,
        identity: targetIdentity,
        generation: assignment.generation + 1,
        updatedAt: now,
      };
      this.#writeAssignment(rebound, 'recovered', {
        source: 'brain_authorized_implementer_identity_rebind',
        reason,
        priorIdentity: assignment.identity,
        targetIdentity,
        revision: expectedRevision,
        ownedFiles,
        evidenceManifestSha256,
      });
      this.#db.exec('COMMIT');
      return { ok: true, value: rebound };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Brain/admin-authorized recovery for one frozen revision on the SAME task
   * and required implementer assignment. Historical audit rows and events are
   * append-only; only the live revision binding is cleared and rebound.
   */
  /**
   * Selects the stale auditors a successor-revision bind is allowed to retire.
   *
   * Single definition shared by the ordinary successor bind and by Brain's
   * revision recovery, so the two can never drift into different notions of
   * "stale". Only auditors bound to the revision being superseded are eligible,
   * and an auditor that already returned an accepted PASS is never eligible --
   * that verdict is authority. Audit progress alone does NOT protect an
   * auditor: a stale in-progress audit of a superseded revision is exactly what
   * has to be retired, otherwise the task wedges with no operator escape.
   */
  /**
   * Existing object relations decide whether a revision has already been
   * audited: a final receipt or an attestation for that exact revision. This is
   * what makes a downgrade decidable without inventing an ordering over
   * hash-suffixed revision ids -- moving the task back onto a revision that
   * already carries accepted audit authority is never a catch-up.
   */
  #revisionHasAcceptedAudit(taskId: string, revision: string): boolean {
    const receipt = this.#db.prepare(`
      SELECT 1 AS ok FROM supervision_audit_receipts
      WHERE task_id = ? AND revision = ? AND receipt_kind = 'final' LIMIT 1
    `).get(taskId, revision) as { ok?: number } | undefined;
    if (receipt?.ok === 1) return true;
    const attestation = this.#db.prepare(`
      SELECT 1 AS ok FROM supervision_audit_attestations
      WHERE task_id = ? AND revision = ? LIMIT 1
    `).get(taskId, revision) as { ok?: number } | undefined;
    return attestation?.ok === 1;
  }

  /**
   * True only when this assignment's PASS was already consumed by the task's
   * immutable integration finalization. Such a row is historical provenance,
   * not a second live owner of a later successor revision.
   *
   * The exact attempt + revision + PASS tuple matters: merely being old or
   * ready_for_integration is not enough, and an unconsumed peer therefore
   * remains an ambiguity that recovery must refuse.
   */
  #assignmentConsumedByFinalization(
    task: PersistedSupervisionTaskRecord,
    assignment: PersistedSupervisionTaskAssignment,
  ): boolean {
    const finalization = task.finalization;
    return Boolean(
      finalization
      && assignment.required
      && (assignment.role === 'implementer' || assignment.role === 'integration_owner')
      && ['ready_for_integration', 'committed', 'pushed', 'finalized'].includes(assignment.status)
      && assignment.auditAttemptId === finalization.auditAttemptId
      && assignment.auditRevision === finalization.revision
      && assignment.verdict?.trim().toUpperCase() === 'PASS'
      && assignment.crossVendorAuditPassed === true
    );
  }

  #selectSupersedableAuditors(input: {
    taskId: string;
    taskStatus: string;
    supersededRevision: string | undefined;
    successorRevision?: string | undefined;
  }): { ok: true; superseded: PersistedSupervisionTaskAssignment[] }
    | { ok: false; reason: 'receipt_closed' | 'stale_audit_revision'; detail: SupervisionTaskRegistryRejectDetail } {
    const superseded: PersistedSupervisionTaskAssignment[] = [];
    const receipts = this.listAuditReceipts(input.taskId);
    for (const candidate of this.listAssignments(input.taskId)) {
      if (candidate.role !== 'auditor') continue;
      if (['cancelled', 'finalized', 'rework'].includes(candidate.status)) continue;
      const acceptedPass = candidate.verdict?.trim().toUpperCase() === 'PASS'
        || receipts.some((receipt) => receipt.assignmentId === candidate.assignmentId
          && receipt.receiptKind === 'final'
          && receipt.verdict?.trim().toUpperCase() === 'PASS');
      if (acceptedPass) {
        return {
          ok: false,
          reason: 'receipt_closed',
          detail: {
            taskStatus: input.taskStatus,
            assignmentStatus: candidate.status,
            expectedRevision: candidate.auditRevision,
            actualRevision: input.successorRevision,
            expectedAttemptId: candidate.auditAttemptId,
          },
        };
      }
      if (candidate.auditRevision !== input.supersededRevision) {
        return {
          ok: false,
          reason: 'stale_audit_revision',
          detail: {
            taskStatus: input.taskStatus,
            assignmentStatus: candidate.status,
            expectedRevision: input.supersededRevision,
            actualRevision: candidate.auditRevision,
            expectedAttemptId: candidate.auditAttemptId,
          },
        };
      }
      superseded.push(candidate);
    }
    return { ok: true, superseded };
  }

  rebindTaskAssignmentRevision(input: {
    taskId: string;
    assignmentId: string;
    fromRevision?: string;
    toRevision: string;
    /** Caller-reported attribution only; never recovery authority. */
    ownedFiles?: readonly string[];
    scopeFiles?: readonly string[];
    worktreeSnapshot: SupervisionWorktreeSnapshot;
    leaseAction: SupervisionRecoveryLeaseAction;
    idempotencyKey: string;
    /** Caller-reported provenance only; never recovery authority. */
    evidenceManifestSha256?: string;
    reason: string;
    now?: number;
  }): SupervisionTaskRegistryResult<PersistedSupervisionTaskRecord> {
    const taskId = normalizeTaskString(input.taskId);
    const assignmentId = normalizeTaskString(input.assignmentId);
    const fromRevision = normalizeTaskString(input.fromRevision);
    const toRevision = normalizeTaskString(input.toRevision);
    const evidenceManifestSha256 = normalizeTaskString(input.evidenceManifestSha256)?.toLowerCase();
    const reason = normalizeTaskString(input.reason);
    const idempotencyKey = normalizeTaskString(input.idempotencyKey);
    const ownedFiles = normalizeTaskArray(input.ownedFiles ?? []).filter(validRepoPath);
    const scopeFiles = input.scopeFiles === undefined
      ? undefined : normalizeTaskArray(input.scopeFiles).filter(validRepoPath);
    if (!taskId || !assignmentId || !toRevision || fromRevision === toRevision
      || !reason || !idempotencyKey
      || !SUPERVISION_RECOVERY_LEASE_ACTIONS.includes(input.leaseAction)
      // A successful revision rebind always normalizes the required
      // implementer to an active lease. `clear` is valid for coordination
      // recovery, but cannot truthfully describe this atomic transition.
      || input.leaseAction === 'clear') {
      return { ok: false, reason: 'invalid' };
    }

    const worktree = input.worktreeSnapshot;
    if (!worktree || !Array.isArray(worktree.files) || !Array.isArray(worktree.stagedPaths)
      || !Array.isArray(worktree.conflictedPaths) || !Array.isArray(worktree.untrackedPaths)) {
      return { ok: false, reason: 'manifest_mismatch' };
    }
    const worktreeFiles = [...worktree.files].sort((a, b) => a.path.localeCompare(b.path));
    const worktreePaths = worktreeFiles.map((file) => file.path);
    const worktreeValid = FINALIZATION_COMMIT_RE.test(worktree.headSha)
      && worktree.stagedPaths.length === 0
      && worktree.conflictedPaths.length === 0
      && worktreePaths.length === new Set(worktreePaths).size
      && worktreeFiles.every((file) => validRepoPath(file.path)
        && ((file.deleted === true && file.sha256 === undefined)
          || (file.deleted !== true && Boolean(file.sha256 && FINALIZATION_SHA256_RE.test(file.sha256)))))
      && worktree.untrackedPaths.every((path) => worktreePaths.includes(path));
    if (!worktreeValid) return { ok: false, reason: 'manifest_mismatch' };

    const now = input.now ?? Date.now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.getTaskRecord(taskId);
      const assignment = this.getAssignment(assignmentId);
      if (!task || !assignment || assignment.taskId !== taskId) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'not_found' };
      }

      const targetScopeFiles = scopeFiles ?? assignment.scopeFiles;
      const exactReplay = task.currentRevision === toRevision && assignment.auditRevision === toRevision;
      if (exactReplay) {
        const priorEvents = this.listEvents(taskId).filter((event) => (
          event.assignmentId === assignmentId
          && event.eventType === 'recovered'
          && event.payload?.source === 'brain_authorized_revision_rebind'
          && event.payload?.idempotencyKey === idempotencyKey
        ));
        const prior = priorEvents.find((event) => (
          event.payload?.fromRevision === (fromRevision ?? null)
          && event.payload?.toRevision === toRevision
          && event.payload?.leaseAction === input.leaseAction
          && event.payload?.worktreeHeadSha === worktree.headSha
          && sameStringArray(
            Array.isArray(event.payload?.worktreePaths)
              ? event.payload.worktreePaths.map((path) => String(path)) : [],
            worktreePaths,
          )
          && sameWorktreeManifest(event.payload?.worktreeManifest, worktreeFiles)
        ));
        this.#db.exec('ROLLBACK');
        return priorEvents.length === 0 ? { ok: false, reason: 'conflicting_replay' }
          : prior
          ? { ok: true, value: task, replay: true }
          : { ok: false, reason: 'conflicting_replay' };
      }

      const assignments = this.listAssignments(taskId);
      const activeImplementers = assignments.filter((candidate) => (
        candidate.required
        && candidate.role === 'implementer'
        && !['cancelled', 'recovered', 'finalized'].includes(candidate.status)
        // A ready_for_integration PASS whose exact attempt/revision has already
        // been consumed by immutable finalization is history, not an active
        // competitor to the explicitly selected successor.
        && !this.#assignmentConsumedByFinalization(task, candidate)
      ));
      // A stale auditor bound to the revision being superseded is RETIRED by
      // this recovery, not a reason to refuse it. Refusing was the tsk_4dd
      // deadlock: the auditor could not be cancelled by any exposed path, so
      // the task wedged permanently. Only an auditor that is NOT supersedable
      // (accepted PASS, or bound to some other revision) still blocks.
      const auditorSelection = this.#selectSupersedableAuditors({
        taskId: task.taskId,
        taskStatus: task.status,
        supersededRevision: fromRevision ?? task.currentRevision,
        successorRevision: toRevision,
      });
      const supersedableAuditorIds = new Set(
        auditorSelection.ok ? auditorSelection.superseded.map((candidate) => candidate.assignmentId) : [],
      );
      const activeAuditor = assignments.some((candidate) => (
        candidate.role === 'auditor'
        && !['cancelled', 'finalized'].includes(candidate.status)
        && !supersedableAuditorIds.has(candidate.assignmentId)
      ));
      if (!auditorSelection.ok) {
        this.#db.exec('ROLLBACK');
        return auditorSelection;
      }
      const protectedRevisions = new Set([
        fromRevision, task.currentRevision, assignment.auditRevision, toRevision,
      ].filter((value): value is string => Boolean(value)));
      const targetPassAssignments = assignments.filter((candidate) => (
        candidate.verdict?.trim().toUpperCase() === 'PASS'
        && candidate.auditRevision === toRevision
      ));
      const conflictingTargetPassAssignment = targetPassAssignments.length > 0;
      const conflictingLivePassAssignment = assignments.some((candidate) => (
        !['cancelled', 'recovered', 'finalized'].includes(candidate.status)
        && !this.#assignmentConsumedByFinalization(task, candidate)
        && (candidate.verdict?.trim().toUpperCase() === 'PASS'
          || candidate.primaryReviewPassed === true
          || candidate.crossVendorAuditPassed === true)
        && (candidate.assignmentId === assignmentId
          || Boolean(candidate.auditRevision && protectedRevisions.has(candidate.auditRevision)))
      ));
      // Immutable PASS history for the source revision is retained when Brain
      // explicitly reopens the same object after a real CI failure. It cannot
      // authorize the target revision, so only pre-existing PASS authority for
      // that target conflicts with a fresh rebind/audit cycle.
      const targetPassAttestations = this.#db.prepare(
        `SELECT attempt_id AS attemptId, assignment_id AS assignmentId
         FROM supervision_audit_attestations
         WHERE task_id = ? AND revision = ? AND UPPER(TRIM(verdict)) = 'PASS'`,
      ).all(taskId, toRevision) as Array<{ attemptId?: unknown; assignmentId?: unknown }>;
      const conflictingTargetPassReceipt = this.#db.prepare(
        `SELECT 1 AS ok FROM supervision_audit_receipts
         WHERE task_id = ? AND revision = ? AND receipt_kind = 'final'
           AND UPPER(TRIM(verdict)) = 'PASS' LIMIT 1`,
      ).get(taskId, toRevision) as { ok?: number } | undefined;
      const auditReceipts = this.listAuditReceipts(taskId);
      const exactFinalizedTargetPasses = targetPassAssignments.filter((candidate) => {
        if (candidate.role !== 'auditor' || candidate.status !== 'finalized'
          || candidate.leaseId || !candidate.auditAttemptId) return false;
        const latestFinal = auditReceipts.filter((receipt) => (
          receipt.assignmentId === candidate.assignmentId
          && receipt.attemptId === candidate.auditAttemptId
          && receipt.revision === toRevision
          && receipt.receiptKind === 'final'
        )).at(-1);
        return latestFinal?.verdict === 'PASS';
      });
      const exactPassedSuccessor = exactFinalizedTargetPasses.length === 1
        ? exactFinalizedTargetPasses[0]
        : undefined;
      const exactSourceReworkAuditors = assignments.filter((candidate) => {
        if (!fromRevision || !assignment.auditAttemptId
          || candidate.role !== 'auditor'
          || !['cancelled', 'finalized'].includes(candidate.status)
          || candidate.leaseId
          || candidate.auditAttemptId !== assignment.auditAttemptId
          || candidate.auditRevision !== fromRevision
          || candidate.verdict?.trim().toUpperCase() !== 'REWORK') return false;
        const latestFinal = auditReceipts.filter((receipt) => (
          receipt.assignmentId === candidate.assignmentId
          && receipt.attemptId === candidate.auditAttemptId
          && receipt.revision === fromRevision
          && receipt.receiptKind === 'final'
        )).at(-1);
        return latestFinal?.verdict === 'REWORK';
      });
      const exactPassedSuccessorAuthority = Boolean(
        exactPassedSuccessor
        && exactSourceReworkAuditors.length === 1
        && targetPassAssignments.length === 1
        && targetPassAttestations.every((attestation) => (
          attestation.attemptId === exactPassedSuccessor.auditAttemptId
          && attestation.assignmentId === assignmentId
        )),
      );
      const activeCoordinationAssignments = assignments.filter((candidate) => (
        candidate.role !== 'implementer'
        && candidate.role !== 'auditor'
        && !['cancelled', 'recovered', 'finalized'].includes(candidate.status)
      ));
      const aggregateImplementingFromCoordination = task.status === 'implementing'
        && activeCoordinationAssignments.length > 0
        && activeCoordinationAssignments.every((candidate) => (
          ['coordinator', 'integration_owner'].includes(candidate.role)
          && ['delegated', 'implementing'].includes(candidate.status)
          && Boolean(candidate.leaseId)
        ));
      const targetPassConflictFree = !conflictingTargetPassAssignment
        && targetPassAttestations.length === 0
        && conflictingTargetPassReceipt?.ok !== 1;
      const sourceBindingMatches = (revision: string | undefined) => (
        !revision || Boolean(fromRevision && revision === fromRevision)
      );
      // A crashed/older control plane can persist the inspected target on the
      // implementer before projecting it to the task. Accept only that narrow
      // split; the task must still match the declared source revision and all
      // worktree, lifecycle, PASS, Git, and ambiguity gates below still apply.
      const assignmentBindingMatches = sourceBindingMatches(assignment.auditRevision)
        || Boolean(fromRevision
          && task.currentRevision === fromRevision
          && assignment.auditRevision === toRevision);
      const carriesConsistentHistoricalFinalization = Boolean(
        task.finalization
        && task.commitSha === task.finalization.commitSha
        && task.pushRemoteRef === task.finalization.pushRemoteRef
        && task.finalization.auditRevision === task.finalization.revision
        // Finalization authorizes exactly one edge away from the revision it
        // closed. Once currentRevision has advanced, the historical R4 record
        // cannot be reused as standing authority for R5 -> R6 -> ... rewrites.
        // Finalization is authority for its OWN revision, and history once the
        // task has moved on. Previously this demanded equality, so an aggregate
        // could take exactly one edge past a finalization and then wedge:
        // Brain's own revision recovery refused every later rebind with
        // `old_revision`. The historical case is admitted through the SAME
        // shared predicate the two ordinary bind paths use, and it is not
        // free-running -- no live integration owner, an internally consistent
        // finalization, an assignment that finalization did not consume, plus
        // every worktree/PASS/lease/ambiguity gate below still applies.
        && (task.currentRevision === task.finalization.revision
          || this.#historicalFinalizationOnly(task))
        && !this.#assignmentConsumedByFinalization(task, assignment)
      );
      const exactStaleShape = Boolean(
        (!HOUSEKEEPING_ASSIGNMENT_AGGREGATE_TERMINAL.has(task.status)
          || carriesConsistentHistoricalFinalization)
        && !HOUSEKEEPING_ASSIGNMENT_AGGREGATE_TERMINAL.has(assignment.status)
        && sourceBindingMatches(task.currentRevision)
        && assignmentBindingMatches
        && assignment.role === 'implementer'
        && assignment.required
        && activeImplementers.length === 1
        && activeImplementers[0]?.assignmentId === assignmentId
        && !activeAuditor
        && (targetPassConflictFree || Boolean(
          exactPassedSuccessorAuthority
          && fromRevision
          && task.currentRevision === fromRevision
          && assignment.auditRevision === fromRevision
          && (task.status === 'rework' || aggregateImplementingFromCoordination)
          && assignment.status === 'rework'
          && assignment.verdict?.trim().toUpperCase() === 'REWORK'
          && assignment.leaseId
          && input.leaseAction === 'preserve'
        ))
        && !conflictingLivePassAssignment
        && (carriesConsistentHistoricalFinalization || (
          !task.commitSha
          && !task.pushRemoteRef
          && !task.finalization
          && !task.archivedAt
        ))
      );
      if (!exactStaleShape) {
        this.#db.exec('ROLLBACK');
          return activeImplementers.length > 1 ? { ok: false, reason: 'ambiguous_assignment' }
          : activeAuditor ? { ok: false, reason: 'invalid_transition' }
            : task.finalization && task.currentRevision !== task.finalization.revision
              ? { ok: false, reason: 'old_revision' }
              : !sourceBindingMatches(task.currentRevision) || !assignmentBindingMatches
                ? { ok: false, reason: 'old_revision' }
                : { ok: false, reason: 'invalid_transition' };
      }

      const payload = {
        source: 'brain_authorized_revision_rebind',
        idempotencyKey,
        reason,
        fromRevision: fromRevision ?? null,
        toRevision,
        // These two fields are retained for attribution only. Replay and
        // authorization intentionally ignore them.
        ownedFiles,
        scopeFiles: targetScopeFiles,
        worktreeHeadSha: worktree.headSha,
        worktreePaths,
        worktreeManifest: worktreeFiles,
        leaseAction: input.leaseAction,
        ...(evidenceManifestSha256 ? { evidenceManifestSha256 } : {}),
        ...(assignment.auditAttemptId ? { previousAuditAttemptId: assignment.auditAttemptId } : {}),
        ...(assignment.verdict ? { previousVerdict: assignment.verdict } : {}),
      };
      const reboundAssignment: PersistedSupervisionTaskAssignment = {
        ...assignment,
        scopeFiles: targetScopeFiles,
        leaseId: input.leaseAction === 'preserve' && assignment.leaseId
          ? assignment.leaseId : this.#mintLeaseId(),
        status: 'implementing',
        generation: assignment.generation + 1,
        auditAttemptId: undefined,
        auditRevision: toRevision,
        verdict: undefined,
        blocker: undefined,
        externalRunId: undefined,
        externalHeadSha: undefined,
        externalTaskId: undefined,
        primaryReviewPassed: undefined,
        crossVendorAuditPassed: undefined,
        auditRoutingReason: undefined,
        auditDegradedReason: undefined,
        updatedAt: now,
      };
      const reboundTask: PersistedSupervisionTaskRecord = {
        ...task,
        currentRevision: toRevision,
        status: 'implementing',
        blocker: undefined,
        updatedAt: now,
      };
      // Atomic with the successor bind: retire each stale auditor in the SAME
      // transaction. Provenance is preserved exactly -- auditAttemptId,
      // auditRevision and identity are untouched, the assignment is never
      // rebound onto the successor revision, and no verdict is written. On
      // rollback every one of them keeps its original status and authority.
      for (const staleAuditor of (auditorSelection.ok ? auditorSelection.superseded : [])) {
        this.#writeAssignment({
          ...staleAuditor,
          status: 'cancelled',
          leaseId: '',
          blocker: JSON.stringify({
            supersededBySuccessorRevision: true,
            supersededRevision: staleAuditor.auditRevision,
            supersededAttemptId: staleAuditor.auditAttemptId,
            successorRevision: toRevision,
          }),
          updatedAt: now,
        }, 'cancelled', {
          source: 'brain_authorized_revision_rebind',
          supersededBySuccessorRevision: true,
          successorRevision: toRevision,
        });
      }
      this.#writeAssignment(reboundAssignment, 'recovered', payload);
      this.#writeTask(reboundTask, 'recovered', { ...payload, assignmentId });
      this.#db.exec('COMMIT');
      return { ok: true, value: reboundTask };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Authoritative project-Brain repair for a wedged coordination shape.
   *
   * This deliberately bypasses the ordinary forward-only transition table,
   * but only into non-success recovery states. Audit receipts and historical
   * events remain append-only; PASS/finalization/Git evidence can never be
   * manufactured through this path.
   */
  coordinateTaskAssignment(input: {
    taskId: string;
    assignmentId: string;
    taskStatus?: SupervisionBrainCoordinationRecoveryStatus;
    assignmentStatus?: SupervisionBrainCoordinationRecoveryStatus;
    scopeFiles?: readonly string[];
    leaseAction: SupervisionRecoveryLeaseAction;
    identity?: PersistedSupervisionTaskAssignmentIdentity;
    idempotencyKey: string;
    reason: string;
    now?: number;
  }): SupervisionTaskRegistryResult<PersistedSupervisionTaskRecord> {
    const taskId = normalizeTaskString(input.taskId);
    const assignmentId = normalizeTaskString(input.assignmentId);
    const idempotencyKey = normalizeTaskString(input.idempotencyKey);
    const reason = normalizeTaskString(input.reason);
    const taskStatus = input.taskStatus;
    const assignmentStatus = input.assignmentStatus;
    const scopeFiles = input.scopeFiles === undefined
      ? undefined
      : normalizeTaskArray(input.scopeFiles).filter(validRepoPath);
    const allowedStatuses = SUPERVISION_BRAIN_COORDINATION_RECOVERY_STATUSES as readonly string[];
    const validIdentity = input.identity === undefined || [
      input.identity.sessionName,
      input.identity.sessionInstanceId,
      input.identity.runtimeEpoch,
      input.identity.agentType,
      input.identity.providerFamily,
    ].every((value) => Boolean(normalizeTaskString(value)));
    if (!taskId || !assignmentId || !idempotencyKey || !reason
      || (!taskStatus && !assignmentStatus && scopeFiles === undefined
        && input.leaseAction === 'preserve' && input.identity === undefined)
      || (taskStatus !== undefined && !allowedStatuses.includes(taskStatus))
      || (assignmentStatus !== undefined && !allowedStatuses.includes(assignmentStatus))
      || !SUPERVISION_RECOVERY_LEASE_ACTIONS.includes(input.leaseAction)
      || !validIdentity) {
      return { ok: false, reason: 'invalid' };
    }

    const now = input.now ?? Date.now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.getTaskRecord(taskId);
      const assignment = this.getAssignment(assignmentId);
      if (!task || !assignment || assignment.taskId !== taskId) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'not_found' };
      }
      const assignments = this.listAssignments(taskId);
      const consumedByFinalization = this.#assignmentConsumedByFinalization(task, assignment);
      const openSuccessorImplementers = assignments.filter((candidate) => (
        candidate.required
        && candidate.role === 'implementer'
        && !isTerminalSupervisionTaskStatus(candidate.status)
        && !this.#assignmentConsumedByFinalization(task, candidate)
      ));
      const openCoordinators = assignments.filter((candidate) => (
        candidate.role === 'coordinator'
        && !isTerminalSupervisionTaskStatus(candidate.status)
      ));
      const exactActiveSuccessor = assignment.role === 'implementer'
        && assignment.required
        && openSuccessorImplementers.length === 1
        && openSuccessorImplementers[0]?.assignmentId === assignmentId;
      const exactActiveCoordinator = assignment.role === 'coordinator'
        && openCoordinators.length === 1
        && openCoordinators[0]?.assignmentId === assignmentId;
      const closedEvidencePresent = Boolean(
        task.finalization || task.commitSha || task.pushRemoteRef || task.archivedAt,
      );
      const consistentFinalizationAnchor = Boolean(
        task.finalization
        && task.currentRevision === task.finalization.revision
        && task.commitSha === task.finalization.commitSha
        && task.pushRemoteRef === task.finalization.pushRemoteRef
        && task.finalization.auditRevision === task.finalization.revision,
      );
      if (closedEvidencePresent && assignment.role === 'implementer'
        && !consumedByFinalization && openSuccessorImplementers.length > 1) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'ambiguous_assignment' };
      }
      // Finalization closes the evidence it names; it does not close the task's
      // control plane forever. Brain may repair exactly one active successor or
      // coordinator while every receipt/finalization/Git/CI byte remains
      // untouched. Historical consumed owners and genuine ambiguity remain
      // fail-closed.
      if (closedEvidencePresent
        && (!consistentFinalizationAnchor || (!exactActiveSuccessor && !exactActiveCoordinator))) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'receipt_closed' };
      }
      if (assignment.role === 'auditor' && assignmentStatus !== undefined) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'role_forbidden' };
      }

      const nextAssignmentStatus = assignmentStatus ?? assignment.status;
      const repairsControlState = taskStatus !== undefined
        || assignmentStatus !== undefined
        || input.leaseAction !== 'preserve'
        || input.identity !== undefined;
      // A lease-only recovery must never erase revision/audit provenance just
      // because the assignment is already implementing or rework. Clearing is
      // tied to an explicit lifecycle reset, not the assignment's current row.
      const resetsAudit = assignmentStatus !== undefined
        && (assignmentStatus === 'implementing' || assignmentStatus === 'rework');
      const priorEvents = this.listEvents(taskId).filter((event) => (
        event.eventType === 'recovered'
        && event.payload?.source === 'brain_coordination_override'
        && event.payload?.idempotencyKey === idempotencyKey
      ));
      const exactReplay = priorEvents.find((event) => (
        event.assignmentId === assignmentId
        && event.payload?.requestedTaskStatus === (taskStatus ?? null)
        && event.payload?.requestedAssignmentStatus === (assignmentStatus ?? null)
        && event.payload?.requestedLeaseAction === input.leaseAction
        && event.payload?.reason === reason
        && JSON.stringify(event.payload?.requestedIdentity ?? null) === JSON.stringify(input.identity ?? null)
      ));
      if (priorEvents.length > 0) {
        this.#db.exec('ROLLBACK');
        return exactReplay
          ? { ok: true, value: task, replay: true }
          : { ok: false, reason: 'conflicting_replay' };
      }

      const nextAssignment: PersistedSupervisionTaskAssignment = {
        ...assignment,
        identity: input.identity ?? assignment.identity,
        status: nextAssignmentStatus,
        scopeFiles: scopeFiles ?? assignment.scopeFiles,
        leaseId: input.leaseAction === 'renew' ? this.#mintLeaseId()
          : input.leaseAction === 'clear' ? '' : assignment.leaseId,
        generation: assignment.generation + 1,
        ...(resetsAudit ? {
          auditAttemptId: undefined,
          auditRevision: undefined,
          verdict: undefined,
          externalRunId: undefined,
          externalHeadSha: undefined,
          externalTaskId: undefined,
          primaryReviewPassed: undefined,
          crossVendorAuditPassed: undefined,
          auditRoutingReason: undefined,
          auditDegradedReason: undefined,
        } : {}),
        blocker: repairsControlState ? reason : assignment.blocker,
        updatedAt: now,
      };
      const nextTask: PersistedSupervisionTaskRecord = {
        ...task,
        status: taskStatus ?? task.status,
        blocker: repairsControlState ? reason : task.blocker,
        updatedAt: repairsControlState ? now : task.updatedAt,
      };
      const payload = {
        source: 'brain_coordination_override',
        idempotencyKey,
        reason,
        requestedTaskStatus: taskStatus ?? null,
        requestedAssignmentStatus: assignmentStatus ?? null,
        requestedScopeFiles: scopeFiles ?? null,
        requestedLeaseAction: input.leaseAction,
        requestedIdentity: input.identity ?? null,
        taskStatus: nextTask.status,
        assignmentStatus: nextAssignment.status,
        scopeFiles: nextAssignment.scopeFiles,
        leaseAction: input.leaseAction,
        ...(input.identity ? { identity: input.identity, priorIdentity: assignment.identity } : {}),
        priorTaskStatus: task.status,
        priorAssignmentStatus: assignment.status,
        priorScopeFiles: assignment.scopeFiles,
        preservedRevision: task.currentRevision,
      };
      this.#writeAssignment(nextAssignment, 'recovered', payload);
      if (repairsControlState) {
        this.#writeTask(nextTask, 'recovered', { ...payload, assignmentId });
      }
      this.#db.exec('COMMIT');
      return { ok: true, value: nextTask };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Append a daemon-authenticated audit receipt without bearer authority.
   *
   * Validation and identity binding happen before BEGIN IMMEDIATE, so a schema
   * or authority failure cannot mutate/close the channel. Receipt rows are
   * immutable. A corrected final supersedes the prior final by id while
   * retaining both rows. The auditor assignment remains in `auditing` until
   * its owner explicitly finishes it; only that FINISHED edge may release the
   * audited assignment to integration.
   */
  appendMatchingAuditReceipt(
    input: Required<Pick<SupervisionMatchingAuditReceiptInput,
      'taskId' | 'auditorAssignmentId' | 'attemptId' | 'revision' | 'receiptKind' | 'auditorIdentity'>>
      & Omit<SupervisionMatchingAuditReceiptInput,
        'taskId' | 'auditorAssignmentId' | 'attemptId' | 'revision' | 'receiptKind' | 'auditorIdentity'>,
  ): SupervisionTaskRegistryResult<PersistedSupervisionAuditReceipt> {
    if (this.#closed) return { ok: false, reason: 'invalid' };
    const taskId = normalizeTaskString(input.taskId);
    const assignmentId = normalizeTaskString(input.auditorAssignmentId);
    const attemptId = normalizeTaskString(input.attemptId);
    const revision = normalizeTaskString(input.revision);
    const findings = input.findings ?? '';
    const validations = [...(input.validations ?? [])];
    if (!taskId || !assignmentId || !attemptId || !revision
      || (input.receiptKind !== 'progress' && input.receiptKind !== 'final')
      || (input.receiptKind === 'progress' && input.verdict !== undefined)) {
      return { ok: false, reason: 'invalid' };
    }
    const task = this.getTaskRecord(taskId);
    let audit = this.getAssignment(assignmentId);
    // An open, non-terminal auditor whose runtime restarted mid-round presents a
    // rotated instance/epoch. Converge it on the same rule as every other
    // boundary BEFORE evaluating receipt authority, so a live round can be
    // resumed on its exact attempt/revision. Terminal auditors are refused by
    // the rule itself, so a closed round can never be reopened this way.
    if (audit) {
      const authorizedAuditor = this.#authorizeParticipant(audit, input.auditorIdentity);
      if (authorizedAuditor
        && (authorizedAuditor.sessionInstanceId !== audit.identity.sessionInstanceId
          || authorizedAuditor.runtimeEpoch !== audit.identity.runtimeEpoch)) {
        this.#writeAssignment(
          { ...audit, identity: authorizedAuditor, updatedAt: Date.now() },
          this.#taskEventFor(audit.status),
          { source: 'identity_convergence', previousRuntimeEpoch: audit.identity.runtimeEpoch },
        );
        audit = this.getAssignment(assignmentId);
      }
    }
    const preAuthority = evaluateAuditReceiptAuthority({
      task, audit, taskId, assignmentId, attemptId, revision,
      receiptKind: input.receiptKind,
      ...(input.verdict ? { verdict: input.verdict } : {}),
      auditorIdentity: input.auditorIdentity,
      auditorSessionName: input.auditorSessionName,
    });
    if (!preAuthority.ok) return { ok: false, reason: preAuthority.reason };
    const digest = auditReceiptDigest({
      taskId, assignmentId, attemptId, revision,
      receiptKind: input.receiptKind,
      ...(input.verdict ? { verdict: input.verdict } : {}),
      findings,
      validations,
    });
    const now = input.now ?? Date.now();
    const receiptId = `supervision_audit_receipt_${randomUUID()}`;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      // Re-read under the write lock. Validation remains non-consuming, while
      // sequence allocation, replay detection, closure, and insertion are one
      // restart-safe exactly-once transaction across daemon connections.
      const lockedTask = this.getTaskRecord(taskId);
      const lockedAudit = this.getAssignment(assignmentId);
      if (!lockedTask || !lockedAudit || lockedAudit.taskId !== taskId || lockedAudit.role !== 'auditor') {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'not_found' };
      }
      const lockedAuthority = evaluateAuditReceiptAuthority({
        task: lockedTask, audit: lockedAudit, taskId, assignmentId, attemptId, revision,
        receiptKind: input.receiptKind,
        ...(input.verdict ? { verdict: input.verdict } : {}),
        auditorIdentity: input.auditorIdentity,
        auditorSessionName: input.auditorSessionName,
      });
      if (!lockedAuthority.ok) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: lockedAuthority.reason };
      }
      const existingDigest = this.#db.prepare(`
        SELECT receipt_id AS receiptId FROM supervision_audit_receipts
        WHERE assignment_id = ? AND attempt_id = ? AND revision = ? AND receipt_digest = ?
      `).get(assignmentId, attemptId, revision, digest) as { receiptId?: unknown } | undefined;
      if (typeof existingDigest?.receiptId === 'string') {
        const replay = this.listAuditReceipts(taskId).find((receipt) => receipt.receiptId === existingDigest.receiptId);
        this.#db.exec('COMMIT');
        return replay ? { ok: true, value: replay, replay: true } : { ok: false, reason: 'not_found' };
      }
      if (['finalized', 'cancelled', 'committed', 'pushed'].includes(lockedAudit.status)
        || ['committed', 'pushed', 'finalized'].includes(lockedTask.status)) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'receipt_closed' };
      }
      const next = this.#db.prepare(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
        FROM supervision_audit_receipts
        WHERE assignment_id = ? AND attempt_id = ? AND revision = ?
      `).get(assignmentId, attemptId, revision) as { sequence?: unknown } | undefined;
      const sequence = Number(next?.sequence ?? 1);
      const priorFinal = input.receiptKind === 'final'
        ? this.#db.prepare(`
            SELECT receipt_id AS receiptId FROM supervision_audit_receipts
            WHERE assignment_id = ? AND attempt_id = ? AND revision = ? AND receipt_kind = 'final'
            ORDER BY sequence DESC LIMIT 1
          `).get(assignmentId, attemptId, revision) as { receiptId?: unknown } | undefined
        : undefined;
      const supersedesReceiptId = typeof priorFinal?.receiptId === 'string' ? priorFinal.receiptId : undefined;
      this.#db.prepare(`
        INSERT INTO supervision_audit_receipts (
          receipt_id, task_id, assignment_id, attempt_id, revision, sequence,
          receipt_kind, verdict, findings, validations_json, receipt_digest,
          supersedes_receipt_id, sender_identity_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        receiptId, taskId, assignmentId, attemptId, revision, sequence,
        input.receiptKind, input.verdict ?? null, findings, JSON.stringify(validations), digest,
        supersedesReceiptId ?? null, JSON.stringify(input.auditorIdentity), now,
      );
      const nextAudit: PersistedSupervisionTaskAssignment = {
        ...lockedAudit,
        status: lockedAudit.status === 'delegated' || lockedAudit.status === 'ready_for_audit' ? 'auditing' : lockedAudit.status,
        ...(input.receiptKind === 'final' ? {
          verdict: input.verdict,
          blocker: input.verdict === 'REWORK' ? normalizeTaskString(findings) : undefined,
        } : {}),
        updatedAt: now,
      };
      this.#writeAssignment(nextAudit, 'audit_replied', {
        source: 'authenticated_audit_receipt', receiptId, sequence,
        receiptKind: input.receiptKind,
        ...(input.verdict ? { verdict: input.verdict } : {}),
        ...(supersedesReceiptId ? { supersedesReceiptId } : {}),
      });
      this.#db.exec('COMMIT');
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
    const receipt = this.listAuditReceipts(taskId).find((item) => item.receiptId === receiptId);
    return receipt ? { ok: true, value: receipt } : { ok: false, reason: 'not_found' };
  }

  /**
   * Persist a legacy controller-bound, revision-matching peer-audit receipt.
   *
   * This is the authority bridge the old implementation lacked: the audit
   * controller could report PASS while the registry assignment remained
   * `delegated` forever. The receipt locates its auditor assignment by the
   * daemon-minted attempt id, binds the audited live session and exact revision,
   * records one durable attestation, and advances the audited assignment through
   * every legal lifecycle edge. UI code never derives or guesses this state.
   */
  applyMatchingAuditReceipt(
    input: SupervisionMatchingAuditReceiptInput & { verdict: PeerAuditVerdict },
  ): SupervisionTaskRegistryResult<PersistedSupervisionTaskAssignment> {
    if (this.#closed) return { ok: false, reason: 'invalid' };
    const attemptId = normalizeTaskString(input.attemptId);
    const revision = normalizeTaskString(input.revision);
    const auditedSessionName = normalizeTaskString(input.auditedSessionName);
    const auditorSessionName = normalizeTaskString(input.auditorSessionName);
    if (!attemptId || !revision || !auditedSessionName || !auditorSessionName) {
      return { ok: false, reason: 'invalid' };
    }
    const auditRows = this.#db.prepare(
      'SELECT assignment_id AS assignmentId FROM supervision_task_assignments WHERE audit_attempt_id = ? AND role = \'auditor\'',
    ).all(attemptId) as Array<{ assignmentId?: unknown }>;
    if (auditRows.length === 0) return { ok: false, reason: 'not_found' };
    if (auditRows.length !== 1 || typeof auditRows[0]?.assignmentId !== 'string') {
      return { ok: false, reason: 'ambiguous_assignment' };
    }
    const auditAssignment = this.getAssignment(auditRows[0].assignmentId);
    if (!auditAssignment || auditAssignment.role !== 'auditor'
      || auditAssignment.identity.sessionName !== auditorSessionName) {
      return { ok: false, reason: 'owner_mismatch' };
    }
    const task = this.getTaskRecord(auditAssignment.taskId);
    if (!task) return { ok: false, reason: 'not_found' };
    const sameSessionAssignments = this.listAssignments(task.taskId).filter((assignment) => (
      assignment.role !== 'auditor'
      && assignment.identity.sessionName === auditedSessionName
    ));
    const pendingCandidates = sameSessionAssignments.filter((assignment) => (
      AUDIT_RECEIPT_PENDING_TARGET_STATUSES.has(assignment.status)
    ));
    const exactCandidates = sameSessionAssignments.filter((assignment) => (
      isExactAuditReceiptTarget(assignment, attemptId, revision)
    ));
    const legacyTransitionCandidates = sameSessionAssignments.filter((assignment) => (
      assignment.status in AUDIT_RECEIPT_TO_AUDITING
    ));
    // Prefer assignments already in the audit phase. If none exists, an exact
    // receipt-bound replay wins. The final fallback preserves the historic
    // single-delegated Quick Audit path, but multiple such rows remain
    // ambiguous rather than being selected by creation order.
    const candidates = pendingCandidates.length > 0
      ? pendingCandidates
      : exactCandidates.length > 0
        ? exactCandidates
        : legacyTransitionCandidates;
    if (candidates.length === 0) return { ok: false, reason: 'not_found' };
    if (candidates.length !== 1) return { ok: false, reason: 'ambiguous_assignment' };
    const target = candidates[0]!;
    const taskRevision = normalizeTaskString(task.currentRevision);
    if (auditAssignment.auditRevision !== revision
      || (target.auditRevision !== undefined && target.auditRevision !== revision)
      || (taskRevision !== undefined && taskRevision !== revision)) {
      return { ok: false, reason: 'old_revision' };
    }
    if (target.executionBinding?.pool === 'economy' && target.primaryReviewPassed !== true) {
      return { ok: false, reason: 'economy_requires_primary_review' };
    }

    const attestation = this.#db.prepare(
      'SELECT task_id AS taskId, assignment_id AS assignmentId, revision, verdict FROM supervision_audit_attestations WHERE attempt_id = ?',
    ).get(attemptId) as Record<string, unknown> | undefined;
    if (attestation) {
      if (attestation.taskId !== task.taskId || attestation.assignmentId !== target.assignmentId
        || attestation.revision !== revision || attestation.verdict !== input.verdict) {
        return { ok: false, reason: 'old_audit_attempt' };
      }
      const replay = this.getAssignment(target.assignmentId);
      return replay ? { ok: true, value: replay, replay: true } : { ok: false, reason: 'not_found' };
    }

    const now = input.now ?? Date.now();
    const transition = (
      assignment: PersistedSupervisionTaskAssignment,
      terminal: 'passed' | 'ready_for_integration' | 'rework',
    ): PersistedSupervisionTaskAssignment | undefined => {
      let current = assignment;
      const steps = [...(AUDIT_RECEIPT_TO_AUDITING[current.status] ?? [])];
      if (terminal === 'ready_for_integration') {
        if (current.status === 'passed') steps.push('ready_for_integration');
        else if (current.status !== 'ready_for_integration') steps.push('passed', 'ready_for_integration');
      } else if (current.status !== terminal) {
        steps.push(terminal);
      }
      for (const status of steps) {
        if (!canTransitionSupervisionTaskStatus(current.status, status)) return undefined;
        current = {
          ...current,
          status,
          auditAttemptId: attemptId,
          auditRevision: revision,
          verdict: input.verdict,
          ...(input.verdict === 'PASS' ? { crossVendorAuditPassed: true } : {}),
          blocker: status === 'rework' ? normalizeTaskString(input.findings) : undefined,
          updatedAt: now,
        };
        const eventType = status === 'auditing' ? 'audit_requested'
          : status === 'passed' || status === 'rework' ? 'audit_replied'
            : status;
        this.#writeAssignment(current, eventType as SupervisionTaskRegistryEventType, {
          source: 'matching_audit_receipt', attemptId, revision,
        });
      }
      return current;
    };

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      if (taskRevision === undefined) {
        this.#writeTask({ ...task, currentRevision: revision, updatedAt: now }, this.#taskEventFor(task.status), {
          source: 'matching_audit_receipt',
          attemptId,
          revisionBound: true,
        });
      }
      const audited = transition(target, input.verdict === 'PASS' ? 'ready_for_integration' : 'rework');
      const audit = transition(auditAssignment, input.verdict === 'PASS' ? 'passed' : 'rework');
      if (!audited || !audit) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'invalid_transition' };
      }
      this.#db.prepare(
        `INSERT INTO supervision_audit_attestations
          (attempt_id, task_id, assignment_id, revision, verdict, auditor_session_name, findings, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(attemptId, task.taskId, audited.assignmentId, revision, input.verdict,
        auditorSessionName, normalizeTaskString(input.findings) ?? null, now);
      this.#deriveTaskStatus(task.taskId, now);
      this.#db.exec('COMMIT');
      return { ok: true, value: audited };
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  #deriveTaskStatus(taskId: string, now: number): void {
    const task = this.getTaskRecord(taskId);
    if (!task) return;
    const assignments = this.listAssignments(taskId);
    const reworkProjectionRepair = this.#planReworkProjectionRepair(task, assignments);
    if (reworkProjectionRepair) {
      this.#applyHousekeepingAction(reworkProjectionRepair, now);
      return;
    }
    // Pre-integration aggregate authority belongs to required implementers.
    // A coordinator is an observer/orchestrator and an auditor is represented
    // by its authenticated receipt; stale rows in either role must not hold an
    // otherwise matching implementation PASS at ready_for_audit forever.
    const requiredImplementers = assignments.filter((assignment) => (
      assignment.required && assignment.role === 'implementer' && assignment.status !== 'cancelled'
    ));
    const required = requiredImplementers.length > 0
      ? requiredImplementers
      : assignments.filter((assignment) => (
          assignment.required && assignment.role === 'integration_owner' && assignment.status !== 'cancelled'
        ));
    if (required.length === 0) return;
    const next = required.every((assignment) => assignment.status === 'finalized')
      ? 'finalized'
      : required.every((assignment) => assignment.status === 'recovered' || assignment.status === 'finalized')
        ? 'recovered'
        : required.every((assignment) => assignment.status === 'ready_for_integration' || assignment.status === 'passed')
          ? 'ready_for_integration'
          : requiredImplementers.length === 0
              && required.every((assignment) => assignment.status === 'ready_for_audit')
            ? 'ready_for_audit'
            : required.some((assignment) => assignment.status === 'rework')
              ? 'rework'
              : required.some((assignment) => assignment.status === 'blocked')
                ? 'blocked'
                : required.some((assignment) => assignment.status === 'retrying_external_ci')
                  ? 'retrying_external_ci'
                  : task.status;
    if (next !== task.status && canTransitionSupervisionTaskStatus(task.status, next)) {
      const aggregateEvent = next === 'ready_for_integration' ? 'ready_for_integration'
        : next === 'ready_for_audit' ? 'ready_for_audit'
        : next === 'rework' ? 'rework'
          : next === 'blocked' ? 'blocked'
            : next === 'retrying_external_ci' ? 'retrying_external_ci'
              : next === 'recovered' ? 'recovered'
                : next === 'finalized' ? 'finalized'
                  : 'validated';
      this.#writeTask({ ...task, status: next, updatedAt: now }, aggregateEvent, { source: 'aggregate_status' });
    }
  }

  /**
   * Recognise only the exact durable split left after a REWORK auditor is
   * assignment-scoped cancelled. This is intentionally narrower than generic
   * aggregate derivation: ready_for_audit -> rework is a recovery edge, not a
   * normal lifecycle transition.
   */
  #planReworkProjectionRepair(
    task: PersistedSupervisionTaskRecord,
    assignments: readonly PersistedSupervisionTaskAssignment[],
  ): SupervisionHousekeepingAction | undefined {
    if (!['validated', 'ready_for_audit', 'rework'].includes(task.status)) return undefined;
    const activeImplementers = assignments.filter((assignment) => (
      assignment.required
      && assignment.role === 'implementer'
      && assignment.status !== 'cancelled'
      && assignment.status !== 'finalized'
    ));
    if (activeImplementers.length !== 1) return undefined;
    const owner = activeImplementers[0]!;
    const revision = normalizeTaskString(owner.auditRevision);
    const attemptId = normalizeTaskString(owner.auditAttemptId);
    if (owner.status !== 'rework'
      || owner.verdict?.trim().toUpperCase() !== 'REWORK'
      || !revision
      || !attemptId) return undefined;

    const activeAuditor = assignments.some((assignment) => (
      assignment.role === 'auditor'
      && assignment.status !== 'cancelled'
      && assignment.status !== 'finalized'
    ));
    if (activeAuditor) return undefined;
    const retiredMatches = assignments.filter((assignment) => (
      assignment.role === 'auditor'
      && (assignment.status === 'cancelled' || assignment.status === 'finalized')
      && !assignment.leaseId
      && assignment.auditAttemptId === attemptId
      && assignment.auditRevision === revision
      && assignment.verdict?.trim().toUpperCase() === 'REWORK'
    ));
    if (retiredMatches.length !== 1) return undefined;
    const exactReworkReceipts = this.listAuditReceipts(task.taskId).filter((receipt) => (
      receipt.assignmentId === retiredMatches[0]!.assignmentId
      && receipt.attemptId === attemptId
      && receipt.revision === revision
      && receipt.receiptKind === 'final'
      && receipt.verdict === 'REWORK'
    ));
    if (exactReworkReceipts.length !== 1) return undefined;

    const assignmentPass = assignments.some((assignment) => (
      assignment.auditRevision === revision
      && assignment.verdict?.trim().toUpperCase() === 'PASS'
    ));
    const attestedPass = this.#db.prepare(
      `SELECT 1 AS ok FROM supervision_audit_attestations
       WHERE task_id = ? AND revision = ? AND UPPER(TRIM(verdict)) = 'PASS' LIMIT 1`,
    ).get(task.taskId, revision) as { ok?: number } | undefined;
    const receiptPass = this.#db.prepare(
      `SELECT 1 AS ok FROM supervision_audit_receipts
       WHERE task_id = ? AND revision = ? AND receipt_kind = 'final'
         AND UPPER(TRIM(verdict)) = 'PASS' LIMIT 1`,
    ).get(task.taskId, revision) as { ok?: number } | undefined;
    if (assignmentPass || attestedPass?.ok === 1 || receiptPass?.ok === 1) return undefined;

    const fromRevision = normalizeTaskString(task.currentRevision);
    if (task.status === 'rework' && fromRevision === revision) return undefined;
    return {
      taskId: task.taskId,
      kind: fromRevision === revision ? 'repair_aggregate' : 'repair_revision',
      assignmentId: owner.assignmentId,
      fromStatus: task.status,
      toStatus: 'rework',
      ...(fromRevision ? { fromRevision } : {}),
      toRevision: revision,
    };
  }

  /**
   * Event id used when a TASK-level status is written directly.
   *
   * Three statuses have no distinct member in the event vocabulary, so they
   * share the closest one. That is not lossy: #writeTask records the exact
   * status on the record itself, and the payload carries it too. Adding event
   * members is an explicit contract-version migration, not something to do
   * inline here.
   */
  #taskEventFor(status: SupervisionTaskLifecycleStatus): SupervisionTaskRegistryEventType {
    switch (status) {
      case 'planned': return 'created';
      case 'auditing': return 'audit_requested';
      case 'final_audit': return 'audit_requested';
      case 'integrating': return 'ready_for_integration';
      default: return status as SupervisionTaskRegistryEventType;
    }
  }

  /**
   * A stale task projection must not let an intent revoke an already accepted
   * integration round. The generic intent transition is intentionally unable
   * to manufacture PASS authority, so this recovery is anchored to the exact
   * integration owner, final receipt and closed cross-vendor auditor that are
   * already durable for the task's current revision.
   *
   * This is deliberately narrower than aggregate derivation: it only handles
   * the non-demoting intent replay, never selects a different revision/attempt,
   * never creates an owner, and refuses ambiguous or conflicting Git state.
   */
  #resolvePassAuthorizedIntegration(
    task: PersistedSupervisionTaskRecord,
  ): {
    kind: 'authorized';
    owner: PersistedSupervisionTaskAssignment;
    revision: string;
    attemptId: string;
  } | { kind: 'conflict'; reason: 'ambiguous_assignment' | 'manifest_mismatch' } | undefined {
    if (task.finalization
      || !['implementing', 'recovered', 'passed', 'ready_for_integration'].includes(task.status)) {
      return undefined;
    }
    const revision = normalizeTaskString(task.currentRevision);
    if (!revision) return undefined;
    const assignments = this.listAssignments(task.taskId);
    const liveOwners = assignments.filter((assignment) => (
      assignment.role === 'integration_owner'
      && assignment.required
      && ['implementing', 'passed', 'ready_for_integration'].includes(assignment.status)
    ));
    if (liveOwners.length !== 1) {
      return liveOwners.length > 1 ? { kind: 'conflict', reason: 'ambiguous_assignment' } : undefined;
    }
    const owner = liveOwners[0]!;
    if (owner.assignmentId !== task.integrationOwnerAssignmentId
      || owner.auditRevision !== revision
      || !owner.auditAttemptId
      || owner.verdict?.trim().toUpperCase() !== 'PASS'
      || owner.crossVendorAuditPassed !== true) return undefined;

    const requiredLineage = assignments.filter((assignment) => (
      assignment.required
      && (assignment.role === 'implementer' || assignment.role === 'integration_owner')
      && assignment.status !== 'cancelled'
      && assignment.status !== 'recovered'
    ));
    if (requiredLineage.length === 0 || requiredLineage.some((assignment) => (
      assignment.auditRevision !== revision
      || assignment.auditAttemptId !== owner.auditAttemptId
      || assignment.verdict?.trim().toUpperCase() !== 'PASS'
      || assignment.crossVendorAuditPassed !== true
    ))) return undefined;

    const receipts = this.listAuditReceipts(task.taskId).filter((receipt) => (
      receipt.receiptKind === 'final'
      && receipt.verdict === 'PASS'
      && receipt.revision === revision
      && receipt.attemptId === owner.auditAttemptId
    ));
    if (receipts.length !== 1) return undefined;
    const auditor = assignments.find((assignment) => assignment.assignmentId === receipts[0]!.assignmentId);
    if (!auditor || auditor.role !== 'auditor' || auditor.status !== 'finalized'
      || auditor.leaseId || auditor.auditRevision !== revision
      || auditor.auditAttemptId !== owner.auditAttemptId
      || auditor.verdict?.trim().toUpperCase() !== 'PASS'
      || auditor.identity.providerFamily === owner.identity.providerFamily) return undefined;

    const hasCommit = Boolean(task.commitSha);
    const hasPush = Boolean(task.pushRemoteRef);
    if (hasCommit !== hasPush
      || (task.commitSha && !FINALIZATION_COMMIT_RE.test(task.commitSha))
      || (task.pushRemoteRef && !task.pushRemoteRef.startsWith('refs/'))
      || (owner.externalHeadSha && task.commitSha && owner.externalHeadSha !== task.commitSha)) {
      return { kind: 'conflict', reason: 'manifest_mismatch' };
    }
    return { kind: 'authorized', owner, revision, attemptId: owner.auditAttemptId };
  }

  #convergePassAuthorizedIntegrationIntent(
    task: PersistedSupervisionTaskRecord,
    input: { intent: string; toStatus: SupervisionTaskLifecycleStatus | null },
  ): SupervisionTaskRegistryResult<PersistedSupervisionTaskRecord> | undefined {
    if (!['start', 'heartbeat', 'checkpoint'].includes(input.intent)
      || (input.intent === 'start' && input.toStatus !== 'implementing')
      || (input.intent !== 'start' && input.toStatus !== null)
    ) {
      return undefined;
    }
    const plan = this.#resolvePassAuthorizedIntegration(task);
    if (!plan) return undefined;
    if (plan.kind === 'conflict') return { ok: false, reason: plan.reason };
    const { owner, revision, attemptId } = plan;

    if (task.status === 'ready_for_integration' && owner.status === 'ready_for_integration') {
      // Ordinary heartbeat/checkpoint handling still owns its observability
      // event. Only start is a true replay when the accepted projection is
      // already coherent.
      return input.intent === 'start' ? { ok: true, value: task, replay: true } : undefined;
    }
    const now = Date.now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const lockedTask = this.getTaskRecord(task.taskId);
      const lockedPlan = lockedTask ? this.#resolvePassAuthorizedIntegration(lockedTask) : undefined;
      if (!lockedTask || !lockedPlan || lockedPlan.kind !== 'authorized'
        || lockedPlan.owner.assignmentId !== owner.assignmentId
        || lockedPlan.revision !== revision || lockedPlan.attemptId !== attemptId) {
        this.#db.exec('ROLLBACK');
        return lockedPlan?.kind === 'conflict'
          ? { ok: false, reason: lockedPlan.reason }
          : { ok: false, reason: 'conflicting_replay' };
      }
      const lockedOwner = lockedPlan.owner;
      if (input.intent === 'heartbeat') {
        if (lockedOwner.status === 'ready_for_integration') {
          this.#appendEvent(task.taskId, lockedOwner.assignmentId, 'implementation_heartbeat',
            lockedOwner.status, {
              source: 'pass_authorized_integration_intent_replay',
              substantiveProgress: false,
            }, now);
          this.#recordAssignmentHeartbeat(lockedOwner, now);
        } else {
          this.#writeAssignment({
            ...lockedOwner,
            status: 'ready_for_integration',
            heartbeatAt: now,
            blocker: undefined,
            updatedAt: now,
          }, 'implementation_heartbeat', {
            source: 'pass_authorized_integration_intent_replay',
            substantiveProgress: false,
            revision,
            auditAttemptId: attemptId,
          });
        }
      } else if (input.intent === 'checkpoint') {
        this.#writeAssignment({
          ...lockedOwner,
          status: 'ready_for_integration',
          blocker: undefined,
          updatedAt: now,
        }, 'implementation_progress', {
          source: 'pass_authorized_integration_intent_replay',
          substantiveProgress: true,
          revision,
          auditAttemptId: attemptId,
        });
      } else if (lockedOwner.status !== 'ready_for_integration') {
        this.#writeAssignment({
          ...lockedOwner,
          status: 'ready_for_integration',
          blocker: undefined,
          updatedAt: now,
        }, 'ready_for_integration', {
          source: 'pass_authorized_integration_intent_replay',
          revision,
          auditAttemptId: attemptId,
        });
      }
      const repaired: PersistedSupervisionTaskRecord = {
        ...lockedTask,
        status: 'ready_for_integration',
        blocker: undefined,
        updatedAt: now,
      };
      this.#writeTask(repaired, 'ready_for_integration', {
        source: 'pass_authorized_integration_intent_replay',
        integrationOwnerAssignmentId: owner.assignmentId,
        revision,
        auditAttemptId: attemptId,
      });
      this.#db.exec('COMMIT');
      return { ok: true, value: repaired };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Persist a task-level status DECIDED by the audited intent state machine.
   *
   * Validation deliberately lives in the caller: resolveSupervisionIntent() owns
   * the transition table and the status-rejection rules, and the MCP handler
   * owns authorization. Re-deriving either here would be a second copy of the
   * same policy that could drift, and the two would mask each other's bugs.
   * This records what was decided, with an event, in one write.
   */
  applyTaskIntent(input: {
    taskId: string;
    assignmentId?: string;
    intent: string;
    toStatus: SupervisionTaskLifecycleStatus | null;
    validationState?: string;
    note?: string;
    /**
     * Caller identity. Optional for backward compatibility, but when supplied
     * it is authorized on the SAME rule as every other boundary. Intents used
     * to accept any caller while task_update refused a restart-rotated one, so
     * `start` could succeed and the very next update fail owner_mismatch.
     */
    identity?: PersistedSupervisionTaskAssignmentIdentity;
  }): SupervisionTaskRegistryResult<PersistedSupervisionTaskRecord> {
    const task = this.getTaskRecord(input.taskId);
    if (!task) return { ok: false, reason: 'not_found' };
    if (input.assignmentId && input.identity) {
      const current = this.getAssignment(input.assignmentId);
      if (current) {
        const authorized = this.#authorizeParticipant(current, input.identity);
        if (!authorized) return { ok: false, reason: 'owner_mismatch' };
        if (!runtimeIdentityMetadataMatches(authorized, current.identity)) {
          // Converge before the intent runs so this intent and every later
          // authorization boundary agree on one identity.
          this.#writeAssignment(
            {
              ...current,
              identity: authorized,
              executionBinding: current.executionBinding ? {
                ...current.executionBinding,
                actual: {
                  ...current.executionBinding.actual,
                  sessionName: authorized.sessionName,
                  sessionInstanceId: authorized.sessionInstanceId,
                  runtimeEpoch: authorized.runtimeEpoch,
                  agentType: authorized.agentType,
                  providerFamily: authorized.providerFamily,
                },
              } : undefined,
              updatedAt: Date.now(),
            },
            this.#taskEventFor(current.status),
            { source: 'identity_convergence', previousRuntimeEpoch: current.identity.runtimeEpoch },
          );
        }
      }
    }
    if (input.intent === 'open_audit' && task.classification === 'integration_slice') {
      // Preserve an idempotent compatibility path for durable auditor rows
      // minted before merge-before-audit became authoritative. New rows are
      // refused by createAssignment(), so this cannot open a fresh slice audit.
      const historicalAudit = this.listAssignments(task.taskId).some((assignment) => (
        assignment.role === 'auditor' && Boolean(assignment.auditAttemptId)
      ));
      if (!historicalAudit) return { ok: false, reason: 'role_forbidden' };
    }
    const preservedIntegration = this.#convergePassAuthorizedIntegrationIntent(task, input);
    if (preservedIntegration) return preservedIntegration;
    if (input.intent === 'cancel' && input.toStatus === 'cancelled' && input.assignmentId) {
      const assignment = this.getAssignment(input.assignmentId);
      if (!assignment || assignment.taskId !== input.taskId) return { ok: false, reason: 'not_found' };
      if (assignment.status === 'finalized' || assignment.status === 'pushed') {
        return { ok: false, reason: 'invalid_transition' };
      }
      const alreadyCancelled = assignment.status === 'cancelled' && !assignment.leaseId;
      if (alreadyCancelled) return { ok: true, value: task, replay: true };

      const now = Date.now();
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        this.#writeAssignment({
          ...assignment,
          status: 'cancelled',
          leaseId: '',
          ...(input.note?.trim() ? { blocker: input.note.trim() } : {}),
          updatedAt: now,
        }, 'cancelled', {
          source: 'assignment_cancel',
          leaseRevoked: true,
        });

        const currentTask = this.getTaskRecord(input.taskId)!;
        if (currentTask.integrationOwnerAssignmentId === assignment.assignmentId) {
          const replacements = this.listAssignments(input.taskId)
            .filter((candidate) => candidate.role === 'integration_owner'
              && candidate.assignmentId !== assignment.assignmentId
              && candidate.status !== 'cancelled')
            .sort((left, right) => right.createdAt - left.createdAt
              || right.assignmentId.localeCompare(left.assignmentId));
          const replacement = replacements[0];
          this.#writeTask({
            ...currentTask,
            integrationOwnerAssignmentId: replacement?.assignmentId,
            updatedAt: now,
          }, this.#taskEventFor(currentTask.status), {
            source: 'assignment_cancel',
            cancelledAssignmentId: assignment.assignmentId,
            ...(replacement ? { replacementIntegrationOwnerAssignmentId: replacement.assignmentId } : {}),
          });
        }
        // A cancelled assignment is retired from the aggregate; it must not
        // erase a replacement owner's completed state or its audit evidence.
        this.#deriveTaskStatus(input.taskId, now);
        this.#db.exec('COMMIT');
        return { ok: true, value: this.getTaskRecord(input.taskId)! };
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      }
    }
    if (input.intent === 'cancel' && input.toStatus === 'cancelled') {
      const now = Date.now();
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        const current = this.getTaskRecord(input.taskId);
        if (!current) {
          this.#db.exec('ROLLBACK');
          return { ok: false, reason: 'not_found' };
        }
        const assignments = this.listAssignments(input.taskId);
        const terminal = new Set<SupervisionTaskLifecycleStatus>(['finalized', 'pushed', 'cancelled']);
        let changed = current.status !== 'cancelled';
        for (const assignment of assignments) {
          const nextStatus = terminal.has(assignment.status) ? assignment.status : 'cancelled';
          if (assignment.leaseId || assignment.status !== nextStatus) {
            changed = true;
            this.#writeAssignment({
              ...assignment,
              status: nextStatus,
              leaseId: '',
              ...(nextStatus === 'cancelled' && input.note?.trim()
                ? { blocker: input.note.trim() }
                : {}),
              updatedAt: now,
            }, 'cancelled', {
              source: 'task_cancel',
              leaseRevoked: true,
              assignmentStatusPreserved: nextStatus !== 'cancelled',
            });
          }
        }
        const record: PersistedSupervisionTaskRecord = changed
          ? { ...current, status: 'cancelled', updatedAt: now }
          : current;
        if (changed) {
          this.#writeTask(record, 'cancelled', {
            source: 'task_intent',
            intent: input.intent,
            status: 'cancelled',
            assignmentsCancelled: assignments.filter((assignment) => !terminal.has(assignment.status)).length,
            ...(input.note ? { note: input.note } : {}),
          });
        }
        this.#db.exec('COMMIT');
        return { ok: true, value: record, ...(changed ? {} : { replay: true }) };
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      }
    }
    const assignment = input.assignmentId ? this.getAssignment(input.assignmentId) : undefined;
    if (input.assignmentId && (!assignment || assignment.taskId !== input.taskId)) {
      return { ok: false, reason: 'not_found' };
    }
    const assignmentTarget: SupervisionTaskLifecycleStatus | null = assignment
      ? input.intent === 'record_validation' && input.validationState === 'passed'
        ? 'validated'
        : input.intent === 'start' || input.intent === 'claim' || input.intent === 'open_audit'
          ? input.toStatus
          : null
      : null;
    // Heartbeat is observability only and MUST NOT refresh the substantive
    // progress clock. Checkpoint is the explicit durable progress edge and is
    // therefore the only no-status intent that updates assignment.updatedAt.
    if (assignment && (input.intent === 'heartbeat' || input.intent === 'checkpoint')) {
      const now = Date.now();
      const eventType = input.intent === 'checkpoint'
        ? 'implementation_progress'
        : 'implementation_heartbeat';
      if (input.intent === 'checkpoint') {
        this.#db.exec('BEGIN IMMEDIATE');
        try {
          this.#writeAssignment({ ...assignment, updatedAt: now }, eventType, {
            source: 'task_intent_assignment_sync',
            substantiveProgress: true,
            ...(input.note ? { note: input.note } : {}),
          });
          this.#deriveTaskStatus(task.taskId, now);
          const repaired = this.getTaskRecord(task.taskId) ?? task;
          this.#db.exec('COMMIT');
          return { ok: true, value: repaired };
        } catch (error) {
          this.#db.exec('ROLLBACK');
          throw error;
        }
      } else {
        this.#appendEvent(task.taskId, assignment.assignmentId, eventType, assignment.status, {
          source: 'task_intent',
          substantiveProgress: false,
          ...(input.note ? { note: input.note } : {}),
        }, now);
        this.#recordAssignmentHeartbeat(assignment, now);
      }
      return { ok: true, value: task };
    }
    const taskChanges = Boolean(input.toStatus && input.toStatus !== task.status);
    const assignmentChanges = Boolean(assignment && assignmentTarget && assignmentTarget !== assignment.status);
    // Heartbeat/checkpoint and an already-applied synchronized intent are true
    // idempotent no-ops.
    // A recorded validation outcome is durable evidence in its own right.
    // `failed` and `unavailable` do not advance status, so without this they
    // would fall into the "nothing changed" replay path and persist nothing,
    // leaving the console reporting 'unknown' despite a real recorded result.
    const validationOutcome = input.intent === 'record_validation' && input.validationState
      ? input.validationState
      : undefined;
    if (!taskChanges && !assignmentChanges && !validationOutcome) {
      return { ok: true, value: task, replay: true };
    }

    if (assignment && assignmentTarget && assignmentTarget !== assignment.status) {
      const staleRepair = assignment.status === 'delegated'
        && ((assignmentTarget === 'validated' && ['implementing', 'validated', 'ready_for_audit'].includes(task.status))
          || (assignmentTarget === 'ready_for_audit' && ['validated', 'ready_for_audit'].includes(task.status)));
      if (!canTransitionSupervisionTaskStatus(assignment.status, assignmentTarget) && !staleRepair) {
        return { ok: false, reason: 'invalid_transition' };
      }
    }

    const now = Date.now();
    const record: PersistedSupervisionTaskRecord = taskChanges
      ? { ...task, status: input.toStatus!, updatedAt: now }
      : task;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      if (assignment && ((assignmentTarget && assignmentTarget !== assignment.status) || validationOutcome)) {
        this.#writeAssignment(
          {
            ...assignment,
            ...(assignmentTarget ? { status: assignmentTarget } : {}),
            // Persist the outcome, not just the event payload, so the console
            // can project a real validation state instead of 'unknown'.
            ...(input.validationState ? { validationState: input.validationState } : {}),
            updatedAt: now,
          },
            input.intent === 'open_audit'
              ? 'implementation_finished'
              // No status transition means this write exists only to record the
              // validation outcome, so the canonical validated event is honest here.
              : (assignmentTarget ? this.#taskEventFor(assignmentTarget) : 'validated'),
          {
            source: 'task_intent_assignment_sync',
            intent: input.intent,
            validationState: input.validationState,
            ...(input.intent === 'open_audit' ? {
              implementationHandoff: 'FINISHED',
              auditVerdict: null,
            } : {}),
          },
        );
      }
      if (taskChanges || validationOutcome) {
        this.#writeTask({ ...record, ...(validationOutcome ? { validationState: validationOutcome } : {}) },
          taskChanges ? this.#taskEventFor(input.toStatus!) : 'validated', {
          source: 'task_intent',
          intent: input.intent,
          status: input.toStatus,
          ...(input.validationState ? { validationState: input.validationState } : {}),
          ...(input.note ? { note: input.note } : {}),
        });
      }
      this.#db.exec('COMMIT');
      return { ok: true, value: record };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Administrative recovery to a restricted status.
   *
   * The handler already enforced the restricted enum, the forbidden source
   * states, and the admin gate. A blocked recovery records its reason as the
   * blocker so the operator sees WHY on the task itself, not only in an event.
   */
  recoverTask(input: {
    taskId: string;
    toStatus: SupervisionRecoveryTargetStatus;
    reason: string;
  }): SupervisionTaskRegistryResult<PersistedSupervisionTaskRecord> {
    const task = this.getTaskRecord(input.taskId);
    if (!task) return { ok: false, reason: 'not_found' };
    const reason = normalizeTaskString(input.reason);
    if (!reason) return { ok: false, reason: 'invalid' };
    if (task.status === 'cancelled' && input.toStatus === 'recovered') {
      const revision = normalizeTaskString(task.currentRevision);
      if (!revision) return { ok: false, reason: 'old_revision' };
      const assignments = this.listAssignments(task.taskId);
      const exactPassAudits = assignments.filter((assignment) => (
        assignment.role === 'auditor'
        && assignment.status === 'finalized'
        && assignment.verdict?.trim().toUpperCase() === 'PASS'
        && assignment.auditRevision === revision
        && Boolean(assignment.auditAttemptId)
      ));
      const candidates = assignments.filter((assignment) => (
        assignment.role === 'integration_owner'
        && assignment.required
        && assignment.status === 'cancelled'
        && !assignment.leaseId
        && assignment.verdict?.trim().toUpperCase() === 'PASS'
        && assignment.auditRevision === revision
        && assignment.crossVendorAuditPassed === true
        && exactPassAudits.some((audit) => audit.auditAttemptId === assignment.auditAttemptId)
      )).sort((left, right) => right.createdAt - left.createdAt
        || right.assignmentId.localeCompare(left.assignmentId));
      const replacement = candidates[0];
      if (!replacement) return { ok: false, reason: 'old_revision' };
      if (candidates[1]?.createdAt === replacement.createdAt) {
        return { ok: false, reason: 'ambiguous_assignment' };
      }

      const now = Date.now();
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        this.#writeAssignment({
          ...replacement,
          status: 'ready_for_integration',
          blocker: undefined,
          updatedAt: now,
        }, 'recovered', {
          source: 'cancelled_task_evidence_recovery',
          reason,
          revision,
          auditAttemptId: replacement.auditAttemptId,
        });
        const recovered: PersistedSupervisionTaskRecord = {
          ...task,
          integrationOwnerAssignmentId: replacement.assignmentId,
          status: 'ready_for_integration',
          blocker: undefined,
          updatedAt: now,
        };
        this.#writeTask(recovered, 'recovered', {
          source: 'cancelled_task_evidence_recovery',
          reason,
          replacementIntegrationOwnerAssignmentId: replacement.assignmentId,
          revision,
          auditAttemptId: replacement.auditAttemptId,
        });
        this.#db.exec('COMMIT');
        return { ok: true, value: recovered };
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      }
    }
    // Administrative cancellation uses the same atomic lifecycle path as a
    // participant cancel so stale delegated leases cannot survive after the
    // task itself is terminal.
    if (input.toStatus === 'cancelled') {
      return this.applyTaskIntent({
        taskId: input.taskId,
        intent: 'cancel',
        toStatus: 'cancelled',
        note: reason,
      });
    }
    const record: PersistedSupervisionTaskRecord = {
      ...task,
      status: input.toStatus,
      updatedAt: Date.now(),
      ...(input.toStatus === 'blocked' ? { blocker: reason } : {}),
    };
    this.#writeTask(record, this.#taskEventFor(input.toStatus), {
      source: 'admin_recovery', reason, status: input.toStatus,
    });
    return { ok: true, value: record };
  }

  /**
   * Bounded, restart-idempotent forward convergence for facts that are already
   * uniquely implied by durable authority.
   *
   * This deliberately invents nothing: it never mints a revision, verdict, CI
   * result or Git evidence, never creates an assignment, and never advances a
   * task whose next step is ambiguous. Every branch is same-object and routes
   * through an existing atomic lifecycle path, so a crash between passes leaves
   * the registry in a state a later pass simply re-derives (or skips).
   */
  /**
   * Bounded convergence candidate selection. Terminal statuses are excluded in
   * SQL so they never consume the scan budget, archived rows are deliberately
   * NOT filtered out, and LIMIT keeps one pass bounded. Ordered most-recently
   * updated first so fresh work cannot be starved by old history, with a
   * deterministic id tie-break.
   */
  #listConvergenceCandidateIds(scanLimit: number): string[] {
    if (this.#closed) return [];
    const bounded = Math.max(1, Math.trunc(scanLimit));
    const select = (sql: string, ...params: Array<string | number>): string[] => (
      (this.#db.prepare(sql).all(...params) as Array<Record<string, unknown>>)
        .map((row) => (typeof row.taskId === 'string' ? row.taskId : ''))
        .filter((taskId): taskId is string => taskId.length > 0)
    );
    const live = `SELECT task_id AS taskId FROM supervision_tasks
       WHERE status NOT IN ('pushed', 'finalized', 'blocked', 'cancelled')`;
    const cursor = this.#readConvergenceCursor();
    // Resume strictly AFTER the last window, then wrap to the head of the ring
    // to fill the remaining budget. Every live task is therefore reached within
    // ceil(live / window) ticks no matter how large the backlog grows, while a
    // single tick stays bounded.
    const ahead = select(`${live} AND task_id > ? ORDER BY task_id ASC LIMIT ?`, cursor, bounded);
    const candidates = ahead.length >= bounded
      ? ahead
      : [...ahead, ...select(
        `${live} AND task_id <= ? ORDER BY task_id ASC LIMIT ?`,
        cursor,
        bounded - ahead.length,
      )];
    if (candidates.length > 0) this.#writeConvergenceCursor(candidates[candidates.length - 1]!);
    return candidates;
  }

  /**
   * The rotation position is durable so a restart resumes the ring instead of
   * rescanning its head forever. A missing/unreadable row means "start of the
   * ring", which is a safe, well-defined position rather than a failure.
   */
  #readConvergenceCursor(): string {
    try {
      const row = this.#db
        .prepare('SELECT task_id AS taskId FROM supervision_convergence_cursor WHERE id = 1')
        .get() as Record<string, unknown> | undefined;
      return typeof row?.taskId === 'string' ? row.taskId : '';
    } catch {
      return '';
    }
  }

  #writeConvergenceCursor(taskId: string): void {
    try {
      this.#db.prepare(
        `INSERT INTO supervision_convergence_cursor (id, task_id, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET task_id = excluded.task_id, updated_at = excluded.updated_at`,
      ).run(taskId, Date.now());
    } catch {
      // A cursor that cannot be persisted must never fail the convergence pass;
      // the next tick simply restarts the ring from a defined position.
    }
  }

  convergeLifecycle(
    now = Date.now(),
    options: SupervisionLifecycleConvergenceOptions = {},
  ): SupervisionLifecycleConvergenceAction[] {
    const limit = Math.max(1, Math.trunc(options.limit ?? SUPERVISION_LIFECYCLE_CONVERGENCE_LIMIT));
    const actions: SupervisionLifecycleConvergenceAction[] = [];
    let scanned = 0;
    // Terminal aggregates are intentionally excluded from the ordinary ring,
    // but legacy databases may still hold delegated/auditing auditor rows (and
    // leases) beneath a cancelled aggregate. Retire a bounded batch first.
    // This never invents a verdict or receipt and never touches active tasks.
    actions.push(...this.#convergeTerminalStaleAuditors(now, limit));
    if (actions.length >= limit) return actions;
    // Archived aggregates are INCLUDED. Archival is a retention/visibility
    // marker written at finalization, not a lifecycle state: a task that was
    // finalized once and then handed a newly authorized round is archived while
    // its status is back to a live one. Iterating the default (visible-only)
    // listing therefore hid exactly those aggregates from EVERY branch below,
    // so tsk_5o7 could not be advanced by any deterministic repair and needed a
    // human Brain round every single time. Terminal status is still the real
    // gate, and the existing `scanned` bound still caps the pass.
    // Candidates come from a BOUNDED query that excludes terminal status in SQL
    // and applies no visibility filter.
    //
    // Two things had to be true at once. Archival is a retention/visibility
    // marker written at finalization, not a lifecycle state: an aggregate that
    // was finalized once and then handed a newly authorized round is archived
    // while its status is back to a live one, and the default visible-only
    // listing hid exactly those from EVERY branch below -- tsk_5o7 could not be
    // advanced by any deterministic repair and needed a human Brain round every
    // time. But simply widening to `includeArchived` broke it the other way:
    // `scanned` is incremented BEFORE the terminal skip, so a backlog of
    // terminal archived history consumed the whole quota and permanently
    // starved the one task that needed work, getting worse as history grows.
    // Excluding terminal rows in the query means they never consume the budget,
    // while LIMIT keeps this a bounded pass rather than a full-table walk. The
    // terminal check below is kept as defence in depth for a status that
    // changed between the query and the read.
    for (const candidateId of this.#listConvergenceCandidateIds(limit * 4)) {
      if (actions.length >= limit || scanned >= limit * 4) break;
      scanned += 1;
      const task = this.getTaskRecord(candidateId);
      // A terminal task (pushed/finalized/blocked/cancelled) is never advanced:
      // `blocked` in particular is an operator decision, not a derivable fact.
      if (!task || isTerminalSupervisionTaskStatus(task.status)) continue;
      const retired = this.#convergeConsumedIntegrationSlice(task, now);
      if (retired) {
        actions.push(retired);
        continue;
      }
      // A record state is a projection of durable authority, never a gate the
      // model must unlock in a fixed order. Each branch below closes a specific
      // way a task can otherwise sit still forever.
      // Every convergence branch may atomically rewrite the task aggregate.
      // Evaluate sequentially against a fresh row; eagerly evaluating the old
      // array against `task` let a later projection spread a stale snapshot
      // over a just-committed zero-byte base bind in the same tick.
      const steps = [
        (current: PersistedSupervisionTaskRecord) => this.#convergeCancelledCompletionEvidence(
          current, now, options.inspectAssignmentWorktree,
        ),
        (current: PersistedSupervisionTaskRecord) => this.#convergeAlreadyPresentDelivery(
          current, now, options.inspectAssignmentWorktree,
        ),
        (current: PersistedSupervisionTaskRecord) => this.#convergeStaleCoordinator(
          current, now, options.resolveAuthoritativeBrain,
        ),
        (current: PersistedSupervisionTaskRecord) => this.#convergeExactReworkTarget(current, now),
        (current: PersistedSupervisionTaskRecord) => this.#convergeZeroByteBaseRevision(
          current, now, options.inspectAssignmentWorktree,
        ),
        (current: PersistedSupervisionTaskRecord) => this.#convergeRevisionProjection(current, now),
        (current: PersistedSupervisionTaskRecord) => this.#convergeValidatedRevisionSplit(current, now),
        (current: PersistedSupervisionTaskRecord) => this.#convergeValidatedHandoff(current, now),
        (current: PersistedSupervisionTaskRecord) => this.#convergeRecordedAuditReceipt(current, now),
        (current: PersistedSupervisionTaskRecord) => this.#convergeConsumedFinalizedImplementer(current, now),
        (current: PersistedSupervisionTaskRecord) => this.#convergeStaleFinalizedOwnerProjection(current, now),
        (current: PersistedSupervisionTaskRecord) => this.#convergeConsumedFinalizedOwnerPointer(current, now),
      ];
      let current = task;
      for (const runStep of steps) {
        if (isTerminalSupervisionTaskStatus(current.status)) break;
        const step = runStep(current);
        if (!step) continue;
        actions.push(step);
        // A returned action is the branch's durable mutation signal. Refresh
        // only at that boundary: this prevents a later branch from spreading
        // a stale aggregate over the mutation without multiplying read/inspect
        // work by every no-op step in a bounded backlog scan.
        const refreshed = this.getTaskRecord(candidateId);
        if (!refreshed || isTerminalSupervisionTaskStatus(refreshed.status)) break;
        current = refreshed;
      }
    }
    return actions;
  }

  #convergeTerminalStaleAuditors(
    now: number,
    limit: number,
  ): SupervisionLifecycleConvergenceAction[] {
    const rows = this.#db.prepare(`
      SELECT a.assignment_id AS assignmentId
      FROM supervision_task_assignments a
      JOIN supervision_tasks t ON t.task_id = a.task_id
      WHERE t.status IN ('cancelled', 'finalized')
        AND a.role = 'auditor'
        AND a.status NOT IN ('cancelled', 'finalized')
      ORDER BY a.assignment_id ASC
      LIMIT ?
    `).all(limit) as Array<{ assignmentId?: unknown }>;
    const actions: SupervisionLifecycleConvergenceAction[] = [];
    for (const row of rows) {
      const assignmentId = normalizeTaskString(row.assignmentId as string | undefined);
      const auditor = assignmentId ? this.getAssignment(assignmentId) : undefined;
      const task = auditor ? this.getTaskRecord(auditor.taskId) : undefined;
      if (!auditor || !task || auditor.role !== 'auditor'
        || !['cancelled', 'finalized'].includes(task.status)
        || ['cancelled', 'finalized'].includes(auditor.status)) continue;
      // Any receipt is durable audit authority. Leave it for an exact receipt
      // convergence/repair path rather than guessing how it should close.
      if (this.listAuditReceipts(task.taskId).some((receipt) => receipt.assignmentId === auditor.assignmentId)) continue;
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        const lockedAuditor = this.getAssignment(auditor.assignmentId);
        const lockedTask = this.getTaskRecord(task.taskId);
        const hasReceipt = this.listAuditReceipts(task.taskId)
          .some((receipt) => receipt.assignmentId === auditor.assignmentId);
        if (!lockedAuditor || !lockedTask || lockedAuditor.role !== 'auditor'
          || !['cancelled', 'finalized'].includes(lockedTask.status)
          || ['cancelled', 'finalized'].includes(lockedAuditor.status)
          || hasReceipt) {
          this.#db.exec('ROLLBACK');
          continue;
        }
        this.#writeAssignment({
          ...lockedAuditor,
          status: 'cancelled',
          leaseId: '',
          blocker: JSON.stringify({
            kind: 'terminal_task_stale_auditor_retired',
            taskId: lockedTask.taskId,
            assignmentId: lockedAuditor.assignmentId,
            priorStatus: lockedAuditor.status,
          }),
          updatedAt: now,
        }, 'cancelled', {
          source: 'terminal_task_stale_auditor_cleanup',
          receiptFabricated: false,
          leaseRevoked: Boolean(lockedAuditor.leaseId),
        });
        this.#db.exec('COMMIT');
        actions.push({
          taskId: lockedTask.taskId,
          assignmentId: lockedAuditor.assignmentId,
          action: 'retire_terminal_stale_auditor',
        });
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      }
    }
    return actions;
  }

  /**
   * Event-driven convergence for one freshly validated assignment. Periodic
   * scanning remains a restart backstop, but a unique next step must not wait
   * for its cursor or heartbeat interval.
   */
  convergeValidatedAssignment(
    assignmentId: string,
    now = Date.now(),
    inspect?: SupervisionLifecycleConvergenceOptions['inspectAssignmentWorktree'],
  ): SupervisionLifecycleConvergenceAction[] {
    const assignment = this.getAssignment(assignmentId);
    const task = assignment ? this.getTaskRecord(assignment.taskId) : undefined;
    if (!assignment || !task || assignment.validationState !== 'passed') return [];
    const actions: SupervisionLifecycleConvergenceAction[] = [];
    const aligned = this.#convergeValidatedRevisionSplit(task, now);
    if (aligned) actions.push(aligned);
    const alignedTask = this.getTaskRecord(task.taskId);
    if (!alignedTask) return actions;
    const zeroByte = this.#convergeZeroByteBaseRevision(alignedTask, now, inspect);
    if (zeroByte) actions.push(zeroByte);
    const refreshedTask = this.getTaskRecord(task.taskId);
    if (!refreshedTask) return actions;
    const handoff = this.#convergeValidatedHandoff(refreshedTask, now);
    if (handoff) actions.push(handoff);
    return actions;
  }

  /** Event-driven exact-object repair used by the Brain recovery ingress. */
  convergeExactReworkAssignment(
    assignmentId: string,
    now = Date.now(),
  ): SupervisionLifecycleConvergenceAction | undefined {
    const assignment = this.getAssignment(assignmentId);
    const task = assignment ? this.getTaskRecord(assignment.taskId) : undefined;
    if (!task) return undefined;
    const converged = this.#convergeExactReworkTarget(task, now, assignmentId);
    if (converged) return converged;
    const refreshed = this.getAssignment(assignmentId);
    const refreshedTask = this.getTaskRecord(task.taskId);
    const revision = normalizeTaskString(refreshedTask?.currentRevision);
    if (!refreshed || !refreshedTask || !revision
      || refreshedTask.status !== 'rework' || refreshed.status !== 'rework'
      || !refreshed.leaseId || refreshed.auditRevision !== revision
      || !refreshed.auditAttemptId || refreshed.verdict?.trim().toUpperCase() !== 'REWORK') return undefined;
    const receipts = this.listAuditReceipts(task.taskId).filter((receipt) => (
      receipt.revision === revision && receipt.attemptId === refreshed.auditAttemptId
      && receipt.receiptKind === 'final' && receipt.verdict === 'REWORK'
    ));
    if (receipts.length !== 1) return undefined;
    const auditor = this.getAssignment(receipts[0]!.assignmentId);
    if (!auditor || auditor.role !== 'auditor'
      || !['cancelled', 'finalized'].includes(auditor.status)
      || auditor.leaseId) return undefined;
    return { taskId: task.taskId, assignmentId, action: 'restore_exact_rework_implementer' };
  }

  #convergeCancelledCompletionEvidence(
    task: PersistedSupervisionTaskRecord,
    now: number,
    inspect?: SupervisionLifecycleConvergenceOptions['inspectAssignmentWorktree'],
  ): SupervisionLifecycleConvergenceAction | undefined {
    if (!inspect) return undefined;
    const pending = this.listCompletionEvidence(task.taskId)
      .filter((record) => record.status === 'pending');
    if (pending.length !== 1) return undefined;
    const evidence = pending[0]!;
    const source = this.getAssignment(evidence.sourceAssignmentId);
    if (!source || source.status !== 'cancelled') return undefined;
    const successors = this.listAssignments(task.taskId).filter((assignment) => (
      assignment.assignmentId !== source.assignmentId
      && assignment.required
      && assignment.role === 'implementer'
      && !isTerminalSupervisionTaskStatus(assignment.status)
      && !this.#assignmentConsumedByFinalization(task, assignment)
    ));
    if (successors.length !== 1) return undefined;
    const successor = successors[0]!;
    const snapshot = inspect(successor);
    if (!snapshot) return undefined;
    const successorHasFileEvents = this.listFileEvents(task.taskId)
      .some((event) => event.assignmentId === successor.assignmentId);
    if (snapshot.files.length === 0 && !successorHasFileEvents) {
      if (successor.blocker && !successor.blocker.includes(evidence.evidenceId)) return undefined;
      const adopted: PersistedSupervisionCompletionEvidence = {
        ...evidence,
        status: 'adopted',
        adoptedByAssignmentId: successor.assignmentId,
        resolutionReason: 'replacement_worktree_untouched',
        resolvedAt: now,
      };
      const blocker = JSON.stringify({
        kind: 'cancelled_completion_evidence', actionRequired: 'adopt',
        evidenceId: evidence.evidenceId, sourceAssignmentId: source.assignmentId,
        revision: evidence.revision, manifestSha256: evidence.manifestSha256,
        worktreePath: evidence.worktreePath,
      });
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        const locked = this.listCompletionEvidence(task.taskId)
          .find((record) => record.evidenceId === evidence.evidenceId);
        const lockedSuccessor = this.getAssignment(successor.assignmentId);
        if (!locked || locked.status !== 'pending' || !lockedSuccessor
          || isTerminalSupervisionTaskStatus(lockedSuccessor.status)) {
          this.#db.exec('ROLLBACK');
          return undefined;
        }
        this.#writeCompletionEvidence(adopted);
        this.#writeAssignment({
          ...lockedSuccessor,
          scopeFiles: normalizeTaskArray([...lockedSuccessor.scopeFiles, ...evidence.files.map((file) => file.path)]),
          blocker,
          updatedAt: now,
        }, this.#taskEventFor(lockedSuccessor.status), {
          source: 'lifecycle_convergence_cancelled_completion_adoption',
          evidenceId: evidence.evidenceId,
        });
        this.#db.exec('COMMIT');
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      }
      return {
        taskId: task.taskId,
        assignmentId: successor.assignmentId,
        action: 'adopt_cancelled_completion_evidence',
      };
    }

    const existingConflict = safeJsonParseObject(task.blocker);
    if (existingConflict?.kind === 'cancelled_completion_evidence_conflict'
      && existingConflict.evidenceId === evidence.evidenceId) return undefined;
    const blocker = JSON.stringify({
      kind: 'cancelled_completion_evidence_conflict', actionRequired: 'adopt_or_discard',
      evidenceId: evidence.evidenceId, sourceAssignmentId: source.assignmentId,
      successorAssignmentId: successor.assignmentId, revision: evidence.revision,
      manifestSha256: evidence.manifestSha256, worktreePath: evidence.worktreePath,
      ...(task.blocker ? { previousBlocker: task.blocker } : {}),
    });
    this.#writeTask({ ...task, blocker, updatedAt: now }, this.#taskEventFor(task.status), {
      source: 'lifecycle_convergence_cancelled_completion_conflict',
      evidenceId: evidence.evidenceId,
      successorAssignmentId: successor.assignmentId,
    });
    return {
      taskId: task.taskId,
      assignmentId: successor.assignmentId,
      action: 'request_cancelled_completion_evidence_decision',
    };
  }

  /**
   * Restore the unique implementation object named by an immutable exact
   * REWORK receipt. This closes the tsk_73i split (task=rework while its sole
   * implementer remained ready_for_audit) without minting a replacement.
   */
  #convergeExactReworkTarget(
    task: PersistedSupervisionTaskRecord,
    now: number,
    requestedAssignmentId?: string,
  ): SupervisionLifecycleConvergenceAction | undefined {
    if (!['validated', 'ready_for_audit', 'rework'].includes(task.status)) return undefined;
    const revision = normalizeTaskString(task.currentRevision);
    if (!revision) return undefined;
    const implementers = this.listAssignments(task.taskId).filter((assignment) => (
      assignment.required && assignment.role === 'implementer'
      && assignment.status !== 'cancelled' && assignment.status !== 'finalized'
      && (!requestedAssignmentId || assignment.assignmentId === requestedAssignmentId)
    ));
    if (implementers.length !== 1) return undefined;
    const implementer = implementers[0]!;
    if (!['validated', 'ready_for_audit'].includes(implementer.status)
      || (normalizeTaskString(implementer.auditRevision)
        && normalizeTaskString(implementer.auditRevision) !== revision)) return undefined;
    const receipts = this.listAuditReceipts(task.taskId).filter((receipt) => (
      receipt.revision === revision && receipt.receiptKind === 'final'
    ));
    if (receipts.length !== 1 || receipts[0]!.verdict !== 'REWORK') return undefined;
    const receipt = receipts[0]!;
    if (normalizeTaskString(implementer.auditAttemptId)
      && normalizeTaskString(implementer.auditAttemptId) !== receipt.attemptId) return undefined;
    const auditor = this.getAssignment(receipt.assignmentId);
    if (!auditor || auditor.role !== 'auditor'
      || !['cancelled', 'finalized'].includes(auditor.status)
      || Boolean(auditor.leaseId)
      || auditor.auditRevision !== revision
      || auditor.auditAttemptId !== receipt.attemptId
      || auditor.verdict?.trim().toUpperCase() !== 'REWORK') return undefined;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const lockedTask = this.getTaskRecord(task.taskId);
      const lockedImplementer = this.getAssignment(implementer.assignmentId);
      const lockedReceipts = this.listAuditReceipts(task.taskId).filter((candidate) => (
        candidate.revision === revision && candidate.receiptKind === 'final'
      ));
      if (!lockedTask || !lockedImplementer
        || !['validated', 'ready_for_audit'].includes(lockedImplementer.status)
        || lockedReceipts.length !== 1
        || lockedReceipts[0]!.receiptId !== receipt.receiptId
        || lockedReceipts[0]!.verdict !== 'REWORK') {
        this.#db.exec('ROLLBACK');
        return undefined;
      }
      const leaseId = lockedImplementer.leaseId || this.#mintLeaseId();
      this.#writeAssignment({
        ...lockedImplementer,
        status: 'rework',
        leaseId,
        generation: lockedImplementer.leaseId
          ? lockedImplementer.generation : lockedImplementer.generation + 1,
        auditAttemptId: receipt.attemptId,
        auditRevision: revision,
        verdict: 'REWORK',
        blocker: receipt.findings,
        updatedAt: now,
      }, 'rework', {
        source: 'lifecycle_convergence_exact_rework_receipt',
        receiptId: receipt.receiptId,
        auditAttemptId: receipt.attemptId,
        revision,
      });
      if (lockedTask.status !== 'rework') {
        this.#writeTask({ ...lockedTask, status: 'rework', updatedAt: now }, 'rework', {
          source: 'lifecycle_convergence_exact_rework_receipt',
          assignmentId: lockedImplementer.assignmentId,
          receiptId: receipt.receiptId,
          auditAttemptId: receipt.attemptId,
          revision,
        });
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return {
      taskId: task.taskId,
      assignmentId: implementer.assignmentId,
      action: 'restore_exact_rework_implementer',
    };
  }

  #convergeAlreadyPresentDelivery(
    task: PersistedSupervisionTaskRecord,
    now: number,
    inspect?: SupervisionLifecycleConvergenceOptions['inspectAssignmentWorktree'],
  ): SupervisionLifecycleConvergenceAction | undefined {
    if (!inspect || !['implementing', 'passed', 'ready_for_integration'].includes(task.status)
      || task.finalization) return undefined;
    const revision = normalizeTaskString(task.currentRevision);
    if (!revision) return undefined;
    const candidates = this.listAssignments(task.taskId).filter((assignment) => (
      assignment.required && (assignment.role === 'implementer' || assignment.role === 'integration_owner')
      && ['implementing', 'passed', 'ready_for_integration'].includes(assignment.status)
      && assignment.auditRevision === revision
      && Boolean(assignment.auditAttemptId)
      && assignment.verdict?.trim().toUpperCase() === 'PASS'
      && assignment.crossVendorAuditPassed === true
    ));
    if (candidates.length !== 1) return undefined;
    const assignment = candidates[0]!;
    const passReceipts = this.listAuditReceipts(task.taskId).filter((receipt) => (
      receipt.receiptKind === 'final' && receipt.verdict === 'PASS'
      && receipt.revision === revision && receipt.attemptId === assignment.auditAttemptId
    ));
    if (passReceipts.length !== 1) return undefined;
    const auditor = this.getAssignment(passReceipts[0]!.assignmentId);
    if (!auditor || auditor.role !== 'auditor' || auditor.status !== 'finalized'
      || auditor.auditRevision !== revision || auditor.auditAttemptId !== assignment.auditAttemptId
      || auditor.verdict?.trim().toUpperCase() !== 'PASS' || auditor.leaseId
      || auditor.identity.providerFamily === assignment.identity.providerFamily) return undefined;
    const snapshot = inspect(assignment);
    if (!snapshot?.matchingRemoteCommitSha || !snapshot.matchingRemoteRef
      || !FINALIZATION_COMMIT_RE.test(snapshot.matchingRemoteCommitSha)) return undefined;
    const blocker = JSON.stringify({
      kind: 'already_present_delivery', missingEvidence: 'structured_finalization_receipt',
      assignmentId: assignment.assignmentId, revision,
      auditAttemptId: assignment.auditAttemptId,
      commitSha: snapshot.matchingRemoteCommitSha,
      pushRemoteRef: snapshot.matchingRemoteRef,
    });
    if (task.commitSha === snapshot.matchingRemoteCommitSha
      && task.pushRemoteRef === snapshot.matchingRemoteRef
      && task.blocker === blocker) return undefined;
    if ((task.commitSha && task.commitSha !== snapshot.matchingRemoteCommitSha)
      || (task.pushRemoteRef && task.pushRemoteRef !== snapshot.matchingRemoteRef)
      || (task.blocker && task.blocker !== blocker)) return undefined;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const lockedTask = this.getTaskRecord(task.taskId);
      const lockedAssignment = this.getAssignment(assignment.assignmentId);
      const lockedReceipts = this.listAuditReceipts(task.taskId).filter((receipt) => (
        receipt.receiptKind === 'final' && receipt.verdict === 'PASS'
        && receipt.revision === revision && receipt.attemptId === assignment.auditAttemptId
      ));
      if (!lockedTask || lockedTask.updatedAt !== task.updatedAt || lockedTask.finalization
        || !lockedAssignment || lockedAssignment.updatedAt !== assignment.updatedAt
        || lockedReceipts.length !== 1 || lockedReceipts[0]!.receiptId !== passReceipts[0]!.receiptId) {
        this.#db.exec('ROLLBACK');
        return undefined;
      }
      this.#writeAssignment({
        ...lockedAssignment, status: 'ready_for_integration', leaseId: '', blocker: undefined, updatedAt: now,
      }, 'ready_for_integration', {
        source: 'lifecycle_convergence_already_present_delivery', revision,
        commitSha: snapshot.matchingRemoteCommitSha, pushRemoteRef: snapshot.matchingRemoteRef,
      });
      this.#writeTask({
        ...lockedTask,
        status: 'ready_for_integration',
        commitSha: snapshot.matchingRemoteCommitSha,
        pushRemoteRef: snapshot.matchingRemoteRef,
        blocker,
        updatedAt: now,
      }, 'ready_for_integration', {
        source: 'lifecycle_convergence_already_present_delivery',
        assignmentId: assignment.assignmentId,
        revision,
      });
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return { taskId: task.taskId, assignmentId: assignment.assignmentId, action: 'record_already_present_delivery' };
  }

  /**
   * Retire an integration slice whose finalized parent already consumed this
   * slice's exact delivery evidence (same externalRunId AND externalHeadSha).
   * The slice cannot make further progress -- its work is already shipped -- so
   * holding its lease only strands the file claims and keeps a worker awake.
   *
   * Fail-closed: it acts only when EXACTLY ONE implementer carries that
   * evidence. Zero means the parent shipped something else; more than one means
   * the authority is ambiguous and a human must decide.
   */
  /**
   * Refresh a coordinator's observational runtime metadata after restart while
   * preserving its durable projectName + sessionName authority.
   */
  #convergeStaleCoordinator(
    task: PersistedSupervisionTaskRecord,
    now: number,
    resolve?: SupervisionLifecycleConvergenceOptions['resolveAuthoritativeBrain'],
  ): SupervisionLifecycleConvergenceAction | undefined {
    if (!resolve) return undefined;
    const coordinators = this.listAssignments(task.taskId).filter((assignment) => (
      assignment.role === 'coordinator'
      && assignment.status !== 'cancelled'
      && assignment.status !== 'finalized'
    ));
    if (coordinators.length !== 1) return undefined;
    const coordinator = coordinators[0]!;
    const live = resolve(task.projectName, coordinator.identity.sessionName);
    if (!live?.sessionName) return undefined;
    if (!matchesDurableSupervisionParticipant({
      taskProjectName: task.projectName,
      assignmentSessionName: coordinator.identity.sessionName,
      candidateProjectName: task.projectName,
      candidateSessionName: live.sessionName,
    })) return undefined;
    if (runtimeIdentityMetadataMatches(coordinator.identity, live)) return undefined;
    this.#writeAssignment({ ...coordinator, identity: { ...live }, updatedAt: now }, this.#taskEventFor(coordinator.status), {
      source: 'lifecycle_convergence_coordinator_rebind',
      previousRuntimeEpoch: coordinator.identity.runtimeEpoch,
      runtimeEpoch: live.runtimeEpoch,
    });
    return { taskId: task.taskId, assignmentId: coordinator.assignmentId, action: 'rebind_stale_coordinator' };
  }

  /**
   * Copy an already-authoritative revision to the side that is missing it. This
   * mints nothing: it only projects a value that exists exactly once. Any
   * disagreement between assignments is ambiguous authority and fails closed.
   */
  #convergeRevisionProjection(
    task: PersistedSupervisionTaskRecord,
    now: number,
  ): SupervisionLifecycleConvergenceAction | undefined {
    const live = this.listAssignments(task.taskId).filter((assignment) => (
      assignment.status !== 'cancelled' && assignment.status !== 'finalized'
      && assignment.role !== 'coordinator'
    ));
    if (live.length === 0) return undefined;
    const distinct = new Set(live
      .map((assignment) => normalizeTaskString(assignment.auditRevision))
      .filter((value): value is string => Boolean(value)));
    if (distinct.size > 1) return undefined; // ambiguous: a human must decide
    const taskRevision = normalizeTaskString(task.currentRevision);
    const assignmentRevision = [...distinct][0];

    if (taskRevision && !assignmentRevision) {
      const missing = live.filter((assignment) => !normalizeTaskString(assignment.auditRevision));
      if (missing.length !== 1) return undefined;
      const target = missing[0]!;
      this.#writeAssignment({ ...target, auditRevision: taskRevision, updatedAt: now }, this.#taskEventFor(target.status), {
        source: 'lifecycle_convergence_revision_projection', revision: taskRevision, from: 'task',
      });
      return { taskId: task.taskId, assignmentId: target.assignmentId, action: 'align_revision_projection' };
    }
    if (!taskRevision && assignmentRevision) {
      this.#writeTask({ ...task, currentRevision: assignmentRevision, updatedAt: now }, this.#taskEventFor(task.status), {
        source: 'lifecycle_convergence_revision_projection', revision: assignmentRevision, from: 'assignment',
      });
      return { taskId: task.taskId, action: 'align_revision_projection' };
    }
    return undefined;
  }

  /**
   * Bind a genuinely zero-byte reviewed task to the Git object it actually
   * reviewed.  This is not a synthetic revision: `headSha` comes from a
   * read-only inspection of the assignment's authoritative worktree.  The
   * transaction is deliberately narrow and fail-closed on any changed byte,
   * revision disagreement, finalization evidence, or ambiguous implementer.
   *
   * This closes the tsk_7ax shape where validation was durable but FINISHED
   * returned `old_revision` forever because neither projection carried a
   * revision.  A no-op review still has an immutable Git object and can proceed
   * through the same audit protocol as a byte-changing revision.
   */
  #convergeZeroByteBaseRevision(
    task: PersistedSupervisionTaskRecord,
    now: number,
    inspect?: SupervisionLifecycleConvergenceOptions['inspectAssignmentWorktree'],
  ): SupervisionLifecycleConvergenceAction | undefined {
    if (!inspect || normalizeTaskString(task.currentRevision)
      || task.finalization || task.commitSha || task.pushRemoteRef) return undefined;
    const candidates = this.listAssignments(task.taskId).filter((assignment) => (
      assignment.required
      && assignment.role === 'implementer'
      && assignment.validationState === 'passed'
      && assignment.status === 'validated'
      && !normalizeTaskString(assignment.auditRevision)
    ));
    if (candidates.length !== 1) return undefined;
    const assignment = candidates[0]!;
    const snapshot = inspect(assignment);
    if (!snapshot || !FINALIZATION_COMMIT_RE.test(snapshot.headSha)
      || snapshot.files.length !== 0
      || snapshot.stagedPaths.length !== 0
      || snapshot.conflictedPaths.length !== 0
      || snapshot.untrackedPaths.length !== 0
      || (normalizeTaskString(task.baseRevision)
        && normalizeTaskString(task.baseRevision) !== snapshot.headSha)) return undefined;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const lockedTask = this.getTaskRecord(task.taskId);
      const lockedAssignment = this.getAssignment(assignment.assignmentId);
      if (!lockedTask || !lockedAssignment
        || normalizeTaskString(lockedTask.currentRevision)
        || normalizeTaskString(lockedAssignment.auditRevision)
        || lockedAssignment.status !== 'validated'
        || lockedAssignment.validationState !== 'passed') {
        this.#db.exec('ROLLBACK');
        return undefined;
      }
      this.#writeTask({
        ...lockedTask,
        baseRevision: normalizeTaskString(lockedTask.baseRevision) ?? snapshot.headSha,
        currentRevision: snapshot.headSha,
        updatedAt: now,
      }, this.#taskEventFor(lockedTask.status), {
        source: 'lifecycle_convergence_zero_byte_base_revision',
        revision: snapshot.headSha,
        worktreePath: snapshot.worktreePath,
      });
      this.#writeAssignment({
        ...lockedAssignment,
        auditRevision: snapshot.headSha,
        updatedAt: now,
      }, this.#taskEventFor(lockedAssignment.status), {
        source: 'lifecycle_convergence_zero_byte_base_revision',
        revision: snapshot.headSha,
        worktreePath: snapshot.worktreePath,
      });
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return {
      taskId: task.taskId,
      assignmentId: assignment.assignmentId,
      action: 'bind_zero_byte_base_revision',
    };
  }

  /**
   * Repair only the observed validated successor split: the aggregate still
   * names R1 while its sole required, validated implementer already names R2.
   * The strict finish equality remains untouched; this atomically advances the
   * aggregate authority first, and ordinary finish then performs the handoff.
   */
  #resolveValidatedRevisionSplit(
    task: PersistedSupervisionTaskRecord,
  ): { assignmentId: string; fromRevision: string; toRevision: string } | undefined {
    const fromRevision = normalizeTaskString(task.currentRevision);
    if (task.status !== 'validated' || task.validationState !== 'passed' || !fromRevision
      || task.finalization || task.commitSha || task.pushRemoteRef || task.archivedAt
      || task.integrationOwnerAssignmentId || task.blocker
      || this.listAuditReceipts(task.taskId).length > 0) return undefined;

    const assignments = this.listAssignments(task.taskId);
    const implementers = assignments.filter((assignment) => (
      assignment.role === 'implementer'
      && assignment.required
      && !isTerminalSupervisionTaskStatus(assignment.status)
    ));
    if (implementers.length !== 1) return undefined;
    const target = implementers[0]!;
    const toRevision = normalizeTaskString(target.auditRevision);
    if (target.status !== 'validated' || target.validationState !== 'passed'
      || !target.leaseId || target.scopeFiles.length === 0 || !toRevision
      || toRevision === fromRevision || target.auditAttemptId || target.verdict
      || target.primaryReviewPassed || target.crossVendorAuditPassed
      || target.auditRoutingReason || target.auditDegradedReason
      || target.externalRunId || target.externalHeadSha || target.externalTaskId) return undefined;

    const conflictingAuthority = assignments.some((assignment) => (
      assignment.assignmentId !== target.assignmentId
      && ((assignment.role === 'implementer' && assignment.required
          && !isTerminalSupervisionTaskStatus(assignment.status))
        || (assignment.role === 'integration_owner'
          && !isTerminalSupervisionTaskStatus(assignment.status))
        || (assignment.role === 'auditor'
          && (Boolean(assignment.auditAttemptId)
            || !isTerminalSupervisionTaskStatus(assignment.status))))
    ));
    if (conflictingAuthority) return undefined;
    return { assignmentId: target.assignmentId, fromRevision, toRevision };
  }

  #convergeValidatedRevisionSplit(
    task: PersistedSupervisionTaskRecord,
    now: number,
  ): SupervisionLifecycleConvergenceAction | undefined {
    const plan = this.#resolveValidatedRevisionSplit(task);
    if (!plan) return undefined;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const lockedTask = this.getTaskRecord(task.taskId);
      const lockedPlan = lockedTask ? this.#resolveValidatedRevisionSplit(lockedTask) : undefined;
      if (!lockedTask || !lockedPlan
        || lockedPlan.assignmentId !== plan.assignmentId
        || lockedPlan.fromRevision !== plan.fromRevision
        || lockedPlan.toRevision !== plan.toRevision) {
        this.#db.exec('ROLLBACK');
        return undefined;
      }
      this.#writeTask({
        ...lockedTask,
        currentRevision: plan.toRevision,
        updatedAt: now,
      }, 'validated', {
        source: 'lifecycle_convergence_validated_revision_split',
        assignmentId: plan.assignmentId,
        fromRevision: plan.fromRevision,
        toRevision: plan.toRevision,
      });
      this.#db.exec('COMMIT');
      return {
        taskId: task.taskId,
        assignmentId: plan.assignmentId,
        action: 'align_validated_revision',
      };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * A recorded `validationState: passed` is the durable fact. Requiring the
   * model to re-issue record_validation before anything may move is exactly the
   * ordering gate that strands tasks, so project it forward instead.
   */
  #convergeValidatedHandoff(
    task: PersistedSupervisionTaskRecord,
    now: number,
  ): SupervisionLifecycleConvergenceAction | undefined {
    const target = this.listAssignments(task.taskId).find((assignment) => (
      assignment.role !== 'auditor'
      && assignment.role !== 'coordinator'
      && assignment.validationState === 'passed'
      && assignment.status !== 'ready_for_audit'
      && canTransitionSupervisionTaskStatus(assignment.status, 'ready_for_audit')
    ));
    if (!target) return undefined;
    // Passed validation is the durable fact; waiting for a separate open_audit
    // call is the ordering gate that strands the object. Use the ordinary
    // atomic FINISHED transition so task + assignment + lease + revision move
    // together. Writing only the assignment produced the tsk_79u split:
    // task=validated while assignment=ready_for_audit.
    const refreshedTask = this.getTaskRecord(task.taskId);
    const refreshedTarget = this.getAssignment(target.assignmentId);
    const revision = normalizeTaskString(refreshedTarget?.auditRevision)
      ?? normalizeTaskString(refreshedTask?.currentRevision);
    if (!refreshedTarget || !revision) return undefined;
    const finished = this.finishAssignment({
      assignmentId: refreshedTarget.assignmentId,
      identity: refreshedTarget.identity,
      revision,
      now,
    });
    if (!finished.ok) return undefined;
    return { taskId: task.taskId, assignmentId: target.assignmentId, action: 'project_validated_handoff' };
  }

  /**
   * An immutable final receipt that matches this auditor EXACTLY (assignment +
   * attempt + revision) already carries the verdict. Close the auditor and free
   * its lease instead of waiting for a finish call that may never arrive. A
   * receipt from any other attempt or revision is ignored.
   */
  #convergeRecordedAuditReceipt(
    task: PersistedSupervisionTaskRecord,
    _now: number,
  ): SupervisionLifecycleConvergenceAction | undefined {
    const receipts = this.listAuditReceipts(task.taskId);
    for (const auditor of this.listAssignments(task.taskId)) {
      if (auditor.role !== 'auditor') continue;
      if (auditor.status === 'finalized' || auditor.status === 'cancelled') continue;
      const attemptId = normalizeTaskString(auditor.auditAttemptId);
      const revision = normalizeTaskString(auditor.auditRevision);
      if (!attemptId || !revision) continue;
      const exact = receipts.filter((receipt) => (
        receipt.assignmentId === auditor.assignmentId
        && receipt.attemptId === attemptId
        && receipt.revision === revision
        && receipt.receiptKind === 'final'
        && (receipt.verdict === 'PASS' || receipt.verdict === 'REWORK')
      ));
      if (exact.length !== 1) continue;
      const closed = this.finishAssignment({
        assignmentId: auditor.assignmentId,
        identity: auditor.identity,
        revision,
      });
      if (!closed.ok) continue;
      return {
        taskId: task.taskId,
        assignmentId: auditor.assignmentId,
        action: 'close_recorded_audit_receipt',
      };
    }
    return undefined;
  }

  /**
   * Retire the implementer whose work the task's own finalization ALREADY
   * consumed, once a newly authorized successor exists.
   *
   * Observed on tsk_5o7: the aggregate was finalized at R4 with a real commit,
   * push and CI run, yet the R4 implementer stayed parked in
   * `ready_for_integration`. Recovery then counted it and the fresh successor
   * as two active implementers and refused with `ambiguous_assignment`, so a
   * human had to cancel the historical assignment by hand every round. The
   * ambiguity is only apparent: the task's immutable finalization names
   * exactly which revision and attempt were shipped.
   *
   * Fail-closed and evidence-anchored. It acts only when EXACTLY ONE parked
   * implementer matches the finalization's revision AND attempt AND carries the
   * PASS it earned, holds no lease, and only when a successor that is NOT on
   * that revision actually exists -- otherwise there is nothing to disambiguate
   * and retiring would destroy the only live implementer. The record is retired
   * in place: identity, auditRevision, auditAttemptId, verdict and every other
   * field are preserved, and the task's finalization/Git/CI evidence is never
   * touched.
   */
  /**
   * Retire a stale LIVE integration-owner projection once the round it belongs
   * to is closed by the task's own finalization.
   *
   * Observed on the remote R3->R4 handoff: the task carried an immutable PASS
   * receipt and real Git provenance, a non-terminal integration_owner
   * projection was still sitting on the aggregate, and the implementer had
   * already frozen its successor. That live owner counts as a second active
   * successor candidate, so binding the frozen revision was refused with
   * `ambiguous_assignment` and a human had to retire the projection by hand
   * every round.
   *
   * Retirement is a STATUS-only change on the same object: identity,
   * auditRevision, auditAttemptId, verdict, externalRunId/HeadSha and every
   * other recorded field are preserved by spreading the record, and the task's
   * finalization, commit and CI evidence are never touched. No revision, PASS,
   * Git or CI byte is invented -- the successor still has to bind its own
   * frozen revision through the ordinary authoritative path.
   *
   * Fail-closed on everything the daemon cannot decide alone: more than one
   * live owner, an owner still holding a lease, an owner whose recorded
   * evidence points at a revision finalization does not cover, or anything
   * other than exactly one unique unconsumed successor.
   */
  /**
   * Recover a successor-bind anchor that a coordination override erased.
   *
   * Only durable evidence is used, and only when it is unambiguous: exactly one
   * final PASS/REWORK receipt recorded against the revision the task is still
   * pointing at, and all such receipts must share ONE attempt. Zero receipts
   * means the round was never audited, and receipts from different attempts
   * mean the authority is genuinely ambiguous -- both fail closed and leave the
   * caller with its ordinary `old_revision` refusal rather than a guess.
   */
  #derivedSuccessorAnchor(
    task: PersistedSupervisionTaskRecord,
    existing: PersistedSupervisionTaskAssignment,
  ): string | undefined {
    if (normalizeTaskString(existing.auditRevision)) return undefined;
    if (existing.role === 'auditor') return undefined;
    const current = normalizeTaskString(task.currentRevision);
    if (!current) return undefined;
    const finals = this.listAuditReceipts(task.taskId).filter((receipt) => (
      receipt.receiptKind === 'final'
      && receipt.revision === current
      && (receipt.verdict === 'PASS' || receipt.verdict === 'REWORK')
    ));
    if (finals.length === 0) return undefined;
    const attempts = new Set(finals.map((receipt) => receipt.attemptId));
    if (attempts.size !== 1) return undefined;
    return current;
  }

  /**
   * Clear an integration-owner POINTER that still names the owner of a round
   * the task has already moved past.
   *
   * Observed on tsk_5o7: finalization covered R4 and named asg_5ve as the
   * integration owner. The task then advanced to R9, but the pointer stayed on
   * that now-finalized R4 owner. Because currentRevision no longer equals
   * finalization.revision, a successor bind takes the ordinary
   * `movesTaskRevisionToSuccessor` path, whose pointer rule demands the caller
   * BE the pointer owner -- so the required implementer was refused with
   * `owner_mismatch` on every single bind, and only a human could unstick it.
   *
   * The pointer is stale, not authoritative: the round it belonged to is closed
   * by the task's own immutable finalization. Only the POINTER is cleared here.
   * The owner assignment itself, its auditRevision/auditAttemptId/verdict and
   * external run/head evidence, the task's finalization, commitSha and CI
   * fields are all left exactly as they are -- this reopens nothing.
   *
   * Fail-closed: the pointer target must be terminal AND carry exactly the
   * finalization's revision and attempt; the task must genuinely have moved on;
   * there must be no other live integration owner; and exactly one required
   * non-terminal implementer must exist to receive the binding. Anything else
   * is ambiguous and stays for Brain to decide.
   */
  /**
   * THE single definition of "this finalization is history, not authority over
   * the round in flight".
   *
   * This rule existed in three places -- the `movesTaskRevisionToSuccessor`
   * authority block, the `bindsSuccessorRevision` veto, and Brain's revision
   * recovery -- and they drifted: fixing the first two still left recovery
   * refusing with `old_revision`. One predicate, three consumers, so a fourth
   * copy cannot appear.
   *
   * Historical means: finalization covers a DIFFERENT revision than the one in
   * flight, the task is not itself in a Git/terminal state, and no integration
   * owner is still live. When finalization still covers the current revision it
   * remains full authority and this returns false, so the dedicated
   * advance-past-finalized path keeps handling that case.
   */
  #historicalFinalizationOnly(task: PersistedSupervisionTaskRecord): boolean {
    const finalizedRevision = normalizeTaskString(task.finalization?.revision);
    if (!task.finalization || !finalizedRevision) return false;
    if (finalizedRevision === normalizeTaskString(task.currentRevision)) return false;
    if (['committed', 'pushed', 'finalized'].includes(task.status)) return false;
    return !this.listAssignments(task.taskId).some((candidate) => (
      candidate.role === 'integration_owner'
      && !isTerminalSupervisionTaskStatus(candidate.status)
    ));
  }

  #convergeConsumedFinalizedOwnerPointer(
    task: PersistedSupervisionTaskRecord,
    now: number,
  ): SupervisionLifecycleConvergenceAction | undefined {
    const pointerId = normalizeTaskString(task.integrationOwnerAssignmentId);
    const finalization = task.finalization;
    if (!pointerId || !finalization) return undefined;
    const finalizedRevision = normalizeTaskString(finalization.revision);
    const finalizedAttempt = normalizeTaskString(finalization.auditAttemptId);
    const current = normalizeTaskString(task.currentRevision);
    if (!finalizedRevision || !finalizedAttempt || !current) return undefined;
    // Only once the task has genuinely moved past the finalized round.
    if (current === finalizedRevision) return undefined;
    const assignments = this.listAssignments(task.taskId);
    const pointer = assignments.find((a) => a.assignmentId === pointerId);
    if (!pointer || pointer.role !== 'integration_owner') return undefined;
    if (!isTerminalSupervisionTaskStatus(pointer.status)) return undefined;
    // The pointer target must be exactly what finalization consumed.
    if (normalizeTaskString(pointer.auditRevision) !== finalizedRevision) return undefined;
    if (normalizeTaskString(pointer.auditAttemptId) !== finalizedAttempt) return undefined;
    // A live owner anywhere means the pointer is still someone's authority.
    if (assignments.some((a) => (
      a.role === 'integration_owner' && !isTerminalSupervisionTaskStatus(a.status)
    ))) return undefined;
    const successors = assignments.filter((a) => (
      a.role === 'implementer' && a.required && !isTerminalSupervisionTaskStatus(a.status)
    ));
    if (successors.length !== 1) return undefined;
    const { integrationOwnerAssignmentId: _cleared, ...withoutPointer } = task;
    this.#writeTask(
      { ...withoutPointer, updatedAt: now },
      this.#taskEventFor(task.status),
      {
        source: 'consumed_finalized_owner_pointer',
        clearedPointer: pointerId,
        finalizedRevision,
        finalizedAuditAttemptId: finalizedAttempt,
      },
    );
    return {
      taskId: task.taskId,
      assignmentId: pointerId,
      action: 'clear_consumed_finalized_owner_pointer',
    };
  }

  #convergeStaleFinalizedOwnerProjection(
    task: PersistedSupervisionTaskRecord,
    now: number,
  ): SupervisionLifecycleConvergenceAction | undefined {
    const finalization = task.finalization;
    if (!finalization) return undefined;
    const revision = normalizeTaskString(finalization.revision);
    if (!revision || task.currentRevision !== revision) return undefined;
    const assignments = this.listAssignments(task.taskId);
    const liveOwners = assignments.filter((assignment) => (
      assignment.role === 'integration_owner'
      && !isTerminalSupervisionTaskStatus(assignment.status)
    ));
    if (liveOwners.length !== 1) return undefined;
    const owner = liveOwners[0]!;
    // R12 audit P1: this previously accepted an owner carrying NO anchor at all
    // and still terminalized it and released its lease. An owner without exact
    // evidence is not demonstrably part of the finalized round -- it may be the
    // next round's owner that simply has not bound yet -- so retiring it
    // destroys live authority on a guess. Require the EXACT revision and
    // attempt finalization recorded; anything else is handed to Brain untouched.
    const ownerRevision = normalizeTaskString(owner.auditRevision);
    const ownerAttempt = normalizeTaskString(owner.auditAttemptId);
    const finalizedAttempt = normalizeTaskString(finalization.auditAttemptId);
    if (!ownerRevision || ownerRevision !== revision) return undefined;
    if (!ownerAttempt || !finalizedAttempt || ownerAttempt !== finalizedAttempt) return undefined;
    const successors = assignments.filter((assignment) => (
      assignment.role === 'implementer'
      && assignment.required
      && !isTerminalSupervisionTaskStatus(assignment.status)
      && !this.#assignmentConsumedByFinalization(task, assignment)
    ));
    if (successors.length !== 1) return undefined;
    if (successors[0]!.assignmentId === owner.assignmentId) return undefined;
    // The lease goes with the projection. A stale owner keeps holding one --
    // that is part of what makes it stale -- so liveness is decided by the
    // finalization evidence, not by the presence of a lease, and releasing it
    // here is what frees the aggregate instead of stranding the claim.
    this.#writeAssignment(
      { ...owner, status: 'finalized', leaseId: '', updatedAt: now },
      'finalized',
      {
        source: 'stale_finalized_owner_projection',
        finalizedRevision: revision,
        finalizedAuditAttemptId: finalization.auditAttemptId,
      },
    );
    return {
      taskId: task.taskId,
      assignmentId: owner.assignmentId,
      action: 'retire_stale_finalized_owner_projection',
    };
  }

  #convergeConsumedFinalizedImplementer(
    task: PersistedSupervisionTaskRecord,
    now: number,
  ): SupervisionLifecycleConvergenceAction | undefined {
    const finalization = task.finalization;
    if (!finalization) return undefined;
    const revision = normalizeTaskString(finalization.revision);
    const attemptId = normalizeTaskString(finalization.auditAttemptId);
    if (!revision || !attemptId) return undefined;
    const implementers = this.listAssignments(task.taskId)
      .filter((assignment) => assignment.role === 'implementer');
    const consumed = implementers.filter((assignment) => (
      (assignment.status === 'ready_for_integration' || assignment.status === 'passed')
      && assignment.auditRevision === revision
      && assignment.auditAttemptId === attemptId
      && assignment.verdict?.trim().toUpperCase() === 'PASS'
      && !assignment.leaseId
    ));
    if (consumed.length !== 1) return undefined;
    const target = consumed[0]!;
    const successors = implementers.filter((assignment) => (
      assignment.assignmentId !== target.assignmentId
      && !isTerminalSupervisionTaskStatus(assignment.status)
      && assignment.auditRevision !== revision
    ));
    if (successors.length === 0) return undefined;
    this.#writeAssignment(
      { ...target, status: 'finalized', updatedAt: now },
      'finalized',
      {
        source: 'consumed_finalized_implementer',
        consumedRevision: revision,
        consumedAuditAttemptId: attemptId,
      },
    );
    return {
      taskId: task.taskId,
      assignmentId: target.assignmentId,
      action: 'retire_consumed_finalized_implementer',
    };
  }

  #convergeConsumedIntegrationSlice(
    task: PersistedSupervisionTaskRecord,
    now: number,
  ): SupervisionLifecycleConvergenceAction | undefined {
    if (task.classification !== 'integration_slice') return undefined;
    const parentId = normalizeTaskString(task.topLevelTaskId);
    if (!parentId || parentId === task.taskId) return undefined;
    const parent = this.getTaskRecord(parentId);
    if (!parent || parent.status !== 'finalized') return undefined;
    const finalization = parent.finalization;
    if (!finalization?.externalRunId || !finalization.externalHeadSha) return undefined;
    const externalHeadSha = finalization.externalHeadSha;

    const delivered = this.listAssignments(task.taskId).filter((assignment) => (
      assignment.role === 'implementer'
      && assignment.externalRunId === finalization.externalRunId
      && assignment.externalHeadSha?.toLowerCase() === externalHeadSha.toLowerCase()
    ));
    if (delivered.length !== 1) return undefined;

    // Reuse the participant cancel path: it is the one atomic lifecycle edge
    // that also clears every stale assignment lease, so no lease can outlive
    // the retired slice.
    const result = this.applyTaskIntent({
      taskId: task.taskId,
      intent: 'cancel',
      toStatus: 'cancelled',
      note: `retired: parent ${parent.taskId} finalized on this slice's delivery evidence`
        + ` (externalRunId ${finalization.externalRunId})`,
      now,
    } as never);
    if (!result.ok) return undefined;
    return {
      taskId: task.taskId,
      assignmentId: delivered[0]!.assignmentId,
      action: 'retire_consumed_slice',
    };
  }

  /**
   * Authorize a caller against a stored assignment, converging a restart-rotated
   * identity for the SAME logical participant.
   *
   * A daemon restart rotates `sessionInstanceId`/`runtimeEpoch` while the
   * participant is unchanged. Strict five-field equality then refused every
   * authorization boundary (task_update, finish, intents) and the object was
   * stranded with no legal way forward -- observed live on tsk_55y, tsk_5oc and
   * tsk_5ns. Convergence repairs exactly that drift and nothing else.
   *
   * It is deliberately narrow: the enclosing task/caller boundary already
   * proves project scope, so only `sessionName` decides durable ownership.
   * Instance, epoch, agent type and provider family are refreshed as
   * observational metadata and never veto a legitimate restart continuation.
   *
   * Returns the identity to persist, or undefined to reject with owner_mismatch.
   */
  #authorizeParticipant(
    existing: PersistedSupervisionTaskAssignment,
    presented: PersistedSupervisionTaskAssignmentIdentity,
  ): PersistedSupervisionTaskAssignmentIdentity | undefined {
    if (!identityMatches(existing.identity, presented)) return undefined;
    // The assignment's task supplies the durable project boundary. Within it,
    // sessionName is the owner; every other field is observational and can
    // rotate or be absent during restart hydration.
    return {
      sessionName: existing.identity.sessionName,
      sessionInstanceId: normalizeTaskString(presented.sessionInstanceId) ?? existing.identity.sessionInstanceId,
      runtimeEpoch: normalizeTaskString(presented.runtimeEpoch) ?? existing.identity.runtimeEpoch,
      agentType: normalizeTaskString(presented.agentType) ?? existing.identity.agentType,
      providerFamily: normalizeTaskString(presented.providerFamily) ?? existing.identity.providerFamily,
    };
  }

  recordFileEvent(input: SupervisionTaskFileEventInput): SupervisionTaskRegistryResult<PersistedSupervisionTaskAssignment> {
    const path = normalizeTaskString(input.path);
    if (!path || !validRepoPath(path)) return { ok: false, reason: 'invalid' };
    const now = input.now ?? Date.now();
    const key = normalizeTaskString(input.idempotencyKey);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const assignment = this.getAssignment(input.assignmentId);
      if (!assignment) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'not_found' };
      }
      if (!identityMatches(assignment.identity, input.identity)) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'owner_mismatch' };
      }
      if (assignment.role === 'auditor') {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'role_forbidden' };
      }
      const idem = key ? `file_event\0${assignment.assignmentId}\0${key}` : '';
      if (idem) {
        const row = this.#db.prepare('SELECT assignment_id AS assignmentId FROM supervision_task_idempotency WHERE idempotency_key = ?').get(idem) as { assignmentId?: unknown } | undefined;
        if (typeof row?.assignmentId === 'string') {
          this.#db.exec('COMMIT');
          return { ok: true, value: assignment, replay: true };
        }
      }
      const task = this.getTaskRecord(assignment.taskId);
      if (!task) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'not_found' };
      }
      const evidenceOnly = scopeEvidenceRoundIsClosed(task, assignment);
      const listedInInitialEvidence = assignment.scopeFiles.includes(path);
      const observedFiles = listedInInitialEvidence
        ? assignment.scopeFiles
        : normalizeTaskArray([...assignment.scopeFiles, path]);
      const auditInvalidated = !evidenceOnly && !listedInInitialEvidence
        && assignmentHasLiveValidationOrAudit(assignment);
      const recorded = !evidenceOnly && !listedInInitialEvidence ? {
        ...assignment,
        scopeFiles: observedFiles,
        generation: assignment.generation + 1,
        ...(auditInvalidated ? {
          status: 'implementing' as const,
          auditAttemptId: undefined,
          auditRevision: undefined,
          verdict: undefined,
          blocker: undefined,
          externalRunId: undefined,
          externalHeadSha: undefined,
          externalTaskId: undefined,
          primaryReviewPassed: undefined,
          crossVendorAuditPassed: undefined,
          auditRoutingReason: undefined,
          auditDegradedReason: undefined,
        } : {}),
        updatedAt: now,
      } : { ...assignment, updatedAt: now };
      this.#db.prepare(`INSERT INTO supervision_task_file_events (task_id, assignment_id, file_path, operation, before_hash, after_hash, tool, source, session_name, session_instance_id, runtime_epoch, agent_type, provider_family, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(assignment.taskId, assignment.assignmentId, path, input.operation, normalizeTaskString(input.beforeHash) ?? null, normalizeTaskString(input.afterHash) ?? null, normalizeTaskString(input.tool) ?? null, normalizeTaskString(input.source) ?? null, input.identity.sessionName, input.identity.sessionInstanceId, input.identity.runtimeEpoch, input.identity.agentType, input.identity.providerFamily, JSON.stringify({ listedInInitialEvidence }), now);
      if (!evidenceOnly && !listedInInitialEvidence) {
        this.#writeAssignment(recorded, 'recovered', {
          source: 'file_event_observed_delivery',
          priorObservedFiles: assignment.scopeFiles,
          observedFiles,
          auditInvalidated,
        });
        if (auditInvalidated) {
          this.#writeTask({ ...task, status: 'implementing', blocker: undefined, updatedAt: now }, 'recovered', {
            source: 'file_event_observed_delivery',
            assignmentId: assignment.assignmentId,
            observedFiles,
            auditInvalidated: true,
          });
        }
      }
      this.#appendEvent(assignment.taskId, assignment.assignmentId, 'file_event', recorded.status, {
        path, operation: input.operation, listedInInitialEvidence, auditInvalidated,
        ...(evidenceOnly ? { terminalEvidenceOnly: true } : {}),
      }, now);
      if (idem) this.#db.prepare('INSERT INTO supervision_task_idempotency (idempotency_key, task_id, assignment_id, created_at) VALUES (?, ?, ?, ?)').run(idem, assignment.taskId, assignment.assignmentId, now);
      this.#db.exec('COMMIT');
      return { ok: true, value: recorded };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  reconcileScope(input: SupervisionTaskScopeReconcileInput): SupervisionTaskRegistryResult<SupervisionTaskSnapshot> {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.getTaskRecord(input.taskId);
      if (!task) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'not_found' };
      }
      const actual = normalizeTaskArray([...(input.trackedPaths ?? []), ...(input.untrackedPaths ?? []), ...(input.deletedPaths ?? [])]);
      const now = input.now ?? Date.now();
      const assignmentFilter = normalizeTaskString(input.assignmentId);
      const assignment = assignmentFilter ? this.getAssignment(assignmentFilter) : undefined;
      if (assignmentFilter && (!assignment || assignment.taskId !== task.taskId || assignment.role === 'auditor')) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: assignment?.role === 'auditor' ? 'role_forbidden' : 'not_found' };
      }
      // Legacy callers reconcile task-wide observations. Preserve that
      // provenance-only behavior, but never rewrite a closed round.
      if (!assignmentFilter) {
        for (const candidate of this.listAssignments(task.taskId)) {
          if (candidate.role === 'auditor' || scopeEvidenceRoundIsClosed(task, candidate)) continue;
          const expanded = normalizeTaskArray([...candidate.scopeFiles, ...actual]);
          if (sameStringArray(expanded, candidate.scopeFiles)) continue;
          this.#writeAssignment({ ...candidate, scopeFiles: expanded, updatedAt: now }, 'file_event', {
            source: 'scope_reconcile_observation', observedPaths: actual,
          });
        }
        const revision = normalizeTaskString(input.currentRevision);
        const updated = revision && revision !== task.currentRevision
          && !SCOPE_EVIDENCE_CLOSED_TASK_STATUSES.has(task.status)
          ? { ...task, currentRevision: revision, updatedAt: now }
          : task;
        if (updated !== task) this.#writeTask(updated, task.status as import('../../shared/supervision-config.js').SupervisionTaskRegistryEventType, {
          source: 'scope_reconcile', observedPaths: actual,
        });
        const snapshot = this.get(task.taskId);
        this.#db.exec('COMMIT');
        return snapshot ? { ok: true, value: snapshot } : { ok: false, reason: 'not_found' };
      }
      if (assignment && scopeEvidenceRoundIsClosed(task, assignment)) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'invalid_transition' };
      }
      const observedSetChanged = Boolean(assignment && !sameStringArray(assignment.scopeFiles, actual));
      const events = this.listFileEvents(task.taskId).filter((event) => !assignmentFilter || event.assignmentId === assignmentFilter);
      const missingHook = actual.find((path) => !events.some((event) => event.path === path));
      if (missingHook) {
        const blocked = { ...task, status: 'blocked' as const, blocker: `missing_hook_event:${missingHook}`, updatedAt: now };
        this.#writeTask(blocked, 'scope_violation', { path: missingHook, source: 'scope_reconcile' });
        this.#db.exec('COMMIT');
        return { ok: false, reason: 'manifest_mismatch' };
      }
      const revision = normalizeTaskString(input.currentRevision);
      const hasLiveValidationOrAudit = Boolean(assignment
        && assignmentHasLiveValidationOrAudit(assignment));
      if (observedSetChanged && hasLiveValidationOrAudit
        && (!revision || revision === task.currentRevision || revision === assignment?.auditRevision)) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'old_revision' };
      }
      if (assignment && observedSetChanged) {
        const invalidated = hasLiveValidationOrAudit;
        const nextAssignment: PersistedSupervisionTaskAssignment = {
          ...assignment,
          scopeFiles: actual,
          generation: assignment.generation + 1,
          ...(invalidated ? {
            status: 'implementing' as const,
            auditAttemptId: undefined,
            verdict: undefined,
            blocker: undefined,
            externalRunId: undefined,
            externalHeadSha: undefined,
            externalTaskId: undefined,
            primaryReviewPassed: undefined,
            crossVendorAuditPassed: undefined,
            auditRoutingReason: undefined,
            auditDegradedReason: undefined,
          } : {}),
          ...(revision ? { auditRevision: revision } : {}),
          updatedAt: now,
        };
        this.#writeAssignment(nextAssignment, 'recovered', {
          source: 'scope_reconcile_observed_delivery',
          priorObservedFiles: assignment.scopeFiles,
          observedFiles: actual,
          auditInvalidated: invalidated,
          ...(revision ? { revision } : {}),
        });
      }
      const taskInvalidated = observedSetChanged && hasLiveValidationOrAudit;
      const updated = revision && revision !== task.currentRevision
        ? { ...task, currentRevision: revision, ...(taskInvalidated ? { status: 'implementing' as const, blocker: undefined } : {}), updatedAt: now }
        : taskInvalidated ? { ...task, status: 'implementing' as const, blocker: undefined, updatedAt: now } : task;
      if (updated !== task) this.#writeTask(updated, taskInvalidated ? 'recovered' : task.status as import('../../shared/supervision-config.js').SupervisionTaskRegistryEventType, {
        source: 'scope_reconcile', observedFiles: actual, auditInvalidated: taskInvalidated,
      });
      const snapshot = this.get(task.taskId);
      this.#db.exec('COMMIT');
      return snapshot ? { ok: true, value: snapshot } : { ok: false, reason: 'not_found' };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  clear(): void {
    if (this.#closed) return;
    this.#db.exec('DELETE FROM supervision_worktree_gc_state; DELETE FROM supervision_task_completion_evidence; DELETE FROM supervision_audit_receipts; DELETE FROM supervision_audit_attestations; DELETE FROM supervision_task_events; DELETE FROM supervision_task_file_events; DELETE FROM supervision_task_file_claims; DELETE FROM supervision_task_idempotency; DELETE FROM supervision_task_assignments; DELETE FROM supervision_tasks;');
  }
}

let supervisionTaskRegistry: SupervisionTaskRegistry | undefined;
let liveParticipantsResolver: SupervisionStateStoreOptions['resolveLiveParticipants'] | undefined;

/**
 * Wire the production live-session view into the singleton registry.
 *
 * Registered from the daemon entrypoint rather than imported here, because the
 * store must not depend on the session layer. Read through a module ref at CALL
 * time so registration order cannot matter: the singleton is created lazily and
 * may exist before the daemon finishes starting.
 */
export function setSupervisionLiveParticipantsResolver(
  resolver: SupervisionStateStoreOptions['resolveLiveParticipants'] | undefined,
): void {
  liveParticipantsResolver = resolver;
}

export function getSupervisionTaskRegistry(): SupervisionTaskRegistry {
  if (supervisionTaskRegistry) return supervisionTaskRegistry;
  supervisionTaskRegistry = new SupervisionTaskRegistry({
    resolveLiveParticipants: (projectName) => liveParticipantsResolver?.(projectName) ?? [],
  });
  return supervisionTaskRegistry;
}

export function resetSupervisionTaskRegistryForTests(): void {
  supervisionTaskRegistry?.close();
  supervisionTaskRegistry = undefined;
}
