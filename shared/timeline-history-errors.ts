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
  INTERNAL_ERROR: FS_GENERIC_ERROR_CODES.INTERNAL_ERROR,
} as const;

export type TimelineHistoryErrorReason =
  (typeof TIMELINE_HISTORY_ERROR_REASONS)[keyof typeof TIMELINE_HISTORY_ERROR_REASONS];

export const TIMELINE_HISTORY_WORKER_ERROR_REASONS = {
  PROJECTION_UNAVAILABLE: TIMELINE_HISTORY_ERROR_REASONS.PROJECTION_UNAVAILABLE,
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
 */
export const RECOVERABLE_TIMELINE_REQUEST_ERROR_REASONS: ReadonlySet<TimelineRequestErrorReason> = new Set<TimelineRequestErrorReason>([
  TIMELINE_REQUEST_ERROR_REASONS.QUEUE_FULL,
  TIMELINE_REQUEST_ERROR_REASONS.DEADLINE_EXCEEDED,
  TIMELINE_REQUEST_ERROR_REASONS.TIMEOUT,
  TIMELINE_REQUEST_ERROR_REASONS.UNAVAILABLE,
]);

export function isRecoverableTimelineRequestErrorReason(reason: unknown): reason is TimelineRequestErrorReason {
  return typeof reason === 'string'
    && (RECOVERABLE_TIMELINE_REQUEST_ERROR_REASONS as ReadonlySet<string>).has(reason);
}
