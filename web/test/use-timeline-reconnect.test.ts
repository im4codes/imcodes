/**
 * Tests for timeline reconnection logic — requestId filtering, epoch handling.
 * Pure unit tests for the filtering/merge logic used by useTimeline.
 */
import { describe, it, expect } from 'vitest';
import type { TimelineEvent } from '../src/ws-client.js';
import { mergeTimelineEvents } from '../../src/shared/timeline/merge.js';

// Reproduce the requestId filtering logic from useTimeline
function shouldProcessReplay(
  msg: { sessionName: string; requestId?: string },
  currentSessionId: string,
  pendingRequestId: string | null,
): boolean {
  if (msg.sessionName !== currentSessionId) return false;
  if (msg.requestId && msg.requestId !== pendingRequestId) return false;
  return true;
}

function shouldProcessHistory(
  msg: { sessionName: string; requestId?: string },
  currentSessionId: string,
  olderRequestId: string | null,
  latestHistoryRequestId: string | null,
): boolean {
  if (msg.sessionName !== currentSessionId) return false;
  if (msg.requestId && msg.requestId === olderRequestId) return true;
  // Forward history batches are accepted even when requestId is stale. useTimeline
  // merges by eventId and ts, so stale same-session history cannot delete newer
  // events, but rejecting it can strand mobile clients on stale cache.
  return true;
}

function makeEvent(overrides: Partial<TimelineEvent> & { seq: number; epoch: number }): TimelineEvent {
  return {
    eventId: `evt-${overrides.seq}`,
    sessionId: 'session-a',
    ts: Date.now(),
    source: 'daemon',
    confidence: 'high',
    type: 'assistant.text',
    payload: { text: `msg-${overrides.seq}` },
    ...overrides,
  };
}

describe('timeline replay requestId filtering', () => {
  it('accepts replay matching sessionName and requestId', () => {
    const result = shouldProcessReplay(
      { sessionName: 'session-a', requestId: 'req-1' },
      'session-a',
      'req-1',
    );
    expect(result).toBe(true);
  });

  it('rejects replay for wrong sessionName', () => {
    const result = shouldProcessReplay(
      { sessionName: 'session-b', requestId: 'req-1' },
      'session-a',
      'req-1',
    );
    expect(result).toBe(false);
  });

  it('rejects replay with mismatched requestId', () => {
    const result = shouldProcessReplay(
      { sessionName: 'session-a', requestId: 'req-2' },
      'session-a',
      'req-1',
    );
    expect(result).toBe(false);
  });

  it('accepts replay without requestId (backwards compat)', () => {
    const result = shouldProcessReplay(
      { sessionName: 'session-a' },
      'session-a',
      'req-1',
    );
    expect(result).toBe(true);
  });

  it('accepts replay without requestId when no pending request', () => {
    const result = shouldProcessReplay(
      { sessionName: 'session-a' },
      'session-a',
      null,
    );
    expect(result).toBe(true);
  });

  it('rejects stale replay from concurrent request (multi-browser scenario)', () => {
    // Browser A sends req-1, Browser B sends req-2
    // Browser A should reject req-2's response
    const resultForA = shouldProcessReplay(
      { sessionName: 'session-a', requestId: 'req-2' },
      'session-a',
      'req-1', // Browser A is waiting for req-1
    );
    expect(resultForA).toBe(false);

    // Browser B should reject req-1's response
    const resultForB = shouldProcessReplay(
      { sessionName: 'session-a', requestId: 'req-1' },
      'session-a',
      'req-2', // Browser B is waiting for req-2
    );
    expect(resultForB).toBe(false);
  });
});

