/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { act, cleanup, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage, TimelineEvent, WsClient } from '../src/ws-client.js';
import { __resetTimelineCacheForTests, useTimeline } from '../src/hooks/useTimeline.js';

/**
 * `session.state` is ~67% of all recorded events by the repo's own measurement,
 * and the whole last-value group is ~84%. Only the newest of each is ever
 * rendered, so committing one React update per arrival is pure churn.
 *
 * Streaming assistant.text and tool events are already frame-coalesced. These
 * tests pin the same treatment for last-value signals, and pin the properties
 * that make it safe: same-frame arrivals collapse to the LAST authoritative
 * value, and nothing is stranded if the frame never runs.
 */
function evt(i: number, type: string, payload: Record<string, unknown> = {}): TimelineEvent {
  return {
    eventId: `${type}-${i}`, type, sessionId: 'deck_perf_brain',
    ts: 1000 + i, epoch: 1, seq: i, source: 'daemon', confidence: 'high', payload,
  } as unknown as TimelineEvent;
}

function harness() {
  let handler: ((m: ServerMessage) => void) | null = null;
  const ws = {
    connected: false,
    onMessage: (fn: (m: ServerMessage) => void) => { handler = fn; return () => { handler = null; }; },
    sendTimelineHistoryRequest: vi.fn(() => 'history-req'),
  } as unknown as WsClient;
  let renders = 0;
  let last: ReturnType<typeof useTimeline> | null = null;
  function Probe() {
    renders += 1;
    last = useTimeline('deck_perf_brain', ws, null);
    return <div data-testid="n">{last.events.length}</div>;
  }
  return {
    ws, Probe,
    send: (e: TimelineEvent) => handler?.({ type: 'timeline.event', event: e } as ServerMessage),
    renders: () => renders,
    events: () => last?.events ?? [],
    ready: () => handler !== null,
  };
}

describe('last-value timeline events are frame-coalesced', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) =>
      setTimeout(() => cb(Date.now()), 0) as unknown as number);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => clearTimeout(id));
    __resetTimelineCacheForTests();
  });
  afterEach(() => { cleanup(); __resetTimelineCacheForTests(); vi.restoreAllMocks(); vi.useRealTimers(); });

  const mount = async (h2: ReturnType<typeof harness>) => {
    render(<h2.Probe />);
    await act(async () => {});
    await act(async () => { vi.runOnlyPendingTimers(); await Promise.resolve(); });
    expect(h2.ready()).toBe(true);
  };

  it('collapses a burst of session.state into a single commit', async () => {
    const t = harness();
    await mount(t);
    const before = t.renders();
    // One act() PER event: in production each WS frame is its own macrotask and
    // React auto-batching does not cross tasks. Wrapping the whole burst in a
    // single act() would batch it artificially and make this pass for the wrong
    // reason — which it did on the first draft of this test.
    for (let i = 0; i < 200; i++) {
      act(() => { t.send(evt(i, 'session.state', { state: 'running' })); });
    }
    await act(async () => { vi.runOnlyPendingTimers(); await Promise.resolve(); await Promise.resolve(); });
    const commits = t.renders() - before;
    expect(
      commits,
      `200 session.state frames produced ${commits} React commits; the coalesced types produce 1`,
    ).toBeLessThanOrEqual(2);
  }, 60_000);

  it('keeps the LAST authoritative value when several arrive in one frame', async () => {
    const t = harness();
    await mount(t);
    // Same eventId, three values in one frame: the newest must win, and the
    // superseded ones must not be observable.
    act(() => {
      t.send({ ...evt(1, 'session.state', { state: 'queued' }), eventId: 'state-1' } as TimelineEvent);
      t.send({ ...evt(2, 'session.state', { state: 'running' }), eventId: 'state-1' } as TimelineEvent);
      t.send({ ...evt(3, 'session.state', { state: 'idle' }), eventId: 'state-1' } as TimelineEvent);
    });
    await act(async () => { vi.runOnlyPendingTimers(); await Promise.resolve(); await Promise.resolve(); });
    const rows = t.events().filter((e) => e.eventId === 'state-1');
    expect(rows, 'one row, not three').toHaveLength(1);
    expect(rows[0]?.payload?.state, 'the newest value must win').toBe('idle');
  }, 60_000);

  it('does not strand a buffered value when the component unmounts before the frame runs', async () => {
    const t = harness();
    await mount(t);
    act(() => { t.send(evt(9, 'session.state', { state: 'running' })); });
    // Unmount BEFORE the frame fires. This must not throw and must not leave a
    // pending frame that fires into a dead component.
    expect(() => cleanup()).not.toThrow();
    await act(async () => { vi.runOnlyPendingTimers(); await Promise.resolve(); });
  }, 60_000);

  it('control: streaming and tool events keep their existing coalescing', async () => {
    const t = harness();
    await mount(t);
    const before = t.renders();
    for (let i = 0; i < 100; i++) {
      act(() => { t.send(evt(i, 'assistant.text', { text: `t${i}`, streaming: true })); });
    }
    for (let i = 0; i < 100; i++) {
      act(() => { t.send(evt(i, 'tool.call', { tool: 'Read', input: {} })); });
    }
    await act(async () => { vi.runOnlyPendingTimers(); await Promise.resolve(); await Promise.resolve(); });
    expect(t.renders() - before).toBeLessThanOrEqual(2);
  }, 60_000);
});
