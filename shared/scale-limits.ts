/**
 * Shared scale, concurrency, and lock/unlock recovery constants across daemon,
 * server, and web layers. Kept in `shared/` as the single source of truth so
 * protocol batch bounds, UI hydration caps, and timeout recovery stay aligned.
 */

export const SUBSESSION_SYNC_BATCH_MSG = 'subsession.sync.batch' as const;
export const SUBSESSION_CREATED_BATCH_MSG = 'subsession.created.batch' as const;
export const SUBSESSION_SYNC_BATCH_MAX_ITEMS = 50;
export const SUBSESSION_SYNC_REBUILD_CONCURRENCY = 8;

/**
 * Maximum concurrent `getRecentTextForWatch` calls per `/watch/sessions` HTTP
 * request so 100+ main and 1000+ sub-session fleets never launch an unbounded
 * 1,100-RPC burst against the DB and daemon link.
 */
export const WATCH_RECENT_TEXT_CONCURRENCY = 20;

/**
 * Maximum simultaneously hydrated `<SubSessionCard>` widgets (each holding a
 * live `useTimeline` + `SessionControls` tree) when the sub-session bar is
 * expanded. Focused/open/running sessions are prioritized first; remaining
 * sub-sessions render as lightweight clickable pills so no sub-session is
 * hidden or lost while bounding main-thread and heap cost.
 * Normal workloads (`<= 24` sub-sessions in a main session) are unaffected.
 */
export const SUBSESSION_BAR_MAX_EXPANDED_CARDS = 24;

/**
 * Bounded IndexedDB open and transaction inactivity timeouts (ms). iOS/Safari
 * WebKit and suspended desktop tabs can leave IDB open/transaction requests
 * pending forever without firing `onsuccess`, `onerror`, `onblocked`, or
 * `oncomplete` across lock/sleep. `IDB_TX_TIMEOUT_MS` bounds stall time
 * between progress heartbeats (`touch()`) so large legitimate batches are not
 * aborted mid-flight while wedged transactions still fail fast and recover via
 * `resetAndReopen()`.
 */
export const IDB_OPEN_TIMEOUT_MS = 10_000;
export const IDB_TX_TIMEOUT_MS = 8_000;

/**
 * Wall-clock threshold (ms) after which an in-flight WebSocket ticket/connect
 * attempt is considered stale across OS lock/sleep when `resumeConnection(true)`
 * runs on foreground unlock.
 */
export const WS_STALE_CONNECT_ATTEMPT_MS = 5_000;

/**
 * Coalescing window (ms) for redundant foreground unlock event bursts
 * (`visibilitychange` + `focus` + `pageshow` + `online`) and auth re-checks.
 */
export const WEB_UNLOCK_COALESCE_MS = 500;
export const WEB_AUTH_VERIFY_MIN_INTERVAL_MS = 30_000;