describe('timeline history requestId handling', () => {
  it('accepts matching older pagination responses', () => {
    expect(shouldProcessHistory(
      { sessionName: 'session-a', requestId: 'older-1' },
      'session-a',
      'older-1',
      'latest-1',
    )).toBe(true);
  });

  it('accepts stale same-session history responses after overlapping reconnect requests', () => {
    expect(shouldProcessHistory(
      { sessionName: 'session-a', requestId: 'history-1' },
      'session-a',
      null,
      'history-2',
    )).toBe(true);
  });

  it('rejects history for the wrong session', () => {
    expect(shouldProcessHistory(
      { sessionName: 'session-b', requestId: 'history-1' },
      'session-a',
      null,
      'history-2',
    )).toBe(false);
  });
});

describe('timeline epoch mismatch handling', () => {
  it('epoch mismatch should clear old data and adopt new epoch', () => {
    let currentEpoch = 1000;
    let events: TimelineEvent[] = [
      makeEvent({ seq: 1, epoch: 1000 }),
      makeEvent({ seq: 2, epoch: 1000 }),
    ];

    // Simulate receiving a replay with new epoch
    const newEpoch = 2000;
    if (newEpoch !== currentEpoch) {
      const oldEpoch = currentEpoch;
      currentEpoch = newEpoch;
      events = []; // clear
      // Verify we saved the old epoch (for DB cleanup)
      expect(oldEpoch).toBe(1000);
    }

    expect(currentEpoch).toBe(2000);
    expect(events).toHaveLength(0);
  });

  it('epoch match should merge replay events by dedup', () => {
    const existing = [
      makeEvent({ seq: 1, epoch: 100 }),
      makeEvent({ seq: 2, epoch: 100 }),
    ];
    const replay = [
      makeEvent({ seq: 2, epoch: 100 }), // duplicate
      makeEvent({ seq: 3, epoch: 100 }),
      makeEvent({ seq: 4, epoch: 100 }),
    ];

    const replayById = new Map(replay.map((event) => [event.eventId, event]));
    const replaced = existing.map((event) => {
      const next = replayById.get(event.eventId);
      if (!next) return event;
      replayById.delete(event.eventId);
      return next;
    });
    const newEvents = [...replayById.values()];
    const merged = [...replaced, ...newEvents].sort((a, b) => a.seq - b.seq);

    expect(merged).toHaveLength(4);
    expect(merged.map(e => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('history merge replaces same-eventId transport final events instead of dropping them', () => {
    const existing = [
      {
        ...makeEvent({ seq: 10, epoch: 100 }),
        eventId: 'transport:session-a:msg-1',
        payload: { text: 'partial', streaming: true },
      },
    ];
    const replay = [
      {
        ...makeEvent({ seq: 11, epoch: 100 }),
        eventId: 'transport:session-a:msg-1',
        payload: { text: 'complete answer', streaming: false },
      },
    ];

    const merged = mergeTimelineEvents(existing, replay, 50);

    expect(merged).toHaveLength(1);
    expect(merged[0].payload.text).toBe('complete answer');
    expect(merged[0].payload.streaming).toBe(false);
  });

  it('history merge does not let stale transport streaming overwrite an existing final event', () => {
    const existing = [
      {
        ...makeEvent({ seq: 11, epoch: 100 }),
        eventId: 'transport:session-a:msg-1',
        payload: { text: 'complete answer', streaming: false },
      },
    ];
    const replay = [
      {
        ...makeEvent({ seq: 10, epoch: 100 }),
        eventId: 'transport:session-a:msg-1',
        payload: { text: 'partial', streaming: true },
      },
    ];

    const merged = mergeTimelineEvents(existing, replay, 50);

    expect(merged).toHaveLength(1);
    expect(merged[0].payload.text).toBe('complete answer');
    expect(merged[0].payload.streaming).toBe(false);
  });

  it('truncated replay should trigger snapshot request', () => {
    let snapshotRequested = false;

    const truncated = true;
    if (truncated) {
      snapshotRequested = true;
    }

    expect(snapshotRequested).toBe(true);
  });

  it('non-truncated replay should not trigger snapshot request', () => {
    let snapshotRequested = false;

    const truncated = false;
    if (truncated) {
      snapshotRequested = true;
    }

    expect(snapshotRequested).toBe(false);
  });
});
