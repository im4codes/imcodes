import {
  SUPERVISION_TASK_CONSOLE_MSG,
  SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
  evaluateSupervisionConsoleCursor,
  initialSupervisionConsoleCursor,
  isStaleSupervisionConsoleResponse,
  isValidSupervisionTaskConsoleEvent,
  isValidSupervisionTaskConsolePairDelta,
  type SupervisionConsoleResyncReason,
  type SupervisionTaskConsoleAssignmentRow,
  type SupervisionConsoleDeltaOp,
  type SupervisionTaskConsoleDelta,
  type SupervisionTaskConsolePairDelta,
  type SupervisionTaskConsolePoolRow,
  type SupervisionTaskConsoleScope,
  type SupervisionTaskConsoleSnapshot,
  type SupervisionTaskConsoleTaskRow,
} from '@shared/supervision-task-console.js';
import {
  SUPERVISION_TASK_STATUS_CONTRACT_VERSION,
  isSupervisionTaskLifecycleStatus,
} from '@shared/supervision-config.js';

export const SUPERVISION_TASK_CONSOLE_PHASE = {
  IDLE: 'idle',
  SUBSCRIBING: 'subscribing',
  READY: 'ready',
  RESYNCING: 'resyncing',
  ERROR: 'error',
} as const;

export type SupervisionTaskConsolePhase =
  typeof SUPERVISION_TASK_CONSOLE_PHASE[keyof typeof SUPERVISION_TASK_CONSOLE_PHASE];

export const SUPERVISION_TASK_CONSOLE_SYNC_STATE = {
  CONNECTING: 'connecting',
  SYNCED: 'synced',
  STALE: 'stale',
  ERROR: 'error',
} as const;
export type SupervisionTaskConsoleSyncState =
  typeof SUPERVISION_TASK_CONSOLE_SYNC_STATE[keyof typeof SUPERVISION_TASK_CONSOLE_SYNC_STATE];

export interface SupervisionTaskConsoleReducerState {
  scope: SupervisionTaskConsoleScope;
  subscriptionId: string | null;
  phase: SupervisionTaskConsolePhase;
  hasAuthoritativeSnapshot: boolean;
  syncing: boolean;
  syncState: SupervisionTaskConsoleSyncState;
  lastSyncedAt: number | null;
  schemaVersion: number;
  statusContractVersion: number;
  projectionVersion: number;
  lastDurableEventId: number | null;
  projectionEpoch: string;
  /**
   * Revision the pair rows are at, from a PAIR_DELTA_V1 snapshot; null when the
   * daemon sent the legacy shape (it then repairs pair changes by resync).
   */
  pairRevision: number | null;
  /**
   * The rows are the pair store's (a `pairs`-engine project), not the legacy
   * registry's. Legacy DELTA frames then describe rows this projection does not
   * hold: they may move the cursor but must never touch a row. (The legacy
   * registry keeps the tasks pairs were imported from under the SAME ids, so
   * applying one replaced a cancelled pair row with a `delegated` legacy row.)
   */
  pairProjection: boolean;
  /** Stored pairs of an engine-off project that the daemon does not track (0 when none). */
  inertPairs: number;
  tasks: Readonly<Record<string, SupervisionTaskConsoleTaskRow>>;
  assignments: Readonly<Record<string, SupervisionTaskConsoleAssignmentRow>>;
  eventsByTask: Readonly<Record<string, readonly SupervisionTaskConsoleEventEvidence[]>>;
  pools: readonly SupervisionTaskConsolePoolRow[];
  resyncReason: SupervisionConsoleResyncReason | null;
  resyncGeneration: number;
  error: string | null;
}

export interface SupervisionTaskConsoleEventEvidence {
  eventId: number;
  projectionVersion: number;
  op: SupervisionConsoleDeltaOp;
}

export type SupervisionTaskConsoleReducerAction =
  | { type: 'scope_changed'; scope: SupervisionTaskConsoleScope }
  | { type: 'subscribe_started'; subscriptionId: string }
  | { type: 'snapshot_received'; payload: unknown; receivedAt?: number }
  | { type: 'delta_received'; payload: unknown; receivedAt?: number }
  | { type: 'pair_delta_received'; payload: unknown; receivedAt?: number }
  | { type: 'server_resync_required'; reason: SupervisionConsoleResyncReason }
  | { type: 'transport_error'; error: string }
  | { type: 'authority_invalidated'; error: string }
  | { type: 'transport_disconnected' };

