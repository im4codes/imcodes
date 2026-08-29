import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  canTransitionSupervisionTaskStatus,
  isSupervisionTaskClassification,
  isSupervisionTaskLifecycleStatus,
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

export interface PersistedSupervisionTaskRecord {
  version: typeof SUPERVISION_TASK_REGISTRY_DB_VERSION;
  taskId: string;
  /** Authoritative project audience. Legacy rows are deliberately unscoped. */
  projectName: string;
  topLevelTaskId: string;
  classification: import('../../shared/supervision-config.js').SupervisionTaskClassification;
  objective: string;
  acceptance: string[];
  integrationOwnerAssignmentId?: string;
  baseRevision?: string;
  currentRevision?: string;
  status: import('../../shared/supervision-config.js').SupervisionTaskLifecycleStatus;
  commitSha?: string;
  pushRemoteRef?: string;
  blocker?: string;
  createdAt: number;
  updatedAt: number;
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
  attemptId: string;
  revision: string;
  verdict: 'PASS' | 'REWORK';
  auditedSessionName: string;
  auditorSessionName: string;
  findings?: string;
  now?: number;
}

export interface SupervisionTaskUpdateInput {
  taskId: string;
  status?: import('../../shared/supervision-config.js').SupervisionTaskLifecycleStatus;
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
}

export type SupervisionTaskRegistryResult<T> =
  | { ok: true; value: T; replay?: boolean }
  | { ok: false; reason: 'invalid' | 'duplicate_task' | 'duplicate_assignment' | 'not_found' | 'invalid_transition' | 'owner_mismatch' | 'old_revision' | 'old_audit_attempt' | 'manifest_mismatch' | 'role_forbidden' | 'ambiguous_assignment' | 'economy_requires_primary_review' };

function stableTaskId(): string { return `supervision_task_${randomUUID()}`; }
function stableAssignmentId(): string { return `supervision_assignment_${randomUUID()}`; }
function stableLeaseId(): string { return `supervision_lease_${randomUUID()}`; }

function normalizeTaskString(value: string | number | null | undefined): string | undefined {
  const text = typeof value === 'number' ? String(value) : value?.trim();
  return text ? text : undefined;
}

function normalizeTaskArray(values: readonly string[] | null | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();
}

function validRepoPath(path: string): boolean {
  return Boolean(path) && !path.startsWith('/') && !path.split('/').includes('..') && !/[\u0000-\u001f\u007f]/.test(path);
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
  return payload as unknown as PersistedSupervisionTaskRecord;
}

