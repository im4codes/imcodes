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
import { TimelineDB } from '../timeline-db.js';
import { mergeTimelineEvents, preferTimelineEvent } from '../../../src/shared/timeline/merge.js';
import { fetchTimelineHistoryHttp, sendSessionViaHttp } from '../api.js';
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
/**
 * Cooldown for "user signaled they want fresh data" refreshes (activation
 * event, false→true active flip). Without it, opening or switching to a
 * session can fire 2-3 backfills back-to-back: mount-time bootstrap +
 * isActiveSession transition + a stray activation event from the same
 * focus/visibility tick. Each fires a real HTTP roundtrip even when the WS
 * timeline has no gap to fill, so the user sees the chat scroll-to-bottom
 * jolt three times in succession.
 *
 * 15 s is short enough that a stale daemon never lingers past one human
 * reaction-time worth of "wait and try again", but long enough to coalesce
 * the burst that typically arrives in <500 ms when a session is clicked.
 *
 * `requestActiveTimelineRefresh({ resetCooldowns: true })` (called on
 * confirmed app-resume from background) explicitly clears
 * `lastHttpBackfillOkAt`, so a real foreground transition still bypasses
 * this gate.
 */
const ACTIVE_REFRESH_COOLDOWN_MS = 15_000;

function resetBackfillCooldowns(): void {
  lastHttpBackfillOkAt.clear();
}

/** Diagnostic logging for the backfill chain. Off by default; flip
 *  `window.__deck_debug_backfill = true` from devtools to trace why an
 *  expected backfill didn't fire on activation/reconnect/session-switch.
 *  Output is intentionally compact so a Safari/iOS console can scrub it. */
