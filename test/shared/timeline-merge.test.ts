import { describe, expect, it } from 'vitest';
import { mergeTimelineEvents, preferTimelineEvent } from '../../src/shared/timeline/merge.js';
import type { TimelineEvent } from '../../src/shared/timeline/types.js';

function makeEvent(overrides: Partial<TimelineEvent> & { eventId: string }): TimelineEvent {
  return {
    eventId: overrides.eventId,
    sessionId: 'session-a',
    ts: 100,
    seq: 1,
    epoch: 1,
    source: 'daemon',
    confidence: 'high',
    type: 'assistant.text',
    payload: { text: 'x' },
    ...overrides,
  };
}

describe('preferTimelineEvent', () => {
  it('prefers non-streaming terminal event over streaming event with same id', () => {
    const streaming = makeEvent({ eventId: 'transport:s:1', ts: 100, seq: 1, payload: { text: 'partial', streaming: true } });
    const final = makeEvent({ eventId: 'transport:s:1', ts: 90, seq: 1, payload: { text: 'final', streaming: false } });
    expect(preferTimelineEvent(streaming, final)).toBe(final);
    expect(preferTimelineEvent(final, streaming)).toBe(final);
  });

  it('prefers newer seq when both are same terminality', () => {
    const oldEvent = makeEvent({ eventId: 'evt-1', seq: 2, ts: 100, payload: { text: 'old' } });
    const newEvent = makeEvent({ eventId: 'evt-1', seq: 3, ts: 90, payload: { text: 'new' } });
    expect(preferTimelineEvent(oldEvent, newEvent)).toBe(newEvent);
  });
});

describe('mergeTimelineEvents', () => {
  it('keeps an existing final event when stale streaming replay arrives later', () => {
    const existing = [
      makeEvent({ eventId: 'transport:s:1', seq: 5, ts: 200, payload: { text: 'done', streaming: false } }),
    ];
    const incoming = [
      makeEvent({ eventId: 'transport:s:1', seq: 4, ts: 150, payload: { text: 'partial', streaming: true } }),
    ];

    const merged = mergeTimelineEvents(existing, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.payload.text).toBe('done');
    expect(merged[0]?.payload.streaming).toBe(false);
  });

  it('replaces a streaming event with a newer final event', () => {
    const existing = [
      makeEvent({ eventId: 'transport:s:1', seq: 4, ts: 150, payload: { text: 'partial', streaming: true } }),
    ];
    const incoming = [
      makeEvent({ eventId: 'transport:s:1', seq: 5, ts: 200, payload: { text: 'done', streaming: false } }),
    ];

    const merged = mergeTimelineEvents(existing, incoming);
    expect(merged[0]?.payload.text).toBe('done');
    expect(merged[0]?.payload.streaming).toBe(false);
  });
});
