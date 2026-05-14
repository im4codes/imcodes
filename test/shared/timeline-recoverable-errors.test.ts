/**
 * Anchor test for the shared timeline-error recoverable contract introduced
 * by the post-deploy audit fix (commit f25f72e7) of
 * `reduce-daemon-main-thread-latency`.
 *
 * This file pins down which `errorReason` strings the daemon, the server
 * bridge, and the web `useTimeline` hook all agree are auto-retryable
 * transients vs. terminal errors. Without this anchor it would be trivial
 * for any future change to widen or narrow the recoverable set on one side
 * (daemon/server/web) while leaving the others on the old definition,
 * which is exactly the kind of cross-layer drift the original audit fix
 * was created to prevent.
 */
import { describe, it, expect } from 'vitest';
import {
  TIMELINE_REQUEST_ERROR_REASONS,
  RECOVERABLE_TIMELINE_REQUEST_ERROR_REASONS,
  isRecoverableTimelineRequestErrorReason,
} from '../../shared/timeline-history-errors.js';

describe('RECOVERABLE_TIMELINE_REQUEST_ERROR_REASONS', () => {
  it('marks transient backpressure / timeout reasons as recoverable', () => {
    expect(isRecoverableTimelineRequestErrorReason(TIMELINE_REQUEST_ERROR_REASONS.QUEUE_FULL)).toBe(true);
    expect(isRecoverableTimelineRequestErrorReason(TIMELINE_REQUEST_ERROR_REASONS.DEADLINE_EXCEEDED)).toBe(true);
    expect(isRecoverableTimelineRequestErrorReason(TIMELINE_REQUEST_ERROR_REASONS.TIMEOUT)).toBe(true);
    expect(isRecoverableTimelineRequestErrorReason(TIMELINE_REQUEST_ERROR_REASONS.UNAVAILABLE)).toBe(true);
  });

  it('marks request-shape / terminal reasons as NOT recoverable', () => {
    // Caller-provoked: the request itself is malformed or oversized,
    // retrying without a smaller payload / corrected shape is futile.
    expect(isRecoverableTimelineRequestErrorReason(TIMELINE_REQUEST_ERROR_REASONS.PAYLOAD_TOO_LARGE)).toBe(false);
    expect(isRecoverableTimelineRequestErrorReason(TIMELINE_REQUEST_ERROR_REASONS.MALFORMED_REQUEST)).toBe(false);
    expect(isRecoverableTimelineRequestErrorReason(TIMELINE_REQUEST_ERROR_REASONS.REQUEST_UNAUTHORIZED)).toBe(false);
    expect(isRecoverableTimelineRequestErrorReason(TIMELINE_REQUEST_ERROR_REASONS.REQUEST_CANCELED)).toBe(false);
  });

  it('marks projection-state / lifecycle reasons as NOT recoverable from the web side', () => {
    // Projection unavailable is daemon-internal — the correct path is the
    // JSONL fallback inside the daemon, not a client retry. The web client
    // would just loop hitting the same projection state.
    expect(isRecoverableTimelineRequestErrorReason(TIMELINE_REQUEST_ERROR_REASONS.PROJECTION_UNAVAILABLE)).toBe(false);
    expect(isRecoverableTimelineRequestErrorReason(TIMELINE_REQUEST_ERROR_REASONS.CRASHED)).toBe(false);
    expect(isRecoverableTimelineRequestErrorReason(TIMELINE_REQUEST_ERROR_REASONS.SHUTDOWN)).toBe(false);
  });

  it('rejects non-string and non-allow-listed values', () => {
    expect(isRecoverableTimelineRequestErrorReason(undefined)).toBe(false);
    expect(isRecoverableTimelineRequestErrorReason(null)).toBe(false);
    expect(isRecoverableTimelineRequestErrorReason(42)).toBe(false);
    expect(isRecoverableTimelineRequestErrorReason('not_a_reason')).toBe(false);
    expect(isRecoverableTimelineRequestErrorReason('')).toBe(false);
  });

  it('exports an immutable allow-list', () => {
    const initialSize = RECOVERABLE_TIMELINE_REQUEST_ERROR_REASONS.size;
    expect(initialSize).toBeGreaterThan(0);
    // Mutation attempts should not be possible — the set is typed
    // ReadonlySet. We still anchor the count so an unintended widening
    // shows up in CI immediately.
    expect(initialSize).toBe(4);
  });
});
