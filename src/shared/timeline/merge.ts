import type { TimelineEvent } from './types.js';
import {
  TIMELINE_DETAIL_FIELD_PATHS as SHARED_TIMELINE_DETAIL_FIELD_PATHS,
  type TimelineDetailFieldPath,
} from '../../../shared/timeline-protocol.js';
import {
  usageContextWindowSourceRank,
  type UsageContextWindowSource,
} from '../../../shared/usage-context-window.js';

export const TIMELINE_DETAIL_FIELD_PATHS = Object.values(SHARED_TIMELINE_DETAIL_FIELD_PATHS) as TimelineDetailFieldPath[];
export type { TimelineDetailFieldPath };

function isStreaming(event: TimelineEvent): boolean {
  return event.payload.streaming === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasDetailRefs(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function getCompletenessRank(event: TimelineEvent): number {
  const eventRecord = event as unknown as Record<string, unknown>;
  const payload = event.payload;
  const completeness = payload.completeness ?? payload.timelineCompleteness ?? eventRecord.completeness ?? eventRecord.timelineCompleteness;
  if (completeness === 'hydrated') return 2;
  if (completeness === 'full') return 1;
  if (payload.historyPayloadTruncated === true) return 0;
  if (payload.payloadTruncated === true) return 0;
  if (payload.timelinePayloadTruncated === true) return 0;
  if (payload.completeness === 'preview') return 0;
  if (payload.timelineCompleteness === 'preview') return 0;
  if (eventRecord.completeness === 'preview') return 0;
  if (eventRecord.timelineCompleteness === 'preview') return 0;
  if (hasDetailRefs(payload.detailRefs)) return 0;
  if (hasDetailRefs(eventRecord.detailRefs)) return 0;
  if (isRecord(payload.detail) && payload.detail.truncated === true) return 0;
  return 1;
}

function compareCompleteness(existing: TimelineEvent, incoming: TimelineEvent): number {
  const existingRank = getCompletenessRank(existing);
  const incomingRank = getCompletenessRank(incoming);
  if (existingRank === incomingRank) return 0;
  return incomingRank > existingRank ? 1 : -1;
}

function compareNumbers(a: number | undefined, b: number | undefined): number {
  const left = typeof a === 'number' ? a : Number.NEGATIVE_INFINITY;
  const right = typeof b === 'number' ? b : Number.NEGATIVE_INFINITY;
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

const USAGE_SNAPSHOT_PAYLOAD_KEYS = [
  'inputTokens',
  'cacheTokens',
  'outputTokens',
  'costUsd',
  'codexStatus',
] as const;

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function canShareUsageContext(preferred: TimelineEvent, alternate: TimelineEvent): boolean {
  const preferredModel = preferred.payload.model;
  const alternateModel = alternate.payload.model;
  return typeof preferredModel !== 'string'
    || typeof alternateModel !== 'string'
    || preferredModel === alternateModel;
}

/**
 * A stable usage event can be updated twice by a transport provider: once with
 * the token snapshot and later with model/context metadata from the terminal
 * completion. Timeline storage is keyed by eventId, so treating the latter as
 * a full replacement would erase the token snapshot and make the UI show 0.
 *
 * Carry forward occupancy/cost fields, plus a stronger authoritative context
 * window for the same model. A terminal metadata frame may contain only a
 * model-name inference; it must not replace a provider/preset window already
 * reported for that exact usage event.
 */
function supplementUsageSnapshot(
  preferred: TimelineEvent,
  alternate: TimelineEvent,
): TimelineEvent {
  if (preferred.type !== 'usage.update' || alternate.type !== 'usage.update') return preferred;
  let payload: TimelineEvent['payload'] | undefined;
  for (const key of USAGE_SNAPSHOT_PAYLOAD_KEYS) {
    if (hasOwn(preferred.payload, key) || !hasOwn(alternate.payload, key)) continue;
    payload ??= { ...preferred.payload };
    payload[key] = alternate.payload[key];
  }
  const preferredContextRank = usageContextWindowSourceRank(preferred.payload.contextWindowSource);
  const alternateContextRank = usageContextWindowSourceRank(alternate.payload.contextWindowSource);
  if (
    alternateContextRank > preferredContextRank
    && typeof alternate.payload.contextWindow === 'number'
    && Number.isFinite(alternate.payload.contextWindow)
    && alternate.payload.contextWindow > 0
    && canShareUsageContext(preferred, alternate)
  ) {
    payload ??= { ...preferred.payload };
    payload.contextWindow = alternate.payload.contextWindow;
    payload.contextWindowSource = alternate.payload.contextWindowSource as UsageContextWindowSource;
  }
  return payload ? { ...preferred, payload } : preferred;
}

function choosePreferredTimelineEvent(existing: TimelineEvent, incoming: TimelineEvent): TimelineEvent {
  const completenessCmp = compareCompleteness(existing, incoming);
  if (completenessCmp !== 0) return completenessCmp > 0 ? incoming : existing;

  const existingStreaming = isStreaming(existing);
  const incomingStreaming = isStreaming(incoming);
  if (existingStreaming !== incomingStreaming) {
    return incomingStreaming ? existing : incoming;
  }

  const epochCmp = compareNumbers(incoming.epoch, existing.epoch);
  if (epochCmp !== 0) return epochCmp > 0 ? incoming : existing;

  const seqCmp = compareNumbers(incoming.seq, existing.seq);
  if (seqCmp !== 0) return seqCmp > 0 ? incoming : existing;

  const tsCmp = compareNumbers(incoming.ts, existing.ts);
  if (tsCmp !== 0) return tsCmp > 0 ? incoming : existing;

  return incoming;
}

/**
 * Resolve same-eventId conflicts deterministically.
 *
 * Preference order:
 * 1. full events over preview events
 * 2. terminal/non-streaming over streaming
 * 3. newer epoch
 * 4. newer seq
 * 5. newer ts
 * 6. incoming as tie-breaker
 */
export function preferTimelineEvent(existing: TimelineEvent, incoming: TimelineEvent): TimelineEvent {
  const preferred = choosePreferredTimelineEvent(existing, incoming);
  const alternate = preferred === existing ? incoming : existing;
  return supplementUsageSnapshot(preferred, alternate);
}

export function mergeTimelineEvents(
  existingEvents: TimelineEvent[],
  incomingEvents: TimelineEvent[],
  maxEvents = 300,
): TimelineEvent[] {
  const incomingById = new Map<string, TimelineEvent>();
  for (const event of incomingEvents) {
    const prev = incomingById.get(event.eventId);
    incomingById.set(event.eventId, prev ? preferTimelineEvent(prev, event) : event);
  }

  let changed = false;
  const replaced = existingEvents.map((event) => {
    const next = incomingById.get(event.eventId);
    if (!next) return event;
    incomingById.delete(event.eventId);
    const preferred = preferTimelineEvent(event, next);
    if (preferred !== event) changed = true;
    return preferred;
  });

  const newEvents = [...incomingById.values()].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  if (!changed && newEvents.length === 0) return existingEvents;

  const merged: TimelineEvent[] = [];
  let i = 0;
  let j = 0;
  while (i < replaced.length && j < newEvents.length) {
    const left = replaced[i]!;
    const right = newEvents[j]!;
    if (left.ts < right.ts || (left.ts === right.ts && left.seq <= right.seq)) merged.push(replaced[i++]!);
    else merged.push(newEvents[j++]!);
  }
  while (i < replaced.length) merged.push(replaced[i++]!);
  while (j < newEvents.length) merged.push(newEvents[j++]!);

  const bounded = merged.length > maxEvents ? merged.slice(merged.length - maxEvents) : merged;

  // Older web builds appended late realtime terminal events at the tail even
  // when their stable timestamp belonged to an earlier turn. That bad order
  // can survive in IndexedDB and be supplied back as `existingEvents`. The
  // two-pointer merge assumes an ordered base, so detect (cheap O(n)) and heal
  // only those legacy/out-of-order arrays. This also makes a same-eventId final
  // replacement move back ahead of a post-Stop user message on reconnect.
  for (let index = 1; index < bounded.length; index += 1) {
    const previous = bounded[index - 1]!;
    const current = bounded[index]!;
    if (previous.ts > current.ts || (previous.ts === current.ts && previous.seq > current.seq)) {
      return [...bounded].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    }
  }

  return bounded;
}
