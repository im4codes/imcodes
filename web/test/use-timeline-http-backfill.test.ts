/**
 * @vitest-environment jsdom
 *
 * Covers the delayed HTTP backfill path in `useTimeline`'s reconnect branch.
 * The WS subscribe → timeline.event routing has an ~10–100ms race window
 * where events emitted during the bridge's async ownership check can be
 * dropped; the HTTP backfill reads the daemon store directly and catches
 * those. Merge dedup by eventId keeps the WS + HTTP paths idempotent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mock: must run before useTimeline is imported so the hook picks up
// our spy rather than the real apiFetch wrapper.
const fetchSpy = vi.hoisted(() => vi.fn());
const fetchTextTailSpy = vi.hoisted(() => vi.fn());
vi.mock('../src/api.js', () => ({
  fetchTimelineHistoryHttp: fetchSpy,
  fetchTimelineTextTailHttp: fetchTextTailSpy,
}));

import { render, screen, cleanup, act, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import type { ServerMessage, TimelineEvent, WsClient } from '../src/ws-client.js';
import {
  __resetBackfillCooldownsForTests,
  __resetTimelineCacheForTests,
  ingestTimelineEventForCache,
  ACTIVE_TIMELINE_REFRESH_EVENT,
  useTimeline,
} from '../src/hooks/useTimeline.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useTimeline — HTTP backfill on WS reconnect', () => {
  beforeEach(() => {
    __resetTimelineCacheForTests();
    cleanup();
    fetchSpy.mockReset();
    fetchTextTailSpy.mockReset();
    fetchTextTailSpy.mockResolvedValue(null);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires HTTP backfill ~600ms after reconnect and merges recovered events', async () => {
    const sessionName = `deck_http_backfill_${Date.now()}`;
    const serverId = `srv-${Date.now()}`;

    // Simulate a recovered event the WS path dropped during subscribe race.
    const recovered: TimelineEvent = {
      eventId: `${sessionName}-recovered-1`,
      sessionId: sessionName,
      ts: 7500,
      epoch: 1,
      seq: 3,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'recovered-by-http' },
    };
    fetchSpy.mockResolvedValue({ events: [recovered], epoch: 1, hasMore: false, nextCursor: null });

    // Seed one local event so the reconnect handler has a non-trivial afterTs.
    ingestTimelineEventForCache({
      eventId: `${sessionName}-local-1`,
      sessionId: sessionName,
      ts: 5000,
      epoch: 1,
      seq: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'local' },
    }, serverId);

    let handler: ((msg: ServerMessage) => void) | null = null;
    const ws: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineReplayRequest: vi.fn(() => 'replay-reconnect'),
      sendTimelineHistoryRequest: vi.fn(() => 'history-reconnect'),
    } as unknown as WsClient;

    function Probe() {
      const { events } = useTimeline(sessionName, ws, serverId);
      return h(
        'div',
        { 'data-testid': 'probe' },
        events.map((e) => String(e.payload.text ?? '')).join('|'),
      );
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe));
    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toContain('local');
    });

    // Consume the mount-time backfill (200ms) before simulating the reconnect
    // so we can cleanly assert the reconnect-only behavior below.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    fetchSpy.mockClear();

    // Simulate browser WS reconnect.
    await act(async () => {
      handler?.({ type: 'session.event', event: 'connected', session: '', state: 'connected' } as ServerMessage);
    });

    expect(ws.sendTimelineReplayRequest).toHaveBeenCalledWith(
      sessionName,
      3,
      1,
    );
    expect(ws.sendTimelineHistoryRequest).toHaveBeenCalledWith(
      sessionName,
      300,
      7499,
    );

    // Before the delay expires, backfill should not have fired.
    expect(fetchSpy).not.toHaveBeenCalled();

    // Advance past the 600ms delay; backfill fires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(650);
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // The cursor is recomputed at fire time from currently-rendered events.
    // The mount-time backfill already merged `recovered` (ts=7500) before we
    // cleared the spy, so the reconnect-time cursor reflects that — it
    // correctly won't re-download the same event.
    expect(fetchSpy).toHaveBeenCalledWith(
      serverId,
      sessionName,
      expect.objectContaining({ afterTs: 7499 }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toContain('recovered-by-http');
    });
  });

  it('does not fire HTTP backfill when serverId is missing (would hit wrong pod)', async () => {
    // serverId is required for pod-sticky routing — without it we can't safely
    // call the REST endpoint. The reconnect path should skip backfill entirely.
    const sessionName = `deck_http_backfill_no_serverid_${Date.now()}`;

    let handler: ((msg: ServerMessage) => void) | null = null;
    const ws: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineReplayRequest: vi.fn(() => 'replay-no-server'),
      sendTimelineHistoryRequest: vi.fn(() => 'history-no-server'),
    } as unknown as WsClient;

    function Probe() {
      useTimeline(sessionName, ws, null);
      return h('div', { 'data-testid': 'probe' }, 'mounted');
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe));
    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('mounted');
    });

    await act(async () => {
      handler?.({ type: 'session.event', event: 'connected', session: '', state: 'connected' } as ServerMessage);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('swallows HTTP backfill failures so they do not break the WS path', async () => {
    const sessionName = `deck_http_backfill_fail_${Date.now()}`;
    const serverId = `srv-fail-${Date.now()}`;

    // fetchTimelineHistoryHttp is contracted to return null on transient
    // failures (daemon offline, pod miss, network). The hook must not throw.
    fetchSpy.mockResolvedValue(null);

    ingestTimelineEventForCache({
      eventId: `${sessionName}-seed`,
      sessionId: sessionName,
      ts: 1000,
      epoch: 1,
      seq: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'seed' },
    }, serverId);

    let handler: ((msg: ServerMessage) => void) | null = null;
    const ws: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineReplayRequest: vi.fn(() => 'replay-fail'),
      sendTimelineHistoryRequest: vi.fn(() => 'history-fail'),
    } as unknown as WsClient;

    function Probe() {
      useTimeline(sessionName, ws, serverId);
      return h('div', { 'data-testid': 'probe' }, 'mounted');
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe));
    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('mounted');
    });

    // Drain the mount-time backfill so the post-reconnect assertion below
    // counts only the reconnect-path fire.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    fetchSpy.mockClear();

    await act(async () => {
      handler?.({ type: 'session.event', event: 'connected', session: '', state: 'connected' } as ServerMessage);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(650);
    });

    // Backfill was attempted and returned null — no crash, no merge.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Hook is still responsive after null response.
    expect(screen.getByTestId('probe').textContent).toBe('mounted');
  });

  it('fires HTTP backfill on session mount (memory-cache path) even without a WS reconnect', async () => {
    // Regression: before this change the HTTP backfill only ran on the
    // WS `session.event connected` message. That left a gap for
    // "user opens a session window while the WS is already connected" —
    // e.g. switching between sessions, reopening a minimized pane,
    // navigating back to a tab after background throttling. The
    // memory-cached events rendered instantly but any daemon-side writes
    // made while this window wasn't visible were missed until the next
    // full reconnect. Now every session mount fires a background
    // backfill ~200ms after render.
    const sessionName = `deck_http_backfill_mount_${Date.now()}`;
    const serverId = `srv-mount-${Date.now()}`;

    const recovered: TimelineEvent = {
      eventId: `${sessionName}-recovered-mount`,
      sessionId: sessionName,
      ts: 9000,
      epoch: 1,
      seq: 4,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'mount-backfill' },
    };
    fetchSpy.mockResolvedValue({ events: [recovered], epoch: 1, hasMore: false, nextCursor: null });

    // Seed a cached event so the mount effect takes path 1 (memory-cache
    // hit). The mount still needs to fire HTTP backfill alongside the
    // synchronous render.
    ingestTimelineEventForCache({
      eventId: `${sessionName}-seed`,
      sessionId: sessionName,
      ts: 6000,
      epoch: 1,
      seq: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'cached' },
    }, serverId);

    const ws: WsClient = {
      connected: true,
      onMessage: () => () => {},
      sendTimelineReplayRequest: vi.fn(() => 'replay-mount'),
      sendTimelineHistoryRequest: vi.fn(() => 'history-mount'),
    } as unknown as WsClient;

    function Probe() {
      const { events } = useTimeline(sessionName, ws, serverId);
      return h(
        'div',
        { 'data-testid': 'probe' },
        events.map((e) => String(e.payload.text ?? '')).join('|'),
      );
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe));
    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toContain('cached');
    });

    // No backfill yet — the 200ms delay is still running.
    expect(fetchSpy).not.toHaveBeenCalled();

    // Drive past the mount-time 200ms delay without firing any WS
    // reconnect event. The hook should still have scheduled a backfill.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      serverId,
      sessionName,
      expect.objectContaining({ afterTs: 5999 }),
    );

    // Recovered event merged into the rendered view.
    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toContain('mount-backfill');
    });
  });

  it('keeps HTTP backfill silent while cached history is already visible', async () => {
    const sessionName = `deck_http_backfill_silent_${Date.now()}`;
    const serverId = `srv-silent-${Date.now()}`;
    const pendingBackfill = deferred<{ events: []; epoch: number; hasMore: false; nextCursor: null }>();
    fetchSpy.mockReturnValue(pendingBackfill.promise);

    ingestTimelineEventForCache({
      eventId: `${sessionName}-seed`,
      sessionId: sessionName,
      ts: 1000,
      epoch: 1,
      seq: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'cached' },
    }, serverId);

    const ws: WsClient = {
      connected: true,
      onMessage: () => () => {},
      sendTimelineReplayRequest: vi.fn(() => 'replay-silent'),
      sendTimelineHistoryRequest: vi.fn(() => 'history-silent'),
    } as unknown as WsClient;

    function Probe() {
      const { events, refreshing, historyStatus } = useTimeline(sessionName, ws, serverId);
      return h(
        'div',
        {
          'data-testid': 'probe',
          'data-refreshing': String(refreshing),
          'data-http': historyStatus.steps.http,
        },
        events.map((e) => String(e.payload.text ?? '')).join('|'),
      );
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe));
    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toContain('cached');
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('probe').getAttribute('data-refreshing')).toBe('false');
    expect(screen.getByTestId('probe').getAttribute('data-http')).not.toBe('running');

    await act(async () => {
      pendingBackfill.resolve({ events: [], epoch: 1, hasMore: false, nextCursor: null });
      await pendingBackfill.promise;
    });
  });

  it('skips the mount-time backfill when revisiting the same session shortly after', async () => {
    // Re-entering the same session while the app remains active should not
    // hammer HTTP on every tap. The mount path stays cooldown-limited.
    const sessionName = `deck_http_backfill_revisit_${Date.now()}`;
    const serverId = `srv-revisit-${Date.now()}`;

    fetchSpy.mockResolvedValue({ events: [], epoch: 1, hasMore: false, nextCursor: null });

    ingestTimelineEventForCache({
      eventId: `${sessionName}-seed`,
      sessionId: sessionName,
      ts: 1000,
      epoch: 1,
      seq: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'seed' },
    }, serverId);

    const ws: WsClient = {
      connected: true,
      onMessage: () => () => {},
      sendTimelineReplayRequest: vi.fn(() => 'replay-cd'),
      sendTimelineHistoryRequest: vi.fn(() => 'history-cd'),
    } as unknown as WsClient;

    function Probe() {
      useTimeline(sessionName, ws, serverId);
      return h('div', { 'data-testid': 'probe' }, 'mounted');
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });

    // --- First mount: fires backfill ---
    const first = render(h(Probe));
    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('mounted');
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    first.unmount();
    fetchSpy.mockClear();

    // --- Second mount, ~10 seconds later: should be skipped by cooldown ---
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    const second = render(h(Probe));
    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('mounted');
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(fetchSpy).not.toHaveBeenCalled();
    second.unmount();
  });

  it('app activation clears the mount cooldown and forces a fresh backfill for the active session', async () => {
    const sessionName = `deck_http_backfill_resume_${Date.now()}`;
    const serverId = `srv-resume-${Date.now()}`;

    fetchSpy.mockResolvedValue({ events: [], epoch: 1, hasMore: false, nextCursor: null });

    ingestTimelineEventForCache({
      eventId: `${sessionName}-seed`,
      sessionId: sessionName,
      ts: 1000,
      epoch: 1,
      seq: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'seed' },
    }, serverId);

    const ws: WsClient = {
      connected: true,
      onMessage: () => () => {},
      sendTimelineReplayRequest: vi.fn(() => 'replay-resume'),
      sendTimelineHistoryRequest: vi.fn(() => 'history-resume'),
    } as unknown as WsClient;

    function Probe() {
      useTimeline(sessionName, ws, serverId);
      return h('div', { 'data-testid': 'probe' }, 'mounted');
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe));
    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('mounted');
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockClear();

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    __resetBackfillCooldownsForTests();
    await act(async () => {
      window.dispatchEvent(new CustomEvent(ACTIVE_TIMELINE_REFRESH_EVENT));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('uses HTTP-backfilled command.ack to settle an optimistic send when the live ack was missed', async () => {
    const sessionName = `deck_http_backfill_ack_${Date.now()}`;
    const serverId = `srv-http-ack-${Date.now()}`;

    fetchSpy.mockResolvedValue({
      events: [{
        eventId: `${sessionName}-ack`,
        sessionId: sessionName,
        ts: 2000,
        epoch: 1,
        seq: 2,
        source: 'daemon',
        confidence: 'high',
        type: 'command.ack',
        payload: { commandId: 'cmd-http-backfill-ack', status: 'accepted' },
      }],
      epoch: 1,
      hasMore: false,
      nextCursor: null,
    });

    const ws: WsClient = {
      connected: true,
      onMessage: () => () => {},
      sendTimelineReplayRequest: vi.fn(() => 'replay-http-ack'),
      sendTimelineHistoryRequest: vi.fn(() => 'history-http-ack'),
    } as unknown as WsClient;

    let timeline: ReturnType<typeof useTimeline> | null = null;
    function Probe() {
      timeline = useTimeline(sessionName, ws, serverId);
      const pending = timeline.events.find((event) => event.eventId.includes('cmd-http-backfill-ack'))?.payload.pending;
      const acked = timeline.events.find((event) => event.eventId.includes('cmd-http-backfill-ack'))?.payload.acked;
      return h('div', { 'data-testid': 'probe' }, `pending:${String(pending)} acked:${String(acked)}`);
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe));
    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toContain('pending:undefined');
    });

    await act(async () => {
      timeline!.addOptimisticUserMessage('needs ack recovery', 'cmd-http-backfill-ack');
    });
    expect(screen.getByTestId('probe').textContent).toContain('pending:true');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toContain('pending:false');
      expect(screen.getByTestId('probe').textContent).toContain('acked:true');
    });
  });
});
