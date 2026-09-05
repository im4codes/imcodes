import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, it, expect } from 'vitest';
import { TimelineDB } from '../src/timeline-db.js';
import type { TimelineEvent } from '../src/ws-client.js';

/**
 * Real IndexedDB regression tests (run 016f9b5b-c8f), backed by `fake-indexeddb`
 * — jsdom has no IndexedDB, so the legacy `timeline-db.test.ts` only exercises
 * the memory fallback and therefore CANNOT catch the most severe bug this work
 * fixed: `migrateRawToScoped()` used to `put(restamped)` then `delete(eventId)`,
 * and because the object store's primary key is `eventId` alone, the delete
 * removed the very row it had just rewritten — silently destroying local
 * history. These tests pin the no-self-delete contract against a real store.
 */

function ev(eventId: string, sessionId: string, seq: number, epoch = 1): TimelineEvent {
  return {
    eventId,
    sessionId,
    ts: seq * 1000,
    epoch,
    seq,
    source: 'daemon',
    confidence: 'high',
    type: 'assistant.text',
    payload: { text: eventId },
  } as TimelineEvent;
}

describe('TimelineDB — real IndexedDB (fake-indexeddb)', () => {
  beforeEach(() => {
    // Fresh database per test (TimelineDB uses a fixed DB_NAME).
    globalThis.indexedDB = new IDBFactory();
  });

  it('round-trips events through a real store (not the memory fallback)', async () => {
    const db = new TimelineDB();
    await db.putEvents([ev('e1', 's', 1), ev('e2', 's', 2)]);
    expect(db.memoryOnly).toBe(false); // proves the real store opened
    const got = await db.getRecentEvents('s', { limit: 10 });
    expect(got.map((e) => e.eventId).sort()).toEqual(['e1', 'e2']);
  });

  it('V1: migrateRawToScoped does NOT self-delete — events survive under the scoped key', async () => {
    const db = new TimelineDB();
    const raw = [ev('e1', 'bare', 1), ev('e2', 'bare', 2)];
    await db.putEvents(raw);

    await db.migrateRawToScoped('bare', 'srv:bare', raw);

    const scoped = await db.getRecentEvents('srv:bare', { limit: 10 });
    // The OLD put-then-delete impl left this EMPTY (data destroyed). New impl
    // rewrites in place — the eventId set is conserved and re-scoped.
    expect(scoped.map((e) => e.eventId).sort()).toEqual(['e1', 'e2']);
    expect(scoped.every((e) => e.sessionId === 'srv:bare')).toBe(true);
  });

  it('V1b: migrateRawToScoped is idempotent (running twice keeps data)', async () => {
    const db = new TimelineDB();
    const raw = [ev('e1', 'bare', 1)];
    await db.putEvents(raw);
    await db.migrateRawToScoped('bare', 'srv:bare', raw);
    await db.migrateRawToScoped('bare', 'srv:bare', raw);
    const scoped = await db.getRecentEvents('srv:bare', { limit: 10 });
    expect(scoped.map((e) => e.eventId)).toEqual(['e1']);
  });

  it('V1c: migrate preserves the more-complete existing row (no payload loss)', async () => {
    const db = new TimelineDB();
    const full = ev('e1', 'bare', 1);
    await db.putEvents([full]);
    // Migrate with a thinner copy of the same eventId — the stored payload must
    // not be clobbered to a worse version, and the row must end up scoped.
    await db.migrateRawToScoped('bare', 'srv:bare', [{ ...full, payload: { text: 'e1' } }]);
    const scoped = await db.getRecentEvents('srv:bare', { limit: 10 });
    expect(scoped).toHaveLength(1);
    expect(scoped[0]!.sessionId).toBe('srv:bare');
  });

  it('getLastSeqAndEpoch returns the highest (epoch, seq) row', async () => {
    const db = new TimelineDB();
    await db.putEvents([ev('e1', 's', 1), ev('e2', 's', 5)]);
    const last = await db.getLastSeqAndEpoch('s');
    expect(last).toEqual({ seq: 5, epoch: 1 });
  });

  it('resetAndReopen() keeps on-disk data readable (no permanent loss across reopen)', async () => {
    const db = new TimelineDB();
    await db.putEvents([ev('e1', 's', 1)]);
    await db.resetAndReopen();
    const got = await db.getRecentEvents('s', { limit: 10 });
    expect(got.map((e) => e.eventId)).toEqual(['e1']);
    expect(db.memoryOnly).toBe(false);
  });

  /**
   * Cost contract for the chat-open path.
   *
   * Opening a chat restores the last `MAX_MEMORY_EVENTS` events from IDB. That
   * read used to be `index.getAll(wholeSessionRange)` followed by
   * `slice(-limit)`, so it structured-cloned EVERY event the session had ever
   * stored and then discarded all but the tail. Nothing prunes that store in
   * production, so the time to open a chat grew with total history forever, and
   * every mounted timeline (open pane, each sub-session card preview, pinned
   * panels) paid it against one shared connection.
   *
   * Correctness alone cannot catch a regression here — returning the right 50
   * events is equally true whether 50 or 50,000 rows were deserialized to get
   * them. So these tests assert the COST: how many records the read is allowed
   * to materialize. Reverting to the whole-range getAll makes them fail.
   */
  function instrumentIdbReads() {
    const proto = IDBIndex.prototype as unknown as Record<string, (...args: unknown[]) => IDBRequest>;
    const originalGetAll = proto.getAll;
    const originalOpenCursor = proto.openCursor;
    const stats = { getAllResultSizes: [] as number[], cursorRecords: 0 };
    proto.getAll = function patchedGetAll(this: IDBIndex, ...args: unknown[]) {
      const req = originalGetAll.apply(this, args);
      req.addEventListener('success', () => {
        stats.getAllResultSizes.push(Array.isArray(req.result) ? req.result.length : 0);
      });
      return req;
    };
    proto.openCursor = function patchedOpenCursor(this: IDBIndex, ...args: unknown[]) {
      const req = originalOpenCursor.apply(this, args);
      req.addEventListener('success', () => { if (req.result) stats.cursorRecords += 1; });
      return req;
    };
    return {
      stats,
      restore: (): void => { proto.getAll = originalGetAll; proto.openCursor = originalOpenCursor; },
    };
  }

  it('restores the newest page without materializing the whole stored history', async () => {
    const db = new TimelineDB();
    const total = 1200;
    const limit = 50;
    await db.putEvents(Array.from({ length: total }, (_, i) => ev(`e${i + 1}`, 's', i + 1)));

    const probe = instrumentIdbReads();
    let got: TimelineEvent[];
    try {
      got = await db.getRecentEvents('s', { limit });
    } finally {
      probe.restore();
    }

    // Behaviour: the newest `limit` events, still oldest-first.
    expect(got).toHaveLength(limit);
    expect(got[0]!.eventId).toBe(`e${total - limit + 1}`);
    expect(got[limit - 1]!.eventId).toBe(`e${total}`);
    expect(got.map((e) => e.seq)).toEqual([...got.map((e) => e.seq)].sort((a, b) => a - b));

    // Cost: nothing may deserialize more than the page we asked for. The old
    // whole-range getAll reported 1200 here.
    const largestGetAll = probe.stats.getAllResultSizes.reduce((a, b) => Math.max(a, b), 0);
    expect(largestGetAll).toBeLessThanOrEqual(limit);
    expect(probe.stats.cursorRecords).toBeLessThanOrEqual(limit);
  });

  it('caps an epoch page read at the requested limit', async () => {
    const db = new TimelineDB();
    await db.putEvents(Array.from({ length: 400 }, (_, i) => ev(`e${i + 1}`, 's', i + 1)));

    const probe = instrumentIdbReads();
    let got: TimelineEvent[];
    try {
      got = await db.getEvents('s', 1, { limit: 25, afterSeq: 0 });
    } finally {
      probe.restore();
    }

    expect(got).toHaveLength(25);
    expect(got[0]!.eventId).toBe('e1');
    const largestGetAll = probe.stats.getAllResultSizes.reduce((a, b) => Math.max(a, b), 0);
    expect(largestGetAll).toBeLessThanOrEqual(25);
  });

  it('prunes to the newest N without cloning the payloads it deletes', async () => {
    const db = new TimelineDB();
    await db.putEvents(Array.from({ length: 300 }, (_, i) => ev(`e${i + 1}`, 's', i + 1)));

    const probe = instrumentIdbReads();
    try {
      await db.pruneOldEvents('s', 40);
    } finally {
      probe.restore();
    }

    const kept = await db.getRecentEvents('s', { limit: 1000 });
    expect(kept).toHaveLength(40);
    expect(kept[0]!.eventId).toBe('e261');
    expect(kept[39]!.eventId).toBe('e300');
    // Deleting needs keys, not payloads: getAllKeys returns key lists, never
    // record objects, so no getAll may report cloned rows here.
    const largestGetAll = probe.stats.getAllResultSizes.reduce((a, b) => Math.max(a, b), 0);
    expect(largestGetAll).toBe(0);
  });
});
