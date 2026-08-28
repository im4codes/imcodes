import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_DELEGATION_COMPLETION_NOTIFICATION_MARKER,
  AGENT_DELEGATION_NOTIFICATION_RESULTS,
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
    receive: vi.fn(),
    markDelivered: vi.fn(),
    expire: vi.fn(),
    get: vi.fn(),
    getMessage: vi.fn(),
    listReceived: vi.fn(() => []),
  },
  timelineEmit: vi.fn(),
  applyMatchingAuditReceipt: vi.fn(),
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
    applyMatchingAuditReceipt: mocks.applyMatchingAuditReceipt,
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
  replyCapability: 'reply_capability_1234567890_ABCDEFG',
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
    mocks.applyMatchingAuditReceipt.mockReset().mockReturnValue({ ok: true, value: {} });
    vi.mocked(ensureTransportRuntimeAvailable).mockClear();
  });

  afterEach(() => {
    clearDelegationReplyIngressForTests();
  });

  it('binds the sender and delivers one trusted notification before consuming the capability', async () => {
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
      replyCapability: envelope.replyCapability,
      sender: target,
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

  it('accepts the structured peer-audit envelope through the capability minted by send_message', async () => {
    const auditRecord = {
      ...record,
      purpose: 'supervision_audit' as const,
      auditAttemptId: 'attempt_manual_audit_1',
      auditRevision: 'revision-manual-1',
      auditedSessionName: origin.sessionName,
    };
    mocks.store.matchPendingAuditAuthority.mockReturnValue(auditRecord);
    mocks.store.receive.mockImplementation((input: { result: string }) => ({
      ok: true,
      record: { ...auditRecord, result: input.result },
      replay: false,
    }));
    registerPeerAuditReplyIngressHandler(() => ({ ok: false, error: 'invalid_capability' }));

    await expect(submitPeerAuditReply({
      rawBody: JSON.stringify({
        version: PEER_AUDIT_REPLY_VERSION,
        attemptId: auditRecord.auditAttemptId,
        replyCapability: envelope.replyCapability,
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
      auditAttemptId: auditRecord.auditAttemptId,
      replyCapability: envelope.replyCapability,
      sender: target,
      now: 100,
    });
    expect(mocks.store.receive).toHaveBeenCalledWith(expect.objectContaining({
      delegationId: auditRecord.delegationId,
      replyCapability: envelope.replyCapability,
      sender: target,
      result: expect.stringContaining('"verdict":"PASS"'),
    }));
    expect(mocks.applyMatchingAuditReceipt).toHaveBeenCalledWith({
      attemptId: auditRecord.auditAttemptId,
      revision: auditRecord.auditRevision,
      verdict: 'PASS',
      auditedSessionName: origin.sessionName,
      auditorSessionName: target.sessionName,
      findings: 'Exact revision and focused validation pass.',
      now: 100,
    });
    expect(mocks.timelineEmit).toHaveBeenCalledWith(
      origin.sessionName,
      AGENT_DELEGATION_REPLY_TIMELINE_EVENT,
      expect.objectContaining({ result: expect.stringContaining('"attemptId":"attempt_manual_audit_1"') }),
      expect.any(Object),
    );
  });

  it('rejects a delegated audit receipt that contradicts the authoritative task revision', async () => {
    const auditRecord = {
      ...record,
      purpose: 'supervision_audit' as const,
      auditAttemptId: 'attempt_manual_audit_stale',
      auditRevision: 'revision-current',
      auditedSessionName: origin.sessionName,
    };
    mocks.store.matchPendingAuditAuthority.mockReturnValue(auditRecord);
    mocks.applyMatchingAuditReceipt.mockReturnValue({ ok: false, reason: 'old_revision' });
    registerPeerAuditReplyIngressHandler(() => ({ ok: false, error: 'invalid_capability' }));

    await expect(submitPeerAuditReply({
      rawBody: JSON.stringify({
        version: PEER_AUDIT_REPLY_VERSION,
        attemptId: auditRecord.auditAttemptId,
        replyCapability: envelope.replyCapability,
        verdict: 'PASS',
        findings: 'Stale evidence must not be delivered.',
        validations: [{
          kind: 'test', label: 'focused', outcome: 'passed', summary: 'focused pass',
        }],
      }),
      senderSessionName: target.sessionName,
      now: 100,
    })).resolves.toEqual({ ok: false, error: 'invalid_capability' });

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

  it('keeps the capability unconsumed when native notification admission throws', async () => {
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

  it('rejects a sender whose live logical identity does not match the capability target', async () => {
    mocks.store.receive.mockReturnValue({ ok: false, reason: 'identity' });

    await expect(submitDelegationReply({
      rawBody: envelope,
      senderSessionName: target.sessionName,
    })).resolves.toEqual({ ok: false, error: 'identity_mismatch' });

    expect(mocks.runtime?.deliverDelegationNotification).not.toHaveBeenCalled();
    expect(mocks.store.markDelivered).not.toHaveBeenCalled();
  });
});
