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
import { isLastValueTimelineEventType } from '../../src/shared/timeline/types.js';

const DB_NAME = 'imcodes-timeline';
const DB_VERSION = 1;
const STORE_NAME = 'events';

/**
 * How long to stay in transient memory-only mode after an open failure before
 * the next `ensureOpen()` retries the real IndexedDB open. Local data has no
 * network excuse to fail — a failed open MUST be retryable without a full page
 * reload (run 016f9b5b-c8f).
 */
const OPEN_RETRY_BACKOFF_MS = 3_000;
/** Reject a permanently-`blocked` open after this long so callers can retry. */
const OPEN_BLOCKED_TIMEOUT_MS = 1_500;

export class TimelineDB {
  private db: IDBDatabase | null = null;
  private openPromise: Promise<IDBDatabase | null> | null = null;
  private memoryFallback = new Map<string, TimelineEvent[]>();
  private _memoryOnly = false;
  private lastOpenFailureAt = 0;
  // Incremented on every resetAndReopen() so a superseded in-flight open chain's
  // .then/.catch side effects (set db / _memoryOnly / openPromise) are discarded
  // instead of clobbering the fresh open (run 016f9b5b-c8f NB1).
  private openGen = 0;

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
   * Force a fresh open attempt, clearing any transient memory-only degradation.
   * Used by explicit user recovery (the chat ↻ button → local reload) so a
   * prior open failure never permanently blocks reading on-disk history.
   */
  async resetAndReopen(): Promise<IDBDatabase | null> {
    this.openGen += 1; // invalidate any in-flight open chain's side effects
    try { this.db?.close(); } catch { /* ignore */ }
    this.db = null;
    this.openPromise = null;
    this._memoryOnly = false;
    this.lastOpenFailureAt = 0;
    return this.ensureOpen();
  }

