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

  it('lets a newer streaming delta past an older hydrated snapshot of the same message', () => {
    // Detail hydration rebuilds the event as `{ ...existing, payload }`, so the
    // hydrated copy carries the seq of the snapshot it hydrated. Ranking
    // completeness first made that stale snapshot outrank every delta still
    // arriving: the merge reported no change and the message stopped updating
    // until the terminal event replaced it, so the whole reply appeared at once.
    const hydratedMidStream = makeEvent({
      eventId: 'evt-1',
      seq: 5,
      ts: 500,
      payload: { text: 'hello wo', streaming: true, completeness: 'hydrated' },
    });
    const nextDelta = makeEvent({
      eventId: 'evt-1',
      seq: 9,
      ts: 900,
      payload: { text: 'hello world, and then some', streaming: true },
    });

    expect(preferTimelineEvent(hydratedMidStream, nextDelta)).toBe(nextDelta);
    // Order must not matter: the same pair seen the other way round agrees.
    expect(preferTimelineEvent(nextDelta, hydratedMidStream)).toBe(nextDelta);
  });

  it('still lets the terminal event replace a hydrated streaming snapshot', () => {
    const hydratedMidStream = makeEvent({
      eventId: 'evt-1',
      seq: 5,
      payload: { text: 'partial', streaming: true, completeness: 'hydrated' },
    });
    const terminal = makeEvent({
      eventId: 'evt-1',
      seq: 9,
      payload: { text: 'final text' },
    });

    expect(preferTimelineEvent(hydratedMidStream, terminal)).toBe(terminal);
  });

  it('still prefers the more complete payload when two streaming versions share a seq', () => {
    // Same generation, so there is no freshness signal to go on — completeness
    // remains the tie-breaker and a truncated copy must not win.
    const truncated = makeEvent({
      eventId: 'evt-1',
      seq: 5,
      payload: {
        text: 'trunc', streaming: true, completeness: 'preview',
        detailRefs: [{ detailId: 'td_1', fieldPath: 'payload.text' }],
      },
    });
    const hydrated = makeEvent({
      eventId: 'evt-1',
      seq: 5,
      payload: { text: 'full text', streaming: true, completeness: 'hydrated' },
    });

    expect(preferTimelineEvent(truncated, hydrated)).toBe(hydrated);
    expect(preferTimelineEvent(hydrated, truncated)).toBe(hydrated);
  });

  it('honors explicit top-level completeness metadata', () => {
    const full = makeEvent({ eventId: 'evt-1', seq: 1, ts: 100, payload: { text: 'full payload' }, completeness: 'full' });
    const preview = makeEvent({ eventId: 'evt-1', seq: 2, ts: 200, payload: { text: 'preview payload' }, completeness: 'preview' });

    expect(preferTimelineEvent(full, preview)).toBe(full);
  });

  it('keeps provider-authoritative usage context when inferred terminal metadata updates the same event id', () => {
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
      contextWindow: 200_000,
      contextWindowSource: 'provider',
    });
    expect(preferTimelineEvent(terminalMetadata, tokens).payload).toEqual(merged.payload);
  });

  it('does not carry authoritative context across different models sharing a malformed event id', () => {
    const providerUsage = makeEvent({
      eventId: 'transport:s:msg-1:usage',
      type: 'usage.update',
      seq: 8,
      payload: {
        model: 'opencode/deepseek-v4-flash-free',
        contextWindow: 200_000,
        contextWindowSource: 'provider',
      },
    });
    const newerModel = makeEvent({
      eventId: 'transport:s:msg-1:usage',
      type: 'usage.update',
      seq: 14,
      payload: {
        model: 'opencode/deepseek-v4-pro',
        contextWindow: 1_000_000,
      },
    });

    expect(preferTimelineEvent(providerUsage, newerModel).payload).toEqual(newerModel.payload);
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
