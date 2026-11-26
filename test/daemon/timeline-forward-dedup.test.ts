import { describe, expect, it } from 'vitest';
import { isDuplicateTimelineForward } from '../../src/daemon/timeline-forward-dedup.js';
import type { TimelineEvent } from '../../src/daemon/timeline-event.js';

const ev = (eventId: string, payload: Record<string, unknown> = {}, extra: Partial<TimelineEvent> = {}): TimelineEvent => ({
  eventId, sessionId: 's', ts: 1, seq: 1, epoch: 1, source: 'daemon', confidence: 'high', type: 'assistant.text', payload, ...extra,
});

describe('isDuplicateTimelineForward', () => {
  const sent = new Set(['evt-1', 'transport:abc']);
  it('drops a replay of an already-sent eventId', () => {
    expect(isDuplicateTimelineForward(ev('evt-1', { text: 'x' }), sent)).toBe(true);
  });
  it('forwards a new eventId and events without an id', () => {
    expect(isDuplicateTimelineForward(ev('evt-2'), sent)).toBe(false);
    expect(isDuplicateTimelineForward(ev(''), sent)).toBe(false);
  });
  it('never dedups transport streaming updates', () => {
    expect(isDuplicateTimelineForward(ev('transport:abc'), sent)).toBe(false);
  });
  it('never dedups a user-delete tombstone for an already-sent eventId (other devices must hide it)', () => {
    expect(isDuplicateTimelineForward(ev('evt-1', { userDeleted: true, streaming: false }, { hidden: true }), sent)).toBe(false);
  });
});
