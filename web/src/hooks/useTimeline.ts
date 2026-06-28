import { DAEMON_MSG } from '@shared/daemon-events.js';
import { TRANSPORT_MSG } from '@shared/transport-events.js';
import {
  TIMELINE_CURSOR_DIRECTIONS,
  TIMELINE_DETAIL_FIELD_PATHS as SHARED_TIMELINE_DETAIL_FIELD_PATHS,
  TIMELINE_MESSAGES,
  TIMELINE_PROTOCOL_REVISION,
  TIMELINE_RESPONSE_STATUS,
  type TimelineCursor,
  type TimelinePayloadMetadata,
} from '@shared/timeline-protocol.js';
import {
  TIMELINE_DETAIL_ERROR_REASONS,
  TIMELINE_HISTORY_ERROR_REASONS,
  TIMELINE_PAGE_ERROR_REASONS,
  TIMELINE_REQUEST_ERROR_REASONS,
  isRecoverableTimelineRequestErrorReason,
} from '@shared/timeline-history-errors.js';
import i18next from 'i18next';
import {
  MSG_COMMAND_FAILED,
  MSG_DAEMON_ONLINE,
  MSG_DAEMON_OFFLINE,
  type AckFailureReason,
} from '@shared/ack-protocol.js';
import { TIMELINE_SNAPSHOT_STORAGE_PREFIX } from '../local-storage-quota.js';

