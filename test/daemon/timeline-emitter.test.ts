import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the timeline store to avoid file I/O in tests
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
import { timelineStore } from '../../src/daemon/timeline-store.js';
import { TIMELINE_RESPONSE_SOURCES } from '../../shared/timeline-protocol.js';

describe('TimelineEmitter — seq counter', () => {
  let emitter: TimelineEmitter;

  beforeEach(() => {
    emitter = new TimelineEmitter();
    vi.mocked(timelineStore.append).mockClear();
  });

  it('seq is monotonically increasing per session', () => {
    const e1 = emitter.emit('session-a', 'assistant.text', { text: 'hello' });
    const e2 = emitter.emit('session-a', 'assistant.text', { text: 'world' });
    const e3 = emitter.emit('session-a', 'session.state', { state: 'idle' });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e3.seq).toBe(3);
  });

  it('different sessions have independent seq counters', () => {
    const a1 = emitter.emit('session-a', 'assistant.text', { text: 'hi' });
    const b1 = emitter.emit('session-b', 'assistant.text', { text: 'hello' });
    const a2 = emitter.emit('session-a', 'session.state', { state: 'idle' });
    const b2 = emitter.emit('session-b', 'session.state', { state: 'idle' });

    expect(a1.seq).toBe(1);
    expect(a2.seq).toBe(2);
    expect(b1.seq).toBe(1);
    expect(b2.seq).toBe(2);
  });

  it('emitted event contains expected fields', () => {
    const event = emitter.emit('session-x', 'user.message', { text: 'test' }, {
      source: 'hook',
      confidence: 'medium',
    });
    expect(event.sessionId).toBe('session-x');
    expect(event.type).toBe('user.message');
    expect(event.payload).toEqual({ text: 'test' });
    expect(event.source).toBe('hook');
    expect(event.confidence).toBe('medium');
    expect(event.epoch).toBe(emitter.epoch);
    expect(typeof event.eventId).toBe('string');
    expect(event.eventId).toHaveLength(24); // sha1 hex prefix
  });

  it('preserves hidden events when requested', () => {
    const event = emitter.emit('session-hidden', 'tool.call', { tool: 'Edit' }, { hidden: true });
    expect(event?.hidden).toBe(true);
  });

  it('defaults source to daemon and confidence to high', () => {
    const event = emitter.emit('session-x', 'session.state', { state: 'idle' });
    expect(event.source).toBe('daemon');
    expect(event.confidence).toBe('high');
  });

  it('appends each event to timeline store', () => {
    emitter.emit('session-a', 'user.message', { text: 'hi' });
    emitter.emit('session-a', 'assistant.text', { text: 'hello' });
    expect(timelineStore.append).toHaveBeenCalledTimes(2);
  });

  it('preserves repeated user messages when allowDuplicate is set', () => {
    emitter.emit('session-a', 'user.message', { text: 'retry', allowDuplicate: true }, { ts: 10 });
    emitter.emit('session-a', 'user.message', { text: 'retry', allowDuplicate: true }, { ts: 20 });

    const { events } = emitter.replay('session-a', 0);
    expect(events).toHaveLength(2);
    expect(events[0]?.payload.text).toBe('retry');
    expect(events[1]?.payload.text).toBe('retry');
  });

  it('still suppresses duplicate user messages without allowDuplicate', () => {
    emitter.emit('session-a', 'user.message', { text: 'retry' }, { ts: 10 });
    emitter.emit('session-a', 'user.message', { text: 'retry' }, { ts: 20 });

    const { events } = emitter.replay('session-a', 0);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.text).toBe('retry');
  });


  it('marks pure API failure assistant text as non-memory answer text at emit time', () => {
    const event = emitter.emit('session-a', 'assistant.text', {
      text: '[API Error: Connection error. (cause: fetch failed)]',
      streaming: false,
    });
    expect(event?.payload.memoryExcluded).toBe(true);
    expect(event?.payload.assistantKind).toBe('error');
  });

  it('does not let a stale streaming update overwrite a newer final event with the same eventId', () => {
    emitter.emit('session-a', 'assistant.text', { text: 'partial', streaming: true }, { eventId: 'transport:session-a:msg-1', ts: 10 });
    emitter.emit('session-a', 'assistant.text', { text: 'final', streaming: false }, { eventId: 'transport:session-a:msg-1', ts: 20 });
    emitter.emit('session-a', 'assistant.text', { text: 'partial-again', streaming: true }, { eventId: 'transport:session-a:msg-1', ts: 15 });

    const { events } = emitter.replay('session-a', 1);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.text).toBe('final');
    expect(events[0]?.payload.streaming).toBe(false);
  });

  it('anchors a stable-eventId event to its first-seen ts so a late terminal update keeps timeline order', () => {
    // Streaming assistant text starts at ts=100.
    const first = emitter.emit('session-anchor', 'assistant.text', { text: 'partial', streaming: true }, { eventId: 'transport:session-anchor:msg-1', ts: 100 });
    expect(first.ts).toBe(100);
    // User presses Stop and immediately sends a new message that lands at ts=150.
    emitter.emit('session-anchor', 'user.message', { text: 'next question' }, { ts: 150 });
    // The stop-settle "⚠️ Turn cancelled" only arrives (delayed) at ts=200. It
    // reuses the assistant eventId and MUST NOT be stamped 200 — otherwise it
    // sorts after the ts=150 user message and their order flips in the UI.
    const cancelled = emitter.emit('session-anchor', 'assistant.text', { text: 'partial\n\n⚠️ Turn cancelled', streaming: false }, { eventId: 'transport:session-anchor:msg-1', ts: 200 });
    expect(cancelled.ts).toBe(100); // anchored to first-seen, NOT bumped to 200

    // Display order is by ts (then seq): the cancelled assistant (100) sorts
    // BEFORE the user message (150), matching what the user expects.
    const { events } = emitter.replay('session-anchor', 0);
    const byTs = [...events].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    const assistantIdx = byTs.findIndex((e) => e.type === 'assistant.text');
    const userIdx = byTs.findIndex((e) => e.type === 'user.message');
    expect(assistantIdx).toBeLessThan(userIdx);
    expect(byTs[assistantIdx]?.ts).toBe(100);
    expect(String(byTs[assistantIdx]?.payload.text)).toContain('Turn cancelled');
  });
});

