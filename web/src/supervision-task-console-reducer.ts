import {
  SUPERVISION_TASK_CONSOLE_MSG,
  SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
  evaluateSupervisionConsoleCursor,
  initialSupervisionConsoleCursor,
  isStaleSupervisionConsoleResponse,
  isValidSupervisionTaskConsoleEvent,
  type SupervisionConsoleResyncReason,
  type SupervisionTaskConsoleAssignmentRow,
  type SupervisionConsoleDeltaOp,
  type SupervisionTaskConsoleDelta,
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

export interface SupervisionTaskConsoleReducerState {
  scope: SupervisionTaskConsoleScope;
  subscriptionId: string | null;
  phase: SupervisionTaskConsolePhase;
  schemaVersion: number;
  statusContractVersion: number;
  projectionVersion: number;
  lastDurableEventId: number | null;
  projectionEpoch: string;
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
  | { type: 'snapshot_received'; payload: unknown }
  | { type: 'delta_received'; payload: unknown }
  | { type: 'server_resync_required'; reason: SupervisionConsoleResyncReason }
  | { type: 'transport_error'; error: string }
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

function containsUnknownLifecycleStatus(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  const rows = [
    ...(Array.isArray(payload.tasks) ? payload.tasks : []),
    ...(Array.isArray(payload.assignments) ? payload.assignments : []),
  ];
  return rows.some((row) => (
    isRecord(row)
      && typeof row.status === 'string'
      && !isSupervisionTaskLifecycleStatus(row.status)
  ));
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
    phase: SUPERVISION_TASK_CONSOLE_PHASE.RESYNCING,
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
    schemaVersion: cursor.schemaVersion,
    statusContractVersion: cursor.statusContractVersion,
    projectionVersion: cursor.projectionVersion,
    lastDurableEventId: cursor.lastDurableEventId,
    projectionEpoch: cursor.projectionEpoch,
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
  const tasks = indexUnique(snapshot.tasks, (task) => task.taskId);
  const assignments = indexUnique(snapshot.assignments, (assignment) => assignment.assignmentId);
  const poolsById = indexUnique(snapshot.pools, (pool) => pool.poolId);
  if (!tasks || !assignments || !poolsById || !assignmentsReferenceKnownTasks(assignments, tasks)) {
    return requestResync(state, 'cursor_unknown');
  }
  return {
    ...state,
    phase: SUPERVISION_TASK_CONSOLE_PHASE.READY,
    schemaVersion: snapshot.schemaVersion,
    statusContractVersion: snapshot.statusContractVersion,
    projectionVersion: snapshot.projectionVersion,
    lastDurableEventId: snapshot.lastDurableEventId,
    projectionEpoch: snapshot.projectionEpoch,
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
  const pools = delta.op === 'pools_update' ? (delta.pools ?? []) : state.pools;
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
    tasks,
    assignments,
    eventsByTask,
    pools,
    resyncReason: null,
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
        phase: SUPERVISION_TASK_CONSOLE_PHASE.SUBSCRIBING,
        error: null,
      };
    case 'snapshot_received':
      if (isStaleProjection(state, action.payload)) return state;
      if (!isValidSupervisionTaskConsoleEvent(action.payload)
        || action.payload.type !== SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT) {
        return requestResync(state, containsUnknownLifecycleStatus(action.payload)
          ? 'status_contract_mismatch'
          : 'cursor_unknown');
      }
      return applySnapshot(state, action.payload);
    case 'delta_received':
      if (isStaleProjection(state, action.payload)) return state;
      if (!isValidSupervisionTaskConsoleEvent(action.payload)
        || action.payload.type !== SUPERVISION_TASK_CONSOLE_MSG.DELTA) {
        return requestResync(state, containsUnknownLifecycleStatus(action.payload)
          ? 'status_contract_mismatch'
          : 'cursor_unknown');
      }
      return applyDelta(state, action.payload);
    case 'server_resync_required':
      return requestResync(state, action.reason);
    case 'transport_error':
      return {
        ...state,
        phase: SUPERVISION_TASK_CONSOLE_PHASE.ERROR,
        error: action.error,
      };
    case 'transport_disconnected':
      return {
        ...state,
        phase: SUPERVISION_TASK_CONSOLE_PHASE.ERROR,
        error: 'transport_disconnected',
      };
  }
}