/** Map an AckFailureReason to a localized message suitable for failureReason payload. */
function localizedAckFailureReason(reason: AckFailureReason): string {
  const withFallback = (key: string, fallback: string): string => {
    const value = i18next.t(key, fallback);
    return typeof value === 'string' && value.trim() ? value : fallback;
  };
  // Keys live under `chat.sendFailedReason.*` in every locale JSON.
  switch (reason) {
    case 'daemon_offline':
      return withFallback('chat.sendFailedReason.daemonOffline', 'Connection lost');
    case 'ack_timeout':
      return withFallback('chat.sendFailedReason.ackTimeout', 'No response');
    case 'daemon_error':
      return withFallback('chat.sendFailedReason.daemonError', 'Server error');
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
import {
  TIMELINE_DETAIL_FIELD_PATHS,
  mergeTimelineEvents,
  preferTimelineEvent,
  type TimelineDetailFieldPath,
} from '../../../src/shared/timeline/merge.js';
import { TIMELINE_HISTORY_CONTENT_TYPES } from '../../../src/shared/timeline/types.js';
import { fetchTimelineHistoryHttp, sendSessionViaHttp } from '../api.js';
import { runNewestWindowBackfill } from '../timeline/catchup/backfill-pager.js';
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
// Per-cacheKey wall-clock of the last *successful* HTTP backfill (response
// received, not a timeout/null). Two consumers:
//   1. The activation/mount cooldown — coalesces the focus/visibility/tap burst
//      so the same session isn't re-fetched on every tick (timeouts/nulls don't
//      write here, so a failed read never suppresses the next retry).
//   2. The foreground watchdog — treats any fresh response (even a no-gap empty
//      one) as "recently responded, stop re-probing for now". This is NOT a
//      verified-contiguous signal (that is cycle-2 Layer B); it only damps the
//      idle/responding poll rate.
const lastHttpBackfillResponseAt = new Map<string, number>();
const MOUNT_BACKFILL_COOLDOWN_MS = 60_000;
/** Scenario-based HTTP timeout for catch-up backfills. The keystone weak-network
 *  fix was lifting the 2.5s default (which aborted before a slow daemon could
 *  answer on a weak link). But a flat 10s also wastes the everyday silent path's
 *  failure-detection budget (round-4 audit N2), so the budget now scales with how
 *  user-visible the recovery is. All values stay below the server relay budget
 *  (`server/src/ws/bridge.ts` HTTP_TIMELINE_TIMEOUT_MS = 15s). */
const SILENT_BACKFILL_TIMEOUT_MS = 6_000;     // activation / watchdog background probes
const MOUNT_BACKFILL_TIMEOUT_MS = 8_000;      // first-open bootstrap
const RECOVERY_BACKFILL_TIMEOUT_MS = 10_000;  // visible resume / reconnect recovery
const FORCE_BACKFILL_TIMEOUT_MS = 12_000;     // manual ↻ — user is waiting; cap < 15s
/** Pick the HTTP timeout from the fire reason encoded in the existing opts:
 *  force (manual) > bootstrap (mount) > visible recovery > silent background. */
function resolveBackfillTimeoutMs(opts?: { phase?: 'bootstrap' | 'refresh'; visible?: boolean; force?: boolean }): number {
  if (opts?.force) return FORCE_BACKFILL_TIMEOUT_MS;
  if (opts?.phase === 'bootstrap') return MOUNT_BACKFILL_TIMEOUT_MS;
  if (opts?.visible) return RECOVERY_BACKFILL_TIMEOUT_MS;
  return SILENT_BACKFILL_TIMEOUT_MS;
}
/** Foreground staleness watchdog. A session the user is looking at can silently
 *  miss a CONTENT `timeline.event` while the pipe still looks alive (no error,
 *  no reconnect, no focus tick) — the "前台停留弱网不自动同步" complaint. When no
 *  content event AND no HTTP response has landed within WATCHDOG_STALE_MS, the
 *  watchdog fires one silent catch-up. NOTE: `lastHttpBackfillResponseAt` only
 *  means "an HTTP backfill returned (non-null)", NOT "the timeline is verified
 *  caught up" — a verified/contiguous cursor is cycle-2 Layer B, not yet here. */
const WATCHDOG_INTERVAL_MS = 30_000;
const WATCHDOG_STALE_MS = 45_000;
/** When the watchdog keeps finding the session stale (link down / persistent
 *  failure so `lastHttpBackfillResponseAt` never advances), space successive
 *  probes out exponentially instead of firing every WATCHDOG_INTERVAL_MS. */
const WATCHDOG_BACKOFF_BASE_MS = 30_000;
const WATCHDOG_BACKOFF_MAX_MS = 120_000;
const WATCHDOG_JITTER_MS = 8_000;
/** Per-cacheKey watchdog scheduling state. `nextAllowedAt` gates BOTH the
 *  exponential backoff AND dedup across multiple hook mounts of the same session
 *  (they share the cacheKey entry, so only one probe fires per window — round-4
 *  audit R1/A3). Reset when the session goes fresh again. */
const watchdogStateByCacheKey = new Map<string, { nextAllowedAt: number; streak: number }>();
const RESUME_RESET_COOLDOWN_AFTER_MS = 60_000;
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
 * `lastHttpBackfillResponseAt`, so a real foreground transition still bypasses
 * this gate.
 */
const ACTIVE_REFRESH_COOLDOWN_MS = 15_000;
const RECONNECT_REFRESH_COOLDOWN_MS = 15_000;
// On activation (app foreground / session focus) re-read LOCAL history when the
// on-screen timeline is shorter than this — NOT only when the pane is fully
// empty (that path is the blankSelfHealRef effect). Covers reopens that restored
// a truncated / half-loaded timeline where the HTTP backfill is gated,
// cooled-down, or a no-op. A local IDB re-read is cheap and an idempotent merge.
const ACTIVE_LOCAL_RELOAD_MAX_EVENTS = 10;
const FORWARD_HISTORY_TIMEOUT_MS = 8_000;
const TIMELINE_HISTORY_CONTENT_TYPE_SET = new Set<string>(TIMELINE_HISTORY_CONTENT_TYPES);
const HTTP_BACKFILL_MODES = ['tail', 'manualLatestWindow'] as const;
type HttpBackfillMode = typeof HTTP_BACKFILL_MODES[number];
type HttpBackfillOpts = {
  cooldownMs?: number;
  phase?: 'bootstrap' | 'refresh';
  visible?: boolean;
  force?: boolean;
  mode?: HttpBackfillMode;
  _retryAttempt?: number;
};

function createHttpBackfillCountState(): Record<HttpBackfillMode, number> {
  return { tail: 0, manualLatestWindow: 0 };
}

function createHttpBackfillTimerState(): Record<HttpBackfillMode, ReturnType<typeof setTimeout> | null> {
  return { tail: null, manualLatestWindow: null };
}

function createHttpBackfillDueAtState(): Record<HttpBackfillMode, number> {
  return { tail: 0, manualLatestWindow: 0 };
}

function totalHttpBackfillInFlight(counts: Record<HttpBackfillMode, number>): number {
  return counts.tail + counts.manualLatestWindow;
}

function resetBackfillCooldowns(): void {
  lastHttpBackfillResponseAt.clear();
  // A genuine resume should let the watchdog probe immediately again.
  watchdogStateByCacheKey.clear();
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
    // Only clear cooldowns after a real background interval. Browser tab
    // peeks on desktop can fire hidden→visible repeatedly within seconds;
    // resetting the cooldown every time turns harmless focus churn into an
    // HTTP backfill on each tab switch.
    const hiddenStartedAt = hiddenAt;
    if (hiddenStartedAt !== null) {
      const hiddenMs = Date.now() - hiddenStartedAt;
      if (hiddenMs > RESUME_RESET_COOLDOWN_AFTER_MS) resetBackfillCooldowns();
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
const TIMELINE_SNAPSHOT_WRITE_DELAY_MS = 750;
// Streaming assistant.text deltas are NOT written to IDB per-tick (too frequent —
// see shouldPersistTimelineEvent). Instead, persist the LATEST streaming text to
// IDB once the stream has been QUIET for this long: each delta resets the timer
// ("一直更新不保存"), and after this idle gap we write once. This makes a turn
// that only ever produced streaming events (no final non-streaming one) durable
// in IDB, so a later page refresh restores it — not only the localStorage mat.
const STREAMING_IDLE_PERSIST_MS = 2000;
// Snapshot tail size matches MAX_MEMORY_EVENTS (300) so the synchronous
// first-paint seed approaches the same coverage as the IDB-restored cache.
// The previous 50-event cap meant 5/6 of a 300-event session disappeared
// after refresh until the async IDB load completed — visible on mobile as
// "本地缓存还是没有立即显示". 300 events of compact payload is on the order
// of 0.5–1 MB per session in localStorage; the per-origin 5 MB quota holds
// up to ~5 active sessions before the `try/catch` swallow at the bottom of
// `persistTimelineSnapshotTail` starts dropping writes. Dynamic LRU eviction
// is a follow-up (see Round 3 plan PR-5 §quota).
const MAX_PERSISTED_SNAPSHOT_EVENTS = 300;
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
// Server-side ack reliability already retried the daemon for ~48s before
// emitting ack_timeout. Give one short visible HTTP backfill chance to recover
// a persisted echo, then fail the optimistic bubble so the user has a retry
// exit instead of waiting for the generic 90s optimistic timer.
const ACK_TIMEOUT_BACKFILL_GRACE_MS = 1_500;

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
const pendingTimelineSnapshotTails = new Map<string, TimelineEvent[]>();
const pendingTimelineSnapshotTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastWrittenTimelineSnapshotTails = new Map<string, TimelineEvent[]>();

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
  scheduleTimelineSnapshotPersist(cacheKey, events);
  const listeners = cacheListeners.get(cacheKey);
  if (listeners) {
    for (const listener of listeners) listener(events);
  }
  pruneTimelineCache();
}

function scheduleBrowserFrame(callback: () => void): () => void {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    const id = window.requestAnimationFrame(() => callback());
    return () => window.cancelAnimationFrame(id);
  }
  const id = setTimeout(callback, 16);
  return () => clearTimeout(id);
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

/**
 * Reads the snapshot under `cacheKey`; if empty falls back to the bare
 * `sessionId` snapshot (written when `selectedServerId` hadn't resolved
 * yet). On a fallback hit, migrates the snapshot to the scoped key and
 * removes the raw one so the next read takes the fast path.
 */
function loadPersistedTimelineSnapshotWithFallback(
  cacheKey: string,
  rawSessionId: string | undefined,
): TimelineEvent[] {
  const scoped = loadPersistedTimelineSnapshot(cacheKey);
  if (scoped.length > 0) return scoped;
  if (!rawSessionId || rawSessionId === cacheKey) return scoped;
  const raw = loadPersistedTimelineSnapshot(rawSessionId);
  if (raw.length === 0) return scoped;
  // Best-effort migration: re-persist under the scoped key and clear the
  // raw entry. localStorage.setItem can throw on quota; if it does we
  // still return the raw events so the user sees them.
  try {
    localStorage.setItem(getTimelineSnapshotStorageKey(cacheKey), JSON.stringify(raw));
    localStorage.removeItem(getTimelineSnapshotStorageKey(rawSessionId));
  } catch {
    /* ignore — fallback read still surfaced the events */
  }
  return raw;
}

function getPersistableTimelineTail(
  events: TimelineEvent[],
  opts?: { includeStreaming?: boolean },
): TimelineEvent[] {
  const persistable = events.filter((event) => opts?.includeStreaming === true || shouldPersistTimelineEvent(event));
  return persistable.length > MAX_PERSISTED_SNAPSHOT_EVENTS
    ? persistable.slice(persistable.length - MAX_PERSISTED_SNAPSHOT_EVENTS)
    : persistable;
}

function areTimelineSnapshotTailsSame(left: TimelineEvent[] | undefined, right: TimelineEvent[]): boolean {
  if (!left) return false;
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function persistTimelineSnapshotTail(cacheKey: string, tail: TimelineEvent[]): void {
  try {
    if (tail.length === 0) {
      localStorage.removeItem(getTimelineSnapshotStorageKey(cacheKey));
      lastWrittenTimelineSnapshotTails.set(cacheKey, tail);
      return;
    }
    localStorage.setItem(getTimelineSnapshotStorageKey(cacheKey), JSON.stringify(tail));
    lastWrittenTimelineSnapshotTails.set(cacheKey, tail);
  } catch {
    // best-effort — quota / private mode / JSON encode failure all land here.
    // A follow-up should add quota-driven LRU eviction; for now we lose the
    // tail write on failure but never corrupt the on-disk snapshot.
  }
}

function flushTimelineSnapshotPersist(cacheKey: string): void {
  const pendingTail = pendingTimelineSnapshotTails.get(cacheKey);
  if (!pendingTail) return;
  pendingTimelineSnapshotTails.delete(cacheKey);
  const timer = pendingTimelineSnapshotTimers.get(cacheKey);
  if (timer) clearTimeout(timer);
  pendingTimelineSnapshotTimers.delete(cacheKey);
  persistTimelineSnapshotTail(cacheKey, pendingTail);
}

function flushPendingTimelineSnapshotWrites(): void {
  for (const cacheKey of [...pendingTimelineSnapshotTails.keys()]) {
    flushTimelineSnapshotPersist(cacheKey);
  }
}

function persistTimelineSnapshotsBeforeFreeze(): void {
  for (const [cacheKey, cachedEvents] of eventsCache.entries()) {
    const tail = getPersistableTimelineTail(cachedEvents, { includeStreaming: true });
    persistTimelineSnapshotTail(cacheKey, tail);
  }
}

function clearPendingTimelineSnapshotWrites(): void {
  for (const timer of pendingTimelineSnapshotTimers.values()) clearTimeout(timer);
  pendingTimelineSnapshotTimers.clear();
  pendingTimelineSnapshotTails.clear();
  lastWrittenTimelineSnapshotTails.clear();
}

function scheduleTimelineSnapshotPersist(cacheKey: string, events: TimelineEvent[]): void {
  const tail = getPersistableTimelineTail(events);
  const pendingTail = pendingTimelineSnapshotTails.get(cacheKey);
  if (areTimelineSnapshotTailsSame(pendingTail, tail)) return;
  if (!pendingTail && areTimelineSnapshotTailsSame(lastWrittenTimelineSnapshotTails.get(cacheKey), tail)) return;
  pendingTimelineSnapshotTails.set(cacheKey, tail);
  if (pendingTimelineSnapshotTimers.has(cacheKey)) return;
  pendingTimelineSnapshotTimers.set(cacheKey, setTimeout(() => {
    flushTimelineSnapshotPersist(cacheKey);
  }, TIMELINE_SNAPSHOT_WRITE_DELAY_MS));
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const flushSnapshotsBeforeFreeze = (): void => {
    flushPendingTimelineCacheIngests();
    flushPendingTimelineSnapshotWrites();
    // A full page refresh during an active transport turn otherwise loses the
    // latest assistant.text streaming payload: streaming ticks are intentionally
    // kept out of IDB, and the daemon history store only has the final event.
    // localStorage is the lightweight browser-local crash mat for refresh/pagehide.
    persistTimelineSnapshotsBeforeFreeze();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSnapshotsBeforeFreeze();
  });
  window.addEventListener('pagehide', flushSnapshotsBeforeFreeze);
  window.addEventListener('beforeunload', flushSnapshotsBeforeFreeze);
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
  // Per-event scope — do NOT trust events[0] as a batch invariant. After
  // snapshot/raw-fallback merges a batch can be a mix of raw + scoped events,
  // and keying off the first item would write the rest under the wrong key
  // (re-creating split-key orphans). Skip the clone only when ALL are scoped.
  if (events.every((event) => event.sessionId === cacheKey)) return events;
  return events.map((event) => (event.sessionId === cacheKey ? event : { ...event, sessionId: cacheKey }));
}

function persistTimelineEvents(cacheKey: string, events: TimelineEvent[]): void {
  if (events.length === 0) return;
  const persistable = events.filter(shouldPersistTimelineEvent);
  if (persistable.length === 0) return;
  sharedDb.putEvents(scopeEventsForDb(cacheKey, persistable)).catch(() => {});
}

// Persist events to IDB WITHOUT the streaming filter — used only by the
// streaming idle-flush so the latest streaming assistant.text becomes durable.
function persistTimelineEventsIncludingStreaming(cacheKey: string, events: TimelineEvent[]): void {
  if (events.length === 0) return;
  sharedDb.putEvents(scopeEventsForDb(cacheKey, events)).catch(() => {});
}

function shouldPersistTimelineEvent(event: TimelineEvent): boolean {
  // Streaming/typewriter deltas can arrive many times per second for the same
  // eventId. They are already represented in the in-memory UI cache and the
  // final non-streaming event is persisted, so writing every intermediate
  // token to IndexedDB just builds a transaction backlog on busy chats.
  return event.payload?.streaming !== true;
}

function shouldFrameCoalesceTimelineEvent(event: TimelineEvent): boolean {
  return (event.type === 'assistant.text' && event.payload?.streaming === true)
    || event.type === 'tool.call'
    || event.type === 'tool.result';
}

const pendingTimelineCacheIngests = new Map<string, Map<string, TimelineEvent>>();
let pendingTimelineCacheIngestCancel: (() => void) | null = null;

function flushPendingTimelineCacheIngests(): void {
  if (pendingTimelineCacheIngestCancel) {
    const cancel = pendingTimelineCacheIngestCancel;
    pendingTimelineCacheIngestCancel = null;
    cancel();
  }
  if (pendingTimelineCacheIngests.size === 0) return;
  const batches = [...pendingTimelineCacheIngests.entries()];
  pendingTimelineCacheIngests.clear();
  for (const [cacheKey, byEventId] of batches) {
    const incoming = [...byEventId.values()];
    if (incoming.length === 0) continue;
    const existing = getCachedEvents(cacheKey) ?? [];
    const merged = mergeTimelineEvents(existing, incoming, MAX_MEMORY_EVENTS);
    if (merged !== existing) setCachedEvents(cacheKey, merged);
    persistTimelineEvents(cacheKey, incoming);
  }
}

function queueTimelineCacheIngest(cacheKey: string, event: TimelineEvent): void {
  let bucket = pendingTimelineCacheIngests.get(cacheKey);
  if (!bucket) {
    bucket = new Map();
    pendingTimelineCacheIngests.set(cacheKey, bucket);
  }
  const existing = bucket.get(event.eventId);
  bucket.set(event.eventId, existing ? preferTimelineEvent(existing, event) : event);
  if (pendingTimelineCacheIngestCancel) return;
  pendingTimelineCacheIngestCancel = scheduleBrowserFrame(() => {
    pendingTimelineCacheIngestCancel = null;
    flushPendingTimelineCacheIngests();
  });
}

function dropPendingTimelineCacheIngest(cacheKey: string, eventId: string): void {
  const bucket = pendingTimelineCacheIngests.get(cacheKey);
  if (!bucket) return;
  bucket.delete(eventId);
  if (bucket.size === 0) pendingTimelineCacheIngests.delete(cacheKey);
}

function cancelPendingTimelineCacheIngests(): void {
  pendingTimelineCacheIngestCancel?.();
  pendingTimelineCacheIngestCancel = null;
  pendingTimelineCacheIngests.clear();
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

/**
 * Read a session's recent local history, falling back to the bare-sessionId key
 * when the serverId-scoped key is empty (scope drift / PR-4), and consolidating
 * the orphaned bare-key rows into the scoped key via `migrateRawToScoped`
 * (idempotent, NO delete — the prior impl deleted what it migrated). Shared by
 * the bootstrap load and the ↻ local reload so the read logic lives in one
 * place.
 *
 * Existence is determined by the actual events read (`getRecentEvents`), NOT by
 * `getLastSeqAndEpoch` — the two use different indexes (`session_ts` vs
 * `session_epoch_seq`), so a null cursor must never be treated as "no history".
 * The cursor is best-effort (index lookup, else derived from the read events).
 *
 * Phase 1 of local restore. Returns `rawAlreadyRead` so the caller knows
 * whether the bare key was already consumed here (the scoped-empty fallback);
 * a non-empty-scoped session still triggers a phase-2 raw merge that heals a
 * SPLIT across both keys (see `readRawSegment` / `mergeRawSegmentLater`).
 */
async function readLocalTimelineMerged(
  db: TimelineDB,
  cacheKey: string,
  rawSessionId: string | undefined,
  limit: number,
): Promise<{ stored: TimelineEvent[]; cursor: { epoch: number; seq: number } | null; rawAlreadyRead: boolean }> {
  let stored = await db.getRecentEvents(cacheKey, { limit });
  let rawAlreadyRead = false;
  if (stored.length === 0 && rawSessionId) {
    rawAlreadyRead = true;
    const rawStored = await db.getRecentEvents(rawSessionId, { limit });
    if (rawStored.length > 0) {
      stored = rawStored.map((event) => (
        event.sessionId === cacheKey ? event : { ...event, sessionId: cacheKey }
      ));
      // Consolidate the orphaned bare-key rows into the scoped key. Idempotent,
      // no delete (see migrateRawToScoped — the old delete destroyed history).
      db.migrateRawToScoped(rawSessionId, cacheKey, rawStored).catch(() => { /* best-effort */ });
    }
  }
  // Cursor: prefer the explicit index lookup; else derive from the read events.
  let cursor: { epoch: number; seq: number } | null = await db.getLastSeqAndEpoch(cacheKey);
  if (!cursor && rawSessionId) cursor = await db.getLastSeqAndEpoch(rawSessionId);
  if (!cursor) cursor = deriveLocalCursor(stored);
  return { stored, cursor, rawAlreadyRead };
}

/** Best-effort cursor (max epoch/seq) derived from a set of events. */
function deriveLocalCursor(events: TimelineEvent[]): { epoch: number; seq: number } | null {
  if (events.length === 0) return null;
  let epoch = 0;
  let seq = 0;
  for (const event of events) {
    if (event.epoch > epoch) epoch = event.epoch;
    if (event.seq > seq) seq = event.seq;
  }
  return { epoch, seq };
}

/** Pick the higher of two cursors (epoch, then seq); either may be null. */
function maxLocalCursor(
  a: { epoch: number; seq: number } | null,
  b: { epoch: number; seq: number } | null,
): { epoch: number; seq: number } | null {
  if (!a) return b;
  if (!b) return a;
  return (b.epoch > a.epoch || (b.epoch === a.epoch && b.seq > a.seq)) ? b : a;
}

/**
 * Phase 2 of local restore (split-key heal): read the bare-sessionId key,
 * restamp to the scoped key, and report events + cursor so the caller can
 * idempotently merge them. Used only when phase 1's scoped read was non-empty
 * (a session whose history is split across both keys). Read on its own so the
 * caller can run it fire-and-forget — it must never block the scoped first paint.
 */
async function readRawSegment(
  db: TimelineDB,
  rawSessionId: string,
  cacheKey: string,
  limit: number,
): Promise<{ rawStored: TimelineEvent[]; rawRestamped: TimelineEvent[]; cursor: { epoch: number; seq: number } | null }> {
  const rawStored = await db.getRecentEvents(rawSessionId, { limit });
  const rawRestamped = rawStored.map((event) => (
    event.sessionId === cacheKey ? event : { ...event, sessionId: cacheKey }
  ));
  return { rawStored, rawRestamped, cursor: deriveLocalCursor(rawRestamped) };
}

export function __getSharedTimelineBaseForTests(
  cacheKey: string | null | undefined,
  localEvents: TimelineEvent[],
  maxEvents = MAX_MEMORY_EVENTS,
): TimelineEvent[] {
  return getSharedTimelineBase(cacheKey, localEvents, maxEvents);
}

export function __resetTimelineCacheForTests(): void {
  cancelPendingTimelineCacheIngests();
  flushPendingTimelineSnapshotWrites();
  eventsCache.clear();
  eventsCacheAccess.clear();
  cacheListeners.clear();
  lastHttpBackfillResponseAt.clear();
  watchdogStateByCacheKey.clear();
}

export function __resetBackfillCooldownsForTests(): void {
  resetBackfillCooldowns();
}

export function __clearPersistedTimelineSnapshotsForTests(): void {
  clearPendingTimelineSnapshotWrites();
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

function isHistoryCursorEligibleEvent(ev: TimelineEvent): boolean {
  if (!TIMELINE_HISTORY_CONTENT_TYPE_SET.has(ev.type)) return false;
  // Pending optimistic bubbles carry `ts = Date.now()` from the client clock —
  // exclude them so a skewed client clock can't accidentally filter out
  // legitimately-missed server events.
  if (ev.type === 'user.message' && (ev as { payload?: { pending?: boolean } }).payload?.pending) return false;
  return true;
}

function getTimelineHistoryAfterTs(events: TimelineEvent[]): number | undefined {
  let maxTs: number | undefined;
  for (const ev of events) {
    if (!isHistoryCursorEligibleEvent(ev)) continue;
    if (typeof ev.ts === 'number' && (maxTs === undefined || ev.ts > maxTs)) maxTs = ev.ts;
  }
  if (maxTs === undefined) return undefined;
  return Math.max(0, maxTs - TIMELINE_HISTORY_AFTER_TS_OVERLAP_MS);
}

export function __getTimelineHistoryAfterTsForTests(events: TimelineEvent[]): number | undefined {
  return getTimelineHistoryAfterTs(events);
}

export function __getTimelineCacheKeysForTests(): string[] {
  return [...eventsCache.keys()];
}

export function __getTimelineCacheForTests(cacheKey: string): TimelineEvent[] | undefined {
  return eventsCache.get(cacheKey);
}

export function __setTimelineCacheForTests(cacheKey: string, events: TimelineEvent[]): void {
  setCachedEvents(cacheKey, events);
}

export function ingestTimelineEventForCache(event: TimelineEvent, serverId?: string | null): void {
  const cacheKey = scopeCacheKey(serverId, event.sessionId);
  if (shouldFrameCoalesceTimelineEvent(event)) {
    queueTimelineCacheIngest(cacheKey, event);
    return;
  }
  dropPendingTimelineCacheIngest(cacheKey, event.eventId);
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
  /** Explicit user-triggered sync for THIS session (the chat ↻ button):
   *  visible (shows the refreshing overlay), force (works even when this hook
   *  isn't the active session, e.g. a visible sub-session card/window), and
   *  no cooldown. Unlike the global `requestActiveTimelineRefresh`, this is
   *  per-session and surfaces visible feedback. */
  forceRefresh: () => void;
}

export interface UseTimelineOptions {
  /**
   * Only the active/visible timeline should trigger opportunistic HTTP
   * backfills. Inactive mounted timelines still stay warm via cache + WS
   * events, but they must not hammer `/timeline/history/full`.
   */
  isActiveSession?: boolean;
  /**
   * Resume-broadcast eligibility: when `true`, the hook participates in the
   * `ACTIVE_TIMELINE_REFRESH_EVENT` broadcast even if it isn't the active
   * session. Used by visible-but-not-focused sub-session cards / windows so
   * that a desktop with multiple open cards catches up on focus/visibility
   * resume (gated by the same 15s success-only `ACTIVE_REFRESH_COOLDOWN_MS`,
   * so multi-card resume is still rate-limited per session). Defaults to
   * `isActiveSession` for back-compat.
   */
  isVisible?: boolean;
  /**
   * Shell/script process sessions have no chat timeline. When disabled, the
   * hook stays idle and skips daemon/HTTP/text-tail history work entirely.
   */
  disableHistory?: boolean;
}

export type TimelineHistoryPhase = 'idle' | 'bootstrap' | 'refresh' | 'older';
export type TimelineHistoryStepState = 'pending' | 'running' | 'done' | 'skipped';
export type TimelineHistoryStepKey = 'cache' | 'textTail' | 'daemon' | 'http' | 'older';
export type TimelineHistoryResponseState = 'ok' | 'empty' | 'partial' | 'deferred' | 'canceled' | 'error' | 'detail';

export interface TimelineHistoryResponseNotice {
  state: TimelineHistoryResponseState;
  i18nKey: string;
  localizedMessage: string;
  recoverable: boolean;
  errorReason?: string;
  source?: string;
  payloadBytes?: number;
  payloadTruncated?: boolean;
  hasMore?: boolean;
  cursorReset?: boolean;
}

export interface TimelineHistoryStatus {
  phase: TimelineHistoryPhase;
  steps: Record<TimelineHistoryStepKey, TimelineHistoryStepState>;
  response: TimelineHistoryResponseNotice | null;
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
    response: null,
  };
}

function createBootstrapHistoryStatus(opts: {
  canDaemon: boolean;
  canHttp: boolean;
  /** True when mount-time seed already populated `events`; flips `cache` to 'done'. */
  cacheSeeded?: boolean;
}): TimelineHistoryStatus {
  return {
    phase: 'bootstrap',
    steps: {
      cache: opts.cacheSeeded ? 'done' : 'running',
      textTail: 'skipped',
      daemon: opts.canDaemon ? 'pending' : 'skipped',
      http: opts.canHttp ? 'pending' : 'skipped',
      older: 'skipped',
    },
    response: null,
  };
}

type TimelineProtocolServerMessage = Extract<
  ServerMessage,
  {
    type:
      | typeof TIMELINE_MESSAGES.HISTORY
      | typeof TIMELINE_MESSAGES.REPLAY
      | typeof TIMELINE_MESSAGES.PAGE
      | typeof TIMELINE_MESSAGES.DETAIL;
  }
>;

type TimelineEventsServerMessage = Extract<
  ServerMessage,
  {
    type:
      | typeof TIMELINE_MESSAGES.HISTORY
      | typeof TIMELINE_MESSAGES.REPLAY
      | typeof TIMELINE_MESSAGES.PAGE;
  }
>;

const TIMELINE_NOTICE_FALLBACKS: Record<string, string> = {
  'chat.timelineStatus.ok': 'History updated',
  'chat.timelineStatus.empty': 'No earlier timeline events',
  'chat.timelineStatus.partial': 'Timeline loaded partially',
  'chat.timelineStatus.deferred': 'Timeline is still being prepared',
  'chat.timelineStatus.canceled': 'Timeline request was canceled',
  'chat.timelineStatus.payloadTruncated': 'Timeline was shortened for faster loading',
  'chat.timelineStatus.cursorReset': 'Timeline position changed; refresh history',
  'chat.timelineStatus.queueFull': 'Timeline worker is busy',
  'chat.timelineStatus.deadlineExceeded': 'Timeline request timed out',
  'chat.timelineStatus.timeout': 'Timeline worker timed out',
  'chat.timelineStatus.unavailable': 'Timeline history is unavailable',
  'chat.timelineStatus.projectionUnavailable': 'Timeline index is unavailable',
  'chat.timelineStatus.malformedRequest': 'Timeline request was invalid',
  'chat.timelineStatus.internalError': 'Timeline history failed',
  'chat.timelineStatus.detailMissing': 'Timeline detail is no longer available',
  'chat.timelineStatus.detailExpired': 'Timeline detail expired',
  'chat.timelineStatus.detailUnauthorized': 'Timeline detail is unavailable for this session',
  'chat.timelineStatus.detailOversized': 'Timeline detail is too large',
  'chat.timelineStatus.detailMalformed': 'Timeline detail request was invalid',
  'chat.timelineStatus.detailEpochMismatch': 'Timeline detail expired after restart',
  'chat.timelineStatus.detailGenerationMismatch': 'Timeline detail expired after refresh',
  'chat.timelineStatus.detailHydrated': 'Timeline detail loaded',
  'chat.timelineStatus.pageCursorReset': 'Timeline page expired; refresh history',
  'chat.timelineStatus.pageMalformed': 'Timeline page request was invalid',
  'chat.timelineStatus.error': 'Timeline history failed',
};

function localizedTimelineNotice(key: string): string {
  const fallback = TIMELINE_NOTICE_FALLBACKS[key] ?? TIMELINE_NOTICE_FALLBACKS['chat.timelineStatus.error']!;
  const value = i18next.t(key, fallback);
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function getTimelineEvents(msg: TimelineProtocolServerMessage): TimelineEvent[] {
  return 'events' in msg && Array.isArray(msg.events) ? msg.events : [];
}

function hasExplicitTimelineOutcome(msg: TimelinePayloadMetadata): boolean {
  return msg.status !== undefined
    || msg.errorReason !== undefined
    || msg.payloadTruncated !== undefined
    || msg.cursorReset === true;
}

function getTimelineNoticeKey(msg: TimelinePayloadMetadata, state: TimelineHistoryResponseState): string {
  const reason = msg.errorReason;
  if (reason === TIMELINE_HISTORY_ERROR_REASONS.QUEUE_FULL) return 'chat.timelineStatus.queueFull';
  if (reason === TIMELINE_HISTORY_ERROR_REASONS.DEADLINE_EXCEEDED) return 'chat.timelineStatus.deadlineExceeded';
  if (reason === TIMELINE_HISTORY_ERROR_REASONS.REQUEST_CANCELED) return 'chat.timelineStatus.canceled';
  if (reason === TIMELINE_HISTORY_ERROR_REASONS.TIMEOUT) return 'chat.timelineStatus.timeout';
  if (
    reason === TIMELINE_HISTORY_ERROR_REASONS.UNAVAILABLE
    || reason === TIMELINE_HISTORY_ERROR_REASONS.CRASHED
    || reason === TIMELINE_HISTORY_ERROR_REASONS.SHUTDOWN
  ) return 'chat.timelineStatus.unavailable';
  if (reason === TIMELINE_HISTORY_ERROR_REASONS.PROJECTION_UNAVAILABLE) return 'chat.timelineStatus.projectionUnavailable';
  if (reason === TIMELINE_REQUEST_ERROR_REASONS.MALFORMED_REQUEST) return 'chat.timelineStatus.malformedRequest';
  if (reason === TIMELINE_DETAIL_ERROR_REASONS.MISSING) return 'chat.timelineStatus.detailMissing';
  if (reason === TIMELINE_DETAIL_ERROR_REASONS.EXPIRED) return 'chat.timelineStatus.detailExpired';
  if (reason === TIMELINE_DETAIL_ERROR_REASONS.UNAUTHORIZED) return 'chat.timelineStatus.detailUnauthorized';
  if (reason === TIMELINE_DETAIL_ERROR_REASONS.OVERSIZED) return 'chat.timelineStatus.detailOversized';
  if (reason === TIMELINE_DETAIL_ERROR_REASONS.MALFORMED) return 'chat.timelineStatus.detailMalformed';
  if (reason === TIMELINE_DETAIL_ERROR_REASONS.EPOCH_MISMATCH) return 'chat.timelineStatus.detailEpochMismatch';
  if (reason === TIMELINE_DETAIL_ERROR_REASONS.GENERATION_MISMATCH) return 'chat.timelineStatus.detailGenerationMismatch';
  if (reason === TIMELINE_PAGE_ERROR_REASONS.CURSOR_RESET) return 'chat.timelineStatus.pageCursorReset';
  if (reason === TIMELINE_PAGE_ERROR_REASONS.MALFORMED) return 'chat.timelineStatus.pageMalformed';
  if (reason === TIMELINE_HISTORY_ERROR_REASONS.INTERNAL_ERROR || reason === TIMELINE_DETAIL_ERROR_REASONS.INTERNAL_ERROR || reason === TIMELINE_PAGE_ERROR_REASONS.INTERNAL_ERROR) {
    return 'chat.timelineStatus.internalError';
  }
  if (state === 'deferred') return 'chat.timelineStatus.deferred';
  if (state === 'canceled') return 'chat.timelineStatus.canceled';
  if (msg.cursorReset) return 'chat.timelineStatus.cursorReset';
  if (msg.payloadTruncated) return 'chat.timelineStatus.payloadTruncated';
  if (state === 'detail') return 'chat.timelineStatus.detailHydrated';
  if (state === 'partial') return 'chat.timelineStatus.partial';
  if (state === 'empty') return 'chat.timelineStatus.empty';
  if (state === 'ok') return 'chat.timelineStatus.ok';
  return 'chat.timelineStatus.error';
}

function getTimelineResponseState(
  msg: TimelineProtocolServerMessage,
): TimelineHistoryResponseState {
  if (msg.status === TIMELINE_RESPONSE_STATUS.ERROR || msg.errorReason) return 'error';
  if (msg.status === TIMELINE_RESPONSE_STATUS.DEFERRED) return 'deferred';
  if (msg.status === TIMELINE_RESPONSE_STATUS.CANCELED) return 'canceled';
  if (msg.status === TIMELINE_RESPONSE_STATUS.PARTIAL || msg.payloadTruncated) return 'partial';
  if (msg.type === TIMELINE_MESSAGES.DETAIL) return 'detail';
  return getTimelineEvents(msg).length === 0 ? 'empty' : 'ok';
}

function createTimelineHistoryResponseNotice(msg: TimelineProtocolServerMessage): TimelineHistoryResponseNotice {
  const state = getTimelineResponseState(msg);
  const i18nKey = getTimelineNoticeKey(msg, state);
  return {
    state,
    i18nKey,
    localizedMessage: localizedTimelineNotice(i18nKey),
    recoverable: msg.recoverable === true,
    errorReason: msg.errorReason,
    source: typeof msg.source === 'string' ? msg.source : undefined,
    payloadBytes: msg.actualPayloadBytes ?? msg.payloadBytes,
    payloadTruncated: msg.payloadTruncated,
    hasMore: msg.hasMore,
    cursorReset: msg.cursorReset,
  };
}

function shouldRetryTimelineHistoryResponse(msg: TimelineEventsServerMessage, hasRenderedEvents: boolean): boolean {
  if (getTimelineEvents(msg).length > 0 || hasRenderedEvents) return false;
  if (msg.recoverable === true) return true;
  // Defense-in-depth: when the server is silent about `recoverable` (older
  // bridge/daemon that hasn't picked up the commit-42dfabec fix), fall back
  // to a shared allow-list of `errorReason`s that we know are transient
  // (queue_full, deadline_exceeded, timeout, unavailable). The allow-list
  // lives in `shared/timeline-history-errors.ts` so server and client agree.
  // We do NOT apply this when `recoverable === false` is explicit — that is
  // a positive "don't retry" signal from a server that has thought about it.
  if (msg.recoverable === undefined
    && msg.errorReason
    && isRecoverableTimelineRequestErrorReason(msg.errorReason)) return true;
  return !hasExplicitTimelineOutcome(msg);
}

function getOlderTimelineCursor(msg: TimelineEventsServerMessage): TimelineCursor | null {
  const cursor = msg.nextCursor;
  if (!cursor || typeof cursor !== 'object') return null;
  if (cursor.direction !== TIMELINE_CURSOR_DIRECTIONS.OLDER) return null;
  return typeof cursor.beforeTs === 'number' ? cursor : null;
}

function hasStructuredOlderPage(msg: TimelineEventsServerMessage): boolean {
  return msg.hasMore === true && getOlderTimelineCursor(msg) !== null;
}

function buildFallbackOlderCursor(events: readonly TimelineEvent[], epoch: number): TimelineCursor | null {
  let earliest: TimelineEvent | null = null;
  for (const event of events) {
    if (typeof event.ts !== 'number' || !Number.isFinite(event.ts)) continue;
    if (!earliest || event.ts < earliest.ts) earliest = event;
  }
  if (!earliest) return null;
  return {
    epoch: epoch > 0 ? epoch : earliest.epoch,
    beforeTs: earliest.ts,
    direction: TIMELINE_CURSOR_DIRECTIONS.OLDER,
  };
}

function supportsTimelineProtocol(ws: WsClient): boolean {
  const method = (ws as { supportsTimelineProtocolRevision?: (minRevision?: number) => boolean }).supportsTimelineProtocolRevision;
  return typeof method === 'function' && method.call(ws, TIMELINE_PROTOCOL_REVISION);
}

const TIMELINE_DETAIL_FIELD_PATH_SET = new Set<string>(TIMELINE_DETAIL_FIELD_PATHS);

function isTimelineRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isAllowedTimelineDetailFieldPath(fieldPath: unknown): fieldPath is TimelineDetailFieldPath {
  return typeof fieldPath === 'string'
    && TIMELINE_DETAIL_FIELD_PATH_SET.has(fieldPath)
    && !fieldPath.split('.').some((part) => part === '__proto__' || part === 'prototype' || part === 'constructor');
}

function detailRefsForEvent(event: TimelineEvent): Array<Record<string, unknown>> {
  const refs = [
    event.payload.detailRefs,
    (event as unknown as Record<string, unknown>).detailRefs,
  ];
  for (const refsValue of refs) {
    if (Array.isArray(refsValue)) return refsValue.filter((ref): ref is Record<string, unknown> => !!ref && typeof ref === 'object' && !Array.isArray(ref));
  }
  return [];
}

function timelineDetailValue(msg: Extract<TimelineProtocolServerMessage, { type: typeof TIMELINE_MESSAGES.DETAIL }>): unknown {
  if ('value' in msg) return msg.value;
  if ('content' in msg) return msg.content;
  if ('detail' in msg) return msg.detail;
  return undefined;
}

function hasMatchingDetailRef(
  event: TimelineEvent,
  msg: Extract<TimelineProtocolServerMessage, { type: typeof TIMELINE_MESSAGES.DETAIL }>,
  fieldPath: TimelineDetailFieldPath,
): boolean {
  const refs = detailRefsForEvent(event);
  if (refs.length === 0) return false;
  return refs.some((ref) => {
    if (typeof msg.detailId === 'string' && ref.detailId !== msg.detailId) return false;
    if (typeof ref.eventId === 'string' && ref.eventId !== event.eventId) return false;
    return ref.fieldPath === fieldPath;
  });
}

function withoutHydratedDetailRef(
  refsValue: unknown,
  msg: Extract<TimelineProtocolServerMessage, { type: typeof TIMELINE_MESSAGES.DETAIL }>,
  fieldPath: TimelineDetailFieldPath,
): unknown {
  if (!Array.isArray(refsValue)) return refsValue;
  return refsValue.filter((ref) => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return true;
    const record = ref as Record<string, unknown>;
    if (record.fieldPath !== fieldPath) return true;
    if (typeof msg.detailId === 'string' && record.detailId !== msg.detailId) return true;
    return false;
  });
}

function hydrateTimelineDetailEvent(
  events: TimelineEvent[],
  msg: Extract<TimelineProtocolServerMessage, { type: typeof TIMELINE_MESSAGES.DETAIL }>,
): TimelineEvent[] {
  if (msg.status !== TIMELINE_RESPONSE_STATUS.OK) return events;
  if (typeof msg.eventId !== 'string') return events;
  if (!isAllowedTimelineDetailFieldPath(msg.fieldPath)) return events;

  const idx = events.findIndex((event) => event.eventId === msg.eventId);
  if (idx < 0) return events;
  const existing = events[idx]!;
  if (msg.sessionName && existing.sessionId !== msg.sessionName) return events;
  if (!hasMatchingDetailRef(existing, msg, msg.fieldPath)) return events;

  const value = timelineDetailValue(msg);
  const payload: Record<string, unknown> = { ...existing.payload };
  if (msg.fieldPath === SHARED_TIMELINE_DETAIL_FIELD_PATHS.PAYLOAD_TEXT) payload.text = value;
  else if (msg.fieldPath === SHARED_TIMELINE_DETAIL_FIELD_PATHS.PAYLOAD_OUTPUT) payload.output = value;
  else if (msg.fieldPath === SHARED_TIMELINE_DETAIL_FIELD_PATHS.PAYLOAD_ERROR) payload.error = value;
  else if (msg.fieldPath === SHARED_TIMELINE_DETAIL_FIELD_PATHS.PAYLOAD_DETAIL_OUTPUT) {
    const detail = isTimelineRecord(payload.detail) ? { ...payload.detail } : {};
    detail.output = value;
    payload.detail = detail;
  } else {
    return events;
  }
  payload.completeness = 'hydrated';
  payload.detailRefs = withoutHydratedDetailRef(payload.detailRefs, msg, msg.fieldPath);
  if (Array.isArray(payload.detailRefs) && payload.detailRefs.length === 0) delete payload.detailRefs;

  const updatedEvent = { ...existing, payload };
  const next = [...events];
  next[idx] = preferTimelineEvent(existing, updatedEvent);
  return next[idx] === existing ? events : next;
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
  const isVisible = options?.isVisible ?? isActiveSession;
  const disableHistory = options?.disableHistory ?? false;
  const wsConnected = !!ws?.connected;
  const cacheKeyRef = useRef(cacheKey);
  cacheKeyRef.current = cacheKey;
  // ── Synchronous cache seed at first render ─────────────────────────────
  // The bootstrap effect that hits memCache / localStorage / IDB runs AFTER
  // the first paint, so a fresh `useTimeline` mount paints with `events=[]`
  // before the cache-hit `setEvents` lands. On mobile that "blank → flash
  // of messages" gap was visible enough that the user reported the local
  // cache as "not instant" even though it was hitting the snapshot.
  //
  // To collapse the gap we read the synchronous caches inside `useState`
  // initializers — they run exactly once per mount, before the first
  // render commits, so the first paint already shows whatever the memCache
  // (module-level) or the localStorage tail holds. Async sources (IDB,
  // daemon WS) are still surfaced by the bootstrap effect.
  const [events, setEvents] = useState<TimelineEvent[]>(() => {
    if (!cacheKey) return [];
    const memCached = getCachedEvents(cacheKey);
    if (memCached && memCached.length > 0) return memCached;
    // Fall back to the bare sessionId snapshot for rows written before
    // `selectedServerId` resolved on this page session — without this the
    // first paint after a refresh shows blank even when the snapshot is
    // present under the old key. PR-4 in .imc/discussions/e9dbc48c-dda.md.
    const rawSessionIdForFallback = sessionId && sessionId !== cacheKey ? sessionId : undefined;
    const persisted = loadPersistedTimelineSnapshotWithFallback(cacheKey, rawSessionIdForFallback);
    if (persisted.length === 0) return [];
    // Keep the localStorage snapshot exactly as written. During a manual page
    // refresh this may include the latest streaming assistant.text; that partial
    // local text is preferable to a blank/lost message and is replaced by the
    // final non-streaming event as soon as history/live sync catches up.
    return persisted;
  });
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const [hasOlderHistory, setHasOlderHistory] = useState(true);
  // Loading starts false when we already have a synchronous cache hit at
  // mount — otherwise the first paint shows messages but ChatView still
  // reads `loading=true` from the prop and would briefly render the spinner
  // over the freshly-seeded content. Start true only when we have nothing.
  const [loading, setLoading] = useState(() => events.length === 0);
  const [refreshing, setRefreshing] = useState(false);
  const [httpRefreshing, setHttpRefreshing] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // History status also reflects the synchronous seed: if cache had data,
  // mark the `cache` step done up front so the bootstrap overlay doesn't
  // briefly show "本地缓存…" alongside the just-painted messages.
  const [historyStatus, setHistoryStatus] = useState<TimelineHistoryStatus>(() => (
    events.length > 0
      ? createBootstrapHistoryStatus({
          canDaemon: !!ws?.connected,
          canHttp: false,
          cacheSeeded: true,
        })
      : createIdleHistoryStatus()
  ));
  const loadingOlderRef = useRef(false); // Synchronous guard against duplicate pagination requests
  const httpBackfillInFlightRef = useRef<Record<HttpBackfillMode, number>>(createHttpBackfillCountState());
  const httpBackfillTimerRef = useRef<Record<HttpBackfillMode, ReturnType<typeof setTimeout> | null>>(createHttpBackfillTimerState());
  const httpBackfillTimerDueAtRef = useRef<Record<HttpBackfillMode, number>>(createHttpBackfillDueAtState());
  const epochRef = useRef<number>(0);
  const seqRef = useRef<number>(0);
  const replayRequestIdRef = useRef<string | null>(null);
  const historyRequestIdRef = useRef<string | null>(null);
  const olderRequestIdRef = useRef<string | null>(null);
  const olderCursorRef = useRef<TimelineCursor | null>(null);
  const historyLoadedRef = useRef<string | null>(null); // tracks which session has been loaded
  const historyRetryRef = useRef(0); // retry count for empty history responses
  const historyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectRefreshInFlightRef = useRef(false);
  const lastReconnectRefreshAtRef = useRef(0);

  const updateHistoryStep = useCallback((
    step: TimelineHistoryStepKey,
    state: TimelineHistoryStepState,
    phase?: Exclude<TimelineHistoryPhase, 'idle'>,
  ) => {
    setHistoryStatus((prev) => ({
      ...prev,
      phase: phase ?? prev.phase,
      steps: {
        ...prev.steps,
        [step]: state,
      },
    }));
  }, []);

  const recordTimelineResponse = useCallback((
    msg: TimelineProtocolServerMessage,
    phase?: Exclude<TimelineHistoryPhase, 'idle'>,
  ) => {
    const response = createTimelineHistoryResponseNotice(msg);
    setHistoryStatus((prev) => ({
      ...prev,
      phase: phase ?? prev.phase,
      response,
    }));
  }, []);

  const clearForwardHistoryTimeout = useCallback(() => {
    if (!historyTimeoutRef.current) return;
    clearTimeout(historyTimeoutRef.current);
    historyTimeoutRef.current = null;
  }, []);

  const armForwardHistoryTimeout = useCallback((requestId: string, phase: Exclude<TimelineHistoryPhase, 'idle'>) => {
    clearForwardHistoryTimeout();
    historyTimeoutRef.current = setTimeout(() => {
      if (historyRequestIdRef.current !== requestId) return;
      historyRequestIdRef.current = null;
      reconnectRefreshInFlightRef.current = false;
      updateHistoryStep('daemon', 'done', phase);
      setRefreshing(false);
    }, FORWARD_HISTORY_TIMEOUT_MS);
  }, [clearForwardHistoryTimeout, updateHistoryStep]);

  const sendForwardHistoryRequest = useCallback((
    phase: Exclude<TimelineHistoryPhase, 'idle'>,
    args?: { limit?: number; afterTs?: number },
  ) => {
    if (!ws || !sessionId) return null;
    const requestId = args?.limit === undefined && args?.afterTs === undefined
      ? ws.sendTimelineHistoryRequest(sessionId)
      : args?.afterTs === undefined
        ? ws.sendTimelineHistoryRequest(sessionId, args?.limit ?? MAX_MEMORY_EVENTS)
        : ws.sendTimelineHistoryRequest(sessionId, args.limit ?? MAX_MEMORY_EVENTS, args.afterTs);
    historyRequestIdRef.current = requestId;
    armForwardHistoryTimeout(requestId, phase);
    return requestId;
  }, [armForwardHistoryTimeout, sessionId, ws]);

  const buildForwardHistoryArgs = useCallback((
    limit?: number,
    sourceEvents: TimelineEvent[] = eventsRef.current,
  ): { limit?: number; afterTs?: number } | undefined => {
    const afterTs = getTimelineHistoryAfterTs(sourceEvents);
    if (afterTs !== undefined) {
      return { limit: limit ?? MAX_MEMORY_EVENTS, afterTs };
    }
    return limit === undefined ? undefined : { limit };
  }, []);

  const beginReconnectRefresh = useCallback((source: 'daemon' | 'browser') => {
    const now = Date.now();
    if (reconnectRefreshInFlightRef.current) {
      backfillDebug('reconnect refresh: already in flight', { sessionId, source });
      return false;
    }
    if (now - lastReconnectRefreshAtRef.current < RECONNECT_REFRESH_COOLDOWN_MS) {
      backfillDebug('reconnect refresh: cooldown skip', { sessionId, source });
      return false;
    }
    reconnectRefreshInFlightRef.current = true;
    lastReconnectRefreshAtRef.current = now;
    return true;
  }, [sessionId]);

  const clearHttpBackfillTimer = useCallback((mode?: HttpBackfillMode) => {
    const modes = mode ? [mode] : HTTP_BACKFILL_MODES;
    for (const currentMode of modes) {
      const timer = httpBackfillTimerRef.current[currentMode];
      if (!timer) continue;
      clearTimeout(timer);
      httpBackfillTimerRef.current[currentMode] = null;
      httpBackfillTimerDueAtRef.current[currentMode] = 0;
    }
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
      httpBackfillInFlightRef.current = createHttpBackfillCountState();
      clearHttpBackfillTimer();
      clearForwardHistoryTimeout();
      historyRequestIdRef.current = null;
      reconnectRefreshInFlightRef.current = false;
      olderCursorRef.current = null;
      resetOlderState();
      return;
    }
    if (disableHistory) {
      setEvents([]);
      setLoading(false);
      setRefreshing(false);
      setHttpRefreshing(false);
      setHistoryStatus(createIdleHistoryStatus());
      httpBackfillInFlightRef.current = createHttpBackfillCountState();
      clearHttpBackfillTimer();
      clearForwardHistoryTimeout();
      historyRequestIdRef.current = null;
      reconnectRefreshInFlightRef.current = false;
      olderCursorRef.current = null;
      resetOlderState();
      setHasOlderHistory(false);
      historyLoadedRef.current = cacheKeyRef.current;
      return;
    }

    setRefreshing(false);
    setHttpRefreshing(false);
    // If the synchronous mount-time seed already populated `events`, mark
    // the cache step done immediately so the bootstrap overlay never flashes
    // "本地缓存…" alongside the just-painted messages.
    setHistoryStatus(createBootstrapHistoryStatus({
      canDaemon: wsConnected,
      canHttp: false,
      cacheSeeded: eventsRef.current.length > 0,
    }));
    httpBackfillInFlightRef.current = createHttpBackfillCountState();
    clearHttpBackfillTimer();
    clearForwardHistoryTimeout();
    historyRequestIdRef.current = null;
    reconnectRefreshInFlightRef.current = false;
    olderCursorRef.current = null;
    resetOlderState();
    setHasOlderHistory(true);

    let cancelled = false;

    const markDaemonHistoryBackground = (): void => {
      updateHistoryStep('daemon', 'done', 'bootstrap');
      setRefreshing(false);
    };

    const requestDaemonHistory = (visible: boolean, limit?: number, sourceEvents?: TimelineEvent[], force = false): void => {
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
      // EXCEPTION: when local cache is completely empty (cold IDB branch
      // below), inactive sessions MUST be allowed exactly one history
      // request — otherwise the user sees a permanently blank pane for any
      // sub-session they haven't opened on this browser before, with no
      // way to recover until they focus it. The cold branch passes
      // `force=true` for this one-shot.
      //
      // When the user later activates the card, this effect re-runs (the
      // mount-effect dep array includes `isActiveSession`) and the gate
      // passes — at which point the bootstrap path issues its history
      // request as normal.
      if (!isActiveSessionRef.current && !force) {
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
      sendForwardHistoryRequest('bootstrap', buildForwardHistoryArgs(limit, sourceEvents));
    };

    // 1. Module-level memory cache — instant restore (e.g. window reopen)
    const memCached = getCachedEvents(cacheKey!);
    if (memCached && memCached.length > 0) {
      updateHistoryStep('cache', 'done', 'bootstrap');
      setEvents(memCached);
      setLoading(false);
      requestDaemonHistory(false, MAX_MEMORY_EVENTS, memCached);
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
    // Use the fallback variant so cacheKey-scope shifts (early-mount
    // serverId resolution) still surface the prior snapshot.
    const rawSessionIdForFallback = sessionId && sessionId !== cacheKey ? sessionId : undefined;
    // Keep the snapshot exactly as written (including a latest streaming text
    // saved during pagehide). Do NOT write this snapshot to the
    // GLOBAL eventsCache: a tail snapshot is low-completeness, and writing it
    // would let path1's `memCached.length>0` short-circuit skip the fuller IDB
    // read on a later effect re-run (run 016f9b5b-c8f M3/B3). It is only this
    // hook's first-paint seed; the global cache is written by IDB/daemon/HTTP.
    const localSnapshot = loadPersistedTimelineSnapshotWithFallback(cacheKey!, rawSessionIdForFallback);
    if (localSnapshot.length > 0) {
      updateHistoryStep('cache', 'done', 'bootstrap');
      setEvents((prev) => (prev === localSnapshot ? prev : localSnapshot));
      setLoading(false);
      requestDaemonHistory(false, MAX_MEMORY_EVENTS, localSnapshot);
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
    // Active session ("the open window") loads IDB immediately. Inactive
    // useTimeline instances (SubSessionCard previews in the bar, hidden
    // SubSessionWindow tabs, etc.) stagger by ~80ms so the active session
    // can grab IDB transactions first, but they still load reliably.
    //
    // History: `90cd30ec` deferred inactive loads to `requestIdleCallback`
    // with a 500ms fallback timeout — and cancelled the pending handle in
    // the effect cleanup. Two problems showed up in production where
    // many non-visible chat windows never loaded their history:
    //   1. `requestIdleCallback` can be starved indefinitely under render
    //      churn / busy main thread on real devices; the 500ms `timeout`
    //      fallback didn't always kick in either.
    //   2. The effect's dep array (ws, wsConnected, callback identities)
    //      churns; every churn ran the cleanup which cancelled the
    //      pending idle handle and scheduled a fresh one — repeat → the
    //      inactive timer never resolved.
    //
    // Fix: stagger with a plain `setTimeout(80)` and DON'T cancel it on
    // cleanup. The `cancelled` guard inside `load()` already handles
    // staleness, so a quick dep churn just queues a (harmless) extra
    // `load()` whose old closure exits on `cancelled === true` before
    // it can touch state.
    const load = async () => {
      const db = sharedDb;
      if (!db) return;
      // Dual-read scoped + bare keys and merge (history can be split across keys
      // when serverId resolved mid-session), status-aware so a read FAILURE is
      // never mistaken for "no history". `ensureOpen` is awaited inside the
      // read methods. See run 016f9b5b-c8f (split-key + fail-safe).
      const rawSessionIdForFallback = sessionId && sessionId !== cacheKey ? sessionId : undefined;
      const { stored, cursor, rawAlreadyRead } = await readLocalTimelineMerged(
        db, cacheKey!, rawSessionIdForFallback, MAX_MEMORY_EVENTS,
      );
      if (cancelled) return;
      if (cursor) {
        epochRef.current = cursor.epoch;
        seqRef.current = cursor.seq;
      } else {
        epochRef.current = 0;
        seqRef.current = 0;
      }
      updateHistoryStep('cache', 'done', 'bootstrap');
      if (stored.length > 0) {
        const existing = getSharedTimelineBase(cacheKey!, eventsRef.current, MAX_MEMORY_EVENTS);
        const restored = mergeTimelineEvents(existing, stored, MAX_MEMORY_EVENTS);
        setCachedEvents(cacheKey!, restored);
        setEvents((prev) => (prev === restored ? prev : restored));
        setLoading(false);
        historyLoadedRef.current = cacheKeyRef.current;
        requestDaemonHistory(false, MAX_MEMORY_EVENTS, restored);
        // Background HTTP backfill — IDB is authoritative only up to the last
        // WS event; reopening after a mid-chat close may leave a gap.
        if (isActiveSession) {
          fireHttpBackfillRef.current(200, { cooldownMs: MOUNT_BACKFILL_COOLDOWN_MS, phase: 'bootstrap' });
        }
        // Phase 2 (split-key heal): scoped had data, but the bare key may ALSO
        // hold a segment (serverId resolved mid-session). Merge it in the
        // background — fire-and-forget so it never blocks the scoped first paint.
        if (rawSessionIdForFallback && !rawAlreadyRead) {
          mergeRawSegmentLaterRef.current(db, rawSessionIdForFallback, cacheKey!);
        }
      } else {
        // Empty local read — a genuine cold start OR a transient IDB read
        // failure (both surface as empty here). FAIL-SAFE: do NOT wipe an
        // already-shown seed. The previous code did
        // `setEvents(prev => prev.filter(isLocalOptimisticUserMessage))` here,
        // which is exactly what turned a seeded/snapshot-painted pane blank when
        // the scoped read missed (split-key) or the open transiently failed.
        // We keep the seed, ask the daemon (visible if active) + HTTP to fill
        // in (authoritative history reconciles by eventId), and leave
        // `historyLoadedRef` unset so a dep-churn re-run / ↻ / the IDB-open
        // backoff retry can re-read the local store if data appears.
        if (isActiveSession && wsConnected) {
          requestDaemonHistory(true);
        } else {
          setLoading(false);
        }
        if (isActiveSession) {
          // IDB came back EMPTY. If a low-completeness seed (localStorage tail
          // snapshot / WS replay tail) is already painted, a tail-mode backfill
          // would anchor afterTs at the seed's newest ts and never fetch the
          // bulk history BELOW it — the "open the chat and only the latest few
          // messages show; force-refresh fixes it" bug. With no IDB backing that
          // seed is definitionally truncated, so pull the full newest window (no
          // lower bound), exactly like forceRefresh's manualLatestWindow. A truly
          // blank pane (no seed) keeps the tail path — afterTs=undefined there
          // already fetches the full window — and is additionally covered by the
          // blank-pane self-heal effect.
          const truncatedSeedShowing = eventsRef.current.length > 0;
          fireHttpBackfillRef.current(200, truncatedSeedShowing
            ? { cooldownMs: 0, phase: 'bootstrap', mode: 'manualLatestWindow' }
            : { cooldownMs: 0, phase: 'bootstrap' });
        }
      }
    };
    if (isActiveSession) {
      // Active session: race straight to IDB so the open window paints with
      // full local history ASAP.
      load().catch(() => {});
    } else {
      // Inactive: short stagger so the active session's IDB read can kick
      // off first. We intentionally do NOT save a handle to cancel on
      // cleanup — see the long comment above for why cancelling here
      // would let dep churn starve background sessions forever.
      setTimeout(() => { if (!cancelled) load().catch(() => {}); }, 80);
    }
    return () => { cancelled = true; };
  }, [buildForwardHistoryArgs, cacheKey, clearForwardHistoryTimeout, clearHttpBackfillTimer, disableHistory, isActiveSession, sendForwardHistoryRequest, sessionId, ws, wsConnected]);

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
      // N-R2 fix (audit 0419d1ac-1f4) — settle commandId only after
      // SUCCESSFULLY flipping the bubble to failed. This pairs with
      // `markOptimisticAccepted`'s new top-of-function settle guard:
      // once terminal-failed, a late `accepted` receipt must NOT revive
      // the bubble. Without this `rememberSettledCommandId` call here
      // (the previous code only settled on the confirmed-echo path at
      // line 962), an error→accepted sequence would leave the bubble
      // as `acked: true, failed: false` — the inverse of bug 1.
      rememberSettledCommandId(commandId);
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

  const markOptimisticAccepted = useCallback((commandId: string, options?: { clearPending?: boolean }) => {
    if (!commandId) return;
    // N-R2 fix (audit 0419d1ac-1f4 / O2 选项 D) — `accepted` is a daemon-
    // receipt ack ("I got your command"), NOT a terminal outcome. Two
    // sub-changes make the dual-ack pattern correct:
    //
    //   1. Skip if the commandId is ALREADY terminal-settled (i.e. an
    //      `error` / `conflict` ack arrived first). A late `accepted`
    //      receipt must not reset a previously-failed bubble back to
    //      acked. Without this guard the order error→accepted would
    //      revive a failed bubble.
    //
    //   2. Don't add this commandId to `settledCommandIdsRef`. Without
    //      this change a subsequent `error` ack was silently swallowed
    //      by `markOptimisticFailed`'s `settledCommandIdsRef.has()`
    //      short-circuit (line ~941) — bug 1 manifested as "message
    //      bypasses queue / shows as sent" even though the daemon
    //      refused it via the F4 record-missing path.
    //
    // Together these make terminal acks (error / conflict / confirmed
    // echo) the only path that writes to `settledCommandIdsRef` — the
    // intended terminal-state semantic.
    if (settledCommandIdsRef.current.has(commandId)) return;
    const eventId = optimisticIdsByCommandRef.current.get(commandId);
    clearOptimisticTimer(commandId);
    clearAutoRetryState(commandId);
    if (!eventId) return;
    setEvents((prev) => {
      const base = getSharedTimelineBase(cacheKeyRef.current, prev, MAX_MEMORY_EVENTS);
      const idx = base.findIndex((e) => e.eventId === eventId);
      if (idx < 0) return base;
      const existing = base[idx]!;
      const payload: Record<string, unknown> = {
        ...existing.payload,
        pending: options?.clearPending === true ? false : true,
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
      markOptimisticAccepted(commandId, { clearPending: true });
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
    if (commandId) {
      // A browser may miss the immediate command.ack/user.message while the
      // socket is resubscribing (most visible on sub-session windows). The
      // message may already be running, so do one cheap tail catch-up instead
      // of letting the local bubble spin until the 90s safety timeout.
      fireHttpBackfillRef.current(1200, {
        phase: 'refresh',
        cooldownMs: 1500,
      });
    }
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
    if (!supportsTimelineProtocol(ws)) return;
    const key = cacheKeyRef.current;
    const cached = key ? getCachedEvents(key) : undefined;
    if (!cached || cached.length === 0) return;
    const cursor = olderCursorRef.current ?? buildFallbackOlderCursor(cached, epochRef.current);
    if (!cursor) return;
    olderCursorRef.current = cursor;
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
      response: null,
    });
    setLoadingOlder(true);
    olderRequestIdRef.current = ws.sendTimelinePageRequest(sessionId, cursor, MAX_MEMORY_EVENTS);
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

  // Phase-2 split-key heal: read the bare-sessionId segment in the background
  // and idempotently merge it (raw → restamped → mergeEvents). Fire-and-forget
  // so it NEVER blocks the scoped first paint (this is also why the dual read
  // survives single-promise test mocks). Only invoked when phase 1's scoped read
  // was non-empty (a session split across both keys). Bumps the cursor to the
  // higher of the two segments and consolidates the bare rows into scoped.
  const mergeRawSegmentLater = useCallback((db: TimelineDB, rawSessionId: string, key: string) => {
    void readRawSegment(db, rawSessionId, key, MAX_MEMORY_EVENTS).then((raw) => {
      if (cacheKeyRef.current !== key || raw.rawStored.length === 0) return;
      mergeEvents(raw.rawRestamped);
      const bumped = maxLocalCursor({ epoch: epochRef.current, seq: seqRef.current }, raw.cursor);
      if (bumped) { epochRef.current = bumped.epoch; seqRef.current = bumped.seq; }
      setLoading(false);
      db.migrateRawToScoped(rawSessionId, key, raw.rawStored).catch(() => { /* best-effort */ });
    }).catch(() => { /* best-effort */ });
  }, [mergeEvents]);
  const mergeRawSegmentLaterRef = useRef(mergeRawSegmentLater);
  mergeRawSegmentLaterRef.current = mergeRawSegmentLater;

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
    const persistable = evts.filter(shouldPersistTimelineEvent);
    if (persistable.length === 0) return;
    const cached = getCachedEvents(key) ?? eventsRef.current;
    const cachedById = new Map(cached.map((event) => [event.eventId, event]));
    const preferred = persistable.map((event) => {
      const existing = cachedById.get(event.eventId);
      return existing ? preferTimelineEvent(existing, event) : event;
    });
    persistTimelineEvents(key, preferred);
  }, []);

  const pendingRealtimeEventsRef = useRef(new Map<string, TimelineEvent>());
  const pendingRealtimeFlushCancelRef = useRef<(() => void) | null>(null);

  const flushPendingRealtimeEvents = useCallback(() => {
    pendingRealtimeFlushCancelRef.current = null;
    const incoming = [...pendingRealtimeEventsRef.current.values()];
    pendingRealtimeEventsRef.current.clear();
    if (incoming.length === 0) return;
    mergeEvents(incoming);
    idbPutEvents(incoming);
  }, [idbPutEvents, mergeEvents]);

  // ── Streaming idle-persist ──────────────────────────────────────────────
  // Debounced IDB write for streaming assistant.text: each delta resets the
  // timer; once the stream is idle for STREAMING_IDLE_PERSIST_MS we persist the
  // LATEST text of every pending eventId. Reads from the per-key cache (not
  // `eventsRef`) so a session switch mid-stream still writes the right session.
  const streamingIdlePersistIdsRef = useRef(new Set<string>());
  const streamingIdlePersistKeyRef = useRef<string | null>(null);
  const streamingIdlePersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushStreamingIdlePersist = useCallback(() => {
    if (streamingIdlePersistTimerRef.current) {
      clearTimeout(streamingIdlePersistTimerRef.current);
      streamingIdlePersistTimerRef.current = null;
    }
    const key = streamingIdlePersistKeyRef.current;
    const ids = streamingIdlePersistIdsRef.current;
    streamingIdlePersistIdsRef.current = new Set();
    streamingIdlePersistKeyRef.current = null;
    if (!key || ids.size === 0) return;
    const cached = getCachedEvents(key) ?? eventsRef.current;
    const byId = new Map(cached.map((event) => [event.eventId, event]));
    const toPersist: TimelineEvent[] = [];
    for (const id of ids) {
      const event = byId.get(id);
      if (event) toPersist.push(event); // whatever the latest is (streaming or final)
    }
    if (toPersist.length > 0) persistTimelineEventsIncludingStreaming(key, toPersist);
  }, []);
  const scheduleStreamingIdlePersist = useCallback((eventId: string) => {
    const key = cacheKeyRef.current;
    if (!key) return;
    // Session changed mid-stream → flush the previous session's pending first.
    if (streamingIdlePersistKeyRef.current && streamingIdlePersistKeyRef.current !== key) {
      flushStreamingIdlePersist();
    }
    streamingIdlePersistKeyRef.current = key;
    streamingIdlePersistIdsRef.current.add(eventId);
    if (streamingIdlePersistTimerRef.current) clearTimeout(streamingIdlePersistTimerRef.current);
    streamingIdlePersistTimerRef.current = setTimeout(flushStreamingIdlePersist, STREAMING_IDLE_PERSIST_MS);
  }, [flushStreamingIdlePersist]);

  const appendRealtimeEvent = useCallback((event: TimelineEvent) => {
    if (!shouldFrameCoalesceTimelineEvent(event)) {
      pendingRealtimeEventsRef.current.delete(event.eventId);
      // A final (non-streaming) version arrived — idbPutEvents persists it below,
      // so drop any pending idle-persist for this id.
      streamingIdlePersistIdsRef.current.delete(event.eventId);
      appendEvent(event);
      idbPutEvents([event]);
      return;
    }
    // Streaming assistant.text isn't written per-tick; (re)arm the idle-persist
    // debounce so the latest text lands in IDB once the stream goes quiet.
    if (event.type === 'assistant.text' && event.payload?.streaming === true) {
      scheduleStreamingIdlePersist(event.eventId);
    }
    const existing = pendingRealtimeEventsRef.current.get(event.eventId);
    pendingRealtimeEventsRef.current.set(event.eventId, existing ? preferTimelineEvent(existing, event) : event);
    if (pendingRealtimeFlushCancelRef.current) return;
    pendingRealtimeFlushCancelRef.current = scheduleBrowserFrame(flushPendingRealtimeEvents);
  }, [appendEvent, flushPendingRealtimeEvents, idbPutEvents, scheduleStreamingIdlePersist]);

  useEffect(() => () => {
    pendingRealtimeFlushCancelRef.current?.();
    pendingRealtimeFlushCancelRef.current = null;
    pendingRealtimeEventsRef.current.clear();
    flushStreamingIdlePersist();
  }, [flushStreamingIdlePersist]);

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
  const isVisibleRef = useRef(isVisible);
  isVisibleRef.current = isVisible;
  // Wall-clock of the last inbound live `timeline.event` for THIS session.
  // The foreground watchdog uses it (together with the last verified backfill)
  // to detect a silently-stalled stream — a live event the WS never delivered
  // with no error/reconnect/focus signal to re-trigger a catch-up.
  const lastTimelineEventAtRef = useRef(0);

  // Retry schedule for transient HTTP backfill failures (daemon briefly
  // offline at activation, pod miss during deploy, network blip on resume).
  // Two retries cover the common ~3s WS-reconnect window after app foreground.
  // After both retries fail we give up — the next activation/reconnect will
  // fire a fresh backfill, and the WS path remains the primary.
  const HTTP_BACKFILL_RETRY_DELAYS_MS = [800, 2000] as const;

  const fireHttpBackfill = useCallback((delayMs: number, opts?: HttpBackfillOpts) => {
    // Read `isActiveSession` via ref so this gate always reflects the latest
    // render's value, never a stale closure. The closure value only desynchs
    // briefly during same-tick `setState` → render → effect sequences (e.g.
    // push-tap that activates a session AND fires the activation event in
    // the same microtask), but in practice that gap was wide enough to drop
    // backfills on real iOS/Android resumes — even after f72193f6 removed
    // `isActiveSession` from the listener's deps. Reading the ref closes
    // the remaining hole.
    //
    // `force=true` callers bypass the active gate. Used by the cold-IDB
    // branch of the bootstrap effect so SubSessionCard previews for
    // sessions the user has never opened on this browser still recover
    // their history through HTTP backfill. Without this, the WS-side
    // request (also force-through'd) is the only data source, and if WS
    // is mid-reconnect the user sees a permanently empty pane.
    if (disableHistory || !serverId || !sessionId || (!isActiveSessionRef.current && !isVisibleRef.current && !opts?.force)) {
      backfillDebug('fireHttpBackfill: gated', { disableHistory, isActiveSession: isActiveSessionRef.current, isVisible: isVisibleRef.current, hasServerId: !!serverId, hasSessionId: !!sessionId, sessionId, force: opts?.force });
      return;
    }
    const cooldownMs = opts?.cooldownMs ?? 0;
    const phase = opts?.phase ?? 'refresh';
    const visible = opts?.visible === true;
    const retryAttempt = opts?._retryAttempt ?? 0;
    const mode = opts?.mode ?? 'tail';
    const backfillSessionId = sessionId;
    const backfillCacheKey = cacheKey;
    const dueAt = Date.now() + Math.max(0, delayMs);
    if (mode === 'manualLatestWindow') clearHttpBackfillTimer('tail');
    if (httpBackfillTimerRef.current[mode] && httpBackfillTimerDueAtRef.current[mode] <= dueAt) {
      backfillDebug('fireHttpBackfill: coalesced', {
        sessionId: backfillSessionId,
        mode,
        hasTimer: true,
        inFlight: httpBackfillInFlightRef.current[mode],
      });
      if (visible) updateHistoryStep('http', 'running', phase);
      return;
    }
    if (httpBackfillTimerRef.current[mode]) clearHttpBackfillTimer(mode);
    if (httpBackfillInFlightRef.current[mode] > 0) {
      backfillDebug('fireHttpBackfill: coalesced', {
        sessionId: backfillSessionId,
        mode,
        hasTimer: false,
        inFlight: httpBackfillInFlightRef.current[mode],
      });
      if (visible) updateHistoryStep('http', 'running', phase);
      return;
    }
    httpBackfillTimerDueAtRef.current[mode] = dueAt;
    httpBackfillTimerRef.current[mode] = setTimeout(() => {
      httpBackfillTimerRef.current[mode] = null;
      httpBackfillTimerDueAtRef.current[mode] = 0;
      if (cacheKeyRef.current !== backfillCacheKey) return;
      if (backfillCacheKey && cooldownMs > 0) {
        const lastOk = lastHttpBackfillResponseAt.get(backfillCacheKey);
        if (lastOk !== undefined && Date.now() - lastOk < cooldownMs) {
          backfillDebug('fireHttpBackfill: cooldown skip', { sessionId: backfillSessionId, mode, lastOk, cooldownMs });
          if (visible) updateHistoryStep('http', 'done', phase);
          return;
        }
      }
      // Tail catch-up recomputes the cursor at fire time so fresh WS events
      // aren't re-downloaded. Manual ↻ is different: it intentionally asks for
      // the daemon's latest 300-event window with no lower timestamp bound, so
      // a newly-pushed event cannot mask the missing middle history below it.
      const afterTs = mode === 'manualLatestWindow' ? undefined : getTimelineHistoryAfterTs(eventsRef.current);
      const maxPages = mode === 'manualLatestWindow' ? 1 : undefined;
      backfillDebug('fireHttpBackfill: requesting', { sessionId: backfillSessionId, phase, mode, afterTs, retryAttempt });
      if (visible) {
        httpBackfillInFlightRef.current[mode] += 1;
        updateHistoryStep('http', 'running', phase);
        setHttpRefreshing(true);
      }
      // Newest-first WINDOW catch-up (Tier-0): the daemon serves history as the
      // NEWEST `limit` of `(afterTs, beforeTs]` (ORDER BY ts DESC), so page 1
      // already syncs to the latest message; to recover a tail backlog larger
      // than one page we hold the lower bound (`afterTs`, the local tail) fixed
      // and walk `beforeTs` DOWN by each page's min `ts` (bounded). Continuation
      // is driven by COUNT truncation (`events.length >= limit`), NOT the wire
      // `hasMore` (which is payload-drop). Only a fully caught-up round (a short
      // page, no truncation) advances the cooldown / watchdog baseline —
      // `cap_hit`/`truncated` must NOT cool down so the next trigger continues
      // rather than being suppressed by a false-completion.
      // NOTE: this does NOT fix the "middle/ordering gap" (events older than the
      // local tail base); that needs the deferred verified/forward cursor.
      void (async () => {
        let terminal: 'caught_up' | 'cap_hit' | 'truncated' | 'transient_null' | 'error' | null = null;
        try {
          const outcome = await runNewestWindowBackfill(afterTs, {
            limit: MAX_MEMORY_EVENTS,
            maxPages,
            fetchPage: ({ afterTs: at, beforeTs: bt }) => Promise.resolve(fetchTimelineHistoryHttp(serverId, backfillSessionId, {
              afterTs: at,
              ...(bt !== undefined ? { beforeTs: bt } : {}),
              limit: MAX_MEMORY_EVENTS,
              timeoutMs: resolveBackfillTimeoutMs(opts),
            })),
            mergePage: (events) => {
              if (cacheKeyRef.current !== backfillCacheKey) return { candidateCount: 0, minTs: null, maxTs: null };
              const recovered = events.filter(
                (ev): ev is TimelineEvent => !!ev && typeof ev === 'object'
                  && typeof (ev as TimelineEvent).eventId === 'string'
                  && typeof (ev as TimelineEvent).sessionId === 'string'
                  && typeof (ev as TimelineEvent).type === 'string'
                  && typeof (ev as TimelineEvent).ts === 'number'
                  && Number.isFinite((ev as TimelineEvent).ts),
              );
              if (recovered.length === 0) return { candidateCount: 0, minTs: null, maxTs: null };
              backfillDebug('fireHttpBackfill: merging page', { sessionId: backfillSessionId, count: recovered.length });
              mergeEvents(recovered);
              for (const recoveredEvent of recovered) {
                settleOptimisticByCommandAckEvent(recoveredEvent);
                settleOptimisticByTimelineProgress(recoveredEvent);
              }
              idbPutEvents(recovered);
              let minTs = Infinity;
              let maxTs = -Infinity;
              for (const recoveredEvent of recovered) {
                if (recoveredEvent.ts < minTs) minTs = recoveredEvent.ts;
                if (recoveredEvent.ts > maxTs) maxTs = recoveredEvent.ts;
              }
              return {
                candidateCount: recovered.length,
                minTs: Number.isFinite(minTs) ? minTs : null,
                maxTs: Number.isFinite(maxTs) ? maxTs : null,
              };
            },
          });
          terminal = outcome.terminal;
          // Transient null on the FIRST page → preserve the legacy retry-with-backoff.
          // A null on a later page means ≥1 page already merged; stop (next trigger
          // continues) rather than restart the whole round.
          if (outcome.terminal === 'transient_null' && outcome.pageCount === 0) {
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
          if (backfillCacheKey && outcome.terminal === 'caught_up') {
            lastHttpBackfillResponseAt.set(backfillCacheKey, Date.now());
          }
          backfillDebug('fireHttpBackfill: backfill settled', { sessionId: backfillSessionId, mode, terminal: outcome.terminal, pages: outcome.pageCount, totalNew: outcome.totalNew });
        } catch {
          terminal = 'error';
          /* opportunistic — WS path is primary */
        }
        finally {
          if (visible) {
            httpBackfillInFlightRef.current[mode] = Math.max(0, httpBackfillInFlightRef.current[mode] - 1);
            updateHistoryStep('http', terminal === 'caught_up' ? 'done' : 'pending', phase);
            if (totalHttpBackfillInFlight(httpBackfillInFlightRef.current) === 0) setHttpRefreshing(false);
          }
        }
      })();
    }, delayMs);
  }, [clearHttpBackfillTimer, disableHistory, isActiveSession, serverId, sessionId, cacheKey, mergeEvents, idbPutEvents, settleOptimisticByCommandAckEvent, settleOptimisticByTimelineProgress, updateHistoryStep]);

  // Stable indirection — lets the session-mount effect below call the latest
  // `fireHttpBackfill` without having to list it (and transitively its five
  // dependencies) in its own dep array, which would otherwise cause the
  // mount effect to re-run on every render.
  const fireHttpBackfillRef = useRef(fireHttpBackfill);
  fireHttpBackfillRef.current = fireHttpBackfill;
  // Explicit user-triggered sync (chat ↻ button). visible:true lights the
  // refreshing overlay so the user sees the catch-up; force:true bypasses the
  // active-session gate so it works on a visible-but-not-focused sub-session;
  // no cooldownMs so the click always fires regardless of the 15s throttle.
  // Re-read local IDB history on demand — independent of the network. Clears
  // any transient memory-only degradation (`resetAndReopen`) so a prior IDB
  // open failure is retried instead of stranding on-disk history until a full
  // page reload. This is what makes the ↻ button actually recover a blank pane
  // even when serverId is unresolved / the daemon is offline (HTTP no-op).
  const reloadLocalTimeline = useCallback(async () => {
    const key = cacheKeyRef.current;
    if (!key) return;
    // Only force a reopen when the DB is actually degraded — resetAndReopen()
    // closes the SHARED singleton connection, which would disrupt every OTHER
    // session's in-flight reads/writes. A healthy connection just re-reads
    // (run 016f9b5b-c8f M2 — the cycle-1 unconditional reset was a regression).
    if (sharedDb.memoryOnly) {
      try { await sharedDb.resetAndReopen(); } catch { /* ignore — read below falls back to memory */ }
    }
    const rawSessionId = sessionId && sessionId !== key ? sessionId : undefined;
    const localSnapshot = loadPersistedTimelineSnapshotWithFallback(key, rawSessionId);
    if (localSnapshot.length > 0) {
      const existing = getSharedTimelineBase(key, eventsRef.current, MAX_MEMORY_EVENTS);
      const restored = mergeTimelineEvents(existing, localSnapshot, MAX_MEMORY_EVENTS);
      setCachedEvents(key, restored);
      setEvents((prev) => (prev === restored ? prev : restored));
      const snapshotCursor = deriveLocalCursor(localSnapshot);
      if (snapshotCursor) {
        epochRef.current = Math.max(epochRef.current, snapshotCursor.epoch);
        seqRef.current = Math.max(seqRef.current, snapshotCursor.seq);
      }
    }
    const { stored, cursor, rawAlreadyRead } = await readLocalTimelineMerged(sharedDb, key, rawSessionId, MAX_MEMORY_EVENTS);
    if (cacheKeyRef.current !== key) return;
    if (cursor) {
      epochRef.current = cursor.epoch;
      seqRef.current = cursor.seq;
    }
    if (stored.length > 0) {
      const existing = getSharedTimelineBase(key, eventsRef.current, MAX_MEMORY_EVENTS);
      const restored = mergeTimelineEvents(existing, stored, MAX_MEMORY_EVENTS);
      setCachedEvents(key, restored);
      setEvents((prev) => (prev === restored ? prev : restored));
      historyLoadedRef.current = key;
      // Phase 2 split-key heal (same as bootstrap) — merge the bare segment.
      if (rawSessionId && !rawAlreadyRead) mergeRawSegmentLater(sharedDb, rawSessionId, key);
    }
  }, [sessionId, mergeRawSegmentLater]);

  // Ref mirror so the activation listeners (whose deps are intentionally pinned
  // to `[disableHistory, sessionId]` to avoid re-attach races) can invoke the
  // latest reloadLocalTimeline without listing it as a dep.
  const reloadLocalTimelineRef = useRef(reloadLocalTimeline);
  reloadLocalTimelineRef.current = reloadLocalTimeline;

  const forceRefresh = useCallback(() => {
    // Re-read LOCAL IDB first (the user's history is local — this recovers a
    // blank pane even when serverId is unresolved or the daemon is offline,
    // i.e. when the HTTP path is a no-op), then opportunistically catch up
    // over HTTP.
    void reloadLocalTimeline();
    fireHttpBackfillRef.current(0, { phase: 'refresh', visible: true, force: true, mode: 'manualLatestWindow' });
  }, [reloadLocalTimeline]);

  // Self-heal a blank pane. The mount path seeds `events` from local cache, but
  // it can still settle EMPTY even when history exists — e.g. serverId resolved
  // AFTER the first read so the scoped cacheKey changed, a cold/slow IndexedDB
  // read, or a daemon history response that came back empty. The user shouldn't
  // have to hit ↻ to get the same recovery path. When the timeline has SETTLED
  // blank, re-read local IDB and run the same latest-window HTTP catch-up used
  // by forceRefresh. `manualLatestWindow` also clears any pending tail backfill,
  // so this does not double-fetch after the mount bootstrap timer.
  const blankSelfHealRef = useRef<string | null>(null);
  const fireBlankPaneRecovery = useCallback((visible: boolean) => {
    const key = cacheKeyRef.current;
    if (!key) return;
    blankSelfHealRef.current = key;
    void reloadLocalTimelineRef.current();
    fireHttpBackfillRef.current(0, {
      phase: 'refresh',
      visible,
      force: true,
      mode: 'manualLatestWindow',
    });
  }, []);
  useEffect(() => {
    const key = cacheKey;
    if (!key || disableHistory) return;
    if (events.length > 0) {
      if (blankSelfHealRef.current === key) blankSelfHealRef.current = null;
      return;
    }
    if (loading || refreshing || httpRefreshing) return; // another recovery path is still running
    if (!isActiveSessionRef.current && !isVisibleRef.current) return;
    if (blankSelfHealRef.current === key) return;  // already self-healed this key
    fireBlankPaneRecovery(isActiveSessionRef.current);
  }, [
    cacheKey,
    events.length,
    loading,
    refreshing,
    httpRefreshing,
    disableHistory,
    fireBlankPaneRecovery,
  ]);

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
      // Resume broadcast: refresh if either the hook is the active session
      // OR it is a visible-but-not-focused mount (open sub-session card / window).
      // The downstream 15s success-only cooldown still rate-limits each session
      // so multiple visible cards on desktop don't herd the daemon.
      if (!isActiveSessionRef.current && !isVisibleRef.current) {
        backfillDebug('activation event: gated by !isActiveSession && !isVisible', { sessionId });
        return;
      }
      const now = Date.now();
      if (now - lastActiveRefreshAtRef.current < 250) {
        backfillDebug('activation event: rate-limited', { sessionId });
        return;
      }
      lastActiveRefreshAtRef.current = now;
      backfillDebug('activation event: firing backfill', { sessionId });
      // Re-read LOCAL history too when the on-screen timeline is short — not only
      // when it's empty. The HTTP backfill below is gated/cooled-down and can be a
      // no-op (serverId unresolved, daemon offline, 15s cooldown), so a window
      // that reopened with a truncated/half-restored timeline would otherwise stay
      // short and the user "loses" messages. A local IDB re-read is cheap and an
      // idempotent merge (never drops newer live events), so it safely restores
      // the user's own history on activation. See ACTIVE_LOCAL_RELOAD_MAX_EVENTS.
      if (eventsRef.current.length < ACTIVE_LOCAL_RELOAD_MAX_EVENTS) {
        void reloadLocalTimelineRef.current();
      }
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
      // Short on-screen timeline → also re-read local history (idempotent merge).
      // Same rationale as the activation-event handler above
      // (ACTIVE_LOCAL_RELOAD_MAX_EVENTS): recover a truncated reopen without
      // waiting on the gated/cooled-down HTTP backfill.
      if (eventsRef.current.length < ACTIVE_LOCAL_RELOAD_MAX_EVENTS) {
        void reloadLocalTimelineRef.current();
      }
      if (eventsRef.current.length === 0) {
        // A rarely-opened sub-session can activate with no local/daemon events
        // rendered yet. The manual ↻ path is known to recover this state, so use
        // that same latest-window, force-through recovery instead of the normal
        // silent tail refresh that may be suppressed by the activation cooldown.
        fireBlankPaneRecovery(true);
        return;
      }
      // SILENT (visible: false). Same reasoning as the activation-event
      // handler above — the false→true transition fires whenever the user
      // taps a session card; coupling that with a refreshing-state flip
      // re-renders the chat list and stutters the scroll. The 15s
      // cooldown handles dedup against the activation-event tick that
      // usually arrives in the same commit.
      fireHttpBackfillRef.current(0, { phase: 'refresh', cooldownMs: ACTIVE_REFRESH_COOLDOWN_MS });
    }
  }, [isActiveSession, disableHistory, sessionId]);

  // ── Foreground staleness watchdog ───────────────────────────────────────
  // A session the user is actively looking at can silently miss a live
  // `timeline.event`: the WS delivered nothing, threw no error, never
  // reconnected, and no focus/visibility tick fired — so none of the existing
  // catch-up triggers run and the chat just sits there stale. This is the core
  // "弱网前台停留不自动同步" complaint. Periodically, while foreground and
  // active/visible, check whether the stream has gone quiet beyond
  // WATCHDOG_STALE_MS (no content event AND no HTTP response) and, if so, fire
  // ONE silent catch-up. Any non-null HTTP response advances the staleness
  // baseline via `lastHttpBackfillResponseAt` (NOT a verified-contiguous signal),
  // so a genuinely idle/responding session self-throttles instead of probing
  // every tick; per-cacheKey backoff bounds the retry rate while the link is down.
  useEffect(() => {
    if (disableHistory || typeof window === 'undefined') return;
    const tick = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (!isActiveSessionRef.current && !isVisibleRef.current) return;
      if (!serverId || !sessionId) return;
      // HTTP backfill is independent of the socket, but if the WS is down the
      // reconnect path already owns recovery; the watchdog targets the
      // "connected but silently stalled" case.
      if (!ws?.connected) return;
      const key = cacheKeyRef.current;
      if (!key) return;
      const okAt = lastHttpBackfillResponseAt.get(key) ?? 0;
      const lastSignal = Math.max(lastTimelineEventAtRef.current, okAt);
      const now = Date.now();
      if (lastSignal > 0 && now - lastSignal < WATCHDOG_STALE_MS) {
        // Fresh again → drop any backoff so the next stale episode probes promptly.
        watchdogStateByCacheKey.delete(key);
        return;
      }
      // Stale. The per-cacheKey gate (a) dedups multiple mounts of the same
      // session so only ONE probe fires per window (round-4 R1/A3), and (b) backs
      // the retry off exponentially while the link stays down so we don't probe
      // every WATCHDOG_INTERVAL_MS (round-4 N4/A4).
      const prev = watchdogStateByCacheKey.get(key);
      if (prev && now < prev.nextAllowedAt) return;
      const streak = prev ? prev.streak : 0;
      const spacing = Math.min(WATCHDOG_BACKOFF_BASE_MS * 2 ** streak, WATCHDOG_BACKOFF_MAX_MS)
        + Math.random() * WATCHDOG_JITTER_MS;
      watchdogStateByCacheKey.set(key, { nextAllowedAt: now + spacing, streak: Math.min(streak + 1, 2) });
      backfillDebug('watchdog: stale → silent catch-up', { sessionId, lastSignal, streak });
      // Silent (visible:false), cooldownMs:0 so the activation/mount cooldown
      // can't suppress this recovery. A silent fire's scenario timeout is ~6s and
      // the gate above keeps the next probe ≥30s away, so each probe's retry
      // chain (~21s) finishes well before another is allowed (no overlap).
      fireHttpBackfillRef.current(0, { phase: 'refresh', cooldownMs: 0 });
    };
    const id = window.setInterval(tick, WATCHDOG_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [disableHistory, serverId, sessionId, ws]);

  // Listen for WS messages
  useEffect(() => {
    if (disableHistory || !ws || !sessionId) return;

    const handler = (msg: ServerMessage) => {
      // ── Real-time event ──
      if (msg.type === TIMELINE_MESSAGES.EVENT) {
        const event = msg.event;
        if (event.sessionId !== sessionId) return;
        // Watchdog liveness = CONTENT freshness, not pipe-alive. `session.state`
        // heartbeats from a running agent must NOT reset liveness, or a dropped
        // `assistant.text`/`tool.*` event stays invisible to the watchdog while
        // state pings keep the window "fresh" (round-4 audit S1 / 新框定#1). A
        // content-quiet session probing every stale-window is benign (returns
        // empty + backs off). The true fix for ordered-gap detection ("missed
        // A/B, then received C") is the Layer B verified cursor.
        if (event.type !== 'session.state') {
          lastTimelineEventAtRef.current = Date.now();
        }
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
        if (!userMessageAlreadyMerged) {
          appendRealtimeEvent(event);
        } else {
          idbPutEvents([event]);
        }
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
      if (msg.type === TIMELINE_MESSAGES.HISTORY || msg.type === TIMELINE_MESSAGES.PAGE) {
        if (msg.sessionName !== sessionId) return;
        const responseState = getTimelineResponseState(msg);
        const shouldPreserveOlderAvailability = responseState === 'error'
          || responseState === 'deferred'
          || responseState === 'canceled';

        // Handle backward pagination response
        if (msg.requestId && msg.requestId === olderRequestIdRef.current) {
          updateHistoryStep('older', 'done', 'older');
          resetOlderState();
          recordTimelineResponse(msg, 'older');
          const olderCursor = getOlderTimelineCursor(msg);
          if (hasStructuredOlderPage(msg) && olderCursor) olderCursorRef.current = olderCursor;
          if (msg.events.length > 0) {
            mergeEvents(msg.events, MAX_HISTORY_EVENTS);
            idbPutEvents(msg.events);
          }
          if (shouldPreserveOlderAvailability) {
            return;
          }
          if (hasStructuredOlderPage(msg)) {
            setHasOlderHistory(true);
          } else if (msg.hasMore === false) {
            olderCursorRef.current = null;
            setHasOlderHistory(false);
          }
          return;
        }

        // Accept any same-session history batch for forward sync. Mobile
        // reconnect/background churn can legitimately create overlapping history
        // requests; dropping the earlier response can leave the UI stuck on old
        // cache if the newest request never completes. Since history merges by
        // eventId and ts, older batches cannot delete newer events.
        const isCurrentForwardHistoryResponse = !msg.requestId || msg.requestId === historyRequestIdRef.current;
        if (isCurrentForwardHistoryResponse) {
          clearForwardHistoryTimeout();
          reconnectRefreshInFlightRef.current = false;
        }
        if (!olderRequestIdRef.current || msg.requestId !== olderRequestIdRef.current) {
          if (!historyRequestIdRef.current || msg.requestId === historyRequestIdRef.current) {
            historyRequestIdRef.current = null;
          }
        }
        updateHistoryStep('daemon', 'done', loading ? 'bootstrap' : 'refresh');
        recordTimelineResponse(msg, loading ? 'bootstrap' : 'refresh');
        historyLoadedRef.current = cacheKeyRef.current;
        const forwardOlderCursor = getOlderTimelineCursor(msg);
        if (hasStructuredOlderPage(msg) && forwardOlderCursor) {
          olderCursorRef.current = forwardOlderCursor;
          setHasOlderHistory(true);
        } else if (msg.hasMore === false) {
          olderCursorRef.current = null;
          setHasOlderHistory(false);
        }

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
        } else if (historyRetryRef.current < 2 && ws?.connected && isActiveSessionRef.current && shouldRetryTimelineHistoryResponse(msg, eventsRef.current.length > 0)) {
          // Legacy empty response with no cached events — retry once after a
          // short delay. Explicit protocol outcomes (empty success, deferred,
          // queue-full, timeout, unavailable, malformed, internal, etc.) are
          // terminal unless the daemon marks the response recoverable.
          // Gate by isActiveSession so non-focused SubSessionCards don't keep
          // retrying forever when their backing session has no events yet.
          historyRetryRef.current++;
          setTimeout(() => {
            // Re-check the flag at fire time — the user may have switched
            // away in the 1-2s delay window.
            if (!isActiveSessionRef.current) return;
            if (ws?.connected && sessionId) sendForwardHistoryRequest('bootstrap', buildForwardHistoryArgs(MAX_MEMORY_EVENTS));
          }, 1000 * historyRetryRef.current);
        }
        setLoading(false);
        setRefreshing(false);
      }

      // ── Replay response (gap-fill after reconnect) ──
      if (msg.type === TIMELINE_MESSAGES.REPLAY) {
        if (msg.sessionName !== sessionId) return;
        if (msg.requestId && msg.requestId !== replayRequestIdRef.current) return;
        replayRequestIdRef.current = null;
        updateHistoryStep('daemon', 'done', 'refresh');
        recordTimelineResponse(msg, 'refresh');
        const { events: replayEvents, truncated, epoch } = msg;

        // Update epoch — don't clear events, ts-sort handles cross-epoch order
        epochRef.current = epoch;

        if (truncated === true && ws) {
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

      if (msg.type === TIMELINE_MESSAGES.DETAIL) {
        if (msg.sessionName && msg.sessionName !== sessionId) return;
        if (msg.status === TIMELINE_RESPONSE_STATUS.OK) {
          let hydrated: TimelineEvent | null = null;
          setEvents((prev) => {
            const base = getSharedTimelineBase(cacheKeyRef.current, prev, MAX_MEMORY_EVENTS);
            const next = hydrateTimelineDetailEvent(base, msg);
            if (next === base) return base;
            hydrated = next.find((event) => event.eventId === msg.eventId) ?? null;
            if (cacheKeyRef.current) setCachedEvents(cacheKeyRef.current, next);
            return next;
          });
          if (hydrated) {
            recordTimelineResponse(msg, loading ? 'bootstrap' : 'refresh');
            idbPutEvents([hydrated]);
          }
          return;
        }
        recordTimelineResponse(msg, loading ? 'bootstrap' : 'refresh');
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
          if (!beginReconnectRefresh('daemon')) return;
          setHistoryStatus({
            phase: 'refresh',
            steps: {
              cache: 'done',
              textTail: 'skipped',
              daemon: 'running',
              http: serverId ? 'pending' : 'skipped',
              older: 'skipped',
            },
            response: null,
          });
          setRefreshing(true);
          sendForwardHistoryRequest('refresh', buildForwardHistoryArgs(MAX_MEMORY_EVENTS));
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
        if ((msg as { reason?: string }).reason === 'probe_recovered') {
          // Probe recovery alone doesn't prove the timeline is in sync — events
          // may have been missed while the socket was half-open. Bare dispatch
          // goes through the active-refresh listener's 15s success-only cooldown
          // (`ACTIVE_REFRESH_COOLDOWN_MS`), so repeated probe events are absorbed
          // but a real >15s gap gets one HTTP backfill. We skip the heavier
          // replay+forward-history path to avoid daemon herd on probe churn.
          dispatchActiveTimelineRefresh();
          return;
        }
        // Same gate as the DAEMON_MSG.RECONNECTED path — restrict the
        // browser-WS reconnect refresh to the active card's hook so we
        // don't herd the daemon with N timeline.history_request +
        // timeline.replay calls every reconnect. Inactive sub-session
        // cards keep their cache and pick up live events; full history
        // re-sync happens when the user next activates that card.
        if (!isActiveSessionRef.current) return;
        if (ws && sessionId) {
          if (!beginReconnectRefresh('browser')) return;
          setHistoryStatus({
            phase: 'refresh',
            steps: {
              cache: 'done',
              textTail: 'skipped',
              daemon: 'running',
              http: 'skipped',
              older: 'skipped',
            },
            response: null,
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
          sendForwardHistoryRequest('refresh', { limit: MAX_MEMORY_EVENTS, afterTs });

          // Fire HTTP backfill with a ~600ms delay to let the bridge's async
          // `terminal.subscribe` ownership-check race resolve; any live
          // `timeline.event` emitted during that window is routed through
          // `sendToSessionSubscribers`, finds the browser not-yet-subscribed,
          // and gets silently dropped. The HTTP path reads daemon store
          // directly (unicast request-response, no subscription routing).
          // Keep this HTTP leg out of the visible stepper: ordinary browser
          // focus/probe reconnects can happen repeatedly on mobile, and the
          // daemon history step already communicates that a refresh is active.
          fireHttpBackfillRef.current(600, { phase: 'refresh' });
        }
      }

      // ── command.ack: reconcile the optimistic send bubble. Error/conflict
      //    flips it to the failed "!" state so the user can retry; success-ish
      //    acks just cancel the 90s failure timeout — the real user.message
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
          // MAY have actually landed and the ack got lost. Fire one short
          // HTTP backfill grace window to recover a persisted echo; if it
          // does not arrive, mark the bubble failed/ retryable instead of
          // leaving the user staring at a long-running pending spinner.
          fireHttpBackfillRef.current(0, { phase: 'refresh', visible: true });
          clearOptimisticTimer(commandId);
          const timer = setTimeout(() => {
            markOptimisticFailed(commandId, localizedAckFailureReason('ack_timeout'));
          }, ACK_TIMEOUT_BACKFILL_GRACE_MS);
          optimisticTimersRef.current.set(commandId, timer);
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
  }, [beginReconnectRefresh, buildForwardHistoryArgs, clearForwardHistoryTimeout, disableHistory, isActiveSession, ws, sessionId, appendEvent, clearOptimisticTimer, idbPutEvents, loading, markOptimisticFailed, mergeEvents, reconcileQueuedOptimisticMessages, recordTimelineResponse, rememberSettledCommandId, replaceEvents, resetOlderState, scheduleAutoRetry, sendForwardHistoryRequest, serverId, settleOptimisticByCommandAck, settleOptimisticByCommandAckEvent, settleOptimisticByTimelineProgress, updateHistoryStep]);

  useEffect(() => {
    if (loading || refreshing || httpRefreshing || loadingOlder) return;
    setHistoryStatus((prev) => (prev.phase === 'idle' ? prev : { ...createIdleHistoryStatus(), response: prev.response }));
  }, [httpRefreshing, loading, loadingOlder, refreshing]);

  useEffect(() => {
    return () => {
      clearForwardHistoryTimeout();
      clearHttpBackfillTimer();
      reconnectRefreshInFlightRef.current = false;
      httpBackfillInFlightRef.current = createHttpBackfillCountState();
    };
  }, [clearForwardHistoryTimeout, clearHttpBackfillTimer, sessionId]);

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
    forceRefresh,
  };
}
