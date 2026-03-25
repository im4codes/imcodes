/**
 * React hook for timeline event state management.
 * Loads from daemon file store on connect, caches in IndexedDB,
 * listens for real-time WS events, handles reconnection replay.
 */

import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import type { WsClient, TimelineEvent, ServerMessage } from '../ws-client.js';
import { TimelineDB } from '../timeline-db.js';

// Singleton DB shared across all useTimeline instances — opened once at module load.
// This avoids per-hook open() latency and ensures the DB is ready before any hook queries it.
const sharedDb = new TimelineDB();
sharedDb.open().catch(() => {});

// Module-level events cache: sessionId → latest events array.
// Updated by every useTimeline instance so that a second instance for the same
// session (e.g. SubSessionWindow opening while SubSessionCard is running) can
// render immediately from in-memory state without waiting for IDB or network.
const eventsCache = new Map<string, TimelineEvent[]>();

const MAX_MEMORY_EVENTS = 2000;
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

export interface UseTimelineResult {
  events: TimelineEvent[];
  loading: boolean;
  /** True while gap-filling after a cache hit — content is visible but may be stale */
  refreshing: boolean;
  /** True while loading older events via backward pagination */
  loadingOlder: boolean;
  /** Immediately inject a pending user message (optimistic UI). */
  addOptimisticUserMessage: (text: string) => void;
  /** Load older events before the earliest currently loaded event. */
  loadOlderEvents: () => void;
}