describe('TimelineEmitter — ring buffer', () => {
  let emitter: TimelineEmitter;

  beforeEach(() => {
    emitter = new TimelineEmitter();
  });

  it('ring buffer caps at 500, evicting oldest events and merging with file store', () => {
    const session = 'session-buf';
    for (let i = 0; i < 510; i++) {
      emitter.emit(session, 'assistant.text', { text: `msg-${i}` });
    }

    // Buffer holds the last 500 events (seq 11..510). When replay falls
    // back to the slow path (afterSeq=0 < buf[0].seq=11) it now MERGES
    // the JSONL tail with any still-in-buffer events — the latter
    // covers async-append in-flight writes (PR-A C1). With the mocked
    // file store returning [], we get exactly the 500 buffer events.
    const { events } = emitter.replay(session, 0);
    expect(events).toHaveLength(500);
    expect(events[0]?.seq).toBe(11);
    expect(events[events.length - 1]?.seq).toBe(510);
  });

  it('buffers for different sessions do not interfere', () => {
    for (let i = 0; i < 3; i++) {
      emitter.emit('session-a', 'assistant.text', { text: `a-${i}` });
    }
    emitter.emit('session-b', 'user.message', { text: 'only-one' });

    const { events: bEvents } = emitter.replay('session-b', 0);
    expect(bEvents).toHaveLength(1);
    expect(bEvents[0].payload.text).toBe('only-one');
  });
});

