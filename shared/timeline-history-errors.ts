import { FS_GENERIC_ERROR_CODES } from './fs-error-codes.js';

export const TIMELINE_HISTORY_ERROR_REASONS = {
  QUEUE_FULL: 'queue_full',
  DEADLINE_EXCEEDED: 'deadline_exceeded',
  REQUEST_CANCELED: 'request_canceled',
  UNAVAILABLE: 'unavailable',
  CRASHED: 'crashed',
  SHUTDOWN: 'shutdown',
  TIMEOUT: 'timeout',
  PROJECTION_UNAVAILABLE: 'projection_unavailable',
  /**
   * The projection exists but could not answer right now: the readiness probe
   * or query raised instead of returning a verdict (SQLITE_BUSY after
   * busy_timeout, lock contention, transient I/O).
   *
   * Kept separate from PROJECTION_UNAVAILABLE on purpose. Absence is a durable
   * property that legitimately licenses the main-thread path; busy is a
   * momentary one, and moving heavy SQLite/synthesize/sanitize onto the event
   * loop is the worst possible response to a process that is already saturated.
   * Collapsing the two is what turned a worker timeout into main-thread work.
   */
  PROJECTION_BUSY: 'projection_busy',
  INTERNAL_ERROR: FS_GENERIC_ERROR_CODES.INTERNAL_ERROR,
} as const;

export type TimelineHistoryErrorReason =
  (typeof TIMELINE_HISTORY_ERROR_REASONS)[keyof typeof TIMELINE_HISTORY_ERROR_REASONS];

export const TIMELINE_HISTORY_WORKER_ERROR_REASONS = {
  PROJECTION_UNAVAILABLE: TIMELINE_HISTORY_ERROR_REASONS.PROJECTION_UNAVAILABLE,
  PROJECTION_BUSY: TIMELINE_HISTORY_ERROR_REASONS.PROJECTION_BUSY,
  INTERNAL_ERROR: TIMELINE_HISTORY_ERROR_REASONS.INTERNAL_ERROR,
} as const;

export type TimelineHistoryWorkerErrorReason =
  (typeof TIMELINE_HISTORY_WORKER_ERROR_REASONS)[keyof typeof TIMELINE_HISTORY_WORKER_ERROR_REASONS];

export const TIMELINE_DETAIL_ERROR_REASONS = {
  EXPIRED: 'detail_expired',
  MISSING: 'detail_missing',
  UNAUTHORIZED: 'detail_unauthorized',
  OVERSIZED: 'detail_oversized',
  MALFORMED: 'detail_malformed',
  EPOCH_MISMATCH: 'detail_epoch_mismatch',
  GENERATION_MISMATCH: 'detail_generation_mismatch',
  INTERNAL_ERROR: FS_GENERIC_ERROR_CODES.INTERNAL_ERROR,
} as const;

export type TimelineDetailErrorReason =
  (typeof TIMELINE_DETAIL_ERROR_REASONS)[keyof typeof TIMELINE_DETAIL_ERROR_REASONS];

export const TIMELINE_PAGE_ERROR_REASONS = {
  CURSOR_RESET: 'page_cursor_reset',
  MALFORMED: 'page_malformed',
  INTERNAL_ERROR: FS_GENERIC_ERROR_CODES.INTERNAL_ERROR,
} as const;

export type TimelinePageErrorReason =
  (typeof TIMELINE_PAGE_ERROR_REASONS)[keyof typeof TIMELINE_PAGE_ERROR_REASONS];

export const TIMELINE_REQUEST_ERROR_REASONS = {
  MALFORMED_REQUEST: 'malformed_request',
  REQUEST_UNAUTHORIZED: 'request_unauthorized',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  ...TIMELINE_HISTORY_ERROR_REASONS,
  ...TIMELINE_DETAIL_ERROR_REASONS,
  ...TIMELINE_PAGE_ERROR_REASONS,
  DETAIL_MALFORMED: TIMELINE_DETAIL_ERROR_REASONS.MALFORMED,
  PAGE_MALFORMED: TIMELINE_PAGE_ERROR_REASONS.MALFORMED,
} as const;

export type TimelineRequestErrorReason =
  (typeof TIMELINE_REQUEST_ERROR_REASONS)[keyof typeof TIMELINE_REQUEST_ERROR_REASONS];

/**
 * Transient request errors that the daemon / bridge layer rejected for
 * backpressure or scheduling reasons rather than because the request itself
 * was bad. Web clients are expected to auto-retry these with backoff; the
 * server signals "auto-retry OK" by setting `recoverable: true` on the
 * error frame and the client also falls back to this set when an older
 * server still emits an `errorReason` without the flag (defense-in-depth).
 *
 * Membership policy:
 *   - QUEUE_FULL — daemon or bridge data-plane queue saturated; retry after
 *     backoff should clear.
 *   - DEADLINE_EXCEEDED — bridge job timed out before draining; same.
 *   - TIMEOUT — generic timeout signal from worker pool / transport.
 *   - UNAVAILABLE — downstream subsystem temporarily not ready (e.g.
 *     projection mid-init).
 *
 * Explicitly NOT recoverable: PAYLOAD_TOO_LARGE (request shape problem),
 * REQUEST_CANCELED (user intent), MALFORMED_*, REQUEST_UNAUTHORIZED,
 * PROJECTION_UNAVAILABLE (semantic — fall back to JSONL on daemon, not
 * retry from the client), CRASHED / SHUTDOWN (terminal), INTERNAL_ERROR.
 *
 * PROJECTION_BUSY is recoverable and PROJECTION_UNAVAILABLE is not, and the
 * difference is the whole point: collapsing them is what let a saturated
 * projection be treated as an absent one and pushed heavy SQLite, synthesize
 * and sanitize onto the daemon's event loop.
 */
export const RECOVERABLE_TIMELINE_REQUEST_ERROR_REASONS: ReadonlySet<TimelineRequestErrorReason> = new Set<TimelineRequestErrorReason>([
  TIMELINE_REQUEST_ERROR_REASONS.QUEUE_FULL,
  TIMELINE_REQUEST_ERROR_REASONS.DEADLINE_EXCEEDED,
  TIMELINE_REQUEST_ERROR_REASONS.TIMEOUT,
  TIMELINE_REQUEST_ERROR_REASONS.UNAVAILABLE,
  // The projection exists but was too busy to answer (SQLITE_BUSY after
  // busy_timeout while a writer checkpoints the WAL). That is momentary and
  // exactly what a client should come back for. It is the counterpart of
  // PROJECTION_UNAVAILABLE below: absence is durable and is resolved on the
  // daemon by the main-thread fallback, so retrying it from the client would
  // only re-run that fallback forever.
  TIMELINE_REQUEST_ERROR_REASONS.PROJECTION_BUSY,
]);

export function isRecoverableTimelineRequestErrorReason(reason: unknown): reason is TimelineRequestErrorReason {
  return typeof reason === 'string'
    && (RECOVERABLE_TIMELINE_REQUEST_ERROR_REASONS as ReadonlySet<string>).has(reason);
}
