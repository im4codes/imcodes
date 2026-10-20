import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../src/store/session-store.js';

const mocks = vi.hoisted(() => ({
  runtimeSend: vi.fn((): 'sent' | 'queued' => 'sent'),
  appendExternal: vi.fn(async (): Promise<string> => 'sent'),
  clearPendingMessages: vi.fn(() => []),
  processSend: vi.fn(async () => undefined),
  stopSessionNow: vi.fn(() => true),
  runtime: { current: undefined as undefined | Record<string, unknown> },
}));

vi.mock('../../src/daemon/command-handler.js', () => ({
  clearTransportConversation: vi.fn(async () => undefined),
  supportsTransportClear: () => true,
  switchSessionModelNow: vi.fn(async () => ({ ok: true })),
  sendProcessSessionMessageForAutomation: mocks.processSend,
  stopSessionNow: mocks.stopSessionNow,
}));

vi.mock('../../src/agent/session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTransportRuntime: () => mocks.runtime.current,
}));

const { dispatchSessionMessage } = await import('../../src/daemon/session-dispatch.js');
const { CHAT_MESSAGE_ORIGINS } = await import('../../shared/chat-message-origin.js');
const { clearAllResend } = await import('../../src/daemon/transport-resend-queue.js');
const { resetTransportQueueStoreForTests } = await import('../../src/daemon/transport-queue-store.js');

const transport = (patch: Partial<SessionRecord> = {}): SessionRecord => ({
  name: 'deck_sub_emgrx', projectName: 'proj', projectDir: '/repo', role: 'w1', agentType: 'claude-code-sdk',
  runtimeType: 'transport', state: 'idle', sessionInstanceId: 'instance-emgrx', runtimeEpoch: 'epoch-emgrx',
  restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1, ...patch,
} as SessionRecord);

const processAgent = (patch: Partial<SessionRecord> = {}): SessionRecord => transport({
  name: 'deck_sub_emgproc', agentType: 'codex', runtimeType: 'process', state: 'idle', ...patch,
});

const AGENT = { messageOrigin: CHAT_MESSAGE_ORIGINS.AGENT };

