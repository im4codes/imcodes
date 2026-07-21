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

  it('keeps a full event when a newer bounded preview arrives', () => {
    const full = makeEvent({ eventId: 'evt-1', seq: 2, ts: 100, payload: { text: 'full output' } });
    const preview = makeEvent({
      eventId: 'evt-1',
      seq: 3,
      ts: 200,
      payload: { text: 'preview', historyPayloadTruncated: true },
    });

    expect(preferTimelineEvent(full, preview)).toBe(full);
  });

  it('lets a full event hydrate an existing preview even when the full event is older', () => {
    const preview = makeEvent({
      eventId: 'evt-1',
      seq: 5,
      ts: 500,
      payload: { text: 'preview', historyPayloadTruncated: true },
    });
    const full = makeEvent({ eventId: 'evt-1', seq: 4, ts: 400, payload: { text: 'full output' } });

    expect(preferTimelineEvent(preview, full)).toBe(full);
  });

  it('keeps a hydrated event when a later full or preview event arrives', () => {
    const hydrated = makeEvent({
      eventId: 'evt-1',
      seq: 5,
      ts: 500,
      payload: { text: 'hydrated output', completeness: 'hydrated' },
    });
    const full = makeEvent({ eventId: 'evt-1', seq: 6, ts: 600, payload: { text: 'full output', completeness: 'full' } });
    const preview = makeEvent({
      eventId: 'evt-1',
      seq: 7,
      ts: 700,
      payload: { text: 'preview', completeness: 'preview', detailRefs: [{ detailId: 'td_1', fieldPath: 'payload.text' }] },
    });

    expect(preferTimelineEvent(hydrated, full)).toBe(hydrated);
    expect(preferTimelineEvent(hydrated, preview)).toBe(hydrated);
  });

  it('honors explicit top-level completeness metadata', () => {
    const full = makeEvent({ eventId: 'evt-1', seq: 1, ts: 100, payload: { text: 'full payload' }, completeness: 'full' });
    const preview = makeEvent({ eventId: 'evt-1', seq: 2, ts: 200, payload: { text: 'preview payload' }, completeness: 'preview' });

    expect(preferTimelineEvent(full, preview)).toBe(full);
  });

  it('keeps an earlier usage snapshot when terminal metadata updates the same event id', () => {
    const tokens = makeEvent({
      eventId: 'transport:s:msg-1:usage',
      type: 'usage.update',
      seq: 8,
      payload: {
        inputTokens: 22,
        cacheTokens: 36_608,
        outputTokens: 10,
        model: 'opencode/deepseek-v4-flash-free',
        contextWindow: 200_000,
        contextWindowSource: 'provider',
        streaming: false,
      },
    });
    const terminalMetadata = makeEvent({
      eventId: 'transport:s:msg-1:usage',
      type: 'usage.update',
      seq: 14,
      payload: {
        model: 'opencode/deepseek-v4-flash-free',
        contextWindow: 1_000_000,
      },
    });

    const merged = preferTimelineEvent(tokens, terminalMetadata);

    expect(merged.seq).toBe(14);
    expect(merged.payload).toMatchObject({
      inputTokens: 22,
      cacheTokens: 36_608,
      outputTokens: 10,
      model: 'opencode/deepseek-v4-flash-free',
      contextWindow: 1_000_000,
    });
    expect(merged.payload).not.toHaveProperty('contextWindowSource');
    expect(preferTimelineEvent(terminalMetadata, tokens).payload).toEqual(merged.payload);
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

  it('does not overwrite a full cached event with an incoming preview event', () => {
    const existing = [
      makeEvent({ eventId: 'evt-1', seq: 10, ts: 1000, payload: { text: 'full output' } }),
    ];
    const incoming = [
      makeEvent({
        eventId: 'evt-1',
        seq: 11,
        ts: 1100,
        payload: { text: 'preview', historyPayloadTruncated: true },
      }),
    ];

    const merged = mergeTimelineEvents(existing, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.payload.text).toBe('full output');
  });

  it('heals a cached late-cancel event that was appended after a newer user message', () => {
    const existing = [
      makeEvent({
        eventId: 'new-user',
        seq: 14,
        ts: 200,
        type: 'user.message',
        payload: { text: 'new message after stop' },
      }),
      makeEvent({
        eventId: 'old-assistant',
        seq: 1,
        ts: 100,
        payload: { text: 'old partial', streaming: true },
      }),
    ];
    const incoming = [
      makeEvent({
        eventId: 'old-assistant',
        seq: 15,
        ts: 100,
        payload: { text: 'old partial\n\n⚠️ Turn cancelled', streaming: false },
      }),
    ];

    const merged = mergeTimelineEvents(existing, incoming);

    expect(merged.map((event) => event.eventId)).toEqual(['old-assistant', 'new-user']);
    expect(merged[0]?.payload.text).toContain('Turn cancelled');
  });
});
