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
import { getTaskPairStore } from './task-pairs/store.js';
import {
  buildPairConsoleRow,
  computePairQueuePositions,
  pairRowJson,
  taskPairBriefRevision,
  type PairScopeView,
} from './supervision-console-pair-projection.js';
import { isPairsEngineProject, isTaskPairsAvailable } from './task-pairs/engine.js';
import {
  SUPERVISION_TASK_CONSOLE_MSG,
  SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
  supervisionConsoleStatusGroup,
  type SupervisionConsoleDeltaOp,
  type SupervisionTaskConsoleDelta,
  type SupervisionTaskConsolePairDelta,
  type SupervisionTaskConsolePairDeltaUpsert,
  type SupervisionTaskConsolePairUpsert,
  type SupervisionTaskConsoleScope,
  type SupervisionTaskConsoleSnapshot,
  type SupervisionTaskConsoleTaskRow,
  type SupervisionTaskConsoleAssignmentRow,
  type SupervisionTaskConsolePoolRow,
  type SupervisionConsoleValidationState,
  type SupervisionConsoleSessionState,
  type SupervisionConsoleSessionStateSource,
  SUPERVISION_CONSOLE_VALIDATION_STATES,
  supervisionConsoleExecutionHealth,
} from '../../shared/supervision-task-console.js';
import {
  DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS,
  SUPERVISION_EXECUTION_POOL_KINDS,
  type SupervisionExecutionPoolKind,
} from '../../shared/supervision-execution-pool.js';
import {
  isSupervisionTaskLifecycleStatus,
  isSupervisionTaskVisibleByDefault,
  SUPERVISION_TASK_STATUS_CONTRACT_VERSION,
  type SupervisionTaskLifecycleStatus,
} from '../../shared/supervision-config.js';
import {
  deriveSupervisionTaskTitle,
  projectSupervisionTaskObjective,
} from '../../shared/supervision-task-identity.js';
import {
  decideSupervisionAuditHandoff,
  type SupervisionAuditReceipt,
  type SupervisionHandoffDecision,
} from '../../shared/supervision-audit-handoff.js';
import type { SupervisionMigrationDb } from './supervision-store-migrations.js';
import { yieldToEventLoop } from './event-loop-yield.js';
import { traceAsync, traceSync } from './latency-tracer.js';
import { withEventLoopWatchdogPhase } from './event-loop-watchdog.js';

/** Upper bound on events read per slice; the time budget below usually stops a slice sooner. */
export const SUPERVISION_PROJECTION_CHUNK_SIZE = 32;

/**
 * Wall-clock budget for ONE synchronous console-sync slice (projection commit
 * plus frame delivery). Between slices the loop yields to the event loop, so a
 * send acknowledgement, heartbeat or control frame never waits longer than one
 * slice behind console projection work.
 */
export const SUPERVISION_SYNC_SLICE_BUDGET_MS = 15;
/** Share of the slice budget spent projecting; the rest is left for delivery. */
const SUPERVISION_SYNC_PROJECTION_SHARE = 0.6;
/**
 * A backlog up to this many events is projected inline (a few milliseconds);
 * anything larger is drained in yielded, time-budgeted slices.
 */
export const SUPERVISION_INLINE_SYNC_MAX_EVENTS = 6;

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
  /** Live daemon authority for assignment owner presentation. */
  resolveSessionPresentation?: (sessionName: string, durableObservedAt: number) => {
    label?: string;
    model?: string;
    thinking?: string;
    state: SupervisionConsoleSessionState;
    source: SupervisionConsoleSessionStateSource;
    observedAt: number;
  } | undefined;
  /** Cache identical subscribe snapshots for this bounded interval. */
  snapshotCacheTtlMs?: number;
  /** Monotonic millisecond clock for slice budgets (default `performance.now`). */
  monotonicNowMs?: () => number;
  /** Per-slice wall-clock budget override (default {@link SUPERVISION_SYNC_SLICE_BUDGET_MS}). */
  syncSliceBudgetMs?: number;
  /** Yield between slices (default `setImmediate`). */
  yieldToEventLoop?: () => Promise<void>;
  /** Inline-vs-yielded backlog threshold override. */
  inlineSyncMaxEvents?: number;
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

interface DurableRegistryEventRow {
  id: number;
  taskId: string;
  assignmentId?: string;
}

/** Assignment states that no longer occupy a pool slot (shared by the full and O(delta) pool paths). */
const POOL_INACTIVE_ASSIGNMENT_STATUSES = ['finalized', 'pushed', 'blocked', 'cancelled'] as const;

