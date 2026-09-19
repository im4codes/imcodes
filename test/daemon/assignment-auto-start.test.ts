import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeSession, upsertSession, type SessionRecord } from '../../src/store/session-store.js';
import {
  SUPERVISION_ASSIGNMENT_AUTO_START_SOURCE,
  SUPERVISION_ASSIGNMENT_DELIVERY_PROOF,
  SUPERVISION_ASSIGNMENT_START_EVIDENCE,
  SUPERVISION_ASSIGNMENT_START_REFUSALS,
  SUPERVISION_ASSIGNMENT_STATUS_TIMELINE_EVENT,
} from '../../shared/supervision-assignment-start.js';
import {
  getSupervisionTaskRegistry,
  resetSupervisionTaskRegistryForTests,
  type PersistedSupervisionTaskAssignmentIdentity,
} from '../../src/daemon/supervision-state-store.js';
import { getDelegationReplyStore, resetDelegationReplyStoreForTests } from '../../src/daemon/delegation-reply-store.js';
import { getTransportQueueStore, resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';
import {
  clearAllResend,
  drainResend,
  enqueueResend,
  RESEND_DISPATCH_CONTROL,
} from '../../src/daemon/transport-resend-queue.js';
import { preserveTransportRuntimeQueuesToResend } from '../../src/daemon/transport-resend-preservation.js';
import { resolveQueuedSupervisionHeartbeatDelivery } from '../../src/daemon/supervision-participant-delivery.js';
import { escalateImplementationBlocker } from '../../src/daemon/send-tool.js';
import { deterministicSendMessageId } from '../../shared/send-message-id.js';
import type { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import {
  assignmentStartRefusalError,
  autoStartAssignmentFromAck,
  autoStartDelegatedAssignmentsFromActivity,
  clearAssignmentAutoStartStateForTests,
  escalateAssignmentStartRefusal,
  readAssignmentDeliveryEvidence,
  readAssignmentStartRefusalError,
  type AssignmentAutoStartDeps,
} from '../../src/daemon/assignment-auto-start.js';

const PROJECT = 'alpha';
const BRAIN = 'deck_alpha_brain';
const WORKER = 'deck_sub_alpha_worker';
const REVISION = 'rev-1';

const workerIdentity = (runtimeEpoch = 'epoch-live', sessionInstanceId = 'instance-worker'): PersistedSupervisionTaskAssignmentIdentity => ({
  sessionName: WORKER,
  sessionInstanceId,
  runtimeEpoch,
  agentType: 'codex-sdk',
  providerFamily: 'openai',
});
const brainIdentity: PersistedSupervisionTaskAssignmentIdentity = {
  sessionName: BRAIN, sessionInstanceId: 'instance-brain', runtimeEpoch: 'epoch-brain', agentType: 'codex-sdk', providerFamily: 'openai',
};

function session(name: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name, projectName: PROJECT, role: name === BRAIN ? 'brain' : 'w1', agentType: 'codex-sdk', projectDir: '/work/alpha',
    state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
    sessionInstanceId: name === BRAIN ? 'instance-brain' : 'instance-worker',
    runtimeEpoch: name === BRAIN ? 'epoch-brain' : 'epoch-live',
    ...overrides,
  } as SessionRecord;
}

interface Seeded {
  taskId: string;
  assignmentId: string;
  messageId: string;
}

/** A Brain-dispatched task exactly as send-tool leaves it before delivery. */
function seedDelegated(input: { suffix?: string; boundIdentity?: PersistedSupervisionTaskAssignmentIdentity } = {}): Seeded {
  const suffix = input.suffix ?? 'a';
  const taskId = `tsk_auto_${suffix}`;
  const assignmentId = `asg_auto_${suffix}`;
  const messageId = `msg_auto_${suffix}`;
  const registry = getSupervisionTaskRegistry();
  expect(registry.createOrGet({
    taskId, projectName: PROJECT, classification: 'independent_top_level', objective: `auto start ${suffix}`,
    currentRevision: REVISION, now: 1_000,
  })).toMatchObject({ ok: true });
  expect(registry.createAssignment({
    assignmentId: `${assignmentId}_coord`, taskId, role: 'coordinator', required: false, identity: brainIdentity, now: 1_001,
  })).toMatchObject({ ok: true });
  expect(registry.createAssignment({
    // send-tool binds a new implementer to the task's revision at dispatch.
    assignmentId, taskId, role: 'implementer', identity: input.boundIdentity ?? workerIdentity(), scopeFiles: ['src/a.ts'],
    auditRevision: REVISION, now: 1_002,
  })).toMatchObject({ ok: true });
  const bound = input.boundIdentity ?? workerIdentity();
  getDelegationReplyStore().create({
    origin: { sessionName: BRAIN, sessionInstanceId: 'instance-brain', runtimeEpoch: 'epoch-brain' },
    target: { sessionName: WORKER, sessionInstanceId: bound.sessionInstanceId, runtimeEpoch: bound.runtimeEpoch },
    dispatchId: `dispatch_${suffix}`, messageId, taskId, assignmentId, coordinatorAssignmentId: `${assignmentId}_coord`, now: 1_003,
  });
  return { taskId, assignmentId, messageId };
}

/**
 * Point the worker's live session record at one provider conversation (a Codex
 * thread), or at none. The queue store stamps delivery tombstones with it.
 */
function holdConversation(conversation: string | undefined) {
  if (conversation === undefined) {
    removeSession(WORKER);
    return;
  }
  upsertSession(session(WORKER, { agentType: 'codex-sdk', runtimeType: 'transport', codexSessionId: conversation }));
}

function deliver(
  messageId: string,
  recipient: { sessionInstanceId: string; runtimeEpoch: string } | null,
  conversation?: string,
) {
  holdConversation(conversation);
  expect(getTransportQueueStore().recordDirectDelivery(WORKER, messageId, `frame-${messageId}`, 1_500, recipient)).toBe(true);
}

function candidatesFor(seeded: Seeded) {
  const task = getSupervisionTaskRegistry().get(seeded.taskId)!;
  return [{ task, assignment: task.assignments.find((a) => a.assignmentId === seeded.assignmentId)! }];
}

function recordingDeps(): AssignmentAutoStartDeps & { escalate: ReturnType<typeof vi.fn>; stopWorker: ReturnType<typeof vi.fn> } {
  return {
    now: () => 2_000,
    escalate: vi.fn(async () => undefined),
    stopWorker: vi.fn(() => true),
  };
}

function activity(seeded: Seeded, overrides: {
  live?: PersistedSupervisionTaskAssignmentIdentity;
  active?: string[];
  eventId?: string;
  /** The provider conversation the live runtime holds now. */
  conversation?: string;
} = {}, deps: AssignmentAutoStartDeps = recordingDeps()) {
  return autoStartDelegatedAssignmentsFromActivity({
    eventId: overrides.eventId ?? 'evt-first-tool-call',
    signal: 'provider_tool_call',
    sessionName: WORKER,
    projectName: PROJECT,
    liveIdentity: overrides.live ?? workerIdentity(),
    ...(overrides.conversation ? { liveConversationKey: overrides.conversation } : {}),
    activeDispatchMessageIds: new Set(overrides.active ?? []),
    candidates: candidatesFor(seeded),
  }, deps);
}

const autoStartEvents = (taskId: string) => getSupervisionTaskRegistry().listEvents(taskId)
  .filter((event) => event.payload?.source === SUPERVISION_ASSIGNMENT_AUTO_START_SOURCE);

describe('assignment auto-start', () => {
  beforeEach(() => {
    resetSupervisionTaskRegistryForTests();
    resetDelegationReplyStoreForTests();
    resetTransportQueueStoreForTests();
    clearAssignmentAutoStartStateForTests();
    removeSession(WORKER);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetSupervisionTaskRegistryForTests();
    resetDelegationReplyStoreForTests();
    resetTransportQueueStoreForTests();
    clearAssignmentAutoStartStateForTests();
    removeSession(WORKER);
  });

  describe('delivery evidence', () => {
    it('classifies whether the task message reached the live runtime', () => {
      const seeded = seedDelegated();
      const read = (active: string[] = [], live = workerIdentity(), bound = workerIdentity('epoch-bound')) => readAssignmentDeliveryEvidence({
        taskId: seeded.taskId, assignmentId: seeded.assignmentId, sessionName: WORKER,
        assignmentIdentity: bound, liveIdentity: live, activeDispatchMessageIds: new Set(active),
      });
      // Dispatched to the worker but still queued: not delivered.
      expect(read()).toEqual({ kind: 'none' });
      // An unrelated message in the current turn is not this task.
      expect(read(['msg_other'])).toEqual({ kind: 'none' });
      expect(read([seeded.messageId])).toEqual({
        kind: 'live', proof: SUPERVISION_ASSIGNMENT_DELIVERY_PROOF.ACTIVE_DISPATCH, messageId: seeded.messageId,
      });
      deliver(seeded.messageId, { sessionInstanceId: 'instance-worker', runtimeEpoch: 'epoch-old' });
      // Delivered into a runtime that is gone, and the assignment is bound elsewhere.
      expect(read()).toEqual({ kind: 'replaced_runtime', messageId: seeded.messageId });
      // The registry already rebound the assignment onto the live runtime (a
      // continuation/heartbeat convergence dispatched bound work there).
      expect(read([], workerIdentity(), workerIdentity())).toEqual({ kind: 'delivered', messageId: seeded.messageId });
      // It names the live runtime, but its provider conversation was never
      // recorded: proof that something was delivered, not that this runtime holds it.
      expect(read([], workerIdentity('epoch-old'))).toEqual({ kind: 'delivered', messageId: seeded.messageId });
    });

    it('treats a tombstone without a recorded recipient as delivered but not live-proven', () => {
      const seeded = seedDelegated();
      deliver(seeded.messageId, null);
      expect(readAssignmentDeliveryEvidence({
        taskId: seeded.taskId, assignmentId: seeded.assignmentId, sessionName: WORKER,
        assignmentIdentity: workerIdentity('epoch-bound'), liveIdentity: workerIdentity(), activeDispatchMessageIds: new Set(),
      })).toEqual({ kind: 'delivered', messageId: seeded.messageId });
    });

    it('never attributes another assignment\'s message', () => {
      const first = seedDelegated({ suffix: 'first' });
      const second = seedDelegated({ suffix: 'second' });
      const deps = recordingDeps();
      const outcomes = autoStartDelegatedAssignmentsFromActivity({
        eventId: 'evt-second-turn', signal: 'provider_assistant_output', sessionName: WORKER, projectName: PROJECT,
        liveIdentity: workerIdentity(), activeDispatchMessageIds: new Set([second.messageId]),
        candidates: [...candidatesFor(first), ...candidatesFor(second)],
      }, deps);
      expect(outcomes.map((outcome) => [outcome.assignmentId, outcome.status])).toEqual([
        [first.assignmentId, 'not_delivered'],
        [second.assignmentId, 'started'],
      ]);
      expect(getSupervisionTaskRegistry().getAssignment(first.assignmentId)?.status).toBe('delegated');
    });
  });

  describe('provider activity', () => {
    it('starts task and assignment atomically at the first activity after live delivery, exactly once', () => {
      const seeded = seedDelegated();
      const emit = vi.spyOn(timelineEmitter, 'emit');
      const deps = recordingDeps();

      expect(activity(seeded, { active: [] }, deps)).toEqual([
        { status: 'not_delivered', taskId: seeded.taskId, assignmentId: seeded.assignmentId },
      ]);
      expect(getSupervisionTaskRegistry().getAssignment(seeded.assignmentId)?.status).toBe('delegated');

      expect(activity(seeded, { active: [seeded.messageId] }, deps)).toEqual([
        { status: 'started', taskId: seeded.taskId, assignmentId: seeded.assignmentId, identityConverged: false },
      ]);
      const registry = getSupervisionTaskRegistry();
      const assignment = registry.getAssignment(seeded.assignmentId)!;
      expect(assignment).toMatchObject({ status: 'implementing', heartbeatAt: 2_000, identity: workerIdentity() });
      expect(registry.get(seeded.taskId)?.status).toBe('implementing');
      const events = autoStartEvents(seeded.taskId);
      expect(events.map((event) => [event.assignmentId ?? null, event.eventType, event.status])).toEqual([
        [seeded.assignmentId, 'implementing', 'implementing'],
        [null, 'implementing', 'implementing'],
      ]);
      expect(events[0]!.payload).toMatchObject({
        evidence: SUPERVISION_ASSIGNMENT_START_EVIDENCE.PROVIDER_ACTIVITY,
        evidenceEventId: 'evt-first-tool-call',
        signal: 'provider_tool_call',
        deliveryMessageId: seeded.messageId,
        deliveryProof: SUPERVISION_ASSIGNMENT_DELIVERY_PROOF.ACTIVE_DISPATCH,
        revision: REVISION,
      });
      // The coordinating Brain's dispatch card learns the live status.
      const announcements = emit.mock.calls.filter((call) => call[1] === SUPERVISION_ASSIGNMENT_STATUS_TIMELINE_EVENT);
      expect(announcements).toHaveLength(1);
      expect(announcements[0]![0]).toBe(BRAIN);
      expect(announcements[0]![2]).toMatchObject({ taskId: seeded.taskId, assignmentId: seeded.assignmentId, status: 'implementing' });
      expect(announcements[0]![3]).toMatchObject({ hidden: true, eventId: `supervision-assignment-status:${seeded.assignmentId}:implementing` });

      // Duplicate activity and a restarted daemon (fresh in-memory state, same
      // durable stores) converge on the same state with no new objects/events.
      expect(activity(seeded, { active: [seeded.messageId], eventId: 'evt-second' }, deps)[0]!.status).toBe('already_started');
      clearAssignmentAutoStartStateForTests();
      expect(activity(seeded, { active: [seeded.messageId], eventId: 'evt-after-restart' }, deps)[0]!.status).toBe('already_started');
      expect(autoStartEvents(seeded.taskId)).toHaveLength(2);
      expect(registry.listAssignments(seeded.taskId)).toHaveLength(2);
      expect(deps.escalate).not.toHaveBeenCalled();
      expect(deps.stopWorker).not.toHaveBeenCalled();
    });

    it('recovers an offline FIFO delivery into a new runtime epoch by converging the same participant', () => {
      // Dispatched while the worker had no provider session (epoch-queued); the
      // durable queue delivered it into the live runtime that exists now.
      const seeded = seedDelegated({ boundIdentity: workerIdentity('epoch-queued') });
      const leaseBefore = getSupervisionTaskRegistry().getAssignment(seeded.assignmentId)!.leaseId;
      deliver(seeded.messageId, { sessionInstanceId: 'instance-worker', runtimeEpoch: 'epoch-live' }, 'thread-live');

      expect(activity(seeded, { active: [], conversation: 'thread-live' })).toEqual([
        { status: 'started', taskId: seeded.taskId, assignmentId: seeded.assignmentId, identityConverged: true },
      ]);
      const assignment = getSupervisionTaskRegistry().getAssignment(seeded.assignmentId)!;
      expect(assignment).toMatchObject({ status: 'implementing', identity: workerIdentity('epoch-live'), leaseId: leaseBefore });
      expect(autoStartEvents(seeded.taskId)[0]!.payload).toMatchObject({
        deliveryProof: SUPERVISION_ASSIGNMENT_DELIVERY_PROOF.DELIVERY_TOMBSTONE,
        runtimeIdentityConverged: { from: { runtimeEpoch: 'epoch-queued' }, to: { runtimeEpoch: 'epoch-live' } },
      });
    });

    it('refuses a delivery that went into a replaced runtime without stopping unrelated work', () => {
      const seeded = seedDelegated({ boundIdentity: workerIdentity('epoch-old') });
      deliver(seeded.messageId, { sessionInstanceId: 'instance-worker', runtimeEpoch: 'epoch-old' });
      const deps = recordingDeps();

      expect(activity(seeded, {}, deps)).toEqual([{
        status: 'refused', taskId: seeded.taskId, assignmentId: seeded.assignmentId,
        refusal: SUPERVISION_ASSIGNMENT_START_REFUSALS.DELIVERED_TO_REPLACED_RUNTIME, workerStopped: false,
      }]);
      expect(getSupervisionTaskRegistry().getAssignment(seeded.assignmentId)?.status).toBe('delegated');
      expect(deps.escalate).toHaveBeenCalledExactlyOnceWith({
        taskId: seeded.taskId, assignmentId: seeded.assignmentId, deliver: true,
        exactError: assignmentStartRefusalError(SUPERVISION_ASSIGNMENT_START_REFUSALS.DELIVERED_TO_REPLACED_RUNTIME),
      });
      expect(deps.stopWorker).not.toHaveBeenCalled();
    });

    it('fails closed on a superseded revision and stops the turn that is carrying the task', () => {
      const seeded = seedDelegated();
      expect(getSupervisionTaskRegistry().updateTask({ taskId: seeded.taskId, currentRevision: 'rev-2', now: 1_800 }))
        .toMatchObject({ ok: true });
      const deps = recordingDeps();

      expect(activity(seeded, { active: [seeded.messageId] }, deps)).toEqual([{
        status: 'refused', taskId: seeded.taskId, assignmentId: seeded.assignmentId,
        refusal: SUPERVISION_ASSIGNMENT_START_REFUSALS.REVISION_SUPERSEDED, workerStopped: true,
      }]);
      expect(getSupervisionTaskRegistry().getAssignment(seeded.assignmentId)?.status).toBe('delegated');
      expect(deps.stopWorker).toHaveBeenCalledExactlyOnceWith(WORKER);
      expect(deps.escalate).toHaveBeenCalledOnce();
      expect(autoStartEvents(seeded.taskId)).toHaveLength(0);
    });

    it('refuses an identity mismatch it cannot attribute, without stopping', () => {
      const seeded = seedDelegated({ boundIdentity: workerIdentity('epoch-bound') });
      deliver(seeded.messageId, null);
      const deps = recordingDeps();
      expect(activity(seeded, {}, deps)).toEqual([{
        status: 'refused', taskId: seeded.taskId, assignmentId: seeded.assignmentId,
        refusal: SUPERVISION_ASSIGNMENT_START_REFUSALS.RUNTIME_IDENTITY_MISMATCH, workerStopped: false,
      }]);
      expect(deps.stopWorker).not.toHaveBeenCalled();
    });

    it('starts a delivery the live runtime is not proven to have received only for the exact bound runtime', () => {
      const seeded = seedDelegated();
      deliver(seeded.messageId, null);
      expect(activity(seeded)[0]).toMatchObject({ status: 'started', identityConverged: false });
    });

    it('starts after the registry rebound the assignment onto the live runtime even though the original went elsewhere', () => {
      // Original task delivered to a replaced runtime; a continuation/heartbeat
      // convergence has since bound the assignment to the live runtime.
      const seeded = seedDelegated();
      deliver(seeded.messageId, { sessionInstanceId: 'instance-worker', runtimeEpoch: 'epoch-old' });
      expect(activity(seeded)[0]).toMatchObject({ status: 'started', identityConverged: false });
    });

    it('reports a start that cannot be persisted as a fail-closed refusal', () => {
      const seeded = seedDelegated();
      vi.spyOn(getSupervisionTaskRegistry(), 'startAssignmentFromRuntimeEvidence').mockImplementation(() => {
        throw new Error('database is locked');
      });
      const deps = recordingDeps();
      expect(activity(seeded, { active: [seeded.messageId] }, deps)).toEqual([{
        status: 'refused', taskId: seeded.taskId, assignmentId: seeded.assignmentId,
        refusal: SUPERVISION_ASSIGNMENT_START_REFUSALS.START_PERSISTENCE_FAILED, workerStopped: true,
      }]);
    });

    it('holds an assignment with a persisted refusal and delivers it at a bounded rate', async () => {
      const seeded = seedDelegated();
      const exactError = assignmentStartRefusalError(SUPERVISION_ASSIGNMENT_START_REFUSALS.REVISION_SUPERSEDED);
      expect(getSupervisionTaskRegistry().recordAssignmentStartRefusalBlocker({
        assignmentId: seeded.assignmentId,
        blocker: JSON.stringify({ exactError, blockerFingerprint: 'fp-1' }),
        blockerFingerprint: 'fp-1',
        now: 1_900,
      })).toMatchObject({ ok: true });
      let now = 2_000;
      const deps = { ...recordingDeps(), now: () => now };

      expect(activity(seeded, { active: [seeded.messageId] }, deps)[0]!.status).toBe('held');
      expect(deps.escalate).toHaveBeenCalledExactlyOnceWith({
        taskId: seeded.taskId, assignmentId: seeded.assignmentId, exactError, deliver: true,
      });
      expect(deps.stopWorker).toHaveBeenCalledOnce();
      // Still in flight: an event in the same tick never starts a second report.
      expect(activity(seeded, { active: [seeded.messageId] }, deps)[0]!.status).toBe('held');
      expect(deps.escalate).toHaveBeenCalledOnce();
      await new Promise((resolve) => setImmediate(resolve));
      now += 1_000;
      expect(activity(seeded, { active: [seeded.messageId] }, deps)[0]!.status).toBe('held');
      expect(deps.escalate).toHaveBeenCalledOnce();
      now += 60_000;
      activity(seeded, { active: [seeded.messageId] }, deps);
      expect(deps.escalate).toHaveBeenCalledTimes(2);
      expect(getSupervisionTaskRegistry().getAssignment(seeded.assignmentId)?.status).toBe('delegated');
    });
  });

  describe('authenticated ACK', () => {
    it('starts from the recipient\'s own authenticated call, converging a rotated runtime, idempotently', () => {
      const seeded = seedDelegated({ boundIdentity: workerIdentity('epoch-queued') });
      const ack = () => autoStartAssignmentFromAck({
        taskId: seeded.taskId, assignmentId: seeded.assignmentId, projectName: PROJECT,
        callerIdentity: workerIdentity('epoch-live'),
        evidence: SUPERVISION_ASSIGNMENT_START_EVIDENCE.ASSIGNMENT_ACK, evidenceEventId: 'intent:heartbeat',
      }, recordingDeps());
      expect(ack()).toEqual({ status: 'started', taskId: seeded.taskId, assignmentId: seeded.assignmentId, identityConverged: true });
      expect(ack()).toEqual({ status: 'already_started', taskId: seeded.taskId, assignmentId: seeded.assignmentId });
      expect(autoStartEvents(seeded.taskId)[0]!.payload).toMatchObject({
        evidence: SUPERVISION_ASSIGNMENT_START_EVIDENCE.ASSIGNMENT_ACK,
        deliveryProof: SUPERVISION_ASSIGNMENT_DELIVERY_PROOF.AUTHENTICATED_ACK,
      });
    });

    it('persists a refusal without delivering it from the recipient process', () => {
      const seeded = seedDelegated();
      expect(getSupervisionTaskRegistry().updateTask({ taskId: seeded.taskId, currentRevision: 'rev-2', now: 1_800 }))
        .toMatchObject({ ok: true });
      const deps = recordingDeps();
      expect(autoStartAssignmentFromAck({
        taskId: seeded.taskId, assignmentId: seeded.assignmentId, projectName: PROJECT,
        callerIdentity: workerIdentity(), evidence: SUPERVISION_ASSIGNMENT_START_EVIDENCE.FILE_EVENT,
        evidenceEventId: 'file:src/a.ts',
      }, deps)).toMatchObject({ status: 'refused', refusal: SUPERVISION_ASSIGNMENT_START_REFUSALS.REVISION_SUPERSEDED });
      expect(deps.escalate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ deliver: false }));
      expect(deps.stopWorker).not.toHaveBeenCalled();
    });

    it('reports a blocker-held assignment as held, but a cancelled task as nothing to start', () => {
      const held = seedDelegated({ suffix: 'held' });
      expect(getSupervisionTaskRegistry().recordAssignmentStartRefusalBlocker({
        assignmentId: held.assignmentId, blocker: '{"blockerFingerprint":"h"}', blockerFingerprint: 'h',
      })).toMatchObject({ ok: true });
      const cancelled = seedDelegated({ suffix: 'cancelled' });
      expect(getSupervisionTaskRegistry().updateTask({ taskId: cancelled.taskId, status: 'cancelled' })).toMatchObject({ ok: true });
      const ack = (seeded: Seeded) => autoStartAssignmentFromAck({
        taskId: seeded.taskId, assignmentId: seeded.assignmentId, projectName: PROJECT, callerIdentity: workerIdentity(),
        evidence: SUPERVISION_ASSIGNMENT_START_EVIDENCE.ASSIGNMENT_ACK, evidenceEventId: 'intent:heartbeat',
      }, recordingDeps());
      expect(ack(held)).toEqual({ status: 'held', taskId: held.taskId, assignmentId: held.assignmentId });
      expect(ack(cancelled)).toEqual({ status: 'ignored', taskId: cancelled.taskId, assignmentId: cancelled.assignmentId, reason: 'invalid_transition' });
    });

    it('never lets another project session start the assignment', () => {
      const seeded = seedDelegated();
      expect(autoStartAssignmentFromAck({
        taskId: seeded.taskId, assignmentId: seeded.assignmentId, projectName: PROJECT,
        callerIdentity: { ...workerIdentity(), sessionName: 'deck_sub_alpha_intruder' },
        evidence: SUPERVISION_ASSIGNMENT_START_EVIDENCE.ASSIGNMENT_ACK, evidenceEventId: 'intent:checkpoint',
      }, recordingDeps())).toMatchObject({ status: 'refused', refusal: SUPERVISION_ASSIGNMENT_START_REFUSALS.RUNTIME_IDENTITY_MISMATCH });
      expect(getSupervisionTaskRegistry().getAssignment(seeded.assignmentId)?.status).toBe('delegated');
    });
  });

  describe('structured Brain escalation', () => {
    it('persists one fingerprinted report and delivers it to the Brain exactly once, redelivering after a lost dispatch', async () => {
      const seeded = seedDelegated();
      expect(getSupervisionTaskRegistry().updateTask({ taskId: seeded.taskId, currentRevision: 'rev-2', now: 1_800 }))
        .toMatchObject({ ok: true });
      const exactError = assignmentStartRefusalError(SUPERVISION_ASSIGNMENT_START_REFUSALS.REVISION_SUPERSEDED);
      const sessions = [session(BRAIN, { label: 'Brain' }), session(WORKER, { label: 'Worker' })];
      let delivered = false;
      const dispatchMessage = vi.fn(async () => { delivered = true; return 'sent' as const; });
      const sendDeps = { listSessions: () => sessions, dispatchMessage, hasDeliveryEvidence: () => delivered };

      const lifecycleEventsBefore = getSupervisionTaskRegistry().listEvents(seeded.taskId)
        .filter((event) => event.eventType !== 'implementation_heartbeat').length;
      // Persist-only (the recipient's MCP process), then the daemon delivers.
      await expect(escalateAssignmentStartRefusal({ taskId: seeded.taskId, assignmentId: seeded.assignmentId, exactError, deliver: false }, sendDeps))
        .resolves.toMatchObject({ status: 'waiting', replay: false });
      expect(dispatchMessage).not.toHaveBeenCalled();
      const blocker = getSupervisionTaskRegistry().getAssignment(seeded.assignmentId)!.blocker!;
      expect(readAssignmentStartRefusalError(blocker)).toBe(exactError);

      await expect(escalateAssignmentStartRefusal({ taskId: seeded.taskId, assignmentId: seeded.assignmentId, exactError, deliver: true }, sendDeps))
        .resolves.toMatchObject({ status: 'waiting', replay: true });
      expect(dispatchMessage).toHaveBeenCalledOnce();
      const report = JSON.parse(String((dispatchMessage.mock.calls[0] as unknown[])[1]));
      expect(report).toMatchObject({
        taskId: seeded.taskId, assignmentId: seeded.assignmentId, exactError, disposition: 'waiting_for_brain',
        reporter: { sessionName: WORKER }, brain: { sessionName: BRAIN },
      });
      expect(report.options).toEqual(['repair_same_object_authority', 'redispatch_exact_assignment']);
      expect(report.blockerFingerprint).toBe(JSON.parse(blocker).blockerFingerprint);

      await escalateAssignmentStartRefusal({ taskId: seeded.taskId, assignmentId: seeded.assignmentId, exactError, deliver: true }, sendDeps);
      expect(dispatchMessage).toHaveBeenCalledOnce();
      const assignment = getSupervisionTaskRegistry().getAssignment(seeded.assignmentId)!;
      expect(assignment.status).toBe('delegated');
      // The fail-closed disposition is not a lifecycle edge: nothing re-delegates.
      expect(getSupervisionTaskRegistry().listEvents(seeded.taskId)
        .filter((event) => event.eventType !== 'implementation_heartbeat')).toHaveLength(lifecycleEventsBefore);
    });
  });
});

