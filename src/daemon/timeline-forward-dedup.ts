import type { TimelineEvent } from './timeline-event.js';
import { isUserDeletedTimelineEvent } from '../shared/timeline/merge.js';

/**
 * Whether the server-link timeline forwarder should drop `event` because its
 * eventId was already sent (history replays must not re-send what browsers hold).
 *
 * Never a duplicate:
 *  - transport streaming events (`transport:` prefix) reuse one eventId for
 *    in-place replacement, so every delta and the final must reach the browser;
 *  - a user-delete tombstone re-states an already-sent eventId on purpose, and
 *    viewers / other devices must receive it to hide the message.
 */
export function isDuplicateTimelineForward(event: TimelineEvent, sentEventIds: ReadonlySet<string>): boolean {
  if (!event.eventId || !sentEventIds.has(event.eventId)) return false;
  if (event.eventId.startsWith('transport:')) return false;
  return !isUserDeletedTimelineEvent(event);
}
