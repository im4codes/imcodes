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

/**
 * Focused tests for TimelineEmitter.replay() logic.
 * The ring buffer caps at 500 events. When afterSeq is covered by the ring
 * buffer, it serves from memory. Otherwise, it falls back to the file store.
 */

describe('TimelineEmitter.replay — ring buffer path', () => {
  let emitter: TimelineEmitter;

  beforeEach(() => {
    emitter = new TimelineEmitter();
    vi.mocked(timelineStore.read).mockReturnValue([]);
  });

  it('normal replay: returns only events with seq > afterSeq', () => {
    const session = 'normal-replay';
    for (let i = 0; i < 10; i++) {
      emitter.emit(session, 'assistant.text', { text: `msg-${i + 1}` });
    }

    const { truncated, events } = emitter.replay(session, 5);
    expect(truncated).toBe(false);
    expect(events).toHaveLength(5);
    expect(events.map((e) => e.seq)).toEqual([6, 7, 8, 9, 10]);
  });

  it('exact match: afterSeq = last seq → empty events', () => {
    const session = 'exact-match';
    emitter.emit(session, 'session.state', { state: 'idle' });
    emitter.emit(session, 'assistant.text', { text: 'hello' });
    emitter.emit(session, 'assistant.text', { text: 'world' }); // seq 3

    const { truncated, events } = emitter.replay(session, 3);
    expect(truncated).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('afterSeq=0 with non-empty buffer → all events returned', () => {
    const session = 'from-zero';
    emitter.emit(session, 'user.message', { text: 'a' });
    emitter.emit(session, 'user.message', { text: 'b' });

    const { truncated, events } = emitter.replay(session, 0);
    expect(truncated).toBe(false);
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(1);
  });

  it('afterSeq exactly at buffer boundary → served from ring buffer', () => {
    const session = 'boundary';
    // 505 events → ring buffer holds seq 6–505
    for (let i = 0; i < 505; i++) {
      emitter.emit(session, 'assistant.text', { text: `x-${i}` });
    }

    // afterSeq=5 → afterSeq+1=6 = bufMinSeq → ring buffer path
    const { truncated, events } = emitter.replay(session, 5);
    expect(truncated).toBe(false);
    expect(events).toHaveLength(500);
  });

  it('replay preserves event order (seq ascending)', () => {
    const session = 'order-check';
    for (let i = 0; i < 5; i++) {
      emitter.emit(session, 'assistant.text', { text: `item-${i}` });
    }

    const { events } = emitter.replay(session, 0);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
    }
  });
});

describe('TimelineEmitter.replay — file store fallback', () => {
  let emitter: TimelineEmitter;

  beforeEach(() => {
    emitter = new TimelineEmitter();
    vi.mocked(timelineStore.read).mockReturnValue([]);
  });

  it('falls back to file store when afterSeq is before ring buffer range', () => {
    const session = 'fallback';
    // 510 events → ring buffer holds seq 11–510
    for (let i = 0; i < 510; i++) {
      emitter.emit(session, 'assistant.text', { text: `msg-${i}` });
    }

    // afterSeq=3 → ring buffer starts at 11, so falls to file store
    emitter.replay(session, 3);
    expect(timelineStore.read).toHaveBeenCalledWith(session, { epoch: emitter.epoch, afterSeq: 3 });
  });

  it('empty buffer falls back to file store', () => {
    emitter.replay('never-used', 5);
    expect(timelineStore.read).toHaveBeenCalledWith('never-used', { epoch: emitter.epoch, afterSeq: 5 });
  });

  it('empty buffer with afterSeq=0 returns empty (no file data)', () => {
    const { events, truncated } = emitter.replay('empty', 0);
    expect(events).toHaveLength(0);
    expect(truncated).toBe(false);
  });
});
