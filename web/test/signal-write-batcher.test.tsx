/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { act, cleanup, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage, TimelineEvent, WsClient } from '../src/ws-client.js';
import { TimelineDB } from '../src/timeline-db.js';
import { SIGNAL_WRITE_INTERVAL_MS, createSignalWriteBatcher } from '../src/signal-write-batcher.js';
import {
  __flushTimelineSnapshotsBeforeFreezeForTests,
  __resetTimelineCacheForTests,
  useTimeline,
} from '../src/hooks/useTimeline.js';

const signal = (i: number, type: string, sessionId = 'deck_perf_brain', payload: Record<string, unknown> = {}): TimelineEvent => ({
  eventId: `${type}-${sessionId}`, type, sessionId, ts: 1000 + i, epoch: 1, seq: i, source: 'daemon', confidence: 'high', summary: true, payload,
}) as unknown as TimelineEvent;

describe('createSignalWriteBatcher', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('turns many pushes into ONE write per interval carrying the newest signal per (session, type)', () => {
    const writes: TimelineEvent[][] = [];
    const batcher = createSignalWriteBatcher({ write: (events) => writes.push(events) });
    for (let i = 1; i <= 100; i += 1) {
      batcher.push([signal(i, 'session.state', 'a', { state: i === 100 ? 'idle' : 'running' })]);
      batcher.push([signal(i, 'agent.status', 'a', { n: i }), signal(i, 'session.state', 'b', { n: i })]);
    }
    expect(writes).toHaveLength(0);
    expect(batcher.pendingCount).toBe(3);
    vi.advanceTimersByTime(SIGNAL_WRITE_INTERVAL_MS);
    expect(writes).toHaveLength(1);
    const byKey = Object.fromEntries(writes[0]!.map((e) => [`${e.sessionId}/${e.type}`, e.payload]));
    expect(byKey['a/session.state']).toEqual({ state: 'idle' });
    expect(byKey['a/agent.status']).toEqual({ n: 100 });
    expect(byKey['b/session.state']).toEqual({ n: 100 });
  });

  // Counterexample: an OLDER signal arriving late must not overwrite a newer pending one.
  it('never lets a stale signal replace a newer pending one', () => {
    const writes: TimelineEvent[][] = [];
    const batcher = createSignalWriteBatcher({ write: (events) => writes.push(events) });
    batcher.push([signal(10, 'session.state', 'a', { state: 'new' })]);
    batcher.push([signal(5, 'session.state', 'a', { state: 'stale' })]);
    batcher.flush();
    expect(writes[0]![0]!.payload).toEqual({ state: 'new' });
  });

  it('flush drains immediately and is idempotent; cancel drops pending writes; nothing is stranded past the bound', () => {
    const writes: TimelineEvent[][] = [];
    const batcher = createSignalWriteBatcher({ write: (events) => writes.push(events) });
    batcher.push([signal(1, 'usage.update')]);
    batcher.flush();
    batcher.flush();
    expect(writes).toHaveLength(1);
    batcher.push([signal(2, 'usage.update')]);
    vi.advanceTimersByTime(SIGNAL_WRITE_INTERVAL_MS + 1);
    expect(writes).toHaveLength(2);
    batcher.push([signal(3, 'usage.update')]);
    batcher.cancel();
    vi.advanceTimersByTime(10 * SIGNAL_WRITE_INTERVAL_MS);
    expect(writes).toHaveLength(2);
  });
});

