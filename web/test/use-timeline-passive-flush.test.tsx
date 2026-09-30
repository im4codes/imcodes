/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { act, cleanup, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage, TimelineEvent, WsClient } from '../src/ws-client.js';
import { PASSIVE_TIMELINE_FLUSH_MS, __resetTimelineCacheForTests, useTimeline } from '../src/hooks/useTimeline.js';

/**
 * A passive presentation (summary-mode hidden pane / collapsed card) flushes its
 * coalesced live events on a slow cadence; anything visible or active keeps the
 * idle-frame cadence, and becoming visible flushes what accumulated at once.
 */
function evt(i: number, type: string, payload: Record<string, unknown> = {}): TimelineEvent {
  return {
    eventId: `${type}-${i}`, type, sessionId: 'deck_perf_brain',
    ts: 1000 + i, epoch: 1, seq: i, source: 'daemon', confidence: 'high', summary: true, payload,
  } as unknown as TimelineEvent;
}

type Options = Parameters<typeof useTimeline>[3];

function harness(initial: Options) {
  let handler: ((m: ServerMessage) => void) | null = null;
  const ws = {
    connected: false,
    onMessage: (fn: (m: ServerMessage) => void) => { handler = fn; return () => { handler = null; }; },
    sendTimelineHistoryRequest: vi.fn(() => 'history-req'),
  } as unknown as WsClient;
  let options = initial;
  let renders = 0;
  let last: ReturnType<typeof useTimeline> | null = null;
  function Probe() {
    renders += 1;
    last = useTimeline('deck_perf_brain', ws, null, options);
    return <div>{last.events.length}</div>;
  }
  return {
    Probe,
    setOptions: (next: Options) => { options = next; },
    send: (e: TimelineEvent) => handler?.({ type: 'timeline.event', event: e } as ServerMessage),
    renders: () => renders,
    events: () => last?.events ?? [],
    ready: () => handler !== null,
  };
}

const PASSIVE: Options = { isActiveSession: false, isVisible: false, subscriptionMode: 'summary' };
const VISIBLE: Options = { isActiveSession: false, isVisible: true, subscriptionMode: 'full' };

describe('passive timeline presentations flush slowly', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) =>
      setTimeout(() => cb(Date.now()), 0) as unknown as number);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => clearTimeout(id));
    __resetTimelineCacheForTests();
  });
  afterEach(() => { cleanup(); __resetTimelineCacheForTests(); vi.restoreAllMocks(); vi.useRealTimers(); });

  const mount = async (t: ReturnType<typeof harness>) => {
    const view = render(<t.Probe />);
    await act(async () => {});
    await act(async () => { vi.advanceTimersByTime(20); await Promise.resolve(); });
    expect(t.ready()).toBe(true);
    return view;
  };

  it('a passive pane commits nothing for a burst until the slow flush, then once with the newest values', async () => {
    const t = harness(PASSIVE);
    await mount(t);
    const before = t.renders();
    for (let i = 0; i < 100; i += 1) {
      act(() => { t.send({ ...evt(i, 'session.state', { state: i === 99 ? 'idle' : 'running' }), eventId: 'state-1' } as TimelineEvent); });
    }
    await act(async () => { vi.advanceTimersByTime(PASSIVE_TIMELINE_FLUSH_MS - 50); await Promise.resolve(); });
    expect(t.renders() - before, 'nothing committed inside the passive window').toBe(0);
    await act(async () => { vi.advanceTimersByTime(100); await Promise.resolve(); await Promise.resolve(); });
    expect(t.renders() - before).toBeLessThanOrEqual(2);
    const row = t.events().find((e) => e.eventId === 'state-1');
    expect(row?.payload?.state, 'the newest value wins').toBe('idle');
  }, 60_000);

  // Counterexample: a visible presentation must NOT be slowed down.
  it('a visible pane still commits within the idle-frame budget', async () => {
    const t = harness(VISIBLE);
    await mount(t);
    act(() => { t.send({ ...evt(1, 'session.state', { state: 'running' }), eventId: 'state-visible' } as TimelineEvent); });
    await act(async () => { vi.advanceTimersByTime(80); await Promise.resolve(); await Promise.resolve(); });
    expect(t.events().find((e) => e.eventId === 'state-visible')?.payload?.state).toBe('running');
  }, 60_000);

  it('becoming visible flushes the accumulated events immediately, without waiting for the slow timer', async () => {
    const t = harness(PASSIVE);
    const view = await mount(t);
    act(() => { t.send({ ...evt(1, 'session.state', { state: 'running' }), eventId: 'state-becomes' } as TimelineEvent); });
    await act(async () => { vi.advanceTimersByTime(100); await Promise.resolve(); });
    expect(t.events().find((e) => e.eventId === 'state-becomes')).toBeUndefined();
    t.setOptions(VISIBLE);
    view.rerender(<t.Probe />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(t.events().find((e) => e.eventId === 'state-becomes')?.payload?.state).toBe('running');
  }, 60_000);

  it('an active pane is never treated as passive even in summary mode', async () => {
    const t = harness({ isActiveSession: true, isVisible: false, subscriptionMode: 'summary' });
    await mount(t);
    act(() => { t.send({ ...evt(1, 'session.state', { state: 'running' }), eventId: 'state-active' } as TimelineEvent); });
    await act(async () => { vi.advanceTimersByTime(80); await Promise.resolve(); await Promise.resolve(); });
    expect(t.events().find((e) => e.eventId === 'state-active')?.payload?.state).toBe('running');
  }, 60_000);
});

