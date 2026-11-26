import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, it, expect } from 'vitest';
import { TimelineDB } from '../src/timeline-db.js';
import type { TimelineEvent } from '../src/ws-client.js';

/**
 * Continuation across a NON-UNIQUE index, and freshness for last-value signals.
 *
 * `session_ts` is not unique: many events can share a millisecond. A
 * continuation token that carries only `ts` and resumes with an exclusive upper
 * bound skips every unvisited sibling in that millisecond — and then reports
 * `done`, so the skipped rows are never drained at all.
 *
 * Separately, last-value signals compete across DIFFERENT eventIds, where the
 * contract is simply "newest wins". A comparator that ranks completeness above
 * freshness lets an older-but-hydrated row overwrite the newer current value,
 * after which the `events` copy is deleted and the newer value is gone.
 */

const DB_NAME = 'imcodes-timeline';
const STORE = 'events';

function ev(
  eventId: string,
  seq: number,
  type: string,
  opts: { ts?: number; epoch?: number; payload?: Record<string, unknown> } = {},
): TimelineEvent {
  return {
    eventId,
    sessionId: 's',
    ts: opts.ts ?? seq * 1000,
    epoch: opts.epoch ?? 1,
    seq,
    source: 'daemon',
    confidence: 'high',
    type,
    payload: opts.payload ?? { text: eventId },
  } as unknown as TimelineEvent;
}

function seedV1(rows: TimelineEvent[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      const store = db.createObjectStore(STORE, { keyPath: 'eventId' });
      store.createIndex('session_epoch_seq', ['sessionId', 'epoch', 'seq'], { unique: false });
      store.createIndex('session_ts', ['sessionId', 'ts'], { unique: false });
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const row of rows) store.put(row);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

/** Rows still physically present in `events` (not the merged read). */
function rawEventsRows(): Promise<TimelineEvent[]> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(STORE, 'readonly');
      const all = tx.objectStore(STORE).getAll();
      all.onsuccess = () => { const r = all.result as TimelineEvent[]; db.close(); resolve(r); };
      all.onerror = () => { db.close(); reject(all.error); };
    };
    req.onerror = () => reject(req.error);
  });
}

describe('drain continuation over a non-unique index', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it('drains every signal sharing one timestamp instead of skipping the bucket', async () => {
    // All 1000 rows in the SAME millisecond. The deletion budget necessarily
    // stops mid-bucket, so a ts-only continuation excludes all 900 unvisited
    // siblings and then claims to be done.
    const rows = Array.from({ length: 1_000 }, (_, i) => (
      ev(`sig-${i}`, i + 1, 'session.state', { ts: 1_000 })
    ));
    await seedV1(rows);

    const db = new TimelineDB();
    let before: { ts: number; eventId: string } | number | undefined;
    let deleted = 0;
    let passes = 0;
    for (;;) {
      const result = await db.drainLegacySignals('s', {
        maxDeletions: 100,
        ...(before !== undefined ? { before } : {}),
      } as never);
      expect(result).not.toBeNull();
      deleted += result!.deleted;
      passes += 1;
      if (result!.done) break;
      before = result!.nextBefore as never;
      if (passes > 30) throw new Error('did not converge');
    }

    // One row per type is preserved in the signals store; every other legacy
    // copy must actually be gone from `events`.
    const remaining = (await rawEventsRows()).filter((e) => e.type === 'session.state');
    expect(
      remaining.length,
      `${remaining.length} same-ts signals were skipped and never drained`,
    ).toBe(0);
    expect(deleted).toBe(1_000);
  }, 60_000);
});

describe('last-value freshness beats completeness', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it('does not let an older hydrated signal overwrite the newer current value', async () => {
    // Legacy row is "more complete" (full payload) but OLDER.
    await seedV1([
      ev('legacy-hydrated', 1, 'session.state', {
        ts: 1_000,
        epoch: 1,
        // rank 2 in getCompletenessRank — outranks the newer row below.
        payload: { state: 'idle', completeness: 'hydrated' },
      }),
      ev('msg', 2, 'assistant.text', { ts: 3_000 }),
    ]);

    const db = new TimelineDB();
    // Current value is NEWER but a thinner preview payload.
    await db.putEvents([
      // rank 0 — newer in every freshness dimension, but "less complete".
      ev('current-preview', 10, 'session.state', {
        ts: 2_000, epoch: 2, payload: { state: 'running', completeness: 'preview' },
      }),
    ]);

    await db.drainLegacySignals('s');

    const after = await db.getRecentEvents('s', { limit: 300 });
    const state = after.filter((e) => e.type === 'session.state');
    expect(state, 'the signal disappeared').toHaveLength(1);
    expect(
      state[0]!.eventId,
      'an older hydrated row overwrote the newer current signal',
    ).toBe('current-preview');
    expect(state[0]!.epoch).toBe(2);
  });
});