describe('TimelineEmitter — replay', () => {
  let emitter: TimelineEmitter;

  beforeEach(() => {
    emitter = new TimelineEmitter();
    vi.mocked(timelineStore.read).mockReturnValue([]);
  });

  it('replay returns only events with seq > afterSeq from ring buffer', () => {
    const session = 'session-replay';
    emitter.emit(session, 'assistant.text', { text: 'one' });   // seq 1
    emitter.emit(session, 'assistant.text', { text: 'two' });   // seq 2
    emitter.emit(session, 'assistant.text', { text: 'three' }); // seq 3

    const { events, source } = emitter.replay(session, 1);
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(2);
    expect(events[1].seq).toBe(3);
    expect(source).toBe(TIMELINE_RESPONSE_SOURCES.RING_BUFFER);
  });

  it('replay with afterSeq=0 returns all events', () => {
    const session = 'session-all';
    emitter.emit(session, 'assistant.text', { text: 'a' });
    emitter.emit(session, 'assistant.text', { text: 'b' });

    const { events } = emitter.replay(session, 0);
    expect(events).toHaveLength(2);
  });

  it('replay with afterSeq equal to last seq returns empty events', () => {
    const session = 'session-last';
    emitter.emit(session, 'session.state', { state: 'idle' }); // seq 1

    const { events, truncated } = emitter.replay(session, 1);
    expect(events).toHaveLength(0);
    expect(truncated).toBe(false);
  });

  it('falls back to file store when ring buffer does not cover afterSeq', () => {
    const session = 'session-fallback';
    // Emit 510 events so ring buffer starts at seq 11
    for (let i = 0; i < 510; i++) {
      emitter.emit(session, 'assistant.text', { text: `msg-${i}` });
    }

    // afterSeq=5 → ring buffer starts at 11, so falls to file store
    emitter.replay(session, 5);
    expect(timelineStore.read).toHaveBeenCalledWith(session, { epoch: emitter.epoch, afterSeq: 5 });
  });

  it('marks replay slow path as mixed when JSONL tail and ring buffer both contribute', () => {
    const session = 'session-mixed';
    for (let i = 0; i < 510; i++) {
      emitter.emit(session, 'assistant.text', { text: `msg-${i}` });
    }
    vi.mocked(timelineStore.read).mockReturnValueOnce([
      {
        eventId: 'jsonl-6',
        sessionId: session,
        ts: 6,
        seq: 6,
        epoch: emitter.epoch,
        source: 'daemon',
        confidence: 'high',
        type: 'assistant.text',
        payload: { text: 'from jsonl' },
      },
    ]);

    const result = emitter.replay(session, 5);

    expect(result.source).toBe(TIMELINE_RESPONSE_SOURCES.RING_BUFFER_JSONL);
    expect(result.events[0]?.eventId).toBe('jsonl-6');
    expect(result.events.at(-1)?.seq).toBe(510);
  });

  it('empty buffer → truncated: false', () => {
    const { events, truncated, source } = emitter.replay('session-empty', 0);
    expect(events).toHaveLength(0);
    expect(truncated).toBe(false);
    expect(source).toBe(TIMELINE_RESPONSE_SOURCES.JSONL_TAIL);
  });

  it('empty buffer with positive afterSeq → falls to file store', () => {
    emitter.replay('session-empty', 5);
    expect(timelineStore.read).toHaveBeenCalledWith('session-empty', { epoch: emitter.epoch, afterSeq: 5 });
  });
});

describe('TimelineEmitter — on/off handlers', () => {
  it('calls registered handler on emit', () => {
    const emitter = new TimelineEmitter();
    const received: unknown[] = [];
    emitter.on((e) => received.push(e));

    emitter.emit('session-h', 'session.state', { state: 'idle' });
    expect(received).toHaveLength(1);
  });

  it('stops calling handler after unsubscribe', () => {
    const emitter = new TimelineEmitter();
    const received: unknown[] = [];
    const unsub = emitter.on((e) => received.push(e));
    unsub();

    emitter.emit('session-h', 'session.state', { state: 'idle' });
    expect(received).toHaveLength(0);
  });
});

