import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_DELEGATION_COMPLETION_NOTIFICATION_MARKER,
  AGENT_DELEGATION_NOTIFICATION_RESULTS,
  AGENT_DELEGATION_REPLY_TIMELINE_EVENT,
  AGENT_DELEGATION_REPLY_VERSION,
} from '../../shared/agent-delegation.js';

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, Record<string, unknown>>(),
  runtime: undefined as undefined | {
    deliverDelegationNotification: ReturnType<typeof vi.fn>;
  },
  restoredRuntime: undefined as undefined | {
    deliverDelegationNotification: ReturnType<typeof vi.fn>;
  },
  store: {
    receive: vi.fn(),
    markDelivered: vi.fn(),
    expire: vi.fn(),
    get: vi.fn(),
    listReceived: vi.fn(() => []),
  },
  timelineEmit: vi.fn(),
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

import {
  clearDelegationReplyIngressForTests,
  submitDelegationReply,
} from '../../src/daemon/delegation-reply-ingress.js';
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
    mocks.sessions.clear();
    mocks.sessions.set(origin.sessionName, session(origin));
    mocks.sessions.set(target.sessionName, session(target));
    mocks.runtime = {
      deliverDelegationNotification: vi.fn(async () => AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED),
    };
    mocks.restoredRuntime = undefined;
    mocks.store.receive.mockReset().mockReturnValue({ ok: true, record, replay: false });
    mocks.store.markDelivered.mockReset().mockReturnValue(true);
    mocks.store.expire.mockReset();
    mocks.store.get.mockReset();
    mocks.store.listReceived.mockReset().mockReturnValue([]);
    mocks.timelineEmit.mockReset();
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
    })).resolves.toEqual({ ok: true, delivered: true });

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
    expect(mocks.store.markDelivered).toHaveBeenCalledWith(record.delegationId);
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
    expect(delivered).toHaveBeenCalledWith(expect.objectContaining({
      delegationId: record.delegationId,
      result: record.result,
    }));
    unsubscribe();
  });

  it('restores a missing origin runtime without changing the bound identities', async () => {
    mocks.runtime = undefined;
    mocks.restoredRuntime = {
      deliverDelegationNotification: vi.fn(async () => AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED),
    };

    await expect(submitDelegationReply({
      rawBody: envelope,
      senderSessionName: target.sessionName,
    })).resolves.toEqual({ ok: true, delivered: true });

    expect(ensureTransportRuntimeAvailable).toHaveBeenCalledWith(origin.sessionName);
    expect(mocks.restoredRuntime.deliverDelegationNotification).toHaveBeenCalledOnce();
    expect(mocks.store.markDelivered).toHaveBeenCalledOnce();
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
      reason: 'active_notification_unsupported',
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
      reason: 'runtime_stale',
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