const ASSIGNMENT_ROW_SELECT = `SELECT a.assignment_id, a.task_id, a.role, a.status, a.session_name, a.agent_type, a.provider_family,
              a.pool_kind, a.validation_state, a.observed_model, a.observed_provider, a.heartbeat_at,
              a.audit_attempt_id, a.audit_revision, a.verdict, a.blocker, a.next_action,
              a.recovery_state, a.recovery_reason, a.last_durable_event_id, a.updated_at,
              a.lease_id, a.payload_json
       FROM supervision_task_assignments a
       INNER JOIN supervision_tasks t ON t.task_id = a.task_id`;

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
  readonly #resolveSessionPresentation?: SupervisionProducerOptions['resolveSessionPresentation'];
  readonly #snapshotCacheTtlMs: number;
  readonly #snapshotCache = new Map<string, {
    builtAt: number;
    dataVersion: number;
    projectionVersion: number;
    lastDurableEventId: number | null;
    projectionEpoch: string;
    snapshot: Omit<SupervisionTaskConsoleSnapshot, 'subscriptionId'>;
  }>();
  readonly #snapshotBuildInFlight = new Map<string, Promise<Omit<SupervisionTaskConsoleSnapshot, 'subscriptionId'>>>();
  /**
   * Per scope AND subscription: the pair rows + revision one PAIR_DELTA_V1
   * viewer was last sent. Several viewers of a scope (a second tab, the phone,
   * the compact panel next to the full console) each hold their own, so one
   * viewer subscribing or leaving never invalidates another's delta base.
   */
  readonly #pairViews = new Map<string, PairScopeView>();
  /**
   * Pair rows a PAIR_DELTA_V1 snapshot was built from, keyed by the snapshot
   * object itself so they never travel on the wire. Seeds one view per
   * subscription that receives that snapshot.
   */
  readonly #pairSnapshotEntries = new WeakMap<object, SupervisionTaskConsolePairUpsert[]>();
  /**
   * Assignment rows memoized for one synchronous projection pass. A replay of
   * N durable events used to re-project every assignment (and each owner's
   * live transport queue) N×2 times on the main thread, which pegged the
   * daemon for minutes on large registries and starved the server heartbeat.
   * Nothing writes assignments inside a pass, so one read per pass is exact.
   */
  #passAssignmentRows: Map<string, SupervisionTaskConsoleAssignmentRow[]> | null = null;
  /**
   * Per-pass memo for the O(delta) frame path: one assignment row / task
   * visibility / pool summary is derived at most once per pass, exactly like
   * `#passAssignmentRows` does for the full projection.
   */
  #passAssignmentById: Map<string, SupervisionTaskConsoleAssignmentRow | null> | null = null;
  #passTaskVisible: Map<string, boolean> | null = null;
  #passPools: Map<string, SupervisionTaskConsolePoolRow[]> | null = null;
  #passNow = 0;
  /** Prevent timer/resubscribe storms from running duplicate large replays. */
  readonly #asyncReplayInFlight = new Map<string, Promise<number>>();
  readonly #monotonicNowMs: () => number;
  readonly #syncSliceBudgetMs: number;
  readonly #yield: () => Promise<void>;
  readonly #inlineSyncMaxEvents: number;

  constructor(db: SupervisionMigrationDb, options: SupervisionProducerOptions) {
    this.#db = db;
    this.#epoch = options.projectionEpoch;
    this.#now = options.now ?? (() => 0);
    this.#onBoundary = options.onBoundary ?? (() => {});
    this.#broadcast = options.broadcast;
    this.#resolveSessionPresentation = options.resolveSessionPresentation;
    this.#snapshotCacheTtlMs = Math.max(0, options.snapshotCacheTtlMs ?? 1_000);
    this.#monotonicNowMs = options.monotonicNowMs ?? (() => performance.now());
    this.#syncSliceBudgetMs = Math.max(1, options.syncSliceBudgetMs ?? SUPERVISION_SYNC_SLICE_BUDGET_MS);
    this.#yield = options.yieldToEventLoop ?? yieldToEventLoop;
    this.#inlineSyncMaxEvents = Math.max(1, options.inlineSyncMaxEvents ?? SUPERVISION_INLINE_SYNC_MAX_EVENTS);
  }

  #snapshotKey(scope: SupervisionTaskConsoleScope): string {
    return JSON.stringify([scope.projectName, scope.coordinatorSessionName]);
  }

  #readDataVersion(): number {
    const row = this.#db.prepare('PRAGMA data_version').get() as { data_version?: unknown } | undefined;
    return typeof row?.data_version === 'number' ? row.data_version : 0;
  }

  /** Invalidate after durable task/assignment changes. */
  invalidateSnapshot(scope: SupervisionTaskConsoleScope): void {
    this.#snapshotCache.delete(this.#snapshotKey(scope));
  }

  /** In-flight/cache key: a PAIR_DELTA_V1 snapshot (no briefs, seeds the pair view) is a different payload. */
  #snapshotModeKey(scope: SupervisionTaskConsoleScope, pairDelta: boolean): string {
    return pairDelta ? `${this.#snapshotKey(scope)}#pd` : this.#snapshotKey(scope);
  }

  /** Build outside the inbound WS callback and coalesce concurrent requests. */
  async buildSnapshotAsync(
    scope: SupervisionTaskConsoleScope,
    subscriptionId: string,
    options: { pairDelta?: boolean } = {},
  ): Promise<SupervisionTaskConsoleSnapshot> {
    const pairDelta = options.pairDelta === true;
    const key = this.#snapshotModeKey(scope, pairDelta);
    let work = this.#snapshotBuildInFlight.get(key);
    if (!work) {
      work = new Promise<Omit<SupervisionTaskConsoleSnapshot, 'subscriptionId'>>((resolve) => {
        setImmediate(() => resolve(withEventLoopWatchdogPhase('supervision-console.build-snapshot', () => this.#buildSnapshotCached(scope, pairDelta))));
      }).finally(() => {
        if (this.#snapshotBuildInFlight.get(key) === work) this.#snapshotBuildInFlight.delete(key);
      });
      this.#snapshotBuildInFlight.set(key, work);
    }
    const snapshot = await work;
    if (pairDelta) this.#seedPairView(scope, subscriptionId, snapshot);
    return { ...snapshot, subscriptionId };
  }

  static #isRetentionVisible(payloadJson: unknown): boolean {
    let retention: { archivedAt?: number } = {};
    try {
      const parsed = JSON.parse(String(payloadJson ?? '{}')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        retention = parsed as { archivedAt?: number };
      }
    } catch { /* malformed legacy payload has no trustworthy archive marker */ }
    return isSupervisionTaskVisibleByDefault(retention);
  }

  #visibleTaskIds(projectName: string): Set<string> {
    const rows = this.#db.prepare(
      'SELECT task_id, payload_json FROM supervision_tasks WHERE project_name = ? ORDER BY task_id ASC',
    ).all(projectName) as Array<{ task_id?: unknown; payload_json?: unknown }>;
    const visible = new Set<string>();
    for (const row of rows) {
      if (SupervisionConsoleProducer.#isRetentionVisible(row.payload_json)) visible.add(String(row.task_id));
    }
    return visible;
  }

  /** Same rule as {@link #visibleTaskIds}, for one task (memoized per pass). */
  #isTaskVisible(projectName: string, taskId: string): boolean {
    const key = `${projectName}\0${taskId}`;
    const memo = this.#passTaskVisible?.get(key);
    if (memo !== undefined) return memo;
    const row = this.#db.prepare(
      'SELECT payload_json FROM supervision_tasks WHERE task_id = ? AND project_name = ?',
    ).get(taskId, projectName) as { payload_json?: unknown } | undefined;
    const visible = row ? SupervisionConsoleProducer.#isRetentionVisible(row.payload_json) : false;
    this.#passTaskVisible?.set(key, visible);
    return visible;
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
   * Establish an authoritative snapshot cursor without replaying years of
   * historical lifecycle events into a new browser outbox.
   *
   * Version zero is reserved for a genuinely event-free registry. A populated
   * registry starts at version one and pins the newest durable event as its
   * baseline; every event committed after that point is projected densely.
   */
  ensureProjectionBaseline(scope: SupervisionTaskConsoleScope): void {
    const existing = this.#db.prepare(
      `SELECT 1 AS found FROM supervision_projection_state
       WHERE project_name = ? AND coordinator_session_name = ?`,
    ).get(scope.projectName, scope.coordinatorSessionName) as { found?: number } | undefined;
    if (existing?.found) return;
    const latest = this.#db.prepare(
      `SELECT MAX(e.id) AS event_id
       FROM supervision_task_events e
       INNER JOIN supervision_tasks t ON t.task_id = e.task_id
       WHERE t.project_name = ?`,
    ).get(scope.projectName) as { event_id?: number | null } | undefined;
    const eventId = latest?.event_id === null || latest?.event_id === undefined
      ? null : Number(latest.event_id);
    this.#db.prepare(
      `INSERT OR IGNORE INTO supervision_projection_state
        (project_name, coordinator_session_name, projection_version, projection_epoch,
         last_durable_event_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(scope.projectName, scope.coordinatorSessionName, eventId === null ? 0 : 1,
      this.#epoch, eventId, this.#now());
  }

  #readDurableRegistryEvents(
    scope: SupervisionTaskConsoleScope,
    afterEventId: number | null,
    limit: number = SUPERVISION_PROJECTION_CHUNK_SIZE,
  ): DurableRegistryEventRow[] {
    // CROSS JOIN pins the event table as the OUTER loop, so SQLite seeks the
    // rowid range `e.id > ?` and probes the task by primary key. Left as an
    // INNER JOIN the planner starts from the project's tasks, walks every event
    // of the project and sorts them in a temp b-tree: ~5 ms even when fully
    // caught up on a real registry (75k events), vs ~0.04 ms.
    const rows = this.#db.prepare(
      `SELECT e.id, e.task_id, e.assignment_id
       FROM supervision_task_events e
       CROSS JOIN supervision_tasks t ON t.task_id = e.task_id
       WHERE t.project_name = ? AND e.id > ?
       ORDER BY e.id ASC
       LIMIT ?`,
    ).all(scope.projectName, afterEventId ?? 0, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.id),
      taskId: String(row.task_id),
      assignmentId: row.assignment_id ? String(row.assignment_id) : undefined,
    }));
  }

  #buildDurableDelta(
    scope: SupervisionTaskConsoleScope,
    event: DurableRegistryEventRow,
    projectionVersion: number,
  ): SupervisionTaskConsoleDelta {
    const base = {
      type: SUPERVISION_TASK_CONSOLE_MSG.DELTA,
      scope,
      subscriptionId: '',
      schemaVersion: SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
      statusContractVersion: SUPERVISION_TASK_STATUS_CONTRACT_VERSION,
      projectionVersion,
      lastDurableEventId: event.id,
      projectionEpoch: this.#epoch,
      eventId: event.id,
    } as SupervisionTaskConsoleDelta;
    if (event.assignmentId) {
      const assignment = this.#readAssignmentRowById(scope.projectName, event.assignmentId);
      if (assignment) {
        base.op = 'assignment_upsert';
        base.assignment = assignment;
        // Assignment liveness is also an aggregate task fact. Keep both rows
        // on the same durable event/version rather than inventing a second
        // event or waiting for an unrelated task transition.
        base.task = this.readTaskRow(event.taskId, scope.projectName, event.id);
        // Pool occupancy changes on assignment transitions. Shipping the
        // current pool rows with the same durable event keeps both views atomic.
        base.pools = this.#readPoolsForDelta(scope.projectName);
        return base;
      }
      base.op = 'assignment_remove';
      base.removedId = event.assignmentId;
      base.pools = this.#readPoolsForDelta(scope.projectName);
      return base;
    }
    const task = this.readTaskRow(event.taskId, scope.projectName, event.id);
    if (task) {
      base.op = 'task_upsert';
      base.task = task;
    } else {
      base.op = 'task_remove';
      base.removedId = event.taskId;
    }
    return base;
  }

  /**
   * Tail already-committed registry events into the dense projection/outbox.
   * This closes both failure windows: the registry listener gives live pushes,
   * while every subscribe calls this method to recover a missed callback or a
   * daemon crash between the registry commit and projection commit.
   */
  synchronizeDurableEvents(
    scope: SupervisionTaskConsoleScope,
    options: { deliver?: boolean } = {},
  ): number {
    return withEventLoopWatchdogPhase('supervision-console.synchronize-durable-events', () => traceSync('supervision-console.synchronize-durable-events', { projectName: scope.projectName }, () => this.#withAssignmentPass(() => {
      this.ensureProjectionBaseline(scope);
      const cursor = this.restoreCursor(scope);
      let committedCount = 0;
      let afterEventId = cursor.lastDurableEventId;
      while (true) {
        const events = this.#readDurableRegistryEvents(scope, afterEventId);
        if (events.length === 0) break;
        const committed = this.#commitDurableEventChunk(scope, events);
        committedCount += committed.length;
        if (options.deliver !== false) {
          for (const item of committed) this.#deliver(item.frame, item.projectionVersion, scope);
        }
        afterEventId = events[events.length - 1]!.id;
        if (events.length < SUPERVISION_PROJECTION_CHUNK_SIZE) break;
      }
      if (committedCount > 0) this.invalidateSnapshot(scope);
      return committedCount;
    })));
  }

  /**
   * Large catch-up path used by the socket subscription handler and the live
   * refresh. It commits time-budgeted slices (see
   * {@link SUPERVISION_SYNC_SLICE_BUDGET_MS}) and yields between them; unlike
   * the historical synchronous implementation, neither a 1,000-event backlog
   * nor a busy registry can monopolize the main thread. The cursor is re-read
   * from SQLite before every slice, so a concurrent inline pass or a restart
   * can never make a slice project an event twice or skip one.
   */
  async synchronizeDurableEventsAsync(
    scope: SupervisionTaskConsoleScope,
    options: { deliver?: boolean } = {},
  ): Promise<number> {
    const replayKey = JSON.stringify([scope.projectName, scope.coordinatorSessionName]);
    // A refresh that arrives while a drain is yielded joins it: the drain only
    // yields when the tail is NOT yet empty and re-reads the persisted cursor
    // after every yield, so the new commit is picked up by its next slice.
    const pending = this.#asyncReplayInFlight.get(replayKey);
    if (pending) return pending;
    let work: Promise<number>;
    work = traceAsync('supervision-console.synchronize-durable-events-async', { projectName: scope.projectName }, () => this.#drainDurableEventsSliced(scope, options))
      .finally(() => {
        if (this.#asyncReplayInFlight.get(replayKey) === work) this.#asyncReplayInFlight.delete(replayKey);
      });
    this.#asyncReplayInFlight.set(replayKey, work);
    return work;
  }

  async #drainDurableEventsSliced(
    scope: SupervisionTaskConsoleScope,
    options: { deliver?: boolean },
  ): Promise<number> {
    let committedCount = 0;
    while (true) {
      const slice = withEventLoopWatchdogPhase(
        'supervision-console.synchronize-durable-events-async',
        () => this.#withAssignmentPass(() => this.#projectDurableSlice(scope, options)),
      );
      committedCount += slice.committed;
      if (slice.drained) break;
      await this.#yield();
    }
    if (committedCount > 0) this.invalidateSnapshot(scope);
    return committedCount;
  }

  /**
   * Project one time-budgeted slice of the durable tail. The cursor is read
   * from SQLite here, never carried across an await, so this stays exact when
   * an inline pass or a restart interleaves between slices.
   */
  #projectDurableSlice(
    scope: SupervisionTaskConsoleScope,
    options: { deliver?: boolean },
  ): { committed: number; drained: boolean } {
    const startedAt = this.#monotonicNowMs();
    this.ensureProjectionBaseline(scope);
    const cursor = this.restoreCursor(scope);
    const events = this.#readDurableRegistryEvents(scope, cursor.lastDurableEventId);
    if (events.length === 0) return { committed: 0, drained: true };
    const projectionDeadline = startedAt + this.#syncSliceBudgetMs * SUPERVISION_SYNC_PROJECTION_SHARE;
    const committed = this.#commitDurableEventChunk(scope, events, projectionDeadline);
    if (options.deliver !== false) {
      for (const item of committed) this.#deliver(item.frame, item.projectionVersion, scope);
    }
    const drained = committed.length === events.length && events.length < SUPERVISION_PROJECTION_CHUNK_SIZE;
    return { committed: committed.length, drained };
  }

  /**
   * True when the tail holds more than a few events, i.e. projecting it inline
   * could exceed one slice budget and must be drained in yielded slices. Small
   * tails (the steady state: one or two events per registry commit) stay inline.
   */
  needsYieldedDurableReplay(scope: SupervisionTaskConsoleScope): boolean {
    this.ensureProjectionBaseline(scope);
    const cursor = this.restoreCursor(scope);
    const rows = this.#db.prepare(
      `SELECT 1 AS found
       FROM supervision_task_events e
       CROSS JOIN supervision_tasks t ON t.task_id = e.task_id
       WHERE t.project_name = ? AND e.id > ?
       LIMIT ?`,
    ).all(scope.projectName, cursor.lastDurableEventId ?? 0, this.#inlineSyncMaxEvents + 1) as Array<{ found?: number }>;
    return rows.length > this.#inlineSyncMaxEvents;
  }

  /**
   * Commit events in order inside one transaction. With a `deadline` (monotonic
   * ms) the commit stops after the event that crossed it -- always at least
   * one, so a slow event can never stall progress -- and the caller continues
   * from the persisted cursor in its next slice.
   */
  #commitDurableEventChunk(
    scope: SupervisionTaskConsoleScope,
    events: DurableRegistryEventRow[],
    deadline?: number,
  ): Array<{ frame: SupervisionTaskConsoleDelta; projectionVersion: number }> {
    return this.#transaction(() => {
      const out: Array<{ frame: SupervisionTaskConsoleDelta; projectionVersion: number }> = [];
      for (const event of events) {
        const projectionVersion = this.#nextProjectionVersion(scope, event.id);
        const frame = this.#buildDurableDelta(scope, event, projectionVersion);
        this.#db.prepare(
          `INSERT INTO supervision_outbox
            (project_name, coordinator_session_name, event_id, projection_version, projection_epoch,
             frame_json, delivery_state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        ).run(scope.projectName, scope.coordinatorSessionName, event.id, projectionVersion,
          this.#epoch, JSON.stringify(frame), this.#now(), this.#now());
        out.push({ frame, projectionVersion });
        if (deadline !== undefined && this.#monotonicNowMs() >= deadline) break;
      }
      return out;
    });
  }

  /**
   * Append one task event and its console frame atomically.
   *
   * Returns the durable ids. If this throws, nothing was written.
   */
  appendTaskEvent(input: SupervisionTaskEventInput): { eventId: number; projectionVersion: number } {
    const owned = this.#db.prepare(
      'SELECT 1 AS ok FROM supervision_tasks WHERE task_id = ? AND project_name = ?',
    ).get(input.taskId, input.scope.projectName) as { ok?: number } | undefined;
    if (!owned?.ok) throw new Error('supervision task is outside the requested project scope');
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
    this.invalidateSnapshot(input.scope);
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
      const row = this.readTaskRow(input.taskId, input.scope.projectName, eventId);
      if (row) base.task = row;
    }
    return base;
  }

  /** Project one durable task row into its browser-safe shape. */
  readTaskRow(taskId: string, projectName: string, lastEventId?: number): SupervisionTaskConsoleTaskRow | undefined {
    const row = this.#db.prepare(
      `SELECT task_id, top_level_task_id, status, current_revision, semantic_key, integration_owner, next_action,
              blocked_reason, recovery_state, recovery_reason, last_durable_event_id, updated_at,
              validation_state, heartbeat_at, payload_json
       FROM supervision_tasks WHERE task_id = ? AND project_name = ?`,
    ).get(taskId, projectName) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const status = String(row.status ?? '');
    // Fail closed: never project a status the contract does not know.
    if (!isSupervisionTaskLifecycleStatus(status)) return undefined;
    let objective: string | undefined;
    try {
      const payload = JSON.parse(String(row.payload_json ?? '{}')) as Record<string, unknown>;
      if (!isSupervisionTaskVisibleByDefault(payload)) return undefined;
      objective = projectSupervisionTaskObjective(payload.objective);
    } catch { /* malformed legacy payload: task id remains the fail-safe title */ }
    return {
      taskId: String(row.task_id),
      topLevelTaskId: row.top_level_task_id ? String(row.top_level_task_id) : undefined,
      semanticKey: row.semantic_key ? String(row.semantic_key) : undefined,
      title: deriveSupervisionTaskTitle(objective) ?? String(row.task_id),
      ...(objective ? { objective } : {}),
      status,
      currentRevision: row.current_revision ? String(row.current_revision) : undefined,
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

  #withAssignmentPass<T>(fn: () => T): T {
    if (this.#passAssignmentRows) return fn();
    this.#passAssignmentRows = new Map();
    this.#passAssignmentById = new Map();
    this.#passTaskVisible = new Map();
    this.#passPools = new Map();
    this.#passNow = Date.now();
    try {
      return fn();
    } finally {
      this.#passAssignmentRows = null;
      this.#passAssignmentById = null;
      this.#passTaskVisible = null;
      this.#passPools = null;
    }
  }

  /** Project every assignment into its browser-safe row. */
  readAssignmentRows(projectName: string): SupervisionTaskConsoleAssignmentRow[] {
    const cached = this.#passAssignmentRows?.get(projectName);
    if (cached) return cached;
    const rows = this.#projectAssignmentRows(projectName);
    this.#passAssignmentRows?.set(projectName, rows);
    return rows;
  }

  #projectAssignmentRows(projectName: string): SupervisionTaskConsoleAssignmentRow[] {
    const visibleTaskIds = this.#visibleTaskIds(projectName);
    const rows = this.#db.prepare(
      `${ASSIGNMENT_ROW_SELECT} WHERE t.project_name = ? ORDER BY a.assignment_id ASC`,
    ).all(projectName) as Array<Record<string, unknown>>;
    const out: SupervisionTaskConsoleAssignmentRow[] = [];
    // One clock for the whole pass so rows in a snapshot cannot disagree.
    const now = Date.now();
    for (const row of rows) {
      if (!visibleTaskIds.has(String(row.task_id))) continue;
      const projected = this.#projectAssignmentRow(row, now);
      if (projected) out.push(projected);
    }
    return out;
  }

  /**
   * One assignment row, projected exactly as the full pass would: same
   * visibility rule, same fail-closed status check, same fields. Used by the
   * durable-event path so a delta costs O(1) instead of O(every assignment).
   */
  #readAssignmentRowById(projectName: string, assignmentId: string): SupervisionTaskConsoleAssignmentRow | undefined {
    const key = `${projectName}\0${assignmentId}`;
    const memo = this.#passAssignmentById;
    if (memo?.has(key)) return memo.get(key) ?? undefined;
    const row = this.#db.prepare(
      `${ASSIGNMENT_ROW_SELECT} WHERE t.project_name = ? AND a.assignment_id = ?`,
    ).get(projectName, assignmentId) as Record<string, unknown> | undefined;
    const projected = row && this.#isTaskVisible(projectName, String(row.task_id))
      ? this.#projectAssignmentRow(row, this.#passNow || Date.now())
      : undefined;
    memo?.set(key, projected ?? null);
    return projected;
  }

  #projectAssignmentRow(row: Record<string, unknown>, now: number): SupervisionTaskConsoleAssignmentRow | undefined {
    const status = String(row.status ?? '');
    // Same fail-closed rule as tasks: never project an unknown status.
    if (!isSupervisionTaskLifecycleStatus(status)) return undefined;
    const verdict = row.verdict === 'PASS' || row.verdict === 'REWORK' ? row.verdict : undefined;
    const ownerSessionName = row.session_name ? String(row.session_name) : undefined;
    const durableObservedAt = Number(row.updated_at ?? 0);
    let required: boolean | undefined;
    try {
      const payload = JSON.parse(String(row.payload_json ?? '{}')) as Record<string, unknown>;
      if (typeof payload.required === 'boolean') required = payload.required;
    } catch { /* malformed legacy payload keeps the conservative browser fallback */ }
    const presentation = ownerSessionName
      ? this.#resolveSessionPresentation?.(ownerSessionName, durableObservedAt)
      : undefined;
    const leaseActive = typeof row.lease_id === 'string' && row.lease_id.trim().length > 0;
    const heartbeatAt = row.heartbeat_at === null || row.heartbeat_at === undefined
      ? undefined : Number(row.heartbeat_at);
    return {
      assignmentId: String(row.assignment_id),
      taskId: String(row.task_id),
      status,
      phase: supervisionConsoleStatusGroup(status),
      auditRevision: row.audit_revision ? String(row.audit_revision) : undefined,
      role: row.role ? String(row.role) : undefined,
      required,
      leaseActive,
      // Derived once, server-side, so the browser renders a fact instead of
      // guessing liveness from a raw timestamp it is forbidden to read.
      executionHealth: supervisionConsoleExecutionHealth({ leaseActive, heartbeatAt, now }),
      awaitingExternalCi: status === 'retrying_external_ci',
      ownerSessionName,
      ownerSessionLabel: presentation?.label,
      ownerAgentType: row.agent_type ? String(row.agent_type) : undefined,
      observedModel: row.observed_model ? String(row.observed_model) : undefined,
      observedThinking: presentation?.thinking ?? (() => {
        try {
          const payload = JSON.parse(String(row.payload_json ?? '{}')) as Record<string, unknown>;
          const value = payload.thinking ?? payload.effort;
          return typeof value === 'string' && value.trim() ? value.trim() : undefined;
        } catch { return undefined; }
      })(),
      observedProvider: row.observed_provider ? String(row.observed_provider)
        : (row.provider_family ? String(row.provider_family) : undefined),
      sessionState: presentation?.state ?? 'unknown',
      sessionStateSource: presentation?.source ?? 'registry',
      sessionStateObservedAt: presentation?.observedAt ?? durableObservedAt,
      poolKind: readPoolKind(row.pool_kind),
      validationState: readValidationState(row.validation_state),
      auditAttemptId: row.audit_attempt_id ? String(row.audit_attempt_id) : undefined,
      auditVerdict: verdict,
      blocker: row.blocker ? String(row.blocker) : undefined,
      nextAction: row.next_action ? String(row.next_action) : undefined,
      recoveryState: row.recovery_state ? String(row.recovery_state) : undefined,
      recoveryReason: row.recovery_reason ? String(row.recovery_reason) : undefined,
      heartbeatAt,
      updatedAt: Number(row.updated_at ?? 0),
      lastEventId: Number(row.last_durable_event_id ?? 0),
    };
  }

  /**
   * Both pools are always projected, even at zero occupancy: an empty column is
   * information ("nothing is running there"), whereas a missing column reads as
   * a broken console.
   */
  readPools(projectName: string): SupervisionTaskConsolePoolRow[] {
    const byKind = new Map<string, number>();
    for (const assignment of this.readAssignmentRows(projectName)) {
      if (!assignment.poolKind
        || (POOL_INACTIVE_ASSIGNMENT_STATUSES as readonly string[]).includes(assignment.status)) continue;
      byKind.set(assignment.poolKind, (byKind.get(assignment.poolKind) ?? 0) + 1);
    }
    return SupervisionConsoleProducer.#poolRows(byKind);
  }

  /**
   * Same result as {@link readPools} without projecting every assignment: only
   * the rows that can occupy a pool slot are read, and each goes through the
   * same visibility / status / pool-kind rules. The equivalence is asserted by
   * a test against the full projection.
   */
  readPoolsIncremental(projectName: string): SupervisionTaskConsolePoolRow[] {
    const inactive = POOL_INACTIVE_ASSIGNMENT_STATUSES.map(() => '?').join(', ');
    const rows = this.#db.prepare(
      `SELECT a.task_id, a.status, a.pool_kind
       FROM supervision_task_assignments a
       INNER JOIN supervision_tasks t ON t.task_id = a.task_id
       WHERE t.project_name = ? AND a.pool_kind IS NOT NULL AND a.status NOT IN (${inactive})`,
    ).all(projectName, ...POOL_INACTIVE_ASSIGNMENT_STATUSES) as Array<Record<string, unknown>>;
    const byKind = new Map<string, number>();
    for (const row of rows) {
      if (!isSupervisionTaskLifecycleStatus(String(row.status ?? ''))) continue;
      const kind = readPoolKind(row.pool_kind);
      if (!kind || !this.#isTaskVisible(projectName, String(row.task_id))) continue;
      byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    }
    return SupervisionConsoleProducer.#poolRows(byKind);
  }

  #readPoolsForDelta(projectName: string): SupervisionTaskConsolePoolRow[] {
    const cached = this.#passPools?.get(projectName);
    if (cached) return cached;
    const pools = this.readPoolsIncremental(projectName);
    this.#passPools?.set(projectName, pools);
    return pools;
  }

  static #poolRows(byKind: ReadonlyMap<string, number>): SupervisionTaskConsolePoolRow[] {
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

  /**
   * `pairs`-engine projects: rows come from the task-pair store. `status`
   * carries the closest legacy lifecycle so the console groups them like
   * legacy rows; `pair` carries the real pair state.
   *
   * `inlineBrief` (default) is the legacy shape with every brief embedded; a
   * PAIR_DELTA_V1 viewer gets `briefRevision` instead and fetches the text on
   * demand.
   */
  readPairRows(
    projectName: string,
    options: { inlineBrief?: boolean } = {},
  ): { tasks: SupervisionTaskConsoleTaskRow[]; assignments: SupervisionTaskConsoleAssignmentRow[]; entries: SupervisionTaskConsolePairUpsert[] } {
    const inlineBrief = options.inlineBrief !== false;
    const pairs = getTaskPairStore().listPairs(projectName);
    const queuePositions = computePairQueuePositions(pairs);
    const tasks: SupervisionTaskConsoleTaskRow[] = [];
    const assignments: SupervisionTaskConsoleAssignmentRow[] = [];
    const entries: SupervisionTaskConsolePairUpsert[] = [];
    for (const stored of pairs) {
      const entry = buildPairConsoleRow(stored, {
        inlineBrief,
        queuePosition: queuePositions.get(stored.state.taskId),
        resolvePresentation: this.#resolveSessionPresentation,
      });
      entries.push(entry);
      tasks.push(entry.task);
      assignments.push(...entry.assignments);
    }
    return { tasks, assignments, entries };
  }

  /** A pair's brief text + its revision, for the on-demand BRIEF_RESPONSE. */
  readPairBrief(projectName: string, taskId: string): { briefRevision: string; brief: string } | null {
    const brief = getTaskPairStore().getPair(projectName, taskId)?.state.brief;
    return brief ? { briefRevision: taskPairBriefRevision(brief), brief } : null;
  }

  /**
   * Whether the console shows this project's PAIR rows. Supervision on (the pairs engine) always does; with supervision off the
   * project still shows the pairs it has been given by hand, as long as it has a Brain, so a manual pair's lifecycle is visible
   * (a project with no pair stays on the registry rows it always had).
   */
  isPairsProject(scope: SupervisionTaskConsoleScope): boolean {
    return this.#showsPairs(scope.projectName);
  }

  #showsPairs(projectName: string): boolean {
    return isPairsEngineProject(projectName)
      || (getTaskPairStore().countPairs(projectName) > 0 && isTaskPairsAvailable(projectName));
  }

  #pairViewKey(scope: SupervisionTaskConsoleScope, subscriptionId: string): string {
    return JSON.stringify([scope.projectName, scope.coordinatorSessionName, subscriptionId]);
  }

  #seedPairView(scope: SupervisionTaskConsoleScope, subscriptionId: string, snapshot: object): void {
    const entries = this.#pairSnapshotEntries.get(snapshot);
    if (!entries) return;
    // Revisions restart at 0 with each snapshot: deltas are only ever
    // meaningful against the snapshot of the subscription they belong to.
    const view: PairScopeView = { revision: 0, rows: new Map() };
    // Fresh wrappers per viewer: each view memoizes its own row JSON.
    for (const entry of entries) view.rows.set(entry.task.taskId, { upsert: entry });
    this.#pairViews.set(this.#pairViewKey(scope, subscriptionId), view);
  }

  /**
   * One viewer went away or must be re-seeded by its next snapshot. Without a
   * subscription id every viewer of the scope is dropped.
   */
  dropPairView(scope: SupervisionTaskConsoleScope, subscriptionId?: string): void {
    if (subscriptionId !== undefined) {
      this.#pairViews.delete(this.#pairViewKey(scope, subscriptionId));
      return;
    }
    const prefix = JSON.stringify([scope.projectName, scope.coordinatorSessionName]).slice(0, -1);
    for (const key of this.#pairViews.keys()) if (key.startsWith(`${prefix},`)) this.#pairViews.delete(key);
  }

  /**
   * One frame for the pairs that changed since this scope's viewer was last
   * sent, or undefined when nothing the viewer can see changed (or it has no
   * snapshot to be a delta against yet).
   *
   * Cost is O(changed pairs + queued pairs), not O(pairs): the 200-row window
   * is checked with an id-only query, and only candidate rows are rebuilt and
   * compared against what was sent.
   */
  buildPairDelta(scope: SupervisionTaskConsoleScope, subscriptionId: string, dirtyTaskIds: Iterable<string>): SupervisionTaskConsolePairDelta | undefined {
    return withEventLoopWatchdogPhase('supervision-console.pair-delta', () => {
      const view = this.#pairViews.get(this.#pairViewKey(scope, subscriptionId));
      if (!view) return undefined;
      const store = getTaskPairStore();
      const windowIds = store.listPairWindowIds(scope.projectName);
      const windowSet = new Set(windowIds);
      const removes: string[] = [];
      for (const taskId of view.rows.keys()) if (!windowSet.has(taskId)) removes.push(taskId);
      const queued = store.listQueuedPairs(scope.projectName).filter((stored) => windowSet.has(stored.state.taskId));
      const queuedById = new Map(queued.map((stored) => [stored.state.taskId, stored] as const));
      const queuePositions = computePairQueuePositions(queued);
      const candidates = new Set<string>();
      for (const taskId of dirtyTaskIds) if (windowSet.has(taskId)) candidates.add(taskId);
      for (const taskId of windowIds) if (!view.rows.has(taskId)) candidates.add(taskId);
      // Positions of sibling queued pairs shift when one is added/removed/reordered.
      for (const taskId of queuedById.keys()) candidates.add(taskId);
      const windowIndex = new Map(windowIds.map((id, index) => [id, index] as const));
      const upserts: SupervisionTaskConsolePairDeltaUpsert[] = [];
      for (const taskId of candidates) {
        const stored = queuedById.get(taskId) ?? store.getPair(scope.projectName, taskId);
        if (!stored) {
          if (view.rows.has(taskId)) removes.push(taskId);
          continue;
        }
        const upsert = buildPairConsoleRow(stored, {
          inlineBrief: false,
          queuePosition: queuePositions.get(taskId),
          resolvePresentation: this.#resolveSessionPresentation,
        });
        const json = pairRowJson(upsert);
        const previous = view.rows.get(taskId);
        if (previous && (previous.json ??= pairRowJson(previous.upsert)) === json) continue;
        view.rows.set(taskId, { json, upsert });
        upserts.push({ ...upsert, position: windowIndex.get(taskId) ?? 0 });
      }
      for (const taskId of removes) view.rows.delete(taskId);
      if (upserts.length === 0 && removes.length === 0) return undefined;
      view.revision += 1;
      return {
        type: SUPERVISION_TASK_CONSOLE_MSG.PAIR_DELTA,
        scope,
        subscriptionId,
        pairRevision: view.revision,
        generatedAt: this.#now(),
        upserts,
        removes,
      };
    });
  }

  buildSnapshot(scope: SupervisionTaskConsoleScope, subscriptionId: string, options: { pairDelta?: boolean } = {}): SupervisionTaskConsoleSnapshot {
    return withEventLoopWatchdogPhase('supervision-console.build-snapshot', () => traceSync(
      'supervision-console.build-snapshot',
      { projectName: scope.projectName },
      () => {
        const base = this.#buildSnapshotCached(scope, options.pairDelta === true);
        if (options.pairDelta === true) this.#seedPairView(scope, subscriptionId, base);
        return { ...base, subscriptionId };
      },
    ));
  }

  #buildSnapshotCached(scope: SupervisionTaskConsoleScope, pairDelta = false): Omit<SupervisionTaskConsoleSnapshot, 'subscriptionId'> {
    const key = this.#snapshotModeKey(scope, pairDelta);
    const cursor = this.restoreCursor(scope);
    // A pair-delta snapshot seeds the per-scope pair view, so it must be built
    // fresh: a cached one would carry a pairRevision older than the deltas
    // already sent and the viewer would see a gap.
    if (pairDelta && this.#showsPairs(scope.projectName)) {
      return this.#withAssignmentPass(() => this.#buildSnapshotParts(scope, cursor, true));
    }
    const now = Date.now();
    const dataVersion = this.#readDataVersion();
    const cached = this.#snapshotCache.get(key);
    if (cached
      && this.#snapshotCacheTtlMs > 0
      && now - cached.builtAt < this.#snapshotCacheTtlMs
      && cached.dataVersion === dataVersion
      && cached.projectionVersion === cursor.projectionVersion
      && cached.lastDurableEventId === cursor.lastDurableEventId
      && cached.projectionEpoch === cursor.projectionEpoch) {
      return cached.snapshot;
    }
    const snapshot = this.#withAssignmentPass(() => this.#buildSnapshotParts(scope, cursor, false));
    this.#snapshotCache.set(key, {
      builtAt: now,
      dataVersion,
      projectionVersion: cursor.projectionVersion,
      lastDurableEventId: cursor.lastDurableEventId,
      projectionEpoch: cursor.projectionEpoch,
      snapshot,
    });
    return snapshot;
  }

  #buildSnapshotParts(
    scope: SupervisionTaskConsoleScope,
    cursor: ReturnType<SupervisionConsoleProducer['restoreCursor']>,
    pairDelta: boolean,
  ): Omit<SupervisionTaskConsoleSnapshot, 'subscriptionId'> {
    const pairRows = this.#showsPairs(scope.projectName)
      ? this.readPairRows(scope.projectName, { inlineBrief: !pairDelta })
      : undefined;
    const pairRevision: number | undefined = pairRows && pairDelta ? 0 : undefined;
    const tasks = pairRows?.tasks ?? [...this.#visibleTaskIds(scope.projectName)]
      .map((taskId) => this.readTaskRow(taskId, scope.projectName))
      .filter((row): row is SupervisionTaskConsoleTaskRow => !!row);
    const snapshot: Omit<SupervisionTaskConsoleSnapshot, 'subscriptionId'> = {
      type: SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT,
      scope,
      schemaVersion: SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
      statusContractVersion: SUPERVISION_TASK_STATUS_CONTRACT_VERSION,
      projectionVersion: cursor.projectionVersion,
      lastDurableEventId: cursor.lastDurableEventId,
      projectionEpoch: cursor.projectionEpoch,
      generatedAt: this.#now(),
      tasks,
      assignments: pairRows?.assignments ?? this.readAssignmentRows(scope.projectName),
      // A pairs project has no legacy assignment rows to project for the
      // snapshot, but its pool occupancy still comes from the registry: count
      // it directly instead of projecting every historical assignment (~24 ms
      // on a real registry) just to derive two integers.
      pools: pairRows ? this.readPoolsIncremental(scope.projectName) : this.readPools(scope.projectName),
      ...(pairRevision !== undefined ? { pairRevision } : {}),
    };
    // No pair rows means the project has no Brain session (the legacy engine is retired). Pairs may still sit on disk: say so
    // rather than present a silent empty list.
    const inertPairs = pairRows ? 0 : getTaskPairStore().countPairs(scope.projectName);
    if (inertPairs > 0) snapshot.inertPairs = inertPairs;
    if (pairRows && pairDelta) this.#pairSnapshotEntries.set(snapshot, pairRows.entries);
    return snapshot;
  }

  /**
   * Apply a completed peer-audit receipt.
   *
   * The decision is taken by the pure state machine; this method only persists
   * it, atomically. A receipt that does not advance the lifecycle still records
   * its durable blocked reason so no PASS can sit silently unowned.
   */
  applyAuditReceipt(scope: SupervisionTaskConsoleScope, receipt: SupervisionAuditReceipt): SupervisionHandoffDecision {
    const scoped = this.#db.prepare(
      `SELECT 1 AS ok FROM supervision_tasks t
       INNER JOIN supervision_task_assignments a ON a.task_id = t.task_id
       WHERE t.task_id = ? AND t.project_name = ? AND a.assignment_id = ?`,
    ).get(receipt.taskId, scope.projectName, receipt.assignmentId) as { ok?: number } | undefined;
    if (!scoped?.ok) throw new Error('supervision audit receipt is outside the requested project scope');
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
