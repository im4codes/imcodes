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
    expect(fetchSpy).toHaveBeenCalledWith(
      serverId,
      sessionName,
      expect.objectContaining({ afterTs: 5000 }),
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
});
