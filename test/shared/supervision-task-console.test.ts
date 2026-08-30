import { describe, expect, it } from 'vitest';
import {
  SUPERVISION_TASK_CONSOLE_MSG,
  SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
  SUPERVISION_CONSOLE_STATUS_GROUP,
  SUPERVISION_CONSOLE_STATUS_GROUPS,
  SUPERVISION_CONSOLE_HISTORY_STATUSES,
  SUPERVISION_CONSOLE_RESYNC_REASONS,
  SUPERVISION_CONSOLE_TRANSITION_FIELDS,
  canCoalesceSupervisionTaskRows,
  evaluateSupervisionConsoleCursor,
  initialSupervisionConsoleCursor,
  isStaleSupervisionConsoleResponse,
  isSupervisionConsoleHistoryStatus,
  isSupervisionConsoleAudienceMember,
  isValidSupervisionTaskConsoleEvent,
  supervisionConsoleStatusGroup,
  supervisionConsoleTabForStatus,
  type SupervisionTaskConsoleCursorState,
  type SupervisionTaskConsoleTaskRow,
} from '../../shared/supervision-task-console.js';
import {
  SUPERVISION_TASK_LIFECYCLE_STATUSES,
  SUPERVISION_TASK_REGISTRY_EVENT_TYPES,
  SUPERVISION_TASK_STATUS_CONTRACT_VERSION,
  isTerminalSupervisionTaskStatus,
} from '../../shared/supervision-config.js';

const SCOPE = { projectName: 'codedeck', coordinatorSessionName: 'deck_cd_brain' };
const EPOCH = 'epoch-1';

function cursor(over: Partial<SupervisionTaskConsoleCursorState> = {}): SupervisionTaskConsoleCursorState {
  return { ...initialSupervisionConsoleCursor(SCOPE, EPOCH), projectionVersion: 5, ...over };
}

function taskRow(over: Partial<SupervisionTaskConsoleTaskRow> = {}): SupervisionTaskConsoleTaskRow {
  return {
    taskId: 'tsk_media-binder-rebind_01J',
    title: 'Rebind media binder',
    status: 'implementing',
    phase: 'active',
    validationState: 'pending',
    updatedAt: 1000,
    lastEventId: 42,
    ...over,
  };
}

describe('supervision task console status grouping', () => {
  it('maps every lifecycle status exactly once and admits no event names', () => {
    const mapped = Object.keys(SUPERVISION_CONSOLE_STATUS_GROUP);
    expect(mapped.sort()).toEqual([...SUPERVISION_TASK_LIFECYCLE_STATUSES].sort());
    expect(mapped).toHaveLength(SUPERVISION_TASK_LIFECYCLE_STATUSES.length);
    for (const status of SUPERVISION_TASK_LIFECYCLE_STATUSES) {
      expect(SUPERVISION_CONSOLE_STATUS_GROUPS).toContain(supervisionConsoleStatusGroup(status));
    }
    // Event types must never appear as a console group key.
    for (const eventOnly of SUPERVISION_TASK_REGISTRY_EVENT_TYPES) {
      if ((SUPERVISION_TASK_LIFECYCLE_STATUSES as readonly string[]).includes(eventOnly)) continue;
      expect(mapped).not.toContain(eventOnly);
    }
  });

  it('partitions every task status into active or history with canonical terminal precedence', () => {
    expect(SUPERVISION_CONSOLE_HISTORY_STATUSES).toEqual([
      'committed', 'pushed', 'recovered', 'finalized', 'blocked', 'cancelled',
    ]);
    for (const status of SUPERVISION_TASK_LIFECYCLE_STATUSES) {
      const history = (SUPERVISION_CONSOLE_HISTORY_STATUSES as readonly string[]).includes(status);
      expect(supervisionConsoleTabForStatus(status), status).toBe(
        history ? 'history' : 'active',
      );
      expect(isSupervisionConsoleHistoryStatus(status), status).toBe(history);
      if (isTerminalSupervisionTaskStatus(status)) {
        expect(supervisionConsoleTabForStatus(status), status).toBe('history');
      }
    }
    expect(supervisionConsoleTabForStatus('implementing')).toBe('active');
    expect(supervisionConsoleTabForStatus('auditing')).toBe('active');
    expect(supervisionConsoleTabForStatus('ready_for_integration')).toBe('active');
  });
});

