/**
 * End-to-end integration tests for the transport message + queue pipeline
 * — the surface the user's `cae1de69-826` bug report explicitly targets:
 *
 *   1. "执行中发消息不经过队列直接输入" — message arrives mid-turn but
 *      bypasses the queue and gets dispatched immediately.
 *   2. "发消息发不到 SDK,机器人睡眠,不输出内容" — message sent but never
 *      reaches the provider.
 *   3. "队列没清空,新发的消息直接进聊天记录了" — pending queue still has
 *      entries but new sends commit to the timeline as if they're already
 *      sent.
 *
 * Existing test coverage:
 *   - `transport-resend-queue.test.ts` exercises the module-level queue
 *     (enqueueResend / drainResend) in isolation.
 *   - `transport-session-runtime.test.ts` exercises `runtime.send()` /
 *     `_dispatchTurn` / `_pendingMessages` / `_drainPending` in isolation.
 *   - `command-handler-transport-queue.test.ts` exercises `handleSend`
 *     with heavily mocked runtime collaborators.
 *
 * What is NOT covered anywhere:
 *   - The **interaction** between the resend queue and a real runtime:
 *     does `drainResend(name, (entry) => runtime.send(...))` correctly
 *     set `_sending=true` SYNCHRONOUSLY before any await yields, so the
 *     race window for bug 1+3 is structurally closed?
 *   - The full ordering guarantee across drainResend + `_drainPending`:
 *     entries that race past the synchronous prefix should end up
 *     merged into the next turn in FIFO order.
 *   - The new `await drainResend(...)` contract introduced by commit
 *     `60d3d04b`: when wired into a caller that awaits, the
 *     post-await world has `_sending=true` and all queued entries are
 *     in-flight or in `_pendingMessages`, so subsequent `handleSend`
 *     arrivals get queued correctly (not dispatched immediately).
 *
 * This file fills those gaps. Tests use the same lightweight mock
 * provider as `transport-session-runtime.test.ts` so we exercise the
 * real `TransportSessionRuntime` + real `drainResend` together.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import {
  clearAllResend,
  drainResend,
  enqueueResend,
  getResendCount,
} from '../../src/daemon/transport-resend-queue.js';
import type { TransportProvider, ProviderError, SessionConfig } from '../../src/agent/transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';

// Suppress timeline events — we don't assert on them here; transport
// runtime emits them as a side effect of provider.send() but we only
// care about the queue/dispatch order.
const timelineEmitterEmitMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: timelineEmitterEmitMock },
}));

// Memory search must be mocked or the runtime will try real DB lookups.
const searchLocalMemoryMock = vi.hoisted(() => vi.fn(async () => ({ items: [], stats: {
  totalRecords: 0, matchedRecords: 0, recentSummaryCount: 0, durableCandidateCount: 0,
  projectCount: 0, stagedEventCount: 0, dirtyTargetCount: 0, pendingJobCount: 0,
} })));
const searchLocalMemorySemanticMock = vi.hoisted(() => vi.fn(async () => ({ items: [], stats: {
  totalRecords: 0, matchedRecords: 0, recentSummaryCount: 0, durableCandidateCount: 0,
  projectCount: 0, stagedEventCount: 0, dirtyTargetCount: 0, pendingJobCount: 0,
} })));
vi.mock('../../src/context/memory-search.js', () => ({
  searchLocalMemory: searchLocalMemoryMock,
  searchLocalMemorySemantic: searchLocalMemorySemanticMock,
}));

// ── Mock provider factory (same shape as transport-session-runtime.test.ts) ──

function makeMockProvider(sessionId = 'sess-1') {
  let deltaCb: ((sid: string, d: MessageDelta) => void) | null = null;
  let completeCb: ((sid: string, m: AgentMessage) => void) | null = null;
  let errorCb: ((sid: string, e: ProviderError) => void) | null = null;

  const fireComplete = (sid: string, overrides: Partial<AgentMessage> = {}) =>
    completeCb?.(sid, {
      id: `msg-${Math.random().toString(16).slice(2, 6)}`,
      sessionId: sid,
      kind: 'text',
      role: 'assistant',
      content: 'done',
      timestamp: Date.now(),
      status: 'complete',
      ...overrides,
    } as AgentMessage);
  const fireError = (sid: string, err?: ProviderError) =>
    errorCb?.(sid, err ?? { code: 'PROVIDER_ERROR', message: 'err', recoverable: true });

  return {
    provider: {
      id: 'mock',
      connectionMode: 'persistent',
      sessionOwnership: 'provider',
      capabilities: {
        streaming: true, toolCalling: false, approval: false, sessionRestore: false,
        multiTurn: true, attachments: false, contextSupport: 'full-normalized-context-injection',
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
      send: vi.fn(),
      cancel: vi.fn(),
      createSession: vi.fn().mockResolvedValue(sessionId),
      endSession: vi.fn(),
      onDelta: (cb: (sid: string, d: MessageDelta) => void) => { deltaCb = cb; return () => { deltaCb = null; }; },
      onComplete: (cb: (sid: string, m: AgentMessage) => void) => { completeCb = cb; return () => { completeCb = null; }; },
      onError: (cb: (sid: string, e: ProviderError) => void) => { errorCb = cb; return () => { errorCb = null; }; },
    } as unknown as TransportProvider,
    fireComplete,
    fireError,
  };
}

const defaultConfig: SessionConfig = { sessionKey: 'deck_test_brain' };
const flushDispatch = async () => {
  // _dispatchTurn fires an inner `void (async () => { ... })()` that
  // awaits context-bootstrap + recall before calling provider.send.
  // Mirror the cadence used by transport-session-runtime.test.ts to
  // ensure provider.send actually fires.
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('transport message + queue integration (audit cae1de69-826)', () => {
  beforeEach(() => {
    clearAllResend();
    timelineEmitterEmitMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('drainResend ↔ runtime.send race-closure contract', () => {
    it('SYNCHRONOUSLY sets runtime._sending=true on the first dispatched entry — bug 1+3 race window is zero', async () => {
      /*
       * This is the regression that motivated the await-drainResend
       * defensive change. The claim verified across rounds 2-3 of the
       * audit (.imc/discussions/cae1de69-826.md) is:
       *
       *   By the time `void drainResend(...)` returns (i.e. the
       *   synchronous prefix has completed), `runtime._sending` is
       *   already TRUE because the dispatcher's first call to
       *   `runtime.send` synchronously invokes `_dispatchTurn` which
       *   synchronously sets `_sending = true`.
       *
       * If anyone refactors `drainResend` to await before the first
       * dispatch (or makes the dispatcher async without synchronous
       * prefix work), this test will catch it because msg-2 (sent
       * AFTER the unawaited drainResend call returns but BEFORE any
       * microtask yield) would see `_sending=false` and dispatch
       * directly — exactly the bug-1+3 race.
       */
      const mock = makeMockProvider();
      const runtime = new TransportSessionRuntime(mock.provider, 'deck_test_brain');
      await runtime.initialize(defaultConfig);

      enqueueResend('deck_test_brain', { text: 'queued-1', commandId: 'q1', queuedAt: Date.now() });

      const dispatched: string[] = [];
      // Fire-and-forget drainResend so we can inspect synchronous state.
      const drainPromise = drainResend('deck_test_brain', (entry) => {
        dispatched.push(entry.commandId);
        return runtime.send(entry.text, entry.commandId);
      });

      // The synchronous prefix of drainResend MUST have already run
      // the dispatcher for q1, which synchronously called runtime.send,
      // which synchronously set _sending=true via _dispatchTurn.
      expect(runtime.sending).toBe(true);
      expect(dispatched).toEqual(['q1']);

      // A new send arriving NOW (no await yield yet) sees _sending=true
      // and correctly queues into runtime._pendingMessages.
      const result = runtime.send('arrived-during-drain', 'r1');
      expect(result).toBe('queued');
      expect(runtime.pendingEntries).toEqual([
        { clientMessageId: 'r1', text: 'arrived-during-drain' },
      ]);

      await drainPromise;
      expect(getResendCount('deck_test_brain')).toBe(0);
    });

    it('keeps order: drained entry-1 dispatches, drained entry-2+ enter runtime._pendingMessages in FIFO order', async () => {
      /*
       * Pin the combined ordering contract: resend-queue FIFO is
       * preserved across the drain → runtime hand-off.
       */
      const mock = makeMockProvider();
      const runtime = new TransportSessionRuntime(mock.provider, 'deck_test_brain');
      await runtime.initialize(defaultConfig);

      enqueueResend('deck_test_brain', { text: 'first',  commandId: 'q1', queuedAt: Date.now() });
      enqueueResend('deck_test_brain', { text: 'second', commandId: 'q2', queuedAt: Date.now() });
      enqueueResend('deck_test_brain', { text: 'third',  commandId: 'q3', queuedAt: Date.now() });

      await drainResend('deck_test_brain', (entry) => runtime.send(entry.text, entry.commandId));

      // Only the first entry actually dispatched to the provider.
      expect(mock.provider.send).toHaveBeenCalledTimes(0);
      await flushDispatch();
      expect(mock.provider.send).toHaveBeenCalledTimes(1);
      expect((mock.provider.send as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({
        userMessage: 'first',
      });

      // q2 and q3 are queued in runtime, in order.
      expect(runtime.pendingEntries).toEqual([
        { clientMessageId: 'q2', text: 'second' },
        { clientMessageId: 'q3', text: 'third' },
      ]);
      expect(runtime.sending).toBe(true);
    });

    it('on turn complete, _drainPending merges remaining entries and dispatches them as one new turn', async () => {
      /*
       * The post-drain follow-through: after the active turn (q1)
       * completes, the runtime's _drainPending should fire one merged
       * turn carrying q2+q3 concatenated. This is the behavior
       * `transport-session-runtime.ts:223` (onComplete) + `_drainPending`
       * promise.
       */
      const mock = makeMockProvider();
      const runtime = new TransportSessionRuntime(mock.provider, 'deck_test_brain');
      await runtime.initialize(defaultConfig);

      enqueueResend('deck_test_brain', { text: 'first',  commandId: 'q1', queuedAt: Date.now() });
      enqueueResend('deck_test_brain', { text: 'second', commandId: 'q2', queuedAt: Date.now() });
      enqueueResend('deck_test_brain', { text: 'third',  commandId: 'q3', queuedAt: Date.now() });

      await drainResend('deck_test_brain', (entry) => runtime.send(entry.text, entry.commandId));
      await flushDispatch();
      expect(mock.provider.send).toHaveBeenCalledTimes(1);

      // Complete the active turn — _drainPending should fire next turn.
      mock.fireComplete('sess-1');
      await flushDispatch();

      expect(mock.provider.send).toHaveBeenCalledTimes(2);
      const secondPayload = (mock.provider.send as ReturnType<typeof vi.fn>).mock.calls[1][1] as Record<string, unknown>;
      // Merged into a single turn with newline separation, in FIFO order.
      expect(secondPayload.userMessage).toBe('second\n\nthird');
      expect(runtime.pendingCount).toBe(0);
    });
  });

  describe('concurrent send ordering — direct simulation of bug 1+3', () => {
    it('msg-2 arriving during an in-flight turn queues into runtime._pendingMessages, does NOT bypass to provider', async () => {
      const mock = makeMockProvider();
      const runtime = new TransportSessionRuntime(mock.provider, 'deck_test_brain');
      await runtime.initialize(defaultConfig);

      // msg-1: dispatched immediately.
      const r1 = runtime.send('msg-1', 'c1');
      expect(r1).toBe('sent');

      // Provider hasn't completed yet; _sending is true.
      expect(runtime.sending).toBe(true);

      // msg-2 arrives concurrently.
      const r2 = runtime.send('msg-2', 'c2');
      expect(r2).toBe('queued');
      expect(runtime.pendingEntries).toEqual([
        { clientMessageId: 'c2', text: 'msg-2' },
      ]);

      // msg-3 also queues.
      const r3 = runtime.send('msg-3', 'c3');
      expect(r3).toBe('queued');
      expect(runtime.pendingEntries).toEqual([
        { clientMessageId: 'c2', text: 'msg-2' },
        { clientMessageId: 'c3', text: 'msg-3' },
      ]);

      // Provider has seen ONLY msg-1 so far.
      await flushDispatch();
      expect(mock.provider.send).toHaveBeenCalledTimes(1);

      // Turn completes; msg-2 + msg-3 merge into next turn.
      mock.fireComplete('sess-1');
      await flushDispatch();

      expect(mock.provider.send).toHaveBeenCalledTimes(2);
      expect((mock.provider.send as ReturnType<typeof vi.fn>).mock.calls[1][1]).toMatchObject({
        userMessage: 'msg-2\n\nmsg-3',
      });
    });

    it('recoverable provider error → drain pending into the next turn, preserving order', async () => {
      const mock = makeMockProvider();
      const runtime = new TransportSessionRuntime(mock.provider, 'deck_test_brain');
      await runtime.initialize(defaultConfig);

      runtime.send('msg-1', 'c1');
      runtime.send('msg-2', 'c2');
      runtime.send('msg-3', 'c3');

      // Provider errors mid-turn; the error is marked recoverable so
      // pending entries should drain.
      mock.fireError('sess-1', { code: 'TRANSIENT', message: 'transient', recoverable: true });
      await flushDispatch();

      expect(mock.provider.send).toHaveBeenCalledTimes(2);
      expect((mock.provider.send as ReturnType<typeof vi.fn>).mock.calls[1][1]).toMatchObject({
        userMessage: 'msg-2\n\nmsg-3',
      });
    });
  });

  describe('await drainResend contract — full transfer before resolution', () => {
    it('all enqueued entries are visible to the runtime (in-flight or _pendingMessages) by the time the awaited drainResend resolves', async () => {
      /*
       * This is the contract the new `await drainResend(...)` in
       * `restoreTransportSessions` / `launchTransportSession`
       * (commit 60d3d04b) relies on. After the await resolves, the
       * resend queue is empty AND every entry is observable on the
       * runtime in some form (active turn payload + pending queue).
       */
      const mock = makeMockProvider();
      const runtime = new TransportSessionRuntime(mock.provider, 'deck_test_brain');
      await runtime.initialize(defaultConfig);

      const now = Date.now();
      enqueueResend('deck_test_brain', { text: 'a', commandId: 'qa', queuedAt: now });
      enqueueResend('deck_test_brain', { text: 'b', commandId: 'qb', queuedAt: now });
      enqueueResend('deck_test_brain', { text: 'c', commandId: 'qc', queuedAt: now });
      enqueueResend('deck_test_brain', { text: 'd', commandId: 'qd', queuedAt: now });

      const dispatched: string[] = [];
      const count = await drainResend('deck_test_brain', (entry) => {
        dispatched.push(entry.commandId);
        return runtime.send(entry.text, entry.commandId);
      });

      expect(count).toBe(4);
      expect(dispatched).toEqual(['qa', 'qb', 'qc', 'qd']);

      // Module-level resend queue is empty.
      expect(getResendCount('deck_test_brain')).toBe(0);

      // Active turn covers qa; rest are in runtime pending.
      expect(runtime.sending).toBe(true);
      expect(runtime.pendingEntries.map((e) => e.clientMessageId)).toEqual(['qb', 'qc', 'qd']);
    });

    it('drainResend dispatcher exceptions do not stop subsequent entries (queue empties; survivors reach runtime)', async () => {
      /*
       * `drainResend` has an internal try/catch around dispatch
       * (transport-resend-queue.ts:110-122) — a failing entry is
       * logged + dropped to avoid retry loops, and the rest continue.
       * This test guards that contract in conjunction with the new
       * outer `await` in session-manager.ts (which we DON'T want to
       * see the inner exceptions).
       */
      const mock = makeMockProvider();
      const runtime = new TransportSessionRuntime(mock.provider, 'deck_test_brain');
      await runtime.initialize(defaultConfig);

      enqueueResend('deck_test_brain', { text: 'good-1', commandId: 'g1', queuedAt: Date.now() });
      enqueueResend('deck_test_brain', { text: 'bad',    commandId: 'bad', queuedAt: Date.now() });
      enqueueResend('deck_test_brain', { text: 'good-2', commandId: 'g2', queuedAt: Date.now() });

      const dispatched: string[] = [];
      await drainResend('deck_test_brain', (entry) => {
        if (entry.commandId === 'bad') throw new Error('dispatcher fail');
        dispatched.push(entry.commandId);
        return runtime.send(entry.text, entry.commandId);
      });

      // Queue empty regardless of failure.
      expect(getResendCount('deck_test_brain')).toBe(0);
      // Successful entries dispatched (in order, skipping bad).
      expect(dispatched).toEqual(['g1', 'g2']);
      // Runtime took the first as in-flight, second as pending.
      expect(runtime.sending).toBe(true);
      expect(runtime.pendingEntries).toEqual([
        { clientMessageId: 'g2', text: 'good-2' },
      ]);
    });

    it('expired entries are dropped before dispatch — runtime is not polluted with stale messages', async () => {
      /*
       * `transport-resend-queue.ts:103-108` drops entries older than
       * RESEND_EXPIRY_MS. Verify the resulting runtime state doesn't
       * see the stale entry at all.
       */
      const mock = makeMockProvider();
      const runtime = new TransportSessionRuntime(mock.provider, 'deck_test_brain');
      await runtime.initialize(defaultConfig);

      const now = Date.now();
      // Far older than RESEND_EXPIRY_MS (default ~5 minutes — anything
      // 24h ago is safely past).
      enqueueResend('deck_test_brain', { text: 'stale', commandId: 'stale', queuedAt: now - 24 * 60 * 60 * 1000 });
      enqueueResend('deck_test_brain', { text: 'fresh', commandId: 'fresh', queuedAt: now });

      const dispatched: string[] = [];
      const count = await drainResend('deck_test_brain', (entry) => {
        dispatched.push(entry.commandId);
        return runtime.send(entry.text, entry.commandId);
      });

      expect(count).toBe(1);
      expect(dispatched).toEqual(['fresh']);
      expect(runtime.sending).toBe(true);
      expect(runtime.pendingCount).toBe(0);
    });
  });

  describe('full lifecycle: enqueue → drain → complete → re-enqueue → drain (regression for bug 2 partial recovery)', () => {
    it('a session can survive a drain-complete-redrain cycle without leaking pending state or duplicate dispatches', async () => {
      const mock = makeMockProvider();
      const runtime = new TransportSessionRuntime(mock.provider, 'deck_test_brain');
      await runtime.initialize(defaultConfig);

      // First cycle: enqueue 2, drain, complete.
      enqueueResend('deck_test_brain', { text: 'c1-msg-a', commandId: 'a1', queuedAt: Date.now() });
      enqueueResend('deck_test_brain', { text: 'c1-msg-b', commandId: 'b1', queuedAt: Date.now() });
      await drainResend('deck_test_brain', (entry) => runtime.send(entry.text, entry.commandId));
      await flushDispatch();
      expect(mock.provider.send).toHaveBeenCalledTimes(1);
      expect(runtime.pendingCount).toBe(1);

      mock.fireComplete('sess-1');                                  // completes a1
      await flushDispatch();
      expect(mock.provider.send).toHaveBeenCalledTimes(2);          // _drainPending fires b1

      mock.fireComplete('sess-1');                                  // completes b1
      await flushDispatch();
      expect(runtime.sending).toBe(false);
      expect(runtime.pendingCount).toBe(0);
      expect(getResendCount('deck_test_brain')).toBe(0);

      // Second cycle: same session, fresh enqueue + drain.
      enqueueResend('deck_test_brain', { text: 'c2-msg-a', commandId: 'a2', queuedAt: Date.now() });
      await drainResend('deck_test_brain', (entry) => runtime.send(entry.text, entry.commandId));
      await flushDispatch();
      expect(mock.provider.send).toHaveBeenCalledTimes(3);
      expect((mock.provider.send as ReturnType<typeof vi.fn>).mock.calls[2][1]).toMatchObject({
        userMessage: 'c2-msg-a',
      });
      expect(runtime.sending).toBe(true);
    });

    it('per-session isolation: drains for session A do not flush session B even if both have entries', async () => {
      /*
       * Module-level `queues: Map<sessionName, ...>` must remain
       * isolated. A regression here would let a clone-related drain
       * (e.g., session-group-clone running its first drain) wipe a
       * sibling session's queue.
       */
      const mockA = makeMockProvider('sess-A');
      const mockB = makeMockProvider('sess-B');
      const runtimeA = new TransportSessionRuntime(mockA.provider, 'deck_a_brain');
      const runtimeB = new TransportSessionRuntime(mockB.provider, 'deck_b_brain');
      await runtimeA.initialize({ sessionKey: 'deck_a_brain' });
      await runtimeB.initialize({ sessionKey: 'deck_b_brain' });

      enqueueResend('deck_a_brain', { text: 'a-msg', commandId: 'ax', queuedAt: Date.now() });
      enqueueResend('deck_b_brain', { text: 'b-msg-1', commandId: 'bx1', queuedAt: Date.now() });
      enqueueResend('deck_b_brain', { text: 'b-msg-2', commandId: 'bx2', queuedAt: Date.now() });

      // Drain only A.
      await drainResend('deck_a_brain', (entry) => runtimeA.send(entry.text, entry.commandId));

      // A drained, B intact.
      expect(getResendCount('deck_a_brain')).toBe(0);
      expect(getResendCount('deck_b_brain')).toBe(2);
      expect(runtimeA.sending).toBe(true);
      expect(runtimeB.sending).toBe(false);
      expect(mockB.provider.send).not.toHaveBeenCalled();
    });
  });
});
