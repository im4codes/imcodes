import type { TimelineEvent } from '../../src/shared/timeline/types.js';
import { SDK_SUBAGENT_DETAIL_KIND } from '../../shared/sdk-subagent-status.js';
import { isAuthoritativeCleanIdlePayload, reduceTimelineActivity } from '../../shared/session-activity-types.js';

const RUNNING_TIMELINE_EVENT_TYPES = new Set<TimelineEvent['type']>([
  'assistant.thinking',
  'tool.call',
]);

const NEUTRAL_TAIL_EVENT_TYPES = new Set<TimelineEvent['type']>([
  'agent.status',
  'usage.update',
  'tool.result',
  'mode.state',
  'terminal.snapshot',
  'command.ack',
]);

type TimelineTailEvent = Pick<TimelineEvent, 'type'> & {
  payload?: TimelineEvent['payload'] | null;
};

export function isSdkSubagentTimelineEvent(event: TimelineTailEvent): boolean {
  if (event.type !== 'tool.call' && event.type !== 'tool.result') return false;
  const detail = event.payload?.detail;
  return Boolean(detail && typeof detail === 'object' && !Array.isArray(detail)
    && (detail as { kind?: unknown }).kind === SDK_SUBAGENT_DETAIL_KIND);
}

export function isRunningTimelineEvent(event: TimelineTailEvent): boolean {
  if (isSdkSubagentTimelineEvent(event)) return false;
  if (event.type === 'assistant.text') {
    return event.payload?.streaming === true;
  }
  return RUNNING_TIMELINE_EVENT_TYPES.has(event.type);
}

export function isIdleSessionStateTimelineEvent(
  event: TimelineTailEvent,
): boolean {
  return event.type === 'session.state' && String(event.payload?.state ?? '') === 'idle';
}

function isAuthoritativeCleanIdle(event: TimelineTailEvent): boolean {
  return isIdleSessionStateTimelineEvent(event)
    && isAuthoritativeCleanIdlePayload(event.payload ?? undefined);
}

function hasActiveWorkThrough(events: TimelineTailEvent[], endIndex: number): boolean {
  // SDK sub-agent rows have their own lifecycle aggregator. Treating hidden
  // wrapper tool.call events as generic open tools makes old Codex
  // collaboration rows keep the parent chat's global "working" indicator
  // alive forever, even after the dedicated SDK row has terminalized.
  const activityEvents = events.slice(0, endIndex + 1).filter((event) => !isSdkSubagentTimelineEvent(event));
  return reduceTimelineActivity(activityEvents as any).active;
}

export function isPendingUserMessageTimelineEvent(
  event: TimelineTailEvent,
): boolean {
  return event.type === 'user.message' && event.payload?.pending === true;
}

export function hasActiveTimelineTurn(
  events: TimelineTailEvent[],
): boolean {
  let userMessageTailRequiresSessionState = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (isIdleSessionStateTimelineEvent(event)) {
      if (isAuthoritativeCleanIdle(event)) return hasActiveWorkThrough(events, i);
      return hasActiveWorkThrough(events, i);
    }
    if (event.type === 'session.state') {
      const state = String(event.payload?.state ?? '');
      return state === 'running' || state === 'queued';
    }
    if (isPendingUserMessageTimelineEvent(event)) continue;
    if (event.type === 'user.message') {
      userMessageTailRequiresSessionState = true;
      continue;
    }
    if (userMessageTailRequiresSessionState && isRunningTimelineEvent(event)) continue;
    if (event.type === 'tool.result') return hasActiveWorkThrough(events, i);
    if (isRunningTimelineEvent(event)) return true;
    if (NEUTRAL_TAIL_EVENT_TYPES.has(event.type)) continue;
    return false;
  }
  return false;
}
