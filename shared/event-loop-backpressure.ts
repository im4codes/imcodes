/**
 * Back pressure by event-loop health (158, 2026-10-07: the main thread was blocked ~100 % of the time - 1.2 s
 * drifts every 1.3 s, a 10 s stall at the end - while child processes kept writing and the in-process readers kept
 * decoding, until the heap was gone). While the loop is overloaded the daemon stops READING from children (their
 * pipes fill and they wait: nothing is dropped) and paces the restore of many sessions; both resume when it recovers.
 */

/** Set to '0' to turn the process-wide back pressure off (an operator kill switch; test workers set it: their loops are blocked on purpose). */
export const EVENT_LOOP_BACKPRESSURE_ENV = 'IMCODES_EVENT_LOOP_BACKPRESSURE';

/** The loop counts as overloaded when its recent timer drift reaches this. */
export const EVENT_LOOP_OVERLOADED_LAG_MS = 400;
/** ...and as healthy again only once the drift is below this (a lower line, so it cannot flap). */
export const EVENT_LOOP_HEALTHY_LAG_MS = 100;
/** The loop is probed this often (a timer that should fire on time). */
export const EVENT_LOOP_PROBE_INTERVAL_MS = 200;
/** The recent drift is the worst of the probes inside this window. */
export const EVENT_LOOP_LAG_WINDOW_MS = 2_000;
/** A child's stdout is never held paused longer than this in one stretch... */
export const BACKPRESSURE_MAX_PAUSE_MS = 5_000;
/** ...and is then allowed to flow for at least this long before it can be paused again (no starvation of the child). */
export const BACKPRESSURE_RESUME_GRACE_MS = 1_000;
/** Between two session restores: at least this long, then until the loop is healthy, but never longer than the cap. */
export const RESTORE_PACING_MIN_GAP_MS = 1_000;
export const RESTORE_PACING_MAX_WAIT_MS = 30_000;
/** Across one whole restore the waiting for health adds up to at most this; after it the restore is paced by the floor alone. */
export const RESTORE_PACING_TOTAL_WAIT_BUDGET_MS = 5 * 60_000;
