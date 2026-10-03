import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../src/store/session-store.js';

/**
 * `dispatchSessionMessage` with `command: true`: every runtime-neutral delivery
 * route hands the target the command marker together with the exact text, and
 * an ordinary dispatch never does (counterexample).
 */

const mocks = vi.hoisted(() => ({
  runtimeSend: vi.fn((): 'sent' | 'queued' => 'sent'),
  appendExternal: vi.fn(async (): Promise<string> => 'sent'),
  processSend: vi.fn(async () => undefined),
  runtime: { current: undefined as undefined | Record<string, unknown> },
}));

vi.mock('../../src/daemon/command-handler.js', () => ({
  clearTransportConversation: vi.fn(async () => undefined),
  supportsTransportClear: () => true,
  switchSessionModelNow: vi.fn(async () => ({ ok: true })),
  sendProcessSessionMessageForAutomation: mocks.processSend,
}));

vi.mock('../../src/agent/session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTransportRuntime: () => mocks.runtime.current,
}));

const { dispatchSessionMessage } = await import('../../src/daemon/session-dispatch.js');
const { CHAT_MESSAGE_ORIGINS } = await import('../../shared/chat-message-origin.js');
const { clearAllResend, getResendEntries } = await import('../../src/daemon/transport-resend-queue.js');
const { resetTransportQueueStoreForTests } = await import('../../src/daemon/transport-queue-store.js');

const transport = (patch: Partial<SessionRecord> = {}): SessionRecord => ({
  name: 'deck_sub_cmdrx', projectName: 'proj', projectDir: '/repo', role: 'w1', agentType: 'claude-code-sdk',
  runtimeType: 'transport', state: 'idle', sessionInstanceId: 'instance-cmdrx', runtimeEpoch: 'epoch-cmdrx',
  restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1, ...patch,
} as SessionRecord);
const processAgent = (): SessionRecord => transport({ name: 'deck_sub_cmdproc', agentType: 'codex', runtimeType: 'process' });

const AGENT = { messageOrigin: CHAT_MESSAGE_ORIGINS.AGENT };

describe('session dispatch command mode', () => {
  beforeEach(() => {
    resetTransportQueueStoreForTests();
    clearAllResend();
    mocks.runtimeSend.mockReset().mockReturnValue('sent');
    mocks.appendExternal.mockReset().mockResolvedValue('sent');
    mocks.processSend.mockClear();
    mocks.runtime.current = { providerSessionId: 'provider-1', send: mocks.runtimeSend, appendExternalMessageToActiveTurn: mocks.appendExternal };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearAllResend();
  });

  it('append: idle-start goes through appendExternalMessageToActiveTurn with the command marker', async () => {
    await dispatchSessionMessage(transport(), '/compact', { messageId: 'send_message_c1', ...AGENT, command: true } as never);
    expect(mocks.appendExternal).toHaveBeenCalledWith('/compact', 'send_message_c1', undefined, undefined, { commandMode: true });
  });

  it('counterexample: an ordinary append carries no command marker', async () => {
    await dispatchSessionMessage(transport(), 'plain', { messageId: 'send_message_c2', ...AGENT } as never);
    expect(mocks.appendExternal).toHaveBeenCalledWith('plain', 'send_message_c2');
  });

  it('append falling back to the FIFO keeps the marker on the queued copy', async () => {
    mocks.appendExternal.mockResolvedValue('unsupported');
    mocks.runtimeSend.mockReturnValue('queued');
    await expect(dispatchSessionMessage(transport(), 'raw', { messageId: 'send_message_c3', ...AGENT, command: true } as never)).resolves.toBe('queued');
    expect(mocks.runtimeSend).toHaveBeenCalledWith('raw', 'send_message_c3', undefined, undefined, { ...AGENT, commandMode: true });
  });

  it('explicit queue mode marks the runtime send', async () => {
    await dispatchSessionMessage(transport(), 'raw', { messageId: 'send_message_c4', deliveryMode: 'queue', ...AGENT, command: true } as never);
    expect(mocks.appendExternal).not.toHaveBeenCalled();
    expect(mocks.runtimeSend).toHaveBeenCalledWith('raw', 'send_message_c4', undefined, undefined, { ...AGENT, commandMode: true });
  });

  it('a runtime that is not bound yet queues the command durably with its marker', async () => {
    mocks.runtime.current = undefined;
    await expect(dispatchSessionMessage(transport(), 'raw', { messageId: 'send_message_c5', ...AGENT, command: true } as never)).resolves.toBe('queued');
    const entry = getResendEntries('deck_sub_cmdrx').find((candidate) => candidate.clientMessageId === 'send_message_c5');
    expect(entry).toMatchObject({ text: 'raw', commandMode: true });
  });

  it('counterexample: the unbound queued copy of an ordinary message has no marker', async () => {
    mocks.runtime.current = undefined;
    await dispatchSessionMessage(transport(), 'plain', { messageId: 'send_message_c6', ...AGENT } as never);
    expect(getResendEntries('deck_sub_cmdrx').find((candidate) => candidate.clientMessageId === 'send_message_c6')).not.toHaveProperty('commandMode');
  });

  it('durable daemon-owned queueing keeps the marker', async () => {
    await dispatchSessionMessage(transport(), 'raw', { messageId: 'send_message_c7', durableQueue: true, ...AGENT, command: true } as never).catch(() => undefined);
    expect(getResendEntries('deck_sub_cmdrx').find((candidate) => candidate.clientMessageId === 'send_message_c7')).toMatchObject({ commandMode: true });
  });

  it('a process target is delivered verbatim (no recall, path rewrite or preamble)', async () => {
    await dispatchSessionMessage(processAgent(), 'raw command', { messageId: 'send_message_c8', ...AGENT, command: true } as never);
    expect(mocks.processSend).toHaveBeenCalledWith('deck_sub_cmdproc', 'raw command', expect.objectContaining({ verbatim: true }));
  });

  it('counterexample: an ordinary process delivery is not verbatim', async () => {
    await dispatchSessionMessage(processAgent(), 'plain', { messageId: 'send_message_c9', ...AGENT } as never);
    expect(mocks.processSend).toHaveBeenCalledTimes(1);
    expect(mocks.processSend.mock.calls[0]![2]).not.toHaveProperty('verbatim');
  });
});
