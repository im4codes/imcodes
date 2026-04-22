import { DAEMON_MSG } from '@shared/daemon-events.js';
import { TRANSPORT_MSG } from '@shared/transport-events.js';
import i18next from 'i18next';
import {
  MSG_COMMAND_FAILED,
  MSG_DAEMON_ONLINE,
  MSG_DAEMON_OFFLINE,
  type AckFailureReason,
} from '@shared/ack-protocol.js';

/** Map an AckFailureReason to a localized message suitable for failureReason payload. */
function localizedAckFailureReason(reason: AckFailureReason): string {
  // Keys live under `chat.sendFailedReason.*` in every locale JSON.
  switch (reason) {
    case 'daemon_offline':
      return i18next.t('chat.sendFailedReason.daemonOffline', 'Connection lost');
    case 'ack_timeout':
      return i18next.t('chat.sendFailedReason.ackTimeout', 'No response');
    case 'daemon_error':
      return i18next.t('chat.sendFailedReason.daemonError', 'Server error');
  }
}
/**
 * React hook for timeline event state management.
 * Loads from daemon file store on connect, caches in IndexedDB,
 * listens for real-time WS events, handles reconnection replay.
 */

import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import type { WsClient, TimelineEvent, ServerMessage } from '../ws-client.js';
import type { TimelineConfidence, TimelineSource } from '../../../src/shared/timeline/types.js';
import { TimelineDB } from '../timeline-db.js';
import { mergeTimelineEvents, preferTimelineEvent } from '../../../src/shared/timeline/merge.js';
import { fetchTimelineHistoryHttp, fetchTimelineTextTailHttp, type TimelineTextTailItem } from '../api.js';
import { normalizeTransportPendingEntries } from '../transport-queue.js';

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
const lastHttpBackfillOkAt = new Map<string, number>();
const MOUNT_BACKFILL_COOLDOWN_MS = 60_000;

function resetBackfillCooldowns(): void {
  lastHttpBackfillOkAt.clear();
}

/**
 * Custom DOM event fired when an ALREADY-MOUNTED timeline hook should force
 * an immediate HTTP backfill. Triggers:
 *
 *   1. Visibility returning from hidden (any duration). Typical case: user
 *      opens the app from a push notification and lands on a session that
 *      was already active — no re-mount happens so the mount path's
 *      backfill never fires.
 *   2. `deck:navigate` navigation from a push notification payload: the
 *      target session may already be active, in which case `setActiveSession`
 *      no-ops and the hook doesn't re-run its mount effect.
 *   3. Mobile native `App.appStateChange` resume (fires `visibilitychange`
 *      via our Capacitor bridge in ws-client.ts).
 *
 * The event is listener-only; hooks subscribe in an effect. We emit it
 * from this module's own visibility handler AND from external callers
 * (push-notifications.ts) so there's a single chokepoint hooks listen to.
 */
export const ACTIVE_TIMELINE_REFRESH_EVENT = 'deck:active-timeline-refresh';

export function dispatchActiveTimelineRefresh(): void {
  if (typeof window === 'undefined') return;
  try { window.dispatchEvent(new CustomEvent(ACTIVE_TIMELINE_REFRESH_EVENT)); } catch { /* ignore */ }
}

export function requestActiveTimelineRefresh(options?: { resetCooldowns?: boolean }): void {
  if (typeof window === 'undefined') return;
  if (options?.resetCooldowns) resetBackfillCooldowns();
  dispatchActiveTimelineRefresh();
  const fireLater = (): void => dispatchActiveTimelineRefresh();
  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => window.requestAnimationFrame(fireLater));
    return;
  }
  window.setTimeout(fireLater, 32);
}

// On every visibility transition we record when the document went hidden;
// on the return-to-visible side we clear the mount cooldown and emit a
// refresh request so the mounted timeline for the active session can
// immediately pull any missed daemon-side events.
//
// Guard against non-browser environments (vitest node / SSR):
// `document`/`window` may be undefined at import time.
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  let hiddenAt: number | null = document.visibilityState === 'hidden' ? Date.now() : null;
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    // visible: notify the mounted timeline hook for the active session.
    const wasHidden = hiddenAt !== null;
    if (wasHidden) {
      resetBackfillCooldowns();
      dispatchActiveTimelineRefresh();
    }
    hiddenAt = null;
  };
  document.addEventListener('visibilitychange', onVisibility);
  // Treat `pageshow` with a truthy `persisted` flag (bfcache restore) like a
  // fresh app open — the cache entries from before bfcache freezes are
  // stale relative to whatever landed in the meantime.
  window.addEventListener('pageshow', (ev) => {
    if ((ev as PageTransitionEvent).persisted) {
      resetBackfillCooldowns();
      dispatchActiveTimelineRefresh();
    }
  });
}

const MAX_MEMORY_EVENTS = 300;
const MAX_HISTORY_EVENTS = 2000;
const MAX_CACHED_SESSIONS = 12;
const MAX_TOTAL_CACHED_EVENTS = 12_000;
const ECHO_WINDOW_MS = 500;
const TIMELINE_HISTORY_AFTER_TS_OVERLAP_MS = 1;
// Dedup window for user.message from JSONL vs web-UI-sent: JSONL watcher polls every 2s,
// so the same message can arrive twice (once from command-handler, once from JSONL).
// 5s is enough to catch the JSONL delay without hiding legitimate repeated messages.
const USER_MSG_DEDUP_WINDOW_MS = 5_000;
const PROVISIONAL_TRANSPORT_HISTORY_PREFIX = 'transport-history:';
const OPTIMISTIC_EVENT_ID_PREFIX = 'optimistic:';
const TIMELINE_SNAPSHOT_STORAGE_PREFIX = 'rcc_timeline_snapshot:';
const MAX_PERSISTED_SNAPSHOT_EVENTS = 50;
// If no confirmation arrives within this window we auto-flip the pending bubble to
// "failed" so the user can retry rather than stare at a perpetual spinner.
const OPTIMISTIC_TIMEOUT_MS = 30_000;

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
  persistTimelineSnapshot(cacheKey, events);
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
    .filter((key) => (cacheListeners.get(key)?.size ?? 0) === 0)
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

