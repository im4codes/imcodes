import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBrainImcodesDelegationEvidence } from '../../src/daemon/brain-delegation-evidence.js';
import { SUPERVISION_BLOCKER_ESCALATION_DISPOSITIONS } from '../../shared/agent-delegation.js';
import {
  getSupervisionTaskRegistry,
  resetSupervisionTaskRegistryForTests,
} from '../../src/daemon/supervision-state-store.js';
import {
  getDelegationReplyStore,
  resetDelegationReplyStoreForTests,
} from '../../src/daemon/delegation-reply-store.js';

const BRAIN = 'deck_evidence_brain';
const WORKER = 'deck_sub_evidence_worker';
const OTHER_BRAIN = 'deck_other_brain';

const identity = (sessionName: string) => ({
  sessionName,
  sessionInstanceId: `instance_${sessionName}`,
  runtimeEpoch: `epoch_${sessionName}`,
  agentType: 'codex-sdk',
  providerFamily: 'openai',
});
const bound = (sessionName: string) => ({
  sessionName,
  sessionInstanceId: `instance_${sessionName}`,
  runtimeEpoch: `epoch_${sessionName}`,
});

interface TaskSeed {
  taskId: string;
  coordinator: string;
  coordinatorStatus?: 'cancelled';
  taskStatus?: 'cancelled';
  participant?: { sessionName: string; role?: 'implementer' | 'auditor'; status?: string; assignmentId?: string };
}

function seedTask(input: TaskSeed) {
  const registry = getSupervisionTaskRegistry();
  expect(registry.createOrGet({
    taskId: input.taskId,
    projectName: 'evidence',
    classification: 'independent_top_level',
    objective: 'evidence task',
    currentRevision: `${input.taskId}-r1`,
  })).toMatchObject({ ok: true });
  const coordinatorAssignmentId = `${input.taskId}-coordinator`;
  expect(registry.createAssignment({
    assignmentId: coordinatorAssignmentId,
    taskId: input.taskId, role: 'coordinator', required: false, identity: identity(input.coordinator),
  })).toMatchObject({ ok: true });
  if (input.participant) {
    const assignmentId = input.participant.assignmentId ?? `${input.taskId}-participant`;
    expect(registry.createAssignment({
      assignmentId,
      taskId: input.taskId,
      role: input.participant.role ?? 'implementer',
      identity: identity(input.participant.sessionName),
    })).toMatchObject({ ok: true });
    if (input.participant.status) {
      expect(registry.updateTask({ taskId: input.taskId, status: 'implementing' })).toMatchObject({ ok: true });
      expect(registry.updateAssignment({
        assignmentId,
        identity: registry.getAssignment(assignmentId)!.identity,
        status: input.participant.status as never,
      })).toMatchObject({ ok: true });
    }
  }
  if (input.coordinatorStatus) {
    expect(registry.updateAssignment({
      assignmentId: coordinatorAssignmentId,
      identity: registry.getAssignment(coordinatorAssignmentId)!.identity,
      status: input.coordinatorStatus,
    })).toMatchObject({ ok: true });
  }
  if (input.taskStatus) {
    expect(registry.updateTask({ taskId: input.taskId, status: input.taskStatus })).toMatchObject({ ok: true });
  }
}

