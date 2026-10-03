import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../src/store/session-store.js';

/**
 * send_message deliveries are another session's words and task-pair nudges are
 * the daemon's; external chat bridges route through the same boundary with the
 * human's words. The origin travels on the row AND on every queued copy, so
 * the chat never renders a non-human message as the human's.
 */

const mocks = vi.hoisted(() => ({
  clearTransportConversation: vi.fn(async () => undefined),
  runtimeSend: vi.fn((): 'sent' | 'queued' => 'sent'),
  processSend: vi.fn(async () => undefined),
}));

vi.mock('../../src/daemon/command-handler.js', () => ({
  clearTransportConversation: mocks.clearTransportConversation,
  supportsTransportClear: () => true,
  switchSessionModelNow: vi.fn(async () => ({ ok: true })),
  sendProcessSessionMessageForAutomation: mocks.processSend,
}));

vi.mock('../../src/agent/session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTransportRuntime: () => ({ providerSessionId: 'provider-1', send: mocks.runtimeSend }),
}));

const { timelineEmitter } = await import('../../src/daemon/timeline-emitter.js');
const { dispatchSessionMessage } = await import('../../src/daemon/session-dispatch.js');
const { CHAT_MESSAGE_ORIGINS, USER_MESSAGE_ORIGIN_FIELDS, classifyUserMessageOrigin } = await import('../../shared/chat-message-origin.js');

function session(patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: 'deck_sub_originrx',
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

function userRow(emit: { mock: { calls: unknown[][] } }): Record<string, unknown> | undefined {
  return emit.mock.calls.find(([, type]) => type === 'user.message')?.[2] as Record<string, unknown> | undefined;
}

describe('session dispatch message origin', () => {
  beforeEach(() => {
    mocks.runtimeSend.mockReset();
    mocks.runtimeSend.mockReturnValue('sent');
    mocks.processSend.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    timelineEmitter.forgetSession('deck_sub_originrx');
  });

  it('stamps an agent delivery on its row and its runtime copy', async () => {
    const emit = vi.spyOn(timelineEmitter, 'emit');
    await dispatchSessionMessage(session(), 'please review', {
      messageId: 'send_message_o1', messageOrigin: CHAT_MESSAGE_ORIGINS.AGENT,
    } as never);
    expect(classifyUserMessageOrigin(userRow(emit))).toBe(CHAT_MESSAGE_ORIGINS.AGENT);
    expect(mocks.runtimeSend).toHaveBeenCalledWith('please review', 'send_message_o1', undefined, undefined,
      { messageOrigin: CHAT_MESSAGE_ORIGINS.AGENT });
  });

  it('keeps the origin on a queued copy, whose drain writes the row', async () => {
    mocks.runtimeSend.mockReturnValue('queued');
    const emit = vi.spyOn(timelineEmitter, 'emit');
    await dispatchSessionMessage(session(), 'pair nudge', {
      messageId: 'send_message_o2', messageOrigin: CHAT_MESSAGE_ORIGINS.SYSTEM,
    } as never);
    expect(userRow(emit)).toBeUndefined();
    expect(mocks.runtimeSend.mock.calls[0]?.[4]).toEqual({ messageOrigin: CHAT_MESSAGE_ORIGINS.SYSTEM });
  });

  it('stamps a control command another session sent, which carries no sender block', async () => {
    const emit = vi.spyOn(timelineEmitter, 'emit');
    await dispatchSessionMessage(session(), '/clear', {
      messageId: 'send_message_o3', messageOrigin: CHAT_MESSAGE_ORIGINS.AGENT,
    } as never);
    expect(userRow(emit)).toMatchObject({ text: '/clear', [USER_MESSAGE_ORIGIN_FIELDS.ORIGIN]: CHAT_MESSAGE_ORIGINS.AGENT });
  });

  it('stamps a process-session delivery through its user-message metadata', async () => {
    await dispatchSessionMessage(session({ runtimeType: 'process', agentType: 'claude-code' as never }), 'nudge', {
      messageId: 'send_message_o4', messageOrigin: CHAT_MESSAGE_ORIGINS.SYSTEM,
    } as never);
    expect(mocks.processSend).toHaveBeenCalledWith('deck_sub_originrx', 'nudge', {
      userMessageMetadata: { [USER_MESSAGE_ORIGIN_FIELDS.ORIGIN]: CHAT_MESSAGE_ORIGINS.SYSTEM },
    });
  });

  it('leaves human input from an external chat bridge unstamped', async () => {
    const emit = vi.spyOn(timelineEmitter, 'emit');
    await dispatchSessionMessage(session(), 'hi from telegram', { messageId: 'send_message_o5' } as never);
    expect(mocks.runtimeSend).toHaveBeenCalledWith('hi from telegram', 'send_message_o5');
    expect(classifyUserMessageOrigin(userRow(emit))).toBe(CHAT_MESSAGE_ORIGINS.USER);
  });
});
