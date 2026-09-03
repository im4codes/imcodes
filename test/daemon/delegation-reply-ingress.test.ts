import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_DELEGATION_COMPLETION_NOTIFICATION_MARKER,
  AGENT_DELEGATION_NOTIFICATION_RESULTS,
  AGENT_DELEGATION_PURPOSES,
  AGENT_DELEGATION_REPLY_ERRORS,
  AGENT_DELEGATION_REPLY_TIMELINE_EVENT,
  AGENT_DELEGATION_REPLY_VERSION,
} from '../../shared/agent-delegation.js';
import { PEER_AUDIT_REPLY_VERSION } from '../../shared/peer-audit.js';

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, Record<string, unknown>>(),
  runtime: undefined as undefined | {
    deliverDelegationNotification: ReturnType<typeof vi.fn>;
  },
  restoredRuntime: undefined as undefined | {
    deliverDelegationNotification: ReturnType<typeof vi.fn>;
  },
  store: {
    matchPendingAuditAuthority: vi.fn(),
    rebindAssignmentTarget: vi.fn(),
    receive: vi.fn(),
    markDelivered: vi.fn(),
    expire: vi.fn(),
    get: vi.fn(),
    getMessage: vi.fn(),
    listReceived: vi.fn(() => []),
  },
  timelineEmit: vi.fn(),
  appendMatchingAuditReceipt: vi.fn(),
  finishAssignment: vi.fn(),
  getAssignment: vi.fn(),
}));

vi.mock('../../src/store/session-store.js', () => ({
  getSession: (name: string) => mocks.sessions.get(name),
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  getTransportRuntime: () => mocks.runtime,
  ensureTransportRuntimeAvailable: vi.fn(async () => mocks.restoredRuntime),
}));

vi.mock('../../src/daemon/delegation-reply-store.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/daemon/delegation-reply-store.js')>(),
  getDelegationReplyStore: () => mocks.store,
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: mocks.timelineEmit },
}));

vi.mock('../../src/daemon/supervision-state-store.js', () => ({
  getSupervisionTaskRegistry: () => ({
    appendMatchingAuditReceipt: mocks.appendMatchingAuditReceipt,
    finishAssignment: mocks.finishAssignment,
    getAssignment: mocks.getAssignment,
  }),
}));

import {
  clearDelegationReplyIngressForTests,
  submitDelegationReply,
} from '../../src/daemon/delegation-reply-ingress.js';
import {
  clearPeerAuditReplyIngressRateLimits,
  registerPeerAuditReplyIngressHandler,
  submitPeerAuditReply,
} from '../../src/daemon/peer-audit-reply-ingress.js';
import { onDelegationReplyDelivered } from '../../src/daemon/delegation-reply-events.js';
import { advancePendingRepliesForReboundCoordinator } from '../../src/daemon/delegation-reply-ingress.js';
import { DelegationReplyStore } from '../../src/daemon/delegation-reply-store.js';
import { ensureTransportRuntimeAvailable } from '../../src/agent/session-manager.js';

const origin = {
  sessionName: 'deck_repo_brain',
  sessionInstanceId: 'origin-instance',
  runtimeEpoch: 'origin-epoch',
};
const target = {
  sessionName: 'deck_sub_auditor',
  sessionInstanceId: 'target-instance',
  runtimeEpoch: 'target-epoch',
};
const record = {
  delegationId: 'delegation_identity_1234567890',
  capabilityHash: 'stored-hash',
  origin,
  target,
  dispatchId: 'dispatch-id',
  messageId: 'message-id',
  notificationId: 'notification-id',
  status: 'received' as const,
  result: 'PASS with exact evidence.',
  createdAt: 1,
  expiresAt: Date.now() + 60_000,
  updatedAt: 2,
};
const envelope = {
  version: AGENT_DELEGATION_REPLY_VERSION,
  delegationId: record.delegationId,
  result: record.result,
};

function session(identity: typeof origin): Record<string, unknown> {
  return {
    name: identity.sessionName,
    sessionInstanceId: identity.sessionInstanceId,
    runtimeEpoch: identity.runtimeEpoch,
    state: 'idle',
  };
}

