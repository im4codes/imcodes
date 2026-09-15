import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, it, expect } from 'vitest';
import { TimelineDB } from '../src/timeline-db.js';
import type { TimelineEvent } from '../src/ws-client.js';

/**
 * The first paint reads a BOUNDED newest-first window out of the `events`
 * store, so anything occupying that window which the chat cannot render is a
 * message the user does not get to see.
 *
 * v1 stored last-value signals (`session.state`, `agent.status`, …) in `events`
 * alongside conversation. v2 routes NEW signals into their own store, but the
 * upgrade is deliberately additive and rewrites no existing row, so everything
 * an install recorded before upgrading stays in `events`. By this repo's own
 * measurement `session.state` alone is ~67% of recorded events and the whole
 * last-value group ~84% — more than enough to fill a 300-row window on a busy
 * session and open the pane with the "load earlier messages" button (gated on
 * `viewItems.length > 0`) above an empty scroller, no spinner.
 *
 * The v2 upgrade comment promised these rows were "drained later, in the
 * background, by pruneSessionHistory" — a function that never existed in the
 * repo. `drainLegacySignals` is that drain.
 */

const DB_NAME = 'imcodes-timeline';
const STORE = 'events';

function ev(eventId: string, sessionId: string, seq: number, type: string): TimelineEvent {
  return {
    eventId,
    sessionId,
    ts: seq * 1000,
    epoch: 1,
    seq,
    source: 'daemon',
    confidence: 'high',
    type,
    payload: { text: eventId },
  } as unknown as TimelineEvent;
}

/** Build a v1 database exactly as the pre-split code did, and seed it. */
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

const CONVERSATION_TYPES = new Set(['user.message', 'assistant.text', 'tool.call', 'tool.result']);
const SIGNAL_TYPES = ['session.state', 'agent.status', 'usage.update', 'memory.context'];

/** 5 real messages, then a flood of NEWER legacy signals on top of them. */
function buriedConversation(): TimelineEvent[] {
  const rows: TimelineEvent[] = [];
  let seq = 0;
  for (let i = 0; i < 5; i += 1) {
    seq += 1;
    rows.push(ev(`msg-${i}`, 's', seq, i % 2 === 0 ? 'user.message' : 'assistant.text'));
  }
  for (let i = 0; i < 400; i += 1) {
    seq += 1;
    rows.push(ev(`sig-${i}`, 's', seq, SIGNAL_TYPES[i % SIGNAL_TYPES.length]!));
  }
  return rows;
}

describe('legacy signals must not consume the bounded first-paint window', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it('buries the conversation until the legacy signals are drained', async () => {
    await seedV1(buriedConversation());
    const db = new TimelineDB();

    // Before the drain the whole window is signals — this is the blank pane.
    const before = await db.getRecentEvents('s', { limit: 300 });
    expect(before.filter((e) => CONVERSATION_TYPES.has(e.type))).toHaveLength(0);

    let guard = 0;
    for (;;) {
      const result = await db.drainLegacySignals('s', { maxDeletions: 150 });
      expect(result).not.toBeNull();
      if (result!.done) break;
      if ((guard += 1) > 20) throw new Error('drain did not converge');
    }

    const after = await db.getRecentEvents('s', { limit: 300 });
    expect(after.filter((e) => CONVERSATION_TYPES.has(e.type)).map((e) => e.eventId)).toEqual([
      'msg-0', 'msg-1', 'msg-2', 'msg-3', 'msg-4',
    ]);
  });

  it('keeps the newest value of every drained signal type', async () => {
    await seedV1(buriedConversation());
    const db = new TimelineDB();

    let guard = 0;
    for (;;) {
      const result = await db.drainLegacySignals('s', { maxDeletions: 150 });
      if (result!.done) break;
      if ((guard += 1) > 20) throw new Error('drain did not converge');
    }

    const after = await db.getRecentEvents('s', { limit: 300 });
    // Every signal type still resolves, and to its NEWEST recorded value —
    // draining must free the window without losing the live status line.
    for (const type of SIGNAL_TYPES) {
      const survivors = after.filter((e) => e.type === type);
      expect(survivors, `signal type ${type} disappeared`).toHaveLength(1);
      const newestSeq = Math.max(
        ...buriedConversation().filter((e) => e.type === type).map((e) => e.seq),
      );
      expect(survivors[0]!.seq, `signal type ${type} kept a stale value`).toBe(newestSeq);
    }
  });

  it('is idempotent and reports done on an already-drained session', async () => {
    await seedV1([ev('c1', 's', 1, 'assistant.text'), ev('s1', 's', 2, 'session.state')]);
    const db = new TimelineDB();

    expect(await db.drainLegacySignals('s')).toMatchObject({ deleted: 1, done: true });
    expect(await db.drainLegacySignals('s')).toMatchObject({ deleted: 0, done: true });

    const after = await db.getRecentEvents('s', { limit: 300 });
    expect(after.map((e) => e.eventId).sort()).toEqual(['c1', 's1']);
  });

  it('still returns conversation stored under v1 after the v2 upgrade', async () => {
    await seedV1([
      ev('c1', 's', 1, 'user.message'),
      ev('c2', 's', 2, 'assistant.text'),
      ev('sig1', 's', 3, 'session.state'),
      ev('c3', 's', 4, 'assistant.text'),
    ]);

    const db = new TimelineDB();
    const got = await db.getRecentEvents('s', { limit: 300 });

    expect(db.memoryOnly).toBe(false);
    expect(got.map((e) => e.eventId)).toEqual(expect.arrayContaining(['c1', 'c2', 'c3']));
  });
});
