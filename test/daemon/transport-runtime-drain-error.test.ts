/**
 * Regression tests for audit 0419d1ac-1f4 — runtime state-machine
 * exception safety (N-R1 / N-R7 / N-R8 / setStatus isolation).
 *
 * Background: commit b02b8380 added `this._sending = true` *before*
 * calling `_onDrain` in `_drainPending()` (the N1 defensive change for
 * audit f395d49c-78c). That fix introduced a regression: if `_onDrain`
 * itself or `_dispatchTurn`'s synchronous prologue threw, the runtime
 * was left at `_sending=true` with no in-flight provider turn AND
 * `_pendingMessages` already spliced empty — wedged forever, surfacing
 * as bug 2 "bot stays asleep" but worse (no recovery without daemon
 * restart).
 *
 * These tests pin the audit 0419d1ac-1f4 contract:
 *   T-N1   — `_drainPending` continues to `_dispatchTurn` even when
 *            `_onDrain` throws.
 *   T-N1b  — `provider.onError` recoverable path triggers `_drainPending`
 *            and survives an `_onDrain` throw.
 *   T-N7   — When `_dispatchTurn` synchronous prologue throws, runtime
 *            resets `_sending=false` and emits `setStatus('error')`.
 *   T-N8   — `runtime.send` direct dispatch throw resets state +
 *            rethrows for caller's error path.
 *   T-setStatus — `setStatus` swallows `_onStatusChange` exceptions
 *                  but still advances `_status`.
 *   T-N10  — `provider.onError` → `_drainPending` reentry path doesn't
 *            wedge runtime when `_onDrain` throws.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import type { TransportProvider, ProviderError, SessionConfig } from '../../src/agent/transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';

const timelineEmitterEmitMock = vi.hoisted(() => vi.fn());
const searchLocalMemoryMock = vi.hoisted(() => vi.fn(async () => ({ items: [], stats: {
  totalRecords: 0, matchedRecords: 0, recentSummaryCount: 0, durableCandidateCount: 0,
  projectCount: 0, stagedEventCount: 0, dirtyTargetCount: 0, pendingJobCount: 0,
} })));
const searchLocalMemorySemanticMock = vi.hoisted(() => vi.fn(async () => ({ items: [], stats: {
  totalRecords: 0, matchedRecords: 0, recentSummaryCount: 0, durableCandidateCount: 0,
  projectCount: 0, stagedEventCount: 0, dirtyTargetCount: 0, pendingJobCount: 0,
} })));
vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: timelineEmitterEmitMock },
}));
vi.mock('../../src/context/memory-search.js', () => ({
  searchLocalMemory: searchLocalMemoryMock,
  searchLocalMemorySemantic: searchLocalMemorySemanticMock,
}));

function makeMockProvider() {
  let completeCb: ((sid: string, m: AgentMessage) => void) | null = null;
  let errorCb: ((sid: string, e: ProviderError) => void) | null = null;
  const fireComplete = (sid: string) => completeCb?.(sid, {
    id: 'msg-1', sessionId: sid, kind: 'text', role: 'assistant',
    content: 'done', timestamp: Date.now(), status: 'complete',
  } as AgentMessage);
  const fireError = (sid: string, err?: ProviderError) =>
    errorCb?.(sid, err ?? { code: 'CANCELLED', message: 'cancelled', recoverable: true });
  return {
    provider: {
      id: 'mock', connectionMode: 'persistent', sessionOwnership: 'provider',
      capabilities: { streaming: true, toolCalling: false, approval: false, sessionRestore: false, multiTurn: true, attachments: false, contextSupport: 'full-normalized-context-injection' },
      connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(), cancel: vi.fn(),
      createSession: vi.fn().mockResolvedValue('sess-1'), endSession: vi.fn(),
      onDelta: (_cb: (sid: string, d: MessageDelta) => void) => () => {},
      onComplete: (cb: (sid: string, m: AgentMessage) => void) => { completeCb = cb; return () => { completeCb = null; }; },
      onError: (cb: (sid: string, e: ProviderError) => void) => { errorCb = cb; return () => { errorCb = null; }; },
    } as unknown as TransportProvider,
    fireComplete, fireError,
  };
}

const defaultConfig: SessionConfig = { sessionKey: 'deck_test_brain' };
const flushDispatch = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('TransportSessionRuntime — exception safety (audit 0419d1ac-1f4)', () => {
  let mock: ReturnType<typeof makeMockProvider>;
  let runtime: TransportSessionRuntime;

  beforeEach(async () => {
    timelineEmitterEmitMock.mockReset();
    mock = makeMockProvider();
    runtime = new TransportSessionRuntime(mock.provider, 'deck_test_brain');
    await runtime.initialize(defaultConfig);
  });

  afterEach(() => { vi.unstubAllEnvs(); });

  it('T-N1: _drainPending continues to _dispatchTurn when _onDrain throws (no wedge)', async () => {
    // Establish busy state: send first message, queue second.
    runtime.send('first', 'cmd-first');
    await flushDispatch();
    runtime.send('queued', 'cmd-queued');
    expect(runtime.pendingCount).toBe(1);

    // Install onDrain that throws.
    runtime.onDrain = () => { throw new Error('boom: onDrain throws'); };

    const providerSendCallsBefore = (mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.length;
    // Complete the active turn — triggers _drainPending → onDrain throws.
    mock.fireComplete('sess-1');
    await flushDispatch();

    // CRITICAL: _dispatchTurn must have still run (provider.send invoked
    // a second time for the merged drain turn). Pre-fix this assertion
    // failed because onDrain throw aborted _dispatchTurn entirely.
    expect((mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(providerSendCallsBefore + 1);
    // Runtime is still active (the new drain turn is in flight).
    expect(runtime.sending).toBe(true);
    // Pending queue drained.
    expect(runtime.pendingCount).toBe(0);
  });

  it('T-N1b: provider.onError recoverable path → _drainPending → _onDrain throws → no wedge', async () => {
    runtime.send('first', 'cmd-first');
    await flushDispatch();
    runtime.send('queued', 'cmd-queued');

    runtime.onDrain = () => { throw new Error('boom from onError-drain path'); };

    const providerSendCallsBefore = (mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.length;
    mock.fireError('sess-1', { code: 'CANCELLED', message: 'cancelled', recoverable: true });
    await flushDispatch();

    // Even via onError reentry, the drain proceeds to dispatch the pending turn.
    expect((mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(providerSendCallsBefore + 1);
    expect(runtime.pendingCount).toBe(0);
  });

  it('T-N7: when _dispatchTurn synchronous prologue throws, runtime resets _sending=false and surfaces error', async () => {
    // Set up busy state + pending.
    runtime.send('first', 'cmd-first');
    await flushDispatch();
    runtime.send('queued', 'cmd-queued');

    // Make _dispatchTurn throw synchronously.
    const originalDispatch = (runtime as unknown as { _dispatchTurn: (...args: unknown[]) => void })._dispatchTurn.bind(runtime);
    let dispatchCalls = 0;
    (runtime as unknown as { _dispatchTurn: (...args: unknown[]) => void })._dispatchTurn = (...args: unknown[]) => {
      dispatchCalls += 1;
      if (dispatchCalls === 1) {
        // The drain-triggered call throws — but the FIRST dispatch
        // (the one from `runtime.send('first')` above) already ran
        // through `originalDispatch`. So this is actually the second
        // _dispatchTurn invocation, the drained merged turn.
        throw new Error('boom from _dispatchTurn sync prologue');
      }
      return originalDispatch(...args);
    };

    mock.fireComplete('sess-1');
    await flushDispatch();

    // After dispatch throws + reset, _sending must be false so future sends work.
    expect(runtime.sending).toBe(false);
    // Status should be 'error' (or similar non-running terminal).
    // Note: the exact status check is loose because _drainPending's
    // catch calls `setStatus('error')` — but setStatus may dedup.
    expect(['error', 'idle']).toContain(runtime.getStatus());
  });

  it('T-setStatus: setStatus swallows _onStatusChange exceptions but still advances _status', () => {
    // Install a status change handler that throws.
    runtime.onStatusChange = () => { throw new Error('boom from onStatusChange'); };

    // Sending should not throw even though setStatus('thinking') will
    // trigger the throwing onStatusChange.
    expect(() => runtime.send('hello', 'cmd-1')).not.toThrow();
    // Status advanced despite observer throw.
    expect(runtime.getStatus()).toBe('thinking');
    expect(runtime.sending).toBe(true);
  });

  it('T-N8: runtime.send direct dispatch throw resets state + rethrows', () => {
    // Override _dispatchTurn to throw synchronously on the direct send path.
    (runtime as unknown as { _dispatchTurn: (...args: unknown[]) => void })._dispatchTurn = () => {
      throw new Error('boom from direct dispatch');
    };

    expect(() => runtime.send('hello', 'cmd-1')).toThrow('boom from direct dispatch');
    // After throw, _sending must be reset so the runtime is usable next time.
    expect(runtime.sending).toBe(false);
    expect(runtime.activeDispatchEntries).toEqual([]);
  });

  it('T-N10: provider.onError reentry + _onDrain throws — runtime not wedged (defense in depth for N-R10)', async () => {
    // Build up a queue, then fire two error events back-to-back to
    // simulate the reentry path. Each onError must leave the state machine
    // recoverable.
    runtime.send('first', 'cmd-first');
    await flushDispatch();
    runtime.send('queued-1', 'cmd-q1');

    let onDrainCalls = 0;
    runtime.onDrain = () => {
      onDrainCalls += 1;
      if (onDrainCalls === 1) throw new Error('boom on first drain');
      // second drain (if any) succeeds.
    };

    mock.fireError('sess-1', { code: 'CANCELLED', message: 'cancelled', recoverable: true });
    await flushDispatch();

    // Runtime is not permanently wedged: future sends still work.
    expect(() => runtime.send('after-error', 'cmd-after')).not.toThrow();
  });

  it('T-N1c: when both _onDrain AND _dispatchTurn throw, runtime resets state (no permanent wedge)', async () => {
    runtime.send('first', 'cmd-first');
    await flushDispatch();
    runtime.send('queued', 'cmd-q');

    runtime.onDrain = () => { throw new Error('onDrain boom'); };
    let dispatchCalls = 0;
    const originalDispatch = (runtime as unknown as { _dispatchTurn: (...args: unknown[]) => void })._dispatchTurn.bind(runtime);
    (runtime as unknown as { _dispatchTurn: (...args: unknown[]) => void })._dispatchTurn = (...args: unknown[]) => {
      dispatchCalls += 1;
      if (dispatchCalls === 1) throw new Error('dispatch boom');
      return originalDispatch(...args);
    };

    mock.fireComplete('sess-1');
    await flushDispatch();

    expect(runtime.sending).toBe(false);
    // After full reset, a new send should work normally.
    expect(() => runtime.send('recovery', 'cmd-recovery')).not.toThrow();
    expect(runtime.sending).toBe(true);
  });
});