function sameScope(left: SupervisionTaskConsoleScope, right: SupervisionTaskConsoleScope): boolean {
  return left.projectName === right.projectName
    && left.coordinatorSessionName === right.coordinatorSessionName;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStaleProjection(
  state: SupervisionTaskConsoleReducerState,
  payload: unknown,
): boolean {
  return Boolean(
    state.subscriptionId
      && isRecord(payload)
      && typeof payload.subscriptionId === 'string'
      && payload.subscriptionId !== state.subscriptionId,
  );
}

function hasUnknownLifecycleStatus(row: unknown): boolean {
  return isRecord(row) && typeof row.status === 'string' && !isSupervisionTaskLifecycleStatus(row.status);
}

/**
 * A row whose status this build does not know affects only that row. Rejecting
 * the whole projection instead made the controller resubscribe forever, and
 * every resubscribe forced the daemon to rebuild a full snapshot -- the same
 * unknown row came back each time and pegged the daemon's main thread.
 * Keep the row in a neutral lifecycle bucket so valid rows and the unknown row
 * remain visible. `unknownStatus` preserves the daemon value for the UI while
 * the normalized enum/phase keeps the wire validator and tab grouping safe.
 */
function normalizeUnknownLifecycleRows(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  if (payload.type === SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT) {
    if (!Array.isArray(payload.tasks) || !Array.isArray(payload.assignments)) return payload;
    const normalize = (row: unknown): unknown => {
      if (!hasUnknownLifecycleStatus(row)) return row;
      return { ...(row as Record<string, unknown>), status: 'planned', phase: 'active', unknownStatus: (row as Record<string, unknown>).status };
    };
    return {
      ...payload,
      tasks: payload.tasks.map(normalize),
      assignments: payload.assignments.map(normalize),
    };
  }
  const normalize = (row: unknown): unknown => {
    if (!hasUnknownLifecycleStatus(row)) return row;
    return { ...(row as Record<string, unknown>), status: 'planned', phase: 'active', unknownStatus: (row as Record<string, unknown>).status };
  };
  if (payload.type === SUPERVISION_TASK_CONSOLE_MSG.PAIR_DELTA) {
    if (!Array.isArray(payload.upserts)) return payload;
    return {
      ...payload,
      upserts: payload.upserts.map((upsert) => (isRecord(upsert)
        ? {
          ...upsert,
          task: normalize(upsert.task),
          ...(Array.isArray(upsert.assignments) ? { assignments: upsert.assignments.map(normalize) } : {}),
        }
        : upsert)),
    };
  }
  if (payload.type !== SUPERVISION_TASK_CONSOLE_MSG.DELTA) return payload;
  return {
    ...payload,
    ...(payload.task ? { task: normalize(payload.task) } : {}),
    ...(payload.assignment ? { assignment: normalize(payload.assignment) } : {}),
  };
}

function indexUnique<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
): Readonly<Record<string, T>> | null {
  const indexed: Record<string, T> = {};
  for (const value of values) {
    const key = keyOf(value);
    if (!key || Object.prototype.hasOwnProperty.call(indexed, key)) return null;
    indexed[key] = value;
  }
  return indexed;
}

function assignmentsReferenceKnownTasks(
  assignments: Readonly<Record<string, SupervisionTaskConsoleAssignmentRow>>,
  tasks: Readonly<Record<string, SupervisionTaskConsoleTaskRow>>,
): boolean {
  return Object.values(assignments).every((assignment) => Boolean(tasks[assignment.taskId]));
}

function requestResync(
  state: SupervisionTaskConsoleReducerState,
  reason: SupervisionConsoleResyncReason,
): SupervisionTaskConsoleReducerState {
  return {
    ...state,
    phase: state.hasAuthoritativeSnapshot
      ? SUPERVISION_TASK_CONSOLE_PHASE.READY
      : SUPERVISION_TASK_CONSOLE_PHASE.RESYNCING,
    syncing: true,
    syncState: SUPERVISION_TASK_CONSOLE_SYNC_STATE.CONNECTING,
    resyncReason: reason,
    resyncGeneration: state.resyncGeneration + 1,
    error: null,
  };
}

export function createSupervisionTaskConsoleState(
  scope: SupervisionTaskConsoleScope,
): SupervisionTaskConsoleReducerState {
  const cursor = initialSupervisionConsoleCursor(scope);
  return {
    scope,
    subscriptionId: null,
    phase: SUPERVISION_TASK_CONSOLE_PHASE.IDLE,
    hasAuthoritativeSnapshot: false,
    syncing: false,
    syncState: SUPERVISION_TASK_CONSOLE_SYNC_STATE.CONNECTING,
    lastSyncedAt: null,
    schemaVersion: cursor.schemaVersion,
    statusContractVersion: cursor.statusContractVersion,
    projectionVersion: cursor.projectionVersion,
    lastDurableEventId: cursor.lastDurableEventId,
    projectionEpoch: cursor.projectionEpoch,
    pairRevision: null,
    pairProjection: false,
    inertPairs: 0,
    tasks: {},
    assignments: {},
    eventsByTask: {},
    pools: [],
    resyncReason: null,
    resyncGeneration: 0,
    error: null,
  };
}

