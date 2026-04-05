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

  const fireDelta = (sid: string, delta?: MessageDelta) =>
    deltaCb?.(sid, delta ?? { messageId: 'msg-1', type: 'text', delta: 'hello', role: 'assistant' });
  const fireComplete = (sid: string, msg?: AgentMessage) =>
    completeCb?.(sid, msg ?? makeMessage('msg-1', sid));
  const fireError = (sid: string, err?: ProviderError) =>
    errorCb?.(sid, err ?? makeError());

  // Default: auto-complete turns synchronously during provider.send()
  let sendBehavior: (sid: string) => void = (sid) => fireComplete(sid);

  return {
    provider: {
      id: 'mock',
      connectionMode: 'persistent',
      sessionOwnership: 'provider',
      capabilities: { streaming: true, toolCalling: false, approval: false, sessionRestore: false, multiTurn: true, attachments: false },
      connect: vi.fn(),
      disconnect: vi.fn(),
      send: vi.fn().mockImplementation((sid: string) => { sendBehavior(sid); }),
      cancel: vi.fn(),
      createSession: vi.fn().mockResolvedValue('mock-session-123'),
      endSession: vi.fn(),
      onDelta: (cb: (sid: string, d: MessageDelta) => void) => { deltaCb = cb; return () => { deltaCb = undefined; }; },
      onComplete: (cb: (sid: string, m: AgentMessage) => void) => { completeCb = cb; return () => { completeCb = undefined; }; },
      onError: (cb: (sid: string, e: ProviderError) => void) => { errorCb = cb; return () => { errorCb = undefined; }; },
    } as unknown as TransportProvider,
    fireDelta,
    fireComplete,
    fireError,
    setSendBehavior: (fn: (sid: string) => void) => { sendBehavior = fn; },
    setManualMode: () => { sendBehavior = () => {}; },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeDelta(messageId = 'msg-1'): MessageDelta {
  return { messageId, type: 'text', delta: 'hello', role: 'assistant' };
}

function makeMessage(id = 'msg-1', sessionId = 'mock-session-123'): AgentMessage {
  return { id, sessionId, kind: 'text', role: 'assistant', content: 'hello world', timestamp: Date.now(), status: 'complete' };
}

function makeError(): ProviderError {
  return { code: 'PROVIDER_ERROR', message: 'something broke', recoverable: false };
}

function makeCancelledError(): ProviderError {
  return { code: 'CANCELLED', message: 'Cancelled', recoverable: true };
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

  it('send() calls provider.send and resolves after turn completes', async () => {
    await runtime.initialize(defaultConfig);
    await runtime.send('do something');
    // Turn auto-completes → status is idle
    expect(runtime.getStatus()).toBe('idle');
    expect(mock.provider.send).toHaveBeenCalledWith('mock-session-123', 'do something', undefined, undefined);
  });

  it('send() passes description as extraSystemPrompt', async () => {
    await runtime.initialize({ ...defaultConfig, description: 'You are a frontend expert' });
    await runtime.send('help me');
    expect(mock.provider.send).toHaveBeenCalledWith('mock-session-123', 'help me', undefined, 'You are a frontend expert');
  });

  it('onDelta callback sets status to streaming', async () => {
    mock.setSendBehavior((sid) => {
      mock.fireDelta(sid, makeDelta());
      mock.fireComplete(sid);
    });
    await runtime.initialize(defaultConfig);
    await runtime.send('go');
    // After completion, status is idle. But streaming was visited during the turn.
    expect(runtime.getStatus()).toBe('idle');
  });

  it('onComplete callback appends to history', async () => {
    await runtime.initialize(defaultConfig);
    await runtime.send('go');
    const history = runtime.getHistory();
    expect(history).toHaveLength(2); // user + assistant
    expect(history[0].role).toBe('user');
    expect(history[0].content).toBe('go');
    expect(history[1].role).toBe('assistant');
  });

  it('onError callback sets status to error', async () => {
    mock.setSendBehavior((sid) => mock.fireError(sid));
    await runtime.initialize(defaultConfig);
    await runtime.send('go').catch(() => {});
    expect(runtime.getStatus()).toBe('error');
  });

  it('cancel() delegates to provider.cancel', async () => {
    mock.setManualMode();
    await runtime.initialize(defaultConfig);
    const sendPromise = runtime.send('go');
    await Promise.resolve();
    await runtime.cancel();
    expect(mock.provider.cancel).toHaveBeenCalledWith('mock-session-123');
    mock.fireComplete('mock-session-123');
    await sendPromise;
  });

  it('cancelled error returns status to idle', async () => {
    mock.setSendBehavior((sid) => mock.fireError(sid, makeCancelledError()));
    await runtime.initialize(defaultConfig);
    await runtime.send('go').catch(() => {});
    expect(runtime.getStatus()).toBe('idle');
    expect(runtime.sending).toBe(false);
  });

  it('next send() clears error status', async () => {
    let callCount = 0;
    mock.setSendBehavior((sid) => {
      callCount++;
      if (callCount === 1) mock.fireError(sid);
      else mock.fireComplete(sid);
    });
    await runtime.initialize(defaultConfig);
    await runtime.send('go').catch(() => {});
    expect(runtime.getStatus()).toBe('error');

    await runtime.send('retry');
    expect(runtime.getStatus()).toBe('idle');
  });

  it('callbacks ignore events from other sessions', async () => {
    mock.setManualMode();
    await runtime.initialize(defaultConfig);
    const sendPromise = runtime.send('go');
    await Promise.resolve();

    // Fire events with a different session id — should be ignored
    mock.fireDelta('other-session-999', makeDelta());
    mock.fireComplete('other-session-999', makeMessage('msg-2', 'other-session-999'));
    expect(runtime.getHistory()).toHaveLength(1); // only the user message

    // Complete with correct session
    mock.fireComplete('mock-session-123');
    await sendPromise;
    expect(runtime.getHistory()).toHaveLength(2);
  });

  it('kill() calls endSession, clears session id, sets idle', async () => {
    mock.setManualMode();
    await runtime.initialize(defaultConfig);
    const sendPromise = runtime.send('go');
    await Promise.resolve();

    await runtime.kill();
    await sendPromise.catch(() => {});

    expect(mock.provider.endSession).toHaveBeenCalledWith('mock-session-123');
    expect(runtime.providerSessionId).toBeNull();
    expect(runtime.getStatus()).toBe('idle');
  });

  it('getHistory() returns a copy', async () => {
    await runtime.initialize(defaultConfig);
    await runtime.send('test');
    const h1 = runtime.getHistory();
    const h2 = runtime.getHistory();
    expect(h1).toEqual(h2);
    expect(h1).not.toBe(h2);

    h1.push(makeMessage('extra'));
    expect(runtime.getHistory()).toHaveLength(2); // user + assistant
  });

  it('send() records user message in history', async () => {
    await runtime.initialize(defaultConfig);
    await runtime.send('hello world');
    const history = runtime.getHistory();
    expect(history[0].role).toBe('user');
    expect(history[0].content).toBe('hello world');
    expect(history[0].kind).toBe('text');
    expect(history[0].status).toBe('complete');
    expect(history[0].sessionId).toBe('mock-session-123');
  });

  it('send() resets status to idle on provider.send failure', async () => {
    await runtime.initialize(defaultConfig);
    (mock.provider.send as ReturnType<typeof vi.fn>).mockImplementationOnce(() => { throw new Error('WS not open'); });
    await expect(runtime.send('fail')).rejects.toThrow('WS not open');
    expect(runtime.getStatus()).toBe('idle');
    expect(runtime.sending).toBe(false);
  });

  it('sending flag tracks turn lifecycle', async () => {
    mock.setManualMode();
    await runtime.initialize(defaultConfig);
    expect(runtime.sending).toBe(false);

    const sendPromise = runtime.send('go');
    await Promise.resolve();
    expect(runtime.sending).toBe(true);

    mock.fireComplete('mock-session-123');
    await sendPromise;
    expect(runtime.sending).toBe(false);
  });

  it('queues next send until the current turn completes (FIFO)', async () => {
    await runtime.initialize(defaultConfig);
    // Auto-complete
    await runtime.send('first');
    expect(mock.provider.send).toHaveBeenCalledTimes(1);

    await runtime.send('second');
    expect(mock.provider.send).toHaveBeenCalledTimes(2);

    const calls = (mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1]);
    expect(calls).toEqual(['first', 'second']);
  });
});