/**
 * NF1 regression suite (audit f395d49c-78c).
 *
 * Before the fix, `session.state` dedup compared only the `state` string,
 * so successive `{state:'queued', pendingCount:1}`, `{state:'queued',
 * pendingCount:2}`, `{state:'queued', pendingCount:3}` events broadcast
 * only the first — UI saw stale queue counts. Bug 3 ("queue not empty
 * but new messages appear in chat history") manifested because the
 * daemon was queueing but the UI's authoritative queue snapshot stayed
 * frozen at pendingCount=1.
 *
 * These tests pin the fixed contract:
 *   T1 — structured queue fields MUST all reach handlers.
 *   T2 — plain idle/running events (no payload mutation) ARE still deduped.
 *   T2b — events with `error` payload are NEVER deduped.
 */
describe('TimelineEmitter — session.state queue snapshot dedup (NF1 regression)', () => {
  it('T1: successive queued events with changing structured queue entries all reach handlers', () => {
    const emitter = new TimelineEmitter();
    const received: Array<Record<string, unknown>> = [];
    emitter.on((e) => {
      if (e.type === 'session.state') received.push(e.payload as Record<string, unknown>);
    });

    emitter.emit('session-q', 'session.state', { state: 'queued', pendingCount: 1, pendingMessageEntries: [{ clientMessageId: 'a', text: 'a' }] });
    emitter.emit('session-q', 'session.state', { state: 'queued', pendingCount: 2, pendingMessageEntries: [{ clientMessageId: 'a', text: 'a' }, { clientMessageId: 'b', text: 'b' }] });
    emitter.emit('session-q', 'session.state', { state: 'queued', pendingCount: 3, pendingMessageEntries: [{ clientMessageId: 'a', text: 'a' }, { clientMessageId: 'b', text: 'b' }, { clientMessageId: 'c', text: 'c' }] });

    expect(received).toHaveLength(3);
    expect(received[0].pendingCount).toBe(1);
    expect(received[1].pendingCount).toBe(2);
    expect(received[2].pendingCount).toBe(3);
  });

  it('T1b: queued events that only carry the state string are deduped', () => {
    const emitter = new TimelineEmitter();
    const received: Array<Record<string, unknown>> = [];
    emitter.on((e) => { if (e.type === 'session.state') received.push(e.payload as Record<string, unknown>); });

    emitter.emit('session-q', 'session.state', { state: 'queued' });
    emitter.emit('session-q', 'session.state', { state: 'queued' });
    expect(received).toHaveLength(1);
  });

  it('T1c: legacy pendingCount and text arrays do not bypass same-state dedup', () => {
    const emitter = new TimelineEmitter();
    const received: Array<Record<string, unknown>> = [];
    emitter.on((e) => { if (e.type === 'session.state') received.push(e.payload as Record<string, unknown>); });

    emitter.emit('session-legacy', 'session.state', { state: 'queued', pendingCount: 1, pendingMessages: ['a'], transportPendingMessages: ['a'] });
    emitter.emit('session-legacy', 'session.state', { state: 'queued', pendingCount: 2, pendingMessages: ['a', 'b'], transportPendingMessages: ['a', 'b'] });
    expect(received).toHaveLength(1);
    expect(received[0].pendingCount).toBe(1);
  });

  it('T2: successive idle (or running) events with no payload mutation are still deduped (avoid UI flicker)', () => {
    const emitter = new TimelineEmitter();
    const received: Array<Record<string, unknown>> = [];
    emitter.on((e) => {
      if (e.type === 'session.state') received.push(e.payload as Record<string, unknown>);
    });

    emitter.emit('session-i', 'session.state', { state: 'idle' });
    emitter.emit('session-i', 'session.state', { state: 'idle' });
    emitter.emit('session-i', 'session.state', { state: 'idle' });
    // Only the first idle reaches the handler — original dedup intact for
    // payloads that don't carry a queue snapshot or error.
    expect(received).toHaveLength(1);

    emitter.emit('session-r', 'session.state', { state: 'running' });
    emitter.emit('session-r', 'session.state', { state: 'running' });
    expect(received.filter((p) => p.state === 'running')).toHaveLength(1);
  });

  it('T2e: visible activity after idle allows the following idle to reach the UI', () => {
    const emitter = new TimelineEmitter();
    const received: Array<Record<string, unknown>> = [];
    emitter.on((e) => {
      if (e.type === 'session.state') received.push(e.payload as Record<string, unknown>);
    });

    emitter.emit('session-auto-tail', 'session.state', { state: 'idle' });
    emitter.emit('session-auto-tail', 'assistant.text', { text: 'auto-continue tail', streaming: false });
    emitter.emit('session-auto-tail', 'session.state', { state: 'idle' });
    emitter.emit('session-tool-tail', 'session.state', { state: 'idle' });
    emitter.emit('session-tool-tail', 'tool.result', { output: 'done' });
    emitter.emit('session-tool-tail', 'session.state', { state: 'idle' });

    expect(received.filter((p) => p.state === 'idle')).toHaveLength(4);
  });

  it('T2b: any session.state event carrying an `error` field bypasses dedup so failure updates always reach the UI', () => {
    const emitter = new TimelineEmitter();
    const received: Array<Record<string, unknown>> = [];
    emitter.on((e) => { if (e.type === 'session.state') received.push(e.payload as Record<string, unknown>); });

    emitter.emit('session-e', 'session.state', { state: 'idle' });
    emitter.emit('session-e', 'session.state', { state: 'idle', error: 'transient' });
    emitter.emit('session-e', 'session.state', { state: 'idle', error: 'transient' });
    // First idle broadcast; second + third have error payloads so both pass.
    expect(received).toHaveLength(3);
    expect(received[1].error).toBe('transient');
    expect(received[2].error).toBe('transient');
  });

  it('T2c: pendingMessageEntries as empty array is still treated as a snapshot (drain-to-zero broadcast)', () => {
    // After a drain, daemon emits `session.state {state:'running',
    // pendingMessageEntries:[]}` to tell the UI the queue is empty. The dedup
    // gate must NOT silently swallow that just because `state` happens to
    // match the previous one.
    const emitter = new TimelineEmitter();
    const received: Array<Record<string, unknown>> = [];
    emitter.on((e) => { if (e.type === 'session.state') received.push(e.payload as Record<string, unknown>); });

    emitter.emit('session-d', 'session.state', { state: 'running' });
    emitter.emit('session-d', 'session.state', { state: 'running', pendingMessageEntries: [] });
    expect(received).toHaveLength(2);
    expect(received[1].pendingMessageEntries).toEqual([]);
  });

  it('T2d: structured queue epoch/version fields bypass same-state dedup', () => {
    const emitter = new TimelineEmitter();
    const received: Array<Record<string, unknown>> = [];
    emitter.on((e) => { if (e.type === 'session.state') received.push(e.payload as Record<string, unknown>); });

    emitter.emit('session-newq', 'session.state', { state: 'running' });
    emitter.emit('session-newq', 'session.state', {
      state: 'running',
      queueEpoch: 'epoch-1',
      queueAuthorityId: 'authority-1',
      transportPendingMessageVersion: 1,
      transportPendingMessageEntries: [{ clientMessageId: 'a', text: 'a' }],
      failedMessageEntries: [],
    });
    emitter.emit('session-newq', 'session.state', {
      state: 'running',
      queueEpoch: 'epoch-1',
      queueAuthorityId: 'authority-1',
      transportPendingMessageVersion: 2,
      transportPendingMessageEntries: [],
      failedMessageEntries: [{ clientMessageId: 'a', text: 'failed' }],
    });

    expect(received).toHaveLength(3);
    expect(received[1].transportPendingMessageVersion).toBe(1);
    expect(received[2].transportPendingMessageVersion).toBe(2);
    expect(received[2].failedMessageEntries).toEqual([{ clientMessageId: 'a', text: 'failed' }]);
  });
});