function applySnapshot(
  state: SupervisionTaskConsoleReducerState,
  snapshot: SupervisionTaskConsoleSnapshot,
  receivedAt: number,
): SupervisionTaskConsoleReducerState {
  if (!sameScope(state.scope, snapshot.scope)) {
    return requestResync(state, 'scope_mismatch');
  }
  if (!state.subscriptionId || isStaleSupervisionConsoleResponse({
    activeSubscriptionId: state.subscriptionId,
    responseSubscriptionId: snapshot.subscriptionId,
  })) return state;
  if (snapshot.schemaVersion !== SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION) {
    return requestResync(state, 'schema_mismatch');
  }
  if (snapshot.statusContractVersion !== SUPERVISION_TASK_STATUS_CONTRACT_VERSION) {
    return requestResync(state, 'status_contract_mismatch');
  }
  if (snapshot.projectionEpoch === state.projectionEpoch
    && snapshot.projectionVersion < state.projectionVersion) return state;
  const tasks = indexUnique(snapshot.tasks, (task) => task.taskId);
  const assignments = indexUnique(snapshot.assignments, (assignment) => assignment.assignmentId);
  const poolsById = indexUnique(snapshot.pools, (pool) => pool.poolId);
  if (!tasks || !assignments || !poolsById || !assignmentsReferenceKnownTasks(assignments, tasks)) {
    return requestResync(state, 'cursor_unknown');
  }
  return {
    ...state,
    phase: SUPERVISION_TASK_CONSOLE_PHASE.READY,
    hasAuthoritativeSnapshot: true,
    syncing: false,
    syncState: SUPERVISION_TASK_CONSOLE_SYNC_STATE.SYNCED,
    lastSyncedAt: receivedAt,
    schemaVersion: snapshot.schemaVersion,
    statusContractVersion: snapshot.statusContractVersion,
    projectionVersion: snapshot.projectionVersion,
    lastDurableEventId: snapshot.lastDurableEventId,
    projectionEpoch: snapshot.projectionEpoch,
    pairRevision: typeof snapshot.pairRevision === 'number' ? snapshot.pairRevision : null,
    pairProjection: typeof snapshot.pairRevision === 'number' || snapshot.tasks.some((task) => Boolean(task.pair)),
    inertPairs: Number.isInteger(snapshot.inertPairs) && (snapshot.inertPairs ?? 0) > 0 ? snapshot.inertPairs! : 0,
    tasks,
    assignments,
    eventsByTask: {},
    pools: snapshot.pools,
    resyncReason: null,
    error: null,
  };
}

