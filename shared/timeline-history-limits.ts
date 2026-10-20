/**
 * Wire-level limits for timeline history/page requests.
 *
 * Keep these in shared/ so the web, bridge and daemon clamp the same request
 * shape.  A caller can ask for less, but never for an unbounded page.
 */
export const TIMELINE_HISTORY_LIMITS = {
  /** Maximum number of events in one history/page response. */
  MAX_EVENTS: 200,
  /** Maximum encoded response envelope retained on the data plane. */
  MAX_BYTES: 1024 * 1024,
} as const;

export function clampTimelineHistoryLimit(value: unknown, fallback: number = TIMELINE_HISTORY_LIMITS.MAX_EVENTS): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.max(1, Math.trunc(value)), TIMELINE_HISTORY_LIMITS.MAX_EVENTS);
}

export function clampTimelineHistoryBudget(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return TIMELINE_HISTORY_LIMITS.MAX_BYTES;
  }
  return Math.min(Math.max(1024, Math.trunc(value)), TIMELINE_HISTORY_LIMITS.MAX_BYTES);
}