describe('TimelineEmitter — forgetSession (frees per-session memory on teardown)', () => {
  let emitter: TimelineEmitter;

  beforeEach(() => {
    emitter = new TimelineEmitter();
    vi.mocked(timelineStore.read).mockReturnValue([]);
  });

  it('drops the ring buffer AND resets the seq counter for a forgotten session', () => {
    emitter.emit('session-gone', 'assistant.text', { text: 'one' });
    emitter.emit('session-gone', 'assistant.text', { text: 'two' });
    // Served from the in-memory ring buffer while the session is alive.
    expect(emitter.replay('session-gone', 0).events).toHaveLength(2);

    emitter.forgetSession('session-gone');

    // Buffer freed + on-disk store (mocked empty) → nothing to replay.
    expect(emitter.replay('session-gone', 0).events).toHaveLength(0);
    // seq restarts at 1 — proves seqMap (not just the buffer) was cleared,
    // so a later same-named session can't inherit a stale high-water seq.
    expect(emitter.emit('session-gone', 'assistant.text', { text: 'reborn' }).seq).toBe(1);
  });

  it('forgetting one session leaves other sessions untouched', () => {
    emitter.emit('session-gone', 'assistant.text', { text: 'a' });
    emitter.emit('session-keep', 'assistant.text', { text: 'b' });
    emitter.emit('session-keep', 'assistant.text', { text: 'c' });

    emitter.forgetSession('session-gone');

    expect(emitter.replay('session-gone', 0).events).toHaveLength(0);
    expect(emitter.replay('session-keep', 0).events).toHaveLength(2);
    // The surviving session keeps counting from where it was.
    expect(emitter.emit('session-keep', 'session.state', { state: 'idle' }).seq).toBe(3);
  });

  it('clears the duplicate-user-message dedup state for the forgotten session', () => {
    emitter.emit('session-gone', 'user.message', { text: 'retry' }, { ts: 10 });
    emitter.forgetSession('session-gone');
    // Without forgetSession the recentUserMsg dedup would suppress this as a
    // duplicate; after forgetting, it must be treated as a fresh message.
    emitter.emit('session-gone', 'user.message', { text: 'retry' }, { ts: 20 });
    expect(emitter.replay('session-gone', 0).events).toHaveLength(1);
  });
});

