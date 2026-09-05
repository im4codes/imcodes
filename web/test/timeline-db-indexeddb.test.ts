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

  it('collapses last-value churn so a bounded read returns the conversation', async () => {
    // Modelled on a real store: session.state was ~67% of all events and the
    // whole last-value group ~84%, so the newest 60 RAW events of a busy agent
    // session held as little as ONE actual message. A page counted in raw
    // events was therefore mostly counting churn, and the chat looked empty.
    const db = new TimelineDB();
    const events: TimelineEvent[] = [];
    let seq = 0;
    const push = (type: string, id: string): void => {
      seq += 1;
      events.push({ ...ev(id, 's', seq), type } as TimelineEvent);
    };
    // 8 real messages, buried under state churn at roughly the measured ratio.
    for (let round = 0; round < 8; round += 1) {
      push('user.message', `u${round}`);
      for (let i = 0; i < 3; i += 1) push('tool.call', `tc${round}-${i}`);
      push('assistant.text', `a${round}`);
      for (let i = 0; i < 25; i += 1) push('session.state', `st${round}-${i}`);
      push('agent.status', `ag${round}`);
      push('usage.update', `us${round}`);
    }
    await db.putEvents(events);

    const beforeTypes = (await db.getRecentEvents('s', { limit: 60 })).map((e) => e.type);
    // Documents the defect this change exists for. The newest 60 RAW events are
    // dominated by churn, and the conversation does not fit inside them — which
    // is why a reader bounded at 60 showed almost nothing. (Measured on real
    // sessions: 1-4 messages in the newest 60.)
    expect(beforeTypes.filter((t) => t === 'session.state').length).toBeGreaterThan(40);
    expect(beforeTypes.filter((t) => t === 'assistant.text').length).toBeLessThan(8);

    const result = await db.pruneSessionHistory('s', 1000);
    expect(result).not.toBeNull();
    expect(result!.deleted).toBeGreaterThan(0);

    const after = await db.getRecentEvents('s', { limit: 60 });
    const afterTypes = after.map((e) => e.type);
    // The whole conversation is now inside a 60-event page...
    expect(afterTypes.filter((t) => t === 'assistant.text').length).toBe(8);
    expect(afterTypes.filter((t) => t === 'user.message').length).toBe(8);
    expect(afterTypes.filter((t) => t === 'tool.call').length).toBe(24);
    // ...and each last-value signal survives exactly once, so the state line
    // and token counter still render after a reload.
    expect(afterTypes.filter((t) => t === 'session.state').length).toBe(1);
    expect(afterTypes.filter((t) => t === 'agent.status').length).toBe(1);
    expect(afterTypes.filter((t) => t === 'usage.update').length).toBe(1);
    // The survivor must be the NEWEST of its type, not an arbitrary one.
    expect(after.find((e) => e.type === 'session.state')!.eventId).toBe('st7-24');
    expect(after.find((e) => e.type === 'usage.update')!.eventId).toBe('us7');
  });

  it('retains unclassified event types as history rather than deleting them', async () => {
    // Fail-safe direction: only the short last-value allowlist is collapsed, so
    // a newly added event type nobody classified is KEPT. Getting this backwards
    // would silently delete data the moment a new type shipped.
    const db = new TimelineDB();
    const events: TimelineEvent[] = [];
    for (let i = 0; i < 5; i += 1) {
      events.push({ ...ev(`novel-${i}`, 's', i + 1), type: 'some.future.event' } as unknown as TimelineEvent);
    }
    await db.putEvents(events);

    await db.pruneSessionHistory('s', 1000);

    const kept = await db.getRecentEvents('s', { limit: 100 });
    expect(kept).toHaveLength(5);
  });

  it('honours a deletion budget so one sweep cannot monopolise the connection', async () => {
    // Every timeline in the app shares ONE IndexedDB connection. An unbounded
    // readwrite sweep over a never-pruned store therefore parks every other
    // session's read behind it, which is exactly how this feature first shipped
    // and made chats open blank and hang on "local cache". A capped sweep keeps
    // each transaction short; deletions come from the OLDEST end, so repeated
    // sweeps always make progress rather than re-deleting the same rows.
    const db = new TimelineDB();
    const events: TimelineEvent[] = [];
    for (let i = 0; i < 400; i += 1) events.push(ev(`e${i + 1}`, 's', i + 1));
    await db.putEvents(events);

    const first = await db.pruneSessionHistory('s', 100, { maxDeletions: 50 });
    expect(first).not.toBeNull();
    expect(first!.deleted).toBe(50);
    // Unfinished, and it says so, so the caller knows to come back.
    expect(first!.done).toBe(false);
    const afterFirst = await db.getRecentEvents('s', { limit: 1000 });
    expect(afterFirst).toHaveLength(350);
    // The retained window is what matters and it is intact. The walk has to run
    // newest-first (that is how "keep the newest of each last-value type" is
    // decided), so a partial sweep removes from the middle rather than the
    // oldest end. That is safe precisely because everything it can touch lies
    // BELOW the retained window, and reads never reach past it.
    const newestHundred = afterFirst.slice(-100).map((e) => e.eventId);
    expect(newestHundred[0]).toBe('e301');
    expect(newestHundred[99]).toBe('e400');

    let guard = 0;
    let done = false;
    while (!done && guard < 20) {
      const next = await db.pruneSessionHistory('s', 100, { maxDeletions: 50 });
      done = next?.done ?? true;
      guard += 1;
    }
    expect(done).toBe(true);
    const finalRows = await db.getRecentEvents('s', { limit: 1000 });
    expect(finalRows).toHaveLength(100);
    expect(finalRows[0]!.eventId).toBe('e301');
    expect(finalRows[99]!.eventId).toBe('e400');
  });

  it('prunes only the requested session', async () => {
    const db = new TimelineDB();
    const noise: TimelineEvent[] = [];
    for (let i = 0; i < 20; i += 1) {
      noise.push({ ...ev(`a-st${i}`, 'sa', i + 1), type: 'session.state' } as TimelineEvent);
      noise.push({ ...ev(`b-st${i}`, 'sb', i + 1), type: 'session.state' } as TimelineEvent);
    }
    await db.putEvents(noise);

    await db.pruneSessionHistory('sa', 1000);

    expect(await db.getRecentEvents('sa', { limit: 100 })).toHaveLength(1);
    expect(await db.getRecentEvents('sb', { limit: 100 })).toHaveLength(20);
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
