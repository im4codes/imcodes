import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/util/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  CopilotSdkProvider,
  copilotSdkRuntimeHooks,
} from '../../src/agent/providers/copilot-sdk.js';
import type { MessageDelta } from '../../shared/agent-message.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Build a fake @github/copilot-sdk whose CopilotClient hands back a session
 * that captures the single event handler passed to `on(handler)`. The test
 * drives that captured handler with a hand-built event sequence to exercise
 * the `assistant.message_delta` accumulator-reset across message boundaries.
 */
function makeFakeSdk() {
  const captured: { handler: ((event: Record<string, any>) => void) | null } = { handler: null };
  const session = {
    sessionId: 'copilot-session-1',
    send: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((handler: (event: Record<string, any>) => void) => {
      captured.handler = handler;
      return () => {
        captured.handler = null;
      };
    }),
  };
  class FakeCopilotClient {
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    // 1.0.31 / protocol 3 are the minimum compatible values the provider's
    // connect() guard accepts (isCompatibleCopilotCliVersion + MIN_PROTOCOL_VERSION).
    getStatus = vi.fn().mockResolvedValue({ version: '1.0.31', protocolVersion: 3 });
    getAuthStatus = vi.fn().mockResolvedValue({ isAuthenticated: true });
    listModels = vi.fn().mockResolvedValue([]);
    createSession = vi.fn().mockResolvedValue(session);
    resumeSession = vi.fn().mockResolvedValue(session);
    listSessions = vi.fn().mockResolvedValue([]);
    deleteSession = vi.fn().mockResolvedValue(undefined);
  }
  return {
    captured,
    session,
    sdk: { CopilotClient: FakeCopilotClient } as unknown as typeof import('@github/copilot-sdk'),
  };
}

describe('CopilotSdkProvider streaming accumulator', () => {
  let originalLoadSdk: typeof copilotSdkRuntimeHooks.loadSdk;

  beforeEach(() => {
    originalLoadSdk = copilotSdkRuntimeHooks.loadSdk;
  });

  afterEach(() => {
    copilotSdkRuntimeHooks.loadSdk = originalLoadSdk;
  });

  it('resets the streaming accumulator across messages so a second message is not prefixed with the first', async () => {
    const fake = makeFakeSdk();
    copilotSdkRuntimeHooks.loadSdk = vi.fn().mockResolvedValue(fake.sdk);

    const provider = new CopilotSdkProvider();
    await provider.connect({ binaryPath: 'copilot' });
    await provider.createSession({ sessionKey: 'route-copilot', cwd: '/tmp/project' });

    const captured: Array<{ id: string; text: string }> = [];
    provider.onDelta((_sid: string, delta: MessageDelta) =>
      captured.push({ id: delta.messageId, text: delta.delta }));

    await provider.send('route-copilot', 'hello');
    await flush();

    const emit = (event: Record<string, any>) => {
      if (!fake.captured.handler) throw new Error('session handler was never captured');
      fake.captured.handler(event);
    };

    // ── Message 1: streams "Let me check." then settles, then a tool round. ──
    emit({ type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: 'Let me check.' } });
    emit({ type: 'assistant.message', data: { messageId: 'm1', content: 'Let me check.' } });
    emit({ type: 'tool.execution_start', data: { toolName: 'read', callId: 't1' } });
    emit({ type: 'tool.execution_complete', data: { toolName: 'read', callId: 't1' } });

    // ── Message 2: a NEW messageId continues the same turn mid-stream. ──
    emit({ type: 'assistant.message_delta', data: { messageId: 'm2', deltaContent: 'The answer' } });
    emit({ type: 'assistant.message_delta', data: { messageId: 'm2', deltaContent: ' is 42.' } });
    emit({ type: 'assistant.message', data: { messageId: 'm2', content: 'The answer is 42.' } });

    // ── Turn ends. ──
    emit({ type: 'session.idle', data: {} });

    // Message 2's deltas must be its OWN cumulative text only — never carrying
    // message 1's full text as a prefix. Before the fix the first m2 delta was
    // "Let me check.The answer" because currentText was not reset at the new
    // messageId boundary.
    const msg2Deltas = captured.filter((d) => d.id === 'm2').map((d) => d.text);
    expect(msg2Deltas).toEqual(['The answer', 'The answer is 42.']);

    // Guard: no emitted delta should ever contain both messages concatenated.
    expect(captured.every((d) => !d.text.includes('Let me check.The answer'))).toBe(true);
  });
});
