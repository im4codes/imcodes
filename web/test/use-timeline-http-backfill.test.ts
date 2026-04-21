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
vi.mock('../src/api.js', () => ({ fetchTimelineHistoryHttp: fetchSpy }));

import { render, screen, cleanup, act, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import type { ServerMessage, TimelineEvent, WsClient } from '../src/ws-client.js';
import {
  __resetBackfillCooldownsForTests,
  __resetTimelineCacheForTests,
  ingestTimelineEventForCache,
  useTimeline,
} from '../src/hooks/useTimeline.js';

describe('useTimeline — HTTP backfill on WS reconnect', () => {
  beforeEach(() => {
    __resetTimelineCacheForTests();
    cleanup();
    fetchSpy.mockReset();
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
      expect.objectContaining({ afterTs: 7500 }),
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
      expect.objectContaining({ afterTs: 6000 }),
    );

    // Recovered event merged into the rendered view.
    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toContain('mount-backfill');
    });
  });

  it('skips the mount-time backfill when the same session was successfully backfilled in the last 60 seconds', async () => {
    // User flow this guards: flicking A → B → A inside a minute.
    // The first A mount fires and records success; the second A mount
    // sees the freshly-stamped cache entry and should NOT hit the HTTP
    // path again. Saves a round-trip per window switch when navigating
    // a lot between a small set of sessions.
    const sessionName = `deck_http_backfill_cooldown_${Date.now()}`;
    const serverId = `srv-cd-${Date.now()}`;

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
      sendTimelineHistoryRequest: vi.fn(() => 'history-cd'),
    } as unknown as WsClient;

    function Probe() {
      useTimeline(sessionName, ws, serverId);
      return h('div', { 'data-testid': 'probe' }, 'mounted');
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });

    // --- First mount: fires backfill and stamps the cooldown ---
    const first = render(h(Probe));
    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('mounted');
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    first.unmount();
    fetchSpy.mockClear();

    // --- Second mount, ~10 seconds later: well inside the 60s window ---
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    const second = render(h(Probe));
    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('mounted');
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(fetchSpy).not.toHaveBeenCalled(); // cooldown skipped the network hit
    second.unmount();

    // --- Third mount, past the 60s threshold: backfill fires again ---
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    const third = render(h(Probe));
    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('mounted');
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    third.unmount();
  });

  it('app-reopen wipe (long-hide visibilitychange / pageshow restore) clears the cooldown so the next mount fires fresh', async () => {
    // The same module-level wipe that the visibility listener performs
    // when the document was hidden longer than the cooldown window. Any
    // session whose cooldown was armed before the wipe must re-fire on
    // its next mount so the reopened app catches up on missed events.
    const sessionName = `deck_http_backfill_reopen_${Date.now()}`;
    const serverId = `srv-reopen-${Date.now()}`;

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
      sendTimelineHistoryRequest: vi.fn(() => 'history-reopen'),
    } as unknown as WsClient;

    function Probe() {
      useTimeline(sessionName, ws, serverId);
      return h('div', { 'data-testid': 'probe' }, 'mounted');
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });

    // First mount: arms cooldown.
    const first = render(h(Probe));
    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('mounted');
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    first.unmount();
    fetchSpy.mockClear();

    // Inside cooldown (5s later): mount skips backfill.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    const second = render(h(Probe));
    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('mounted');
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(fetchSpy).not.toHaveBeenCalled();
    second.unmount();

    // App was hidden long enough → wipe fires (simulated directly).
    __resetBackfillCooldownsForTests();

    // Mount again — cooldown cleared, backfill MUST fire even though
    // we're still well inside the 60s window from the original arm.
    const third = render(h(Probe));
    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('mounted');
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    third.unmount();
  });

  it('reconnect-path backfill bypasses the mount cooldown (gap recovery trumps rate limit)', async () => {
    // Reconnects imply a real connection gap where live events may have
    // been dropped. Suppressing the reconnect backfill to save a request
    // would defeat its purpose — confirm it still fires even when a mount
    // backfill just succeeded moments ago.
    const sessionName = `deck_http_backfill_reconnect_bypass_${Date.now()}`;
    const serverId = `srv-rb-${Date.now()}`;

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

    let handler: ((msg: ServerMessage) => void) | null = null;
    const ws: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineHistoryRequest: vi.fn(() => 'history-rb'),
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

    // Drain mount backfill (arms cooldown) then clear the spy.
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockClear();

    // Reconnect 5 seconds later — well inside the 60s mount cooldown.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await act(async () => {
      handler?.({ type: 'session.event', event: 'connected', session: '', state: 'connected' } as ServerMessage);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(650); });

    // Reconnect bypasses the cooldown and fires anyway.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
