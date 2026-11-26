import { TIMELINE_HISTORY_LIMITS, TIMELINE_HISTORY_MIN_TEXT_FLOOR } from '../../shared/timeline-history-limits.js';
import { TIMELINE_TEXT_HISTORY_EVENT_TYPES } from '../../shared/timeline-protocol.js';
import { preferTimelineEvent } from '../shared/timeline/merge.js';
import type { TimelineEvent, TimelineEventType } from './timeline-event.js';

const TEXT_EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(TIMELINE_TEXT_HISTORY_EVENT_TYPES);

/** Return true for readable conversation text events (`user.message` / `assistant.text`). */
export function isTimelineTextHistoryEventType(type: string): boolean {
  return TEXT_EVENT_TYPE_SET.has(type);
}

/** Deterministic chronological replay ordering shared by worker and main-thread history builders. */
export function compareTimelineEventsForHistory(a: TimelineEvent, b: TimelineEvent): number {
  return a.ts - b.ts || a.seq - b.seq || a.eventId.localeCompare(b.eventId);
}

export interface SubstantiveTextFloorResult {
  selectedSubstantive: TimelineEvent[];
  hasMoreSubstantive: boolean;
  extraTextEventsRead: number;
  /** Oldest timestamp of the contiguous tail window before any older text splice (bounds stateEvents read). */
  contiguousCutoffTs: number | undefined;
  /** Oldest timestamp of the unbroken newest window for `nextCursor.beforeTs`. */
  cursorFloorTs: number | undefined;
}

/**
 * Guarantee up to `TIMELINE_HISTORY_MIN_TEXT_FLOOR` readable text events on
 * unfiltered tail reads while keeping total substantive count `<= limit` and
 * doing zero extra work when text events already fill the floor.
 */
export async function selectSubstantiveWithTextFloor(options: {
  recentSubstantive: readonly TimelineEvent[];
  limit: number;
  preserveTextFloor: boolean;
  contentTypes: readonly TimelineEventType[];
  fetchRecentTextEvents: (textLimit: number) => Promise<TimelineEvent[]> | TimelineEvent[];
}): Promise<SubstantiveTextFloorResult> {
  const { recentSubstantive, limit, preserveTextFloor, contentTypes, fetchRecentTextEvents } = options;
  const hasMoreSubstantive = recentSubstantive.length > limit;
  const contiguousTail = hasMoreSubstantive
    ? recentSubstantive.slice(recentSubstantive.length - limit)
    : [...recentSubstantive];
  const contiguousCutoffTs = contiguousTail.length > 0 ? contiguousTail[0]!.ts : undefined;

  if (!preserveTextFloor || !hasMoreSubstantive || limit <= 0) {
    return {
      selectedSubstantive: contiguousTail,
      hasMoreSubstantive,
      extraTextEventsRead: 0,
      contiguousCutoffTs,
      cursorFloorTs: contiguousCutoffTs,
    };
  }

  const textTypes = TIMELINE_TEXT_HISTORY_EVENT_TYPES.filter((type) => contentTypes.includes(type));
  const textFloorTarget = Math.min(limit, TIMELINE_HISTORY_MIN_TEXT_FLOOR);
  if (textTypes.length === 0 || textFloorTarget <= 0) {
    return {
      selectedSubstantive: contiguousTail,
      hasMoreSubstantive,
      extraTextEventsRead: 0,
      contiguousCutoffTs,
      cursorFloorTs: contiguousCutoffTs,
    };
  }

  let textCount = 0;
  for (const event of contiguousTail) {
    if (isTimelineTextHistoryEventType(event.type)) textCount += 1;
  }
  if (textCount >= textFloorTarget) {
    return {
      selectedSubstantive: contiguousTail,
      hasMoreSubstantive,
      extraTextEventsRead: 0,
      contiguousCutoffTs,
      cursorFloorTs: contiguousCutoffTs,
    };
  }

  const recentText = await fetchRecentTextEvents(textFloorTarget);
  const byId = new Map<string, TimelineEvent>();
  for (const event of contiguousTail) byId.set(event.eventId, event);
  for (const event of recentText) {
    const existing = byId.get(event.eventId);
    byId.set(event.eventId, existing ? preferTimelineEvent(existing, event) : event);
  }
  const combined = Array.from(byId.values()).sort(compareTimelineEventsForHistory);
  const allText = combined.filter((event) => isTimelineTextHistoryEventType(event.type));
  const allNonText = combined.filter((event) => !isTimelineTextHistoryEventType(event.type));

  const reservedText = allText.slice(Math.max(0, allText.length - textFloorTarget));
  const nonTextBudget = Math.max(0, limit - reservedText.length);
  const keptNonText = nonTextBudget > 0 ? allNonText.slice(Math.max(0, allNonText.length - nonTextBudget)) : [];
  const selectedSubstantive = [...reservedText, ...keptNonText].sort(compareTimelineEventsForHistory);

  const contiguousIds = new Set(contiguousTail.map((event) => event.eventId));
  const didSpliceOlderText = reservedText.some((event) => !contiguousIds.has(event.eventId));
  const cursorFloorTs = didSpliceOlderText
    ? (keptNonText[0]?.ts ?? contiguousCutoffTs)
    : (selectedSubstantive[0]?.ts ?? contiguousCutoffTs);

  return {
    selectedSubstantive,
    hasMoreSubstantive,
    extraTextEventsRead: recentText.length,
    contiguousCutoffTs,
    cursorFloorTs,
  };
}

/**
 * Interleave relevant `stateEvents` into `substantive` while keeping total
 * page count bounded at `maxTotalEvents` without ever evicting substantive rows.
 */
export function mergeSubstantiveAndStateEvents(options: {
  substantive: readonly TimelineEvent[];
  stateEvents: readonly TimelineEvent[];
  contentTypes: readonly TimelineEventType[];
  stateCutoffTs: number | undefined;
  maxTotalEvents?: number;
}): { events: TimelineEvent[]; trimmedByTotalCap: boolean } {
  const {
    substantive,
    stateEvents,
    contentTypes,
    stateCutoffTs,
    maxTotalEvents = TIMELINE_HISTORY_LIMITS.MAX_EVENTS,
  } = options;
  if (substantive.length === 0) {
    return { events: [], trimmedByTotalCap: false };
  }
  const relevantState = stateCutoffTs === undefined
    ? stateEvents
    : stateEvents.filter((event) => event.ts >= stateCutoffTs);
  const combined = relevantState.length > 0
    ? [...substantive, ...relevantState].sort(compareTimelineEventsForHistory)
    : [...substantive];
  if (combined.length <= maxTotalEvents) {
    return { events: combined, trimmedByTotalCap: false };
  }
  const contentTypeSet = new Set<string>(contentTypes);
  const content = combined.filter((event) => contentTypeSet.has(event.type));
  const state = combined.filter((event) => !contentTypeSet.has(event.type));
  const stateBudget = Math.max(0, maxTotalEvents - content.length);
  const trimmed = [...content, ...state.slice(Math.max(0, state.length - stateBudget))]
    .sort(compareTimelineEventsForHistory);
  return { events: trimmed, trimmedByTotalCap: true };
}
