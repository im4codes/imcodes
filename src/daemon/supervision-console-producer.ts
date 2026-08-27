/**
 * Transactional supervision console producer.
 *
 * Writes the task event, the console projection cursor and the durable outbox
 * frame inside ONE SQLite transaction, then broadcasts. That ordering is the
 * whole point: a crash before commit persists nothing, and a crash after commit
 * but before broadcast leaves the frame `pending`, so restart redelivers it.
 * Nothing is ever reconstructed from chat context or model recollection.
 *
 * Crash boundaries are INJECTED (see `CrashBoundary`), not documented. Tests
 * throw at a named boundary and assert the durable state that results, which is
 * the only way to show the transaction actually holds.
 */
import {
  SUPERVISION_TASK_CONSOLE_MSG,
  SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
  supervisionConsoleStatusGroup,
  type SupervisionConsoleDeltaOp,
  type SupervisionTaskConsoleDelta,
  type SupervisionTaskConsoleScope,
  type SupervisionTaskConsoleSnapshot,
  type SupervisionTaskConsoleTaskRow,
  type SupervisionTaskConsoleAssignmentRow,
  type SupervisionTaskConsolePoolRow,
  type SupervisionConsoleValidationState,
  SUPERVISION_CONSOLE_VALIDATION_STATES,
} from '../../shared/supervision-task-console.js';
import {
  DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS,
  SUPERVISION_EXECUTION_POOL_KINDS,
  type SupervisionExecutionPoolKind,
} from '../../shared/supervision-execution-pool.js';
import {
  isSupervisionTaskLifecycleStatus,
  SUPERVISION_TASK_STATUS_CONTRACT_VERSION,
  type SupervisionTaskLifecycleStatus,
} from '../../shared/supervision-config.js';
import {
  decideSupervisionAuditHandoff,
  type SupervisionAuditReceipt,
  type SupervisionHandoffDecision,
} from '../../shared/supervision-audit-handoff.js';
import type { SupervisionMigrationDb } from './supervision-store-migrations.js';

/** Named points a test can throw from to simulate a real crash. */
export const SUPERVISION_CRASH_BOUNDARIES = [
  'after_event_insert',
  'after_projection_update',
  'after_outbox_insert',
  'before_commit',
  'after_commit_before_broadcast',
  'after_broadcast_before_ack',
] as const;
export type SupervisionCrashBoundary = typeof SUPERVISION_CRASH_BOUNDARIES[number];

export interface SupervisionProducerOptions {
  projectionEpoch: string;
  now?: () => number;
  /** Throwing from here simulates a crash at that exact boundary. */
  onBoundary?: (boundary: SupervisionCrashBoundary) => void;
  /** Delivery sink. Absent means "durable only", which restart will redeliver. */
  broadcast?: (frame: SupervisionTaskConsoleDelta) => void;
}

export interface SupervisionOutboxRow {
  id: number;
  projectName: string;
  coordinatorSessionName: string;
  eventId: number;
  projectionVersion: number;
  projectionEpoch: string;
  frame: SupervisionTaskConsoleDelta;
  deliveryState: 'pending' | 'sent' | 'acked' | 'failed';
  attempts: number;
}

export interface SupervisionTaskEventInput {
  scope: SupervisionTaskConsoleScope;
  taskId: string;
  assignmentId?: string;
  eventType: string;
  status: SupervisionTaskLifecycleStatus;
  op?: SupervisionConsoleDeltaOp;
  payload?: Record<string, unknown>;
}

function readValidationState(value: unknown): SupervisionConsoleValidationState {
  return typeof value === 'string'
    && (SUPERVISION_CONSOLE_VALIDATION_STATES as readonly string[]).includes(value)
    ? value as SupervisionConsoleValidationState
    : 'unknown';
}

function readPoolKind(value: unknown): SupervisionExecutionPoolKind | undefined {
  return typeof value === 'string'
    && (SUPERVISION_EXECUTION_POOL_KINDS as readonly string[]).includes(value)
    ? value as SupervisionExecutionPoolKind
    : undefined;
}

export class SupervisionConsoleProducer {
  readonly #db: SupervisionMigrationDb;
  readonly #epoch: string;
  readonly #now: () => number;
  readonly #onBoundary: (boundary: SupervisionCrashBoundary) => void;
  readonly #broadcast?: (frame: SupervisionTaskConsoleDelta) => void;