describe('supervision console cursor ordering', () => {
  it('applies only the exact next version', () => {
    expect(evaluateSupervisionConsoleCursor({
      client: cursor(), incoming: cursor({ projectionVersion: 6 }),
    })).toEqual({ decision: 'apply', reason: 'in_order' });
  });

  it('drops already-applied replays so at-least-once outbox delivery is idempotent', () => {
    for (const version of [5, 4, 1]) {
      expect(evaluateSupervisionConsoleCursor({
        client: cursor(), incoming: cursor({ projectionVersion: version }),
      }).decision, `v${version}`).toBe('ignore_duplicate');
    }
  });

  it('forces a full resync on a gap rather than patching across it', () => {
    expect(evaluateSupervisionConsoleCursor({
      client: cursor(), incoming: cursor({ projectionVersion: 8 }),
    })).toEqual({ decision: 'resync_required', reason: 'version_gap' });
  });

  it('resyncs on schema, status-contract and scope mismatch', () => {
    const cases: Array<[Partial<SupervisionTaskConsoleCursorState>, string]> = [
      [{ schemaVersion: 99 }, 'schema_mismatch'],
      [{ statusContractVersion: 99 }, 'status_contract_mismatch'],
      [{ scope: { ...SCOPE, coordinatorSessionName: 'deck_cd_w1' } }, 'scope_mismatch'],
    ];
    for (const [over, reason] of cases) {
      expect(evaluateSupervisionConsoleCursor({
        client: cursor(), incoming: cursor({ projectionVersion: 6, ...over }),
      }), reason).toEqual({ decision: 'resync_required', reason });
    }
  });

  it('treats an epoch change as incomparable BEFORE comparing versions', () => {
    // Load-bearing: a rebuilt projection store replays low versions. If the
    // epoch were checked after the `<=` duplicate test, this would be silently
    // swallowed as "already applied" and the console would freeze forever.
    const result = evaluateSupervisionConsoleCursor({
      client: cursor({ projectionVersion: 500 }),
      incoming: cursor({ projectionVersion: 1, projectionEpoch: 'epoch-2' }),
    });
    expect(result).toEqual({ decision: 'resync_required', reason: 'authority_epoch_changed' });
  });

  it('exposes every resync reason it can return', () => {
    for (const reason of ['version_gap', 'schema_mismatch', 'status_contract_mismatch',
      'scope_mismatch', 'authority_epoch_changed'] as const) {
      expect(SUPERVISION_CONSOLE_RESYNC_REASONS).toContain(reason);
    }
  });
});

describe('supervision console stale-response guard', () => {
  it('rejects a projection answering a superseded subscribe', () => {
    expect(isStaleSupervisionConsoleResponse({ activeSubscriptionId: 'sub-2', responseSubscriptionId: 'sub-1' })).toBe(true);
    expect(isStaleSupervisionConsoleResponse({ activeSubscriptionId: 'sub-2', responseSubscriptionId: 'sub-2' })).toBe(false);
  });
});

describe('supervision console wire validation', () => {
  const base = {
    type: SUPERVISION_TASK_CONSOLE_MSG.DELTA,
    scope: SCOPE,
    subscriptionId: 'sub-1',
    schemaVersion: SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
    statusContractVersion: SUPERVISION_TASK_STATUS_CONTRACT_VERSION,
    projectionVersion: 6,
    lastDurableEventId: 42,
    projectionEpoch: EPOCH,
    eventId: 42,
    op: 'task_upsert',
  };

  it('accepts a well-formed delta', () => {
    expect(isValidSupervisionTaskConsoleEvent({ ...base, task: taskRow() })).toBe(true);
  });

  it('rejects model-authored / unknown / case-variant status', () => {
    for (const status of ['file_event', 'scope_violation', 'Implementing', ' implementing', 'in_progress', 'done']) {
      expect(isValidSupervisionTaskConsoleEvent({ ...base, task: taskRow({ status: status as never }) }), status).toBe(false);
    }
  });

  it('rejects an arbitrary verdict, pool kind and validation state', () => {
    expect(isValidSupervisionTaskConsoleEvent({ ...base, task: taskRow({ auditVerdict: 'LGTM' as never }) })).toBe(false);
    expect(isValidSupervisionTaskConsoleEvent({ ...base, task: taskRow({ poolKind: 'turbo' as never }) })).toBe(false);
    expect(isValidSupervisionTaskConsoleEvent({ ...base, task: taskRow({ validationState: 'maybe' as never }) })).toBe(false);
  });

  it('rejects a phase that disagrees with the derived status group', () => {
    // Reported by Cx3: phase is derived, so a frame may not contradict it.
    expect(isValidSupervisionTaskConsoleEvent({
      ...base, task: taskRow({ status: 'auditing', phase: 'final' }),
    })).toBe(false);
    // ...and the honest pairing still passes.
    expect(isValidSupervisionTaskConsoleEvent({
      ...base, task: taskRow({ status: 'auditing', phase: 'audit' }),
    })).toBe(true);
    for (const status of SUPERVISION_TASK_LIFECYCLE_STATUSES) {
      expect(isValidSupervisionTaskConsoleEvent({
        ...base, task: taskRow({ status, phase: supervisionConsoleStatusGroup(status) }),
      }), status).toBe(true);
      expect(isValidSupervisionTaskConsoleEvent({
        ...base, task: taskRow({ status, phase: 'nonsense' as never }),
      }), status).toBe(false);
    }
  });

  it('rejects a missing or non-member phase on both row kinds', () => {
    const { phase, ...noPhase } = taskRow();
    expect(isValidSupervisionTaskConsoleEvent({ ...base, task: noPhase })).toBe(false);
    expect(isValidSupervisionTaskConsoleEvent({
      ...base, op: 'assignment_upsert',
      assignment: { assignmentId: 'asg-1', taskId: 'tsk-1', status: 'auditing',
        phase: 'final', validationState: 'pending', updatedAt: 1, lastEventId: 2 },
    })).toBe(false);
    expect(isValidSupervisionTaskConsoleEvent({
      ...base, op: 'assignment_upsert',
      assignment: { assignmentId: 'asg-1', taskId: 'tsk-1', status: 'auditing',
        phase: 'audit', validationState: 'pending', sessionState: 'running',
        sessionStateSource: 'runtime', sessionStateObservedAt: 1, updatedAt: 1, lastEventId: 2 },
    })).toBe(true);
    expect(isValidSupervisionTaskConsoleEvent({
      ...base, op: 'assignment_upsert',
      assignment: { assignmentId: 'asg-1', taskId: 'tsk-1', status: 'auditing',
        phase: 'audit', validationState: 'pending', sessionState: 'stale',
        sessionStateSource: 'model', sessionStateObservedAt: Number.NaN, updatedAt: 1, lastEventId: 2 },
    })).toBe(false);
  });

  it('rejects a frame missing subscription identity or authority epoch', () => {
    const { subscriptionId, ...noSub } = base;
    expect(isValidSupervisionTaskConsoleEvent({ ...noSub, task: taskRow() })).toBe(false);
    const { projectionEpoch, ...noEpoch } = base;
    expect(isValidSupervisionTaskConsoleEvent({ ...noEpoch, task: taskRow() })).toBe(false);
  });

  it('rejects control frames as projections', () => {
    for (const type of [SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE, SUPERVISION_TASK_CONSOLE_MSG.ACK,
      SUPERVISION_TASK_CONSOLE_MSG.UNSUBSCRIBE, SUPERVISION_TASK_CONSOLE_MSG.RESYNC_REQUIRED]) {
      expect(isValidSupervisionTaskConsoleEvent({ ...base, type }), type).toBe(false);
    }
  });

  it('rejects a delta whose op does not match its payload', () => {
    expect(isValidSupervisionTaskConsoleEvent({ ...base, op: 'task_remove', task: taskRow() })).toBe(false);
    expect(isValidSupervisionTaskConsoleEvent({ ...base, op: 'pools_update', task: taskRow() })).toBe(false);
    expect(isValidSupervisionTaskConsoleEvent({ ...base, op: 'nonsense', task: taskRow() })).toBe(false);
  });
});

