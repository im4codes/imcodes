import { describe, expect, it } from 'vitest';
import {
  SUPERVISION_TASK_CONSOLE_MSG,
  SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
  supervisionConsoleStatusGroup,
  type SupervisionTaskConsoleDelta,
  type SupervisionTaskConsoleScope,
  type SupervisionTaskConsoleSnapshot,
} from '../../shared/supervision-task-console.js';
import {
  SUPERVISION_TASK_LIFECYCLE_STATUSES,
  SUPERVISION_TASK_STATUS_CONTRACT_VERSION,
} from '../../shared/supervision-config.js';
import {
  SUPERVISION_TASK_CONSOLE_PHASE,
  createSupervisionTaskConsoleState,
  supervisionTaskConsoleReducer,
} from '../src/supervision-task-console-reducer.js';

const SCOPE: SupervisionTaskConsoleScope = {
  projectName: 'alpha',
  coordinatorSessionName: 'deck_alpha_brain',
};

function snapshot(
  overrides: Partial<SupervisionTaskConsoleSnapshot> = {},
): SupervisionTaskConsoleSnapshot {
  return {
    type: SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT,
    schemaVersion: SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
    statusContractVersion: SUPERVISION_TASK_STATUS_CONTRACT_VERSION,
    projectionVersion: 3,
    lastDurableEventId: 3,
    projectionEpoch: 'epoch-1',
    subscriptionId: 'subscription-1',
    generatedAt: 30,
    scope: SCOPE,
    tasks: [{
      taskId: 'task-1',
      semanticKey: 'semantic-1',
      title: 'Build console',
      status: 'implementing',
      phase: 'active',
      validationState: 'pending',
      updatedAt: 30,
      lastEventId: 3,
    }],
    assignments: [{
      assignmentId: 'assignment-1',
      taskId: 'task-1',
      status: 'implementing', phase: 'active', validationState: 'pending',
      updatedAt: 30,
      lastEventId: 3,
    }],
    pools: [{ poolId: 'primary', label: 'Primary', activeCount: 1, capacity: 2 }],
    ...overrides,
  };
}

function readyState() {
  return supervisionTaskConsoleReducer(subscribingState(),
    { type: 'snapshot_received', payload: snapshot() },
  );
}

function subscribingState() {
  return supervisionTaskConsoleReducer(
    createSupervisionTaskConsoleState(SCOPE),
    { type: 'subscribe_started', subscriptionId: 'subscription-1' },
  );
}

function delta(overrides: Partial<SupervisionTaskConsoleDelta> = {}): SupervisionTaskConsoleDelta {
  return {
    type: SUPERVISION_TASK_CONSOLE_MSG.DELTA,
    schemaVersion: SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
    statusContractVersion: SUPERVISION_TASK_STATUS_CONTRACT_VERSION,
    projectionVersion: 4,
    lastDurableEventId: 4,
    projectionEpoch: 'epoch-1',
    subscriptionId: 'subscription-1',
    eventId: 4,
    scope: SCOPE,
    op: 'task_upsert',
    task: {
      taskId: 'task-1',
      semanticKey: 'semantic-1',
      title: 'Build console',
      status: 'validated',
      phase: 'active',
      validationState: 'passed',
      updatedAt: 40,
      lastEventId: 4,
    },
    ...overrides,
  };
}