function backfillDebug(msg: string, data?: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  if (!(window as unknown as { __deck_debug_backfill?: boolean }).__deck_debug_backfill) return;
  // eslint-disable-next-line no-console
  console.debug(`[backfill] ${msg}`, data ?? '');
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
//
// Sized to comfortably cover the server's full ack-reliability budget AND the
// client-side auto-retry + HTTP fallback chain so we don't race ahead of
// `command.failed` or interrupt an in-flight retry:
//   - RECONNECT_GRACE_MS (10s) + ACK_TIMEOUT_MS * (RETRY_LIMIT + 1) (8 * 6 = 48s)
//     = 58s worst case before the server first gives up.
//   - Plus client retries (CLIENT_RETRY_DELAYS_MS sum ≈ 6s) + HTTP fallback (~5s).
// Total comfortable budget ~75s. We pick 90s so even worst-case retries
// complete before the optimistic timeout marks the bubble as a generic
// "timeout" failure (which would skip the retry path's specific reason).
const OPTIMISTIC_TIMEOUT_MS = 90_000;

/**
 * Per-attempt backoff for client-side auto-retry of failed sends. The user's
 * stated policy is: "发送失败至少重试 2-3 次后再 HTTP watch 兜底，最终失败"
 * — i.e. don't surface failure on the first server-side `command.failed`,
 * give the network a few more chances, then fall back to the HTTP send
 * endpoint, and only after all of that mark the bubble red.
 *
 * Total WS retry budget = sum of delays = 6s, comfortably less than the
 * server's grace window so the daemon has time to reconnect between attempts.
 */
const CLIENT_RETRY_DELAYS_MS = [800, 2000, 3200] as const;
const CLIENT_RETRY_MAX_ATTEMPTS = CLIENT_RETRY_DELAYS_MS.length; // 3 WS attempts before HTTP fallback

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

function getUserMessageCommandId(event: TimelineEvent): string | undefined {
  if (event.type !== 'user.message') return undefined;
  const commandId = typeof event.payload.commandId === 'string'
    ? event.payload.commandId.trim()
    : '';
  if (commandId) return commandId;
  const clientMessageId = typeof event.payload.clientMessageId === 'string'
    ? event.payload.clientMessageId.trim()
    : '';
  return clientMessageId || undefined;
}

function isLocalOptimisticUserMessage(event: TimelineEvent): boolean {
  return event.type === 'user.message' && event.eventId.startsWith(OPTIMISTIC_EVENT_ID_PREFIX);
}

function isAuthoritativeSendProgressEvent(event: TimelineEvent): boolean {
  if (event.type === 'assistant.text' || event.type === 'tool.call' || event.type === 'tool.result') return true;
  if (event.type === 'memory.context' && typeof event.payload.relatedToEventId === 'string') return true;
  if (event.type === 'session.state') {
    const state = String(event.payload.state ?? '');
    return state === 'running' || state === 'idle';
  }
  return false;
}

function removeReconciledLocalUserMessages(
  base: TimelineEvent[],
  incoming: readonly TimelineEvent[],
): TimelineEvent[] {
  const commandIds = new Set<string>();
  for (const event of incoming) {
    const commandId = getUserMessageCommandId(event);
    if (commandId) commandIds.add(commandId);
  }
  if (commandIds.size === 0) return base;
  const filtered = base.filter((event) => {
    if (!isLocalOptimisticUserMessage(event)) return true;
    const commandId = getUserMessageCommandId(event);
    return !commandId || !commandIds.has(commandId);
  });
  return filtered.length === base.length ? base : filtered;
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
  /** Update a failed optimistic message in place for retry with a fresh commandId. */
  retryOptimisticMessage: (
    oldCommandId: string,
    newCommandId: string,
    text: string,
    opts?: {
      attachments?: Array<Record<string, unknown>>;
      resendExtra?: Record<string, unknown>;
    },
  ) => void;
  /** Load older events before the earliest currently loaded event. */
  loadOlderEvents: () => void;
}

export interface UseTimelineOptions {
  /**
   * Only the active/visible timeline should trigger opportunistic HTTP
   * backfills. Inactive mounted timelines still stay warm via cache + WS
   * events, but they must not hammer `/timeline/history/full`.
   */
  isActiveSession?: boolean;
  /**
   * Shell/script process sessions have no chat timeline. When disabled, the
   * hook stays idle and skips daemon/HTTP/text-tail history work entirely.
   */
  disableHistory?: boolean;
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

function createBootstrapHistoryStatus(opts: { canDaemon: boolean; canHttp: boolean }): TimelineHistoryStatus {
  return {
    phase: 'bootstrap',
    steps: {
      cache: 'running',
      textTail: 'skipped',
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
  options?: UseTimelineOptions,
): UseTimelineResult {
  // IDB + memory cache key: scope by serverId to prevent cross-server pollution
  // when different servers share the same session name (e.g. deck_cd_brain).
  const cacheKey = sessionId ? scopeCacheKey(serverId, sessionId) : sessionId;
  const isActiveSession = options?.isActiveSession ?? true;
  const disableHistory = options?.disableHistory ?? false;
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
      setHttpRefreshing(false);
      setHistoryStatus(createIdleHistoryStatus());
      httpBackfillInFlightRef.current = 0;
      resetOlderState();
      return;
    }
    if (disableHistory) {
      setEvents([]);
      setLoading(false);
      setRefreshing(false);
      setHttpRefreshing(false);
      setHistoryStatus(createIdleHistoryStatus());
      httpBackfillInFlightRef.current = 0;
      resetOlderState();
      setHasOlderHistory(false);
      historyLoadedRef.current = cacheKeyRef.current;
      return;
    }

    setRefreshing(false);
    setHttpRefreshing(false);
    setHistoryStatus(createBootstrapHistoryStatus({
      canDaemon: wsConnected,
      canHttp: false,
    }));
    httpBackfillInFlightRef.current = 0;
    resetOlderState();
    setHasOlderHistory(true);

    let cancelled = false;

    const markDaemonHistoryBackground = (): void => {
      updateHistoryStep('daemon', 'done', 'bootstrap');
      setRefreshing(false);
    };

    const requestDaemonHistory = (visible: boolean, limit?: number): void => {
      if (!wsConnected || !ws) return;
      // Gate WS-side timeline.history_request behind isActiveSession the same
      // way fireHttpBackfill is gated. SubSessionCard mounts one useTimeline
      // per sub-session card; with the gate missing, every non-focused card
      // also asked the daemon for history on mount/reconnect, which (a) drove
      // the daemon to recoverOpenCodeSessionRecord + exportOpenCodeSession for
      // OpenCode-typed cards the user never opened, and (b) overwhelmed the
      // WS bridge with N concurrent timeline.history_request calls per
      // reconnect. Inactive cards still render previews from memory/IDB
      // cache and live WS event pushes; they don't need their own backfill.
      //
      // When the user later activates the card, this effect re-runs (the
      // mount-effect dep array includes `isActiveSession`) and the gate
      // passes — at which point the bootstrap path issues its history
      // request as normal.
      if (!isActiveSessionRef.current) {
        updateHistoryStep('daemon', 'skipped', 'bootstrap');
        setLoading(false);
        setRefreshing(false);
        return;
      }
      if (visible) {
        updateHistoryStep('daemon', 'running', 'bootstrap');
        setRefreshing(true);
      } else {
        markDaemonHistoryBackground();
      }
      historyRequestIdRef.current = limit === undefined
        ? ws.sendTimelineHistoryRequest(sessionId)
        : ws.sendTimelineHistoryRequest(sessionId, limit);
    };

    // 1. Module-level memory cache — instant restore (e.g. window reopen)
    const memCached = getCachedEvents(cacheKey!);
    if (memCached && memCached.length > 0) {
      updateHistoryStep('cache', 'done', 'bootstrap');
      setEvents(memCached);
      setLoading(false);
      requestDaemonHistory(false, MAX_MEMORY_EVENTS);
      // Background HTTP backfill — catches events missed while this window
      // was minimized/backgrounded since the memory cache can be stale.
      // Kept short (~200ms) because the UI is already visible; this is
      // strictly additive catch-up, merged by eventId.
      if (isActiveSession) {
        fireHttpBackfillRef.current(200, { cooldownMs: MOUNT_BACKFILL_COOLDOWN_MS, phase: 'bootstrap' });
      }
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
      requestDaemonHistory(false, MAX_MEMORY_EVENTS);
      if (isActiveSession) {
        fireHttpBackfillRef.current(200, { cooldownMs: MOUNT_BACKFILL_COOLDOWN_MS, phase: 'bootstrap' });
      }
    }

    // 2. Already loaded this session — skip reload (prevents flash-of-empty on minimize/restore)
    if (historyLoadedRef.current === cacheKey) {
      updateHistoryStep('cache', 'done', 'bootstrap');
      setLoading(false);
      // Just request incremental updates
      requestDaemonHistory(false, MAX_MEMORY_EVENTS);
      // Same reasoning as path 1 — back-fill in the background so the
      // re-opened window is guaranteed to reflect authoritative daemon
      // state, not whatever the WS subscription happened to catch.
      if (isActiveSession) {
        fireHttpBackfillRef.current(200, { cooldownMs: MOUNT_BACKFILL_COOLDOWN_MS, phase: 'bootstrap' });
      }
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
        requestDaemonHistory(false, MAX_MEMORY_EVENTS);
        // Background HTTP backfill — IDB is authoritative only up to the
        // last time a WS event landed; if the user closed the tab mid-chat
        // and reopened later there may be a gap between IDB and daemon.
        if (isActiveSession) {
          fireHttpBackfillRef.current(200, { cooldownMs: MOUNT_BACKFILL_COOLDOWN_MS, phase: 'bootstrap' });
        }
      } else {
        epochRef.current = 0;
        seqRef.current = 0;
        if (cancelled) return;
        updateHistoryStep('cache', 'done', 'bootstrap');
        // Preserve any optimistic user messages added by the user before the
        // cold IDB load completed. Without this guard, a fast send right
        // after mount (before async load() finishes) gets wiped out — and
        // when `command.failed` arrives, the auto-retry path can't find the
        // optimistic event to settle it. Authoritative timeline events from
        // the daemon will arrive shortly after via WS / HTTP backfill and
        // reconcile (matched by commandId).
        setEvents((prev) => prev.filter(isLocalOptimisticUserMessage));
        if (wsConnected) {
          requestDaemonHistory(true);
        } else {
          setLoading(false);
        }
        // Cold load — no IDB cache, no memory cache. Still fire the same
        // delayed HTTP backfill so an empty timeline can recover missed
        // daemon-side events without waiting for a later reconnect.
        if (isActiveSession) {
          fireHttpBackfillRef.current(200, { cooldownMs: 0, phase: 'bootstrap' });
        }
      }
    };
    load().catch(() => {});
    return () => { cancelled = true; };
  }, [cacheKey, disableHistory, isActiveSession, sessionId, ws, wsConnected]);

  // Map of commandId → optimistic eventId for O(1) lookup on command.ack / dedup.
  const optimisticIdsByCommandRef = useRef(new Map<string, string>());
  // Per-commandId timeout handle so we can flip perpetual-spinner entries to failed.
  const optimisticTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const settledCommandIdsRef = useRef(new Set<string>());
  const settledCommandOrderRef = useRef<string[]>([]);

  // Per-commandId auto-retry bookkeeping. `attempts` counts only WS retries
  // (HTTP fallback is the final attempt and isn't counted). `timer` lets us
  // cancel a pending retry if the message settles (ack/echo) before the
  // backoff fires. `payloads` snapshots the message text + extra at first
  // failure so a transient empty `events` array (async IDB load completing
  // mid-retry) can't strand the retry chain without something to send. Maps
  // are pruned in `clearAutoRetryState`.
  const autoRetryAttemptsRef = useRef(new Map<string, number>());
  const autoRetryTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const autoRetryPayloadsRef = useRef(new Map<string, { text: string; extra: Record<string, unknown> }>());

  const rememberSettledCommandId = useCallback((commandId: string) => {
    if (!commandId || settledCommandIdsRef.current.has(commandId)) return;
    settledCommandIdsRef.current.add(commandId);
    settledCommandOrderRef.current.push(commandId);
    while (settledCommandOrderRef.current.length > 500) {
      const old = settledCommandOrderRef.current.shift();
      if (old) settledCommandIdsRef.current.delete(old);
    }
  }, []);

  const clearOptimisticTimer = useCallback((commandId: string) => {
    const timer = optimisticTimersRef.current.get(commandId);
    if (timer) {
      clearTimeout(timer);
      optimisticTimersRef.current.delete(commandId);
    }
  }, []);

  // Drop any pending auto-retry timer + attempt counter + cached payload for
  // this commandId. Called when the message is settled (ack / echo / explicit
  // retry / mark failed) so a delayed retry can't resurrect a settled bubble.
  const clearAutoRetryState = useCallback((commandId: string) => {
    if (!commandId) return;
    const timer = autoRetryTimersRef.current.get(commandId);
    if (timer) {
      clearTimeout(timer);
      autoRetryTimersRef.current.delete(commandId);
    }
    autoRetryAttemptsRef.current.delete(commandId);
    autoRetryPayloadsRef.current.delete(commandId);
  }, []);

  // Flip a pending optimistic entry to failed state (red "!" bubble with retry).
  const markOptimisticFailed = useCallback((commandId: string, error?: string) => {
    if (!commandId) return;
    if (settledCommandIdsRef.current.has(commandId)) return;
    const eventId = optimisticIdsByCommandRef.current.get(commandId);
    if (!eventId) return;
    clearOptimisticTimer(commandId);
    clearAutoRetryState(commandId);
    setEvents((prev) => {
      const base = getSharedTimelineBase(cacheKeyRef.current, prev, MAX_MEMORY_EVENTS);
      const idx = base.findIndex((e) => e.eventId === eventId);
      if (idx < 0) return base;
      const existing = base[idx]!;
      const text = String(existing.payload.text ?? '').trim();
      if (text) {
        const hasConfirmedEcho = base.some((e) =>
          e.type === 'user.message'
          && e.eventId !== eventId
          && !e.payload.pending
          && !e.payload.failed
          && String(e.payload.text ?? '').trim() === text,
        );
        if (hasConfirmedEcho) {
          optimisticIdsByCommandRef.current.delete(commandId);
          rememberSettledCommandId(commandId);
          const next = base.filter((e) => e.eventId !== eventId);
          if (cacheKeyRef.current) setCachedEvents(cacheKeyRef.current, next);
          return next;
        }
      }
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
  }, [clearAutoRetryState, clearOptimisticTimer, rememberSettledCommandId]);

  /**
   * Auto-retry an optimistic send when the server surfaces `command.failed`.
   *
   * Strategy (per "发送失败至少重试 2-3 次后再 HTTP watch 兜底，最终失败"):
   *   1. WS retry up to CLIENT_RETRY_MAX_ATTEMPTS times with exponential
   *      backoff. Same `commandId` is reused — the server clears inflight on
   *      `command.failed` (and dedup only blocks already-acked ids), so a
   *      replay with the same id is treated as a fresh dispatch.
   *   2. After WS retries exhausted, attempt one HTTP-send via the pod-sticky
   *      `/api/server/:serverId/session/send` endpoint. This succeeds even
   *      when the browser WS is broken because it doesn't depend on the same
   *      socket — only on serverId routing reaching the daemon's pod.
   *   3. Only after both fail, mark the bubble red so the user sees failure.
   *
   * The bubble stays in `pending` state throughout the retry chain so the
   * user doesn't see flicker between "❌" and "↻". The optimistic 90s timer
   * (separate) is the ultimate safety net if every retry is silently dropped.
   */
  const scheduleAutoRetry = useCallback((
    commandId: string,
    sessionName: string,
    reasonStr: AckFailureReason,
  ) => {
    if (!commandId) return;
    if (settledCommandIdsRef.current.has(commandId)) return;
    const eventId = optimisticIdsByCommandRef.current.get(commandId);
    if (!eventId) {
      // Optimistic event was removed — nothing to retry, just mark failed.
      markOptimisticFailed(commandId, localizedAckFailureReason(reasonStr));
      return;
    }

    // We pull the latest pending payload from `eventsRef` if available, AND
    // snapshot it the first time so a transient empty `events` (e.g. async
    // IDB load completing during retry backoff) can't strand the retry chain.
    const event = eventsRef.current.find((e) => e.eventId === eventId);
    if (event && event.payload && event.payload.pending === false && event.payload.failed !== true) {
      // Already accepted/settled — don't retry.
      return;
    }
    const cachedPayload = autoRetryPayloadsRef.current.get(commandId);
    const eventText = String(event?.payload?.text ?? cachedPayload?.text ?? '');
    const eventExtra = (event?.payload?._resendExtra && typeof event.payload._resendExtra === 'object')
      ? (event.payload._resendExtra as Record<string, unknown>)
      : (cachedPayload?.extra ?? {});

    const text = eventText;
    if (!text) {
      markOptimisticFailed(commandId, localizedAckFailureReason(reasonStr));
      return;
    }
    const resendExtra = eventExtra;
    // Snapshot for subsequent retries in this chain.
    autoRetryPayloadsRef.current.set(commandId, { text, extra: resendExtra });

    const attempts = autoRetryAttemptsRef.current.get(commandId) ?? 0;

    // Exhausted WS retries → HTTP fallback (one shot), then mark failed.
    if (attempts >= CLIENT_RETRY_MAX_ATTEMPTS) {
      if (!serverId) {
        markOptimisticFailed(commandId, localizedAckFailureReason(reasonStr));
        return;
      }
      // Bump beyond CLIENT_RETRY_MAX_ATTEMPTS so a duplicate command.failed
      // (e.g. server retries inside `replayInflightToDaemon`) does not stack
      // a second HTTP attempt while the first is still in flight.
      autoRetryAttemptsRef.current.set(commandId, attempts + 1);
      const httpPayload: Record<string, unknown> = {
        sessionName,
        text,
        commandId,
        ...resendExtra,
      };
      void sendSessionViaHttp(serverId, httpPayload).then(() => {
        // HTTP returns 2xx — daemon accepted the message via REST path.
        // The authoritative `user.message` echo will arrive via WS and
        // settle the bubble; we do NOT mark accepted here because HTTP
        // success only proves the server enqueued, not that the agent saw it.
      }).catch(() => {
        markOptimisticFailed(commandId, localizedAckFailureReason(reasonStr));
      });
      return;
    }

    // Schedule the next WS retry. Cancel any prior pending timer for this
    // commandId so a flurry of duplicate `command.failed` events (rare but
    // possible on rapid daemon flap) doesn't queue multiple retries.
    const existingTimer = autoRetryTimersRef.current.get(commandId);
    if (existingTimer) clearTimeout(existingTimer);

    const delay = CLIENT_RETRY_DELAYS_MS[Math.min(attempts, CLIENT_RETRY_DELAYS_MS.length - 1)];
    autoRetryAttemptsRef.current.set(commandId, attempts + 1);

    const timer = setTimeout(() => {
      autoRetryTimersRef.current.delete(commandId);
      // Re-check state at fire time: user may have manually retried, or the
      // echo / ack could have arrived during the backoff. We tolerate the
      // optimistic event temporarily missing from `eventsRef` (async IDB
      // load can briefly empty the array between failure and retry-fire) —
      // settledCommandIdsRef is the authoritative "stop retrying" signal.
      if (settledCommandIdsRef.current.has(commandId)) return;
      const stillTracked = optimisticIdsByCommandRef.current.get(commandId);
      if (stillTracked !== eventId) return;
      const currentEvent = eventsRef.current.find((e) => e.eventId === eventId);
      if (currentEvent && currentEvent.payload && currentEvent.payload.pending === false && currentEvent.payload.failed !== true) {
        // Was settled (acked) during the backoff.
        return;
      }

      const wsClient = ws;
      if (wsClient && wsClient.connected) {
        try {
          wsClient.sendSessionCommand('send', { sessionName, text, commandId, ...resendExtra });
          return;
        } catch {
          // WS threw — fall through to HTTP fallback this iteration by
          // jumping the attempts counter to MAX so the next retry-trigger
          // (or this synthetic one) goes the HTTP route.
        }
      }
      // WS unavailable (or threw) — short-circuit to HTTP fallback.
      autoRetryAttemptsRef.current.set(commandId, CLIENT_RETRY_MAX_ATTEMPTS);
      scheduleAutoRetry(commandId, sessionName, reasonStr);
    }, delay);
    autoRetryTimersRef.current.set(commandId, timer);
  }, [markOptimisticFailed, serverId, ws]);

  // Remove an optimistic entry entirely — used by the retry button so the retry
  // doesn't leave behind the failed bubble (the fresh send re-renders it).
  const removeOptimisticMessage = useCallback((commandId: string) => {
    if (!commandId) return;
    const eventId = optimisticIdsByCommandRef.current.get(commandId);
    optimisticIdsByCommandRef.current.delete(commandId);
    clearOptimisticTimer(commandId);
    clearAutoRetryState(commandId);
    if (!eventId) return;
    setEvents((prev) => {
      const base = getSharedTimelineBase(cacheKeyRef.current, prev, MAX_MEMORY_EVENTS);
      const next = base.filter((e) => e.eventId !== eventId);
      if (next.length === base.length) return base;
      if (cacheKeyRef.current) setCachedEvents(cacheKeyRef.current, next);
      return next;
    });
  }, [clearAutoRetryState, clearOptimisticTimer]);

  const reconcileQueuedOptimisticMessages = useCallback((pendingEntries: unknown, pendingMessages: unknown) => {
    const queuedEntries = normalizeTransportPendingEntries(pendingEntries, pendingMessages, sessionId ?? '');
    if (queuedEntries.length === 0) return;
    const queuedIds = new Set(queuedEntries.map((entry) => entry.clientMessageId).filter(Boolean));
    if (queuedIds.size === 0) return;
    setEvents((prev) => {
      const base = getSharedTimelineBase(cacheKeyRef.current, prev, MAX_MEMORY_EVENTS);
      let changed = false;
      const next = base.filter((event) => {
        if (!isLocalOptimisticUserMessage(event)) return true;
        const commandId = typeof event.payload.commandId === 'string' ? event.payload.commandId : '';
        if (!commandId || !queuedIds.has(commandId)) return true;
        optimisticIdsByCommandRef.current.delete(commandId);
        rememberSettledCommandId(commandId);
        clearOptimisticTimer(commandId);
        changed = true;
        return false;
      });
      if (!changed) return base;
      if (cacheKeyRef.current) setCachedEvents(cacheKeyRef.current, next);
      return next;
    });
  }, [clearOptimisticTimer, rememberSettledCommandId, sessionId]);

  const markOptimisticAccepted = useCallback((commandId: string) => {
    if (!commandId) return;
    const eventId = optimisticIdsByCommandRef.current.get(commandId);
    clearOptimisticTimer(commandId);
    clearAutoRetryState(commandId);
    rememberSettledCommandId(commandId);
    if (!eventId) return;
    setEvents((prev) => {
      const base = getSharedTimelineBase(cacheKeyRef.current, prev, MAX_MEMORY_EVENTS);
      const idx = base.findIndex((e) => e.eventId === eventId);
      if (idx < 0) return base;
      const existing = base[idx]!;
      const payload: Record<string, unknown> = {
        ...existing.payload,
        pending: false,
        failed: false,
        acked: true,
      };
      delete payload.failureReason;
      const updated = [...base];
      updated[idx] = { ...existing, payload };
      if (cacheKeyRef.current) setCachedEvents(cacheKeyRef.current, updated);
      return updated;
    });
  }, [clearOptimisticTimer, rememberSettledCommandId]);

  const settleOptimisticByCommandAck = useCallback((commandId: string, status: string, error?: unknown) => {
    if (!commandId || !status) return;
    if (status === 'error' || status === 'conflict') {
      markOptimisticFailed(commandId, typeof error === 'string' ? error : status);
      return;
    }
    markOptimisticAccepted(commandId);
  }, [markOptimisticAccepted, markOptimisticFailed]);

  const settleOptimisticByCommandAckEvent = useCallback((event: TimelineEvent) => {
    if (event.type !== 'command.ack') return;
    const commandId = typeof event.payload.commandId === 'string' ? event.payload.commandId : '';
    const status = typeof event.payload.status === 'string' ? event.payload.status : '';
    settleOptimisticByCommandAck(commandId, status, event.payload.error);
  }, [settleOptimisticByCommandAck]);

  const retryOptimisticMessage = useCallback((
    oldCommandId: string,
    newCommandId: string,
    text: string,
    opts?: {
      attachments?: Array<Record<string, unknown>>;
      resendExtra?: Record<string, unknown>;
    },
  ) => {
    if (!sessionId || !oldCommandId || !newCommandId) return;
    const eventId = optimisticIdsByCommandRef.current.get(oldCommandId);
    optimisticIdsByCommandRef.current.delete(oldCommandId);
    clearOptimisticTimer(oldCommandId);
    optimisticIdsByCommandRef.current.set(newCommandId, eventId ?? `${OPTIMISTIC_EVENT_ID_PREFIX}${sessionId}:${newCommandId}`);
    clearOptimisticTimer(newCommandId);
    const timer = setTimeout(() => {
      markOptimisticFailed(newCommandId, 'timeout');
    }, OPTIMISTIC_TIMEOUT_MS);
    optimisticTimersRef.current.set(newCommandId, timer);

    setEvents((prev) => {
      const base = getSharedTimelineBase(cacheKeyRef.current, prev, MAX_MEMORY_EVENTS);
      const idx = eventId ? base.findIndex((e) => e.eventId === eventId) : -1;
      const payload: Record<string, unknown> = {
        text,
        pending: true,
        failed: false,
        commandId: newCommandId,
      };
      if (opts?.attachments && opts.attachments.length > 0) payload.attachments = opts.attachments;
      if (opts?.resendExtra && Object.keys(opts.resendExtra).length > 0) payload._resendExtra = opts.resendExtra;
      if (idx >= 0) {
        const existing = base[idx]!;
        const updated = [...base];
        updated[idx] = {
          ...existing,
          ts: Date.now(),
          payload: {
            ...existing.payload,
            ...payload,
          },
        };
        delete updated[idx]!.payload.failureReason;
        delete updated[idx]!.payload.acked;
        if (cacheKeyRef.current) setCachedEvents(cacheKeyRef.current, updated);
        return updated;
      }
      const optimisticId = `${OPTIMISTIC_EVENT_ID_PREFIX}${sessionId}:${newCommandId}`;
      optimisticIdsByCommandRef.current.set(newCommandId, optimisticId);
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
      const result = [...base, event];
      if (cacheKeyRef.current) setCachedEvents(cacheKeyRef.current, result);
      return result;
    });
  }, [clearOptimisticTimer, markOptimisticFailed, sessionId]);

  const settleOptimisticByTimelineProgress = useCallback((progressEvent: TimelineEvent) => {
    if (!isAuthoritativeSendProgressEvent(progressEvent)) return;
    const pendingCommands = [...optimisticIdsByCommandRef.current.entries()];
    if (pendingCommands.length === 0) return;
    const base = getSharedTimelineBase(cacheKeyRef.current, eventsRef.current, MAX_MEMORY_EVENTS);
    for (const [commandId, optimisticId] of pendingCommands) {
      if (settledCommandIdsRef.current.has(commandId)) continue;
      const optimisticEvent = base.find((event) => event.eventId === optimisticId);
      if (!optimisticEvent || optimisticEvent.type !== 'user.message') continue;
      if (!optimisticEvent.payload.pending && !optimisticEvent.payload.failed) continue;
      if (typeof optimisticEvent.ts === 'number' && progressEvent.ts + 1_000 < optimisticEvent.ts) continue;
      const relatedToEventId = progressEvent.type === 'memory.context' && typeof progressEvent.payload.relatedToEventId === 'string'
        ? progressEvent.payload.relatedToEventId
        : '';
      if (relatedToEventId) {
        const relatedUserMessage = base.find((event) => event.eventId === relatedToEventId && event.type === 'user.message');
        if (relatedUserMessage) {
          setEvents((prev) => {
            const current = getSharedTimelineBase(cacheKeyRef.current, prev, MAX_MEMORY_EVENTS);
            const optimisticIdx = current.findIndex((event) => event.eventId === optimisticId);
            if (optimisticIdx < 0) return current;
            const next = current.filter((event) => event.eventId !== relatedToEventId);
            const idx = next.findIndex((event) => event.eventId === optimisticId);
            if (idx < 0) return current;
            next[idx] = relatedUserMessage;
            if (cacheKeyRef.current) setCachedEvents(cacheKeyRef.current, next);
            return next;
          });
          optimisticIdsByCommandRef.current.delete(commandId);
          clearOptimisticTimer(commandId);
          rememberSettledCommandId(commandId);
          continue;
        }
      }
      markOptimisticAccepted(commandId);
    }
  }, [clearOptimisticTimer, markOptimisticAccepted, rememberSettledCommandId]);

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
    if (disableHistory) return;
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
  }, [disableHistory, ws, sessionId]);

  // Append or replace a single event by eventId.
  // Same eventId → replace in place (supports streaming transport updates).
  // New eventId → append to end.
  const appendEvent = useCallback((event: TimelineEvent) => {
    setEvents((prev) => {
      const sharedBase = getSharedTimelineBase(cacheKeyRef.current, prev, MAX_MEMORY_EVENTS);
      const base = removeReconciledLocalUserMessages(sharedBase, [event]);
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
      const sharedBase = getSharedTimelineBase(cacheKeyRef.current, prev, maxEvents);
      const base = removeReconciledLocalUserMessages(sharedBase, incoming);
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
  // Stable ref for `isActiveSession`. Declared up here (instead of below
  // `fireHttpBackfill`) because the fire-gate reads it — keeping the ref
  // declaration earlier in the source order avoids a TDZ trap if anything
  // ever calls fireHttpBackfill synchronously during render (it doesn't
  // today, but the dependency direction should be safe by construction).
  const isActiveSessionRef = useRef(isActiveSession);
  isActiveSessionRef.current = isActiveSession;

  // Retry schedule for transient HTTP backfill failures (daemon briefly
  // offline at activation, pod miss during deploy, network blip on resume).
  // Two retries cover the common ~3s WS-reconnect window after app foreground.
  // After both retries fail we give up — the next activation/reconnect will
  // fire a fresh backfill, and the WS path remains the primary.
  const HTTP_BACKFILL_RETRY_DELAYS_MS = [800, 2000] as const;

  const fireHttpBackfill = useCallback((delayMs: number, opts?: { cooldownMs?: number; phase?: 'bootstrap' | 'refresh'; visible?: boolean; _retryAttempt?: number }) => {
    // Read `isActiveSession` via ref so this gate always reflects the latest
    // render's value, never a stale closure. The closure value only desynchs
    // briefly during same-tick `setState` → render → effect sequences (e.g.
    // push-tap that activates a session AND fires the activation event in
    // the same microtask), but in practice that gap was wide enough to drop
    // backfills on real iOS/Android resumes — even after f72193f6 removed
    // `isActiveSession` from the listener's deps. Reading the ref closes
    // the remaining hole.
    if (disableHistory || !isActiveSessionRef.current || !serverId || !sessionId) {
      backfillDebug('fireHttpBackfill: gated', { disableHistory, isActiveSession: isActiveSessionRef.current, hasServerId: !!serverId, hasSessionId: !!sessionId, sessionId });
      return;
    }
    const cooldownMs = opts?.cooldownMs ?? 0;
    const phase = opts?.phase ?? 'refresh';
    const visible = opts?.visible === true;
    const retryAttempt = opts?._retryAttempt ?? 0;
    const backfillSessionId = sessionId;
    const backfillCacheKey = cacheKey;
    setTimeout(() => {
      if (cacheKeyRef.current !== backfillCacheKey) return;
      if (backfillCacheKey && cooldownMs > 0) {
        const lastOk = lastHttpBackfillOkAt.get(backfillCacheKey);
        if (lastOk !== undefined && Date.now() - lastOk < cooldownMs) {
          backfillDebug('fireHttpBackfill: cooldown skip', { sessionId: backfillSessionId, lastOk, cooldownMs });
          return;
        }
      }
      // Recompute the cursor at fire time, not call time — the UI may have
      // received fresh WS events during the delay window and we don't want
      // to redownload them.
      const afterTs = getTimelineHistoryAfterTs(eventsRef.current);
      backfillDebug('fireHttpBackfill: requesting', { sessionId: backfillSessionId, phase, afterTs, retryAttempt });
      if (visible) {
        httpBackfillInFlightRef.current += 1;
        updateHistoryStep('http', 'running', phase);
        setHttpRefreshing(true);
      }
      void Promise.resolve(fetchTimelineHistoryHttp(serverId, backfillSessionId, {
        afterTs,
        limit: MAX_MEMORY_EVENTS,
      })).then((result) => {
        if (!result) {
          // Transient failure (daemon offline / pod miss / network blip).
          // Retry with backoff if budget remains; otherwise give up — the WS
          // path or next activation will catch up.
          if (retryAttempt < HTTP_BACKFILL_RETRY_DELAYS_MS.length) {
            const delay = HTTP_BACKFILL_RETRY_DELAYS_MS[retryAttempt];
            backfillDebug('fireHttpBackfill: null result → retry', { sessionId: backfillSessionId, retryAttempt: retryAttempt + 1, delayMs: delay });
            setTimeout(() => {
              fireHttpBackfillRef.current(0, { ...opts, _retryAttempt: retryAttempt + 1 });
            }, delay);
          } else {
            backfillDebug('fireHttpBackfill: null result → give up', { sessionId: backfillSessionId, retryAttempt });
          }
          return;
        }
        if (backfillCacheKey) lastHttpBackfillOkAt.set(backfillCacheKey, Date.now());
        if (result.events.length === 0) {
          backfillDebug('fireHttpBackfill: no new events', { sessionId: backfillSessionId });
          return;
        }
        if (cacheKeyRef.current !== backfillCacheKey) return;
        const recovered = result.events.filter(
          (ev): ev is TimelineEvent => !!ev && typeof ev === 'object' && typeof (ev as TimelineEvent).eventId === 'string',
        );
        if (recovered.length === 0) return;
        backfillDebug('fireHttpBackfill: merging', { sessionId: backfillSessionId, count: recovered.length });
        mergeEvents(recovered);
        for (const recoveredEvent of recovered) {
          settleOptimisticByCommandAckEvent(recoveredEvent);
          settleOptimisticByTimelineProgress(recoveredEvent);
        }
        idbPutEvents(recovered);
      }).catch(() => { /* opportunistic — WS path is primary */ })
        .finally(() => {
          if (visible) {
            httpBackfillInFlightRef.current = Math.max(0, httpBackfillInFlightRef.current - 1);
            updateHistoryStep('http', 'done', phase);
            if (httpBackfillInFlightRef.current === 0) setHttpRefreshing(false);
          }
        });
    }, delayMs);
  }, [disableHistory, isActiveSession, serverId, sessionId, cacheKey, mergeEvents, idbPutEvents, settleOptimisticByCommandAckEvent, settleOptimisticByTimelineProgress, updateHistoryStep]);

  // Stable indirection — lets the session-mount effect below call the latest
  // `fireHttpBackfill` without having to list it (and transitively its five
  // dependencies) in its own dep array, which would otherwise cause the
  // mount effect to re-run on every render.
  const fireHttpBackfillRef = useRef(fireHttpBackfill);
  fireHttpBackfillRef.current = fireHttpBackfill;
  const lastActiveRefreshAtRef = useRef(0);

  // (`isActiveSessionRef` declared above so the fire-gate can read it.)
  //
  // The listener reads `isActiveSessionRef.current` at event time so it
  // stays correct across session-switches without re-attaching. Re-attaching
  // on every isActiveSession flip opened a race where an event dispatched
  // in the same microtask as the flip (e.g. a foreground resume that also
  // switches the active session via push-notification) landed between the
  // cleanup and re-add, was silently dropped, and the user stared at stale
  // chat content. See commits 1c178a4a/35d87485 for the regression that
  // f72193f6 fixed by pinning the listener deps to `[disableHistory, sessionId]`.

  // Force-refresh the active session when the app comes back to the
  // foreground or a push-notification is tapped. The listener stays
  // attached across session switches and reads `isActiveSessionRef.current`
  // at event time so only the currently-active hook fires the backfill —
  // satisfying "fast cache 这些一定只触发激活窗口的".
  useEffect(() => {
    if (disableHistory) return;
    const handler = (): void => {
      if (!isActiveSessionRef.current) {
        backfillDebug('activation event: gated by !isActiveSession', { sessionId });
        return;
      }
      const now = Date.now();
      if (now - lastActiveRefreshAtRef.current < 250) {
        backfillDebug('activation event: rate-limited', { sessionId });
        return;
      }
      lastActiveRefreshAtRef.current = now;
      backfillDebug('activation event: firing backfill', { sessionId });
      // SILENT (visible: false) — activation events fire on every focus /
      // visibility / pageshow / appStateChange tick. Even with the 15s
      // cooldown coalescing the burst, when a fetch DOES go through, the
      // visible:true variant flips `setHttpRefreshing(true→false)` and
      // every subscribed component re-renders. On a chat with hundreds
      // of timeline events the back-to-back state flips visibly stutter
      // the scroll. Recovery paths that genuinely need user-visible
      // feedback (mount bootstrap, WS reconnect, ack_timeout) keep
      // visible:true; activation is the high-frequency path that must
      // stay imperceptible.
      //
      // `cooldownMs: 15s` so a session that's been refreshed in the last
      // 15s does NOT refire on every focus/visibility/appStateChange tick.
      // App-resume's resetCooldowns:true path explicitly clears the map
      // so a real foreground from background still bypasses this.
      fireHttpBackfillRef.current(0, { phase: 'refresh', cooldownMs: ACTIVE_REFRESH_COOLDOWN_MS });
    };
    window.addEventListener(ACTIVE_TIMELINE_REFRESH_EVENT, handler);
    return () => window.removeEventListener(ACTIVE_TIMELINE_REFRESH_EVENT, handler);
  }, [disableHistory, sessionId]);

  // Whenever this hook becomes the active session (false → true transition),
  // fire an immediate backfill — satisfies "激活哪个触发哪个". The mount
  // path already handles first-render bootstrap, so we explicitly skip
  // mount and only react to subsequent flips. Using a ref makes the
  // transition detection idempotent across re-renders that don't change
  // `isActiveSession`.
  const prevIsActiveRef = useRef(isActiveSession);
  useEffect(() => {
    if (disableHistory) return;
    const prev = prevIsActiveRef.current;
    prevIsActiveRef.current = isActiveSession;
    if (!prev && isActiveSession) {
      backfillDebug('isActiveSession false→true: firing backfill', { sessionId });
      // SILENT (visible: false). Same reasoning as the activation-event
      // handler above — the false→true transition fires whenever the user
      // taps a session card; coupling that with a refreshing-state flip
      // re-renders the chat list and stutters the scroll. The 15s
      // cooldown handles dedup against the activation-event tick that
      // usually arrives in the same commit.
      fireHttpBackfillRef.current(0, { phase: 'refresh', cooldownMs: ACTIVE_REFRESH_COOLDOWN_MS });
    }
  }, [isActiveSession, disableHistory, sessionId]);

  // Listen for WS messages
  useEffect(() => {
    if (disableHistory || !ws || !sessionId) return;

    const handler = (msg: ServerMessage) => {
      // ── Real-time event ──
      if (msg.type === 'timeline.event') {
        const event = msg.event;
        if (event.sessionId !== sessionId) return;
        if (event.type === 'session.state' && event.payload?.state === 'queued') {
          reconcileQueuedOptimisticMessages(event.payload.pendingMessageEntries, event.payload.pendingMessages);
        }
        settleOptimisticByCommandAckEvent(event);

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
        let userMessageAlreadyMerged = false;
        if (event.type === 'user.message' && event.payload.text) {
          const text = String(event.payload.text).trim();
          const normalizedText = normalizeForEcho(text);
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
            //    bubble that matches this echo's commandId regardless of state.
            //    Replace in place so retry/success preserve the original visual
            //    position and linked memory.context cards attach to the real id.
            if (echoCommandId) {
              const optimisticId = optimisticIdsByCommandRef.current.get(echoCommandId);
              if (optimisticId) {
                const idx = base.findIndex((e) => e.eventId === optimisticId);
                optimisticIdsByCommandRef.current.delete(echoCommandId);
                clearOptimisticTimer(echoCommandId);
                rememberSettledCommandId(echoCommandId);
                if (idx >= 0) {
                  const updated = [...base];
                  updated[idx] = event;
                  if (cacheKeyRef.current) setCachedEvents(cacheKeyRef.current, updated);
                  userMessageAlreadyMerged = true;
                  return updated;
                }
              }
              rememberSettledCommandId(echoCommandId);
            }
            // 2) Fallback to text-based cleanup for legacy emit paths (tmux
            //    JSONL scrapers, etc.) that don't propagate commandId.
            const optimisticTextIdx = base.findIndex(
              (e) =>
                e.type === 'user.message'
                && (e.payload.pending || e.payload.failed)
                && normalizeForEcho(String(e.payload.text ?? '')) === normalizedText,
            );
            if (optimisticTextIdx >= 0) {
              const removed = base[optimisticTextIdx]!;
              const removedCommandId = typeof removed.payload.commandId === 'string'
                ? removed.payload.commandId
                : '';
              if (removedCommandId) {
                optimisticIdsByCommandRef.current.delete(removedCommandId);
                clearOptimisticTimer(removedCommandId);
                rememberSettledCommandId(removedCommandId);
              }
              const updated = [...base];
              updated[optimisticTextIdx] = event;
              if (cacheKeyRef.current) setCachedEvents(cacheKeyRef.current, updated);
              userMessageAlreadyMerged = true;
              return updated;
            }
            const withoutPending = base.filter(
              (e) => {
                if (e.type !== 'user.message' || (!e.payload.pending && !e.payload.failed)) return true;
                const candidateCommandId = typeof e.payload.commandId === 'string'
                  ? e.payload.commandId
                  : '';
                return candidateCommandId !== echoCommandId;
              },
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

        settleOptimisticByTimelineProgress(event);


        // Update epoch tracker — don't clear events on epoch change;
        // history response will merge the authoritative set, and ts-sort handles cross-epoch order.
        epochRef.current = event.epoch;
        seqRef.current = Math.max(seqRef.current, event.seq);
        if (!userMessageAlreadyMerged) appendEvent(event);

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
          for (const historyEvent of msg.events) {
            settleOptimisticByCommandAckEvent(historyEvent);
            settleOptimisticByTimelineProgress(historyEvent);
          }
          idbPutEvents(msg.events);
        } else if (historyRetryRef.current < 2 && ws?.connected && eventsRef.current.length === 0 && isActiveSessionRef.current) {
          // Empty response with no cached events — retry once after a short delay
          // (defense-in-depth for transient bridge/daemon failures).
          // Gate by isActiveSession so non-focused SubSessionCards don't keep
          // retrying forever when their backing session has no events yet.
          historyRetryRef.current++;
          setTimeout(() => {
            // Re-check the flag at fire time — the user may have switched
            // away in the 1-2s delay window.
            if (!isActiveSessionRef.current) return;
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
          for (const replayEvent of replayEvents) {
            settleOptimisticByCommandAckEvent(replayEvent);
            settleOptimisticByTimelineProgress(replayEvent);
          }
          idbPutEvents(replayEvents);
        }
        setRefreshing(false);
      }

      // ── Reconnect: daemon restarted → epoch changed, replay is useless. Request only new events. ──
      if (msg.type === DAEMON_MSG.RECONNECTED) {
        // Only the active card's hook should refresh from daemon — N
        // SubSessionCards mounted in the bar would otherwise herd the daemon
        // with N concurrent timeline.history_request RPCs on every daemon
        // restart. Inactive cards' content stays warm via memory/IDB cache
        // plus live WS events; the next time the user activates one, its
        // hook's isActiveSession flips true and the active-session-refresh
        // listener pulls fresh history then.
        if (!isActiveSessionRef.current) return;
        // Keep local optimistic bubbles visible across reconnect. The daemon may
        // have received and persisted the send while the browser missed the ack
        // or the live timeline echo; removing the bubble here makes the message
        // appear to vanish until a manual refresh. History/backfill below will
        // reconcile confirmed sends by commandId/text, and the existing timeout
        // still marks genuinely unconfirmed sends as retryable.
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
          fireHttpBackfillRef.current(600, { phase: 'refresh', visible: true });
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
        // Same gate as the DAEMON_MSG.RECONNECTED path — restrict the
        // browser-WS reconnect refresh to the active card's hook so we
        // don't herd the daemon with N timeline.history_request +
        // timeline.replay calls every reconnect. Inactive sub-session
        // cards keep their cache and pick up live events; full history
        // re-sync happens when the user next activates that card.
        if (!isActiveSessionRef.current) return;
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
        settleOptimisticByCommandAck(commandId, status, (msg as unknown as Record<string, unknown>).error);
      }

      // ── command.failed: server-surfaced send failure.
      //    Policy: do NOT immediately flash red. Auto-retry up to
      //    CLIENT_RETRY_MAX_ATTEMPTS times via WS, then HTTP fallback, then
      //    mark failed. This honors the "至少重试 2-3 次后再 HTTP 兜底，最终
      //    失败" preference and matches what users intuitively expect: a
      //    transient network blip should not surface as a red error. ──
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
        if (reasonStr === 'ack_timeout') {
          // ack_timeout means the server already retried 5x with the daemon
          // connected — further client retries won't help, but the message
          // MAY have actually landed and the ack got lost. Let the HTTP
          // backfill recover the echo from the daemon's persisted store.
          fireHttpBackfillRef.current(0, { phase: 'refresh', visible: true });
          return;
        }
        // daemon_offline / daemon_error → WS retry chain → HTTP fallback → fail.
        // The bubble stays pending the whole time so the user doesn't see
        // a "fail then succeed" flicker.
        const retrySessionName = failedSession ?? sessionId;
        scheduleAutoRetry(commandId, retrySessionName, reasonStr);
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
  }, [disableHistory, isActiveSession, ws, sessionId, appendEvent, clearOptimisticTimer, loading, markOptimisticFailed, mergeEvents, reconcileQueuedOptimisticMessages, rememberSettledCommandId, replaceEvents, scheduleAutoRetry, serverId, settleOptimisticByCommandAck, settleOptimisticByCommandAckEvent, settleOptimisticByTimelineProgress, updateHistoryStep]);

  useEffect(() => {
    if (loading || refreshing || httpRefreshing || loadingOlder) return;
    setHistoryStatus((prev) => (prev.phase === 'idle' ? prev : createIdleHistoryStatus()));
  }, [httpRefreshing, loading, loadingOlder, refreshing]);

  // Clear outstanding optimistic timers on unmount / session change so that a
  // dismissed chat window can't fire a delayed markOptimisticFailed into an
  // unmounted component.
  useEffect(() => {
    const timers = optimisticTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      optimisticIdsByCommandRef.current.clear();
      settledCommandIdsRef.current.clear();
      settledCommandOrderRef.current = [];
    };
  }, [sessionId]);

  return {
    events,
    loading,
    refreshing: refreshing || httpRefreshing,
    historyStatus,
    loadingOlder,
    hasOlderHistory,
    addOptimisticUserMessage,
    markOptimisticFailed,
    removeOptimisticMessage,
    retryOptimisticMessage,
    loadOlderEvents,
  };
}