  /**
   * Single-flight open. Resolves with the live `IDBDatabase` on success or
   * `null` when open() rejected (quota / private mode / corruption / blocked).
   * On the first successful open we also drain `memoryFallback` into IDB so
   * cold-start writes are durable.
   *
   * Failure is TRANSIENT, not a permanent latch: after an open failure we stay
   * memory-only only for `OPEN_RETRY_BACKOFF_MS`, then the next call retries the
   * real open. This satisfies "local load must be retryable" — a transient
   * quota/lock/private-mode blip must not strand on-disk history until a full
   * page reload.
   */
  private async ensureOpen(): Promise<IDBDatabase | null> {
    if (this.db) return this.db;
    if (this._memoryOnly) {
      if (Date.now() - this.lastOpenFailureAt < OPEN_RETRY_BACKOFF_MS) return null;
      // Backoff elapsed → drop the transient degradation and retry below.
      this._memoryOnly = false;
    }
    if (!this.openPromise) {
      const gen = this.openGen;
      this.openPromise = this.openInternal()
        .then(async (db) => {
          if (gen !== this.openGen) {
            // A resetAndReopen() superseded this attempt — discard its side
            // effects and close the now-orphaned connection (don't leak it).
            if (db) { try { db.close(); } catch { /* ignore */ } }
            return null;
          }
          if (db) {
            this.db = db;
            await this.flushMemoryFallbackToDb(db);
          }
          return db;
        })
        .catch(() => {
          // Superseded by a reset → don't clobber the fresh open's state.
          if (gen !== this.openGen) return null;
          this._memoryOnly = true;
          this.lastOpenFailureAt = Date.now();
          // Drop the cached rejected promise so a later call can retry a fresh
          // open once the backoff window elapses (no permanent latch).
          this.openPromise = null;
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

      // Single settle point so a late onsuccess after a blocked-timeout reject
      // closes the orphan connection instead of leaking it (run 016f9b5b-c8f
      // #2/B5), and the blocked timer is always cleared on success/error.
      let settled = false;
      let blockedTimer: ReturnType<typeof setTimeout> | null = null;
      const finishSuccess = (db: IDBDatabase): void => {
        if (settled) {
          // Holder released after we already timed out → close the orphan so it
          // doesn't linger and block future version upgrades.
          try { db.close(); } catch { /* ignore */ }
          return;
        }
        settled = true;
        if (blockedTimer) { clearTimeout(blockedTimer); blockedTimer = null; }
        resolve(db);
      };
      const finishError = (err: unknown): void => {
        if (settled) return;
        settled = true;
        if (blockedTimer) { clearTimeout(blockedTimer); blockedTimer = null; }
        reject(err);
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
        finishSuccess(db);
      };
      req.onerror = () => finishError(req.error);
      req.onblocked = () => {
        // Another tab still holds a connection to the old version. Don't hang
        // forever — if the holder doesn't release within the timeout, reject so
        // the caller falls back to memory + a backoff retry instead of a
        // permanently-pending promise. A late `onsuccess` closes the orphan.
        blockedTimer = setTimeout(() => finishError(new Error('idb_open_blocked')), OPEN_BLOCKED_TIMEOUT_MS);
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

        // `getAll(range, count)` stops the clone at `count` records. Passing
        // the limit to IDB rather than slicing afterwards matters because
        // getAll structured-clones every record it returns: slicing after the
        // fact still paid the full deserialization cost for rows we discard.
        const req = Number.isFinite(limit) ? index.getAll(range, limit) : index.getAll(range);
        req.onsuccess = () => resolve(req.result as TimelineEvent[]);
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
      return await this.getRecentEventsTx(db, sessionId, opts);
    } catch {
      return this.memGetByTime(sessionId, opts);
    }
  }

  private getRecentEventsTx(
    db: IDBDatabase,
    sessionId: string,
    opts?: { limit?: number },
  ): Promise<TimelineEvent[]> {
    const limit = opts?.limit ?? Infinity;
    return new Promise<TimelineEvent[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('session_ts');

      const lower = [sessionId, 0];
      const upper = [sessionId, Infinity];
      const range = IDBKeyRange.bound(lower, upper);

      // An unbounded read still wants the single-round-trip getAll.
      if (!Number.isFinite(limit)) {
        const req = index.getAll(range);
        req.onsuccess = () => resolve(req.result as TimelineEvent[]);
        req.onerror = () => reject(req.error);
        return;
      }

      // Bounded read: walk newest-first and stop at `limit`.
      //
      // This used to be `getAll(range)` followed by `slice(-limit)`. getAll
      // structured-clones EVERY record in the range, so restoring the last 300
      // events deserialized the session's entire stored history — and nothing
      // ever prunes that store, so opening a chat got monotonically slower the
      // longer the session had been used. Every mounted useTimeline (the open
      // pane, every SubSessionCard preview, pinned panels) paid it against one
      // shared connection. A 'prev' cursor clones only the records we keep, so
      // the cost is O(limit) instead of O(total stored events).
      //
      // `getAll(range, count)` is not usable here: count takes from the START
      // of the range and we need the END.
      const out: TimelineEvent[] = [];
      const req = index.openCursor(range, 'prev');
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { out.reverse(); resolve(out); return; }
        out.push(cursor.value as TimelineEvent);
        // Ascending order is the contract callers merge against, so undo the
        // newest-first walk before handing the page back.
        if (out.length >= limit) { out.reverse(); resolve(out); return; }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Rewrite the given events' storage scope from a bare/raw `sessionId` key to
   * the serverId-scoped key, in a single readwrite transaction. No delete.
   *
   * CRITICAL: the object store's primary key is `eventId` ALONE (not composite
   * with sessionId), so a raw row and a scoped row CANNOT coexist for the same
   * `eventId` — they are the same physical row. The previous implementation
   * ("put(restamped) then delete(eventId)") therefore DELETED the row it had
   * just rewritten, destroying local history (run 016f9b5b-c8f A1/RV1). This is
   * a pure in-place `sessionId` rewrite: for each event we `get` the current
   * row, pick the more-complete payload, and `put` it back with
   * `sessionId=scopedKey` (forced explicitly — NOT relying on a merge
   * tie-break, so scoping can't silently revert).
   *
   * Why this exists: `useTimeline` scopes the IDB key by serverId
   * (`${serverId}:${sessionId}`). When the app first paints with
   * `selectedServerId === null`, WS events persist under the bare `sessionId`;
   * once serverId resolves, scoped reads miss those bare rows. This consolidates
   * them under the scoped key. Best-effort; on failure the rows remain readable
   * under the raw key (the read path dual-reads both).
   *
   * See `.imc/discussions/e9dbc48c-dda.md` PR-4 and `016f9b5b-c8f` for the audit.
   */
  async migrateRawToScoped(
    rawSessionId: string,
    scopedKey: string,
    rawEvents: TimelineEvent[],
  ): Promise<void> {
    if (rawSessionId === scopedKey || rawEvents.length === 0) return;
    const db = await this.ensureOpen();
    if (!db) {
      // Memory-only: re-stamp the in-memory copies under the scoped key.
      for (const event of rawEvents) this.memPut({ ...event, sessionId: scopedKey });
      return;
    }
    await new Promise<void>((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const event of rawEvents) {
          const getReq = store.get(event.eventId);
          getReq.onsuccess = () => {
            const existing = getReq.result as TimelineEvent | undefined;
            const preferred = existing ? preferTimelineEvent(existing, event) : event;
            store.put({ ...preferred, sessionId: scopedKey });
          };
          getReq.onerror = () => reject(getReq.error);
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
      // Primary keys only, ordered by ts. Deleting needs the key and nothing
      // else, so `getAllKeys` avoids structured-cloning payloads we are about
      // to throw away — the old `getAll` made pruning cost as much as the
      // unbounded read it exists to prevent.
      const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const index = store.index('session_ts');
        const lower = [sessionId, 0];
        const upper = [sessionId, Infinity];
        const range = IDBKeyRange.bound(lower, upper);
        const req = index.getAllKeys(range);
        req.onsuccess = () => resolve(req.result as IDBValidKey[]);
        req.onerror = () => reject(req.error);
      });

      if (keys.length <= keepCount) return;

      const toDelete = keys.slice(0, keys.length - keepCount);
      await txWrite(db, STORE_NAME, (store) => {
        for (const key of toDelete) store.delete(key);
      });
    } catch {
      // best-effort
    }
  }

  /**
   * Trim a session to what can actually be rendered, in one newest-first pass.
   *
   * Two different retention rules, because the stream holds two different kinds
   * of record:
   *   - History (the conversation) keeps the newest `keepHistoryEvents`.
   *   - Last-value signals (session state, token usage, agent status, ...) keep
   *     exactly ONE row each: only the newest is ever displayed, so every older
   *     copy is storage and page budget spent on something unrenderable.
   *
   * That second rule is what makes a bounded read useful. Measured on a real
   * store, `session.state` alone was ~67% of all events and the whole
   * last-value group ~84%, so the newest 60 raw events of a busy agent session
   * contained as few as ONE actual message — a page counted in raw events was
   * mostly counting churn.
   *
   * Fail-safe by construction: only the short explicit last-value allowlist is
   * collapsed. An unclassified (e.g. newly added) event type is treated as
   * history and kept.
   *
   * Returns null when the store is unavailable — pruning is best-effort and
   * must never be attempted against the memory fallback, where the DB cannot
   * report what is actually on disk.
   */
  async pruneSessionHistory(
    sessionId: string,
    keepHistoryEvents: number,
    opts?: { maxDeletions?: number },
  ): Promise<{ deleted: number; done: boolean } | null> {
    const db = await this.ensureOpen();
    if (!db) return null;
    // No total-count shortcut here. An earlier version skipped the sweep when
    // the session held fewer rows than `keepHistoryEvents`, which silently
    // disabled the last-value collapse: a small store that is 90% superseded
    // state events is "within budget" by row count and still needs collapsing.
    // The walk is bounded and runs off the paint path, so pay it.
    const maxDeletions = Math.max(1, opts?.maxDeletions ?? Number.MAX_SAFE_INTEGER);
    try {
      return await new Promise<{ deleted: number; done: boolean }>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const index = tx.objectStore(STORE_NAME).index('session_ts');
        const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Infinity]);
        const keptLastValueTypes = new Set<string>();
        let historyKept = 0;
        let deleted = 0;
        let done = true;
        const req = index.openCursor(range, 'prev');
        req.onsuccess = () => {
          const cursor = req.result;
          // Walk finished; tx.oncomplete settles once the deletes commit.
          if (!cursor) return;
          // Stop the transaction short once the deletion budget is spent. A
          // never-pruned store holds tens of thousands of rows, and deleting
          // them in ONE readwrite transaction blocks every other session's
          // read on this shared connection -- which showed up as chats opening
          // blank and stuck on "local cache" while the sweep ran. Deletions are
          // taken from the OLDEST end, so a capped sweep always makes progress
          // and the next one resumes.
          if (deleted >= maxDeletions) { done = false; return; }
          const type = String((cursor.value as TimelineEvent).type ?? '');
          let drop: boolean;
          if (isLastValueTimelineEventType(type)) {
            // Newest-first, so the FIRST one seen for a type is the survivor.
            drop = keptLastValueTypes.has(type);
            if (!drop) keptLastValueTypes.add(type);
          } else {
            historyKept += 1;
            drop = historyKept > keepHistoryEvents;
          }
          if (drop) {
            cursor.delete();
            deleted += 1;
          }
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => resolve({ deleted, done });
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } catch {
      return null;
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
