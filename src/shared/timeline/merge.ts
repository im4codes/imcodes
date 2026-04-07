import type { TimelineEvent } from './types.js';

function isStreaming(event: TimelineEvent): boolean {
  return event.payload.streaming === true;
}

function compareNumbers(a: number | undefined, b: number | undefined): number {
  const left = typeof a === 'number' ? a : Number.NEGATIVE_INFINITY;
  const right = typeof b === 'number' ? b : Number.NEGATIVE_INFINITY;
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

/**
 * Resolve same-eventId conflicts deterministically.
 *
 * Preference order:
 * 1. terminal/non-streaming over streaming
 * 2. newer epoch
 * 3. newer seq
 * 4. newer ts
 * 5. incoming as tie-breaker
 */
export function preferTimelineEvent(existing: TimelineEvent, incoming: TimelineEvent): TimelineEvent {
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

  return merged.length > maxEvents ? merged.slice(merged.length - maxEvents) : merged;
}
