import { DAEMON_MSG } from '@shared/daemon-events.js';
/**
 * React hook for timeline event state management.
 * Loads from daemon file store on connect, caches in IndexedDB,
 * listens for real-time WS events, handles reconnection replay.
 */

import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import type { WsClient, TimelineEvent, ServerMessage } from '../ws-client.js';
import { TimelineDB } from '../timeline-db.js';
import { mergeTimelineEvents, preferTimelineEvent } from '../../../src/shared/timeline/merge.js';

// Singleton DB shared across all useTimeline instances — opened once at module load.
// This avoids per-hook open() latency and ensures the DB is ready before any hook queries it.
const sharedDb = new TimelineDB();
sharedDb.open().catch(() => {});

// Module-level events cache: sessionId → latest events array.
// Updated by every useTimeline instance so that a second instance for the same
// session (e.g. SubSessionWindow opening while SubSessionCard is running) can
// render immediately from in-memory state without waiting for IDB or network.
const eventsCache = new Map<string, TimelineEvent[]>();
const eventsCacheAccess = new Map<string, number>();
const cacheListeners = new Map<string, Set<(events: TimelineEvent[]) => void>>();

const MAX_MEMORY_EVENTS = 300;
const MAX_HISTORY_EVENTS = 2000;
const MAX_CACHED_SESSIONS = 12;
const MAX_TOTAL_CACHED_EVENTS = 12_000;
const ECHO_WINDOW_MS = 500;
// Dedup window for user.message from JSONL vs web-UI-sent: JSONL watcher polls every 2s,
// so the same message can arrive twice (once from command-handler, once from JSONL).
// 5s is enough to catch the JSONL delay without hiding legitimate repeated messages.
const USER_MSG_DEDUP_WINDOW_MS = 5_000;