describe('useTimeline persists last-value signals through the batcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => clearTimeout(id));
    __resetTimelineCacheForTests();
  });
  afterEach(() => { cleanup(); __resetTimelineCacheForTests(); vi.restoreAllMocks(); vi.useRealTimers(); });

  function mount() {
    let handler: ((m: ServerMessage) => void) | null = null;
    const ws = {
      connected: false,
      onMessage: (fn: (m: ServerMessage) => void) => { handler = fn; return () => { handler = null; }; },
      sendTimelineHistoryRequest: vi.fn(() => 'history-req'),
    } as unknown as WsClient;
    function Probe() { useTimeline('deck_perf_brain', ws, null, { isActiveSession: true, isVisible: true, subscriptionMode: 'full' }); return <div />; }
    render(<Probe />);
    return { send: (e: TimelineEvent) => handler?.({ type: 'timeline.event', event: e } as ServerMessage), ready: () => handler !== null };
  }

  it('40 signal frames produce one batched signal write per interval, and conversation events are still written at once', async () => {
    const putEvents = vi.spyOn(TimelineDB.prototype, 'putEvents').mockResolvedValue();
    const t = mount();
    await act(async () => { vi.advanceTimersByTime(20); await Promise.resolve(); });
    expect(t.ready()).toBe(true);
    putEvents.mockClear();
    for (let i = 1; i <= 40; i += 1) {
      act(() => { t.send({ ...signal(i, 'session.state', 'deck_perf_brain', { state: i % 2 ? 'running' : 'idle' }), eventId: `state-${i % 3}` } as TimelineEvent); });
      await act(async () => { vi.advanceTimersByTime(20); await Promise.resolve(); });
    }
    const signalWrites = putEvents.mock.calls.filter(([events]) => (events as TimelineEvent[]).some((e) => e.type === 'session.state'));
    expect(signalWrites.length, `signal writes in 800 ms of frames`).toBeLessThanOrEqual(1);
    await act(async () => { vi.advanceTimersByTime(SIGNAL_WRITE_INTERVAL_MS + 50); await Promise.resolve(); });
    const afterInterval = putEvents.mock.calls.filter(([events]) => (events as TimelineEvent[]).some((e) => e.type === 'session.state'));
    expect(afterInterval.length).toBeGreaterThanOrEqual(1);
    expect(afterInterval.length).toBeLessThanOrEqual(2);
    // conversation events are NOT delayed
    putEvents.mockClear();
    act(() => { t.send({ eventId: 'msg-1', type: 'assistant.text', sessionId: 'deck_perf_brain', ts: 5000, epoch: 1, seq: 500, source: 'daemon', confidence: 'high', payload: { text: 'hello', streaming: false } } as unknown as TimelineEvent); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(putEvents.mock.calls.some(([events]) => (events as TimelineEvent[]).some((e) => e.eventId === 'msg-1'))).toBe(true);
  }, 60_000);

  it('a page hide flushes pending signal writes at once (nothing lost to the interval)', async () => {
    const putEvents = vi.spyOn(TimelineDB.prototype, 'putEvents').mockResolvedValue();
    const t = mount();
    await act(async () => { vi.advanceTimersByTime(20); await Promise.resolve(); });
    putEvents.mockClear();
    act(() => { t.send(signal(1, 'session.state', 'deck_perf_brain', { state: 'idle' })); });
    await act(async () => { vi.advanceTimersByTime(80); await Promise.resolve(); await Promise.resolve(); });
    expect(putEvents.mock.calls.some(([events]) => (events as TimelineEvent[]).some((e) => e.type === 'session.state'))).toBe(false);
    __flushTimelineSnapshotsBeforeFreezeForTests();
    expect(putEvents.mock.calls.some(([events]) => (events as TimelineEvent[]).some((e) => e.type === 'session.state'))).toBe(true);
  }, 60_000);

  it('with IndexedDB unavailable the write still goes to the same putEvents (memory fallback is inside it)', async () => {
    const putEvents = vi.spyOn(TimelineDB.prototype, 'putEvents').mockRejectedValue(new Error('idb unavailable'));
    const t = mount();
    await act(async () => { vi.advanceTimersByTime(20); await Promise.resolve(); });
    act(() => { t.send(signal(1, 'session.state', 'deck_perf_brain', { state: 'idle' })); });
    await act(async () => { vi.advanceTimersByTime(SIGNAL_WRITE_INTERVAL_MS + 100); await Promise.resolve(); await Promise.resolve(); });
    expect(putEvents).toHaveBeenCalled(); // a rejected write must not throw out of the timer
  }, 60_000);
});