describe('in-place Brain repair of a refused start', () => {
  beforeEach(() => {
    resetSupervisionTaskRegistryForTests();
    resetDelegationReplyStoreForTests();
    resetTransportQueueStoreForTests();
    clearAssignmentAutoStartStateForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetSupervisionTaskRegistryForTests();
    resetDelegationReplyStoreForTests();
    resetTransportQueueStoreForTests();
    clearAssignmentAutoStartStateForTests();
  });

  const persistRefusal = async (seeded: Seeded, refusal: typeof SUPERVISION_ASSIGNMENT_START_REFUSALS[keyof typeof SUPERVISION_ASSIGNMENT_START_REFUSALS]) => {
    const exactError = assignmentStartRefusalError(refusal);
    const sessions = [session(BRAIN), session(WORKER)];
    const result = await escalateAssignmentStartRefusal(
      { taskId: seeded.taskId, assignmentId: seeded.assignmentId, exactError, deliver: false },
      { listSessions: () => sessions, hasDeliveryEvidence: () => false },
    );
    expect(result).toMatchObject({ status: 'waiting' });
    return (result as { report: { recommendedNextAction: string } }).report;
  };
  const clearHold = (seeded: Seeded, assignmentStatus: 'delegated' | 'implementing', key: string) => (
    getSupervisionTaskRegistry().coordinateTaskAssignment({
      taskId: seeded.taskId, assignmentId: seeded.assignmentId, assignmentStatus, leaseAction: 'preserve',
      idempotencyKey: key, reason: 'repair refused automatic start in place',
    })
  );

  it('recovers a delivery to a replaced runtime only in the reported order: re-dispatch, then clear the hold', async () => {
    const seeded = seedDelegated({ boundIdentity: workerIdentity('epoch-old') });
    deliver(seeded.messageId, { sessionInstanceId: 'instance-worker', runtimeEpoch: 'epoch-old' });
    expect(activity(seeded)[0]).toMatchObject({ refusal: SUPERVISION_ASSIGNMENT_START_REFUSALS.DELIVERED_TO_REPLACED_RUNTIME });
    const report = await persistRefusal(seeded, SUPERVISION_ASSIGNMENT_START_REFUSALS.DELIVERED_TO_REPLACED_RUNTIME);
    expect(report.recommendedNextAction).toMatch(/first re-dispatch the exact task.*then clear the hold/);
    expect(activity(seeded, { eventId: 'evt-held' })[0]!.status).toBe('held');

    // Wrong order: clearing the hold before the re-dispatch is refused again.
    expect(clearHold(seeded, 'delegated', 'clear-too-early')).toMatchObject({ ok: true });
    expect(getSupervisionTaskRegistry().getAssignment(seeded.assignmentId)?.blocker).toBeUndefined();
    clearAssignmentAutoStartStateForTests();
    expect(activity(seeded, { eventId: 'evt-too-early' })[0]).toMatchObject({
      status: 'refused', refusal: SUPERVISION_ASSIGNMENT_START_REFUSALS.DELIVERED_TO_REPLACED_RUNTIME,
    });
    await persistRefusal(seeded, SUPERVISION_ASSIGNMENT_START_REFUSALS.DELIVERED_TO_REPLACED_RUNTIME);

    // Reported order: the continuation send re-binds the same participant onto the
    // live runtime (send-tool's durable convergence), then the hold is cleared.
    expect(getSupervisionTaskRegistry().convergeImplementationHeartbeatTarget({
      taskId: seeded.taskId, assignmentId: seeded.assignmentId,
      candidates: [{ projectName: PROJECT, identity: workerIdentity() }],
    })).toMatchObject({ ok: true });
    expect(clearHold(seeded, 'delegated', 'clear-after-redispatch')).toMatchObject({ ok: true });
    clearAssignmentAutoStartStateForTests();
    expect(activity(seeded, { eventId: 'evt-after-repair' })[0]).toMatchObject({ status: 'started' });
    expect(getSupervisionTaskRegistry().getAssignment(seeded.assignmentId)?.status).toBe('implementing');
  });

  it('recovers a superseded revision by moving the same assignment onto the current revision', async () => {
    const seeded = seedDelegated();
    expect(getSupervisionTaskRegistry().updateTask({ taskId: seeded.taskId, currentRevision: 'rev-2', now: 1_800 }))
      .toMatchObject({ ok: true });
    expect(activity(seeded, { active: [seeded.messageId] })[0]).toMatchObject({
      refusal: SUPERVISION_ASSIGNMENT_START_REFUSALS.REVISION_SUPERSEDED,
    });
    const report = await persistRefusal(seeded, SUPERVISION_ASSIGNMENT_START_REFUSALS.REVISION_SUPERSEDED);
    expect(report.recommendedNextAction).toMatch(/assignmentStatus=implementing/);

    expect(clearHold(seeded, 'implementing', 'move-to-current-revision')).toMatchObject({ ok: true });
    const repaired = getSupervisionTaskRegistry().getAssignment(seeded.assignmentId)!;
    expect(repaired).toMatchObject({ status: 'implementing' });
    expect(repaired.blocker).toBeUndefined();
    expect(repaired.auditRevision).toBeUndefined();
    clearAssignmentAutoStartStateForTests();
    expect(activity(seeded, { active: [seeded.messageId], eventId: 'evt-after-revision-repair' })[0]!.status).toBe('already_started');
  });
});

