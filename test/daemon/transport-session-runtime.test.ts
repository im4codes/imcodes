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

  const fireDelta = (sid: string) =>
    deltaCb?.(sid, { messageId: 'msg', type: 'text', delta: 'x', role: 'assistant' });
  const fireComplete = (sid: string) =>
    completeCb?.(sid, { id: 'msg-1', sessionId: sid, kind: 'text', role: 'assistant', content: 'done', timestamp: Date.now(), status: 'complete' });
  const fireError = (sid: string, err?: ProviderError) =>
    errorCb?.(sid, err ?? { code: 'PROVIDER_ERROR', message: 'err', recoverable: false });

  return {
    provider: {
      id: 'mock', connectionMode: 'persistent', sessionOwnership: 'provider',
      capabilities: { streaming: true, toolCalling: false, approval: false, sessionRestore: false, multiTurn: true, attachments: false },
      connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(), cancel: vi.fn(),
      createSession: vi.fn().mockResolvedValue('sess-1'), endSession: vi.fn(),
      onDelta: (cb: (sid: string, d: MessageDelta) => void) => { deltaCb = cb; return () => { deltaCb = null; }; },
      onComplete: (cb: (sid: string, m: AgentMessage) => void) => { completeCb = cb; return () => { completeCb = null; }; },
      onError: (cb: (sid: string, e: ProviderError) => void) => { errorCb = cb; return () => { errorCb = null; }; },
    } as unknown as TransportProvider,
    fireDelta, fireComplete, fireError,
  };
}

const defaultConfig: SessionConfig = { sessionKey: 'deck_test_brain' };

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('TransportSessionRuntime', () => {
  let mock: ReturnType<typeof makeMockProvider>;
  let runtime: TransportSessionRuntime;

  beforeEach(async () => {
    mock = makeMockProvider();
    runtime = new TransportSessionRuntime(mock.provider, 'deck_test_brain');
    await runtime.initialize(defaultConfig);
  });

  it('type is transport', () => {
    expect(runtime.type).toBe(RUNTIME_TYPES.TRANSPORT);
  });

  it('initialize() calls provider.createSession', async () => {
    expect(runtime.providerSessionId).toBe('sess-1');
    expect(mock.provider.createSession).toHaveBeenCalledWith(defaultConfig);
  });

  it('send() throws if not initialized', () => {
    const fresh = new TransportSessionRuntime(mock.provider, 'x');
    expect(() => fresh.send('hi')).toThrow(/not initialized/i);
  });

  it('send() returns "sent" when idle', () => {
    expect(runtime.send('hi')).toBe('sent');
    expect(mock.provider.send).toHaveBeenCalledWith('sess-1', 'hi', undefined, undefined);
  });

  it('send() returns "queued" when busy', () => {
    runtime.send('first');
    expect(runtime.send('second')).toBe('queued');
    expect(runtime.pendingCount).toBe(1);
    // provider.send called only once (for first message)
    expect(mock.provider.send).toHaveBeenCalledTimes(1);
  });

  it('send() passes description as extraSystemPrompt', async () => {
    const r = new TransportSessionRuntime(mock.provider, 'x');
    await r.initialize({ ...defaultConfig, description: 'expert' });
    r.send('help');
    expect(mock.provider.send).toHaveBeenCalledWith('sess-1', 'help', undefined, 'expert');
  });

  it('onComplete sets status to idle and appends to history', () => {
    runtime.send('go');
    mock.fireComplete('sess-1');

    expect(runtime.getStatus()).toBe('idle');
    const h = runtime.getHistory();
    expect(h).toHaveLength(2);
    expect(h[0].role).toBe('user');
    expect(h[1].role).toBe('assistant');
  });

  it('onError sets status to error', () => {
    runtime.send('go');
    mock.fireError('sess-1');
    expect(runtime.getStatus()).toBe('error');
    expect(runtime.sending).toBe(false);
  });

  it('cancel() delegates to provider.cancel and preserves pending', () => {
    runtime.send('first');
    runtime.send('queued1');
    runtime.send('queued2');
    expect(runtime.pendingCount).toBe(2);

    runtime.cancel();
    expect(mock.provider.cancel).toHaveBeenCalledWith('sess-1');
    expect(runtime.pendingCount).toBe(2);
  });

  it('cancelled turns drain pending messages into the next turn', () => {
    runtime.send('first');
    runtime.send('queued1');
    runtime.send('queued2');

    runtime.cancel();
    mock.fireError('sess-1', { code: 'CANCELLED', message: 'cancelled', recoverable: true });

    expect(mock.provider.send).toHaveBeenCalledTimes(2);
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', 'queued1\n\nqueued2', undefined, undefined);
    expect(runtime.pendingCount).toBe(0);
  });

  it('CANCELLED error → idle (not error)', () => {
    runtime.send('go');
    mock.fireError('sess-1', { code: 'CANCELLED', message: 'cancelled', recoverable: true });
    expect(runtime.getStatus()).toBe('idle');
  });

  it('events from wrong session are ignored', () => {
    runtime.send('go');
    mock.fireDelta('other-session');
    mock.fireComplete('other-session');
    expect(runtime.getStatus()).toBe('thinking');
    expect(runtime.getHistory()).toHaveLength(1); // only user msg
  });

  it('kill() clears everything', async () => {
    runtime.send('go');
    runtime.send('queued');
    await runtime.kill();

    expect(runtime.providerSessionId).toBeNull();
    expect(runtime.getStatus()).toBe('idle');
    expect(runtime.sending).toBe(false);
    expect(runtime.pendingCount).toBe(0);
  });

  it('getHistory() returns a copy', () => {
    runtime.send('test');
    mock.fireComplete('sess-1');
    const h = runtime.getHistory();
    h.push({} as AgentMessage);
    expect(runtime.getHistory()).toHaveLength(2);
  });

  it('sending flag tracks turn', () => {
    expect(runtime.sending).toBe(false);
    runtime.send('go');
    expect(runtime.sending).toBe(true);
    mock.fireComplete('sess-1');
    expect(runtime.sending).toBe(false);
  });
});