function getTimelineSnapshotStorageKey(cacheKey: string): string {
  return `${TIMELINE_SNAPSHOT_STORAGE_PREFIX}${cacheKey}`;
}

function loadPersistedTimelineSnapshot(cacheKey: string): TimelineEvent[] {
  try {
    const raw = localStorage.getItem(getTimelineSnapshotStorageKey(cacheKey));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((event): event is TimelineEvent => (
      !!event
      && typeof event === 'object'
      && typeof (event as TimelineEvent).eventId === 'string'
      && typeof (event as TimelineEvent).type === 'string'
      && typeof (event as TimelineEvent).sessionId === 'string'
      && typeof (event as TimelineEvent).ts === 'number'
      && typeof (event as TimelineEvent).payload === 'object'
    ));
  } catch {
    return [];
  }
}

function persistTimelineSnapshot(cacheKey: string, events: TimelineEvent[]): void {
  try {
    if (events.length === 0) {
      localStorage.removeItem(getTimelineSnapshotStorageKey(cacheKey));
      return;
    }
    const tail = events.length > MAX_PERSISTED_SNAPSHOT_EVENTS
      ? events.slice(events.length - MAX_PERSISTED_SNAPSHOT_EVENTS)
      : events;
    localStorage.setItem(getTimelineSnapshotStorageKey(cacheKey), JSON.stringify(tail));
  } catch {
    // best-effort
  }
}

function isProvisionalTransportHistoryEvent(event: TimelineEvent): boolean {
  return event.eventId.startsWith(PROVISIONAL_TRANSPORT_HISTORY_PREFIX);
}

function convertTransportHistoryRecordToTimelineEvent(
  sessionId: string,
  record: Record<string, unknown>,
  index: number,
): TimelineEvent | null {
  const rawType = typeof record.type === 'string' ? record.type : '';
  const ts = typeof record._ts === 'number' ? record._ts : Date.now();
  const base = {
    eventId: `${PROVISIONAL_TRANSPORT_HISTORY_PREFIX}${sessionId}:${rawType}:${ts}:${index}`,
    sessionId,
    ts,
    seq: index + 1,
    epoch: 0,
    source: 'daemon' as const,
    confidence: 'high' as const,
  };

  if (rawType === 'user.message' && typeof record.text === 'string') {
    return {
      ...base,
      type: 'user.message',
      payload: { text: record.text },
    };
  }

  if (rawType === 'assistant.text' && typeof record.text === 'string') {
    return {
      ...base,
      type: 'assistant.text',
      payload: { text: record.text, streaming: false },
    };
  }

  if (rawType === 'tool.result') {
    const payload: Record<string, unknown> = {};
    if (record.output !== undefined) payload.output = record.output;
    if (record.error !== undefined) payload.error = record.error;
    if (record.detail !== undefined) payload.detail = record.detail;
    return {
      ...base,
      type: 'tool.result',
      payload,
    };
  }

  return null;
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
  lastHttpBackfillOkAt.clear();
}

export function __resetBackfillCooldownsForTests(): void {
  resetBackfillCooldowns();
}

