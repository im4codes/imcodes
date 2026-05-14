/**
 * Bug 3 end-to-end regression (audit f395d49c-78c).
 *
 * User report: "队列没清空,新发的消息直接进聊天记录了" — the daemon was
 * queueing user messages internally, but the UI's authoritative queue
 * snapshot stayed frozen and new sends appeared in chat history as if
 * delivered. Round 1+2 of the multi-agent audit attributed this to the
 * web optimistic-UI reconciliation layer. Round 3 traced the actual
 * root cause to `TimelineEmitter.session.state` dedup at
 * `src/daemon/timeline-emitter.ts:51-60`, which compared ONLY the
 * `state` string. Consecutive `session.state {state:'queued',
 * pendingCount:N}` events with different snapshot payloads collapsed
 * into a single broadcast — the second and third updates never
 * reached handlers, so the web client never learned that the queue
 * had grown.
 *
 * This test wires a REAL `TimelineEmitter` (no module mock) and
 * verifies the end-to-end emission chain that `handleSend` produces
 * when a transport runtime is busy. If the NF1 dedup logic regresses
 * to a state-string-only comparison, this test fails immediately.
 *
 * Coverage anchors:
 *   - `src/daemon/timeline-emitter.ts:emit` — dedup gate must allow
 *     payload-mutation broadcasts.
 *   - `src/daemon/command-handler.ts:3348-3354` — queued emission shape
 *     (pendingCount + pendingMessages + pendingMessageEntries) is the
 *     contract this test mirrors.
 *
 * The test deliberately bypasses `handleSend` itself (which has many
 * orthogonal dependencies) and emits the same payload shape directly.
 * The dedup logic operates purely on emitter payload — bypassing
 * handleSend is sufficient and keeps the test focused.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/daemon/timeline-store.js', () => ({
  timelineStore: {
    append: vi.fn(),
    read: vi.fn(() => []),
    getLatest: vi.fn(() => null),
    truncate: vi.fn(),
    cleanup: vi.fn(),
  },
}));

import { TimelineEmitter } from '../../src/daemon/timeline-emitter.js';

describe('bug 3 end-to-end: queued session.state snapshots reach UI handler (audit f395d49c-78c)', () => {
  let emitter: TimelineEmitter;
  let received: Array<{ type: string; state: string; pendingCount?: number; entries?: Array<{ clientMessageId: string; text: string }> }>;

  beforeEach(() => {
    emitter = new TimelineEmitter();
    received = [];
    emitter.on((event) => {
      if (event.type !== 'session.state') return;
      const payload = event.payload as {
        state: string;
        pendingCount?: number;
        pendingMessageEntries?: Array<{ clientMessageId: string; text: string }>;
      };
      received.push({
        type: event.type,
        state: payload.state,
        pendingCount: payload.pendingCount,
        entries: payload.pendingMessageEntries,
      });
    });
  });

  it('T7: connecting 3 sends while runtime is busy produces 3 distinct queued events with pendingCount 1/2/3', () => {
    // Simulate the exact emission shape `handleSend` produces at
    // `command-handler.ts:3348-3354` when `runtime.send()` returns
    // 'queued' three times in a row. Each emission carries the
    // CURRENT snapshot of runtime.pendingEntries (growing as more
    // messages are queued).
    const sessionName = 'deck_bug3_brain';

    // After msg-1 arrives during an in-flight turn:
    emitter.emit(sessionName, 'session.state', {
      state: 'queued',
      pendingCount: 1,
      pendingMessages: ['msg-1'],
      pendingMessageEntries: [{ clientMessageId: 'cmd-1', text: 'msg-1' }],
    });
    // msg-2 arrives next:
    emitter.emit(sessionName, 'session.state', {
      state: 'queued',
      pendingCount: 2,
      pendingMessages: ['msg-1', 'msg-2'],
      pendingMessageEntries: [
        { clientMessageId: 'cmd-1', text: 'msg-1' },
        { clientMessageId: 'cmd-2', text: 'msg-2' },
      ],
    });
    // msg-3 arrives last:
    emitter.emit(sessionName, 'session.state', {
      state: 'queued',
      pendingCount: 3,
      pendingMessages: ['msg-1', 'msg-2', 'msg-3'],
      pendingMessageEntries: [
        { clientMessageId: 'cmd-1', text: 'msg-1' },
        { clientMessageId: 'cmd-2', text: 'msg-2' },
        { clientMessageId: 'cmd-3', text: 'msg-3' },
      ],
    });

    // Before the NF1 fix only the FIRST event would reach the handler.
    // After the fix all 3 reach with the right pendingCount progression.
    expect(received).toHaveLength(3);
    expect(received[0].pendingCount).toBe(1);
    expect(received[1].pendingCount).toBe(2);
    expect(received[2].pendingCount).toBe(3);
    expect(received[2].entries?.map((entry) => entry.clientMessageId)).toEqual([
      'cmd-1',
      'cmd-2',
      'cmd-3',
    ]);
  });

  it('T7b: drain-to-empty queued snapshot still reaches handler (running with pendingCount=0)', () => {
    // After `_drainPending` fires, daemon emits `{state:'running',
    // pendingCount:0, pendingMessageEntries:[]}`. Even though
    // `state==='running'` may match the previous broadcast, the
    // pending snapshot is authoritative and must reach handlers so
    // the UI can clear queue indicators.
    const sessionName = 'deck_bug3_drain_brain';

    emitter.emit(sessionName, 'session.state', { state: 'running' });
    emitter.emit(sessionName, 'session.state', {
      state: 'running',
      pendingCount: 0,
      pendingMessageEntries: [],
    });

    expect(received).toHaveLength(2);
    expect(received[0].pendingCount).toBeUndefined();
    expect(received[1].pendingCount).toBe(0);
    expect(received[1].entries).toEqual([]);
  });

  it('T7c: cross-session isolation — bug 3 fix does not let one session\'s emit reach another\'s handler accidentally', () => {
    // Defensive: confirm the dedup map remains per-session.
    const sessionA: typeof received = [];
    const sessionB: typeof received = [];
    const newEmitter = new TimelineEmitter();
    newEmitter.on((event) => {
      if (event.type !== 'session.state') return;
      const payload = event.payload as { state: string; pendingCount?: number };
      const entry = { type: event.type, state: payload.state, pendingCount: payload.pendingCount };
      if (event.sessionId === 'deck_a') sessionA.push(entry);
      if (event.sessionId === 'deck_b') sessionB.push(entry);
    });

    newEmitter.emit('deck_a', 'session.state', { state: 'queued', pendingCount: 1 });
    newEmitter.emit('deck_b', 'session.state', { state: 'queued', pendingCount: 5 });
    newEmitter.emit('deck_a', 'session.state', { state: 'queued', pendingCount: 2 });
    newEmitter.emit('deck_b', 'session.state', { state: 'queued', pendingCount: 6 });

    expect(sessionA.map((entry) => entry.pendingCount)).toEqual([1, 2]);
    expect(sessionB.map((entry) => entry.pendingCount)).toEqual([5, 6]);
  });
});