// Two presentations of ONE session (a window and its card) share the per-session
// cache. A merge by the visible one used to re-render the passive one at once.
describe('passive presentations do not re-render on every shared-cache merge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) =>
      setTimeout(() => cb(Date.now()), 0) as unknown as number);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => clearTimeout(id));
    __resetTimelineCacheForTests();
  });
  afterEach(() => { cleanup(); __resetTimelineCacheForTests(); vi.restoreAllMocks(); vi.useRealTimers(); });

  function pair(passiveOptions: Options) {
    const handlers = new Set<(m: ServerMessage) => void>();
    const ws = {
      connected: false,
      onMessage: (fn: (m: ServerMessage) => void) => { handlers.add(fn); return () => { handlers.delete(fn); }; },
      sendTimelineHistoryRequest: vi.fn(() => 'history-req'),
    } as unknown as WsClient;
    const stats = { visibleRenders: 0, passiveRenders: 0 };
    let visibleEvents: TimelineEvent[] = [];
    let passiveEvents: TimelineEvent[] = [];
    let passiveOpts = passiveOptions;
    function Visible() {
      stats.visibleRenders += 1;
      visibleEvents = useTimeline('deck_perf_brain', ws, null, VISIBLE).events;
      return <div>v{visibleEvents.length}</div>;
    }
    function Passive() {
      stats.passiveRenders += 1;
      passiveEvents = useTimeline('deck_perf_brain', ws, null, passiveOpts).events;
      return <div>p{passiveEvents.length}</div>;
    }
    return {
      Visible, Passive, stats,
      setPassiveOptions: (next: Options) => { passiveOpts = next; },
      // The server delivers a frame to every hook's subscription; only the
      // visible hook flushes on the fast cadence, so it is the one that merges.
      send: (e: TimelineEvent) => { for (const handler of [...handlers]) handler({ type: 'timeline.event', event: e } as ServerMessage); },
      visibleEvents: () => visibleEvents,
      passiveEvents: () => passiveEvents,
    };
  }

  it('the passive hook applies the shared snapshot on the slow cadence; the visible hook does not wait', async () => {
    const t = pair(PASSIVE);
    render(<div><t.Visible /><t.Passive /></div>);
    await act(async () => {});
    await act(async () => { vi.advanceTimersByTime(20); await Promise.resolve(); });
    const passiveBefore = t.stats.passiveRenders;
    for (let i = 0; i < 40; i += 1) {
      act(() => { t.send({ ...evt(i, 'session.state', { state: i % 2 ? 'idle' : 'running' }), eventId: 'state-shared' } as TimelineEvent); });
      await act(async () => { vi.advanceTimersByTime(20); await Promise.resolve(); });
    }
    // 800 ms of 25 Hz traffic: the visible hook followed it, the passive one committed only a couple of times.
    expect(t.visibleEvents().find((e) => e.eventId === 'state-shared')).toBeDefined();
    expect(t.stats.passiveRenders - passiveBefore).toBeLessThanOrEqual(3);
    await act(async () => { vi.advanceTimersByTime(PASSIVE_TIMELINE_FLUSH_MS + 50); await Promise.resolve(); await Promise.resolve(); });
    expect(t.passiveEvents().find((e) => e.eventId === 'state-shared'), 'it converges to the same snapshot').toBeDefined();
    expect(t.passiveEvents()).toBe(t.visibleEvents());
  }, 60_000);

  // Counterexample: a second VISIBLE presentation must stay in lock-step (windows side by side).
  it('a second visible presentation follows the shared cache without the slow cadence', async () => {
    const t = pair(VISIBLE);
    render(<div><t.Visible /><t.Passive /></div>);
    await act(async () => {});
    await act(async () => { vi.advanceTimersByTime(20); await Promise.resolve(); });
    act(() => { t.send({ ...evt(1, 'session.state', { state: 'running' }), eventId: 'state-lockstep' } as TimelineEvent); });
    await act(async () => { vi.advanceTimersByTime(80); await Promise.resolve(); await Promise.resolve(); });
    expect(t.passiveEvents().find((e) => e.eventId === 'state-lockstep')?.payload?.state).toBe('running');
  }, 60_000);
});
