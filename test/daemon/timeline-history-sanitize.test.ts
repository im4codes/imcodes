import { describe, expect, it } from 'vitest';
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
});
