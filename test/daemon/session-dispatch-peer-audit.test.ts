import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../src/store/session-store.js';

const sendMock = vi.fn();
const removeMock = vi.fn();
const processSendMock = vi.fn();
const injectPrivateMock = vi.fn();
const getSessionMock = vi.fn();

vi.mock('../../src/agent/session-manager.js', () => ({
  getTransportRuntime: vi.fn(() => ({
    send: sendMock,
    removePendingMessage: removeMock,
  })),
}));

vi.mock('../../src/daemon/command-handler.js', () => ({
  sendProcessSessionMessageForAutomation: (...args: unknown[]) => processSendMock(...args),
  runWithProcessSessionSendLock: async (_name: string, fn: () => Promise<unknown>) => fn(),
  prepareProcessSessionPrivateWriter: async () => (text: string) => injectPrivateMock(text),
}));

vi.mock('../../src/store/session-store.js', () => ({
  getSession: (...args: unknown[]) => getSessionMock(...args),
}));

vi.mock('../../src/daemon/transport-queue-projection.js', () => ({
  buildTransportQueueSnapshotPayload: vi.fn(() => ({ queueEpoch: 'queue_epoch_1' })),
}));

const { cancelQueuedPeerAuditMessage, dispatchPeerAuditMessage, dispatchSessionMessage } = await import('../../src/daemon/session-dispatch.js');

function target(patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: 'deck_sub_audit123',
    sessionInstanceId: 'instance_audit123',
    runtimeEpoch: 'runtime_audit123',
    projectName: 'p',
    projectDir: '/repo',
    role: 'w1',
    parentSession: 'deck_p_brain',
    agentType: 'codex-sdk',
    runtimeType: 'transport',
    providerId: 'openai',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

describe('peer-audit dedicated dispatch', () => {
  beforeEach(() => {
    sendMock.mockReset();
    removeMock.mockReset();
    processSendMock.mockReset();
    injectPrivateMock.mockReset();
    getSessionMock.mockReset();
  });

  it.each(['sent', 'queued'] as const)('returns the exact transport %s disposition and private queue metadata', async (disposition) => {
    sendMock.mockReturnValue(disposition);
    const result = await dispatchPeerAuditMessage({ target: target(), brief: 'bounded brief', attemptId: 'attempt_1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.disposition).toBe(disposition);
    expect(result.receipt.queueEpoch).toBe(disposition === 'queued' ? 'queue_epoch_1' : undefined);
    expect(sendMock).toHaveBeenCalledWith(
      'bounded brief',
      expect.any(String),
      undefined,
      undefined,
      { peerAudit: { contractVersion: 'peer_audit_v1', attemptHash: expect.any(String) } },
    );
  });

  it('cancels only the exact queued message id', () => {
    removeMock.mockReturnValue(true);
    expect(cancelQueuedPeerAuditMessage('deck_sub_audit123', 'message_exact')).toBe(true);
    expect(removeMock).toHaveBeenCalledWith('message_exact');
  });

  it('injects idle process auditors privately and never through the ordinary automation send', async () => {
    const idle = target({ agentType: 'codex', runtimeType: 'process', state: 'idle' });
    getSessionMock.mockReturnValue(idle);

    await expect(dispatchPeerAuditMessage({ target: idle, brief: 'audit', attemptId: 'attempt_2' }))
      .resolves.toMatchObject({ ok: true, receipt: { disposition: 'sent_unrevocable' } });
    expect(injectPrivateMock).toHaveBeenCalledWith('audit');
    // The capability-bearing brief must not reach the timeline/history/memory path.
    expect(processSendMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('rejects a busy process auditor without injecting', async () => {
    const busy = target({ agentType: 'codex', runtimeType: 'process', state: 'running' });
    getSessionMock.mockReturnValue(busy);

    await expect(dispatchPeerAuditMessage({ target: busy, brief: 'audit', attemptId: 'attempt_3' }))
      .resolves.toEqual({ ok: false, error: 'target_runtime_busy_uncancellable' });
    expect(injectPrivateMock).not.toHaveBeenCalled();
    expect(processSendMock).not.toHaveBeenCalled();
  });

  it('sends nothing when the authoritative record diverges from the caller snapshot', async () => {
    // Caller snapshot is idle and correctly identified; the live record has
    // since been replaced (delete/recreate) and is busy.
    const snapshot = target({ agentType: 'codex', runtimeType: 'process', state: 'idle' });
    getSessionMock.mockReturnValue(target({
      agentType: 'codex',
      runtimeType: 'process',
      state: 'running',
      sessionInstanceId: 'instance_recreated',
    }));

    await expect(dispatchPeerAuditMessage({ target: snapshot, brief: 'audit', attemptId: 'attempt_4' }))
      .resolves.toEqual({ ok: false, error: 'target_ineligible' });
    expect(injectPrivateMock).not.toHaveBeenCalled();
  });

  it('does not claim sent_unrevocable when the effect was cancelled before the write', async () => {
    const idle = target({ agentType: 'codex', runtimeType: 'process', state: 'idle' });
    getSessionMock.mockReturnValue(idle);

    await expect(dispatchPeerAuditMessage({
      target: idle,
      brief: 'audit',
      attemptId: 'attempt_5',
      isEffectCurrent: () => false,
    })).resolves.toEqual({ ok: false, error: 'attempt_not_found' });
    expect(injectPrivateMock).not.toHaveBeenCalled();
    expect(processSendMock).not.toHaveBeenCalled();
  });

  it('keeps ordinary manual dispatch on the inferred transport path for legacy records', async () => {
    sendMock.mockReturnValue('sent');
    const legacyTransport = target({ runtimeType: undefined, agentType: 'codex-sdk' });
    await expect(dispatchSessionMessage(legacyTransport, 'ordinary delegation', {
      messageId: 'send_message_12345678' as never,
    })).resolves.toBe('sent');
    expect(sendMock).toHaveBeenCalledWith('ordinary delegation', 'send_message_12345678');
    expect(processSendMock).not.toHaveBeenCalled();
  });
});