describe('delegation reply ingress', () => {
  beforeEach(() => {
    clearDelegationReplyIngressForTests();
    clearPeerAuditReplyIngressRateLimits();
    registerPeerAuditReplyIngressHandler(null);
    mocks.sessions.clear();
    mocks.sessions.set(origin.sessionName, session(origin));
    mocks.sessions.set(target.sessionName, session(target));
    mocks.runtime = {
      deliverDelegationNotification: vi.fn(async () => AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED),
    };
    mocks.restoredRuntime = undefined;
    mocks.store.receive.mockReset().mockReturnValue({ ok: true, record, replay: false });
    mocks.store.matchPendingAuditAuthority.mockReset();
    mocks.store.rebindAssignmentTarget.mockReset();
    mocks.store.listPendingByCoordinator = vi.fn(() => []);
    mocks.store.rebindAuthorizedOrigin = vi.fn(() => undefined);
    mocks.store.markDelivered.mockReset().mockReturnValue(true);
    mocks.store.expire.mockReset();
    mocks.store.get.mockReset();
    mocks.store.getMessage.mockReset().mockImplementation(() => ({
      ...record,
      status: 'delivered',
      deliveredAt: Date.now(),
    }));
    mocks.store.listReceived.mockReset().mockReturnValue([]);
    mocks.timelineEmit.mockReset();
    mocks.appendMatchingAuditReceipt.mockReset().mockReturnValue({ ok: true, value: {} });
    mocks.finishAssignment.mockReset().mockReturnValue({ ok: true, value: {}, replay: false });
    mocks.getAssignment.mockReset();
    vi.mocked(ensureTransportRuntimeAvailable).mockClear();
  });

  afterEach(() => {
    clearDelegationReplyIngressForTests();
  });

  it('binds the sender and delivers one trusted tokenless notification', async () => {
    const delivered = vi.fn();
    const unsubscribe = onDelegationReplyDelivered(delivered);
    await expect(submitDelegationReply({
      rawBody: envelope,
      senderSessionName: target.sessionName,
    })).resolves.toEqual({
      ok: true,
      delivered: false,
      pending: true,
      reason: AGENT_DELEGATION_REPLY_ERRORS.DELIVERY_PENDING,
    });

    expect(mocks.store.receive).toHaveBeenCalledWith(expect.objectContaining({
      delegationId: record.delegationId,
      sender: target,
      result: record.result,
    }));
    expect(mocks.runtime?.deliverDelegationNotification).toHaveBeenCalledWith({
      notificationId: record.notificationId,
      delegationId: record.delegationId,
      sourceSessionName: target.sessionName,
      text: expect.stringContaining(AGENT_DELEGATION_COMPLETION_NOTIFICATION_MARKER),
    });
    expect(mocks.runtime?.deliverDelegationNotification).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining(record.result) }),
    );
    await vi.waitFor(() => {
      expect(mocks.store.markDelivered).toHaveBeenCalledWith(
        record.delegationId,
        record.notificationId,
      );
    });
    expect(mocks.timelineEmit).toHaveBeenCalledWith(
      origin.sessionName,
      AGENT_DELEGATION_REPLY_TIMELINE_EVENT,
      {
        memoryExcluded: true,
        sourceSessionName: target.sessionName,
        result: record.result,
      },
      {
        source: 'daemon',
        confidence: 'high',
        eventId: `delegation-reply:${record.notificationId}`,
      },
    );
    await vi.waitFor(() => {
      expect(delivered).toHaveBeenCalledWith(expect.objectContaining({
        delegationId: record.delegationId,
        result: record.result,
      }));
    });
    unsubscribe();
  });

  it('accepts the structured peer-audit envelope through daemon-authenticated assignment authority', async () => {
    const auditRecord = {
      ...record,
      purpose: 'supervision_audit' as const,
      auditAttemptId: 'attempt_manual_audit_1',
      auditRevision: 'revision-manual-1',
      auditedSessionName: origin.sessionName,
      taskId: 'supervision_task_manual_1',
      assignmentId: 'supervision_assignment_auditor_1',
    };
    mocks.store.matchPendingAuditAuthority.mockReturnValue(auditRecord);
    mocks.store.receive.mockImplementation((input: { result: string }) => ({
      ok: true,
      record: { ...auditRecord, result: input.result },
      replay: false,
    }));
    mocks.getAssignment.mockReturnValue({
      assignmentId: auditRecord.assignmentId,
      taskId: auditRecord.taskId,
      role: 'auditor',
      auditAttemptId: auditRecord.auditAttemptId,
      auditRevision: auditRecord.auditRevision,
      identity: { ...target, agentType: 'codex-sdk', providerFamily: 'openai' },
    });
    registerPeerAuditReplyIngressHandler(() => ({ ok: false, error: 'attempt_mismatch' }));

    await expect(submitPeerAuditReply({
      rawBody: JSON.stringify({
        version: PEER_AUDIT_REPLY_VERSION,
        taskId: auditRecord.taskId,
        assignmentId: auditRecord.assignmentId,
        attemptId: auditRecord.auditAttemptId,
        revision: auditRecord.auditRevision,
        receiptKind: 'final',
        verdict: 'PASS',
        findings: 'Exact revision and focused validation pass.',
        validations: [{
          kind: 'test', label: 'focused', outcome: 'passed', summary: '29 passed',
        }],
      }),
      senderSessionName: target.sessionName,
      now: 100,
    })).resolves.toEqual({ ok: true });

    expect(mocks.store.matchPendingAuditAuthority).toHaveBeenCalledWith({
      taskId: auditRecord.taskId,
      assignmentId: auditRecord.assignmentId,
      auditAttemptId: auditRecord.auditAttemptId,
      auditRevision: auditRecord.auditRevision,
      sender: target,
      now: 100,
    });
    expect(mocks.store.receive).toHaveBeenCalledWith(expect.objectContaining({
      delegationId: auditRecord.delegationId,
      sender: target,
      authorizedSender: target,
      result: expect.stringContaining('"verdict":"PASS"'),
    }));
    const visibleResult = JSON.parse(mocks.store.receive.mock.calls[0]![0].result) as Record<string, unknown>;
    expect(visibleResult).toMatchObject({
      taskId: auditRecord.taskId,
      assignmentId: auditRecord.assignmentId,
      attemptId: auditRecord.auditAttemptId,
      revision: auditRecord.auditRevision,
      verdict: 'PASS',
    });
    expect(mocks.appendMatchingAuditReceipt).toHaveBeenCalledWith({
      taskId: auditRecord.taskId,
      auditorAssignmentId: auditRecord.assignmentId,
      attemptId: auditRecord.auditAttemptId,
      revision: auditRecord.auditRevision,
      receiptKind: 'final',
      verdict: 'PASS',
      auditedSessionName: origin.sessionName,
      auditorSessionName: target.sessionName,
      auditorIdentity: expect.objectContaining(target),
      findings: 'Exact revision and focused validation pass.',
      validations: [{ kind: 'test', label: 'focused', outcome: 'passed', summary: '29 passed' }],
      now: 100,
    });
    expect(mocks.finishAssignment).toHaveBeenCalledWith({
      assignmentId: auditRecord.assignmentId,
      identity: expect.objectContaining(target),
      revision: auditRecord.auditRevision,
      now: 100,
    });
    expect(visibleResult.assignmentHandoff).toEqual({ status: 'finished', replay: false });
    expect(mocks.timelineEmit).toHaveBeenCalledWith(
      origin.sessionName,
      AGENT_DELEGATION_REPLY_TIMELINE_EVENT,
      expect.objectContaining({ result: expect.stringContaining('"attemptId":"attempt_manual_audit_1"') }),
      expect.any(Object),
    );
  });

  it('accepts one final peer audit when exact redelivery replaces the prior pending authority', async () => {
    const store = new DelegationReplyStore({ dbPath: ':memory:' });
    const taskId = 'tsk_redelivery';
    const assignmentId = 'asg_redelivery_auditor';
    const attemptId = 'attempt-redelivery-r1';
    const revision = 'revision-redelivery-r1';
    const messageId = 'send_message_redelivery-stable';
    const bound = {
      origin,
      target,
      messageId,
      purpose: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
      auditAttemptId: attemptId,
      auditRevision: revision,
      auditedSessionName: origin.sessionName,
      taskId,
      assignmentId,
    } as const;
    const failed = store.create({ ...bound, dispatchId: 'dispatch-failed', now: 10 });
    const redelivery = store.create({ ...bound, dispatchId: 'dispatch-redelivery', now: 12 });
    const auditorAssignments = [{
      assignmentId,
      taskId,
      role: 'auditor',
      auditAttemptId: attemptId,
      auditRevision: revision,
      identity: { ...target, agentType: 'codex-sdk', providerFamily: 'openai' },
    }];
    mocks.store.matchPendingAuditAuthority.mockImplementation((input) => store.matchPendingAuditAuthority(input));
    mocks.store.receive.mockImplementation((input) => store.receive(input));
    mocks.getAssignment.mockImplementation((requested: string) => (
      auditorAssignments.find((assignment) => assignment.assignmentId === requested)
    ));

    try {
      await expect(submitPeerAuditReply({
        rawBody: JSON.stringify({
          version: PEER_AUDIT_REPLY_VERSION,
          taskId,
          assignmentId,
          attemptId,
          revision,
          receiptKind: 'final',
          verdict: 'PASS',
          findings: 'Exact redelivery authority accepted.',
          validations: [{ kind: 'test', label: 'redelivery', outcome: 'passed', summary: 'exact chain passed' }],
        }),
        senderSessionName: target.sessionName,
        now: 20,
      })).resolves.toEqual({ ok: true });

      expect(auditorAssignments).toHaveLength(1);
      expect(mocks.store.matchPendingAuditAuthority).toHaveBeenCalledWith({
        taskId,
        assignmentId,
        auditAttemptId: attemptId,
        auditRevision: revision,
        sender: target,
        now: 20,
      });
      expect(store.get(failed.record.delegationId)?.status).toBe('expired');
      expect(store.get(redelivery.record.delegationId)).toMatchObject({
        status: 'received',
        taskId,
        assignmentId,
        auditAttemptId: attemptId,
        auditRevision: revision,
        messageId,
      });
      expect(mocks.appendMatchingAuditReceipt).toHaveBeenCalledOnce();
      expect(mocks.finishAssignment).toHaveBeenCalledOnce();
    } finally {
      store.close();
    }
  });

  it('persists progress without Brain chatter and reports a blocked final handoff once', async () => {
    const auditRecord = {
      ...record,
      purpose: 'supervision_audit' as const,
      auditAttemptId: 'attempt_quiet_progress_1',
      auditRevision: 'revision-quiet-progress-1',
      auditedSessionName: origin.sessionName,
      taskId: 'supervision_task_quiet_progress_1',
      assignmentId: 'supervision_assignment_quiet_progress_1',
    };
    mocks.store.matchPendingAuditAuthority.mockReturnValue(auditRecord);
    mocks.store.receive.mockImplementation((input: { result: string }) => ({
      ok: true, record: { ...auditRecord, result: input.result }, replay: false,
    }));
    mocks.getAssignment.mockReturnValue({
      assignmentId: auditRecord.assignmentId,
      taskId: auditRecord.taskId,
      role: 'auditor',
      auditAttemptId: auditRecord.auditAttemptId,
      auditRevision: auditRecord.auditRevision,
      identity: { ...target, agentType: 'codex-sdk', providerFamily: 'openai' },
    });
    registerPeerAuditReplyIngressHandler(() => ({ ok: false, error: 'attempt_mismatch' }));

    await expect(submitPeerAuditReply({
      rawBody: JSON.stringify({
        version: PEER_AUDIT_REPLY_VERSION,
        taskId: auditRecord.taskId,
        assignmentId: auditRecord.assignmentId,
        attemptId: auditRecord.auditAttemptId,
        revision: auditRecord.auditRevision,
        receiptKind: 'progress',
        findings: 'Evidence inspection is complete.',
        validations: [],
      }),
      senderSessionName: target.sessionName,
      now: 100,
    })).resolves.toEqual({ ok: true });
    expect(mocks.appendMatchingAuditReceipt).toHaveBeenCalledOnce();
    expect(mocks.store.receive).not.toHaveBeenCalled();
    expect(mocks.timelineEmit).not.toHaveBeenCalled();
    expect(mocks.finishAssignment).not.toHaveBeenCalled();

    mocks.finishAssignment.mockReturnValue({ ok: false, reason: 'old_revision' });
    await expect(submitPeerAuditReply({
      rawBody: JSON.stringify({
        version: PEER_AUDIT_REPLY_VERSION,
        taskId: auditRecord.taskId,
        assignmentId: auditRecord.assignmentId,
        attemptId: auditRecord.auditAttemptId,
        revision: auditRecord.auditRevision,
        receiptKind: 'final',
        verdict: 'REWORK',
        findings: 'Exact blocker remains.',
        validations: [{ kind: 'test', label: 'focused', outcome: 'failed', summary: 'counterexample failed' }],
      }),
      senderSessionName: target.sessionName,
      now: 110,
    })).resolves.toEqual({ ok: true });
    expect(mocks.store.receive).toHaveBeenCalledOnce();
    const result = JSON.parse(mocks.store.receive.mock.calls[0]![0].result) as Record<string, unknown>;
    expect(result).toMatchObject({
      taskId: auditRecord.taskId,
      assignmentId: auditRecord.assignmentId,
      attemptId: auditRecord.auditAttemptId,
      revision: auditRecord.auditRevision,
      verdict: 'REWORK',
      assignmentHandoff: { status: 'blocked', exactError: 'task finish rejected: old_revision' },
    });
    expect(mocks.timelineEmit).toHaveBeenCalledOnce();
  });

  it('rejects a delegated audit receipt that contradicts the authoritative task revision', async () => {
    const auditRecord = {
      ...record,
      purpose: 'supervision_audit' as const,
      auditAttemptId: 'attempt_manual_audit_stale',
      auditRevision: 'revision-current',
      auditedSessionName: origin.sessionName,
      taskId: 'supervision_task_stale',
      assignmentId: 'supervision_assignment_stale',
    };
    mocks.store.matchPendingAuditAuthority.mockReturnValue(auditRecord);
    mocks.getAssignment.mockReturnValue({
      assignmentId: auditRecord.assignmentId,
      taskId: auditRecord.taskId,
      role: 'auditor',
      auditAttemptId: auditRecord.auditAttemptId,
      auditRevision: auditRecord.auditRevision,
      identity: { ...target, agentType: 'codex-sdk', providerFamily: 'openai' },
    });
    mocks.appendMatchingAuditReceipt.mockReturnValue({ ok: false, reason: 'old_revision' });
    registerPeerAuditReplyIngressHandler(() => ({ ok: false, error: 'attempt_mismatch' }));

    await expect(submitPeerAuditReply({
      rawBody: JSON.stringify({
        version: PEER_AUDIT_REPLY_VERSION,
        taskId: auditRecord.taskId,
        assignmentId: auditRecord.assignmentId,
        attemptId: auditRecord.auditAttemptId,
        revision: auditRecord.auditRevision,
        receiptKind: 'final',
        verdict: 'PASS',
        findings: 'Stale evidence must not be delivered.',
        validations: [{
          kind: 'test', label: 'focused', outcome: 'passed', summary: 'focused pass',
        }],
      }),
      senderSessionName: target.sessionName,
      now: 100,
    })).resolves.toEqual({ ok: false, error: 'revision_mismatch' });

    expect(mocks.store.receive).not.toHaveBeenCalled();
    expect(mocks.timelineEmit).not.toHaveBeenCalled();
  });

  it('delivers multiple distinct replies for one delegation without collapsing their in-flight work', async () => {
    const secondRecord = {
      ...record,
      notificationId: 'notification-id-2',
      result: 'A later progress update.',
      updatedAt: 3,
    };
    mocks.store.receive
      .mockReturnValueOnce({ ok: true, record, replay: false })
      .mockReturnValueOnce({ ok: true, record: secondRecord, replay: false });
    mocks.store.getMessage.mockImplementation((_delegationId: string, notificationId: string) => ({
      ...(notificationId === secondRecord.notificationId ? secondRecord : record),
      status: 'delivered',
      deliveredAt: Date.now(),
    }));

    await Promise.all([
      submitDelegationReply({
        rawBody: envelope,
        senderSessionName: target.sessionName,
      }),
      submitDelegationReply({
        rawBody: { ...envelope, result: secondRecord.result },
        senderSessionName: target.sessionName,
      }),
    ]);

    await vi.waitFor(() => {
      expect(mocks.runtime?.deliverDelegationNotification).toHaveBeenCalledTimes(2);
      expect(mocks.store.markDelivered).toHaveBeenCalledWith(
        record.delegationId,
        record.notificationId,
      );
      expect(mocks.store.markDelivered).toHaveBeenCalledWith(
        record.delegationId,
        secondRecord.notificationId,
      );
    });
    expect(mocks.timelineEmit).toHaveBeenCalledWith(
      origin.sessionName,
      AGENT_DELEGATION_REPLY_TIMELINE_EVENT,
      expect.objectContaining({ result: record.result }),
      expect.objectContaining({ eventId: `delegation-reply:${record.notificationId}` }),
    );
    expect(mocks.timelineEmit).toHaveBeenCalledWith(
      origin.sessionName,
      AGENT_DELEGATION_REPLY_TIMELINE_EVENT,
      expect.objectContaining({ result: secondRecord.result }),
      expect.objectContaining({ eventId: `delegation-reply:${secondRecord.notificationId}` }),
    );
  });

  it('restores a missing origin runtime without changing the bound identities', async () => {
    mocks.runtime = undefined;
    mocks.restoredRuntime = {
      deliverDelegationNotification: vi.fn(async () => AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED),
    };

    await expect(submitDelegationReply({
      rawBody: envelope,
      senderSessionName: target.sessionName,
    })).resolves.toEqual({
      ok: true,
      delivered: false,
      pending: true,
      reason: AGENT_DELEGATION_REPLY_ERRORS.DELIVERY_PENDING,
    });

    await vi.waitFor(() => {
      expect(ensureTransportRuntimeAvailable).toHaveBeenCalledWith(origin.sessionName);
      expect(mocks.restoredRuntime?.deliverDelegationNotification).toHaveBeenCalledOnce();
      expect(mocks.store.markDelivered).toHaveBeenCalledOnce();
    });
  });

  it('acknowledges durable receipt without waiting for a wedged provider notification', async () => {
    mocks.runtime = {
      deliverDelegationNotification: vi.fn(() => new Promise(() => {})),
    };

    const outcome = await Promise.race([
      submitDelegationReply({
        rawBody: envelope,
        senderSessionName: target.sessionName,
      }),
      new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 100)),
    ]);

    expect(outcome).toEqual({
      ok: true,
      delivered: false,
      pending: true,
      reason: AGENT_DELEGATION_REPLY_ERRORS.DELIVERY_PENDING,
    });
    expect(mocks.runtime.deliverDelegationNotification).toHaveBeenCalledOnce();
    expect(mocks.store.markDelivered).not.toHaveBeenCalled();
    expect(mocks.timelineEmit).toHaveBeenCalledWith(
      origin.sessionName,
      AGENT_DELEGATION_REPLY_TIMELINE_EVENT,
      expect.objectContaining({ result: record.result }),
      expect.objectContaining({ eventId: `delegation-reply:${record.notificationId}` }),
    );
  });

  it('keeps the reply pending when a busy provider cannot accept native notification', async () => {
    mocks.runtime = {
      deliverDelegationNotification: vi.fn(async () => AGENT_DELEGATION_NOTIFICATION_RESULTS.UNSUPPORTED),
    };

    await expect(submitDelegationReply({
      rawBody: envelope,
      senderSessionName: target.sessionName,
    })).resolves.toEqual({
      ok: true,
      delivered: false,
      pending: true,
      reason: AGENT_DELEGATION_REPLY_ERRORS.DELIVERY_PENDING,
    });

    await vi.waitFor(() => {
      expect(mocks.runtime?.deliverDelegationNotification).toHaveBeenCalledOnce();
    });
    expect(mocks.store.markDelivered).not.toHaveBeenCalled();
    expect(mocks.timelineEmit).toHaveBeenCalledWith(
      origin.sessionName,
      AGENT_DELEGATION_REPLY_TIMELINE_EVENT,
      expect.objectContaining({ result: record.result }),
      expect.objectContaining({ eventId: `delegation-reply:${record.notificationId}` }),
    );
  });

  it('keeps the durable receipt pending when native notification admission throws', async () => {
    mocks.runtime = {
      deliverDelegationNotification: vi.fn(async () => {
        throw new Error('active turn changed');
      }),
    };

    await expect(submitDelegationReply({
      rawBody: envelope,
      senderSessionName: target.sessionName,
    })).resolves.toEqual({
      ok: true,
      delivered: false,
      pending: true,
      reason: AGENT_DELEGATION_REPLY_ERRORS.DELIVERY_PENDING,
    });

    await vi.waitFor(() => {
      expect(mocks.runtime?.deliverDelegationNotification).toHaveBeenCalledOnce();
    });
    expect(mocks.store.markDelivered).not.toHaveBeenCalled();
  });

  it('expires instead of notifying a same-name recreated origin or target', async () => {
    mocks.sessions.set(origin.sessionName, {
      ...session(origin),
      sessionInstanceId: 'recreated-origin',
    });

    await expect(submitDelegationReply({
      rawBody: envelope,
      senderSessionName: target.sessionName,
    })).resolves.toEqual({ ok: false, error: 'identity_mismatch' });

    expect(mocks.store.expire).toHaveBeenCalledWith(record.delegationId);
    expect(mocks.runtime?.deliverDelegationNotification).not.toHaveBeenCalled();
    expect(mocks.store.markDelivered).not.toHaveBeenCalled();
  });

  // R3 P1 (cross-vendor auditor): a durable TASK-BOUND return must be bound to
  // taskId + the original coordinator assignment + the exact persistent origin
  // target. Two holes: (a) a same-name origin replacement EXPIRED the record, so
  // B's mere existence destroyed A's pending reply; (b) after the identity gate,
  // the runtime was fetched by NAME (getTransportRuntime(record.origin.sessionName))
  // with no identity re-verification, so the notification could still be projected
  // onto a reusable session name.
  describe('durable task-return authority is bound to the original coordinator', () => {
    const taskBound = {
      ...record,
      taskId: 'tsk_5oc',
      assignmentId: 'asg_5of',
      coordinatorAssignmentId: 'asg_5od',
    };

    it('does NOT destroy a task-bound pending reply when a same-name replacement appears', async () => {
      mocks.store.receive.mockReturnValue({ ok: true, record: taskBound, replay: false });
      // B: same session NAME, rotated instance/epoch.
      mocks.sessions.set(origin.sessionName, {
        ...session(origin),
        sessionInstanceId: 'replacement-instance',
        runtimeEpoch: 'replacement-epoch',
      });

      const result = await submitDelegationReply({
        rawBody: envelope,
        senderSessionName: target.sessionName,
      });

      expect(
        mocks.store.expire,
        "A's pending reply must survive B; expiring it loses the return permanently",
      ).not.toHaveBeenCalled();
      expect(mocks.runtime?.deliverDelegationNotification, 'B must get no provider notification').not.toHaveBeenCalled();
      expect(mocks.store.markDelivered).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: true, delivered: false, pending: true });
    });

    it('does not emit any timeline projection to a same-name replacement', async () => {
      mocks.store.receive.mockReturnValue({ ok: true, record: taskBound, replay: false });
      mocks.sessions.set(origin.sessionName, {
        ...session(origin),
        sessionInstanceId: 'replacement-instance',
        runtimeEpoch: 'replacement-epoch',
      });

      await submitDelegationReply({ rawBody: envelope, senderSessionName: target.sessionName });

      const toReplacement = mocks.timelineEmit.mock.calls.filter((call) => call[0] === origin.sessionName);
      expect(toReplacement, 'B must receive neither timeline nor provider notification').toEqual([]);
    });

    it('refuses to deliver through a live runtime whose identity is not the bound origin', async () => {
      mocks.store.receive.mockReturnValue({ ok: true, record: taskBound, replay: false });
      // The session RECORD still matches A, but the runtime registered under that
      // name belongs to a different instance. A name lookup would hand A's reply
      // to it.
      mocks.runtime = {
        recipientIdentity: { sessionInstanceId: 'replacement-instance', runtimeEpoch: 'replacement-epoch' },
        deliverDelegationNotification: vi.fn(async () => AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED),
      };

      const result = await submitDelegationReply({
        rawBody: envelope,
        senderSessionName: target.sessionName,
      });

      expect(mocks.runtime.deliverDelegationNotification).not.toHaveBeenCalled();
      expect(mocks.store.markDelivered).not.toHaveBeenCalled();
      expect(mocks.store.expire).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: true, delivered: false, pending: true });
    });

    it('validates origin for a taskId-only record instead of skipping it', async () => {
      // The removed skip keyed on taskId ALONE. A record carrying taskId but no
      // assignmentId is not a bound task return, so a rotated origin must still
      // fail closed rather than sail past validation.
      mocks.store.receive.mockReturnValue({
        ok: true,
        record: { ...record, taskId: 'tsk_5oc' },
        replay: false,
      });
      mocks.sessions.set(origin.sessionName, {
        ...session(origin),
        sessionInstanceId: 'replacement-instance',
        runtimeEpoch: 'replacement-epoch',
      });

      await expect(submitDelegationReply({
        rawBody: envelope,
        senderSessionName: target.sessionName,
      })).resolves.toEqual({ ok: false, error: 'identity_mismatch' });
      expect(mocks.runtime?.deliverDelegationNotification).not.toHaveBeenCalled();
      expect(mocks.timelineEmit.mock.calls.filter((c) => c[0] === origin.sessionName)).toEqual([]);
    });

    it('still delivers to the exact bound origin runtime (positive control)', async () => {
      mocks.store.receive.mockReturnValue({ ok: true, record: taskBound, replay: false });
      mocks.runtime = {
        recipientIdentity: { sessionInstanceId: origin.sessionInstanceId, runtimeEpoch: origin.runtimeEpoch },
        deliverDelegationNotification: vi.fn(async () => AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED),
      };

      const result = await submitDelegationReply({
        rawBody: envelope,
        senderSessionName: target.sessionName,
      });

      expect(mocks.runtime.deliverDelegationNotification).toHaveBeenCalled();
      expect(result).toMatchObject({ ok: true });
    });
  });

  it('rejects a sender whose live logical identity does not match the authority target', async () => {
    mocks.store.receive.mockReturnValue({ ok: false, reason: 'identity' });

    await expect(submitDelegationReply({
      rawBody: envelope,
      senderSessionName: target.sessionName,
    })).resolves.toEqual({ ok: false, error: 'identity_mismatch' });

    expect(mocks.runtime?.deliverDelegationNotification).not.toHaveBeenCalled();
    expect(mocks.store.markDelivered).not.toHaveBeenCalled();
  });
});