function applyDelta(
  state: SupervisionTaskConsoleReducerState,
  delta: SupervisionTaskConsoleDelta,
  receivedAt: number,
): SupervisionTaskConsoleReducerState {
  if (state.phase !== SUPERVISION_TASK_CONSOLE_PHASE.READY) {
    return requestResync(state, 'cursor_unknown');
  }
  if (!state.subscriptionId || isStaleSupervisionConsoleResponse({
    activeSubscriptionId: state.subscriptionId,
    responseSubscriptionId: delta.subscriptionId,
  })) return state;
  const cursorDecision = evaluateSupervisionConsoleCursor({
    client: state,
    incoming: delta,
  });
  if (cursorDecision.decision === 'ignore_duplicate') return state;
  if (cursorDecision.decision === 'resync_required') {
    if (cursorDecision.reason === 'in_order' || cursorDecision.reason === 'already_applied') {
      return requestResync(state, 'cursor_unknown');
    }
    return requestResync(state, cursorDecision.reason);
  }
  if (delta.eventId !== delta.lastDurableEventId || delta.eventId === state.lastDurableEventId) {
    return requestResync(state, 'cursor_unknown');
  }
  if (state.pairProjection) {
    // Legacy-registry event on a pairs project: keep the cursor dense so the
    // next frame is still "in order", leave every row alone.
    return {
      ...state,
      projectionVersion: delta.projectionVersion,
      lastDurableEventId: delta.lastDurableEventId,
      projectionEpoch: delta.projectionEpoch,
      error: null,
    };
  }

  const tasks: Record<string, SupervisionTaskConsoleTaskRow> = { ...state.tasks };
  const assignments: Record<string, SupervisionTaskConsoleAssignmentRow> = { ...state.assignments };
  const eventsByTask: Record<string, readonly SupervisionTaskConsoleEventEvidence[]> = { ...state.eventsByTask };
  let eventTaskId: string | null = null;
  switch (delta.op) {
    case 'task_upsert':
      if (!delta.task) return requestResync(state, 'cursor_unknown');
      tasks[delta.task.taskId] = delta.task;
      eventTaskId = delta.task.taskId;
      break;
    case 'task_remove':
      if (!delta.removedId) return requestResync(state, 'cursor_unknown');
      delete tasks[delta.removedId];
      delete eventsByTask[delta.removedId];
      for (const [assignmentId, assignment] of Object.entries(assignments)) {
        if (assignment.taskId === delta.removedId) delete assignments[assignmentId];
      }
      break;
    case 'assignment_upsert':
      if (!delta.assignment) return requestResync(state, 'cursor_unknown');
      assignments[delta.assignment.assignmentId] = delta.assignment;
      if (delta.task) {
        if (delta.task.taskId !== delta.assignment.taskId) {
          return requestResync(state, 'cursor_unknown');
        }
        tasks[delta.task.taskId] = delta.task;
      }
      eventTaskId = delta.assignment.taskId;
      break;
    case 'assignment_remove':
      if (!delta.removedId) return requestResync(state, 'cursor_unknown');
      eventTaskId = assignments[delta.removedId]?.taskId ?? null;
      delete assignments[delta.removedId];
      break;
    case 'pools_update':
      break;
  }
  const pools = delta.pools ?? state.pools;
  if (!indexUnique(pools, (pool) => pool.poolId) || !assignmentsReferenceKnownTasks(assignments, tasks)) {
    return requestResync(state, 'cursor_unknown');
  }
  if (eventTaskId && tasks[eventTaskId]) {
    eventsByTask[eventTaskId] = [
      ...(eventsByTask[eventTaskId] ?? []),
      { eventId: delta.eventId, projectionVersion: delta.projectionVersion, op: delta.op },
    ].slice(-20);
  }
  return {
    ...state,
    projectionVersion: delta.projectionVersion,
    lastDurableEventId: delta.lastDurableEventId,
    projectionEpoch: delta.projectionEpoch,
    hasAuthoritativeSnapshot: true,
    syncing: false,
    syncState: SUPERVISION_TASK_CONSOLE_SYNC_STATE.SYNCED,
    lastSyncedAt: receivedAt,
    tasks,
    assignments,
    eventsByTask,
    pools,
    resyncReason: null,
    error: null,
  };
}

/**
 * Merge a one-pair (or few-pair) delta. Untouched rows keep their identity and
 * relative order; each upserted pair is inserted at the position the daemon
 * reports, so the result is exactly the list a fresh snapshot would produce.
 */
function applyPairDelta(
  state: SupervisionTaskConsoleReducerState,
  delta: SupervisionTaskConsolePairDelta,
  receivedAt: number,
): SupervisionTaskConsoleReducerState {
  if (!sameScope(state.scope, delta.scope)) return requestResync(state, 'scope_mismatch');
  if (!state.subscriptionId || isStaleSupervisionConsoleResponse({
    activeSubscriptionId: state.subscriptionId,
    responseSubscriptionId: delta.subscriptionId,
  })) return state;
  // Still waiting for this subscription's snapshot: the snapshot is the base a
  // delta applies to, and it will carry these changes itself.
  if (state.syncing) return state;
  if (state.pairRevision === null) return requestResync(state, 'cursor_unknown');
  if (delta.pairRevision <= state.pairRevision) return state;
  if (delta.pairRevision !== state.pairRevision + 1) return requestResync(state, 'version_gap');

  const changed = new Set<string>([...delta.removes, ...delta.upserts.map((upsert) => upsert.task.taskId)]);
  const order = Object.keys(state.tasks).filter((taskId) => !changed.has(taskId));
  for (const upsert of [...delta.upserts].sort((left, right) => left.position - right.position)) {
    order.splice(Math.min(upsert.position, order.length), 0, upsert.task.taskId);
  }
  const upserted = new Map(delta.upserts.map((upsert) => [upsert.task.taskId, upsert] as const));
  const previousAssignments = new Map<string, SupervisionTaskConsoleAssignmentRow[]>();
  for (const assignment of Object.values(state.assignments)) {
    const group = previousAssignments.get(assignment.taskId) ?? [];
    group.push(assignment);
    previousAssignments.set(assignment.taskId, group);
  }
  const tasks: Record<string, SupervisionTaskConsoleTaskRow> = {};
  const assignments: Record<string, SupervisionTaskConsoleAssignmentRow> = {};
  for (const taskId of order) {
    const upsert = upserted.get(taskId);
    tasks[taskId] = upsert ? upsert.task : state.tasks[taskId]!;
    for (const assignment of upsert ? upsert.assignments : previousAssignments.get(taskId) ?? []) {
      assignments[assignment.assignmentId] = assignment;
    }
  }
  const eventsByTask: Record<string, readonly SupervisionTaskConsoleEventEvidence[]> = { ...state.eventsByTask };
  for (const taskId of delta.removes) delete eventsByTask[taskId];
  return {
    ...state,
    pairRevision: delta.pairRevision,
    hasAuthoritativeSnapshot: true,
    syncState: SUPERVISION_TASK_CONSOLE_SYNC_STATE.SYNCED,
    lastSyncedAt: receivedAt,
    tasks,
    assignments,
    eventsByTask,
    error: null,
  };
}