describe('supervision console coalescing', () => {
  it('collapses presentation-neutral updates', () => {
    expect(canCoalesceSupervisionTaskRows(
      taskRow({ progress: { completed: 1, total: 4 } }),
      taskRow({ progress: { completed: 2, total: 4 }, updatedAt: 2000, lastEventId: 43 }),
    )).toBe(true);
  });

  it('never drops a lifecycle, audit, validation or blocker transition', () => {
    const transitions: Array<Partial<SupervisionTaskConsoleTaskRow>> = [
      { status: 'ready_for_audit' }, { phase: 'audit' }, { auditVerdict: 'REWORK' },
      { auditAttemptId: 'aud-1' }, { auditRound: 'r2' }, { validationState: 'failed' },
      { blocker: 'toolchain missing' }, { recoveryState: 're_audit_required' },
      { snapshotState: 'frozen' }, { checkpointId: 'chk-1' },
    ];
    for (const over of transitions) {
      expect(canCoalesceSupervisionTaskRows(taskRow(), taskRow(over)), JSON.stringify(over)).toBe(false);
    }
  });

  it('refuses to coalesce an unrecognized field change (conservative default)', () => {
    expect(canCoalesceSupervisionTaskRows(
      taskRow(), taskRow({ semanticKey: 'suddenly-set' }),
    )).toBe(false);
  });

  it('lists no field as both a transition and coalesceable', () => {
    const both = SUPERVISION_CONSOLE_TRANSITION_FIELDS.filter((f) => f === 'progress' || f === 'updatedAt');
    expect(both).toEqual([]);
  });

  it('does not coalesce across different tasks', () => {
    expect(canCoalesceSupervisionTaskRows(taskRow(), taskRow({ taskId: 'tsk_other_01J' }))).toBe(false);
  });
});

describe('supervision console audience scoping', () => {
  it('refuses when participation is unrecorded or empty', () => {
    expect(isSupervisionConsoleAudienceMember({ coordinatorSessionName: 'deck_cd_brain', participantSessionNames: undefined })).toBe(false);
    expect(isSupervisionConsoleAudienceMember({ coordinatorSessionName: 'deck_cd_brain', participantSessionNames: [] })).toBe(false);
    expect(isSupervisionConsoleAudienceMember({ coordinatorSessionName: '', participantSessionNames: ['deck_cd_brain'] })).toBe(false);
  });

  it('admits only a recorded participant', () => {
    expect(isSupervisionConsoleAudienceMember({ coordinatorSessionName: 'deck_cd_brain', participantSessionNames: ['deck_cd_brain', 'deck_cd_w1'] })).toBe(true);
    expect(isSupervisionConsoleAudienceMember({ coordinatorSessionName: 'deck_other_brain', participantSessionNames: ['deck_cd_brain'] })).toBe(false);
  });
});