describe('TimelineEmitter — global message delete (hidden re-emit)', () => {
  let emitter: TimelineEmitter;

  beforeEach(() => {
    emitter = new TimelineEmitter();
    vi.mocked(timelineStore.read).mockReturnValue([]);
  });

  it('re-emitting an event verbatim with hidden:true wins the same-eventId merge and hides it', () => {
    const original = emitter.emit('session-x', 'assistant.text', { text: 'secret' });
    expect(original).toBeTruthy();
    // Sanity: visible (not hidden) before deletion.
    const before = emitter.replay('session-x', 0).events.find((e) => e.eventId === original!.eventId);
    expect(before?.hidden).toBeFalsy();

    // Delete = re-emit the exact event with hidden:true. The fresh higher seq wins.
    emitter.emit('session-x', original!.type, original!.payload, {
      eventId: original!.eventId,
      hidden: true,
    });

    // Still exactly one logical event for that eventId — now hidden (the renderer drops it).
    const matches = emitter.replay('session-x', 0).events.filter((e) => e.eventId === original!.eventId);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.hidden).toBe(true);
  });

  it('the hidden re-emit is persisted (appended) so the deletion survives restart/refresh', () => {
    vi.mocked(timelineStore.append).mockClear();
    const original = emitter.emit('session-y', 'tool.call', { tool: 'Edit' });
    emitter.emit('session-y', original!.type, original!.payload, { eventId: original!.eventId, hidden: true });
    // The final append carries hidden:true (durable via JSONL + SQLite hidden column).
    const appended = vi.mocked(timelineStore.append).mock.calls.map((c) => c[0]);
    const lastForEvent = appended.reverse().find((e) => e.eventId === original!.eventId);
    expect(lastForEvent?.hidden).toBe(true);
  });
});
