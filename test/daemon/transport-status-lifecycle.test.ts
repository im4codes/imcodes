/**
 * Transport session runtime — status lifecycle, batched queuing, and cancel tests.
 *
 * Send model:
 *   - Idle → send dispatches immediately (one turn)
 *   - Busy → messages enqueue. On turn completion, ALL pending messages
 *     merge into ONE message and dispatch as a single turn.
 *
 * Status lifecycle:
 *   idle → thinking → streaming → idle   (normal)
 *   idle → thinking → error              (provider error)
 *   idle → thinking → idle               (cancel / no streaming)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import type { TransportProvider, ProviderError, SessionConfig } from '../../src/agent/transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';
import type { AgentStatus } from '../../src/agent/detect.js';

// ── Mock provider ──────────────────────────────────────────────────────────────

function makeMockProvider() {
  let deltaCb: ((sid: string, d: MessageDelta) => void) | null = null;
  let completeCb: ((sid: string, m: AgentMessage) => void) | null = null;
  let errorCb: ((sid: string, e: ProviderError) => void) | null = null;

  const fireDelta = (sid: string) =>
    deltaCb?.(sid, { messageId: 'msg', type: 'text', delta: 'x', role: 'assistant' });
  const fireComplete = (sid: string) =>
    completeCb?.(sid, { id: 'msg-1', sessionId: sid, kind: 'text', role: 'assistant', content: 'done', timestamp: Date.now(), status: 'complete' });
  const fireError = (sid: string, code = 'PROVIDER_ERROR', recoverable = false) =>
    errorCb?.(sid, { code, message: 'err', recoverable });
  const fireCancelled = (sid: string) =>
    errorCb?.(sid, { code: 'CANCELLED', message: 'cancelled', recoverable: true });

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
    fireDelta, fireComplete, fireError, fireCancelled,
  };
}

const defaultConfig: SessionConfig = { sessionKey: 'deck_test' };

// ── Status lifecycle ───────────────────────────────────────────────────────────

describe('status lifecycle', () => {
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

  it('idle → thinking → streaming → idle (normal turn)', () => {
    runtime.send('hi');
    mock.fireDelta('sess-1');
    mock.fireDelta('sess-1'); // duplicate suppressed
    mock.fireComplete('sess-1');
    expect(statusLog).toEqual(['thinking', 'streaming', 'idle']);
  });

  it('idle → thinking → idle (no streaming, direct complete)', () => {
    runtime.send('hi');
    mock.fireComplete('sess-1');
    expect(statusLog).toEqual(['thinking', 'idle']);
  });

  it('idle → thinking → error (provider error)', () => {
    runtime.send('hi');
    mock.fireError('sess-1');
    expect(statusLog).toEqual(['thinking', 'error']);
  });

  it('idle → thinking → idle (CANCELLED)', () => {
    runtime.send('hi');
    mock.fireCancelled('sess-1');
    expect(statusLog).toEqual(['thinking', 'idle']);
  });

  it('idle → thinking → streaming → error (error during streaming)', () => {
    runtime.send('hi');
    mock.fireDelta('sess-1');
    mock.fireError('sess-1');
    expect(statusLog).toEqual(['thinking', 'streaming', 'error']);
  });

  it('duplicate deltas do not re-emit streaming', () => {
    runtime.send('hi');
    mock.fireDelta('sess-1');
    mock.fireDelta('sess-1');
    mock.fireDelta('sess-1');
    mock.fireComplete('sess-1');
    expect(statusLog.filter((s) => s === 'streaming')).toHaveLength(1);
  });

  it('ignores events from wrong session ID', () => {
    runtime.send('hi');
    mock.fireDelta('other');
    mock.fireComplete('other');
    expect(statusLog).toEqual(['thinking']);
  });

  it('kill() transitions to idle', async () => {
    runtime.send('hi');
    mock.fireDelta('sess-1');
    await runtime.kill();
    expect(statusLog[statusLog.length - 1]).toBe('idle');
    expect(runtime.getStatus()).toBe('idle');
  });

  it('kill() from idle does not fire onStatusChange', async () => {
    await runtime.kill();
    expect(statusLog).toEqual([]);
  });
});

// ── Batched queuing ────────────────────────────────────────────────────────────

describe('batched queuing', () => {
  let mock: ReturnType<typeof makeMockProvider>;
  let runtime: TransportSessionRuntime;
  let drainLog: Array<{ merged: string; count: number }>;

  beforeEach(async () => {
    mock = makeMockProvider();
    runtime = new TransportSessionRuntime(mock.provider, 'deck_test');
    drainLog = [];
    runtime.onDrain = (merged, count) => drainLog.push({ merged, count });
    await runtime.initialize(defaultConfig);
  });

  it('idle send dispatches immediately, no drain', () => {
    const result = runtime.send('hello');
    expect(result).toBe('sent');
    expect(mock.provider.send).toHaveBeenCalledTimes(1);
    expect(drainLog).toHaveLength(0);
  });

  it('messages during busy turn are queued', () => {
    runtime.send('first');
    expect(runtime.send('second')).toBe('queued');
    expect(runtime.send('third')).toBe('queued');
    expect(runtime.pendingCount).toBe(2);
    // Only first message sent to provider
    expect(mock.provider.send).toHaveBeenCalledTimes(1);
    expect(mock.provider.send).toHaveBeenCalledWith('sess-1', 'first', undefined, undefined);
  });

  it('on complete, all pending messages merge into one turn', () => {
    runtime.send('first');
    runtime.send('second');
    runtime.send('third');
    expect(runtime.pendingCount).toBe(2);

    // Complete first turn → pending messages drain as one merged message
    mock.fireComplete('sess-1');

    expect(mock.provider.send).toHaveBeenCalledTimes(2);
    // Second call is the merged message
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', 'second\n\nthird', undefined, undefined);
    expect(runtime.pendingCount).toBe(0);
    expect(drainLog).toEqual([{ merged: 'second\n\nthird', count: 2 }]);
  });

  it('on unrecoverable error, pending messages are NOT drained (prevents error loop)', () => {
    runtime.send('first');
    runtime.send('retry-me');

    // Unrecoverable error (recoverable: false) — don't drain
    mock.fireError('sess-1');

    expect(mock.provider.send).toHaveBeenCalledTimes(1);
    expect(runtime.pendingCount).toBe(1); // message preserved, not consumed
    expect(runtime.getStatus()).toBe('error');
  });

  it('on recoverable error, pending messages drain into next turn', () => {
    runtime.send('first');
    runtime.send('retry-me');

    // Recoverable error → drain pending
    mock.fireError('sess-1', 'RATE_LIMITED', true);

    expect(mock.provider.send).toHaveBeenCalledTimes(2);
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', 'retry-me', undefined, undefined);
    expect(runtime.getStatus()).toBe('thinking');
  });

  it('on cancel, pending messages are drained into the next turn', () => {
    runtime.send('first');
    runtime.send('still-queued');
    runtime.send('send-after-stop');

    runtime.cancel();
    mock.fireCancelled('sess-1');

    expect(mock.provider.send).toHaveBeenCalledTimes(2);
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', 'still-queued\n\nsend-after-stop', undefined, undefined);
    expect(runtime.pendingCount).toBe(0);
    expect(runtime.getStatus()).toBe('thinking');
  });

  it('multiple turns with queuing: correct history order', () => {
    // Turn 1: send 'A', queue 'B' and 'C'
    runtime.send('A');
    runtime.send('B');
    runtime.send('C');

    // Complete turn 1 → drains B+C as merged turn 2
    mock.fireComplete('sess-1');
    // Complete turn 2
    mock.fireComplete('sess-1');

    const history = runtime.getHistory();
    expect(history.map((h) => ({ role: h.role, content: h.content }))).toEqual([
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'B\n\nC' },
      { role: 'assistant', content: 'done' },
    ]);
  });

  it('status transitions with queuing: thinking→idle then thinking→idle', () => {
    const statusLog: AgentStatus[] = [];
    runtime.onStatusChange = (s) => statusLog.push(s);

    runtime.send('A');
    runtime.send('B'); // queued

    // Complete A → drain B (no idle between — goes straight to next turn thinking)
    mock.fireComplete('sess-1');
    // Complete B
    mock.fireComplete('sess-1');

    // thinking(A) → streaming is optional → thinking(B, drain) → idle(B done)
    // Since drain fires a new turn, status goes: thinking → thinking(again via drain) → idle
    // But setStatus deduplicates, so thinking→thinking is suppressed
    expect(statusLog[0]).toBe('thinking');
    expect(statusLog[statusLog.length - 1]).toBe('idle');
  });

  it('no drain happens if pendingMessages is empty', () => {
    runtime.send('solo');
    mock.fireComplete('sess-1');

    expect(mock.provider.send).toHaveBeenCalledTimes(1);
    expect(drainLog).toHaveLength(0);
    expect(runtime.getStatus()).toBe('idle');
  });

  it('kill() clears pending without draining', async () => {
    runtime.send('first');
    runtime.send('queued1');
    runtime.send('queued2');

    await runtime.kill();

    expect(mock.provider.send).toHaveBeenCalledTimes(1);
    expect(drainLog).toHaveLength(0);
    expect(runtime.pendingCount).toBe(0);
  });

  it('send after kill throws', async () => {
    await runtime.kill();
    expect(() => runtime.send('hi')).toThrow(/not initialized/i);
  });
});
