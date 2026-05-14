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