/** Normalize text for echo comparison: strip prompt prefixes, collapse whitespace. */
function normalizeForEcho(text: string): string {
  return text
    .trim()
    .replace(/^[❯>λ›$%#]\s*/, '')
    .replace(/\s+/g, ' ');
}

function markCacheAccess(cacheKey: string): void {
  eventsCacheAccess.set(cacheKey, Date.now());
}

function getCachedEvents(cacheKey: string): TimelineEvent[] | undefined {
  const cached = eventsCache.get(cacheKey);
  if (cached) markCacheAccess(cacheKey);
  return cached;
}

function setCachedEvents(cacheKey: string, events: TimelineEvent[]): void {
  eventsCache.set(cacheKey, events);
  markCacheAccess(cacheKey);
  const listeners = cacheListeners.get(cacheKey);
  if (listeners) {
    for (const listener of listeners) listener(events);
  }
  pruneTimelineCache();
}

function subscribeCache(cacheKey: string, listener: (events: TimelineEvent[]) => void): () => void {
  let listeners = cacheListeners.get(cacheKey);
  if (!listeners) {
    listeners = new Set();
    cacheListeners.set(cacheKey, listeners);
  }
  listeners.add(listener);
  return () => {
    const set = cacheListeners.get(cacheKey);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) cacheListeners.delete(cacheKey);
  };
}

function pruneTimelineCache(): void {
  let totalEvents = 0;
  for (const events of eventsCache.values()) totalEvents += events.length;
  if (eventsCache.size <= MAX_CACHED_SESSIONS && totalEvents <= MAX_TOTAL_CACHED_EVENTS) return;

  const evictionOrder = [...eventsCache.keys()]
    .map((key) => ({ key, at: eventsCacheAccess.get(key) ?? 0, size: eventsCache.get(key)?.length ?? 0 }))
    .sort((a, b) => a.at - b.at);

  for (const entry of evictionOrder) {
    if (eventsCache.size <= MAX_CACHED_SESSIONS && totalEvents <= MAX_TOTAL_CACHED_EVENTS) break;
    if (eventsCache.delete(entry.key)) {
      eventsCacheAccess.delete(entry.key);
      totalEvents -= entry.size;
    }
  }
}

function scopeCacheKey(serverId: string | null | undefined, sessionId: string): string {
  return serverId ? `${serverId}:${sessionId}` : sessionId;
}

function scopeEventsForDb(cacheKey: string, events: TimelineEvent[]): TimelineEvent[] {
  if (cacheKey === events[0]?.sessionId) return events;
  return events.map((event) => ({ ...event, sessionId: cacheKey }));
}

function persistTimelineEvents(cacheKey: string, events: TimelineEvent[]): void {
  if (events.length === 0) return;
  sharedDb.putEvents(scopeEventsForDb(cacheKey, events)).catch(() => {});
}

function getSharedTimelineBase(
  cacheKey: string | null | undefined,
  localEvents: TimelineEvent[],
  maxEvents = MAX_MEMORY_EVENTS,
): TimelineEvent[] {
  if (!cacheKey) return localEvents;
  const shared = getCachedEvents(cacheKey);
  if (!shared || shared === localEvents) return localEvents;
  if (shared.length === 0) return localEvents;
  if (localEvents.length === 0) return shared;
  return mergeTimelineEvents(shared, localEvents, maxEvents);
}

export function __getSharedTimelineBaseForTests(
  cacheKey: string | null | undefined,
  localEvents: TimelineEvent[],
  maxEvents = MAX_MEMORY_EVENTS,
): TimelineEvent[] {
  return getSharedTimelineBase(cacheKey, localEvents, maxEvents);
}

export function __resetTimelineCacheForTests(): void {
  eventsCache.clear();
  eventsCacheAccess.clear();
  cacheListeners.clear();
}

export function __getTimelineCacheKeysForTests(): string[] {
  return [...eventsCache.keys()];
}

export function __setTimelineCacheForTests(cacheKey: string, events: TimelineEvent[]): void {
  setCachedEvents(cacheKey, events);
}

export function ingestTimelineEventForCache(event: TimelineEvent, serverId?: string | null): void {
  const cacheKey = scopeCacheKey(serverId, event.sessionId);
  const existing = getCachedEvents(cacheKey) ?? [];
  const merged = mergeTimelineEvents(existing, [event], MAX_MEMORY_EVENTS);
  if (merged !== existing) setCachedEvents(cacheKey, merged);
  persistTimelineEvents(cacheKey, [event]);
}

export interface UseTimelineResult {
  events: TimelineEvent[];
  loading: boolean;
  /** True while gap-filling after a cache hit — content is visible but may be stale */
  refreshing: boolean;
  /** True while loading older events via backward pagination */
  loadingOlder: boolean;
  /** False when backward pagination returned 0 events (no more history to load) */
  hasOlderHistory: boolean;
  /** Immediately inject a pending user message (optimistic UI). */
  addOptimisticUserMessage: (text: string) => void;
  /** Load older events before the earliest currently loaded event. */
  loadOlderEvents: () => void;
}

export function useTimeline(
  sessionId: string | null,
  ws: WsClient | null,
  serverId?: string | null,
): UseTimelineResult {
  // IDB + memory cache key: scope by serverId to prevent cross-server pollution
  // when different servers share the same session name (e.g. deck_cd_brain).
  const cacheKey = sessionId ? scopeCacheKey(serverId, sessionId) : sessionId;
  const cacheKeyRef = useRef(cacheKey);
  cacheKeyRef.current = cacheKey;
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const [hasOlderHistory, setHasOlderHistory] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingOlderRef = useRef(false); // Synchronous guard against duplicate pagination requests
  const epochRef = useRef<number>(0);
  const seqRef = useRef<number>(0);
  const replayRequestIdRef = useRef<string | null>(null);
  const historyRequestIdRef = useRef<string | null>(null);
  const olderRequestIdRef = useRef<string | null>(null);
  const historyLoadedRef = useRef<string | null>(null); // tracks which session has been loaded
  const historyRetryRef = useRef(0); // retry count for empty history responses

  useEffect(() => {
    if (!cacheKey) return;
    return subscribeCache(cacheKey, (nextEvents) => {
      setEvents((prev) => (prev === nextEvents ? prev : nextEvents));
    });
  }, [cacheKey]);

  // Reset on session change — but DON'T clear events when sessionId becomes null
  // (window minimized). The memory cache (eventsCache) preserves them for instant
  // restore when the window reopens.
  useEffect(() => {
    if (!sessionId) {
      setLoading(false);
      resetOlderState();
      return;
    }

    setRefreshing(false);
    resetOlderState();
    setHasOlderHistory(true);

    let cancelled = false;

    // 1. Module-level memory cache — instant restore (e.g. window reopen)
    const memCached = getCachedEvents(cacheKey!);
    if (memCached && memCached.length > 0) {
      setEvents(memCached);
      setLoading(false);
      if (ws?.connected) {
        setRefreshing(true);
        historyRequestIdRef.current = ws.sendTimelineHistoryRequest(sessionId, MAX_MEMORY_EVENTS);
      }
      return () => { cancelled = true; };
    }

    // 2. Already loaded this session — skip reload (prevents flash-of-empty on minimize/restore)
    if (historyLoadedRef.current === cacheKey) {
      setLoading(false);
      // Just request incremental updates
      if (ws?.connected) {
        setRefreshing(true);
        historyRequestIdRef.current = ws.sendTimelineHistoryRequest(sessionId, MAX_MEMORY_EVENTS);
      }
      return () => { cancelled = true; };
    }

    // 3. IndexedDB cache → daemon history (first load for this session in this page session)
    setLoading(true);
    const load = async () => {
      const db = sharedDb;
      if (!db) return;
      await db.open();
      if (cancelled) return;
      const last = await db.getLastSeqAndEpoch(cacheKey!);
      if (cancelled) return;
      if (last) {
        epochRef.current = last.epoch;
        seqRef.current = last.seq;
        const stored = await db.getRecentEvents(cacheKey!, { limit: MAX_MEMORY_EVENTS });
        if (cancelled) return;
        const existing = getSharedTimelineBase(cacheKey!, eventsRef.current, MAX_MEMORY_EVENTS);
        const restored = mergeTimelineEvents(existing, stored, MAX_MEMORY_EVENTS);
        setCachedEvents(cacheKey!, restored);
        setEvents((prev) => (prev === restored ? prev : restored));
        setLoading(false);
        historyLoadedRef.current = cacheKeyRef.current;
        if (ws?.connected) {
          setRefreshing(true);
          historyRequestIdRef.current = ws.sendTimelineHistoryRequest(sessionId, MAX_MEMORY_EVENTS);
        }
      } else {
        epochRef.current = 0;
        seqRef.current = 0;
        if (cancelled) return;
        setEvents([]);
        if (ws?.connected) {
          historyRequestIdRef.current = ws.sendTimelineHistoryRequest(sessionId);
        } else {
          setLoading(false);
        }
      }
    };
    load().catch(() => {});
    return () => { cancelled = true; };
  }, [sessionId, ws]);

  // Immediately show a user message before the daemon confirms it.
  // The real event (from WS) will remove the pending version on arrival.
  const addOptimisticUserMessage = useCallback((text: string) => {
    if (!sessionId) return;
    const event: TimelineEvent = {
      eventId: `optimistic:${sessionId}:${Date.now()}`,
      type: 'user.message',
      sessionId,
      ts: Date.now(),
      epoch: 0,
      seq: 0,
      source: 'daemon',
      confidence: 'high',
      payload: { text, pending: true },
    };
    setEvents((prev) => {
      const base = getSharedTimelineBase(cacheKeyRef.current, prev, MAX_MEMORY_EVENTS);
      const result = [...base, event];
      if (cacheKeyRef.current) setCachedEvents(cacheKeyRef.current, result);
      return result;
    });
  }, [sessionId]);

  const olderTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetOlderState = useCallback(() => {
    loadingOlderRef.current = false;
    olderRequestIdRef.current = null;
    if (olderTimeoutRef.current) { clearTimeout(olderTimeoutRef.current); olderTimeoutRef.current = null; }
    setLoadingOlder(false);
  }, []);

  // Load older events (backward pagination)
  const loadOlderEvents = useCallback(() => {
    if (!ws?.connected || !sessionId || loadingOlderRef.current) return;
    const key = cacheKeyRef.current;
    const cached = key ? getCachedEvents(key) : undefined;
    if (!cached || cached.length === 0) return;
    const oldestTs = Math.min(...cached.map((e) => e.ts));
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    olderRequestIdRef.current = ws.sendTimelineHistoryRequest(sessionId, MAX_MEMORY_EVENTS, undefined, oldestTs);
    // Timeout: if response never arrives (packet loss, disconnect), reset after 10s
    if (olderTimeoutRef.current) clearTimeout(olderTimeoutRef.current);
    olderTimeoutRef.current = setTimeout(resetOlderState, 10_000);
  }, [ws, sessionId]);

  // Append or replace a single event by eventId.
  // Same eventId → replace in place (supports streaming transport updates).
  // New eventId → append to end.
  const appendEvent = useCallback((event: TimelineEvent) => {
    setEvents((prev) => {
      const base = getSharedTimelineBase(cacheKeyRef.current, prev, MAX_MEMORY_EVENTS);
      // Fast path: check last few events for same-ID replacement
      for (let i = base.length - 1; i >= Math.max(0, base.length - 10); i--) {
        if (base[i].eventId === event.eventId) {
          // Replace in place — enables typewriter effect for streaming events
          const current = base[i]!;
          const preferred = preferTimelineEvent(current, event);
          if (preferred === current) return base;
          const updated = [...base];
          updated[i] = preferred;
          if (cacheKeyRef.current) setCachedEvents(cacheKeyRef.current, updated);
          return updated;
        }
      }
      const next = [...base, event];
      const result = next.length > MAX_MEMORY_EVENTS
        ? next.slice(next.length - MAX_MEMORY_EVENTS)
        : next;
      if (cacheKeyRef.current) setCachedEvents(cacheKeyRef.current, result);
      return result;
    });
  }, []);

  /** Merge a batch of events into state (dedup + O(n) merge).
   *  Both `prev` and `incoming` are assumed mostly sorted by timestamp.
   *  Uses two-pointer merge instead of concatenate + full sort. */
  const mergeEvents = useCallback((incoming: TimelineEvent[], maxEvents = MAX_MEMORY_EVENTS) => {
    setEvents((prev) => {
      const base = getSharedTimelineBase(cacheKeyRef.current, prev, maxEvents);
      const result = mergeTimelineEvents(base, incoming, maxEvents);
      if (result === base) return base;
      if (cacheKeyRef.current) setCachedEvents(cacheKeyRef.current, result);
      return result;
    });
  }, []);

  // IDB helper: scope events by cacheKey so cross-server sessions don't collide
  const idbPutEvents = useCallback((evts: TimelineEvent[]) => {
    const key = cacheKeyRef.current;
    if (!key) return;
    persistTimelineEvents(key, evts);
  }, []);

  // Listen for WS messages
  useEffect(() => {
    if (!ws || !sessionId) return;

    const handler = (msg: ServerMessage) => {
      // ── Real-time event ──
      if (msg.type === 'timeline.event') {
        const event = msg.event;
        if (event.sessionId !== sessionId) return;

        // Echo dedup: hide assistant.text that echoes a recent user message (e.g. prompt repeat).
        // Read current events via ref (avoid unnecessary setEvents call that returns prev unchanged).
        if (event.type === 'assistant.text' && event.payload.text) {
          const normalized = normalizeForEcho(String(event.payload.text));
          const prev = eventsRef.current;
          const recentUserMsg = prev.find(
            (e) =>
              e.type === 'user.message' &&
              e.ts > event.ts - ECHO_WINDOW_MS &&
              normalizeForEcho(String(e.payload.text ?? '')) === normalized,
          );
          if (recentUserMsg) event.hidden = true;
        }

        // user.message: remove matching optimistic (pending) event, then dedup
        // against already-confirmed events (JSONL watcher re-emits same text ~2s later).
        if (event.type === 'user.message' && event.payload.text) {
          const text = String(event.payload.text).trim();
          const allowDuplicate = event.payload.allowDuplicate === true;
          let skipAppend = false;
          setEvents((prev) => {
            const base = getSharedTimelineBase(cacheKeyRef.current, prev, MAX_MEMORY_EVENTS);
            // Remove pending version of this message (optimistic UI cleanup)
            const withoutPending = base.filter(
              (e) => !(e.type === 'user.message' && e.payload.pending && String(e.payload.text ?? '').trim() === text),
            );
            if (withoutPending.length < base.length) {
              if (cacheKeyRef.current) setCachedEvents(cacheKeyRef.current, withoutPending);
              return withoutPending;
            }
            // No pending event — check for confirmed dedup (JSONL re-emit)
            const isDup = !allowDuplicate && base.some(
              (e) =>
                e.type === 'user.message' &&
                e.payload.allowDuplicate !== true &&
                !e.payload.pending &&
                Math.abs(e.ts - event.ts) < USER_MSG_DEDUP_WINDOW_MS &&
                String(e.payload.text ?? '').trim() === text,
            );
            if (isDup) skipAppend = true;
            return base;
          });
          if (skipAppend) return;
        }

        // Update epoch tracker — don't clear events on epoch change;
        // history response will merge the authoritative set, and ts-sort handles cross-epoch order.
        epochRef.current = event.epoch;
        seqRef.current = Math.max(seqRef.current, event.seq);
        appendEvent(event);

        idbPutEvents([event]);
      }

      // ── History response (full load from daemon file store) ──
      if (msg.type === 'timeline.history') {
        if (msg.sessionName !== sessionId) return;

        // Handle backward pagination response
        if (msg.requestId && msg.requestId === olderRequestIdRef.current) {
          resetOlderState();
          if (msg.events.length > 0) {
            mergeEvents(msg.events, MAX_HISTORY_EVENTS);
            idbPutEvents(msg.events);
          } else {
            setHasOlderHistory(false);
          }
          return;
        }

        // Accept any same-session history batch for forward sync. Mobile
        // reconnect/background churn can legitimately create overlapping history
        // requests; dropping the earlier response can leave the UI stuck on old
        // cache if the newest request never completes. Since history merges by
        // eventId and ts, older batches cannot delete newer events.
        if (!olderRequestIdRef.current || msg.requestId !== olderRequestIdRef.current) {
          if (!historyRequestIdRef.current || msg.requestId === historyRequestIdRef.current) {
            historyRequestIdRef.current = null;
          }
        }
        historyLoadedRef.current = cacheKeyRef.current;

        epochRef.current = msg.epoch;

        if (msg.events.length > 0) {
          historyRetryRef.current = 0; // reset on success
          const maxSeq = msg.events.reduce((max, e) => Math.max(max, e.seq), 0);
          seqRef.current = Math.max(seqRef.current, maxSeq);
          mergeEvents(msg.events);
          idbPutEvents(msg.events);
        } else if (historyRetryRef.current < 2 && ws?.connected && eventsRef.current.length === 0) {
          // Empty response with no cached events — retry once after a short delay
          // (defense-in-depth for transient bridge/daemon failures)
          historyRetryRef.current++;
          setTimeout(() => {
            if (ws?.connected && sessionId) {
              historyRequestIdRef.current = ws.sendTimelineHistoryRequest(sessionId, MAX_MEMORY_EVENTS);
            }
          }, 1000 * historyRetryRef.current);
        }
        setLoading(false);
        setRefreshing(false);
      }

      // ── Replay response (gap-fill after reconnect) ──
      if (msg.type === 'timeline.replay') {
        if (msg.sessionName !== sessionId) return;
        if (msg.requestId && msg.requestId !== replayRequestIdRef.current) return;
        replayRequestIdRef.current = null;
        const { events: replayEvents, truncated, epoch } = msg;

        // Update epoch — don't clear events, ts-sort handles cross-epoch order
        epochRef.current = epoch;

        if (truncated && ws) {
          ws.sendSnapshotRequest(sessionId);
        }

        if (replayEvents.length > 0) {
          const maxSeq = replayEvents.reduce((max, e) => Math.max(max, e.seq), 0);
          seqRef.current = Math.max(seqRef.current, maxSeq);
          mergeEvents(replayEvents);
          idbPutEvents(replayEvents);
        }
        setRefreshing(false);
      }

      // ── Reconnect: daemon restarted → epoch changed, replay is useless. Request only new events. ──
      if (msg.type === DAEMON_MSG.RECONNECTED) {
        // Clear pending optimistic messages — they were sent to the old connection
        // and we can't guarantee they reached the agent. The history replay below
        // will bring back any messages that were actually processed.
        setEvents((prev) => {
          const base = getSharedTimelineBase(cacheKeyRef.current, prev, MAX_MEMORY_EVENTS);
          const cleaned = base.filter((e) => !(e.type === 'user.message' && e.payload.pending));
          if (cleaned.length !== base.length && cacheKeyRef.current) setCachedEvents(cacheKeyRef.current, cleaned);
          return cleaned;
        });
        if (ws && sessionId) {
          setRefreshing(true);
          historyRequestIdRef.current = ws.sendTimelineHistoryRequest(sessionId, MAX_MEMORY_EVENTS);
        }
      }
      // ── Browser WS disconnected: reset in-flight pagination to prevent stuck state ──
      if (msg.type === 'session.event' && (msg as { event: string }).event === 'disconnected') {
        if (loadingOlderRef.current) resetOlderState();
      }
      // ── Browser WS reconnected: fill gaps using afterTs for reliability ──
      // Always use timestamp-based history (not seq-based replay) to avoid
      // epoch mismatch and seq desync issues on mobile (app killed/backgrounded).
      if (msg.type === 'session.event' && (msg as { event: string }).event === 'connected') {
        if (ws && sessionId) {
          historyRequestIdRef.current = ws.sendTimelineHistoryRequest(sessionId, MAX_MEMORY_EVENTS);
        }
      }
    };

    const unsub = ws.onMessage(handler);
    return unsub;
  }, [ws, sessionId, appendEvent, mergeEvents]);

  return { events, loading, refreshing, loadingOlder, hasOlderHistory, addOptimisticUserMessage, loadOlderEvents };
}