  constructor(db: SupervisionMigrationDb, options: SupervisionProducerOptions) {
    this.#db = db;
    this.#epoch = options.projectionEpoch;
    this.#now = options.now ?? (() => 0);
    this.#onBoundary = options.onBoundary ?? (() => {});
    this.#broadcast = options.broadcast;
  }

  #transaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#onBoundary('before_commit');
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Reserve the next dense projection version for a scope.
   *
   * Restored from SQLite, so a restart continues the sequence instead of
   * restarting it — that is what lets a reconnecting browser keep its cursor.
   */
  #nextProjectionVersion(scope: SupervisionTaskConsoleScope, eventId: number): number {
    const row = this.#db.prepare(
      `SELECT projection_version AS v, projection_epoch AS e FROM supervision_projection_state
       WHERE project_name = ? AND coordinator_session_name = ?`,
    ).get(scope.projectName, scope.coordinatorSessionName) as { v?: number; e?: string } | undefined;
    const next = Number(row?.v ?? 0) + 1;
    this.#db.prepare(
      `INSERT INTO supervision_projection_state
        (project_name, coordinator_session_name, projection_version, projection_epoch, last_durable_event_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_name, coordinator_session_name) DO UPDATE SET
         projection_version = excluded.projection_version,
         projection_epoch = excluded.projection_epoch,
         last_durable_event_id = excluded.last_durable_event_id,
         updated_at = excluded.updated_at`,
    ).run(scope.projectName, scope.coordinatorSessionName, next, this.#epoch, eventId, this.#now());
    return next;
  }

  /**
   * Append one task event and its console frame atomically.
   *
   * Returns the durable ids. If this throws, nothing was written.
   */
  appendTaskEvent(input: SupervisionTaskEventInput): { eventId: number; projectionVersion: number } {
    const committed = this.#transaction(() => {
      this.#db.prepare(
        `INSERT INTO supervision_task_events (task_id, assignment_id, event_type, status, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(input.taskId, input.assignmentId ?? null, input.eventType, input.status,
        JSON.stringify(input.payload ?? {}), this.#now());
      const eventId = Number((this.#db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
      this.#onBoundary('after_event_insert');

      const projectionVersion = this.#nextProjectionVersion(input.scope, eventId);
      this.#onBoundary('after_projection_update');

      const frame = this.#buildDelta(input, eventId, projectionVersion);
      this.#db.prepare(
        `INSERT INTO supervision_outbox
          (project_name, coordinator_session_name, event_id, projection_version, projection_epoch,
           frame_json, delivery_state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(input.scope.projectName, input.scope.coordinatorSessionName, eventId, projectionVersion,
        this.#epoch, JSON.stringify(frame), this.#now(), this.#now());
      this.#onBoundary('after_outbox_insert');
      return { eventId, projectionVersion, frame };
    });

    // Past this line the state is durable. A crash here loses no data: the
    // frame is still `pending` and restart redelivers it.
    this.#onBoundary('after_commit_before_broadcast');
    this.#deliver(committed.frame, committed.projectionVersion, input.scope);
    return { eventId: committed.eventId, projectionVersion: committed.projectionVersion };
  }

  #buildDelta(
    input: SupervisionTaskEventInput,
    eventId: number,
    projectionVersion: number,
  ): SupervisionTaskConsoleDelta {
    const op: SupervisionConsoleDeltaOp = input.op ?? 'task_upsert';
    const base = {
      type: SUPERVISION_TASK_CONSOLE_MSG.DELTA,
      scope: input.scope,
      subscriptionId: '',
      schemaVersion: SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
      statusContractVersion: SUPERVISION_TASK_STATUS_CONTRACT_VERSION,
      projectionVersion,
      lastDurableEventId: eventId,
      projectionEpoch: this.#epoch,
      eventId,
      op,
    } as SupervisionTaskConsoleDelta;
    if (op === 'task_upsert') {
      const row = this.readTaskRow(input.taskId, eventId);
      if (row) base.task = row;
    }
    return base;
  }

  /** Project one durable task row into its browser-safe shape. */
  readTaskRow(taskId: string, lastEventId?: number): SupervisionTaskConsoleTaskRow | undefined {
    const row = this.#db.prepare(
      `SELECT task_id, top_level_task_id, status, semantic_key, integration_owner, next_action,
              blocked_reason, recovery_state, recovery_reason, last_durable_event_id, updated_at,
              validation_state, heartbeat_at
       FROM supervision_tasks WHERE task_id = ?`,
    ).get(taskId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const status = String(row.status ?? '');
    // Fail closed: never project a status the contract does not know.
    if (!isSupervisionTaskLifecycleStatus(status)) return undefined;
    return {
      taskId: String(row.task_id),
      topLevelTaskId: row.top_level_task_id ? String(row.top_level_task_id) : undefined,
      semanticKey: row.semantic_key ? String(row.semantic_key) : undefined,
      title: String(row.task_id),
      status,
      phase: supervisionConsoleStatusGroup(status),
      validationState: readValidationState(row.validation_state),
      heartbeatAt: row.heartbeat_at === null || row.heartbeat_at === undefined
        ? undefined : Number(row.heartbeat_at),
      nextAction: row.next_action ? String(row.next_action) : undefined,
      blocker: row.blocked_reason ? String(row.blocked_reason) : undefined,
      recoveryState: row.recovery_state ? String(row.recovery_state) : undefined,
      recoveryReason: row.recovery_reason ? String(row.recovery_reason) : undefined,
      updatedAt: Number(row.updated_at ?? 0),
      lastEventId: lastEventId ?? Number(row.last_durable_event_id ?? 0),
    };
  }

  /** Project every assignment into its browser-safe row. */
  readAssignmentRows(): SupervisionTaskConsoleAssignmentRow[] {
    const rows = this.#db.prepare(
      `SELECT assignment_id, task_id, role, status, session_name, agent_type, provider_family,
              pool_kind, validation_state, observed_model, observed_provider, heartbeat_at,
              audit_attempt_id, verdict, blocker, next_action,
              recovery_state, recovery_reason, last_durable_event_id, updated_at
       FROM supervision_task_assignments ORDER BY assignment_id ASC`,
    ).all() as Array<Record<string, unknown>>;
    const out: SupervisionTaskConsoleAssignmentRow[] = [];
    for (const row of rows) {
      const status = String(row.status ?? '');
      // Same fail-closed rule as tasks: never project an unknown status.
      if (!isSupervisionTaskLifecycleStatus(status)) continue;
      const verdict = row.verdict === 'PASS' || row.verdict === 'REWORK' ? row.verdict : undefined;
      out.push({
        assignmentId: String(row.assignment_id),
        taskId: String(row.task_id),
        status,
        phase: supervisionConsoleStatusGroup(status),
        role: row.role ? String(row.role) : undefined,
        ownerSessionName: row.session_name ? String(row.session_name) : undefined,
        ownerAgentType: row.agent_type ? String(row.agent_type) : undefined,
        observedModel: row.observed_model ? String(row.observed_model) : undefined,
        observedProvider: row.observed_provider ? String(row.observed_provider)
          : (row.provider_family ? String(row.provider_family) : undefined),
        poolKind: readPoolKind(row.pool_kind),
        validationState: readValidationState(row.validation_state),
        auditAttemptId: row.audit_attempt_id ? String(row.audit_attempt_id) : undefined,
        auditVerdict: verdict,
        blocker: row.blocker ? String(row.blocker) : undefined,
        nextAction: row.next_action ? String(row.next_action) : undefined,
        recoveryState: row.recovery_state ? String(row.recovery_state) : undefined,
        recoveryReason: row.recovery_reason ? String(row.recovery_reason) : undefined,
        heartbeatAt: row.heartbeat_at === null || row.heartbeat_at === undefined
          ? undefined : Number(row.heartbeat_at),
        updatedAt: Number(row.updated_at ?? 0),
        lastEventId: Number(row.last_durable_event_id ?? 0),
      });
    }
    return out;
  }

  /**
   * Both pools are always projected, even at zero occupancy: an empty column is
   * information ("nothing is running there"), whereas a missing column reads as
   * a broken console.
   */
  readPools(): SupervisionTaskConsolePoolRow[] {
    const counts = this.#db.prepare(
      `SELECT pool_kind AS kind, COUNT(*) AS n FROM supervision_task_assignments
       WHERE pool_kind IS NOT NULL AND status NOT IN ('finalized','pushed','blocked','cancelled')
       GROUP BY pool_kind`,
    ).all() as Array<{ kind?: string; n?: number }>;
    const byKind = new Map(counts.map((row) => [String(row.kind), Number(row.n ?? 0)]));
    return SUPERVISION_EXECUTION_POOL_KINDS.map((kind) => ({
      poolId: kind,
      label: kind,
      activeCount: byKind.get(kind) ?? 0,
      capacity: DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS[kind].maxConcurrency,
    }));
  }

  #deliver(frame: SupervisionTaskConsoleDelta, projectionVersion: number, scope: SupervisionTaskConsoleScope): void {
    if (!this.#broadcast) return;
    this.#broadcast(frame);
    this.#db.prepare(
      `UPDATE supervision_outbox SET delivery_state = 'sent', attempts = attempts + 1, updated_at = ?
       WHERE project_name = ? AND coordinator_session_name = ? AND projection_epoch = ? AND projection_version = ?`,
    ).run(this.#now(), scope.projectName, scope.coordinatorSessionName, this.#epoch, projectionVersion);
    this.#onBoundary('after_broadcast_before_ack');
  }

  /** Frames the browser has not durably acknowledged, oldest first. */
  pendingFrames(scope: SupervisionTaskConsoleScope): SupervisionOutboxRow[] {
    const rows = this.#db.prepare(
      `SELECT id, project_name, coordinator_session_name, event_id, projection_version,
              projection_epoch, frame_json, delivery_state, attempts
       FROM supervision_outbox
       WHERE project_name = ? AND coordinator_session_name = ? AND delivery_state IN ('pending','sent','failed')
       ORDER BY id ASC`,
    ).all(scope.projectName, scope.coordinatorSessionName) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.id),
      projectName: String(row.project_name),
      coordinatorSessionName: String(row.coordinator_session_name),
      eventId: Number(row.event_id),
      projectionVersion: Number(row.projection_version),
      projectionEpoch: String(row.projection_epoch),
      frame: JSON.parse(String(row.frame_json)) as SupervisionTaskConsoleDelta,
      deliveryState: String(row.delivery_state) as SupervisionOutboxRow['deliveryState'],
      attempts: Number(row.attempts),
    }));
  }

  /**
   * Record a durable client ack. Everything at or below the acked version for
   * this epoch becomes `acked`; nothing above it is touched.
   */
  recordAck(scope: SupervisionTaskConsoleScope, projectionVersion: number): number {
    const before = this.pendingFrames(scope).length;
    this.#db.prepare(
      `UPDATE supervision_outbox SET delivery_state = 'acked', updated_at = ?
       WHERE project_name = ? AND coordinator_session_name = ? AND projection_epoch = ?
         AND projection_version <= ? AND delivery_state != 'acked'`,
    ).run(this.#now(), scope.projectName, scope.coordinatorSessionName, this.#epoch, projectionVersion);
    return before - this.pendingFrames(scope).length;
  }

  /** Cursor state restored purely from SQLite. */
  restoreCursor(scope: SupervisionTaskConsoleScope): { projectionVersion: number; projectionEpoch: string; lastDurableEventId: number | null } {
    const row = this.#db.prepare(
      `SELECT projection_version AS v, projection_epoch AS e, last_durable_event_id AS l
       FROM supervision_projection_state WHERE project_name = ? AND coordinator_session_name = ?`,
    ).get(scope.projectName, scope.coordinatorSessionName) as { v?: number; e?: string; l?: number } | undefined;
    return {
      projectionVersion: Number(row?.v ?? 0),
      projectionEpoch: String(row?.e ?? this.#epoch),
      lastDurableEventId: row?.l === undefined || row?.l === null ? null : Number(row.l),
    };
  }

  buildSnapshot(scope: SupervisionTaskConsoleScope, subscriptionId: string): SupervisionTaskConsoleSnapshot {
    const cursor = this.restoreCursor(scope);
    const ids = this.#db.prepare(
      'SELECT task_id FROM supervision_tasks ORDER BY task_id ASC',
    ).all() as Array<{ task_id: string }>;
    const tasks = ids
      .map((row) => this.readTaskRow(String(row.task_id)))
      .filter((row): row is SupervisionTaskConsoleTaskRow => !!row);
    return {
      type: SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT,
      scope,
      subscriptionId,
      schemaVersion: SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
      statusContractVersion: SUPERVISION_TASK_STATUS_CONTRACT_VERSION,
      projectionVersion: cursor.projectionVersion,
      lastDurableEventId: cursor.lastDurableEventId,
      projectionEpoch: cursor.projectionEpoch,
      generatedAt: this.#now(),
      tasks,
      assignments: this.readAssignmentRows(),
      pools: this.readPools(),
    };
  }

  /**
   * Apply a completed peer-audit receipt.
   *
   * The decision is taken by the pure state machine; this method only persists
   * it, atomically. A receipt that does not advance the lifecycle still records
   * its durable blocked reason so no PASS can sit silently unowned.
   */
  applyAuditReceipt(scope: SupervisionTaskConsoleScope, receipt: SupervisionAuditReceipt): SupervisionHandoffDecision {
    const task = this.#db.prepare(
      `SELECT status, current_revision, integration_owner FROM supervision_tasks WHERE task_id = ?`,
    ).get(receipt.taskId) as Record<string, unknown> | undefined;
    const assignment = this.#db.prepare(
      `SELECT audit_attempt_id, session_name FROM supervision_task_assignments WHERE assignment_id = ?`,
    ).get(receipt.assignmentId) as Record<string, unknown> | undefined;
    const applied = (this.#db.prepare(
      'SELECT attempt_id FROM supervision_audit_attestations WHERE task_id = ?',
    ).all(receipt.taskId) as Array<{ attempt_id: string }>).map((row) => String(row.attempt_id));

    const status = String(task?.status ?? 'planned');
    const decision = decideSupervisionAuditHandoff({
      receipt,
      context: {
        currentStatus: isSupervisionTaskLifecycleStatus(status) ? status : 'planned',
        expectedAttemptId: String(assignment?.audit_attempt_id ?? receipt.attemptId),
        currentRevision: String(task?.current_revision ?? receipt.revision),
        declaredIntegrationOwner: task?.integration_owner ? String(task.integration_owner) : undefined,
        developmentOwner: assignment?.session_name ? String(assignment.session_name) : undefined,
        appliedAttemptIds: applied,
      },
    });

    this.#transaction(() => {
      if (decision.recordAttestation) {
        this.#db.prepare(
          `INSERT OR IGNORE INTO supervision_audit_attestations
            (attempt_id, task_id, assignment_id, revision, verdict, auditor_session_name, findings, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(receipt.attemptId, receipt.taskId, receipt.assignmentId, receipt.revision,
          receipt.verdict ?? 'REWORK', receipt.auditorSessionName, receipt.findings ?? null, this.#now());
      }
      if (decision.nextStatus) {
        this.#db.prepare(
          `UPDATE supervision_tasks SET status = ?, integration_owner = ?, next_action = ?,
             blocked_reason = ?, updated_at = ? WHERE task_id = ?`,
        ).run(decision.nextStatus, decision.integrationOwner ?? null, decision.nextAction,
          decision.blockedReason ?? null, this.#now(), receipt.taskId);
      } else {
        // Holding still records WHY, so a stalled task is never unexplained.
        this.#db.prepare(
          'UPDATE supervision_tasks SET next_action = ?, blocked_reason = ?, updated_at = ? WHERE task_id = ?',
        ).run(decision.nextAction, decision.blockedReason ?? null, this.#now(), receipt.taskId);
      }
      if (decision.queueOp?.op === 'upsert') {
        this.#db.prepare(
          `INSERT INTO supervision_integration_queue
            (task_id, integration_owner, attempt_id, revision, next_action, queued_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET
             integration_owner = excluded.integration_owner, attempt_id = excluded.attempt_id,
             revision = excluded.revision, next_action = excluded.next_action, updated_at = excluded.updated_at`,
        ).run(decision.queueOp.taskId, decision.queueOp.integrationOwner, decision.queueOp.attemptId,
          decision.queueOp.revision, decision.nextAction, this.#now(), this.#now());
      } else if (decision.queueOp?.op === 'remove') {
        this.#db.prepare('DELETE FROM supervision_integration_queue WHERE task_id = ?')
          .run(decision.queueOp.taskId);
      }
    });

    if (decision.nextStatus) {
      this.appendTaskEvent({
        scope, taskId: receipt.taskId, assignmentId: receipt.assignmentId,
        eventType: 'audit_replied', status: decision.nextStatus,
        payload: { attemptId: receipt.attemptId, verdict: receipt.verdict },
      });
    }
    return decision;
  }

  /** Integration queue rebuilt from durable rows alone. */
  integrationQueue(): Array<{ taskId: string; integrationOwner?: string; attemptId: string; revision: string; nextAction?: string; blockedReason?: string }> {
    return (this.#db.prepare(
      `SELECT task_id, integration_owner, attempt_id, revision, next_action, blocked_reason
       FROM supervision_integration_queue ORDER BY queued_at ASC, task_id ASC`,
    ).all() as Array<Record<string, unknown>>).map((row) => ({
      taskId: String(row.task_id),
      integrationOwner: row.integration_owner ? String(row.integration_owner) : undefined,
      attemptId: String(row.attempt_id),
      revision: String(row.revision),
      nextAction: row.next_action ? String(row.next_action) : undefined,
      blockedReason: row.blocked_reason ? String(row.blocked_reason) : undefined,
    }));
  }
}
