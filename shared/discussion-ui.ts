/**
 * Shared discussion-UI constants used by both the daemon and the web client.
 *
 * Single-sourced here per the repo convention (never duplicate cross-tier
 * constants). Import from daemon as `../../shared/discussion-ui.js`, from
 * server as `../../../shared/discussion-ui.js`, and from web as
 * `@shared/discussion-ui.js`.
 */

/**
 * How long a finished (done/failed) classic discussion is retained before it
 * is cleaned up / hidden, and the foreground "hidden gap" threshold that
 * triggers a discussion re-sync on resume. The daemon keeps a finished run in
 * its in-memory map for this long; the web client treats a background gap of
 * at least this long as "long hidden" and re-syncs the discussion list.
 */
export const DISCUSSION_RECONCILE_HIDDEN_MS = 60_000;

/**
 * Backstop timeout for an optimistic "pending" discussion start: it only
 * covers the case where the send succeeded but neither `discussion.started`
 * nor `discussion.error` arrived. It is cancelled on the first authoritative
 * event for the request, and is NOT used for the synchronous dispatch-time
 * failure path (which is handled immediately).
 */
export const PENDING_START_TIMEOUT_MS = 30_000;
