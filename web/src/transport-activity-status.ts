import type { TimelineEvent } from './ws-client.js';

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function getLatestTransportActivityDetail(events: readonly TimelineEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.type !== 'session.state') continue;
    const state = String(event.payload.state ?? '');
    if (state === 'error') {
      const error = typeof event.payload.error === 'string' ? event.payload.error.trim() : '';
      return error || null;
    }
    if (state !== 'running' && state !== 'queued') return null;
    const busyReasons = stringArray(event.payload.busyReasons);
    if (busyReasons.length > 0) return busyReasons.join(', ');
    const blockingWorkCount = finiteNumber(event.payload.blockingWorkCount);
    if (blockingWorkCount !== null && blockingWorkCount > 0) return `${blockingWorkCount} active work item${blockingWorkCount === 1 ? '' : 's'}`;
    const activeWorkCount = finiteNumber(event.payload.activeWorkCount);
    if (activeWorkCount !== null && activeWorkCount > 0) return `${activeWorkCount} active work item${activeWorkCount === 1 ? '' : 's'}`;
  }
  return null;
}
