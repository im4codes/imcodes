/**
 * Daemon / controlled-node WebSocket authentication timing, shared by the server and its tests.
 *
 * A controlled node gives a socket up after 30 s without any server frame (its inbound-silence watchdog),
 * so nothing on the path to the first `heartbeat_ack` may wait that long.
 */

/**
 * How long authentication waits for the remote-desktop reconcile/revalidate steps before it completes anyway.
 * The steps keep running in the background and remote desktop stays unavailable for that connection until they
 * finish (fail closed); only the rest of the node's service no longer waits for them. Well under the node's 30 s.
 */
export const DAEMON_AUTH_RECONCILE_BUDGET_MS = 10_000;

/** A failed background reconcile is retried after these delays, then reported and left fail-closed. */
export const DAEMON_AUTH_RECONCILE_RETRY_DELAYS_MS = [5_000, 15_000, 60_000] as const;

/** An authentication phase (or the whole of it) slower than this is logged as a warning. */
export const DAEMON_AUTH_SLOW_PHASE_MS = 2_000;

/** This many authenticated connections replaced within the window means two processes share one credential. */
export const DAEMON_CONNECTION_DUEL_REPLACEMENTS = 3;
export const DAEMON_CONNECTION_DUEL_WINDOW_MS = 60_000;
