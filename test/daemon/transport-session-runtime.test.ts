import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import { RUNTIME_TYPES } from '../../src/agent/session-runtime.js';
import type { TransportProvider, ProviderError, SessionConfig } from '../../src/agent/transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';

// ── Mock provider factory ──────────────────────────────────────────────────────

function makeMockProvider() {
  let deltaCb: ((sid: string, d: MessageDelta) => void) | null = null;
  let completeCb: ((sid: string, m: AgentMessage) => void) | null = null;
  let errorCb: ((sid: string, e: ProviderError) => void) | null = null;

  return {
    provider: {
      id: 'mock',
      connectionMode: 'persistent',
      sessionOwnership: 'provider',
      capabilities: {
        streaming: true,
        toolCalling: false,
        approval: false,
        sessionRestore: false,
        multiTurn: true,
        attachments: false,
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
      send: vi.fn(),
      createSession: vi.fn().mockResolvedValue('mock-session-123'),
      endSession: vi.fn(),
      onDelta: (cb: (sid: string, d: MessageDelta) => void) => { deltaCb = cb; return () => { deltaCb = undefined; }; },
      onComplete: (cb: (sid: string, m: AgentMessage) => void) => { completeCb = cb; return () => { completeCb = undefined; }; },
      onError: (cb: (sid: string, e: ProviderError) => void) => { errorCb = cb; return () => { errorCb = undefined; }; },
    } as unknown as TransportProvider,
    fireDelta: (sid: string, delta: MessageDelta) => deltaCb?.(sid, delta),
    fireComplete: (sid: string, msg: AgentMessage) => completeCb?.(sid, msg),
    fireError: (sid: string, err: ProviderError) => errorCb?.(sid, err),
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeDelta(messageId = 'msg-1'): MessageDelta {
  return { messageId, type: 'text', delta: 'hello', role: 'assistant' };
}

function makeMessage(id = 'msg-1', sessionId = 'mock-session-123'): AgentMessage {
  return {
    id,
    sessionId,
    kind: 'text',
    role: 'assistant',
    content: 'hello world',
    timestamp: Date.now(),
    status: 'complete',
  };
}

function makeError(): ProviderError {
  return { code: 'PROVIDER_ERROR', message: 'something broke', recoverable: false };
}

const defaultConfig: SessionConfig = { sessionKey: 'deck_test_brain' };

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('TransportSessionRuntime', () => {
  let mock: ReturnType<typeof makeMockProvider>;
  let runtime: TransportSessionRuntime;

  beforeEach(() => {
    mock = makeMockProvider();
    runtime = new TransportSessionRuntime(mock.provider, 'deck_test_brain');
  });

  it('type is transport', () => {
    expect(runtime.type).toBe(RUNTIME_TYPES.TRANSPORT);
  });

  it('initialize() calls provider.createSession and stores session id', async () => {
    expect(runtime.providerSessionId).toBeNull();
    await runtime.initialize(defaultConfig);
    expect(mock.provider.createSession).toHaveBeenCalledWith(defaultConfig);
    expect(runtime.providerSessionId).toBe('mock-session-123');
  });

  it('send() throws if not initialized', async () => {
    await expect(runtime.send('hi')).rejects.toThrow(/not initialized/i);
  });

  it('send() sets status to thinking and calls provider.send', async () => {
    await runtime.initialize(defaultConfig);
    await runtime.send('do something');
    expect(runtime.getStatus()).toBe('thinking');
    expect(mock.provider.send).toHaveBeenCalledWith('mock-session-123', 'do something', undefined, undefined);
  });

  it('send() passes description as extraSystemPrompt', async () => {
    await runtime.initialize({ ...defaultConfig, description: 'You are a frontend expert' });
    await runtime.send('help me');
    expect(mock.provider.send).toHaveBeenCalledWith('mock-session-123', 'help me', undefined, 'You are a frontend expert');
  });

  it('onDelta callback sets status to streaming', async () => {
    await runtime.initialize(defaultConfig);
    await runtime.send('go');
    expect(runtime.getStatus()).toBe('thinking');

    mock.fireDelta('mock-session-123', makeDelta());
    expect(runtime.getStatus()).toBe('streaming');
  });

  it('onComplete callback sets status to idle and appends to history', async () => {
    await runtime.initialize(defaultConfig);
    await runtime.send('go');

    const msg = makeMessage();
    mock.fireComplete('mock-session-123', msg);

    expect(runtime.getStatus()).toBe('idle');
    // history has user message + assistant message
    const history = runtime.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe('user');
    expect(history[0].content).toBe('go');
    expect(history[1]).toEqual(msg);
  });

  it('onError callback sets status to error', async () => {
    await runtime.initialize(defaultConfig);
    await runtime.send('go');
    expect(runtime.getStatus()).toBe('thinking');

    mock.fireError('mock-session-123', makeError());
    expect(runtime.getStatus()).toBe('error');
  });

  it('next send() clears error status back to thinking', async () => {
    await runtime.initialize(defaultConfig);
    await runtime.send('go');
    mock.fireError('mock-session-123', makeError());
    expect(runtime.getStatus()).toBe('error');

    await runtime.send('retry');
    expect(runtime.getStatus()).toBe('thinking');
  });

  it('callbacks ignore events from other sessions', async () => {
    await runtime.initialize(defaultConfig);
    await runtime.send('go');
    expect(runtime.getStatus()).toBe('thinking');

    // Fire events with a different session id — should be ignored
    mock.fireDelta('other-session-999', makeDelta());
    expect(runtime.getStatus()).toBe('thinking'); // unchanged

    mock.fireComplete('other-session-999', makeMessage('msg-2', 'other-session-999'));
    expect(runtime.getStatus()).toBe('thinking'); // unchanged
    expect(runtime.getHistory()).toHaveLength(1); // only the user message from send()

    mock.fireError('other-session-999', makeError());
    expect(runtime.getStatus()).toBe('thinking'); // unchanged
  });

  it('kill() calls endSession, clears session id, sets idle', async () => {
    await runtime.initialize(defaultConfig);
    await runtime.send('go');
    expect(runtime.getStatus()).toBe('thinking');

    await runtime.kill();
    expect(mock.provider.endSession).toHaveBeenCalledWith('mock-session-123');
    expect(runtime.providerSessionId).toBeNull();
    expect(runtime.getStatus()).toBe('idle');
  });

  it('getHistory() returns a copy', async () => {
    await runtime.initialize(defaultConfig);
    await runtime.send('test');
    const msg = makeMessage();
    mock.fireComplete('mock-session-123', msg);

    const h1 = runtime.getHistory();
    const h2 = runtime.getHistory();

    expect(h1).toEqual(h2);
    expect(h1).not.toBe(h2); // different array references

    // Mutating the returned array must not affect internal state
    h1.push(makeMessage('extra'));
    expect(runtime.getHistory()).toHaveLength(2); // user + assistant
  });

  it('send() records user message in history', async () => {
    await runtime.initialize(defaultConfig);
    await runtime.send('hello world');
    const history = runtime.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe('user');
    expect(history[0].content).toBe('hello world');
    expect(history[0].kind).toBe('text');
    expect(history[0].status).toBe('complete');
    expect(history[0].sessionId).toBe('mock-session-123');
  });

  it('send() resets status to idle on provider.send failure', async () => {
    await runtime.initialize(defaultConfig);
    (mock.provider.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('WS not open'));

    await expect(runtime.send('fail')).rejects.toThrow('WS not open');
    expect(runtime.getStatus()).toBe('idle');
    expect(runtime.sending).toBe(false);
  });

  it('sending flag is true while send is in flight', async () => {
    await runtime.initialize(defaultConfig);
    expect(runtime.sending).toBe(false);

    await runtime.send('go');
    expect(runtime.sending).toBe(true);

    mock.fireComplete('mock-session-123', makeMessage());
    expect(runtime.sending).toBe(false);
  });

  it('queues next send until the current turn completes', async () => {
    await runtime.initialize(defaultConfig);

    await runtime.send('first');
    expect(mock.provider.send).toHaveBeenNthCalledWith(1, 'mock-session-123', 'first', undefined, undefined);

    const queued = runtime.send('second');
    await Promise.resolve();
    expect(mock.provider.send).toHaveBeenCalledTimes(1);

    mock.fireComplete('mock-session-123', makeMessage('msg-1', 'mock-session-123'));
    await queued;

    expect(mock.provider.send).toHaveBeenCalledTimes(2);
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'mock-session-123', 'second', undefined, undefined);
  });
});
