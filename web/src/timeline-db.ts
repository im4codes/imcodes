/**
 * IndexedDB persistence for timeline events.
 * Database: imcodes-timeline
 * Object store: events (keyPath: eventId)
 * Indexes: [sessionId, epoch, seq], [sessionId, ts]
 *
 * Graceful degradation: falls back to memory-only mode on IndexedDB errors.
 */

import type { TimelineEvent } from './ws-client.js';

const DB_NAME = 'imcodes-timeline';
const DB_VERSION = 1;
const STORE_NAME = 'events';

export class TimelineDB {
  private db: IDBDatabase | null = null;
  private memoryFallback = new Map<string, TimelineEvent[]>();
  private _memoryOnly = false;

  get memoryOnly(): boolean {
    return this._memoryOnly;
  }

  async open(): Promise<void> {
    if (this.db) return;

    try {
      this.db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);

        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'eventId' });
            store.createIndex('session_epoch_seq', ['sessionId', 'epoch', 'seq'], { unique: false });
            store.createIndex('session_ts', ['sessionId', 'ts'], { unique: false });
          }
        };

        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch {
      this._memoryOnly = true;
    }
  }

  async putEvent(event: TimelineEvent): Promise<void> {
    if (this._memoryOnly || !this.db) {
      this.memPut(event);
      return;
    }

    try {
      await txWrite(this.db, STORE_NAME, (store) => {
        store.put(event);
      });
    } catch {
      this.memPut(event);
    }
  }

  async putEvents(events: TimelineEvent[]): Promise<void> {
    if (events.length === 0) return;

    if (this._memoryOnly || !this.db) {
      for (const e of events) this.memPut(e);
      return;
    }

    try {
      await txWrite(this.db, STORE_NAME, (store) => {
        for (const e of events) store.put(e);
      });
    } catch {
      for (const e of events) this.memPut(e);
    }
  }

  async getEvents(
    sessionId: string,
    epoch: number,
    opts?: { limit?: number; afterSeq?: number },
  ): Promise<TimelineEvent[]> {
    if (this._memoryOnly || !this.db) {
      return this.memGet(sessionId, epoch, opts);
    }

    try {
      const afterSeq = opts?.afterSeq ?? -1;
      const limit = opts?.limit ?? Infinity;

      return await new Promise<TimelineEvent[]>((resolve, reject) => {
        const tx = this.db!.transaction(STORE_NAME, 'readonly');
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
    if (this._memoryOnly || !this.db) {
      return this.memGetByTime(sessionId, opts);
    }

    try {
      const limit = opts?.limit ?? Infinity;

      return await new Promise<TimelineEvent[]>((resolve, reject) => {
        const tx = this.db!.transaction(STORE_NAME, 'readonly');
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

  async getLastSeqAndEpoch(sessionId: string): Promise<{ seq: number; epoch: number } | null> {
    if (this._memoryOnly || !this.db) {
      return this.memLastSeqEpoch(sessionId);
    }

    try {
      return await new Promise<{ seq: number; epoch: number } | null>((resolve, reject) => {
        const tx = this.db!.transaction(STORE_NAME, 'readonly');
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
    if (this._memoryOnly || !this.db) {
      const key = sessionId;
      const events = this.memoryFallback.get(key);
      if (events) {
        this.memoryFallback.set(key, events.filter((e) => e.epoch !== epoch));
      }
      return;
    }

    try {
      const events = await this.getEvents(sessionId, epoch);
      await txWrite(this.db, STORE_NAME, (store) => {
        for (const e of events) store.delete(e.eventId);
      });
    } catch {
      // best-effort
    }
  }

  async pruneOldEvents(sessionId: string, keepCount: number): Promise<void> {
    if (this._memoryOnly || !this.db) {
      const events = this.memoryFallback.get(sessionId);
      if (events && events.length > keepCount) {
        this.memoryFallback.set(sessionId, events.slice(-keepCount));
      }
      return;
    }

    try {
      // Get all events for session, ordered by ts
      const all = await new Promise<TimelineEvent[]>((resolve, reject) => {
        const tx = this.db!.transaction(STORE_NAME, 'readonly');
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
      await txWrite(this.db, STORE_NAME, (store) => {
        for (const e of toDelete) store.delete(e.eventId);
      });
    } catch {
      // best-effort
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
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
      events[idx] = event;
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