describe('supervision task console reducer', () => {
  it('accepts an authoritative empty snapshot as a completed initial load', () => {
    const empty = supervisionTaskConsoleReducer(subscribingState(), {
      type: 'snapshot_received',
      payload: snapshot({
        projectionVersion: 0,
        lastDurableEventId: null,
        tasks: [],
        assignments: [],
        pools: [],
      }),
    });
    expect(empty.phase).toBe(SUPERVISION_TASK_CONSOLE_PHASE.READY);
    expect(empty.tasks).toEqual({});
  });

  it('turns a transport disconnect into a terminal visible error state', () => {
    const disconnected = supervisionTaskConsoleReducer(subscribingState(), {
      type: 'transport_disconnected',
    });
    expect(disconnected).toMatchObject({
      phase: SUPERVISION_TASK_CONSOLE_PHASE.ERROR,
      error: 'transport_disconnected',
    });
  });

  it('hydrates an authoritative snapshot and replaces it after daemon restart', () => {
    const first = readyState();
    const restarted = supervisionTaskConsoleReducer(first, {
      type: 'snapshot_received',
      payload: snapshot({
        projectionVersion: 9,
        lastDurableEventId: 9,
        tasks: [{
          taskId: 'task-recovered',
          title: 'Recovered task',
          status: 'recovered',
          phase: 'active',
          validationState: 'passed',
          updatedAt: 90,
          lastEventId: 9,
        }],
        assignments: [],
      }),
    });
    expect(restarted.phase).toBe(SUPERVISION_TASK_CONSOLE_PHASE.READY);
    expect(restarted.projectionVersion).toBe(9);
    expect(Object.keys(restarted.tasks)).toEqual(['task-recovered']);
  });

  it('applies only the next monotonic delta and ignores duplicate delivery', () => {
    const applied = supervisionTaskConsoleReducer(readyState(), { type: 'delta_received', payload: delta() });
    expect(applied.projectionVersion).toBe(4);
    expect(applied.tasks['task-1']?.status).toBe('validated');
    expect(applied.eventsByTask['task-1']).toEqual([{ eventId: 4, projectionVersion: 4, op: 'task_upsert' }]);
    expect(supervisionTaskConsoleReducer(applied, { type: 'delta_received', payload: delta() })).toBe(applied);
  });

  it('requests a full resync for a version gap or out-of-order future update', () => {
    const gapped = supervisionTaskConsoleReducer(readyState(), {
      type: 'delta_received',
      payload: delta({ projectionVersion: 5, lastDurableEventId: 5, eventId: 5 }),
    });
    expect(gapped.phase).toBe(SUPERVISION_TASK_CONSOLE_PHASE.RESYNCING);
    expect(gapped.resyncReason).toBe('version_gap');
  });

  it('rejects the wrong project or coordinator scope without changing rows', () => {
    const current = readyState();
    const wrongScope = supervisionTaskConsoleReducer(current, {
      type: 'delta_received',
      payload: delta({ scope: { ...SCOPE, coordinatorSessionName: 'deck_other_brain' } }),
    });
    expect(wrongScope.resyncReason).toBe('scope_mismatch');
    expect(wrongScope.tasks).toEqual(current.tasks);
  });

  it('drops a delayed projection from a replaced subscription', () => {
    const current = supervisionTaskConsoleReducer(readyState(), {
      type: 'subscribe_started',
      subscriptionId: 'subscription-2',
    });
    const delayed = supervisionTaskConsoleReducer(current, {
      type: 'snapshot_received',
      payload: snapshot({ subscriptionId: 'subscription-1' }),
    });
    expect(delayed).toBe(current);
    expect(delayed.subscriptionId).toBe('subscription-2');
  });

  it('accepts every fixed lifecycle status', () => {
    for (const status of SUPERVISION_TASK_LIFECYCLE_STATUSES) {
      const next = supervisionTaskConsoleReducer(subscribingState(), {
        type: 'snapshot_received',
        payload: snapshot({
          tasks: [{ taskId: status, title: status, status, phase: supervisionConsoleStatusGroup(status), validationState: 'unknown', updatedAt: 1, lastEventId: 3 }],
          assignments: [],
        }),
      });
      expect(next.phase, status).toBe(SUPERVISION_TASK_CONSOLE_PHASE.READY);
    }
  });

  it('fails closed on an unknown future status and requests resync', () => {
    const payload = snapshot() as unknown as Record<string, unknown>;
    payload.tasks = [{
      taskId: 'task-unknown',
      title: 'Unknown',
      status: 'future_status',
      phase: 'active',
      validationState: 'unknown',
      updatedAt: 1,
      lastEventId: 3,
    }];
    payload.assignments = [];
    const next = supervisionTaskConsoleReducer(subscribingState(), {
      type: 'snapshot_received',
      payload,
    });
    expect(next.phase).toBe(SUPERVISION_TASK_CONSOLE_PHASE.RESYNCING);
    expect(next.resyncReason).toBe('status_contract_mismatch');
  });

  it('drops malformed delayed frames before validating a replaced subscription', () => {
    const current = supervisionTaskConsoleReducer(readyState(), {
      type: 'subscribe_started',
      subscriptionId: 'subscription-2',
    });
    const delayed = supervisionTaskConsoleReducer(current, {
      type: 'delta_received',
      payload: {
        type: SUPERVISION_TASK_CONSOLE_MSG.DELTA,
        subscriptionId: 'subscription-1',
        status: 'future_status',
      },
    });
    expect(delayed).toBe(current);
  });

  it('keeps multiple assignments for one task and two execution pools', () => {
    const next = supervisionTaskConsoleReducer(subscribingState(), {
      type: 'snapshot_received',
      payload: snapshot({
        assignments: [
          { assignmentId: 'a-primary', taskId: 'task-1', status: 'implementing', phase: 'active', validationState: 'pending', poolId: 'primary', updatedAt: 2, lastEventId: 3 },
          { assignmentId: 'a-economy', taskId: 'task-1', status: 'auditing', phase: 'audit', validationState: 'passed', poolId: 'economy', updatedAt: 3, lastEventId: 3 },
        ],
        pools: [
          { poolId: 'primary', label: 'Primary', activeCount: 1, capacity: 2 },
          { poolId: 'economy', label: 'Economy', activeCount: 1, capacity: 4 },
        ],
      }),
    });
    expect(Object.keys(next.assignments)).toEqual(['a-primary', 'a-economy']);
    expect(next.pools.map((pool) => pool.poolId)).toEqual(['primary', 'economy']);
  });

  it('rejects orphan assignments, duplicate ids, and mismatched durable ids', () => {
    const orphan = supervisionTaskConsoleReducer(subscribingState(), {
      type: 'snapshot_received',
      payload: snapshot({ assignments: [{ assignmentId: 'orphan', taskId: 'missing', status: 'implementing', phase: 'active', validationState: 'pending', updatedAt: 1, lastEventId: 3 }] }),
    });
    expect(orphan.resyncReason).toBe('cursor_unknown');

    const duplicate = supervisionTaskConsoleReducer(subscribingState(), {
      type: 'snapshot_received',
      payload: snapshot({ tasks: [snapshot().tasks[0], snapshot().tasks[0]] }),
    });
    expect(duplicate.resyncReason).toBe('cursor_unknown');

    const mismatched = supervisionTaskConsoleReducer(readyState(), {
      type: 'delta_received',
      payload: delta({ eventId: 99 }),
    });
    expect(mismatched.resyncReason).toBe('cursor_unknown');
  });
});
