import { describe, expect, it, vi } from 'vitest';
import type { TimelineEvent } from '../../src/shared/timeline/types.js';
import { sanitizeTimelineHistoryEventsForTransport } from '../../src/daemon/timeline-history-sanitize.js';

function event(overrides: Partial<TimelineEvent>): TimelineEvent {
  return {
    eventId: 'evt',
    sessionId: 'deck_hist',
    ts: 1,
    seq: 1,
    epoch: 1,
    source: 'daemon',
    confidence: 'high',
    type: 'tool.result',
    payload: {},
    ...overrides,
  };
}

describe('timeline history transport sanitization', () => {
  it('caps large tool payloads before history responses leave the daemon', () => {
    const huge = 'x'.repeat(2 * 1024 * 1024);
    const result = sanitizeTimelineHistoryEventsForTransport([
      event({
        eventId: 'tool-big',
        payload: {
          output: huge,
          detail: {
            output: huge,
            raw: {
              aggregatedOutput: huge,
              nested: { output: huge },
            },
          },
        },
      }),
    ]);

    expect(result.events).toHaveLength(1);
    expect(result.truncatedEvents).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(result.events[0]), 'utf8')).toBeLessThan(40 * 1024);
    expect(JSON.stringify(result.events[0])).toContain('history truncated');
  });

  it('adds opaque detail refs for omitted large renderable fields', () => {
    const refs: unknown[] = [];
    const huge = 'x'.repeat(32 * 1024);
    const result = sanitizeTimelineHistoryEventsForTransport([
      event({
        eventId: 'tool-detail-ref',
        payload: {
          output: huge,
          detail: {
            output: huge,
          },
        },
      }),
    ], {
      detailSink: {
        put: (input) => {
          refs.push(input);
          return {
            detailId: 'opaque-detail-1',
            eventId: input.eventId,
            fieldPath: input.fieldPath,
            previewBytes: input.previewBytes,
            expiresAt: 123,
          };
        },
      },
    });

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      sessionName: 'deck_hist',
      eventId: 'tool-detail-ref',
      fieldPath: 'payload.output',
    });
    expect(result.detailRefs).toEqual([expect.objectContaining({
      detailId: 'opaque-detail-1',
      eventId: 'tool-detail-ref',
      fieldPath: 'payload.output',
    })]);
  });

  it('keeps the newest events when the history batch exceeds the response budget', () => {
    const events = Array.from({ length: 30 }, (_, index) => event({
      eventId: `assistant-${index}`,
      type: 'assistant.text',
      ts: index,
      seq: index,
      payload: { text: `${index}: ${'y'.repeat(20 * 1024)}`, streaming: false },
    }));

    const result = sanitizeTimelineHistoryEventsForTransport(events, {
      maxResponseBytes: 96 * 1024,
    });

    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.length).toBeLessThan(events.length);
    expect(result.droppedEvents).toBeGreaterThan(0);
    expect(result.events.at(-1)?.eventId).toBe('assistant-29');
  });

  it('does not register detail refs for events dropped by the response budget', () => {
    const registered: Array<{ eventId: string; fieldPath: string }> = [];
    const events = Array.from({ length: 120 }, (_, index) => event({
      eventId: `tool-${index}`,
      ts: index,
      seq: index,
      payload: { output: `${index}:${'x'.repeat(32 * 1024)}` },
    }));

    const result = sanitizeTimelineHistoryEventsForTransport(events, {
      maxResponseBytes: 64 * 1024,
      detailSink: {
        put: (input) => {
          registered.push({ eventId: input.eventId, fieldPath: input.fieldPath });
          return {
            detailId: `td_${input.eventId}`,
            eventId: input.eventId,
            fieldPath: input.fieldPath,
            previewBytes: input.previewBytes,
            expiresAt: 123,
          };
        },
      },
    });
    const selectedIds = new Set(result.events.map((entry) => entry.eventId));

    expect(result.droppedEvents).toBeGreaterThan(0);
    expect(selectedIds.has('tool-119')).toBe(true);
    expect(registered.length).toBeGreaterThan(0);
    expect(registered.every((ref) => selectedIds.has(ref.eventId))).toBe(true);
    expect(registered).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ eventId: 'tool-0' }),
    ]));
  });

  it('does not call raw toJSON hooks while shaping large timeline payloads', () => {
    const payloadToJson = vi.fn(() => {
      throw new Error('raw payload stringify should not run');
    });
    const eventToJson = vi.fn(() => {
      throw new Error('raw event stringify should not run');
    });
    const rawEvent = Object.assign(event({
      eventId: 'tool-to-json',
      payload: {
        output: 'z'.repeat(2 * 1024 * 1024),
        toJSON: payloadToJson,
      } as Record<string, unknown>,
    }), { toJSON: eventToJson });

    const result = sanitizeTimelineHistoryEventsForTransport([rawEvent], {
      maxResponseBytes: 128 * 1024,
    });

    expect(result.events).toHaveLength(1);
    expect(result.truncatedEvents).toBeGreaterThan(0);
    expect(payloadToJson).not.toHaveBeenCalled();
    expect(eventToJson).not.toHaveBeenCalled();
  });
});
