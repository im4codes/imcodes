/**
 * Transport session runtime — status lifecycle, queuing, and cancel tests.
 *
 * Verifies:
 *   1. onStatusChange fires for every status transition in correct order
 *   2. Status never skips states or emits duplicates
 *   3. Queued sends execute in strict FIFO order
 *   4. Error during active turn doesn't block queued sends
 *   5. cancel/kill during active turn cleans up properly
 *   6. send() resolves only after the full turn completes (dispatch + response)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import type { TransportProvider, ProviderError, SessionConfig } from '../../src/agent/transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';
import type { AgentStatus } from '../../src/agent/detect.js';

// ── Mock provider that simulates async turn lifecycle ──────────────────────────

function makeMockProvider() {
  let deltaCb: ((sid: string, d: MessageDelta) => void) | null = null;
  let completeCb: ((sid: string, m: AgentMessage) => void) | null = null;
  let errorCb: ((sid: string, e: ProviderError) => void) | null = null;

  const fireDelta = (sid: string) => deltaCb?.(sid, { messageId: 'msg', type: 'text', delta: 'x', role: 'assistant' });
  const fireComplete = (sid: string, id = 'msg-1') => completeCb?.(sid, { id, sessionId: sid, kind: 'text', role: 'assistant', content: 'done', timestamp: Date.now(), status: 'complete' });
  const fireError = (sid: string, code = 'PROVIDER_ERROR') => errorCb?.(sid, { code, message: 'err', recoverable: false });
  const fireCancelled = (sid: string) => errorCb?.(sid, { code: 'CANCELLED', message: 'Cancelled', recoverable: true });

  // By default, provider.send fires delta+complete automatically (simulates a complete turn).
  // Tests can override sendBehavior to control timing.
  let sendBehavior: (sid: string) => void = (sid) => {
    fireDelta(sid);
    fireComplete(sid);
  };

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
      createSession: vi.fn().mockResolvedValue('sess-1'),
      endSession: vi.fn(),
      onDelta: (cb: (sid: string, d: MessageDelta) => void) => { deltaCb = cb; return () => { deltaCb = null; }; },
      onComplete: (cb: (sid: string, m: AgentMessage) => void) => { completeCb = cb; return () => { completeCb = null; }; },
      onError: (cb: (sid: string, e: ProviderError) => void) => { errorCb = cb; return () => { errorCb = null; }; },
    } as unknown as TransportProvider,
    fireDelta,
    fireComplete,
    fireError,
    fireCancelled,
    /** Override what provider.send does when called. */
    setSendBehavior: (fn: (sid: string) => void) => { sendBehavior = fn; },
    /** Make provider.send do nothing — caller must fire callbacks manually. */
    setManualMode: () => { sendBehavior = () => {}; },
  };
}

const defaultConfig: SessionConfig = { sessionKey: 'deck_test_brain' };

// ── Status lifecycle tests ─────────────────────────────────────────────────────

