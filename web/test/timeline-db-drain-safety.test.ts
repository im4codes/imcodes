import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { TimelineDB } from '../src/timeline-db.js';
import type { TimelineEvent } from '../src/ws-client.js';

/**
 * Safety contract for `drainLegacySignals`.
 *
 * The drain DELETES rows from the conversation store, so every guarantee here
 * is about not losing information and not monopolising the shared connection:
 *
 *  - a legacy row must never overwrite a NEWER value already in `signals`,
 *    including when both carry the same `ts` (audit finding: comparing `ts`
 *    alone let an epoch=1/seq=1 legacy row clobber an epoch=2/seq=10 current
 *    one, and the `events` copy was then deleted — irreversible);
 *  - the pass must free the NEWEST window first, because that is the window the
 *    first paint reads. Deleting the oldest signals first can burn an entire
 *    page session's budget without unblocking anything;
 *  - the read must be bounded, not a full-session `getAll` per chunk.
 */

const DB_NAME = 'imcodes-timeline';
const STORE = 'events';

function ev(
  eventId: string,
  sessionId: string,
  seq: number,
  type: string,
  opts: { ts?: number; epoch?: number } = {},
): TimelineEvent {
  return {
    eventId,
    sessionId,
    ts: opts.ts ?? seq * 1000,
    epoch: opts.epoch ?? 1,
    seq,
    source: 'daemon',
    confidence: 'high',
    type,
    payload: { text: eventId },
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

describe('drainLegacySignals safety', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it('never lets a same-ts legacy row overwrite a newer value already in signals', async () => {
    // Legacy row left in `events` by v1, and a CURRENT value already routed to
    // the signals store by v2. Same ts, but the current one is a later
    // epoch/seq — the only thing that distinguishes them.
    await seedV1([
      ev('legacy-state', 's', 1, 'session.state', { ts: 1000, epoch: 1 }),
      ev('msg', 's', 2, 'assistant.text', { ts: 2000 }),
    ]);

    const db = new TimelineDB();
    // Goes to the signals store via the production write path.
    await db.putEvents([ev('current-state', 's', 10, 'session.state', { ts: 1000, epoch: 2 })]);

    // Before the drain BOTH copies are visible: the legacy row still sits in
    // `events` and the current value already lives in `signals`.
    const before = await db.getRecentEvents('s', { limit: 300 });
    expect(before.filter((e) => e.type === 'session.state').map((e) => e.seq).sort((a, b) => a - b))
      .toEqual([1, 10]);

    await db.drainLegacySignals('s');

    const after = await db.getRecentEvents('s', { limit: 300 });
    const state = after.filter((e) => e.type === 'session.state');
    expect(state, 'the session.state signal disappeared entirely').toHaveLength(1);
    // The newer value must survive: the legacy row is deleted from `events`,
    // so losing it here is unrecoverable.
    expect(state[0]!.seq, 'a stale legacy row overwrote the newer signal').toBe(10);
    expect(state[0]!.epoch).toBe(2);
  });

  it('frees the NEWEST window first when the budget cannot cover everything', async () => {
    const rows: TimelineEvent[] = [];
    for (let i = 0; i < 1_000; i += 1) rows.push(ev(`sig-${i}`, 's', i + 1, 'session.state'));
    await seedV1(rows);

    const db = new TimelineDB();
    const result = await db.drainLegacySignals('s', { maxDeletions: 100 });

    expect(result).toMatchObject({ deleted: 100 });
    expect(result!.done, 'a budget-limited pass must report more work remaining').toBe(false);

    // The 100 newest signals (sig-900..sig-999) are the ones blocking the
    // first-paint window, so they are the ones that must be gone.
    const remaining = await db.getRecentEvents('s', { limit: 5_000 });
    const remainingIds = new Set(remaining.map((e) => e.eventId));
    for (let i = 900; i < 1_000; i += 1) {
      // sig-999 survives as the preserved newest-per-type value in `signals`.
      if (i === 999) continue;
      expect(remainingIds.has(`sig-${i}`), `newest signal sig-${i} was not drained first`).toBe(false);
    }
    expect(remainingIds.has('sig-0'), 'oldest signal should still be waiting its turn').toBe(true);
    // 1000 rows through fake-indexeddb runs ~3.4s focused, which overruns the
    // default 5s budget once the full suite is competing for the event loop.
  }, 30_000);

  it('does not materialise the whole session per pass', async () => {
    const rows: TimelineEvent[] = [];
    for (let i = 0; i < 600; i += 1) rows.push(ev(`sig-${i}`, 's', i + 1, 'agent.status'));
    await seedV1(rows);

    const unboundedGetAll = vi.spyOn(IDBIndex.prototype, 'getAll');
    const db = new TimelineDB();
    await db.drainLegacySignals('s', { maxDeletions: 50 });

    // A full-range getAll structured-clones every remaining row on EVERY chunk,
    // which is the exact unbounded cost the bounded read path exists to avoid.
    const unbounded = unboundedGetAll.mock.calls.filter((call) => call[1] === undefined);
    expect(unbounded, 'drain must scan with a bounded cursor, not a full-range getAll').toHaveLength(0);
    unboundedGetAll.mockRestore();
  });

  it('makes progress when the newest rows are all conversation (no zero-progress spin)', async () => {
    // 300 signals on top, then a long tail of conversation underneath. The scan
    // budget is consumed by conversation long before the cursor reaches the
    // older rows, so a pass that always restarts at the newest row returns
    // {deleted: 0, done: false} forever: it re-scans the identical prefix, the
    // caller's retry loop burns every chunk making no progress, and the re-read
    // that unblocks the pane is delayed by the full loop.
    const rows: TimelineEvent[] = [];
    for (let i = 0; i < 600; i += 1) rows.push(ev(`msg-${i}`, 's', i + 1, 'assistant.text'));
    for (let i = 0; i < 100; i += 1) rows.push(ev(`sig-${i}`, 's', 601 + i, 'session.state'));
    await seedV1(rows);

    const db = new TimelineDB();
    let deleted = 0;
    let before: number | undefined;
    let passes = 0;
    for (;;) {
      const result = await db.drainLegacySignals('s', {
        maxDeletions: 50,
        ...(before !== undefined ? { before } : {}),
      });
      expect(result).not.toBeNull();
      deleted += result!.deleted;
      passes += 1;
      if (result!.done) break;
      expect(
        result!.nextBefore,
        'a pass that is not done must report where to resume',
      ).toBeDefined();
      expect(
        result!.nextBefore !== before,
        'the drain re-scanned the same prefix instead of advancing',
      ).toBe(true);
      before = result!.nextBefore;
      if (passes > 15) throw new Error('drain never converged — zero-progress spin');
    }
    expect(deleted).toBe(100);
  }, 30_000);

  it('stops at the scan budget instead of walking the whole session', async () => {
    // No signals at all: the only thing that can stop this pass is the scan cap.
    const rows: TimelineEvent[] = [];
    for (let i = 0; i < 600; i += 1) rows.push(ev(`msg-${i}`, 's', i + 1, 'assistant.text'));
    await seedV1(rows);

    const db = new TimelineDB();
    const result = await db.drainLegacySignals('s', { maxDeletions: 10 });

    expect(result).toMatchObject({ deleted: 0, done: false });
    // maxDeletions 10 * DRAIN_SCAN_MULTIPLIER 4 = 40 rows examined, newest
    // first: msg-599 (ts 600_000) down to msg-560, whose ts is 561_000. Walking
    // the whole session instead would report ts 1_000 and done: true.
    expect(
      result!.nextBefore,
      'the pass examined more rows than its scan budget allows',
    ).toEqual({ ts: 561_000, eventId: 'msg-560' });
  }, 30_000);

  it('converges to done and is idempotent across repeated bounded passes', async () => {
    const rows: TimelineEvent[] = [ev('msg', 's', 1, 'assistant.text')];
    for (let i = 0; i < 300; i += 1) rows.push(ev(`sig-${i}`, 's', i + 2, 'usage.update'));
    await seedV1(rows);

    const db = new TimelineDB();
    let deleted = 0;
    let guard = 0;
    for (;;) {
      const result = await db.drainLegacySignals('s', { maxDeletions: 40 });
      deleted += result!.deleted;
      if (result!.done) break;
      if ((guard += 1) > 50) throw new Error('drain did not converge');
    }
    expect(deleted).toBe(300);
    expect(await db.drainLegacySignals('s')).toMatchObject({ deleted: 0, done: true });

    const after = await db.getRecentEvents('s', { limit: 300 });
    // The conversation survives, and the signal type still resolves to its
    // newest value rather than vanishing.
    expect(after.some((e) => e.eventId === 'msg')).toBe(true);
    const usage = after.filter((e) => e.type === 'usage.update');
    expect(usage).toHaveLength(1);
    expect(usage[0]!.seq).toBe(301);
  });
});