export function supervisionTaskConsoleReducer(
  state: SupervisionTaskConsoleReducerState,
  action: SupervisionTaskConsoleReducerAction,
): SupervisionTaskConsoleReducerState {
  switch (action.type) {
    case 'scope_changed':
      return sameScope(state.scope, action.scope) ? state : createSupervisionTaskConsoleState(action.scope);
    case 'subscribe_started':
      return {
        ...state,
        subscriptionId: action.subscriptionId,
        phase: state.hasAuthoritativeSnapshot
          ? SUPERVISION_TASK_CONSOLE_PHASE.READY
          : SUPERVISION_TASK_CONSOLE_PHASE.SUBSCRIBING,
        syncing: true,
        syncState: SUPERVISION_TASK_CONSOLE_SYNC_STATE.CONNECTING,
        error: null,
      };
    case 'snapshot_received': {
      if (isStaleProjection(state, action.payload)) return state;
      const payload = normalizeUnknownLifecycleRows(action.payload);
      if (!isValidSupervisionTaskConsoleEvent(payload)
        || payload.type !== SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT) {
        return requestResync(state, 'cursor_unknown');
      }
      return applySnapshot(state, payload, action.receivedAt ?? payload.generatedAt);
    }
    case 'delta_received': {
      if (isStaleProjection(state, action.payload)) return state;
      const payload = normalizeUnknownLifecycleRows(action.payload);
      if (!isValidSupervisionTaskConsoleEvent(payload)
        || payload.type !== SUPERVISION_TASK_CONSOLE_MSG.DELTA) {
        return requestResync(state, 'cursor_unknown');
      }
      return applyDelta(state, payload, action.receivedAt ?? state.lastSyncedAt ?? 0);
    }
    case 'pair_delta_received': {
      if (isStaleProjection(state, action.payload)) return state;
      const payload = normalizeUnknownLifecycleRows(action.payload);
      if (!isValidSupervisionTaskConsolePairDelta(payload)) return requestResync(state, 'cursor_unknown');
      return applyPairDelta(state, payload, action.receivedAt ?? state.lastSyncedAt ?? 0);
    }
    case 'server_resync_required':
      return requestResync(state, action.reason);
    case 'transport_error':
      return {
        ...state,
        phase: state.hasAuthoritativeSnapshot
          ? SUPERVISION_TASK_CONSOLE_PHASE.READY
          : SUPERVISION_TASK_CONSOLE_PHASE.ERROR,
        syncing: false,
        syncState: state.hasAuthoritativeSnapshot
          ? SUPERVISION_TASK_CONSOLE_SYNC_STATE.STALE
          : SUPERVISION_TASK_CONSOLE_SYNC_STATE.ERROR,
        error: action.error,
      };
    case 'authority_invalidated':
      return {
        ...createSupervisionTaskConsoleState(state.scope),
        phase: SUPERVISION_TASK_CONSOLE_PHASE.ERROR,
        syncState: SUPERVISION_TASK_CONSOLE_SYNC_STATE.ERROR,
        error: action.error,
      };
    case 'transport_disconnected':
      return {
        ...state,
        phase: state.hasAuthoritativeSnapshot
          ? SUPERVISION_TASK_CONSOLE_PHASE.READY
          : SUPERVISION_TASK_CONSOLE_PHASE.ERROR,
        syncing: false,
        syncState: state.hasAuthoritativeSnapshot
          ? SUPERVISION_TASK_CONSOLE_SYNC_STATE.STALE
          : SUPERVISION_TASK_CONSOLE_SYNC_STATE.ERROR,
        error: 'transport_disconnected',
      };
  }
}
