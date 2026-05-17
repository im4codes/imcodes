/**
 * IndexedDB persistence for timeline events.
 * Database: imcodes-timeline
 * Object store: events (keyPath: eventId)
 * Indexes: [sessionId, epoch, seq], [sessionId, ts]
 *
 * Graceful degradation: falls back to memory-only mode on IndexedDB errors.
 *
 * Open lifecycle — see Round 2 P2P audit "B1":
 *   - All public mutators / readers await `ensureOpen()` internally before
 *     touching IndexedDB. The previous design exposed `open()` as a manual
 *     step and let `putEvents()` short-circuit to the memory fallback when
 *     `this.db === null`, which conflated "open pending" with "permanently
 *     memory-only". Events written during that pending window were never
 *     flushed once IDB became ready, so cold-start WS deliveries effectively
 *     disappeared (same-page lifecycle invisible because `getRecentEvents`
 *     only reads `this.db`, not `memoryFallback`).
 *   - Now: `ensureOpen()` is single-flight via `openPromise`. Once open
 *     succeeds we flush any events that were buffered in `memoryFallback`
 *     into IDB so they are durable across reloads. Flush failures keep the
 *     fallback intact — we never silently drop. Only an `open()` reject
 *     (quota / corruption / private-mode block) sets `_memoryOnly = true`.
 */

import type { TimelineEvent } from './ws-client.js';
import { preferTimelineEvent } from '../../src/shared/timeline/merge.js';

const DB_NAME = 'imcodes-timeline';
const DB_VERSION = 1;
const STORE_NAME = 'events';

export class TimelineDB {
  private db: IDBDatabase | null = null;
  private openPromise: Promise<IDBDatabase | null> | null = null;
  private memoryFallback = new Map<string, TimelineEvent[]>();
  private _memoryOnly = false;

  get memoryOnly(): boolean {
    return this._memoryOnly;
  }

  /**
   * Backwards-compatible explicit open. New code should rely on the
   * internal `ensureOpen()` that every public method calls — this stays for
   * call-sites that explicitly want to wait for IDB readiness (e.g. test
   * setup, optional prewarm).
   */
  async open(): Promise<void> {
    await this.ensureOpen();
  }

  /**
   * Single-flight open. Resolves with the live `IDBDatabase` on success or
   * `null` when open() itself rejected (quota / private mode / corruption).
   * On the first successful open we also drain `memoryFallback` into IDB so
   * cold-start writes are durable.
   */
  private async ensureOpen(): Promise<IDBDatabase | null> {
    if (this.db) return this.db;
    if (this._memoryOnly) return null;
    if (!this.openPromise) {
      this.openPromise = this.openInternal()
        .then(async (db) => {
          if (db) {
            this.db = db;
            await this.flushMemoryFallbackToDb(db);
          }
          return db;
        })
        .catch(() => {
          this._memoryOnly = true;
          return null;
        });
    }
    return this.openPromise;
  }

