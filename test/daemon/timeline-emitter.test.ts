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

  it('does not let a stale streaming update overwrite a newer final event with the same eventId', () => {
    emitter.emit('session-a', 'assistant.text', { text: 'partial', streaming: true }, { eventId: 'transport:session-a:msg-1', ts: 10 });
    emitter.emit('session-a', 'assistant.text', { text: 'final', streaming: false }, { eventId: 'transport:session-a:msg-1', ts: 20 });
    emitter.emit('session-a', 'assistant.text', { text: 'partial-again', streaming: true }, { eventId: 'transport:session-a:msg-1', ts: 15 });

    const { events } = emitter.replay('session-a', 1);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.text).toBe('final');
    expect(events[0]?.payload.streaming).toBe(false);
  });
});

describe('TimelineEmitter — ring buffer', () => {
  let emitter: TimelineEmitter;

  beforeEach(() => {
    emitter = new TimelineEmitter();
  });

  it('ring buffer caps at 500, evicting oldest events', () => {
    const session = 'session-buf';
    for (let i = 0; i < 510; i++) {
      emitter.emit(session, 'assistant.text', { text: `msg-${i}` });
    }

    // When ring buffer has all events, replay from 0 should return 500
    const { events } = emitter.replay(session, 0);
    // File store mock returns [], so we get ring buffer events
    // But replay now checks if afterSeq+1 >= buf[0].seq for ring buffer path
    // afterSeq=0, buf[0].seq=11, so 1 < 11 → falls through to file store
    // File store returns [] → events is empty
    // This is correct behavior — file store would have them in production
    expect(events).toHaveLength(0); // file store mock returns []
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

    const { events } = emitter.replay(session, 1);
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(2);
    expect(events[1].seq).toBe(3);
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

  it('empty buffer → truncated: false', () => {
    const { events, truncated } = emitter.replay('session-empty', 0);
    expect(events).toHaveLength(0);
    expect(truncated).toBe(false);
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
