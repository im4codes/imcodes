import { describe, it, expect, beforeEach } from 'vitest';
import { TimelineDB } from '../src/timeline-db.js';
import type { TimelineEvent } from '../src/ws-client.js';

/**
 * Tests for TimelineDB using the memory fallback mode.
 * IndexedDB is unavailable in the vitest/jsdom environment, so TimelineDB
 * degrades gracefully to in-memory storage after open() fails.
 */

function makeEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    sessionId: 'session-a',
    ts: Date.now(),
    seq: 1,
    epoch: 1000,
    source: 'daemon',
    confidence: 'high',
    type: 'assistant.text',
    payload: { text: 'hello' },
    ...overrides,
  };
}

describe('TimelineDB — memory fallback mode', () => {
  let db: TimelineDB;

  beforeEach(async () => {
    db = new TimelineDB();
    // open() will fail (no IndexedDB in jsdom) and set _memoryOnly = true
    await db.open();
  });

  it('operates in memory-only mode when IndexedDB is unavailable', () => {
    expect(db.memoryOnly).toBe(true);
  });

  it('putEvent and getEvents work in memory mode', async () => {
    const event = makeEvent({ seq: 1, epoch: 100 });
    await db.putEvent(event);

    const results = await db.getEvents('session-a', 100);
    expect(results).toHaveLength(1);
    expect(results[0].eventId).toBe(event.eventId);
  });

  it('getEvents filters by sessionId', async () => {
    await db.putEvent(makeEvent({ sessionId: 'session-a', seq: 1, epoch: 100, eventId: 'a1' }));
    await db.putEvent(makeEvent({ sessionId: 'session-b', seq: 1, epoch: 100, eventId: 'b1' }));

    const resultsA = await db.getEvents('session-a', 100);
    expect(resultsA).toHaveLength(1);
    expect(resultsA[0].eventId).toBe('a1');

    const resultsB = await db.getEvents('session-b', 100);
    expect(resultsB).toHaveLength(1);
    expect(resultsB[0].eventId).toBe('b1');
  });

  it('getEvents filters by epoch', async () => {
    await db.putEvent(makeEvent({ seq: 1, epoch: 100, eventId: 'old' }));
    await db.putEvent(makeEvent({ seq: 1, epoch: 200, eventId: 'new' }));

    const results = await db.getEvents('session-a', 200);
    expect(results).toHaveLength(1);
    expect(results[0].eventId).toBe('new');
  });

  it('getEvents respects afterSeq option', async () => {
    await db.putEvent(makeEvent({ seq: 1, epoch: 100, eventId: 'e1' }));
    await db.putEvent(makeEvent({ seq: 2, epoch: 100, eventId: 'e2' }));
    await db.putEvent(makeEvent({ seq: 3, epoch: 100, eventId: 'e3' }));

    const results = await db.getEvents('session-a', 100, { afterSeq: 1 });
    expect(results).toHaveLength(2);
    expect(results.map((e) => e.seq)).toEqual([2, 3]);
  });

  it('getEvents respects limit option', async () => {
    for (let i = 1; i <= 5; i++) {
      await db.putEvent(makeEvent({ seq: i, epoch: 100, eventId: `e${i}` }));
    }

    const results = await db.getEvents('session-a', 100, { limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('putEvents batch inserts multiple events', async () => {
    const events = [
      makeEvent({ seq: 1, epoch: 100, eventId: 'b1' }),
      makeEvent({ seq: 2, epoch: 100, eventId: 'b2' }),
      makeEvent({ seq: 3, epoch: 100, eventId: 'b3' }),
    ];
    await db.putEvents(events);

    const results = await db.getEvents('session-a', 100);
    expect(results).toHaveLength(3);
  });

  it('putEvents with empty array is a no-op', async () => {
    await expect(db.putEvents([])).resolves.toBeUndefined();
    const results = await db.getEvents('session-a', 100);
    expect(results).toHaveLength(0);
  });

  it('getLastSeqAndEpoch returns correct values', async () => {
    await db.putEvent(makeEvent({ seq: 1, epoch: 100, eventId: 'e1' }));
    await db.putEvent(makeEvent({ seq: 5, epoch: 100, eventId: 'e5' }));
    await db.putEvent(makeEvent({ seq: 3, epoch: 100, eventId: 'e3' }));

    const result = await db.getLastSeqAndEpoch('session-a');
    expect(result).not.toBeNull();
    expect(result!.seq).toBe(5);
    expect(result!.epoch).toBe(100);
  });

  it('getLastSeqAndEpoch returns null for unknown session', async () => {
    const result = await db.getLastSeqAndEpoch('session-unknown');
    expect(result).toBeNull();
  });

  it('clearSessionEpoch removes events for that epoch only', async () => {
    await db.putEvent(makeEvent({ seq: 1, epoch: 100, eventId: 'old-1' }));
    await db.putEvent(makeEvent({ seq: 2, epoch: 100, eventId: 'old-2' }));
    await db.putEvent(makeEvent({ seq: 1, epoch: 200, eventId: 'new-1' }));

    await db.clearSessionEpoch('session-a', 100);

    const epoch100 = await db.getEvents('session-a', 100);
    expect(epoch100).toHaveLength(0);

    const epoch200 = await db.getEvents('session-a', 200);
    expect(epoch200).toHaveLength(1);
    expect(epoch200[0].eventId).toBe('new-1');
  });

  it('pruneOldEvents keeps only the last N events', async () => {
    for (let i = 1; i <= 10; i++) {
      await db.putEvent(makeEvent({ seq: i, epoch: 100, eventId: `p${i}` }));
    }

    await db.pruneOldEvents('session-a', 5);

    const results = await db.getEvents('session-a', 100);
    expect(results).toHaveLength(5);
    // Should keep the most recent ones (last 5: seq 6–10)
    const seqs = results.map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([6, 7, 8, 9, 10]);
  });

  it('pruneOldEvents is a no-op when count is within limit', async () => {
    await db.putEvent(makeEvent({ seq: 1, epoch: 100, eventId: 'x1' }));
    await db.putEvent(makeEvent({ seq: 2, epoch: 100, eventId: 'x2' }));

    await db.pruneOldEvents('session-a', 10);

    const results = await db.getEvents('session-a', 100);
    expect(results).toHaveLength(2);
  });

  it('deduplicates events by eventId', async () => {
    const event = makeEvent({ seq: 1, epoch: 100, eventId: 'dedup-1' });
    await db.putEvent(event);
    await db.putEvent(event); // second put with same eventId
    await db.putEvent(event); // third put

    const results = await db.getEvents('session-a', 100);
    expect(results).toHaveLength(1);
  });

  it('overwrite updates event data (idempotent put)', async () => {
    const event1 = makeEvent({ seq: 1, epoch: 100, eventId: 'overwrite-1' });
    await db.putEvent(event1);
    const updated = { ...event1, hidden: true };
    await db.putEvent(updated);

    const results = await db.getEvents('session-a', 100);
    const found = results.find((e) => e.eventId === 'overwrite-1');
    expect(found?.hidden).toBe(true);
  });

  it('results are sorted by seq ascending', async () => {
    await db.putEvent(makeEvent({ seq: 3, epoch: 100, eventId: 'c' }));
    await db.putEvent(makeEvent({ seq: 1, epoch: 100, eventId: 'a' }));
    await db.putEvent(makeEvent({ seq: 2, epoch: 100, eventId: 'b' }));

    const results = await db.getEvents('session-a', 100);
    expect(results.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('cross-server isolation via serverId:sessionId cache key', async () => {
    // Simulate two servers with the same session name but different cacheKeys
    const serverA_key = 'server-a:deck_cd_brain';
    const serverB_key = 'server-b:deck_cd_brain';

    await db.putEvent(makeEvent({ sessionId: serverA_key, seq: 1, epoch: 100, eventId: 'a1', payload: { text: 'from server A' } }));
    await db.putEvent(makeEvent({ sessionId: serverB_key, seq: 1, epoch: 100, eventId: 'b1', payload: { text: 'from server B' } }));

    const resultsA = await db.getRecentEvents(serverA_key);
    expect(resultsA).toHaveLength(1);
    expect(resultsA[0].payload.text).toBe('from server A');

    const resultsB = await db.getRecentEvents(serverB_key);
    expect(resultsB).toHaveLength(1);
    expect(resultsB[0].payload.text).toBe('from server B');
  });

  it('getLastSeqAndEpoch is isolated by cacheKey', async () => {
    await db.putEvent(makeEvent({ sessionId: 'srv1:sess', seq: 5, epoch: 100, eventId: 's1' }));
    await db.putEvent(makeEvent({ sessionId: 'srv2:sess', seq: 10, epoch: 200, eventId: 's2' }));

    const r1 = await db.getLastSeqAndEpoch('srv1:sess');
    expect(r1).toEqual({ seq: 5, epoch: 100 });

    const r2 = await db.getLastSeqAndEpoch('srv2:sess');
    expect(r2).toEqual({ seq: 10, epoch: 200 });
  });
});