describe('registry start fence', () => {
  beforeEach(() => {
    resetSupervisionTaskRegistryForTests();
    resetDelegationReplyStoreForTests();
  });
  afterEach(() => {
    resetSupervisionTaskRegistryForTests();
    resetDelegationReplyStoreForTests();
  });

  const start = (seeded: Seeded, overrides: Partial<Parameters<ReturnType<typeof getSupervisionTaskRegistry>['startAssignmentFromRuntimeEvidence']>[0]> = {}) => (
    getSupervisionTaskRegistry().startAssignmentFromRuntimeEvidence({
      taskId: seeded.taskId, assignmentId: seeded.assignmentId, projectName: PROJECT, identity: workerIdentity(),
      evidence: SUPERVISION_ASSIGNMENT_START_EVIDENCE.PROVIDER_ACTIVITY, evidenceEventId: 'evt', now: 5_000,
      ...overrides,
    })
  );

  it('requires an exact runtime unless delivery to the live runtime is proven', () => {
    const seeded = seedDelegated({ boundIdentity: workerIdentity('epoch-bound') });
    expect(start(seeded)).toMatchObject({ ok: false, reason: 'owner_mismatch' });
    expect(start(seeded, { projectName: 'beta', deliveryProof: SUPERVISION_ASSIGNMENT_DELIVERY_PROOF.DELIVERY_TOMBSTONE }))
      .toMatchObject({ ok: false, reason: 'owner_mismatch' });
    expect(start(seeded, { deliveryProof: SUPERVISION_ASSIGNMENT_DELIVERY_PROOF.DELIVERY_TOMBSTONE })).toMatchObject({ ok: true });
  });

  it('refuses a blocked, terminal, or non-implementer assignment and replays anything already started', () => {
    const blocked = seedDelegated({ suffix: 'blocked' });
    const registry = getSupervisionTaskRegistry();
    expect(registry.recordAssignmentStartRefusalBlocker({
      assignmentId: blocked.assignmentId, blocker: '{"blockerFingerprint":"x"}', blockerFingerprint: 'x',
    })).toMatchObject({ ok: true });
    expect(start(blocked)).toMatchObject({ ok: false, reason: 'invalid_transition' });

    const cancelled = seedDelegated({ suffix: 'cancelled' });
    expect(registry.updateTask({ taskId: cancelled.taskId, status: 'cancelled' })).toMatchObject({ ok: true });
    expect(start(cancelled)).toMatchObject({ ok: false, reason: 'invalid_transition' });

    const coordinator = seedDelegated({ suffix: 'coord' });
    expect(start({ ...coordinator, assignmentId: `${coordinator.assignmentId}_coord` }, { identity: brainIdentity }))
      .toMatchObject({ ok: false, reason: 'role_forbidden' });

    const validated = seedDelegated({ suffix: 'validated' });
    expect(start(validated)).toMatchObject({ ok: true });
    const eventsAfterStart = registry.listEvents(validated.taskId).length;
    expect(start(validated, { evidenceEventId: 'evt-replay' })).toMatchObject({ ok: true, replay: true });
    expect(registry.listEvents(validated.taskId)).toHaveLength(eventsAfterStart);
  });

  it('repairs an interrupted row with no lease in the same transaction', () => {
    const seeded = seedDelegated();
    const registry = getSupervisionTaskRegistry();
    const before = registry.getAssignment(seeded.assignmentId)!;
    vi.spyOn(registry, 'getAssignment').mockImplementation((id) => {
      const record = registry.listAssignments(seeded.taskId).find((candidate) => candidate.assignmentId === id);
      return record && id === seeded.assignmentId && record.status === 'delegated' ? { ...record, leaseId: '' } : record;
    });
    const started = start(seeded);
    vi.restoreAllMocks();
    expect(started).toMatchObject({ ok: true });
    if (!started.ok) return;
    expect(started.value.leaseId).toBeTruthy();
    expect(started.value.leaseId).not.toBe(before.leaseId);
    expect(started.value.generation).toBe(before.generation + 1);
  });
});

