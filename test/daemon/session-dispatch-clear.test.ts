import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../src/store/session-store.js';

/**
 * `/clear` sent by another session (imcodes send / send_message / cron /
 * supervision) reached the model as ordinary text: the delivery path called
 * runtime.send directly and never saw the daemon-managed command, so a Codex
 * session kept its 214k-token context after being "cleared".
 */

const mocks = vi.hoisted(() => ({
  clearTransportConversation: vi.fn(async () => undefined),
  supportsTransportClear: vi.fn((agentType: string | undefined) => agentType === 'codex-sdk'),
  switchSessionModelNow: vi.fn(async () => ({ ok: true })),
  runtimeSend: vi.fn(() => 'sent' as const),
}));

vi.mock('../../src/daemon/command-handler.js', () => ({
  clearTransportConversation: mocks.clearTransportConversation,
  supportsTransportClear: mocks.supportsTransportClear,
  switchSessionModelNow: mocks.switchSessionModelNow,
  sendProcessSessionMessageForAutomation: vi.fn(),
}));

vi.mock('../../src/agent/session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTransportRuntime: () => ({ providerSessionId: 'provider-1', send: mocks.runtimeSend }),
}));

function transportSession(patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: 'deck_sub_cx8',
    projectName: 'proj',
    projectDir: '/repo',
    role: 'w1',
    agentType: 'codex-sdk',
    runtimeType: 'transport',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  } as SessionRecord;
}

describe('daemon-side delivery of /clear', () => {
  beforeEach(() => {
    mocks.clearTransportConversation.mockClear();
    mocks.runtimeSend.mockClear();
  });

  it('starts a fresh conversation instead of sending "/clear" to the model', async () => {
    const { dispatchSessionMessage } = await import('../../src/daemon/session-dispatch.js');
    const target = transportSession();
    const result = await dispatchSessionMessage(target, ' /clear ', { messageId: 'send_message_1', suppressTimeline: true } as never);
    expect(result).toBe('sent');
    expect(mocks.clearTransportConversation).toHaveBeenCalledWith(target);
    expect(mocks.runtimeSend).not.toHaveBeenCalled();
  });

  it('still delivers ordinary text, and /clear to agents without a fresh-conversation relaunch', async () => {
    const { dispatchSessionMessage } = await import('../../src/daemon/session-dispatch.js');
    await dispatchSessionMessage(transportSession(), 'please /clear the cache dir', { messageId: 'send_message_2', suppressTimeline: true } as never);
    await dispatchSessionMessage(transportSession({ agentType: 'some-other-sdk' as never }), '/clear', { messageId: 'send_message_3', suppressTimeline: true } as never);
    expect(mocks.clearTransportConversation).not.toHaveBeenCalled();
    expect(mocks.runtimeSend).toHaveBeenCalledTimes(2);
  });

  it('switches the model for a /model sent by another session', async () => {
    const { dispatchSessionMessage } = await import('../../src/daemon/session-dispatch.js');
    await dispatchSessionMessage(transportSession(), '/model gpt-5.6-sol', { messageId: 'send_message_4', suppressTimeline: true } as never);
    expect(mocks.switchSessionModelNow).toHaveBeenCalledWith('deck_sub_cx8', 'gpt-5.6-sol');
    expect(mocks.runtimeSend).not.toHaveBeenCalled();
  });

  it('delivers control commands verbatim instead of wrapping them in a sender header', async () => {
    const { buildSessionDispatchMessage } = await import('../../src/daemon/session-dispatch.js');
    const wrap = { from: 'deck_proj_brain', fromLabel: 'Brain', replyTo: 'deck_proj_brain', contextTail: 'earlier talk' };
    expect(buildSessionDispatchMessage(' /clear ', wrap)).toBe('/clear');
    expect(buildSessionDispatchMessage('/compact', wrap)).toBe('/compact');
    expect(buildSessionDispatchMessage('/model gpt-5.6-sol', wrap)).toBe('/model gpt-5.6-sol');
    // Ordinary text and /stop keep the envelope (stop has its own priority path).
    expect(buildSessionDispatchMessage('please /clear the cache', wrap)).toContain('deck_proj_brain');
    expect(buildSessionDispatchMessage('/stop', wrap)).not.toBe('/stop');
  });
});
