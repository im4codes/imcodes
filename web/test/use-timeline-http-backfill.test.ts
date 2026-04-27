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

  // ── Activation / multi-session gating regression suite ─────────────────
  // These tests pin down the post-fix behaviour the user explicitly asked
  // for ("WS 重连后必 backfill ，fast cache 这些一定只触发激活窗口的。
  // 激活哪个触发哪个。") and prevent the gating regressions that landed
  // in 1c178a4a / 35d87485 from coming back unnoticed.

  it('activation event fires backfill ONLY for the active session, never for inactive mounted siblings', async () => {
    const activeSession = `deck_active_${Date.now()}`;
    const inactiveSession = `deck_inactive_${Date.now()}`;
    const serverId = `srv-multi-${Date.now()}`;

    fetchSpy.mockResolvedValue({ events: [], epoch: 1, hasMore: false, nextCursor: null });

    for (const name of [activeSession, inactiveSession]) {
      ingestTimelineEventForCache({
        eventId: `${name}-seed`,
        sessionId: name,
        ts: 1000,
        epoch: 1,
        seq: 1,
        source: 'daemon',
        confidence: 'high',
        type: 'assistant.text',
        payload: { text: 'seed' },
      }, serverId);
    }

    const ws: WsClient = {
      connected: true,
      onMessage: () => () => {},
      sendTimelineReplayRequest: vi.fn(() => 'replay'),
      sendTimelineHistoryRequest: vi.fn(() => 'history'),
    } as unknown as WsClient;

    function Probe() {
      useTimeline(activeSession, ws, serverId, { isActiveSession: true });
      useTimeline(inactiveSession, ws, serverId, { isActiveSession: false });
      return h('div', { 'data-testid': 'probe' }, 'mounted');
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe));
    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('mounted');
    });
    // Drain mount-time backfill (active session only — inactive is gated)
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(serverId, activeSession, expect.anything());
    fetchSpy.mockClear();

    // Simulate an app-resume / push-tap activation event. Real callers
    // arrive via `requestActiveTimelineRefresh({ resetCooldowns: true })`
    // which clears the 15s cooldown map first (because the user signaled
    // they want fresh data, not a coalesced refire). We mirror that here.
    __resetBackfillCooldownsForTests();
    await act(async () => {
      window.dispatchEvent(new CustomEvent(ACTIVE_TIMELINE_REFRESH_EVENT));
      await vi.advanceTimersByTimeAsync(50);
    });

    // ONLY the active session should have fired a backfill.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(serverId, activeSession, expect.anything());
  });

  it('switching active session (false→true transition) immediately fires backfill for the newly-active hook', async () => {
    const sessionA = `deck_switch_a_${Date.now()}`;
    const sessionB = `deck_switch_b_${Date.now()}`;
    const serverId = `srv-switch-${Date.now()}`;

    fetchSpy.mockResolvedValue({ events: [], epoch: 1, hasMore: false, nextCursor: null });

    for (const name of [sessionA, sessionB]) {
      ingestTimelineEventForCache({
        eventId: `${name}-seed`,
        sessionId: name,
        ts: 1000,
        epoch: 1,
        seq: 1,
        source: 'daemon',
        confidence: 'high',
        type: 'assistant.text',
        payload: { text: 'seed' },
      }, serverId);
    }

    const ws: WsClient = {
      connected: true,
      onMessage: () => () => {},
      sendTimelineReplayRequest: vi.fn(() => 'replay'),
      sendTimelineHistoryRequest: vi.fn(() => 'history'),
    } as unknown as WsClient;

    function Probe({ activeName }: { activeName: string }) {
      useTimeline(sessionA, ws, serverId, { isActiveSession: activeName === sessionA });
      useTimeline(sessionB, ws, serverId, { isActiveSession: activeName === sessionB });
      return h('div', { 'data-testid': 'probe' }, activeName);
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { rerender } = render(h(Probe, { activeName: sessionA }));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    // Mount-time backfill for sessionA only.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(serverId, sessionA, expect.anything());
    fetchSpy.mockClear();

    // User switches active session A → B.
    rerender(h(Probe, { activeName: sessionB }));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    // sessionB became active → its own backfill fires. sessionA does NOT
    // (it's no longer active and shouldn't echo a stale request).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(serverId, sessionB, expect.anything());
  });

  it('activation event fired during isActiveSession flip is NOT lost (stable listener, ref-based gate)', async () => {
    // This pins the regression caused by 1c178a4a/35d87485: when the listener
    // had `isActiveSession` in its deps, the listener was torn down + re-added
    // synchronously with the flip. An ACTIVE_TIMELINE_REFRESH_EVENT dispatched
    // in the same tick as the flip (e.g. push-tap that activates the session
    // AND requests a refresh together) landed in the gap and was silently
    // dropped. Post-fix the listener stays attached and reads the latest
    // `isActiveSession` via ref.
    const sessionName = `deck_flip_race_${Date.now()}`;
    const serverId = `srv-race-${Date.now()}`;

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
      sendTimelineReplayRequest: vi.fn(() => 'replay'),
      sendTimelineHistoryRequest: vi.fn(() => 'history'),
    } as unknown as WsClient;

    function Probe({ active }: { active: boolean }) {
      useTimeline(sessionName, ws, serverId, { isActiveSession: active });
      return h('div', { 'data-testid': 'probe' }, String(active));
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Start inactive — no mount-time backfill.
    const { rerender } = render(h(Probe, { active: false }));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(fetchSpy).not.toHaveBeenCalled();

    // Synchronously: flip to active AND dispatch the activation event in the
    // same act() — this is the racy path.
    await act(async () => {
      rerender(h(Probe, { active: true }));
      window.dispatchEvent(new CustomEvent(ACTIVE_TIMELINE_REFRESH_EVENT));
      await vi.advanceTimersByTimeAsync(50);
    });

    // Both the false→true transition AND the activation event request a
    // refresh; the 250ms rate-limiter coalesces them into a single fetch.
    // The important assertion: at least one fetch fired (no silent drop).
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(fetchSpy).toHaveBeenCalledWith(serverId, sessionName, expect.anything());
  });

  it('retries HTTP backfill on null result (transient daemon-offline at activation)', async () => {
    const sessionName = `deck_retry_${Date.now()}`;
    const serverId = `srv-retry-${Date.now()}`;

    // First two calls return null (daemon offline); third call succeeds.
    const recovered: TimelineEvent = {
      eventId: `${sessionName}-recovered`,
      sessionId: sessionName,
      ts: 5000,
      epoch: 1,
      seq: 2,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'recovered-after-retry' },
    };
    fetchSpy
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ events: [recovered], epoch: 1, hasMore: false, nextCursor: null });

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
      sendTimelineReplayRequest: vi.fn(() => 'replay'),
      sendTimelineHistoryRequest: vi.fn(() => 'history'),
    } as unknown as WsClient;

    function Probe() {
      const { events } = useTimeline(sessionName, ws, serverId);
      return h('div', { 'data-testid': 'probe' }, events.map((e) => String(e.payload.text ?? '')).join('|'));
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe));
    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toContain('seed');
    });

    // Mount-time backfill fires at 200ms → null → retry at +800ms → null →
    // retry at +2000ms → success. Total elapsed ≈ 200 + 800 + 2000 = 3000ms.
    await act(async () => { await vi.advanceTimersByTimeAsync(3500); });

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toContain('recovered-after-retry');
    });
  });

  it('gives up cleanly after exhausting retries (no infinite loop, no crash)', async () => {
    const sessionName = `deck_retry_exhaust_${Date.now()}`;
    const serverId = `srv-retry-exhaust-${Date.now()}`;

    // All calls return null.
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

    const ws: WsClient = {
      connected: true,
      onMessage: () => () => {},
      sendTimelineReplayRequest: vi.fn(() => 'replay'),
      sendTimelineHistoryRequest: vi.fn(() => 'history'),
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

    // Initial backfill + 2 retries = 3 calls total. Beyond that, give up.
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    // No further calls even after a long wait — retry budget exhausted.
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('probe').textContent).toBe('mounted');
  });

  it('15s cooldown coalesces back-to-back activation events for the same session', async () => {
    // Pins the user-reported regression: clicking a session triggered 2-3
    // backfills back-to-back (mount + isActiveSession transition + a stray
    // activation event from the same focus/visibility tick), each one
    // running a real HTTP roundtrip and re-rendering the chat. The 15s
    // cooldown coalesces that burst into a single fetch. Real app-resume
    // (`resetCooldowns: true`) clears the gate explicitly, but ordinary
    // session-switch / re-focus must respect it.
    const sessionName = `deck_cooldown_${Date.now()}`;
    const serverId = `srv-cooldown-${Date.now()}`;

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
      sendTimelineReplayRequest: vi.fn(() => 'replay'),
      sendTimelineHistoryRequest: vi.fn(() => 'history'),
    } as unknown as WsClient;

    function Probe() {
      useTimeline(sessionName, ws, serverId, { isActiveSession: true });
      return h('div', { 'data-testid': 'probe' }, 'mounted');
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe));
    // Drain the mount-time backfill — successful fetch arms the cooldown.
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockClear();

    // Three activation events arrive in quick succession (e.g. focus,
    // visibility, and appStateChange all firing within the same render
    // commit on iOS). With the 15s cooldown they should coalesce: zero
    // additional fetches.
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        window.dispatchEvent(new CustomEvent(ACTIVE_TIMELINE_REFRESH_EVENT));
        await vi.advanceTimersByTimeAsync(300);
      });
    }
    expect(fetchSpy).toHaveBeenCalledTimes(0);

    // Past 15s, a new activation event should fire.
    await act(async () => { await vi.advanceTimersByTimeAsync(15_500); });
    await act(async () => {
      window.dispatchEvent(new CustomEvent(ACTIVE_TIMELINE_REFRESH_EVENT));
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // resetCooldowns (the app-resume path) must bypass the cooldown. Advance
    // past the inner 250ms rate-limit too so the activation event isn't
    // suppressed by the in-handler debounce that gates same-tick repeats.
    __resetBackfillCooldownsForTests();
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    await act(async () => {
      window.dispatchEvent(new CustomEvent(ACTIVE_TIMELINE_REFRESH_EVENT));
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('activation backfill flips refreshing=true so the user sees a spinner', async () => {
    // Pins the contract that activation events (push-tap, app-resume, focus,
    // visibilitychange) flip the visible refreshing flag while the HTTP
    // backfill is in-flight. Without this, the user resumes the app, sees
    // no spinner, no new messages arrive (because of WS subscribe race or
    // a transport-channel bug), and has no way to tell whether anything is
    // happening — they perceive the app as frozen and pull-to-refresh
    // manually. The visibility cue is also the easiest user-side smoke
    // test for the whole activation chain.
    const sessionName = `deck_activation_visible_${Date.now()}`;
    const serverId = `srv-vis-${Date.now()}`;

    // Hold the fetch open so we can observe refreshing=true mid-flight.
    const gate = deferred<{ events: TimelineEvent[]; epoch: number; hasMore: boolean; nextCursor: null }>();
    fetchSpy.mockReturnValue(gate.promise);

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
      sendTimelineReplayRequest: vi.fn(() => 'replay'),
      sendTimelineHistoryRequest: vi.fn(() => 'history'),
    } as unknown as WsClient;

    let observedRefreshing: boolean | null = null;
    function Probe() {
      const { refreshing } = useTimeline(sessionName, ws, serverId, { isActiveSession: true });
      observedRefreshing = refreshing;
      return h('div', { 'data-testid': 'probe' }, refreshing ? 'refreshing' : 'idle');
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe));
    // Drain the mount-time backfill so the next fetch is unambiguously the
    // activation one.
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    fetchSpy.mockClear();
    fetchSpy.mockReturnValue(gate.promise);

    // Fire activation event (e.g. app-resume).
    await act(async () => {
      window.dispatchEvent(new CustomEvent(ACTIVE_TIMELINE_REFRESH_EVENT));
      await vi.advanceTimersByTimeAsync(20);
    });

    // Backfill is in-flight → refreshing=true (so the UI spinner shows).
    expect(observedRefreshing).toBe(true);
    expect(screen.getByTestId('probe').textContent).toBe('refreshing');

    // Resolve the fetch → refreshing flips back to false.
    await act(async () => {
      gate.resolve({ events: [], epoch: 1, hasMore: false, nextCursor: null });
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(observedRefreshing).toBe(false);
  });
});