  private openInternal(): Promise<IDBDatabase | null> {
    return new Promise<IDBDatabase | null>((resolve, reject) => {
      let req: IDBOpenDBRequest;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        // Some browsers throw synchronously when storage is unavailable
        // (e.g. iOS private mode in older versions).
        reject(err);
        return;
      }

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'eventId' });
          store.createIndex('session_epoch_seq', ['sessionId', 'epoch', 'seq'], { unique: false });
          store.createIndex('session_ts', ['sessionId', 'ts'], { unique: false });
        }
      };

      req.onsuccess = () => {
        const db = req.result;
        // If another tab upgrades the schema later we want to drop our
        // connection so the upgrade isn't blocked indefinitely. Going back
        // to memory until the next ensureOpen() is the safest fallback;
        // production has DB_VERSION=1 today so this is dormant defense.
        db.onversionchange = () => {
          try { db.close(); } catch { /* ignore */ }
          this.db = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => {
        // Another tab still holds a connection to the old version. We
        // don't reject here — when the holder closes we'll get
        // `onsuccess` eventually. Leaving the promise pending is
        // preferable to flipping to memory-only on a slow tab.
      };
    });
  }

  private async flushMemoryFallbackToDb(db: IDBDatabase): Promise<void> {
    if (this.memoryFallback.size === 0) return;
    const all: TimelineEvent[] = [];
    for (const events of this.memoryFallback.values()) {
      for (const event of events) all.push(event);
    }
    if (all.length === 0) return;
    try {
      await txPutEventsPreservingCompleteness(db, all);
      // Successful flush — drop the in-memory mirror. If a later write
      // fails it will repopulate the fallback for the next open cycle.
      this.memoryFallback.clear();
    } catch {
      // Keep the fallback; another open()/flush will retry. Never silently
      // drop the data.
    }
  }

  async putEvent(event: TimelineEvent): Promise<void> {
    await this.putEvents([event]);
  }

  async putEvents(events: TimelineEvent[]): Promise<void> {
    if (events.length === 0) return;

    const db = await this.ensureOpen();
    if (!db) {
      for (const e of events) this.memPut(e);
      return;
    }

    try {
      await txPutEventsPreservingCompleteness(db, events);
    } catch {
      for (const e of events) this.memPut(e);
    }
  }

  async getEvents(
    sessionId: string,
    epoch: number,
    opts?: { limit?: number; afterSeq?: number },
  ): Promise<TimelineEvent[]> {
    const db = await this.ensureOpen();
    if (!db) {
      return this.memGet(sessionId, epoch, opts);
    }

    try {
      const afterSeq = opts?.afterSeq ?? -1;
      const limit = opts?.limit ?? Infinity;

      return await new Promise<TimelineEvent[]>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const index = store.index('session_epoch_seq');

        // Range: [sessionId, epoch, afterSeq+1] to [sessionId, epoch, Infinity]
        const lower = [sessionId, epoch, afterSeq + 1];
        const upper = [sessionId, epoch, Infinity];
        const range = IDBKeyRange.bound(lower, upper);

        // getAll is a single IDB round-trip — much faster than cursor iteration
        const req = index.getAll(range);
        req.onsuccess = () => {
          const all = req.result as TimelineEvent[];
          resolve(limit < all.length ? all.slice(0, limit) : all);
        };
        req.onerror = () => reject(req.error);
      });
    } catch {
      return this.memGet(sessionId, epoch, opts);
    }
  }

  /**
   * Get recent events for a session across ALL epochs, ordered by timestamp.
   * Used for initial cache restore on page load — no epoch filtering so all
   * stored events (across daemon restarts) are included.
   */
  async getRecentEvents(
    sessionId: string,
    opts?: { limit?: number },
  ): Promise<TimelineEvent[]> {
    const db = await this.ensureOpen();
    if (!db) {
      return this.memGetByTime(sessionId, opts);
    }

    try {
      const limit = opts?.limit ?? Infinity;

      return await new Promise<TimelineEvent[]>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const index = store.index('session_ts');

        const lower = [sessionId, 0];
        const upper = [sessionId, Infinity];
        const range = IDBKeyRange.bound(lower, upper);

        // getAll is a single IDB round-trip — much faster than cursor iteration
        const req = index.getAll(range);
        req.onsuccess = () => {
          const all = req.result as TimelineEvent[];
          resolve(limit < all.length ? all.slice(-limit) : all);
        };
        req.onerror = () => reject(req.error);
      });
    } catch {
      return this.memGetByTime(sessionId, opts);
    }
  }

  /**
   * Async migration helper used by `useTimeline`'s scope-fallback path.
   * Re-writes `events` under `scopedKey` and deletes the raw-key rows.
   * Best-effort; failures leave both copies alive so the fallback path
   * keeps working on the next read.
   *
   * Why this exists: `useTimeline` scopes the IDB key by serverId
   * (`${serverId}:${sessionId}`). When the app first paints with
   * `selectedServerId === null` (state loading from localStorage), WS
   * events arriving in that window get persisted under the bare
   * `sessionId`. Once selectedServerId resolves, subsequent reads use
   * the scoped key and the bare-key rows become "orphans" — invisible
   * to every later read. The data IS there in IDB, just under the
   * previous (raw) key shape — so the chat pane reads empty despite a
   * real local cache.
   *
   * See `.imc/discussions/e9dbc48c-dda.md` PR-4 for the full audit.
   */
  async migrateRawToScoped(
    rawSessionId: string,
    scopedKey: string,
    rawEvents: TimelineEvent[],
  ): Promise<void> {
    if (rawSessionId === scopedKey || rawEvents.length === 0) return;
    // 1. Re-stamp + put under scoped key. putEvents internally awaits
    //    ensureOpen so we don't need to re-check.
    const restamped = rawEvents.map((event) => ({ ...event, sessionId: scopedKey }));
    await this.putEvents(restamped);
    // 2. Delete the raw rows by eventId. Each event's eventId is the
    //    primary key, so a single readwrite transaction can drop them.
    const db = await this.ensureOpen();
    if (!db) return;
    await new Promise<void>((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const event of rawEvents) {
          try { store.delete(event.eventId); } catch { /* ignore */ }
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  async getLastSeqAndEpoch(sessionId: string): Promise<{ seq: number; epoch: number } | null> {
    const db = await this.ensureOpen();
    if (!db) {
      return this.memLastSeqEpoch(sessionId);
    }

    try {
      return await new Promise<{ seq: number; epoch: number } | null>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const index = store.index('session_epoch_seq');

        // Open cursor in reverse on session prefix to find the last event
        const lower = [sessionId, 0, 0];
        const upper = [sessionId, Infinity, Infinity];
        const range = IDBKeyRange.bound(lower, upper);
        const req = index.openCursor(range, 'prev');

        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            const ev = cursor.value as TimelineEvent;
            resolve({ seq: ev.seq, epoch: ev.epoch });
          } else {
            resolve(null);
          }
        };
        req.onerror = () => reject(req.error);
      });
    } catch {
      return this.memLastSeqEpoch(sessionId);
    }
  }

  async clearSessionEpoch(sessionId: string, epoch: number): Promise<void> {
    const db = await this.ensureOpen();
    if (!db) {
      const key = sessionId;
      const events = this.memoryFallback.get(key);
      if (events) {
        this.memoryFallback.set(key, events.filter((e) => e.epoch !== epoch));
      }
      return;
    }

    try {
      const events = await this.getEvents(sessionId, epoch);
      await txWrite(db, STORE_NAME, (store) => {
        for (const e of events) store.delete(e.eventId);
      });
    } catch {
      // best-effort
    }
  }

  async pruneOldEvents(sessionId: string, keepCount: number): Promise<void> {
    const db = await this.ensureOpen();
    if (!db) {
      const events = this.memoryFallback.get(sessionId);
      if (events && events.length > keepCount) {
        this.memoryFallback.set(sessionId, events.slice(-keepCount));
      }
      return;
    }

    try {
      // Get all events for session, ordered by ts
      const all = await new Promise<TimelineEvent[]>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const index = store.index('session_ts');
        const lower = [sessionId, 0];
        const upper = [sessionId, Infinity];
        const range = IDBKeyRange.bound(lower, upper);
        const req = index.getAll(range);
        req.onsuccess = () => resolve(req.result as TimelineEvent[]);
        req.onerror = () => reject(req.error);
      });

      if (all.length <= keepCount) return;

      const toDelete = all.slice(0, all.length - keepCount);
      await txWrite(db, STORE_NAME, (store) => {
        for (const e of toDelete) store.delete(e.eventId);
      });
    } catch {
      // best-effort
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.openPromise = null;
  }

  // ── Memory fallback helpers ──────────────────────────────────────────────

  private memPut(event: TimelineEvent): void {
    const key = event.sessionId;
    let events = this.memoryFallback.get(key);
    if (!events) {
      events = [];
      this.memoryFallback.set(key, events);
    }
    // Idempotent overwrite by eventId (matches IndexedDB put semantics)
    const idx = events.findIndex((e) => e.eventId === event.eventId);
    if (idx >= 0) {
      events[idx] = preferTimelineEvent(events[idx]!, event);
    } else {
      events.push(event);
    }
  }

  private memGet(
    sessionId: string,
    epoch: number,
    opts?: { limit?: number; afterSeq?: number },
  ): TimelineEvent[] {
    const events = this.memoryFallback.get(sessionId) ?? [];
    const afterSeq = opts?.afterSeq ?? -1;
    const limit = opts?.limit ?? Infinity;
    return events
      .filter((e) => e.epoch === epoch && e.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit);
  }

  private memGetByTime(
    sessionId: string,
    opts?: { limit?: number },
  ): TimelineEvent[] {
    const events = this.memoryFallback.get(sessionId) ?? [];
    const limit = opts?.limit ?? Infinity;
    return [...events].sort((a, b) => a.ts - b.ts).slice(-limit);
  }

  private memLastSeqEpoch(sessionId: string): { seq: number; epoch: number } | null {
    const events = this.memoryFallback.get(sessionId);
    if (!events || events.length === 0) return null;
    const last = events.reduce((a, b) => (a.seq > b.seq ? a : b));
    return { seq: last.seq, epoch: last.epoch };
  }
}

function txPutEventsPreservingCompleteness(
  db: IDBDatabase,
  events: TimelineEvent[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const event of events) {
      const getReq = store.get(event.eventId);
      getReq.onsuccess = () => {
        const existing = getReq.result as TimelineEvent | undefined;
        store.put(existing ? preferTimelineEvent(existing, event) : event);
      };
      getReq.onerror = () => reject(getReq.error);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ── IDB transaction helper ─────────────────────────────────────────────────

function txWrite(
  db: IDBDatabase,
  storeName: string,
  fn: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    fn(store);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
