import { TIMELINE_DETAIL_ERROR_REASONS } from '../../shared/timeline-history-errors.js';
import { TIMELINE_PAYLOAD_BUDGET_BYTES } from '../../shared/timeline-payload-budget.js';
import { sanitizeTimelineHistoryEventsForTransport, type TimelineHistorySanitizeOptions } from './timeline-history-sanitize.js';
import type { TimelineEvent } from './timeline-event.js';

export function shapeTimelineEventsForTransport(
  events: readonly TimelineEvent[],
  options: TimelineHistorySanitizeOptions = {},
) {
  return sanitizeTimelineHistoryEventsForTransport(events, options);
}

export type TimelineDetailValueShapeResult =
  | {
      ok: true;
      value: string;
      payloadBytes: number;
      payloadTruncated: false;
    }
  | {
      ok: false;
      errorReason: typeof TIMELINE_DETAIL_ERROR_REASONS.OVERSIZED;
      payloadBytes: number;
      payloadTruncated: true;
    };

export function shapeTimelineDetailValueForTransport(
  value: string,
  responseEnvelope: Record<string, unknown>,
): TimelineDetailValueShapeResult {
  const envelopeBudget = TIMELINE_PAYLOAD_BUDGET_BYTES.EXPLICIT_PAGE_OR_DETAIL;
  const valueBytes = Buffer.byteLength(value, 'utf8');
  const envelopeOverheadBytes = Buffer.byteLength(JSON.stringify({
    ...responseEnvelope,
    value: '',
    payloadBytes: 0,
    actualPayloadBytes: 0,
    payloadTruncated: false,
    hasMore: false,
  }), 'utf8');
  if (valueBytes + envelopeOverheadBytes > envelopeBudget) {
    const errorPayloadBytes = Buffer.byteLength(JSON.stringify({
      ...responseEnvelope,
      errorReason: TIMELINE_DETAIL_ERROR_REASONS.OVERSIZED,
      payloadBytes: valueBytes + envelopeOverheadBytes,
      actualPayloadBytes: valueBytes + envelopeOverheadBytes,
      payloadTruncated: true,
      hasMore: false,
    }), 'utf8');
    return {
      ok: false,
      errorReason: TIMELINE_DETAIL_ERROR_REASONS.OVERSIZED,
      payloadBytes: errorPayloadBytes,
      payloadTruncated: true,
    };
  }
  const payloadBytes = Buffer.byteLength(JSON.stringify({
    ...responseEnvelope,
    value,
    payloadBytes: 0,
    actualPayloadBytes: 0,
    payloadTruncated: false,
    hasMore: false,
  }), 'utf8');
  if (payloadBytes > TIMELINE_PAYLOAD_BUDGET_BYTES.EXPLICIT_PAGE_OR_DETAIL) {
    return {
      ok: false,
      errorReason: TIMELINE_DETAIL_ERROR_REASONS.OVERSIZED,
      payloadBytes,
      payloadTruncated: true,
    };
  }
  return {
    ok: true,
    value,
    payloadBytes,
    payloadTruncated: false,
  };
}