function parseAssignmentRow(row: Record<string, unknown>): PersistedSupervisionTaskAssignment | undefined {
  const payload = safeJsonParseObject(typeof row.payloadJson === 'string' ? row.payloadJson : undefined);
  if (!payload || payload.version !== SUPERVISION_TASK_REGISTRY_DB_VERSION) return undefined;
  return payload as unknown as PersistedSupervisionTaskAssignment;
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

function identityMatches(left: PersistedSupervisionTaskAssignmentIdentity, right: PersistedSupervisionTaskAssignmentIdentity): boolean {
  return left.sessionName === right.sessionName
    && left.sessionInstanceId === right.sessionInstanceId
    && left.runtimeEpoch === right.runtimeEpoch
    && left.agentType === right.agentType
    && left.providerFamily === right.providerFamily;
}

export class SupervisionTaskRegistry {
  readonly #db: DatabaseSyncInstance;
  readonly #ownsDb: boolean;
  #closed = false;

  constructor(options: SupervisionStateStoreOptions = {}) {
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
      CREATE TABLE IF NOT EXISTS supervision_tasks (
        task_id TEXT PRIMARY KEY,
        project_name TEXT,
        top_level_task_id TEXT NOT NULL,
        classification TEXT NOT NULL,
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
    this.#reconcileCancelledTaskResources();
  }

  /** Atomically repair rows left by the legacy task-only cancel write. */
  #reconcileCancelledTaskResources(): void {
    const taskIds = (this.#db.prepare(
      "SELECT task_id AS taskId FROM supervision_tasks WHERE status = 'cancelled' ORDER BY task_id",
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


  close(): void { if (this.#ownsDb && !this.#closed) this.#db.close(); this.#closed = true; }

  #appendEvent(taskId: string, assignmentId: string | undefined, eventType: import('../../shared/supervision-config.js').SupervisionTaskRegistryEventType, status: import('../../shared/supervision-config.js').SupervisionTaskLifecycleStatus, payload: Record<string, unknown> | undefined, now: number): void {
    this.#db.prepare(`INSERT INTO supervision_task_events (task_id, assignment_id, event_type, status, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(taskId, assignmentId ?? null, eventType, status, payload ? JSON.stringify(payload) : null, now);
  }

  #writeTask(record: PersistedSupervisionTaskRecord, eventType: import('../../shared/supervision-config.js').SupervisionTaskRegistryEventType, payload?: Record<string, unknown>): void {
    this.#db.prepare(`
      INSERT INTO supervision_tasks (task_id, project_name, top_level_task_id, classification, status, current_revision, commit_sha, push_remote_ref, blocker, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        project_name=excluded.project_name, top_level_task_id=excluded.top_level_task_id, classification=excluded.classification, status=excluded.status,
        current_revision=excluded.current_revision, commit_sha=excluded.commit_sha, push_remote_ref=excluded.push_remote_ref,
        blocker=excluded.blocker, payload_json=excluded.payload_json, updated_at=excluded.updated_at
    `).run(record.taskId, record.projectName, record.topLevelTaskId, record.classification, record.status, record.currentRevision ?? null, record.commitSha ?? null, record.pushRemoteRef ?? null, record.blocker ?? null, JSON.stringify(record), record.createdAt, record.updatedAt);
    this.#appendEvent(record.taskId, undefined, eventType, record.status, payload, record.updatedAt);
  }

  #writeAssignment(record: PersistedSupervisionTaskAssignment, eventType: import('../../shared/supervision-config.js').SupervisionTaskRegistryEventType, payload?: Record<string, unknown>): void {
    const identity = record.identity;
    this.#db.prepare(`
      INSERT INTO supervision_task_assignments (assignment_id, task_id, role, status, session_name, session_instance_id, runtime_epoch, agent_type, provider_family, lease_id, generation, audit_attempt_id, audit_revision, verdict, blocker, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(assignment_id) DO UPDATE SET
        role=excluded.role, status=excluded.status, session_name=excluded.session_name, session_instance_id=excluded.session_instance_id,
        runtime_epoch=excluded.runtime_epoch, agent_type=excluded.agent_type, provider_family=excluded.provider_family,
        lease_id=excluded.lease_id, generation=excluded.generation, audit_attempt_id=excluded.audit_attempt_id,
        audit_revision=excluded.audit_revision, verdict=excluded.verdict, blocker=excluded.blocker,
        payload_json=excluded.payload_json, updated_at=excluded.updated_at
    `).run(record.assignmentId, record.taskId, record.role, record.status, identity.sessionName, identity.sessionInstanceId, identity.runtimeEpoch, identity.agentType, identity.providerFamily, record.leaseId, record.generation, record.auditAttemptId ?? null, record.auditRevision ?? null, record.verdict ?? null, record.blocker ?? null, JSON.stringify(record), record.createdAt, record.updatedAt);
    this.#appendEvent(record.taskId, record.assignmentId, eventType, record.status, payload, record.updatedAt);
  }

  get(taskId: string): SupervisionTaskSnapshot | undefined {
    const task = this.getTaskRecord(taskId);
    if (!task) return undefined;
    const assignments = this.listAssignments(taskId);
    const fileClaims = this.listFileClaims(taskId);
    const touchedFiles = [...new Set(this.listFileEvents(taskId).map((event) => event.path))].sort();
    return { ...task, assignments, fileClaims, touchedFiles };
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

  list(filter: { status?: import('../../shared/supervision-config.js').SupervisionTaskLifecycleStatus; topLevelTaskId?: string; ownerSessionName?: string; projectName?: string } = {}): SupervisionTaskSnapshot[] {
    if (this.#closed) return [];
    let sql = 'SELECT DISTINCT t.payload_json AS payloadJson FROM supervision_tasks t LEFT JOIN supervision_task_assignments a ON a.task_id = t.task_id WHERE 1=1';
    const params: string[] = [];
    if (filter.projectName) { sql += ' AND t.project_name = ?'; params.push(filter.projectName); }
    if (filter.status) { sql += ' AND t.status = ?'; params.push(filter.status); }
    if (filter.topLevelTaskId) { sql += ' AND t.top_level_task_id = ?'; params.push(filter.topLevelTaskId); }
    if (filter.ownerSessionName) { sql += ' AND a.session_name = ?'; params.push(filter.ownerSessionName); }
    sql += ' ORDER BY t.updated_at ASC';
    return (this.#db.prepare(sql).all(...params) as Array<Record<string, unknown>>)
      .map(parseTaskRow)
      .filter((record): record is PersistedSupervisionTaskRecord => record !== undefined)
      .map((record) => this.get(record.taskId))
      .filter((record): record is SupervisionTaskSnapshot => record !== undefined);
  }

  listAssignments(taskId: string): PersistedSupervisionTaskAssignment[] {
    if (this.#closed) return [];
    return (this.#db.prepare('SELECT payload_json AS payloadJson FROM supervision_task_assignments WHERE task_id = ? ORDER BY created_at ASC').all(taskId) as Array<Record<string, unknown>>)
      .map(parseAssignmentRow)
      .filter((record): record is PersistedSupervisionTaskAssignment => record !== undefined);
  }

  listFileClaims(taskId: string): PersistedSupervisionTaskFileClaim[] {
    void taskId;
    return [];
  }

  listEvents(taskId: string): PersistedSupervisionTaskEvent[] {
    if (this.#closed) return [];
    return (this.#db.prepare('SELECT id, task_id AS taskId, assignment_id AS assignmentId, event_type AS eventType, status, payload_json AS payloadJson, created_at AS createdAt FROM supervision_task_events WHERE task_id = ? ORDER BY id ASC').all(taskId) as Array<Record<string, unknown>>).map(parseEventRow);
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
    const proposedTaskKey = normalizeTaskString(input.semanticTaskKey);
    let taskId: string;
    if (proposedTaskKey) {
      // Daemon-minted: typed prefix + validated key + daemon entropy.
      const minted = mintSupervisionId(
        { kind: 'task', semanticKey: proposedTaskKey },
        { exists: (id) => !!this.getTaskRecord(id) },
      );
      if (!minted.ok) return { ok: false, reason: 'invalid' };
      taskId = minted.id;
    } else {
      taskId = normalizeTaskString(input.taskId) ?? stableTaskId();
    }
    if (this.getTaskRecord(taskId)) return { ok: false, reason: 'duplicate_task' };
    const classification = input.classification ?? 'integration_slice';
    if (!isSupervisionTaskClassification(classification)) return { ok: false, reason: 'invalid' };
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
      ...(normalizeTaskString(input.baseRevision) ? { baseRevision: normalizeTaskString(input.baseRevision) } : {}),
      ...(normalizeTaskString(input.currentRevision) ? { currentRevision: normalizeTaskString(input.currentRevision) } : {}),
      status: 'planned',
      createdAt: now,
      updatedAt: now,
    };
    this.#db.exec('BEGIN IMMEDIATE');
    try {
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
    const proposedAssignmentKey = normalizeTaskString(input.semanticAssignmentKey);
    let assignmentId: string;
    if (proposedAssignmentKey) {
      const minted = mintSupervisionId(
        { kind: 'assignment', semanticKey: proposedAssignmentKey },
        { exists: (id) => !!this.getAssignment(id) },
      );
      if (!minted.ok) return { ok: false, reason: 'invalid' };
      assignmentId = minted.id;
    } else {
      assignmentId = normalizeTaskString(input.assignmentId) ?? stableAssignmentId();
    }
    if (this.getAssignment(assignmentId)) return { ok: false, reason: 'duplicate_assignment' };
    if (!['coordinator','integration_owner','implementer','auditor'].includes(input.role)) return { ok: false, reason: 'invalid' };
    const scopeFiles = normalizeTaskArray(input.scopeFiles);
    if (!scopeFiles.every(validRepoPath)) return { ok: false, reason: 'invalid' };
    const record: PersistedSupervisionTaskAssignment = {
      version: SUPERVISION_TASK_REGISTRY_DB_VERSION,
      assignmentId,
      taskId: task.taskId,
      role: input.role,
      identity: input.identity,
      scopeFiles,
      required: input.required !== false,
      status: 'delegated',
      leaseId: stableLeaseId(),
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
    this.#db.exec('BEGIN IMMEDIATE');
    try {
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
    const record: PersistedSupervisionTaskRecord = {
      ...existing,
      status: nextStatus,
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
    if (!identityMatches(existing.identity, input.identity)) return { ok: false, reason: 'owner_mismatch' };
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
    if (!isNewAuditAfterRework && input.auditAttemptId && existing.auditAttemptId && input.auditAttemptId !== existing.auditAttemptId) return { ok: false, reason: 'old_audit_attempt' };
    if (!isNewAuditAfterRework && input.revision !== undefined && existing.auditRevision && String(input.revision ?? '') !== existing.auditRevision) return { ok: false, reason: 'old_revision' };
    const now = input.now ?? Date.now();
    const record: PersistedSupervisionTaskAssignment = {
      ...existing,
      status: nextStatus,
      auditAttemptId: normalizeTaskString(input.auditAttemptId) ?? existing.auditAttemptId,
      auditRevision: normalizeTaskString(input.auditRevision) ?? existing.auditRevision,
      verdict: normalizeTaskString(input.verdict) ?? (nextStatus === 'auditing' ? undefined : existing.verdict),
      blocker: normalizeTaskString(input.blocker)
        ?? (nextStatus === 'auditing' || nextStatus === 'passed' || nextStatus === 'ready_for_integration' ? undefined : existing.blocker),
      externalRunId: normalizeTaskString(input.externalRunId) ?? existing.externalRunId,
      externalHeadSha: normalizeTaskString(input.externalHeadSha) ?? existing.externalHeadSha,
      externalTaskId: normalizeTaskString(input.externalTaskId) ?? existing.externalTaskId,
      primaryReviewPassed: input.primaryReviewPassed ?? existing.primaryReviewPassed,
      crossVendorAuditPassed: input.crossVendorAuditPassed ?? existing.crossVendorAuditPassed,
      auditRoutingReason: input.auditRoutingReason ?? existing.auditRoutingReason,
      updatedAt: now,
    };
    const eventType = nextStatus === 'auditing' ? 'audit_requested'
      : nextStatus === 'passed' || nextStatus === 'rework' ? 'audit_replied'
      : nextStatus;
    this.#writeAssignment(record, eventType as import('../../shared/supervision-config.js').SupervisionTaskRegistryEventType, {
      source: 'assignment_update',
      ...(record.auditRoutingReason ? { auditRoutingReason: record.auditRoutingReason } : {}),
    });
    this.#deriveTaskStatus(record.taskId, now);
    return { ok: true, value: record };
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
  finishAssignment(input: SupervisionTaskAssignmentFinishInput): SupervisionTaskRegistryResult<PersistedSupervisionTaskAssignment> {
    const existing = this.getAssignment(input.assignmentId);
    if (!existing) return { ok: false, reason: 'not_found' };
    if (!identityMatches(existing.identity, input.identity)) return { ok: false, reason: 'owner_mismatch' };
    const task = this.getTaskRecord(existing.taskId);
    if (!task) return { ok: false, reason: 'not_found' };
    const requestedRevision = normalizeTaskString(input.revision);
    const assignments = this.listAssignments(existing.taskId);

    let targetStatus: SupervisionTaskLifecycleStatus;
    let matchingAudit: PersistedSupervisionTaskAssignment | undefined;
    if (existing.role === 'auditor') {
      const verdict = existing.verdict?.trim().toUpperCase();
      if ((verdict !== 'PASS' && verdict !== 'REWORK')
        || !existing.auditAttemptId || !existing.auditRevision
        || (requestedRevision && requestedRevision !== existing.auditRevision)) {
        return { ok: false, reason: requestedRevision ? 'old_revision' : 'invalid_transition' };
      }
      targetStatus = 'finalized';
    } else if (existing.status === 'pushed') {
      targetStatus = 'finalized';
    } else {
      const revision = requestedRevision ?? normalizeTaskString(task.currentRevision);
      if (!revision) return { ok: false, reason: 'old_revision' };
      matchingAudit = assignments.find((assignment) => (
        assignment.role === 'auditor'
        && assignment.verdict?.trim().toUpperCase() === 'PASS'
        && Boolean(assignment.auditAttemptId)
        && assignment.auditRevision === revision
      ));
      if (!matchingAudit) return { ok: false, reason: 'old_revision' };
      if (!mayFinalizeEconomyAssignment({
        pool: existing.executionBinding?.pool,
        primaryReviewPassed: existing.primaryReviewPassed === true,
        crossVendorAuditPassed: true,
      })) return { ok: false, reason: 'economy_requires_primary_review' };
      targetStatus = 'ready_for_integration';
    }

    const alreadyApplied = existing.status === targetStatus && !existing.leaseId;
    if (alreadyApplied) return { ok: true, value: existing, replay: true };

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
      this.#writeAssignment(record, targetStatus === 'ready_for_integration' ? 'ready_for_integration' : 'finalized', {
        source: 'assignment_finish',
        leaseRevoked: true,
        ...(matchingAudit ? {
          matchingAuditAssignmentId: matchingAudit.assignmentId,
          auditAttemptId: matchingAudit.auditAttemptId,
          auditRevision: matchingAudit.auditRevision,
        } : {}),
        ...(normalizeTaskString(input.evidence) ? { evidence: normalizeTaskString(input.evidence) } : {}),
      });
      this.#deriveTaskStatus(existing.taskId, now);
      this.#db.exec('COMMIT');
      return { ok: true, value: record };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Persist a capability-validated, revision-matching peer-audit receipt.
   *
   * This is the authority bridge the old implementation lacked: the audit
   * controller could report PASS while the registry assignment remained
   * `delegated` forever. The receipt locates its auditor assignment by the
   * daemon-minted attempt id, binds the audited live session and exact revision,
   * records one durable attestation, and advances the audited assignment through
   * every legal lifecycle edge. UI code never derives or guesses this state.
   */
  applyMatchingAuditReceipt(
    input: SupervisionMatchingAuditReceiptInput,
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
    const candidates = this.listAssignments(task.taskId).filter((assignment) => (
      assignment.role !== 'auditor'
      && assignment.identity.sessionName === auditedSessionName
    ));
    if (candidates.length === 0) return { ok: false, reason: 'not_found' };
    if (candidates.length !== 1) return { ok: false, reason: 'ambiguous_assignment' };
    const target = candidates[0]!;
    const expectedRevision = auditAssignment.auditRevision ?? target.auditRevision ?? task.currentRevision;
    if (!expectedRevision || expectedRevision !== revision
      || (auditAssignment.auditRevision !== undefined && auditAssignment.auditRevision !== revision)
      || (target.auditRevision !== undefined && target.auditRevision !== revision)
      || (task.currentRevision !== undefined && task.currentRevision !== revision)) {
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
    const toAuditing: Partial<Record<SupervisionTaskLifecycleStatus, SupervisionTaskLifecycleStatus[]>> = {
      delegated: ['auditing'],
      implementing: ['validated', 'ready_for_audit', 'auditing'],
      retrying_external_ci: ['validated', 'ready_for_audit', 'auditing'],
      validated: ['ready_for_audit', 'auditing'],
      ready_for_audit: ['auditing'],
      rework: ['auditing'],
      auditing: [],
    };
    const transition = (
      assignment: PersistedSupervisionTaskAssignment,
      terminal: 'passed' | 'ready_for_integration' | 'rework',
    ): PersistedSupervisionTaskAssignment | undefined => {
      let current = assignment;
      const steps = [...(toAuditing[current.status] ?? [])];
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
    const required = this.listAssignments(taskId).filter((assignment) => assignment.required && assignment.role !== 'auditor');
    if (required.length === 0) return;
    const next = required.every((assignment) => assignment.status === 'finalized')
      ? 'finalized'
      : required.every((assignment) => assignment.status === 'recovered' || assignment.status === 'finalized')
        ? 'recovered'
        : required.every((assignment) => assignment.status === 'ready_for_integration' || assignment.status === 'passed')
          ? 'ready_for_integration'
          : required.some((assignment) => assignment.status === 'rework')
            ? 'rework'
            : required.some((assignment) => assignment.status === 'blocked')
              ? 'blocked'
              : required.some((assignment) => assignment.status === 'retrying_external_ci')
                ? 'retrying_external_ci'
                : task.status;
    if (next !== task.status && canTransitionSupervisionTaskStatus(task.status, next)) {
      const aggregateEvent = next === 'ready_for_integration' ? 'ready_for_integration'
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
  }): SupervisionTaskRegistryResult<PersistedSupervisionTaskRecord> {
    const task = this.getTaskRecord(input.taskId);
    if (!task) return { ok: false, reason: 'not_found' };
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
    const taskChanges = Boolean(input.toStatus && input.toStatus !== task.status);
    const assignmentChanges = Boolean(assignment && assignmentTarget && assignmentTarget !== assignment.status);
    // Heartbeat/checkpoint and an already-applied synchronized intent are true
    // idempotent no-ops.
    if (!taskChanges && !assignmentChanges) return { ok: true, value: task, replay: true };

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
      if (assignment && assignmentTarget && assignmentTarget !== assignment.status) {
        this.#writeAssignment({ ...assignment, status: assignmentTarget, updatedAt: now }, this.#taskEventFor(assignmentTarget), {
          source: 'task_intent_assignment_sync',
          intent: input.intent,
          validationState: input.validationState,
        });
      }
      if (taskChanges) {
        this.#writeTask(record, this.#taskEventFor(input.toStatus!), {
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
    // Administrative cancellation uses the same atomic lifecycle path as a
    // participant cancel so stale delegated leases cannot survive after the
    // task itself is terminal.
    if (input.toStatus === 'cancelled') {
      return this.applyTaskIntent({
        taskId: input.taskId,
        intent: 'cancel',
        toStatus: 'cancelled',
        note: input.reason,
      });
    }
    const record: PersistedSupervisionTaskRecord = {
      ...task,
      status: input.toStatus,
      updatedAt: Date.now(),
      ...(input.toStatus === 'blocked' ? { blocker: input.reason } : {}),
    };
    this.#writeTask(record, this.#taskEventFor(input.toStatus), {
      source: 'admin_recovery', reason: input.reason, status: input.toStatus,
    });
    return { ok: true, value: record };
  }

  recordFileEvent(input: SupervisionTaskFileEventInput): SupervisionTaskRegistryResult<PersistedSupervisionTaskAssignment> {
    const assignment = this.getAssignment(input.assignmentId);
    if (!assignment) return { ok: false, reason: 'not_found' };
    if (!identityMatches(assignment.identity, input.identity)) return { ok: false, reason: 'owner_mismatch' };
    if (assignment.role === 'auditor') return { ok: false, reason: 'role_forbidden' };
    const path = normalizeTaskString(input.path);
    if (!path || !validRepoPath(path)) return { ok: false, reason: 'invalid' };
    const now = input.now ?? Date.now();
    const key = normalizeTaskString(input.idempotencyKey);
    const idem = key ? `file_event\0${assignment.assignmentId}\0${key}` : '';
    if (idem) {
      const row = this.#db.prepare('SELECT assignment_id AS assignmentId FROM supervision_task_idempotency WHERE idempotency_key = ?').get(idem) as { assignmentId?: unknown } | undefined;
      if (typeof row?.assignmentId === 'string') return { ok: true, value: assignment, replay: true };
    }
    const declaredInAssignment = assignment.scopeFiles.includes(path);
    this.#db.prepare(`INSERT INTO supervision_task_file_events (task_id, assignment_id, file_path, operation, before_hash, after_hash, tool, source, session_name, session_instance_id, runtime_epoch, agent_type, provider_family, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(assignment.taskId, assignment.assignmentId, path, input.operation, normalizeTaskString(input.beforeHash) ?? null, normalizeTaskString(input.afterHash) ?? null, normalizeTaskString(input.tool) ?? null, normalizeTaskString(input.source) ?? null, input.identity.sessionName, input.identity.sessionInstanceId, input.identity.runtimeEpoch, input.identity.agentType, input.identity.providerFamily, JSON.stringify({ declaredInAssignment }), now);
    this.#appendEvent(assignment.taskId, assignment.assignmentId, 'file_event', assignment.status, { path, operation: input.operation, declaredInAssignment }, now);
    if (idem) this.#db.prepare('INSERT INTO supervision_task_idempotency (idempotency_key, task_id, assignment_id, created_at) VALUES (?, ?, ?, ?)').run(idem, assignment.taskId, assignment.assignmentId, now);
    return { ok: true, value: { ...assignment, updatedAt: now } };
  }

  reconcileScope(input: SupervisionTaskScopeReconcileInput): SupervisionTaskRegistryResult<SupervisionTaskSnapshot> {
    const task = this.getTaskRecord(input.taskId);
    if (!task) return { ok: false, reason: 'not_found' };
    const declared = new Set(this.listAssignments(task.taskId).flatMap((assignment) => assignment.scopeFiles));
    const actual = normalizeTaskArray([...(input.trackedPaths ?? []), ...(input.untrackedPaths ?? []), ...(input.deletedPaths ?? [])]);
    const extra = actual.find((path) => !declared.has(path));
    const now = input.now ?? Date.now();
    if (extra) {
      const blocked = { ...task, status: 'blocked' as const, blocker: `unattributed_drift:${extra}`, updatedAt: now };
      this.#writeTask(blocked, 'scope_violation', { path: extra, source: 'scope_reconcile' });
      return { ok: false, reason: 'manifest_mismatch' };
    }
    const assignmentFilter = normalizeTaskString(input.assignmentId);
    const events = this.listFileEvents(task.taskId).filter((event) => !assignmentFilter || event.assignmentId === assignmentFilter);
    const missingHook = actual.find((path) => !events.some((event) => event.path === path));
    if (missingHook) {
      const blocked = { ...task, status: 'blocked' as const, blocker: `missing_hook_event:${missingHook}`, updatedAt: now };
      this.#writeTask(blocked, 'scope_violation', { path: missingHook, source: 'scope_reconcile' });
      return { ok: false, reason: 'manifest_mismatch' };
    }
    const revision = normalizeTaskString(input.currentRevision);
    const updated = revision && revision !== task.currentRevision ? { ...task, currentRevision: revision, updatedAt: now } : task;
    if (updated !== task) this.#writeTask(updated, task.status as import('../../shared/supervision-config.js').SupervisionTaskRegistryEventType, { source: 'scope_reconcile' });
    const snapshot = this.get(task.taskId);
    return snapshot ? { ok: true, value: snapshot } : { ok: false, reason: 'not_found' };
  }

  clear(): void {
    if (this.#closed) return;
    this.#db.exec('DELETE FROM supervision_audit_attestations; DELETE FROM supervision_task_events; DELETE FROM supervision_task_file_events; DELETE FROM supervision_task_file_claims; DELETE FROM supervision_task_idempotency; DELETE FROM supervision_task_assignments; DELETE FROM supervision_tasks;');
  }
}

let supervisionTaskRegistry: SupervisionTaskRegistry | undefined;

export function getSupervisionTaskRegistry(): SupervisionTaskRegistry {
  if (supervisionTaskRegistry) return supervisionTaskRegistry;
  supervisionTaskRegistry = new SupervisionTaskRegistry();
  return supervisionTaskRegistry;
}

export function resetSupervisionTaskRegistryForTests(): void {
  supervisionTaskRegistry?.close();
  supervisionTaskRegistry = undefined;
}