describe('exact provider-conversation delivery proof', () => {
  const OLD = { sessionInstanceId: 'instance-worker', runtimeEpoch: 'epoch-old' };
  const LIVE = { sessionInstanceId: 'instance-worker', runtimeEpoch: 'epoch-live' };

  beforeEach(() => {
    resetSupervisionTaskRegistryForTests();
    resetDelegationReplyStoreForTests();
    resetTransportQueueStoreForTests();
    clearAssignmentAutoStartStateForTests();
    clearAllResend();
    removeSession(WORKER);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearAllResend();
    resetSupervisionTaskRegistryForTests();
    resetDelegationReplyStoreForTests();
    resetTransportQueueStoreForTests();
    clearAssignmentAutoStartStateForTests();
    removeSession(WORKER);
  });

  const evidence = (seeded: Seeded, conversation: string | undefined, bound = workerIdentity('epoch-old')) => readAssignmentDeliveryEvidence({
    taskId: seeded.taskId, assignmentId: seeded.assignmentId, sessionName: WORKER,
    assignmentIdentity: bound, liveIdentity: workerIdentity(),
    ...(conversation ? { liveConversationKey: conversation } : {}),
    activeDispatchMessageIds: new Set(),
  });

  it('stamps the delivering conversation on the tombstone and keeps it when a relaunch relabels the epoch', () => {
    deliver('msg_stamp', OLD, 'thread-a');
    holdConversation('thread-b');
    expect(getTransportQueueStore().rebindRecipientRuntimeEpoch(WORKER, OLD, LIVE)).toBe(true);
    // The epoch label moves with the queue; the conversation that received it does not.
    expect(getTransportQueueStore().listDeliveryRecipients(WORKER, 'msg_stamp')).toEqual([
      expect.objectContaining({ recipient: LIVE, conversationKey: 'thread-a' }),
    ]);
    deliver('msg_unknown', LIVE);
    expect(getTransportQueueStore().listDeliveryRecipients(WORKER, 'msg_unknown')).toEqual([
      expect.objectContaining({ recipient: LIVE, conversationKey: null }),
    ]);
  });

  it('proves a resumed conversation across a same-instance relaunch, and refuses a reset one as a replaced runtime', () => {
    const seeded = seedDelegated({ boundIdentity: workerIdentity('epoch-old') });
    deliver(seeded.messageId, OLD, 'thread-a');
    expect(getTransportQueueStore().rebindRecipientRuntimeEpoch(WORKER, OLD, LIVE)).toBe(true);

    expect(evidence(seeded, 'thread-a')).toEqual({
      kind: 'live', proof: SUPERVISION_ASSIGNMENT_DELIVERY_PROOF.DELIVERY_TOMBSTONE, messageId: seeded.messageId,
    });
    expect(evidence(seeded, 'thread-reset')).toEqual({ kind: 'replaced_runtime', messageId: seeded.messageId });
    expect(evidence(seeded, undefined)).toEqual({ kind: 'delivered', messageId: seeded.messageId });

    // Reset: the fresh conversation never saw the task. Fail closed and report,
    // without stopping unrelated work.
    const deps = recordingDeps();
    expect(activity(seeded, { conversation: 'thread-reset' }, deps)).toEqual([{
      status: 'refused', taskId: seeded.taskId, assignmentId: seeded.assignmentId,
      refusal: SUPERVISION_ASSIGNMENT_START_REFUSALS.DELIVERED_TO_REPLACED_RUNTIME, workerStopped: false,
    }]);
    expect(deps.escalate).toHaveBeenCalledOnce();
    expect(deps.stopWorker).not.toHaveBeenCalled();
    expect(getSupervisionTaskRegistry().getAssignment(seeded.assignmentId)?.status).toBe('delegated');

    // Resume: the relaunched runtime holds the same conversation and starts in place.
    clearAssignmentAutoStartStateForTests();
    expect(activity(seeded, { conversation: 'thread-a', eventId: 'evt-resumed' })).toEqual([
      { status: 'started', taskId: seeded.taskId, assignmentId: seeded.assignmentId, identityConverged: true },
    ]);
    expect(autoStartEvents(seeded.taskId)[0]!.payload).toMatchObject({
      deliveryProof: SUPERVISION_ASSIGNMENT_DELIVERY_PROOF.DELIVERY_TOMBSTONE,
    });
  });

  it('never counts a conversation the bound runtime replaced, and never proves an unknown one', () => {
    const replaced = seedDelegated({ suffix: 'replaced', boundIdentity: workerIdentity() });
    deliver(replaced.messageId, LIVE, 'thread-a');
    // Bound to the exact live runtime, but its provider conversation is not the one delivered to.
    expect(evidence(replaced, 'thread-b', workerIdentity())).toEqual({ kind: 'replaced_runtime', messageId: replaced.messageId });
    expect(activity(replaced, { conversation: 'thread-b' })[0]).toMatchObject({
      status: 'refused', refusal: SUPERVISION_ASSIGNMENT_START_REFUSALS.DELIVERED_TO_REPLACED_RUNTIME,
    });

    const unknown = seedDelegated({ suffix: 'unknown', boundIdentity: workerIdentity('epoch-bound') });
    deliver(unknown.messageId, LIVE);
    // Delivered to the live runtime while no conversation was known: never proof,
    // so a rotated identity cannot converge on it.
    expect(activity(unknown, { conversation: 'thread-b' })[0]).toMatchObject({
      status: 'refused', refusal: SUPERVISION_ASSIGNMENT_START_REFUSALS.RUNTIME_IDENTITY_MISMATCH,
    });
    expect(getSupervisionTaskRegistry().getAssignment(unknown.assignmentId)?.status).toBe('delegated');
  });

  it('defers the refusal while a re-dispatch of the same assignment is still queued for the worker', () => {
    const seeded = seedDelegated({ boundIdentity: workerIdentity('epoch-old') });
    deliver(seeded.messageId, OLD, 'thread-a');
    getDelegationReplyStore().create({
      origin: { sessionName: BRAIN, sessionInstanceId: 'instance-brain', runtimeEpoch: 'epoch-brain' },
      target: { sessionName: WORKER, sessionInstanceId: 'instance-worker', runtimeEpoch: 'epoch-live' },
      dispatchId: 'dispatch_redispatch', messageId: 'msg_redispatch', taskId: seeded.taskId, assignmentId: seeded.assignmentId,
      coordinatorAssignmentId: `${seeded.assignmentId}_coord`, now: 1_700,
    });
    expect(enqueueResend(WORKER, {
      recipient: LIVE, text: 'continue the exact task', commandId: 'msg_redispatch', clientMessageId: 'msg_redispatch', queuedAt: Date.now(),
    }).accepted).toBe(true);

    expect(evidence(seeded, 'thread-b')).toEqual({ kind: 'none' });
    const deps = recordingDeps();
    expect(activity(seeded, { conversation: 'thread-b' }, deps)).toEqual([
      { status: 'not_delivered', taskId: seeded.taskId, assignmentId: seeded.assignmentId },
    ]);
    expect(deps.escalate).not.toHaveBeenCalled();
  });
});

