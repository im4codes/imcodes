import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, it, expect } from 'vitest';
import { TimelineDB } from '../src/timeline-db.js';
import type { TimelineEvent } from '../src/ws-client.js';

/**
 * `onversionchange` must not strand the shared connection.
 *
 * The handler closes the database and clears `this.db`, but `ensureOpen()`
 * returns the cached `openPromise` whenever `db` is null — so leaving that
 * promise set handed every later caller the CLOSED connection. Each
 * transaction then threw InvalidStateError, every read silently fell back to an
 * empty in-memory store, and because `_memoryOnly` was never set on that path
 * the `resetAndReopen()` recovery hook stayed disabled. The result was a pane
 * that stayed blank until a full page reload.
 *
 * `deleteDatabase` is used to fire a real `versionchange` at an open
 * connection, which is exactly the event another tab's upgrade delivers.
 */

const DB_NAME = 'imcodes-timeline';

function ev(eventId: string, sessionId: string, seq: number): TimelineEvent {
  return {
    eventId,
    sessionId,
    ts: seq * 1000,
    epoch: 1,
    seq,
    source: 'daemon',
    confidence: 'high',
    type: 'assistant.text',
    payload: { text: eventId },
  } as unknown as TimelineEvent;
}

function fireVersionChange(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    const done = () => resolve();
    req.onsuccess = done;
    req.onerror = done;
    req.onblocked = done;
  });
}

describe('TimelineDB survives a versionchange from another tab', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it('reopens instead of serving every later read from a closed connection', async () => {
    const db = new TimelineDB();
    await db.putEvents([ev('before-1', 's', 1)]);
    expect(db.memoryOnly).toBe(false);
    expect(await db.getRecentEvents('s', { limit: 10 })).toHaveLength(1);

    await fireVersionChange();
    // Let the versionchange handler run.
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    // The store is gone, so this is legitimately empty — but the connection
    // must be usable again rather than permanently closed.
    await db.putEvents([ev('after-1', 's', 2)]);

    // Read through an INDEPENDENT instance, whose in-memory fallback is empty.
    //
    // Reading back through `db` itself proves nothing: with a stranded closed
    // connection every transaction throws, the write lands in that instance's
    // memory fallback, and the read is served straight back out of it — so the
    // assertion passes while nothing was ever persisted. `memoryOnly` is no
    // help either; the whole point of this bug is that it stays false. Only a
    // second instance can tell a durable reopen from a private memory map.
    const observer = new TimelineDB();
    const seen = await observer.getRecentEvents('s', { limit: 10 });

    expect(
      seen.map((e) => e.eventId),
      'the write never reached disk — the connection was still the closed one',
    ).toEqual(['after-1']);
  });
});
