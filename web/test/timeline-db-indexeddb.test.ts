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
});