describe('Brain IM.codes delegation evidence', () => {
  beforeEach(() => {
    resetSupervisionTaskRegistryForTests();
    resetDelegationReplyStoreForTests();
  });
  afterEach(() => {
    resetSupervisionTaskRegistryForTests();
    resetDelegationReplyStoreForTests();
  });

  it('has no evidence when only provider-native agents were used (nothing authoritative exists)', () => {
    expect(readBrainImcodesDelegationEvidence(BRAIN)).toEqual({
      hasAuthoritativeDelegation: false,
      participants: [],
      pendingReplies: [],
      heldParticipants: [],
    });
  });

  it('accepts a non-self, non-terminal participant on a task the Brain coordinates', () => {
    seedTask({ taskId: 'tsk_evidence_ok', coordinator: BRAIN, participant: { sessionName: WORKER, status: 'implementing' } });
    const evidence = readBrainImcodesDelegationEvidence(BRAIN);
    expect(evidence.hasAuthoritativeDelegation).toBe(true);
    expect(evidence.participants).toEqual([{
      taskId: 'tsk_evidence_ok',
      assignmentId: 'tsk_evidence_ok-participant',
      role: 'implementer',
      status: 'implementing',
      sessionName: WORKER,
    }]);
  });

  it.each<[string, TaskSeed]>([
    ['a self-bound implementer (main-window work)', { taskId: 'tsk_self', coordinator: BRAIN, participant: { sessionName: BRAIN, status: 'implementing' } }],
    ['a blocked participant', { taskId: 'tsk_blocked', coordinator: BRAIN, participant: { sessionName: WORKER, status: 'blocked' } }],
    ['a task coordinated by another Brain', { taskId: 'tsk_foreign', coordinator: OTHER_BRAIN, participant: { sessionName: BRAIN, status: 'implementing' } }],
    ['a coordinator-only task', { taskId: 'tsk_empty', coordinator: BRAIN }],
  ])('rejects %s', (_label, seed) => {
    seedTask(seed);
    expect(readBrainImcodesDelegationEvidence(BRAIN).hasAuthoritativeDelegation).toBe(false);
  });

  // Each fixture below isolates exactly one liveness rule: the premise
  // assertion proves every OTHER rule would still accept the row, so the
  // rejection can only come from the rule named in the label.
  it('never counts a participant row that lacks its authoritative ids', () => {
    // The registry parses persisted assignment payloads without re-validating
    // them, so a damaged row must not become WAITING evidence.
    seedTask({ taskId: 'tsk_damaged', coordinator: BRAIN, participant: { sessionName: WORKER, status: 'implementing' } });
    const registry = getSupervisionTaskRegistry();
    const [snapshot] = registry.list({ ownerSessionName: BRAIN });
    const damaged = {
      ...snapshot!,
      assignments: snapshot!.assignments.map((assignment) => (
        assignment.role === 'implementer' ? { ...assignment, assignmentId: '' } : assignment
      )),
    };
    const list = vi.spyOn(registry, 'list').mockReturnValue([damaged]);
    try {
      expect(readBrainImcodesDelegationEvidence(BRAIN).hasAuthoritativeDelegation).toBe(false);
    } finally {
      list.mockRestore();
    }
    expect(readBrainImcodesDelegationEvidence(BRAIN).hasAuthoritativeDelegation).toBe(true);
  });

  it('does not wait on a participant held on a blocker only the Brain can resolve', () => {
    seedTask({ taskId: 'tsk_held', coordinator: BRAIN, participant: { sessionName: WORKER } });
    const registry = getSupervisionTaskRegistry();
    expect(readBrainImcodesDelegationEvidence(BRAIN).hasAuthoritativeDelegation).toBe(true);
    // The worker's automatic start was refused: the report waits for the Brain.
    expect(registry.recordAssignmentStartRefusalBlocker({
      assignmentId: 'tsk_held-participant',
      blocker: JSON.stringify({ disposition: SUPERVISION_BLOCKER_ESCALATION_DISPOSITIONS.WAITING_FOR_BRAIN, blockerFingerprint: 'fp-held' }),
      blockerFingerprint: 'fp-held',
    })).toMatchObject({ ok: true });
    const evidence = readBrainImcodesDelegationEvidence(BRAIN);
    expect(evidence.hasAuthoritativeDelegation).toBe(false);
    expect(evidence.heldParticipants).toEqual([{
      taskId: 'tsk_held', assignmentId: 'tsk_held-participant', role: 'implementer', status: 'delegated', sessionName: WORKER,
    }]);
  });

  it('still waits on a participant blocked on external input', () => {
    seedTask({ taskId: 'tsk_external', coordinator: BRAIN, participant: { sessionName: WORKER } });
    expect(getSupervisionTaskRegistry().recordAssignmentStartRefusalBlocker({
      assignmentId: 'tsk_external-participant',
      blocker: JSON.stringify({ disposition: SUPERVISION_BLOCKER_ESCALATION_DISPOSITIONS.NEEDS_INPUT, blockerFingerprint: 'fp-input' }),
      blockerFingerprint: 'fp-input',
    })).toMatchObject({ ok: true });
    expect(readBrainImcodesDelegationEvidence(BRAIN).hasAuthoritativeDelegation).toBe(true);
  });

  it('rejects a cancelled participant on a task that is still active', () => {
    seedTask({ taskId: 'tsk_cancelled_participant', coordinator: BRAIN, participant: { sessionName: WORKER, status: 'cancelled' } });
    expect(getSupervisionTaskRegistry().get('tsk_cancelled_participant')!.status).toBe('implementing');
    expect(readBrainImcodesDelegationEvidence(BRAIN).hasAuthoritativeDelegation).toBe(false);
  });

  it('rejects a live participant on a cancelled task', () => {
    seedTask({ taskId: 'tsk_cancelled_task', coordinator: BRAIN, participant: { sessionName: WORKER }, taskStatus: 'cancelled' });
    const task = getSupervisionTaskRegistry().get('tsk_cancelled_task')!;
    expect(task.status).toBe('cancelled');
    expect(task.assignments.find((assignment) => assignment.role === 'implementer')!.status).toBe('delegated');
    expect(readBrainImcodesDelegationEvidence(BRAIN).hasAuthoritativeDelegation).toBe(false);
  });

  it('rejects a live participant once the Brain no longer coordinates the task', () => {
    seedTask({ taskId: 'tsk_released', coordinator: BRAIN, participant: { sessionName: WORKER }, coordinatorStatus: 'cancelled' });
    const task = getSupervisionTaskRegistry().get('tsk_released')!;
    expect(task.status).not.toBe('cancelled');
    expect(task.assignments.find((assignment) => assignment.role === 'implementer')!.status).toBe('delegated');
    expect(readBrainImcodesDelegationEvidence(BRAIN).hasAuthoritativeDelegation).toBe(false);
  });

  it('accepts a durable reply still owed to the Brain and rejects closed or self-addressed replies', () => {
    const store = getDelegationReplyStore();
    const now = Date.now();
    const pending = store.create({ origin: bound(BRAIN), target: bound(WORKER), dispatchId: 'd-pending', messageId: 'm-pending', now });
    let evidence = readBrainImcodesDelegationEvidence(BRAIN, now);
    expect(evidence.hasAuthoritativeDelegation).toBe(true);
    expect(evidence.pendingReplies).toEqual([{ delegationId: pending.record.delegationId, targetSessionName: WORKER }]);

    // Received but not yet delivered: the result is still on its way to the Brain.
    expect(store.receive({ delegationId: pending.record.delegationId, result: 'done', sender: bound(WORKER), now: now + 1 }))
      .toMatchObject({ ok: true });
    expect(readBrainImcodesDelegationEvidence(BRAIN, now + 2).hasAuthoritativeDelegation).toBe(true);

    // Delivered: closed.
    const received = store.get(pending.record.delegationId)!;
    expect(store.markDelivered(received.delegationId, received.notificationId, now + 2)).toBe(true);
    expect(readBrainImcodesDelegationEvidence(BRAIN, now + 3).hasAuthoritativeDelegation).toBe(false);

    // A non-task reply past its deadline is closed even before the expiry sweep.
    const stale = store.create({ origin: bound(BRAIN), target: bound(WORKER), dispatchId: 'd-stale', messageId: 'm-stale', now });
    expect(readBrainImcodesDelegationEvidence(BRAIN, stale.record.expiresAt + 1).hasAuthoritativeDelegation).toBe(false);
    // Expired by the sweep: closed at any time.
    store.expire(stale.record.delegationId, now + 4);
    expect(readBrainImcodesDelegationEvidence(BRAIN, now + 5).hasAuthoritativeDelegation).toBe(false);

    // A reply the Brain addressed to itself is not delegation.
    store.create({ origin: bound(BRAIN), target: bound(BRAIN), dispatchId: 'd-self', messageId: 'm-self', now });
    expect(readBrainImcodesDelegationEvidence(BRAIN, now + 6).hasAuthoritativeDelegation).toBe(false);

    // Another Brain's pending reply is not this Brain's evidence.
    resetDelegationReplyStoreForTests();
    getDelegationReplyStore().create({ origin: bound(OTHER_BRAIN), target: bound(WORKER), dispatchId: 'd-other', messageId: 'm-other', now });
    expect(readBrainImcodesDelegationEvidence(BRAIN, now).hasAuthoritativeDelegation).toBe(false);
  });

  it('keeps a task-bound reply owed past any deadline only while its task and assignment are live', () => {
    // The reply is bound to a task coordinated by ANOTHER Brain so that the
    // participant path cannot supply the evidence: only the reply can.
    seedTask({
      taskId: 'tsk_reply', coordinator: OTHER_BRAIN,
      participant: { sessionName: WORKER, assignmentId: 'asg_reply', status: 'implementing' },
    });
    const now = Date.now();
    const taskBound = getDelegationReplyStore().create({
      origin: bound(BRAIN), target: bound(WORKER), dispatchId: 'd-task', messageId: 'm-task',
      taskId: 'tsk_reply', assignmentId: 'asg_reply', now,
    });
    const afterDeadline = taskBound.record.expiresAt + 1;
    const evidence = readBrainImcodesDelegationEvidence(BRAIN, afterDeadline);
    expect(evidence.participants).toEqual([]);
    expect(evidence.pendingReplies).toEqual([{
      delegationId: taskBound.record.delegationId,
      targetSessionName: WORKER,
      taskId: 'tsk_reply',
      assignmentId: 'asg_reply',
    }]);

    // The bound assignment ends while the task stays active: nothing is owed.
    const registry = getSupervisionTaskRegistry();
    expect(registry.updateAssignment({
      assignmentId: 'asg_reply', identity: registry.getAssignment('asg_reply')!.identity, status: 'cancelled',
    })).toMatchObject({ ok: true });
    expect(registry.get('tsk_reply')!.status).toBe('implementing');
    expect(readBrainImcodesDelegationEvidence(BRAIN, afterDeadline).hasAuthoritativeDelegation).toBe(false);
  });

  it.each<[string, TaskSeed | undefined]>([
    ['its task was cancelled', {
      taskId: 'tsk_reply', coordinator: OTHER_BRAIN, participant: { sessionName: WORKER, assignmentId: 'asg_reply' }, taskStatus: 'cancelled',
    }],
    ['its task no longer exists', undefined],
    ['its assignment is not on the task', {
      taskId: 'tsk_reply', coordinator: OTHER_BRAIN, participant: { sessionName: WORKER, assignmentId: 'asg_unrelated', status: 'implementing' },
    }],
    ['its assignment is bound to the Brain itself', {
      taskId: 'tsk_reply', coordinator: OTHER_BRAIN, participant: { sessionName: BRAIN, assignmentId: 'asg_reply', status: 'implementing' },
    }],
  ])('does not count a task-bound reply when %s', (_label, seed) => {
    if (seed) seedTask(seed);
    const now = Date.now();
    getDelegationReplyStore().create({
      origin: bound(BRAIN), target: bound(WORKER), dispatchId: 'd-task', messageId: 'm-task',
      taskId: 'tsk_reply', assignmentId: 'asg_reply', now,
    });
    expect(readBrainImcodesDelegationEvidence(BRAIN, now)).toEqual({
      hasAuthoritativeDelegation: false,
      participants: [],
      pendingReplies: [],
      heldParticipants: [],
    });
  });
});