export function useTimeline(
  sessionId: string | null,
  ws: WsClient | null,
): UseTimelineResult {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
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

  // Reset on session change
  useEffect(() => {
    if (!sessionId) {
      setEvents([]);
      setLoading(false);
      resetOlderState();
      epochRef.current = 0;
      seqRef.current = 0;
      historyLoadedRef.current = null;
      return;
    }

    setRefreshing(false);
    resetOlderState();
    historyLoadedRef.current = null;

    let cancelled = false;

    // Check module-level memory cache first — shows events instantly for sessions
    // already loaded in this page session (e.g. SubSessionWindow reopened while
    // SubSessionCard had been receiving events).
    const memCached = eventsCache.get(sessionId);
    if (memCached && memCached.length > 0) {
      setEvents(memCached);
      setLoading(false);
      // Request only events newer than what we already have
      if (ws?.connected) {
        setRefreshing(true);
        const afterTs = Math.max(...memCached.map((e) => e.ts));
        historyRequestIdRef.current = ws.sendTimelineHistoryRequest(sessionId, 500, afterTs);
      }
      return () => { cancelled = true; };
    }

    // No memory cache — load from IndexedDB as immediate cache while waiting for daemon.
    // Use getRecentEvents (ts-based, no epoch filter) so cached events across
    // daemon restarts are all included — epoch change doesn't hide old messages.
    setLoading(true);
    const load = async () => {
      const db = sharedDb;
      if (!db) return;
      await db.open(); // ensure DB is open before querying (open() is idempotent)
      if (cancelled) return;
      const last = await db.getLastSeqAndEpoch(sessionId);
      if (cancelled) return;
      if (last) {
        epochRef.current = last.epoch;
        seqRef.current = last.seq;
        const stored = await db.getRecentEvents(sessionId, { limit: MAX_MEMORY_EVENTS });
        if (cancelled) return;
        eventsCache.set(sessionId, stored);
        setEvents(stored);
        // Cache hit — show immediately, request only events newer than cache
        setLoading(false);
        if (ws?.connected) {
          setRefreshing(true);
          const afterTs = stored.length > 0 ? Math.max(...stored.map((e) => e.ts)) : undefined;
          historyRequestIdRef.current = ws.sendTimelineHistoryRequest(sessionId, 500, afterTs);
        }
      } else {
        epochRef.current = 0;
        seqRef.current = 0;
        if (cancelled) return;
        setEvents([]);
        // No cache — request full history from daemon
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
      const result = [...prev, event];
      eventsCache.set(sessionId, result);
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
    const cached = eventsCache.get(sessionId);
    if (!cached || cached.length === 0) return;
    const oldestTs = Math.min(...cached.map((e) => e.ts));
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    olderRequestIdRef.current = ws.sendTimelineHistoryRequest(sessionId, 500, undefined, oldestTs);
    // Timeout: if response never arrives (packet loss, disconnect), reset after 10s
    if (olderTimeoutRef.current) clearTimeout(olderTimeoutRef.current);
    olderTimeoutRef.current = setTimeout(resetOlderState, 10_000);
  }, [ws, sessionId, loadingOlder]);

  // Append a single event, dedup by eventId.
  // Uses a Set for O(1) dedup instead of O(n) .some() scan.
  const appendEvent = useCallback((event: TimelineEvent) => {
    setEvents((prev) => {
      // Fast path: check last few events (most common: appending to end)
      for (let i = prev.length - 1; i >= Math.max(0, prev.length - 10); i--) {
        if (prev[i].eventId === event.eventId) return prev;
      }
      const next = [...prev, event];
      const result = next.length > MAX_MEMORY_EVENTS
        ? next.slice(next.length - MAX_MEMORY_EVENTS)
        : next;
      if (event.sessionId) eventsCache.set(event.sessionId, result);
      return result;
    });
  }, []);

  /** Merge a batch of events into state (dedup + O(n) merge).
   *  Both `prev` and `incoming` are assumed mostly sorted by timestamp.
   *  Uses two-pointer merge instead of concatenate + full sort. */
  const mergeEvents = useCallback((incoming: TimelineEvent[]) => {
    setEvents((prev) => {
      const existingIds = new Set(prev.map((e) => e.eventId));
      const newEvents = incoming.filter((e) => !existingIds.has(e.eventId));
      if (newEvents.length === 0) return prev;

      // Sort only the new events (typically small batch), then merge with already-sorted prev.
      newEvents.sort((a, b) => a.ts - b.ts);

      // Two-pointer O(n+m) merge
      const merged: TimelineEvent[] = [];
      let i = 0, j = 0;
      while (i < prev.length && j < newEvents.length) {
        if (prev[i].ts <= newEvents[j].ts) merged.push(prev[i++]);
        else merged.push(newEvents[j++]);
      }
      while (i < prev.length) merged.push(prev[i++]);
      while (j < newEvents.length) merged.push(newEvents[j++]);

      const result = merged.length > MAX_MEMORY_EVENTS
        ? merged.slice(merged.length - MAX_MEMORY_EVENTS)
        : merged;
      if (incoming[0]?.sessionId) eventsCache.set(incoming[0].sessionId, result);
      return result;
    });
  }, []);

  // Listen for WS messages
  useEffect(() => {
    if (!ws || !sessionId) return;

    const handler = (msg: ServerMessage) => {
      // ── Real-time event ──
      if (msg.type === 'timeline.event') {
        const event = msg.event;
        if (event.sessionId !== sessionId) return;

        // Echo dedup: hide assistant.text that echoes a recent user message (e.g. prompt repeat)
        if (event.type === 'assistant.text' && event.payload.text) {
          const normalized = normalizeForEcho(String(event.payload.text));
          setEvents((prev) => {
            const recentUserMsg = prev.find(
              (e) =>
                e.type === 'user.message' &&
                e.ts > event.ts - ECHO_WINDOW_MS &&
                normalizeForEcho(String(e.payload.text ?? '')) === normalized,
            );
            if (recentUserMsg) event.hidden = true;
            return prev;
          });
        }

        // user.message: remove matching optimistic (pending) event, then dedup
        // against already-confirmed events (JSONL watcher re-emits same text ~2s later).
        if (event.type === 'user.message' && event.payload.text) {
          const text = String(event.payload.text).trim();
          let skipAppend = false;
          setEvents((prev) => {
            // Remove pending version of this message (optimistic UI cleanup)
            const withoutPending = prev.filter(
              (e) => !(e.type === 'user.message' && e.payload.pending && String(e.payload.text ?? '').trim() === text),
            );
            if (withoutPending.length < prev.length) {
              if (event.sessionId) eventsCache.set(event.sessionId, withoutPending);
              return withoutPending;
            }
            // No pending event — check for confirmed dedup (JSONL re-emit)
            const isDup = prev.some(
              (e) =>
                e.type === 'user.message' &&
                !e.payload.pending &&
                Math.abs(e.ts - event.ts) < USER_MSG_DEDUP_WINDOW_MS &&
                String(e.payload.text ?? '').trim() === text,
            );
            if (isDup) skipAppend = true;
            return prev;
          });
          if (skipAppend) return;
        }

        // Update epoch tracker — don't clear events on epoch change;
        // history response will merge the authoritative set, and ts-sort handles cross-epoch order.
        epochRef.current = event.epoch;
        seqRef.current = Math.max(seqRef.current, event.seq);
        appendEvent(event);

        sharedDb?.putEvent(event).catch(() => {});
      }

      // ── History response (full load from daemon file store) ──
      if (msg.type === 'timeline.history') {
        if (msg.sessionName !== sessionId) return;

        // Handle backward pagination response
        if (msg.requestId && msg.requestId === olderRequestIdRef.current) {
          resetOlderState();
          if (msg.events.length > 0) {
            mergeEvents(msg.events);
            sharedDb?.putEvents(msg.events).catch(() => {});
          }
          return;
        }

        if (msg.requestId && msg.requestId !== historyRequestIdRef.current) return;
        historyRequestIdRef.current = null;
        historyLoadedRef.current = sessionId;

        epochRef.current = msg.epoch;

        if (msg.events.length > 0) {
          const maxSeq = msg.events.reduce((max, e) => Math.max(max, e.seq), 0);
          seqRef.current = Math.max(seqRef.current, maxSeq);
          mergeEvents(msg.events);
          sharedDb?.putEvents(msg.events).catch(() => {});
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
          sharedDb?.putEvents(replayEvents).catch(() => {});
        }
        setRefreshing(false);
      }

      // ── Reconnect: daemon restarted → epoch changed, replay is useless. Request only new events. ──
      if (msg.type === 'daemon.reconnected') {
        // Clear pending optimistic messages — they were sent to the old connection
        // and we can't guarantee they reached the agent. The history replay below
        // will bring back any messages that were actually processed.
        setEvents((prev) => {
          const cleaned = prev.filter((e) => !(e.type === 'user.message' && e.payload.pending));
          if (cleaned.length !== prev.length && sessionId) eventsCache.set(sessionId, cleaned);
          return cleaned;
        });
        if (ws && sessionId) {
          setRefreshing(true);
          const cached = eventsCache.get(sessionId);
          const afterTs = cached && cached.length > 0 ? Math.max(...cached.map((e) => e.ts)) : undefined;
          historyRequestIdRef.current = ws.sendTimelineHistoryRequest(sessionId, 500, afterTs);
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
          const cached = eventsCache.get(sessionId);
          const afterTs = cached && cached.length > 0 ? Math.max(...cached.map((e) => e.ts)) : undefined;
          historyRequestIdRef.current = ws.sendTimelineHistoryRequest(sessionId, 500, afterTs);
        }
      }
    };

    const unsub = ws.onMessage(handler);
    return unsub;
  }, [ws, sessionId, appendEvent, mergeEvents]);

  return { events, loading, refreshing, loadingOlder, addOptimisticUserMessage, loadOlderEvents };
}
