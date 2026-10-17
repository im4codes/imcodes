import { TIMELINE_DETAIL_ERROR_REASONS } from '../../shared/timeline-history-errors.js';
import { TIMELINE_PAYLOAD_BUDGET_BYTES } from '../../shared/timeline-payload-budget.js';
import { sanitizeTimelineHistoryEventsForTransport, type TimelineHistorySanitizeOptions } from './timeline-history-sanitize.js';
import type { TimelineEvent } from './timeline-event.js';
import {
  AGENT_DELEGATION_REPLY_TIMELINE_EVENT,
  readAgentDelegationSupervisionTaskProjection,
  type AgentDelegationSupervisionTaskProjection,
} from '../../shared/agent-delegation.js';

export type TimelineSupervisionTaskProjectionResolver = (
  taskId: string,
  assignmentId: string,
) => AgentDelegationSupervisionTaskProjection | undefined;

/**
 * Refresh old daemon-authored task cards from the registry before transport.
 * Legacy rows may contain only the former 120-character title. Their durable
 * task/assignment ids remain authoritative, while their display text does not.
 */
export function refreshTimelineSupervisionTaskProjections(
  events: readonly TimelineEvent[],
  resolveProjection: TimelineSupervisionTaskProjectionResolver,
): TimelineEvent[] {
  const cache = new Map<string, AgentDelegationSupervisionTaskProjection | null>();
  return events.map((event) => {
    if (event.source !== 'daemon' || event.confidence !== 'high'
      || (event.type !== AGENT_DELEGATION_REPLY_TIMELINE_EVENT && event.type !== 'peer_audit.result')) {
      return event;
    }
    const stored = readAgentDelegationSupervisionTaskProjection(event.payload.supervisionTask);
    if (!stored) return event;
    const key = `${stored.taskId}\0${stored.assignmentId}`;
    let current = cache.get(key);
    if (current === undefined) {
      try {
        current = resolveProjection(stored.taskId, stored.assignmentId) ?? null;
      } catch {
        current = null;
      }
      cache.set(key, current);
    }
    if (!current) return event;
    return {
      ...event,
      payload: { ...event.payload, supervisionTask: current },
    };
  });
}

export function shapeTimelineEventsForTransport(
  events: readonly TimelineEvent[],
  options: TimelineHistorySanitizeOptions = {},
  resolveProjection?: TimelineSupervisionTaskProjectionResolver,
) {
  const projected = resolveProjection
    ? refreshTimelineSupervisionTaskProjections(events, resolveProjection)
    : events;
  return sanitizeTimelineHistoryEventsForTransport(projected, options);
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
