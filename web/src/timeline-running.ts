import type { TimelineEvent } from '../../src/shared/timeline/types.js';

const RUNNING_TIMELINE_EVENT_TYPES = new Set<TimelineEvent['type']>([
  'assistant.text',
  'tool.call',
  'tool.result',
]);

export function isRunningTimelineEvent(event: Pick<TimelineEvent, 'type'>): boolean {
  return RUNNING_TIMELINE_EVENT_TYPES.has(event.type);
}

export function isIdleSessionStateTimelineEvent(
  event: Pick<TimelineEvent, 'type' | 'payload'>,
): boolean {
  return event.type === 'session.state' && String(event.payload.state ?? '') === 'idle';
}