describe('preserved-queue relaunch delivers the task into the successor runtime', () => {
  const OLD = { sessionInstanceId: 'instance-worker', runtimeEpoch: 'epoch-old' };
  const LIVE = { sessionInstanceId: 'instance-worker', runtimeEpoch: 'epoch-live' };

  beforeEach(() => {
    resetSupervisionTaskRegistryForTests();
    resetDelegationReplyStoreForTests();
    resetTransportQueueStoreForTests();
    clearAssignmentAutoStartStateForTests();
    clearAllResend();
    removeSession(WORKER);
  });
  afterEach(() => {
    clearAllResend();
    resetSupervisionTaskRegistryForTests();
    resetDelegationReplyStoreForTests();
    resetTransportQueueStoreForTests();
    clearAssignmentAutoStartStateForTests();
    removeSession(WORKER);
  });

  /** The replaced runtime still had the dispatch in its FIFO; relaunch preserves it. */
  function preserveDispatch(seeded: Seeded) {
    const replaced = {
      activeDispatchEntries: [],
      pendingEntries: [{ clientMessageId: seeded.messageId, text: 'formal task dispatch', timelineCommitted: true }],
      recipientIdentity: OLD,
    } as unknown as TransportSessionRuntime;
    expect(preserveTransportRuntimeQueuesToResend(WORKER, replaced)).toMatchObject({ preservedCount: 1, rejectedCount: 0 });
  }

  async function drainInto(recipient: typeof LIVE) {
    const sent: string[] = [];
    const drained = await drainResend(WORKER, async (entry) => {
      sent.push(entry.clientMessageId ?? '');
      return 'sent';
    }, undefined, undefined, undefined, recipient);
    return { drained, sent };
  }

  it('starts in place when the same-instance successor drains the dispatch into the conversation it holds', async () => {
    const seeded = seedDelegated({ boundIdentity: workerIdentity('epoch-old') });
    holdConversation('thread-resumed');
    preserveDispatch(seeded);
    expect(activity(seeded, { conversation: 'thread-resumed' })[0]!.status).toBe('not_delivered');

    expect(getTransportQueueStore().rebindRecipientRuntimeEpoch(WORKER, OLD, LIVE)).toBe(true);
    await expect(drainInto(LIVE)).resolves.toEqual({ drained: 1, sent: [seeded.messageId] });
    expect(getTransportQueueStore().listDeliveryRecipients(WORKER, seeded.messageId)).toEqual([
      expect.objectContaining({ recipient: LIVE, conversationKey: 'thread-resumed' }),
    ]);

    const deps = recordingDeps();
    expect(activity(seeded, { conversation: 'thread-resumed' }, deps)).toEqual([
      { status: 'started', taskId: seeded.taskId, assignmentId: seeded.assignmentId, identityConverged: true },
    ]);
    expect(getSupervisionTaskRegistry().getAssignment(seeded.assignmentId)).toMatchObject({
      status: 'implementing', identity: workerIdentity(),
    });
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it('gives a same-named successor INSTANCE nothing to drain and nothing to start from', async () => {
    const seeded = seedDelegated({ boundIdentity: workerIdentity('epoch-old') });
    holdConversation('thread-successor');
    preserveDispatch(seeded);
    const SUCCESSOR = { sessionInstanceId: 'instance-successor', runtimeEpoch: 'epoch-successor' };
    expect(getTransportQueueStore().rebindRecipientRuntimeEpoch(WORKER, OLD, SUCCESSOR)).toBe(false);
    await expect(drainInto(SUCCESSOR)).resolves.toEqual({ drained: 0, sent: [] });

    const deps = recordingDeps();
    expect(activity(seeded, {
      live: workerIdentity('epoch-successor', 'instance-successor'), conversation: 'thread-successor',
    }, deps)).toEqual([{ status: 'not_delivered', taskId: seeded.taskId, assignmentId: seeded.assignmentId }]);
    expect(getSupervisionTaskRegistry().getAssignment(seeded.assignmentId)?.status).toBe('delegated');
    expect(deps.escalate).not.toHaveBeenCalled();
  });
});

describe('start-refusal report through the durable queue and its final delivery authority', () => {
  beforeEach(() => {
    resetSupervisionTaskRegistryForTests();
    resetDelegationReplyStoreForTests();
    resetTransportQueueStoreForTests();
    clearAssignmentAutoStartStateForTests();
    clearAllResend();
    upsertSession(session(BRAIN, { label: 'Brain', runtimeType: 'transport' }));
  });
  afterEach(() => {
    clearAllResend();
    removeSession(BRAIN);
    resetSupervisionTaskRegistryForTests();
    resetDelegationReplyStoreForTests();
    resetTransportQueueStoreForTests();
    clearAssignmentAutoStartStateForTests();
  });

  it('reaches the Brain exactly once while the exact hold stands, and is stale once repaired or for any other report', async () => {
    const seeded = seedDelegated();
    const exactError = assignmentStartRefusalError(SUPERVISION_ASSIGNMENT_START_REFUSALS.DELIVERED_TO_REPLACED_RUNTIME);
    const sessions = [session(BRAIN, { label: 'Brain' }), session(WORKER, { label: 'Worker' })];
    const result = await escalateAssignmentStartRefusal({ ...seeded, exactError, deliver: true }, {
      listSessions: () => sessions,
      hasDeliveryEvidence: () => false,
      dispatchMessage: async (target, message, options) => {
        const queued = enqueueResend(target.name, {
          text: message,
          commandId: options.messageId,
          clientMessageId: options.messageId,
          supervisionReference: options.queueSupervisionReference,
          queuedAt: Date.now(),
        });
        if (!queued.accepted) throw new Error('durable queue rejected the report');
        return 'queued';
      },
    });
    expect(result).toMatchObject({ status: 'waiting', replay: false });
    const held = getSupervisionTaskRegistry().getAssignment(seeded.assignmentId)!;
    expect(held.status).toBe('delegated');
    const messageId = deterministicSendMessageId(`implementation-blocker:${JSON.parse(held.blocker!).blockerFingerprint}`);
    const reference = { kind: 'implementation_blocker' as const, taskId: seeded.taskId, assignmentId: seeded.assignmentId, revision: REVISION, exactError };
    const admission = (clientMessageId = messageId, supervisionReference = reference) => resolveQueuedSupervisionHeartbeatDelivery({
      targetSessionName: BRAIN, clientMessageId, text: held.blocker!, supervisionReference,
    });
    expect(admission('send_message_other_fingerprint')).toBe('stale');

    const delivered: unknown[] = [];
    const drained = await drainResend(BRAIN, async (entry) => {
      const decision = resolveQueuedSupervisionHeartbeatDelivery({
        targetSessionName: BRAIN,
        clientMessageId: entry.clientMessageId ?? '',
        text: entry.text,
        supervisionReference: entry.supervisionReference,
      });
      if (decision === 'retry') return RESEND_DISPATCH_CONTROL.RETRY;
      if (decision === 'stale') return RESEND_DISPATCH_CONTROL.STALE;
      delivered.push(entry.supervisionReference);
      return 'sent';
    });
    expect(drained).toBe(1);
    expect(delivered).toEqual([reference]);
    expect(getTransportQueueStore().hasDeliveryTombstone(BRAIN, messageId)).toBe(true);

    // The Brain repairs the hold in place: a late copy of the report is stale.
    expect(getSupervisionTaskRegistry().coordinateTaskAssignment({
      taskId: seeded.taskId, assignmentId: seeded.assignmentId, assignmentStatus: 'delegated', leaseAction: 'preserve',
      idempotencyKey: 'repair-start-refusal', reason: 'repair refused automatic start in place',
    })).toMatchObject({ ok: true });
    expect(admission()).toBe('stale');

    // Only the refused-start family is admitted on a delegated hold.
    const otherError = 'not an automatic start refusal';
    await expect(escalateImplementationBlocker({
      taskId: seeded.taskId, assignmentId: seeded.assignmentId, eligibleStatus: 'delegated',
      ineligibleReason: 'assignment_not_delegated', exactError: otherError, completedSafeWork: 'none',
      brainOptions: ['repair_same_object_authority'], brainRecommendedNextAction: 'repair',
      persist: (record) => getSupervisionTaskRegistry().recordAssignmentStartRefusalBlocker(record), deliver: false,
    }, { listSessions: () => sessions, hasDeliveryEvidence: () => false })).resolves.toMatchObject({ status: 'waiting' });
    const other = JSON.parse(getSupervisionTaskRegistry().getAssignment(seeded.assignmentId)!.blocker!) as { blockerFingerprint: string };
    expect(admission(
      deterministicSendMessageId(`implementation-blocker:${other.blockerFingerprint}`),
      { ...reference, exactError: otherError },
    )).toBe('stale');
  });
});
