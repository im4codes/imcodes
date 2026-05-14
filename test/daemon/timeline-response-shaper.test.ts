import { afterEach, describe, expect, it, vi } from 'vitest';
import { TIMELINE_DETAIL_ERROR_REASONS } from '../../shared/timeline-history-errors.js';
import { TIMELINE_PAYLOAD_BUDGET_BYTES } from '../../shared/timeline-payload-budget.js';
import { TIMELINE_MESSAGES, TIMELINE_RESPONSE_SOURCES, TIMELINE_RESPONSE_STATUS } from '../../shared/timeline-protocol.js';
import { shapeTimelineDetailValueForTransport, shapeTimelineEventsForTransport } from '../../src/daemon/timeline-response-shaper.js';
import type { TimelineEvent } from '../../src/shared/timeline/types.js';

function event(overrides: Partial<TimelineEvent>): TimelineEvent {
  return {
    eventId: 'evt',
    sessionId: 'deck_shape_brain',
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

describe('timeline response shaper', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unmock('node:worker_threads');
  });

  it('keeps default history/replay shaped events under the shared 256KiB envelope budget', () => {
    const events = Array.from({ length: 120 }, (_, index) => event({
      eventId: `tool-${index}`,
      ts: index,
      seq: index,
      payload: {
        tool: 'shell',
        output: `${index}: ${'x'.repeat(48 * 1024)}`,
        detail: { raw: { stdout: 'r'.repeat(512 * 1024) } },
      },
    }));

    const shaped = shapeTimelineEventsForTransport(events);

    expect(shaped.payloadBytes).toBeLessThanOrEqual(TIMELINE_PAYLOAD_BUDGET_BYTES.DEFAULT_ENVELOPE);
    expect(Buffer.byteLength(JSON.stringify(shaped.events), 'utf8')).toBeLessThanOrEqual(TIMELINE_PAYLOAD_BUDGET_BYTES.DEFAULT_ENVELOPE);
    expect(shaped.droppedEvents).toBeGreaterThan(0);
    expect(shaped.events.at(-1)?.eventId).toBe('tool-119');
  });

  it('allows explicit page responses up to the 1MiB hard cap without exceeding it', () => {
    const events = Array.from({ length: 220 }, (_, index) => event({
      eventId: `assistant-${index}`,
      type: 'assistant.text',
      ts: index,
      seq: index,
      payload: { text: `${index}: ${'y'.repeat(12 * 1024)}`, streaming: false },
    }));

    const shaped = shapeTimelineEventsForTransport(events, {
      maxResponseBytes: TIMELINE_PAYLOAD_BUDGET_BYTES.EXPLICIT_PAGE_OR_DETAIL,
    });

    expect(shaped.payloadBytes).toBeLessThanOrEqual(TIMELINE_PAYLOAD_BUDGET_BYTES.EXPLICIT_PAGE_OR_DETAIL);
    expect(Buffer.byteLength(JSON.stringify(shaped.events), 'utf8')).toBeLessThanOrEqual(TIMELINE_PAYLOAD_BUDGET_BYTES.EXPLICIT_PAGE_OR_DETAIL);
    expect(shaped.events.at(-1)?.eventId).toBe('assistant-219');
  });

  it('returns bounded timeline.detail payload metadata and rejects over-cap detail responses', () => {
    const envelope = {
      type: TIMELINE_MESSAGES.DETAIL,
      sessionName: 'deck_shape_brain',
      requestId: 'detail-shape',
      detailId: 'td_shape',
      eventId: 'evt-shape',
      fieldPath: 'payload.output',
      status: TIMELINE_RESPONSE_STATUS.OK,
      source: TIMELINE_RESPONSE_SOURCES.CACHE,
      mediaType: 'text/plain',
      epoch: 1,
    };

    const ok = shapeTimelineDetailValueForTransport('ok detail', envelope);
    expect(ok).toMatchObject({
      ok: true,
      payloadTruncated: false,
    });
    expect(ok.payloadBytes).toBeLessThanOrEqual(TIMELINE_PAYLOAD_BUDGET_BYTES.EXPLICIT_PAGE_OR_DETAIL);

    const oversized = shapeTimelineDetailValueForTransport('x'.repeat(TIMELINE_PAYLOAD_BUDGET_BYTES.EXPLICIT_PAGE_OR_DETAIL), envelope);
    expect(oversized).toMatchObject({
      ok: false,
      errorReason: TIMELINE_DETAIL_ERROR_REASONS.OVERSIZED,
      payloadTruncated: true,
    });
    expect(oversized.payloadBytes).toBeLessThanOrEqual(TIMELINE_PAYLOAD_BUDGET_BYTES.EXPLICIT_PAGE_OR_DETAIL);
  });

  it('collects worker detail candidates only for selected history events', async () => {
    vi.doMock('node:worker_threads', () => ({
      workerData: {},
      parentPort: {
        on: vi.fn(),
        postMessage: vi.fn(),
      },
    }));
    const { collectSelectedDetailCandidates } = await import('../../src/daemon/timeline-history-worker.js');
    const dropped = event({
      eventId: 'dropped-large',
      payload: { output: 'd'.repeat(32 * 1024) },
    });
    const selected = event({
      eventId: 'selected-large',
      seq: 2,
      ts: 2,
      payload: {
        output: 's'.repeat(32 * 1024),
        detail: { output: 'detail'.repeat(8 * 1024) },
      },
    });

    const candidates = collectSelectedDetailCandidates([dropped, selected], [selected]);

    expect(candidates).toEqual([
      expect.objectContaining({
        sessionName: 'deck_shape_brain',
        epoch: 1,
        eventId: 'selected-large',
        fieldPath: 'payload.output',
      }),
      expect.objectContaining({
        eventId: 'selected-large',
        fieldPath: 'payload.detail.output',
      }),
    ]);
    expect(candidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ eventId: 'dropped-large' }),
    ]));
  });
});
