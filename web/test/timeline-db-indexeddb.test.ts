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

  it('collapses last-value signals on write, so churn can never accumulate', async () => {
    // Modelled on a real store, where session.state alone was ~67% of every
    // event recorded and the whole last-value group ~84%. The newest 60 RAW
    // events of a busy agent session held as little as ONE actual message.
    //
    // Signals now live in their own store keyed by [sessionId, type], so a
    // write overwrites rather than appends. There is nothing to sweep, and a
    // bounded read is bounded in CONVERSATION rather than in churn.
    const db = new TimelineDB();
    const events: TimelineEvent[] = [];
    let seq = 0;
    const push = (type: string, id: string): void => {
      seq += 1;
      events.push({ ...ev(id, 's', seq), type } as TimelineEvent);
    };
    for (let round = 0; round < 8; round += 1) {
      push('user.message', `u${round}`);
      for (let i = 0; i < 3; i += 1) push('tool.call', `tc${round}-${i}`);
      push('assistant.text', `a${round}`);
      for (let i = 0; i < 25; i += 1) push('session.state', `st${round}-${i}`);
      push('agent.status', `ag${round}`);
      push('usage.update', `us${round}`);
    }
    await db.putEvents(events);

    // No prune call anywhere in this test: the shape is structural.
    const page = await db.getRecentEvents('s', { limit: 60 });
    const types = page.map((e) => e.type);
    expect(types.filter((t) => t === 'assistant.text').length).toBe(8);
    expect(types.filter((t) => t === 'user.message').length).toBe(8);
    expect(types.filter((t) => t === 'tool.call').length).toBe(24);
    // Exactly one of each signal survives, and it is the newest, so the state
    // line and token counter still render after a reload.
    expect(types.filter((t) => t === 'session.state').length).toBe(1);
    expect(types.filter((t) => t === 'agent.status').length).toBe(1);
    expect(types.filter((t) => t === 'usage.update').length).toBe(1);
    expect(page.find((e) => e.type === 'session.state')!.eventId).toBe('st7-24');
    expect(page.find((e) => e.type === 'usage.update')!.eventId).toBe('us7');
    // Ascending order is the contract callers merge against.
    expect(page.map((e) => e.ts)).toEqual([...page.map((e) => e.ts)].sort((a, b) => a - b));
  });

  it('never lets a replayed older signal clobber a newer one', async () => {
    // The key is [sessionId, type], so a plain put would let a late reconnect
    // replay walk the state line backwards.
    const db = new TimelineDB();
    await db.putEvents([{ ...ev('newest', 's', 10), type: 'session.state' } as TimelineEvent]);
    await db.putEvents([{ ...ev('stale', 's', 2), type: 'session.state' } as TimelineEvent]);

    const page = await db.getRecentEvents('s', { limit: 10 });
    const state = page.filter((e) => e.type === 'session.state');
    expect(state).toHaveLength(1);
    expect(state[0]!.eventId).toBe('newest');
  });

  it('keeps unclassified event types as conversation rather than collapsing them', async () => {
    // Fail-safe direction. Only the short last-value allowlist collapses, so an
    // event type nobody has classified is retained in full. Backwards, a newly
    // added type would silently keep just one row the day it shipped.
    const db = new TimelineDB();
    const events: TimelineEvent[] = [];
    for (let i = 0; i < 5; i += 1) {
      events.push({ ...ev(`novel-${i}`, 's', i + 1), type: 'some.future.event' } as unknown as TimelineEvent);
    }
    await db.putEvents(events);

    expect(await db.getRecentEvents('s', { limit: 100 })).toHaveLength(5);
  });

  it('scopes signals per session', async () => {
    const db = new TimelineDB();
    await db.putEvents([
      { ...ev('a-st', 'sa', 1), type: 'session.state' } as TimelineEvent,
      { ...ev('b-st', 'sb', 1), type: 'session.state' } as TimelineEvent,
    ]);

    const a = await db.getRecentEvents('sa', { limit: 10 });
    const b = await db.getRecentEvents('sb', { limit: 10 });
    expect(a.map((e) => e.eventId)).toEqual(['a-st']);
    expect(b.map((e) => e.eventId)).toEqual(['b-st']);
  });

  it('honours a deletion budget so one sweep cannot monopolise the connection', async () => {
    // Every timeline shares ONE IndexedDB connection, so an unbounded delete
    // transaction over a large store parks every other session's read behind
    // it. That is how retention first shipped, and chats opened blank and hung
    // on "local cache" while it ran.
    const db = new TimelineDB();
    const events: TimelineEvent[] = [];
    for (let i = 0; i < 400; i += 1) events.push(ev(`e${i + 1}`, 's', i + 1));
    await db.putEvents(events);

    const first = await db.pruneOldEvents('s', 100, { maxDeletions: 50 });
    expect(first).toEqual({ deleted: 50, done: false });
    const afterFirst = await db.getRecentEvents('s', { limit: 1000 });
    expect(afterFirst).toHaveLength(350);
    // Oldest first, so repeated sweeps always make progress.
    expect(afterFirst[0]!.eventId).toBe('e51');

    let guard = 0;
    let done = false;
    while (!done && guard < 20) {
      done = (await db.pruneOldEvents('s', 100, { maxDeletions: 50 }))?.done ?? true;
      guard += 1;
    }
    const finalRows = await db.getRecentEvents('s', { limit: 1000 });
    expect(finalRows).toHaveLength(100);
    expect(finalRows[0]!.eventId).toBe('e301');
    expect(finalRows[99]!.eventId).toBe('e400');
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
