import { AGENT_DELEGATION_REPLY_TIMELINE_EVENT } from './agent-delegation.js';

/**
 * Observability for timeline events that are DROPPED before reaching a browser.
 *
 * Why this exists: the timeline has two silent-discard points, and both were
 * invisible.
 *
 *  1. Daemon → server. Live timeline events are control-plane, so
 *     `ServerLink.trySend` returns false and drops them whenever the socket is
 *     not OPEN. There is no queue and no replay (only the data plane has
 *     `dataPlaneSendQueue`).
 *  2. Server → browser. `sendJsonToSessionSubscribers` only writes to sockets
 *     that are currently subscribed to that session. With no subscriber the loop
 *     body never runs at all — a backgrounded app therefore has its events
 *     discarded outright.
 *
 * The healing fix (activation / reconnect requesting the full newest window with
 * no lower bound) makes the user-visible symptom go away, which is exactly why
 * these counters matter: without them a rising drop rate would now be masked by
 * recovery instead of reported. Counter names are shared so daemon and server
 * emit the same series and a regression shows up as a number, not a bug report.
 */

/** Counter names. Kept in one place so daemon/server/tests cannot drift. */
export const TIMELINE_DELIVERY_METRICS = {
  /** Daemon-side: a control-plane timeline event hit a non-OPEN socket. */
  DAEMON_LINK_DOWN_DROPPED: 'timeline.delivery.daemon_link_down_dropped',
  /** Server-side: relayed to a session with zero subscribed viewers. */
  SERVER_NO_SUBSCRIBER_DROPPED: 'timeline.delivery.server_no_subscriber_dropped',
  /** Server-side: relayed and delivered to at least one viewer. */
  SERVER_DELIVERED: 'timeline.delivery.server_delivered',
} as const;

export type TimelineDeliveryMetric =
  typeof TIMELINE_DELIVERY_METRICS[keyof typeof TIMELINE_DELIVERY_METRICS];

/**
 * Message types whose loss leaves a user-visible hole in the chat, as opposed to
 * status/telemetry chatter that the next update supersedes anyway. Only these are
 * worth counting: `agent.status` fires about once a second during a turn, so
 * counting it would bury the signal that actually matters.
 */
const CONTENT_BEARING_TIMELINE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'user.message',
  'assistant.text',
  'tool.call',
  'tool.result',
  'file.change',
  'ask.question',
  'peer_audit.result',
  AGENT_DELEGATION_REPLY_TIMELINE_EVENT,
]);

/**
 * True when a dropped `timeline.event` would leave a visible gap.
 *
 * `event` is the inner timeline event of a `timeline.event` envelope. Anything
 * unrecognised counts as NOT content-bearing so a future noisy event type cannot
 * silently inflate the drop series.
 */
export function isContentBearingTimelineEvent(event: unknown): boolean {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  const type = (event as { type?: unknown }).type;
  return typeof type === 'string' && CONTENT_BEARING_TIMELINE_EVENT_TYPES.has(type);
}

/**
 * The event type when this event is worth counting, otherwise undefined.
 *
 * Both drop sites need exactly this pair of answers (is it countable, and under
 * which label), so they share one call instead of asking twice. Callers that
 * already hold the parsed event — the server relay does — must never re-parse the
 * serialized copy just to build a counter label; that path runs for every event
 * of every session.
 */
export function countableTimelineEventType(event: unknown): string | undefined {
  if (!isContentBearingTimelineEvent(event)) return undefined;
  return (event as { type: string }).type;
}

/** Extract the timeline event type from a `timeline.event` envelope, if any. */
export function timelineEventTypeOf(msg: unknown): string | undefined {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return undefined;
  const event = (msg as { event?: unknown }).event;
  if (!event || typeof event !== 'object' || Array.isArray(event)) return undefined;
  const type = (event as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}