// The advance function's BODY had no direct coverage: the wiring test mocks it
// out entirely. These exercise it against the mocked store so its authority
// tuple, its skip-on-refusal behaviour and its delivery scheduling are real.
describe('advancePendingRepliesForReboundCoordinator', () => {
  const rotated = { sessionName: origin.sessionName, sessionInstanceId: 'origin-2', runtimeEpoch: 'epoch-2' };
  const owned = {
    ...record, taskId: 'tsk_5oc', assignmentId: 'asg_worker',
    coordinatorAssignmentId: 'asg_coord', status: 'received' as const,
  };

  it('rebinds each owned return with the exact authority tuple', () => {
    mocks.store.listPendingByCoordinator = vi.fn(() => [owned]);
    mocks.store.rebindAuthorizedOrigin = vi.fn(() => ({ ...owned, origin: rotated }));

    const advanced = advancePendingRepliesForReboundCoordinator({
      taskId: 'tsk_5oc', coordinatorAssignmentId: 'asg_coord', origin: rotated,
    });

    expect(advanced).toBe(1);
    expect(mocks.store.rebindAuthorizedOrigin).toHaveBeenCalledWith({
      delegationId: owned.delegationId,
      taskId: 'tsk_5oc',
      assignmentId: 'asg_worker',
      coordinatorAssignmentId: 'asg_coord',
      origin: rotated,
    });
  });

  it('skips a record the store refuses to rebind instead of force-advancing it', () => {
    mocks.store.listPendingByCoordinator = vi.fn(() => [owned]);
    mocks.store.rebindAuthorizedOrigin = vi.fn(() => undefined); // unauthorized
    expect(advancePendingRepliesForReboundCoordinator({
      taskId: 'tsk_5oc', coordinatorAssignmentId: 'asg_coord', origin: rotated,
    })).toBe(0);
  });

  it('skips a record carrying no worker/auditor assignment', () => {
    mocks.store.listPendingByCoordinator = vi.fn(() => [{ ...owned, assignmentId: undefined }]);
    const rebind = vi.fn(() => ({ ...owned, origin: rotated }));
    mocks.store.rebindAuthorizedOrigin = rebind;
    expect(advancePendingRepliesForReboundCoordinator({
      taskId: 'tsk_5oc', coordinatorAssignmentId: 'asg_coord', origin: rotated,
    })).toBe(0);
    expect(rebind).not.toHaveBeenCalled();
  });

  it('advances nothing when the coordinator owns no returns', () => {
    mocks.store.listPendingByCoordinator = vi.fn(() => []);
    expect(advancePendingRepliesForReboundCoordinator({
      taskId: 'tsk_5oc', coordinatorAssignmentId: 'asg_coord', origin: rotated,
    })).toBe(0);
  });
});
