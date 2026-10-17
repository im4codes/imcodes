import { SUPERVISION_ASSIGNMENT_STATUS_TIMELINE_EVENT } from '@shared/supervision-assignment-start.js';
import type { TimelineEvent } from '../ws-client.js';

/** One daemon-announced lifecycle status and when the daemon observed it. */
export interface LiveAssignmentStatus {
  status: string;
  /** Daemon time the status was observed; comparable to a dispatch card's own time. */
  ts: number;
}

/**
 * Latest daemon-announced lifecycle status per assignment id.
 *
 * The daemon emits a hidden `supervision.assignment.status` event on the
 * coordinating Brain's timeline when it observes a dispatched assignment's
 * lifecycle (for example the automatic delegated -> implementing start). A
 * dispatch card captured its status at send time; an announcement only
 * supersedes that snapshot when it is NEWER than the card (see
 * `resolveCardAssignmentStatus`), so a stale announcement never overwrites a
 * later card's fresher snapshot.
 */
export function deriveLiveAssignmentStatuses(events: readonly TimelineEvent[]): ReadonlyMap<string, LiveAssignmentStatus> {
  const latest = new Map<string, LiveAssignmentStatus>();
  for (const event of events) {
    if (event.type !== SUPERVISION_ASSIGNMENT_STATUS_TIMELINE_EVENT) continue;
    const assignmentId = typeof event.payload?.assignmentId === 'string' ? event.payload.assignmentId.trim() : '';
    const status = typeof event.payload?.status === 'string' ? event.payload.status.trim() : '';
    if (!assignmentId || !status || !Number.isFinite(event.ts)) continue;
    const previous = latest.get(assignmentId);
    if (!previous || event.ts >= previous.ts) latest.set(assignmentId, { status, ts: event.ts });
  }
  return latest;
}

/**
 * The status a dispatch card should show: the newest of its own send-time
 * snapshot and the daemon's announcement. Without a known card time only the
 * snapshot is trusted.
 */
export function resolveCardAssignmentStatus(input: {
  sentStatus: string | undefined;
  live: LiveAssignmentStatus | undefined;
  cardTs: number | undefined;
}): string | undefined {
  const { sentStatus, live, cardTs } = input;
  if (!live) return sentStatus;
  if (cardTs === undefined || !Number.isFinite(cardTs)) return sentStatus ?? undefined;
  return live.ts >= cardTs ? live.status : sentStatus;
}

/**
 * A stable content key for the derived map, so a memoized consumer only
 * re-renders when an announcement actually changes rather than on every event.
 */
export function liveAssignmentStatusesKey(statuses: ReadonlyMap<string, LiveAssignmentStatus>): string {
  return JSON.stringify([...statuses].sort(([left], [right]) => left.localeCompare(right)));
}