describe('TransportSessionRuntime — status lifecycle', () => {
  let mock: ReturnType<typeof makeMockProvider>;
  let runtime: TransportSessionRuntime;
  let statusLog: AgentStatus[];

  beforeEach(async () => {
    mock = makeMockProvider();
    runtime = new TransportSessionRuntime(mock.provider, 'deck_test');
    statusLog = [];
    runtime.onStatusChange = (s) => statusLog.push(s);
    await runtime.initialize(defaultConfig);
  });

  it('normal turn: idle → thinking → streaming → idle', async () => {
    mock.setSendBehavior((sid) => {
      mock.fireDelta(sid);
      mock.fireDelta(sid); // duplicate delta shouldn't re-emit
      mock.fireComplete(sid);
    });
    await runtime.send('hi');
    expect(statusLog).toEqual(['thinking', 'streaming', 'idle']);
  });

  it('turn without streaming: idle → thinking → idle', async () => {
    mock.setSendBehavior((sid) => mock.fireComplete(sid));
    await runtime.send('hi');
    expect(statusLog).toEqual(['thinking', 'idle']);
  });

  it('provider error: idle → thinking → error', async () => {
    mock.setSendBehavior((sid) => mock.fireError(sid));
    // send() should still resolve (error is handled via _activeTurn rejection)
    await runtime.send('hi').catch(() => {});
    expect(statusLog).toEqual(['thinking', 'error']);
    expect(runtime.sending).toBe(false);
  });

  it('cancel: idle → thinking → idle (CANCELLED maps to idle)', async () => {
    mock.setSendBehavior((sid) => mock.fireCancelled(sid));
    await runtime.send('hi').catch(() => {});
    expect(statusLog).toEqual(['thinking', 'idle']);
    expect(runtime.sending).toBe(false);
  });

  it('error during streaming: idle → thinking → streaming → error', async () => {
    mock.setSendBehavior((sid) => {
      mock.fireDelta(sid);
      mock.fireError(sid);
    });
    await runtime.send('hi').catch(() => {});
    expect(statusLog).toEqual(['thinking', 'streaming', 'error']);
  });

  it('provider.send() synchronous throw: idle → thinking → idle', async () => {
    (mock.provider.send as ReturnType<typeof vi.fn>).mockImplementationOnce(() => { throw new Error('network'); });
    await expect(runtime.send('hi')).rejects.toThrow('network');
    expect(statusLog).toEqual(['thinking', 'idle']);
    expect(runtime.sending).toBe(false);
  });

  it('does not fire onStatusChange for duplicate status', async () => {
    mock.setSendBehavior((sid) => {
      mock.fireDelta(sid);
      mock.fireDelta(sid);
      mock.fireDelta(sid);
      mock.fireComplete(sid);
    });
    await runtime.send('hi');
    expect(statusLog).toEqual(['thinking', 'streaming', 'idle']);
  });

  it('ignores events from a different session ID', async () => {
    mock.setManualMode();
    const sendPromise = runtime.send('hi');
    // Let the queue microtask fire so _doSend runs
    await Promise.resolve();
    expect(statusLog).toEqual(['thinking']);

    mock.fireDelta('other-session');
    mock.fireComplete('other-session');
    expect(statusLog).toEqual(['thinking']); // unchanged

    // Now fire for correct session
    mock.fireComplete('sess-1');
    await sendPromise;
    expect(statusLog).toEqual(['thinking', 'idle']);
  });

  it('kill() during active turn transitions to idle', async () => {
    mock.setManualMode();
    const sendPromise = runtime.send('hi');
    await Promise.resolve();
    mock.fireDelta('sess-1');
    expect(runtime.getStatus()).toBe('streaming');

    await runtime.kill();
    await sendPromise.catch(() => {});

    // Final state must be idle
    expect(runtime.getStatus()).toBe('idle');
    expect(runtime.sending).toBe(false);
    expect(runtime.providerSessionId).toBeNull();
    // Last status in log must be idle
    expect(statusLog[statusLog.length - 1]).toBe('idle');
  });

  it('kill() from idle does not fire redundant onStatusChange', async () => {
    await runtime.kill();
    expect(statusLog).toEqual([]);
  });

  it('send() resolves only after the full turn completes', async () => {
    const order: string[] = [];
    mock.setSendBehavior((sid) => {
      order.push('send-dispatched');
      // Simulate async: complete fires in next microtask
      Promise.resolve().then(() => {
        order.push('complete-fired');
        mock.fireComplete(sid);
      });
    });

    await runtime.send('hi');
    order.push('send-resolved');

    // send-resolved must come AFTER complete-fired
    expect(order).toEqual(['send-dispatched', 'complete-fired', 'send-resolved']);
  });
});

// ── Queuing tests ──────────────────────────────────────────────────────────────

