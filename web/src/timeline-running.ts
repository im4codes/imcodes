import type { TimelineEvent } from '../../src/shared/timeline/types.js';

const RUNNING_TIMELINE_EVENT_TYPES = new Set<TimelineEvent['type']>([
  'assistant.thinking',
  'assistant.text',
  'tool.call',
  'tool.result',
]);

const NEUTRAL_TAIL_EVENT_TYPES = new Set<TimelineEvent['type']>([
  'agent.status',
  'usage.update',
  'mode.state',
  'terminal.snapshot',
  'command.ack',
]);

export function isRunningTimelineEvent(event: Pick<TimelineEvent, 'type'>): boolean {
  return RUNNING_TIMELINE_EVENT_TYPES.has(event.type);
}

export function isIdleSessionStateTimelineEvent(
  event: Pick<TimelineEvent, 'type' | 'payload'>,
): boolean {
  return event.type === 'session.state' && String(event.payload.state ?? '') === 'idle';
}

export function isPendingUserMessageTimelineEvent(
  event: Pick<TimelineEvent, 'type' | 'payload'>,
): boolean {
  return event.type === 'user.message' && event.payload.pending === true;
}

export function hasActiveTimelineTurn(
  events: Array<Pick<TimelineEvent, 'type' | 'payload'>>,
): boolean {
  let userMessageTailRequiresSessionState = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (isIdleSessionStateTimelineEvent(event)) return false;
    if (event.type === 'session.state') {
      const state = String(event.payload.state ?? '');
      return state === 'running' || state === 'queued';
    }
    if (isPendingUserMessageTimelineEvent(event)) continue;
    if (event.type === 'user.message') {
      userMessageTailRequiresSessionState = true;
      continue;
    }
    if (userMessageTailRequiresSessionState && isRunningTimelineEvent(event)) continue;
    if (isRunningTimelineEvent(event)) return true;
    if (NEUTRAL_TAIL_EVENT_TYPES.has(event.type)) continue;
    return false;
  }
  return false;
}
