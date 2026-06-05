/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { act, cleanup, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage, TimelineEvent, WsClient } from '../src/ws-client.js';
import {
  __getTimelineCacheForTests,
  __resetTimelineCacheForTests,
  ingestTimelineEventForCache,
  useTimeline,
} from '../src/hooks/useTimeline.js';
import { TimelineDB } from '../src/timeline-db.js';

function makeEvent(text: string, overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    eventId: 'assistant-stream',
    type: 'assistant.text',
    sessionId: 'deck_perf_brain',
    ts: 1000,
    epoch: 1,
    seq: 1,
    source: 'daemon',
    confidence: 'high',
    payload: { text, streaming: true },
    ...overrides,
  } as TimelineEvent;
}

function makeToolEvent(eventId: string, type: 'tool.call' | 'tool.result', overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    eventId,
    type,
    sessionId: 'deck_perf_brain',
    ts: 1000,
    epoch: 1,
    seq: 1,
    source: 'daemon',
    confidence: 'high',
    payload: type === 'tool.call'
      ? { tool: 'Read', input: { path: '/tmp/a.ts' } }
      : { output: 'ok' },
    ...overrides,
  } as TimelineEvent;
}

describe('useTimeline streaming coalescing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      return setTimeout(() => cb(Date.now()), 0) as unknown as number;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
      clearTimeout(id);
    });
    __resetTimelineCacheForTests();
  });

  afterEach(() => {
    cleanup();
    __resetTimelineCacheForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('coalesces streaming cache ingests until the next animation frame', () => {
    ingestTimelineEventForCache(makeEvent('h'), 'srv-1');
    ingestTimelineEventForCache(makeEvent('he', { seq: 2 }), 'srv-1');

    expect(__getTimelineCacheForTests('srv-1:deck_perf_brain')).toBeUndefined();

    act(() => {
      vi.advanceTimersByTime(1);
    });

    const cached = __getTimelineCacheForTests('srv-1:deck_perf_brain') ?? [];
    expect(cached).toHaveLength(1);
    expect(cached[0]?.payload.text).toBe('he');
  });

  it('lets a final assistant text event replace a pending streaming ingest immediately', () => {
    ingestTimelineEventForCache(makeEvent('draft'), 'srv-1');
    ingestTimelineEventForCache(makeEvent('final', {
      seq: 3,
      payload: { text: 'final', streaming: false },
    }), 'srv-1');

    let cached = __getTimelineCacheForTests('srv-1:deck_perf_brain') ?? [];
    expect(cached).toHaveLength(1);
    expect(cached[0]?.payload.text).toBe('final');
    expect(cached[0]?.payload.streaming).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });

    cached = __getTimelineCacheForTests('srv-1:deck_perf_brain') ?? [];
    expect(cached).toHaveLength(1);
    expect(cached[0]?.payload.text).toBe('final');
    expect(cached[0]?.payload.streaming).toBe(false);
  });

  it('coalesces tool cache ingests until the next animation frame', () => {
    ingestTimelineEventForCache(makeToolEvent('tool-1', 'tool.call'), 'srv-1');
    ingestTimelineEventForCache(makeToolEvent('tool-2', 'tool.result', { seq: 2 }), 'srv-1');

    expect(__getTimelineCacheForTests('srv-1:deck_perf_brain')).toBeUndefined();

    act(() => {
      vi.advanceTimersByTime(1);
    });

    const cached = __getTimelineCacheForTests('srv-1:deck_perf_brain') ?? [];
    expect(cached.map((event) => event.type)).toEqual(['tool.call', 'tool.result']);
  });

  it('coalesces live hook streaming events into one rendered state update per frame', async () => {
    let handler: ((msg: ServerMessage) => void) | null = null;
    const ws = {
      connected: false,
      onMessage: (fn: (msg: ServerMessage) => void) => {
        handler = fn;
        return () => { handler = null; };
      },
      sendTimelineHistoryRequest: vi.fn(() => 'history-req'),
    } as unknown as WsClient;

    function Probe() {
      const result = useTimeline('deck_perf_brain', ws, null);
      return <div data-testid="events">{result.events.map((event) => String(event.payload.text ?? '')).join('|')}</div>;
    }

    const { getByTestId } = render(<Probe />);
    await act(async () => {});
    await act(async () => {
      vi.runOnlyPendingTimers();
      await Promise.resolve();
    });
    expect(handler).not.toBeNull();

    act(() => {
      handler?.({ type: 'timeline.event', event: makeEvent('h') } as ServerMessage);
      handler?.({ type: 'timeline.event', event: makeEvent('hello', { seq: 2 }) } as ServerMessage);
    });

    expect(getByTestId('events').textContent).toBe('');

    await act(async () => {
      vi.runOnlyPendingTimers();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {});

    expect(__getTimelineCacheForTests('deck_perf_brain')?.[0]?.payload.text).toBe('hello');
    expect(getByTestId('events').textContent).toBe('hello');
  });

  it('persists the latest streaming assistant.text to IDB only after the stream goes idle', async () => {
    const putSpy = vi.spyOn(TimelineDB.prototype, 'putEvents').mockResolvedValue(undefined);
    const streamingPuts = (): TimelineEvent[] =>
      putSpy.mock.calls
        .flatMap(([evts]) => evts as TimelineEvent[])
        .filter((event) => event.eventId === 'assistant-stream');

    let handler: ((msg: ServerMessage) => void) | null = null;
    const ws = {
      connected: false,
      onMessage: (fn: (msg: ServerMessage) => void) => { handler = fn; return () => { handler = null; }; },
      sendTimelineHistoryRequest: vi.fn(() => 'history-req'),
    } as unknown as WsClient;

    function Probe() {
      const result = useTimeline('deck_perf_brain', ws, null);
      return <div data-testid="events">{result.events.map((event) => String(event.payload.text ?? '')).join('|')}</div>;
    }

    render(<Probe />);
    await act(async () => {});
    await act(async () => { vi.runOnlyPendingTimers(); await Promise.resolve(); });

    // Stream a couple of deltas (all streaming:true).
    act(() => {
      handler?.({ type: 'timeline.event', event: makeEvent('h') } as ServerMessage);
      handler?.({ type: 'timeline.event', event: makeEvent('hel', { seq: 2 }) } as ServerMessage);
    });
    // Flush the coalescing frame (rAF = setTimeout 0) so the cache is populated;
    // the idle-persist timer is armed but not yet due.
    await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve(); await Promise.resolve(); });

    // While the stream is live, streaming text is NOT written to IDB (too frequent).
    expect(streamingPuts()).toHaveLength(0);

    // Once it has been idle past the threshold, the LATEST text is persisted.
    await act(async () => { vi.advanceTimersByTime(2100); await Promise.resolve(); });
    const persisted = streamingPuts();
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted.at(-1)?.payload.text).toBe('hel');
    expect(persisted.at(-1)?.payload.streaming).toBe(true);
  });
});