describe('TransportSessionRuntime — strict FIFO queuing', () => {
  let mock: ReturnType<typeof makeMockProvider>;
  let runtime: TransportSessionRuntime;
  let statusLog: AgentStatus[];

  beforeEach(async () => {
    mock = makeMockProvider();
    runtime = new TransportSessionRuntime(mock.provider, 'deck_test');
    statusLog = [];
    runtime.onStatusChange = (s) => statusLog.push(s);
    await runtime.initialize(defaultConfig);
  });

  it('second send waits for first turn to complete (FIFO)', async () => {
    // Auto-complete on send
    await runtime.send('first');
    expect(mock.provider.send).toHaveBeenCalledTimes(1);

    await runtime.send('second');
    expect(mock.provider.send).toHaveBeenCalledTimes(2);

    const calls = (mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1]);
    expect(calls).toEqual(['first', 'second']);
  });

  it('three concurrent sends execute in strict order', async () => {
    const order: string[] = [];
    mock.setSendBehavior((sid) => {
      order.push(`dispatch-${(mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.length}`);
      mock.fireComplete(sid);
    });

    await Promise.all([
      runtime.send('A'),
      runtime.send('B'),
      runtime.send('C'),
    ]);

    const calls = (mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1]);
    expect(calls).toEqual(['A', 'B', 'C']);
    expect(mock.provider.send).toHaveBeenCalledTimes(3);
  });

  it('queued send proceeds after active turn errors', async () => {
    let callCount = 0;
    mock.setSendBehavior((sid) => {
      callCount++;
      if (callCount === 1) mock.fireError(sid); // first fails
      else mock.fireComplete(sid);               // second succeeds
    });

    const results = await Promise.allSettled([
      runtime.send('first'),
      runtime.send('second'),
    ]);

    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('fulfilled');
    expect(mock.provider.send).toHaveBeenCalledTimes(2);
  });

  it('queued send proceeds after cancel', async () => {
    let callCount = 0;
    mock.setSendBehavior((sid) => {
      callCount++;
      if (callCount === 1) mock.fireCancelled(sid);
      else mock.fireComplete(sid);
    });

    const results = await Promise.allSettled([
      runtime.send('first'),
      runtime.send('second'),
    ]);

    // Cancelled turn rejects, but second proceeds
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('fulfilled');
  });

  it('status transitions for queued sends: thinking→idle→thinking→idle', async () => {
    mock.setSendBehavior((sid) => mock.fireComplete(sid));

    await Promise.all([
      runtime.send('first'),
      runtime.send('second'),
    ]);

    expect(statusLog).toEqual(['thinking', 'idle', 'thinking', 'idle']);
  });

  it('sending flag tracks the active send through queue', async () => {
    mock.setSendBehavior((sid) => mock.fireComplete(sid));

    await runtime.send('first');
    expect(runtime.sending).toBe(false);

    await runtime.send('second');
    expect(runtime.sending).toBe(false);
  });

  it('history preserves correct order for queued sends', async () => {
    mock.setSendBehavior((sid) => mock.fireComplete(sid));

    await Promise.all([
      runtime.send('msg-A'),
      runtime.send('msg-B'),
    ]);

    const history = runtime.getHistory();
    expect(history.map((h) => ({ role: h.role, content: h.content }))).toEqual([
      { role: 'user', content: 'msg-A' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'msg-B' },
      { role: 'assistant', content: 'done' },
    ]);
  });
});

// ── Cancel / stop tests ────────────────────────────────────────────────────────

describe('TransportSessionRuntime — cancel and stop', () => {
  let mock: ReturnType<typeof makeMockProvider>;
  let runtime: TransportSessionRuntime;
  let statusLog: AgentStatus[];

  beforeEach(async () => {
    mock = makeMockProvider();
    runtime = new TransportSessionRuntime(mock.provider, 'deck_test');
    statusLog = [];
    runtime.onStatusChange = (s) => statusLog.push(s);
    await runtime.initialize(defaultConfig);
  });

  it('cancel() delegates to provider.cancel', async () => {
    mock.setManualMode();
    const sendPromise = runtime.send('hi');
    await Promise.resolve(); // let queue microtask fire

    await runtime.cancel();
    expect(mock.provider.cancel).toHaveBeenCalledWith('sess-1');

    // Simulate the provider firing CANCELLED after cancel()
    mock.fireCancelled('sess-1');
    await sendPromise.catch(() => {});

    expect(runtime.getStatus()).toBe('idle');
  });

  it('cancel() throws if not initialized', async () => {
    const fresh = new TransportSessionRuntime(mock.provider, 'test');
    await expect(fresh.cancel()).rejects.toThrow(/not initialized/i);
  });

  it('kill() cancels active turn and clears queue', async () => {
    mock.setManualMode();
    const first = runtime.send('first');
    const second = runtime.send('second');
    await Promise.resolve(); // let first's _doSend start

    await runtime.kill();

    // Both should resolve/reject without hanging
    await first.catch(() => {});
    await second.catch(() => {});

    expect(runtime.getStatus()).toBe('idle');
    expect(runtime.sending).toBe(false);
  });

  it('send after kill rejects (session destroyed)', async () => {
    await runtime.kill();
    await expect(runtime.send('hi')).rejects.toThrow(/not initialized/i);
  });
});