export function __clearPersistedTimelineSnapshotsForTests(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(TIMELINE_SNAPSHOT_STORAGE_PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function getTimelineHistoryAfterTs(events: TimelineEvent[]): number | undefined {
  let maxTs: number | undefined;
  for (const ev of events) {
    // Pending optimistic bubbles carry `ts = Date.now()` from the client
    // clock — exclude them so a skewed client clock can't accidentally
    // filter out legitimately-missed server events.
    if (ev.type === 'user.message' && (ev as { payload?: { pending?: boolean } }).payload?.pending) continue;
    if (typeof ev.ts === 'number' && (maxTs === undefined || ev.ts > maxTs)) maxTs = ev.ts;
  }
  if (maxTs === undefined) return undefined;
  return Math.max(0, maxTs - TIMELINE_HISTORY_AFTER_TS_OVERLAP_MS);
}

function timelineEventFromTextTailItem(sessionId: string, item: TimelineTextTailItem): TimelineEvent | null {
  if (typeof item.eventId !== 'string' || !item.eventId) return null;
  if (typeof item.ts !== 'number' || !Number.isFinite(item.ts)) return null;
  if (item.type !== 'user.message' && item.type !== 'assistant.text') return null;
  if (typeof item.text !== 'string' || item.text.trim().length === 0) return null;
  const source: TimelineSource = item.source === 'hook' || item.source === 'terminal-parse' || item.source === 'terminal-spinner'
    ? item.source
    : 'daemon';
  const confidence: TimelineConfidence = item.confidence === 'medium' || item.confidence === 'low'
    ? item.confidence
    : 'high';
  return {
    eventId: item.eventId,
    sessionId,
    ts: item.ts,
    epoch: 0,
    seq: 0,
    source,
    confidence,
    type: item.type,
    payload: { text: item.text },
  };
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
  /** Structured history-fetch progress shown under the ctx bar while history is loading. */
  historyStatus: TimelineHistoryStatus;
  /** True while loading older events via backward pagination */
  loadingOlder: boolean;
  /** False when backward pagination returned 0 events (no more history to load) */
  hasOlderHistory: boolean;
  /** Immediately inject a pending user message (optimistic UI).
   *  Pass `commandId` to let command.ack and the real user.message echo reconcile
   *  deterministically; attachments are preserved on the pending bubble so the
   *  user sees exactly what was sent; `resendExtra` is stashed (non-enumerable
   *  to the daemon) so the retry path can replay the original command. */
  addOptimisticUserMessage: (
    text: string,
    commandId?: string,
    opts?: {
      attachments?: Array<Record<string, unknown>>;
      resendExtra?: Record<string, unknown>;
    },
  ) => void;
  /** Flip a pending optimistic message to failed state (red "!") keyed by commandId. */
  markOptimisticFailed: (commandId: string, error?: string) => void;
  /** Remove an optimistic message by commandId (used by retry before re-sending). */
  removeOptimisticMessage: (commandId: string) => void;
  /** Load older events before the earliest currently loaded event. */
  loadOlderEvents: () => void;
}

export interface UseTimelineOptions {
  /** Only active timeline sessions should schedule HTTP full-history backfill. */
  isActiveSession?: boolean;
}

export type TimelineHistoryPhase = 'idle' | 'bootstrap' | 'refresh' | 'older';
export type TimelineHistoryStepState = 'pending' | 'running' | 'done' | 'skipped';
export type TimelineHistoryStepKey = 'cache' | 'textTail' | 'daemon' | 'http' | 'older';

export interface TimelineHistoryStatus {
  phase: TimelineHistoryPhase;
  steps: Record<TimelineHistoryStepKey, TimelineHistoryStepState>;
}

export function createIdleHistoryStatus(): TimelineHistoryStatus {
  return {
    phase: 'idle',
    steps: {
      cache: 'skipped',
      textTail: 'skipped',
      daemon: 'skipped',
      http: 'skipped',
      older: 'skipped',
    },
  };
}

function createBootstrapHistoryStatus(opts: { canTextTail: boolean; canDaemon: boolean; canHttp: boolean }): TimelineHistoryStatus {
  return {
    phase: 'bootstrap',
    steps: {
      cache: 'running',
      textTail: opts.canTextTail ? 'pending' : 'skipped',
      daemon: opts.canDaemon ? 'pending' : 'skipped',
      http: opts.canHttp ? 'pending' : 'skipped',
      older: 'skipped',
    },
  };
}

export function useTimeline(
  sessionId: string | null,
  ws: WsClient | null,
  serverId?: string | null,
  options: UseTimelineOptions = {},
): UseTimelineResult {
  const isActiveSession = options.isActiveSession ?? true;
  // IDB + memory cache key: scope by serverId to prevent cross-server pollution
  // when different servers share the same session name (e.g. deck_cd_brain).
  const cacheKey = sessionId ? scopeCacheKey(serverId, sessionId) : sessionId;
  const wsConnected = !!ws?.connected;
  const cacheKeyRef = useRef(cacheKey);
  cacheKeyRef.current = cacheKey;
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const [hasOlderHistory, setHasOlderHistory] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [httpRefreshing, setHttpRefreshing] = useState(false);
  const [textTailRefreshing, setTextTailRefreshing] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyStatus, setHistoryStatus] = useState<TimelineHistoryStatus>(() => createIdleHistoryStatus());
  const loadingOlderRef = useRef(false); // Synchronous guard against duplicate pagination requests
  const httpBackfillInFlightRef = useRef(0);
  const epochRef = useRef<number>(0);
  const seqRef = useRef<number>(0);
  const replayRequestIdRef = useRef<string | null>(null);
  const historyRequestIdRef = useRef<string | null>(null);
  const olderRequestIdRef = useRef<string | null>(null);
  const historyLoadedRef = useRef<string | null>(null); // tracks which session has been loaded
  const historyRetryRef = useRef(0); // retry count for empty history responses

  const updateHistoryStep = useCallback((
    step: TimelineHistoryStepKey,
    state: TimelineHistoryStepState,
    phase?: Exclude<TimelineHistoryPhase, 'idle'>,
  ) => {
    setHistoryStatus((prev) => ({
      phase: phase ?? prev.phase,
      steps: {
        ...prev.steps,
        [step]: state,
      },
    }));
  }, []);

  useEffect(() => {
    if (!cacheKey) return;
    if (!isActiveSession) return;
    return subscribeCache(cacheKey, (nextEvents) => {
      setEvents((prev) => (prev === nextEvents ? prev : nextEvents));
    });
  }, [cacheKey, isActiveSession]);

  // Reset on session change — but DON'T clear events when sessionId becomes null
  // (window minimized). The memory cache (eventsCache) preserves them for instant
  // restore when the window reopens.
  useEffect(() => {
    if (!sessionId) {
      setLoading(false);
      setHttpRefreshing(false);
      setTextTailRefreshing(false);
      setHistoryStatus(createIdleHistoryStatus());
      httpBackfillInFlightRef.current = 0;
      resetOlderState();
      return;
    }

    if (!isActiveSession) return;

    setRefreshing(false);
    setHttpRefreshing(false);
    setTextTailRefreshing(false);
    setHistoryStatus(createBootstrapHistoryStatus({
      canTextTail: !!serverId,
      canDaemon: wsConnected,
      canHttp: !!serverId,
    }));
    httpBackfillInFlightRef.current = 0;
    resetOlderState();
    setHasOlderHistory(true);

    let cancelled = false;
    let textTailStarted = false;

    const startTextTailBootstrap = (): void => {
      if (textTailStarted || !serverId || !sessionId || !cacheKey) return;
      textTailStarted = true;
      const expectedCacheKey = cacheKey;
      const expectedSessionId = sessionId;
      updateHistoryStep('textTail', 'running', 'bootstrap');
      setTextTailRefreshing(true);
      void fetchTimelineTextTailHttp(serverId, expectedSessionId)
        .then((result) => {
          if (cancelled || cacheKeyRef.current !== expectedCacheKey || !result || result.events.length === 0) return;
          const recovered = result.events
            .map((item) => timelineEventFromTextTailItem(expectedSessionId, item))
            .filter((event): event is TimelineEvent => event !== null);
          if (recovered.length === 0) return;
          mergeEvents(recovered);
        })
        .catch(() => { /* fail-open: authoritative history flow continues */ })
        .finally(() => {
          updateHistoryStep('textTail', 'done', 'bootstrap');
          if (!cancelled && cacheKeyRef.current === expectedCacheKey) setTextTailRefreshing(false);
        });
    };

    // 1. Module-level memory cache — instant restore (e.g. window reopen)
    const memCached = getCachedEvents(cacheKey!);
    if (memCached && memCached.length > 0) {
      updateHistoryStep('cache', 'done', 'bootstrap');
      setEvents(memCached);
      setLoading(false);
      startTextTailBootstrap();
      if (wsConnected) {
        updateHistoryStep('daemon', 'running', 'bootstrap');
        setRefreshing(true);
        historyRequestIdRef.current = ws.sendTimelineHistoryRequest(sessionId, MAX_MEMORY_EVENTS);
      }
      // Background HTTP backfill — catches events missed while this window
      // was minimized/backgrounded since the memory cache can be stale.
      // Kept short (~200ms) because the UI is already visible; this is
      // strictly additive catch-up, merged by eventId.
      fireHttpBackfillRef.current(200, { cooldownMs: MOUNT_BACKFILL_COOLDOWN_MS, phase: 'bootstrap' });
      return () => { cancelled = true; };
    }

    // 1.5 Synchronous localStorage snapshot — instant restore across full page
    // reloads before IndexedDB/network complete. This is intentionally only a
    // tail snapshot for first paint; IndexedDB remains the fuller local source.
    const localSnapshot = loadPersistedTimelineSnapshot(cacheKey!);
    if (localSnapshot.length > 0) {
      updateHistoryStep('cache', 'done', 'bootstrap');
      setCachedEvents(cacheKey!, localSnapshot);
      setEvents((prev) => (prev === localSnapshot ? prev : localSnapshot));
      setLoading(false);
      startTextTailBootstrap();
      if (wsConnected) {
        updateHistoryStep('daemon', 'running', 'bootstrap');
        setRefreshing(true);
        historyRequestIdRef.current = ws.sendTimelineHistoryRequest(sessionId, MAX_MEMORY_EVENTS);
      }
      fireHttpBackfillRef.current(200, { cooldownMs: MOUNT_BACKFILL_COOLDOWN_MS, phase: 'bootstrap' });
    }

    // 2. Already loaded this session — skip reload (prevents flash-of-empty on minimize/restore)
    if (historyLoadedRef.current === cacheKey) {
      updateHistoryStep('cache', 'done', 'bootstrap');
      setLoading(false);
      startTextTailBootstrap();
      // Just request incremental updates
      if (wsConnected) {
        updateHistoryStep('daemon', 'running', 'bootstrap');
        setRefreshing(true);
        historyRequestIdRef.current = ws.sendTimelineHistoryRequest(sessionId, MAX_MEMORY_EVENTS);
      }
      // Same reasoning as path 1 — back-fill in the background so the
      // re-opened window is guaranteed to reflect authoritative daemon
      // state, not whatever the WS subscription happened to catch.
      fireHttpBackfillRef.current(200, { cooldownMs: MOUNT_BACKFILL_COOLDOWN_MS, phase: 'bootstrap' });
      return () => { cancelled = true; };
    }

    // 3. IndexedDB cache → daemon history (first load for this session in this page session)
    if (localSnapshot.length === 0) setLoading(true);
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
        updateHistoryStep('cache', 'done', 'bootstrap');
        setCachedEvents(cacheKey!, restored);
        setEvents((prev) => (prev === restored ? prev : restored));
        setLoading(false);
        historyLoadedRef.current = cacheKeyRef.current;
        startTextTailBootstrap();
        if (wsConnected) {
          updateHistoryStep('daemon', 'running', 'bootstrap');
          setRefreshing(true);
          historyRequestIdRef.current = ws.sendTimelineHistoryRequest(sessionId, MAX_MEMORY_EVENTS);
        }
        // Background HTTP backfill — IDB is authoritative only up to the
        // last time a WS event landed; if the user closed the tab mid-chat
        // and reopened later there may be a gap between IDB and daemon.
        fireHttpBackfillRef.current(200, { cooldownMs: MOUNT_BACKFILL_COOLDOWN_MS, phase: 'bootstrap' });
      } else {
        epochRef.current = 0;
        seqRef.current = 0;
        if (cancelled) return;
        updateHistoryStep('cache', 'done', 'bootstrap');
        setEvents([]);
        startTextTailBootstrap();
        if (wsConnected) {
          updateHistoryStep('daemon', 'running', 'bootstrap');
          setRefreshing(true);
          historyRequestIdRef.current = ws.sendTimelineHistoryRequest(sessionId);
        } else {
          setLoading(false);
        }
        // Cold load — no IDB cache, no memory cache. Still fire the same
        // delayed HTTP backfill so an empty timeline can recover missed
        // daemon-side events without waiting for a later reconnect.
        fireHttpBackfillRef.current(200, { cooldownMs: 0, phase: 'bootstrap' });
      }
    };
    load().catch(() => {});
    return () => { cancelled = true; };
  }, [cacheKey, sessionId, ws, wsConnected]);

  // Map of commandId → optimistic eventId for O(1) lookup on command.ack / dedup.
  const optimisticIdsByCommandRef = useRef(new Map<string, string>());
  // Per-commandId timeout handle so we can flip perpetual-spinner entries to failed.
  const optimisticTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const clearOptimisticTimer = useCallback((commandId: string) => {
    const timer = optimisticTimersRef.current.get(commandId);
    if (timer) {
      clearTimeout(timer);
      optimisticTimersRef.current.delete(commandId);
    }
  }, []);

  // Flip a pending optimistic entry to failed state (red "!" bubble with retry).
  const markOptimisticFailed = useCallback((commandId: string, error?: string) => {
    if (!commandId) return;
    const eventId = optimisticIdsByCommandRef.current.get(commandId);
    if (!eventId) return;
    clearOptimisticTimer(commandId);
    setEvents((prev) => {
      const base = getSharedTimelineBase(cacheKeyRef.current, prev, MAX_MEMORY_EVENTS);
      const idx = base.findIndex((e) => e.eventId === eventId);
      if (idx < 0) return base;
      const existing = base[idx]!;
      const payload: Record<string, unknown> = {
        ...existing.payload,
        pending: false,
        failed: true,
      };
      if (error) payload.failureReason = error;
      const updated = [...base];
      updated[idx] = { ...existing, payload };
      if (cacheKeyRef.current) setCachedEvents(cacheKeyRef.current, updated);
      return updated;
    });
  }, [clearOptimisticTimer]);

  // Remove an optimistic entry entirely — used by the retry button so the retry
  // doesn't leave behind the failed bubble (the fresh send re-renders it).
  const removeOptimisticMessage = useCallback((commandId: string) => {
    if (!commandId) return;
    const eventId = optimisticIdsByCommandRef.current.get(commandId);
    optimisticIdsByCommandRef.current.delete(commandId);
    clearOptimisticTimer(commandId);
    if (!eventId) return;
    setEvents((prev) => {
      const base = getSharedTimelineBase(cacheKeyRef.current, prev, MAX_MEMORY_EVENTS);
      const next = base.filter((e) => e.eventId !== eventId);
      if (next.length === base.length) return base;
      if (cacheKeyRef.current) setCachedEvents(cacheKeyRef.current, next);
      return next;
    });
  }, [clearOptimisticTimer]);

  const reconcileQueuedOptimisticMessages = useCallback((pendingEntries: unknown, pendingMessages: unknown) => {
    const queuedEntries = normalizeTransportPendingEntries(pendingEntries, pendingMessages, sessionId ?? '');
    if (queuedEntries.length === 0) return;
    const queuedIds = new Set(queuedEntries.map((entry) => entry.clientMessageId).filter(Boolean));
    if (queuedIds.size === 0) return;
    setEvents((prev) => {
      const base = getSharedTimelineBase(cacheKeyRef.current, prev, MAX_MEMORY_EVENTS);
      let changed = false;
      const next = base.filter((event) => {
        if (event.type !== 'user.message' || event.payload.pending !== true) return true;
        const commandId = typeof event.payload.commandId === 'string' ? event.payload.commandId : '';
        if (!commandId || !queuedIds.has(commandId)) return true;
        optimisticIdsByCommandRef.current.delete(commandId);
        clearOptimisticTimer(commandId);
        changed = true;
        return false;
      });
      if (!changed) return base;
      if (cacheKeyRef.current) setCachedEvents(cacheKeyRef.current, next);
      return next;
    });
  }, [clearOptimisticTimer, sessionId]);

  // Immediately show a user message before the daemon confirms it.
  // The real event (from WS) will remove the pending version on arrival.
  // When `commandId` is provided, the bubble reconciles deterministically with
  // command.ack (for error → failed) and the echoed user.message (for success).
  const addOptimisticUserMessage = useCallback((
    text: string,
    commandId?: string,
    opts?: {
      attachments?: Array<Record<string, unknown>>;
      resendExtra?: Record<string, unknown>;
    },
  ) => {
    if (!sessionId) return;
    const optimisticId = `${OPTIMISTIC_EVENT_ID_PREFIX}${sessionId}:${commandId ?? Date.now()}`;
    if (commandId) {
      // Guard against double-send of the same commandId: if already tracked,
      // skip — the existing bubble is still valid.
      if (optimisticIdsByCommandRef.current.has(commandId)) return;
      optimisticIdsByCommandRef.current.set(commandId, optimisticId);
      clearOptimisticTimer(commandId);
      const timer = setTimeout(() => {
        markOptimisticFailed(commandId, 'timeout');
      }, OPTIMISTIC_TIMEOUT_MS);
      optimisticTimersRef.current.set(commandId, timer);
    }
    const payload: Record<string, unknown> = { text, pending: true };
    if (commandId) payload.commandId = commandId;
    if (opts?.attachments && opts.attachments.length > 0) payload.attachments = opts.attachments;
    if (opts?.resendExtra && Object.keys(opts.resendExtra).length > 0) {
      // Prefix with _ so server-side consumers reading user.message payloads
      // treat it as a client-only hint and don't echo/store it.
      payload._resendExtra = opts.resendExtra;
    }
    const event: TimelineEvent = {
      eventId: optimisticId,
      type: 'user.message',
      sessionId,
      ts: Date.now(),
      epoch: 0,
      seq: 0,
      source: 'daemon',
      confidence: 'high',
      payload,
    };
    setEvents((prev) => {
      const base = getSharedTimelineBase(cacheKeyRef.current, prev, MAX_MEMORY_EVENTS);
      const result = [...base, event];
      if (cacheKeyRef.current) setCachedEvents(cacheKeyRef.current, result);
      return result;
    });
  }, [sessionId, clearOptimisticTimer, markOptimisticFailed]);

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
    setHistoryStatus({
      phase: 'older',
      steps: {
        cache: 'done',
        textTail: 'skipped',
        daemon: 'skipped',
        http: 'skipped',
        older: 'running',
      },
    });
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

  const replaceEvents = useCallback((incoming: TimelineEvent[], maxEvents = MAX_MEMORY_EVENTS) => {
    setEvents(() => {
      const result = incoming.length > maxEvents
        ? incoming.slice(incoming.length - maxEvents)
        : incoming;
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

  /**
   * Defense-in-depth: fire an HTTP "/timeline/history/full" read for this
   * session after a short delay. Results are merged via `eventId`, so the
   * overlap with the WS stream is harmless (pure dedup). Runs in the
   * background — the UI has already rendered from memory cache / IDB / WS
   * history before this fires.
   *
   * Call sites:
   *   - Session mount / switch (~200ms): cached history renders immediately,
   *     then a background backfill reconciles against authoritative daemon
   *     state. Re-visits within 60 seconds reuse the previous successful
   *     result to avoid hammering HTTP while the app stays active.
   *   - WS reconnect (~600ms): covers the ~10–100ms subscribe-race
   *     window on the bridge where live events can be silently dropped.
   *     Missing events after a disconnect is exactly what this read exists
   *     to recover.
   *
   * Safe to call when:
   *   - `serverId` is unknown → skipped (self-hosted deploys require it).
   *   - The user switches session mid-flight → the cacheKey-guard in the
   *     timeout callback discards results for the old session.
   *   - Backfill returns zero events → a successful no-gap result still arms
   *     the mount cooldown.
   *   - Backfill returns null / rejects → WS path remains primary; the next
   *     trigger simply tries again.
   */
  const fireHttpBackfill = useCallback((delayMs: number, opts?: { cooldownMs?: number; phase?: 'bootstrap' | 'refresh' }) => {
    if (!serverId || !sessionId || !isActiveSession) return;
    const cooldownMs = opts?.cooldownMs ?? 0;
    const phase = opts?.phase ?? 'refresh';
    const backfillSessionId = sessionId;
    const backfillCacheKey = cacheKey;
    setTimeout(() => {
      if (cacheKeyRef.current !== backfillCacheKey) return;
      if (backfillCacheKey && cooldownMs > 0) {
        const lastOk = lastHttpBackfillOkAt.get(backfillCacheKey);
        if (lastOk !== undefined && Date.now() - lastOk < cooldownMs) return;
      }
      // Recompute the cursor at fire time, not call time — the UI may have
      // received fresh WS events during the delay window and we don't want
      // to redownload them.
      const afterTs = getTimelineHistoryAfterTs(eventsRef.current);
      httpBackfillInFlightRef.current += 1;
      updateHistoryStep('http', 'running', phase);
      setHttpRefreshing(true);
      void fetchTimelineHistoryHttp(serverId, backfillSessionId, {
        afterTs,
        limit: MAX_MEMORY_EVENTS,
      }).then((result) => {
        if (!result) return;
        if (backfillCacheKey) lastHttpBackfillOkAt.set(backfillCacheKey, Date.now());
        if (result.events.length === 0) return;
        if (cacheKeyRef.current !== backfillCacheKey) return;
        const recovered = result.events.filter(
          (ev): ev is TimelineEvent => !!ev && typeof ev === 'object' && typeof (ev as TimelineEvent).eventId === 'string',
        );
        if (recovered.length === 0) return;
        mergeEvents(recovered);
        idbPutEvents(recovered);
      }).catch(() => { /* opportunistic — WS path is primary */ })
        .finally(() => {
          httpBackfillInFlightRef.current = Math.max(0, httpBackfillInFlightRef.current - 1);
          updateHistoryStep('http', 'done', phase);
          if (httpBackfillInFlightRef.current === 0) setHttpRefreshing(false);
        });
    }, delayMs);
  }, [serverId, sessionId, cacheKey, mergeEvents, idbPutEvents, updateHistoryStep]);

  // Stable indirection — lets the session-mount effect below call the latest
  // `fireHttpBackfill` without having to list it (and transitively its five
  // dependencies) in its own dep array, which would otherwise cause the
  // mount effect to re-run on every render.
  const fireHttpBackfillRef = useRef(fireHttpBackfill);
  fireHttpBackfillRef.current = fireHttpBackfill;
  const lastActiveRefreshAtRef = useRef(0);

  // Force-refresh the active session when the app comes back to the
  // foreground or a push-notification is tapped. Listener is intentionally
  // registered with NO deps so it stays attached across session switches:
  // if we gated on [sessionId, serverId], React would tear down + re-add
  // the listener on every navigate, and an ACTIVE_TIMELINE_REFRESH_EVENT
  // dispatched synchronously in the same tick as setActiveSession() (see
  // push-notifications.ts) would land in the gap and be silently dropped,
  // leaving the user staring at "No events yet" after a notification tap.
  // `fireHttpBackfillRef.current` reads the latest sessionId/serverId on
  // each call, and `fireHttpBackfill` itself no-ops when either is unset.
  useEffect(() => {
    const handler = (): void => {
      if (!isActiveSession) return;
      const now = Date.now();
      if (now - lastActiveRefreshAtRef.current < 250) return;
      lastActiveRefreshAtRef.current = now;
      fireHttpBackfillRef.current(0, { phase: 'refresh' });
    };
    window.addEventListener(ACTIVE_TIMELINE_REFRESH_EVENT, handler);
    return () => window.removeEventListener(ACTIVE_TIMELINE_REFRESH_EVENT, handler);
  }, [isActiveSession]);

  // Listen for WS messages
  useEffect(() => {
    if (!ws || !sessionId) return;

    const handler = (msg: ServerMessage) => {
      // ── Real-time event ──
      if (msg.type === 'timeline.event') {
        const event = msg.event;
        if (event.sessionId !== sessionId) return;
        if (event.type === 'session.state' && event.payload?.state === 'queued') {
          reconcileQueuedOptimisticMessages(event.payload.pendingMessageEntries, event.payload.pendingMessages);
        }

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
          // Transport path already attaches the originating commandId as
          // `clientMessageId` in the payload; prefer that for reconciliation
          // since text-based matching loses when the agent echoes a normalized
          // or retried version of the prompt.
          const echoCommandId = typeof event.payload.commandId === 'string'
            ? event.payload.commandId
            : typeof event.payload.clientMessageId === 'string'
              ? event.payload.clientMessageId
              : undefined;
          let skipAppend = false;
          setEvents((prev) => {
            const base = getSharedTimelineBase(cacheKeyRef.current, prev, MAX_MEMORY_EVENTS);
            // 1) Prefer commandId-based reconciliation: remove the optimistic
            //    bubble that matches this echo's commandId regardless of state
            //    (pending OR failed — a late echo means the send eventually
            //    succeeded and the red "!" was spurious).
            let cleaned = base;
            if (echoCommandId) {
              const optimisticId = optimisticIdsByCommandRef.current.get(echoCommandId);
              if (optimisticId) {
                cleaned = base.filter((e) => e.eventId !== optimisticId);
                optimisticIdsByCommandRef.current.delete(echoCommandId);
                clearOptimisticTimer(echoCommandId);
              }
            }
            // 2) Fallback to text-based cleanup for legacy emit paths (tmux
            //    JSONL scrapers, etc.) that don't propagate commandId.
            const withoutPending = cleaned.filter(
              (e) => !(
                e.type === 'user.message'
                && (e.payload.pending || e.payload.failed)
                && String(e.payload.text ?? '').trim() === text
              ),
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
                !e.payload.failed &&
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
      if (msg.type === TRANSPORT_MSG.CHAT_HISTORY) {
        if (msg.sessionId !== sessionId) return;
        if (eventsRef.current.length > 0) return;
        const provisionalEvents = msg.events
          .map((event, index) => convertTransportHistoryRecordToTimelineEvent(sessionId, event, index))
          .filter((event): event is TimelineEvent => event != null);
        if (provisionalEvents.length === 0) return;
        updateHistoryStep('daemon', 'done', 'bootstrap');
        replaceEvents(provisionalEvents);
        setLoading(false);
        return;
      }

      // ── History response (full load from daemon file store) ──
      if (msg.type === 'timeline.history') {
        if (msg.sessionName !== sessionId) return;

        // Handle backward pagination response
        if (msg.requestId && msg.requestId === olderRequestIdRef.current) {
          updateHistoryStep('older', 'done', 'older');
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
        updateHistoryStep('daemon', 'done', loading ? 'bootstrap' : 'refresh');
        historyLoadedRef.current = cacheKeyRef.current;

        epochRef.current = msg.epoch;

        if (msg.events.length > 0) {
          historyRetryRef.current = 0; // reset on success
          const maxSeq = msg.events.reduce((max, e) => Math.max(max, e.seq), 0);
          seqRef.current = Math.max(seqRef.current, maxSeq);
          const current = getSharedTimelineBase(cacheKeyRef.current, eventsRef.current, MAX_MEMORY_EVENTS);
          const withoutProvisionalTransportHistory = current.filter((event) => !isProvisionalTransportHistoryEvent(event));
          const hadProvisionalTransportHistory = withoutProvisionalTransportHistory.length !== current.length;
          if (hadProvisionalTransportHistory) {
            const next = withoutProvisionalTransportHistory.length === 0
              ? msg.events
              : mergeTimelineEvents(withoutProvisionalTransportHistory, msg.events, MAX_MEMORY_EVENTS);
            replaceEvents(next);
          } else {
            mergeEvents(msg.events);
          }
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
        updateHistoryStep('daemon', 'done', 'refresh');
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
        // will bring back any messages that were actually processed. Failed
        // bubbles stay put so the user can still retry them.
        for (const timer of optimisticTimersRef.current.values()) clearTimeout(timer);
        optimisticTimersRef.current.clear();
        optimisticIdsByCommandRef.current.clear();
        setEvents((prev) => {
          const base = getSharedTimelineBase(cacheKeyRef.current, prev, MAX_MEMORY_EVENTS);
          const cleaned = base.filter((e) => !(e.type === 'user.message' && e.payload.pending));
          if (cleaned.length !== base.length && cacheKeyRef.current) setCachedEvents(cacheKeyRef.current, cleaned);
          return cleaned;
        });
        if (ws && sessionId) {
          setHistoryStatus({
            phase: 'refresh',
            steps: {
              cache: 'done',
              textTail: 'skipped',
              daemon: 'running',
              http: serverId ? 'pending' : 'skipped',
              older: 'skipped',
            },
          });
          setRefreshing(true);
          historyRequestIdRef.current = ws.sendTimelineHistoryRequest(sessionId, MAX_MEMORY_EVENTS);
        }
      }
      // ── Browser WS disconnected: reset in-flight pagination to prevent stuck state ──
      if (msg.type === 'session.event' && (msg as { event: string }).event === 'disconnected') {
        if (loadingOlderRef.current) resetOlderState();
      }
      // ── Browser WS reconnected: recover both in-memory streaming deltas and
      //    persisted history gaps. `timeline.history(afterTs)` is the durable
      //    path, but it cannot recover assistant streaming deltas because the
      //    daemon intentionally does not persist `streaming: true` updates.
      //    Pair it with `timeline.replay(afterSeq, epoch)` so same-daemon
      //    reconnects can recover active transport turns from the in-memory
      //    ring buffer while history still covers durable gap-fill.
      //
      // The afterTs cursor is the max ts of any event currently rendered for
      // this session — server replays only events with ts > afterTs. Without
      // this cursor the server dumped a MAX_MEMORY_EVENTS-sized recent window,
      // which (a) re-downloaded events we already had and (b) silently lost
      // anything older than that window if the disconnect gap exceeded the
      // window. If we have no local events (first connect / fresh tab) we omit
      // afterTs and get the standard recent window.
      if (msg.type === 'session.event' && (msg as { event: string }).event === 'connected') {
        if (!isActiveSession) return;
        if (ws && sessionId) {
          setHistoryStatus({
            phase: 'refresh',
            steps: {
              cache: 'done',
              textTail: 'skipped',
              daemon: 'running',
              http: serverId ? 'pending' : 'skipped',
              older: 'skipped',
            },
          });
          const current = eventsRef.current;
          const replayAfterSeq = seqRef.current > 0
            ? seqRef.current
            : current.reduce((max, event) => Math.max(max, event.seq), 0);
          const replayEpoch = epochRef.current > 0
            ? epochRef.current
            : (current.length > 0 ? current[current.length - 1]?.epoch ?? 0 : 0);
          if (current.length > 0 && replayAfterSeq > 0 && replayEpoch > 0) {
            replayRequestIdRef.current = ws.sendTimelineReplayRequest(sessionId, replayAfterSeq, replayEpoch);
          } else {
            replayRequestIdRef.current = null;
          }
          const afterTs = getTimelineHistoryAfterTs(current);
          historyRequestIdRef.current = ws.sendTimelineHistoryRequest(sessionId, MAX_MEMORY_EVENTS, afterTs);

          // Fire HTTP backfill with a ~600ms delay to let the bridge's async
          // `terminal.subscribe` ownership-check race resolve; any live
          // `timeline.event` emitted during that window is routed through
          // `sendToSessionSubscribers`, finds the browser not-yet-subscribed,
          // and gets silently dropped. The HTTP path reads daemon store
          // directly (unicast request-response, no subscription routing).
          fireHttpBackfillRef.current(600, { phase: 'refresh' });
        }
      }

      // ── command.ack: reconcile the optimistic send bubble. Error/conflict
      //    flips it to the failed "!" state so the user can retry; success-ish
      //    acks just cancel the 30s failure timeout — the real user.message
      //    event is still the authoritative "agent saw it" signal and will
      //    remove the bubble on arrival. ──
      if (msg.type === 'command.ack') {
        const ackSession = typeof (msg as { session?: unknown }).session === 'string'
          ? (msg as { session: string }).session
          : undefined;
        if (ackSession && ackSession !== sessionId) return;
        const commandId = (msg as { commandId?: unknown }).commandId;
        if (typeof commandId !== 'string' || !commandId) return;
        const status = typeof (msg as { status?: unknown }).status === 'string'
          ? (msg as { status: string }).status
          : '';
        const isFailure = status === 'error' || status === 'conflict';
        if (isFailure) {
          const errorField = (msg as unknown as Record<string, unknown>).error;
          const reason = typeof errorField === 'string' ? errorField : status;
          markOptimisticFailed(commandId, reason);
        } else if (status) {
          clearOptimisticTimer(commandId);
        }
      }

      // ── command.failed: server-surfaced fast failure (daemon_offline / ack_timeout).
      //    The server already owns retry coordination (buffer during grace, replay
      //    on reconnect), so the web does NOT maintain its own retry queue — we
      //    just flip the optimistic bubble to failed state so the user can retry
      //    manually when they choose. ──
      if (msg.type === MSG_COMMAND_FAILED) {
        const failedSession = typeof (msg as { session?: unknown }).session === 'string'
          ? (msg as { session: string }).session
          : undefined;
        if (failedSession && failedSession !== sessionId) return;
        const commandId = typeof (msg as { commandId?: unknown }).commandId === 'string'
          ? (msg as { commandId: string }).commandId
          : '';
        const reason = (msg as { reason?: unknown }).reason;
        if (!commandId) return;
        const reasonStr: AckFailureReason = (reason === 'ack_timeout' || reason === 'daemon_error')
          ? reason
          : 'daemon_offline';
        markOptimisticFailed(commandId, localizedAckFailureReason(reasonStr));
      }

      // ── daemon.online / daemon.offline: purely advisory status signals.
      //    DAEMON_MSG.RECONNECTED / .DISCONNECTED already drive terminal
      //    subscription state; these new signals exist for future UI polish
      //    (e.g. status badge reflecting the grace window) without mutating
      //    any optimistic bubble state here. ──
      if (msg.type === MSG_DAEMON_ONLINE || msg.type === MSG_DAEMON_OFFLINE) {
        return;
      }
    };

    const unsub = ws.onMessage(handler);
    return unsub;
  }, [ws, sessionId, appendEvent, clearOptimisticTimer, loading, markOptimisticFailed, mergeEvents, reconcileQueuedOptimisticMessages, replaceEvents, serverId, updateHistoryStep]);

  useEffect(() => {
    if (loading || refreshing || httpRefreshing || textTailRefreshing || loadingOlder) return;
    setHistoryStatus((prev) => (prev.phase === 'idle' ? prev : createIdleHistoryStatus()));
  }, [httpRefreshing, loading, loadingOlder, refreshing, textTailRefreshing]);

  // Clear outstanding optimistic timers on unmount / session change so that a
  // dismissed chat window can't fire a delayed markOptimisticFailed into an
  // unmounted component.
  useEffect(() => {
    const timers = optimisticTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      optimisticIdsByCommandRef.current.clear();
    };
  }, [sessionId]);

  return {
    events,
    loading,
    refreshing: refreshing || httpRefreshing || textTailRefreshing,
    historyStatus,
    loadingOlder,
    hasOlderHistory,
    addOptimisticUserMessage,
    markOptimisticFailed,
    removeOptimisticMessage,
    loadOlderEvents,
  };
}