describe('session dispatch emergency mode', () => {
  beforeEach(() => {
    resetTransportQueueStoreForTests();
    clearAllResend();
    mocks.runtimeSend.mockReset().mockReturnValue('sent');
    mocks.appendExternal.mockReset().mockResolvedValue('sent');
    mocks.clearPendingMessages.mockReset().mockReturnValue([]);
    mocks.processSend.mockClear();
    mocks.stopSessionNow.mockClear();
    mocks.runtime.current = {
      providerSessionId: 'provider-1',
      send: mocks.runtimeSend,
      appendExternalMessageToActiveTurn: mocks.appendExternal,
      clearPendingMessages: mocks.clearPendingMessages,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearAllResend();
  });

  describe('transport session', () => {
    it('clears pending messages, stops active turn, and places emergency send at front when appendExternal returns unsupported and emergency is true', async () => {
      mocks.appendExternal.mockResolvedValue('unsupported');
      mocks.runtimeSend.mockReturnValue('sent');
      const cancelSessionMock = vi.fn().mockResolvedValue(true);

      const target = transport();
      const res = await dispatchSessionMessage(target, 'emergency redirect', {
        messageId: 'send_message_emg1',
        ...AGENT,
        emergency: true,
        cancelSession: cancelSessionMock,
      } as never);

      expect(mocks.clearPendingMessages).toHaveBeenCalledWith('user_stopped');
      expect(cancelSessionMock).toHaveBeenCalledWith(target);
      expect(mocks.runtimeSend).toHaveBeenCalledWith(
        'emergency redirect',
        'send_message_emg1',
        undefined,
        undefined,
        expect.objectContaining({ deliveryMode: 'append', queuePlacement: 'front', emergency: true }),
      );
      expect(res).toBe('sent');
    });

    it('falls back to stopSessionNow when cancelSession is not provided', async () => {
      mocks.appendExternal.mockResolvedValue('unsupported');
      mocks.runtimeSend.mockReturnValue('sent');

      const target = transport();
      await dispatchSessionMessage(target, 'emergency redirect', {
        messageId: 'send_message_emg2',
        ...AGENT,
        emergency: true,
      } as never);

      expect(mocks.clearPendingMessages).toHaveBeenCalledWith('user_stopped');
      expect(mocks.stopSessionNow).toHaveBeenCalledWith('deck_sub_emgrx');
      expect(mocks.runtimeSend).toHaveBeenCalled();
    });

    it('stops active turn and places send at front when appendExternal returns unsupported on append deliveryMode', async () => {
      mocks.appendExternal.mockResolvedValue('unsupported');
      mocks.runtimeSend.mockReturnValue('sent');
      const cancelSessionMock = vi.fn().mockResolvedValue(true);

      const target = transport();
      const res = await dispatchSessionMessage(target, 'ordinary append message', {
        messageId: 'send_message_emg3',
        ...AGENT,
        cancelSession: cancelSessionMock,
      } as never);

      expect(mocks.clearPendingMessages).toHaveBeenCalledWith('user_stopped');
      expect(cancelSessionMock).toHaveBeenCalledWith(target);
      expect(mocks.runtimeSend).toHaveBeenCalledWith(
        'ordinary append message',
        'send_message_emg3',
        undefined,
        undefined,
        expect.objectContaining({ deliveryMode: 'append', queuePlacement: 'front', emergency: true }),
      );
      expect(res).toBe('sent');
    });

    it('does NOT stop session when deliveryMode is explicitly queue', async () => {
      mocks.runtimeSend.mockReturnValue('queued');
      const cancelSessionMock = vi.fn().mockResolvedValue(true);

      const target = transport();
      const res = await dispatchSessionMessage(target, 'queued message', {
        messageId: 'send_message_queue',
        ...AGENT,
        deliveryMode: 'queue',
        cancelSession: cancelSessionMock,
      } as never);

      expect(cancelSessionMock).not.toHaveBeenCalled();
      expect(mocks.stopSessionNow).not.toHaveBeenCalled();
      expect(res).toBe('queued');
    });

    it('does NOT stop session when emergency is true but target is idle (appendExternal returns sent)', async () => {
      mocks.appendExternal.mockResolvedValue('sent');
      const cancelSessionMock = vi.fn().mockResolvedValue(true);

      const target = transport();
      const res = await dispatchSessionMessage(target, 'idle emergency message', {
        messageId: 'send_message_emg4',
        ...AGENT,
        emergency: true,
        cancelSession: cancelSessionMock,
      } as never);

      expect(cancelSessionMock).not.toHaveBeenCalled();
      expect(mocks.stopSessionNow).not.toHaveBeenCalled();
      expect(mocks.runtimeSend).not.toHaveBeenCalled(); // handled by appendExternal idle send directly
      expect(res).toBe('sent');
    });

    it('does NOT stop session when emergency is true and provider supports native append (appendExternal returns appended)', async () => {
      mocks.appendExternal.mockResolvedValue('appended');
      const cancelSessionMock = vi.fn().mockResolvedValue(true);

      const target = transport();
      const res = await dispatchSessionMessage(target, 'steer in-flight', {
        messageId: 'send_message_emg5',
        ...AGENT,
        emergency: true,
        cancelSession: cancelSessionMock,
      } as never);

      expect(cancelSessionMock).not.toHaveBeenCalled();
      expect(mocks.stopSessionNow).not.toHaveBeenCalled();
      expect(mocks.runtimeSend).not.toHaveBeenCalled(); // successfully appended into active turn
      expect(res).toBe('sent');
    });
  });

  describe('process session', () => {
    it('stops process session when state is running and emergency is true', async () => {
      const cancelSessionMock = vi.fn().mockResolvedValue(true);
      const target = processAgent({ state: 'running' });

      await dispatchSessionMessage(target, 'urgent stop and redirect', {
        messageId: 'send_message_emg6',
        ...AGENT,
        emergency: true,
        cancelSession: cancelSessionMock,
      } as never);

      expect(cancelSessionMock).toHaveBeenCalledWith(target);
      expect(mocks.processSend).toHaveBeenCalledWith(
        'deck_sub_emgproc',
        'urgent stop and redirect',
        expect.anything(),
      );
    });

    it('does NOT stop process session when state is idle and emergency is true', async () => {
      const cancelSessionMock = vi.fn().mockResolvedValue(true);
      const target = processAgent({ state: 'idle' });

      await dispatchSessionMessage(target, 'message for idle process', {
        messageId: 'send_message_emg7',
        ...AGENT,
        emergency: true,
        cancelSession: cancelSessionMock,
      } as never);

      expect(cancelSessionMock).not.toHaveBeenCalled();
      expect(mocks.stopSessionNow).not.toHaveBeenCalled();
      expect(mocks.processSend).toHaveBeenCalledWith(
        'deck_sub_emgproc',
        'message for idle process',
        expect.anything(),
      );
    });

    it('stops running process session when deliveryMode is append even when emergency is omitted', async () => {
      const cancelSessionMock = vi.fn().mockResolvedValue(true);
      const target = processAgent({ state: 'running' });

      await dispatchSessionMessage(target, 'append message', {
        messageId: 'send_message_emg8',
        ...AGENT,
        cancelSession: cancelSessionMock,
      } as never);

      expect(cancelSessionMock).toHaveBeenCalledWith(target);
      expect(mocks.processSend).toHaveBeenCalledWith(
        'deck_sub_emgproc',
        'append message',
        expect.anything(),
      );
    });

    it('does NOT stop running process session when deliveryMode is explicitly queue', async () => {
      const cancelSessionMock = vi.fn().mockResolvedValue(true);
      const target = processAgent({ state: 'running' });

      await dispatchSessionMessage(target, 'queued message', {
        messageId: 'send_message_emg9',
        ...AGENT,
        deliveryMode: 'queue',
        cancelSession: cancelSessionMock,
      } as never);

      expect(cancelSessionMock).not.toHaveBeenCalled();
      expect(mocks.stopSessionNow).not.toHaveBeenCalled();
      expect(mocks.processSend).toHaveBeenCalled();
    });
  });
});
