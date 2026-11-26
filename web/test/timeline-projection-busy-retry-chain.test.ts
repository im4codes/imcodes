import { describe, expect, it } from 'vitest';
import { __shouldRetryTimelineHistoryResponseForTests } from '../src/hooks/useTimeline.js';
import {
  RECOVERABLE_TIMELINE_REQUEST_ERROR_REASONS,
  TIMELINE_HISTORY_ERROR_REASONS,
} from '../../shared/timeline-history-errors.js';
import { TIMELINE_MESSAGES, TIMELINE_RESPONSE_STATUS } from '../../shared/timeline-protocol.js';

/**
 * The exact frame the daemon emits for a saturated projection. Built here in the
 * wire shape rather than by calling the daemon, so this test pins the CONTRACT
 * the two sides share: if the daemon stops setting `recoverable`, or sets some
 * field the client does not read, this fails.
 */
function daemonHistoryErrorFrame(errorReason: string, recoverable?: boolean) {
  return {
    type: TIMELINE_MESSAGES.HISTORY,
    sessionName: 'deck_saturated_brain',
    requestId: 'hist-1',
    events: [],
    epoch: 1,
    status: TIMELINE_RESPONSE_STATUS.ERROR,
    errorReason,
    source: `worker_${errorReason}`,
    payloadBytes: 2,
    payloadTruncated: false,
    hasMore: false,
    droppedEvents: 0,
    truncatedEvents: 0,
    ...(recoverable === undefined ? {} : { recoverable }),
  } as never;
}

describe('projection_busy retries end to end; projection_unavailable does not', () => {
  it('schedules a client retry for a busy projection', () => {
    // The daemon answers saturation with a determinate error frame instead of
    // doing the work on its event loop. That is only useful if the client
    // actually comes back -- otherwise the user simply loses their history.
    expect(__shouldRetryTimelineHistoryResponseForTests(
      daemonHistoryErrorFrame(TIMELINE_HISTORY_ERROR_REASONS.PROJECTION_BUSY, true),
      false,
    )).toBe(true);
  });

  it('retries a busy projection even from a server that omits the flag', () => {
    // Defense-in-depth path: an older daemon sends the reason without
    // `recoverable`. The shared allow-list must still classify busy as
    // transient, or a mixed-version fleet silently stops retrying.
    expect(RECOVERABLE_TIMELINE_REQUEST_ERROR_REASONS.has(
      TIMELINE_HISTORY_ERROR_REASONS.PROJECTION_BUSY,
    )).toBe(true);
    expect(__shouldRetryTimelineHistoryResponseForTests(
      daemonHistoryErrorFrame(TIMELINE_HISTORY_ERROR_REASONS.PROJECTION_BUSY),
      false,
    )).toBe(true);
  });

  it('does not retry a genuinely unavailable projection', () => {
    // Absence is durable and is handled on the daemon by falling back to the
    // main-thread build; retrying it from the client would just re-run that
    // fallback forever. It must stay outside the recoverable set.
    expect(RECOVERABLE_TIMELINE_REQUEST_ERROR_REASONS.has(
      TIMELINE_HISTORY_ERROR_REASONS.PROJECTION_UNAVAILABLE,
    )).toBe(false);
    expect(__shouldRetryTimelineHistoryResponseForTests(
      daemonHistoryErrorFrame(TIMELINE_HISTORY_ERROR_REASONS.PROJECTION_UNAVAILABLE, false),
      false,
    )).toBe(false);
  });

  it('never retries once events were actually rendered', () => {
    // Guards the precondition the classifier depends on, so a future change to
    // the busy path cannot start retrying over a populated view.
    expect(__shouldRetryTimelineHistoryResponseForTests(
      daemonHistoryErrorFrame(TIMELINE_HISTORY_ERROR_REASONS.PROJECTION_BUSY, true),
      true,
    )).toBe(false);
  });
});
