/**
 * @vitest-environment jsdom
 *
 * Web hook-level integration tests for the weak-network auto-sync fixes (run
 * f9f61e78-e82). These exercise the full `useTimeline` lifecycle against a MOCKED
 * WS + MOCKED HTTP backfill in jsdom — they are NOT a real cross-bridge e2e (no
 * real `/timeline/history/full` route, no daemon, no real browser/Capacitor
 * visibility). They prove the client-side hook state machine; true bridge/abort/
 * late-response behavior needs a separate server-level test. The matching
 * `test/e2e/weak-network-auto-sync.test.ts` gate runs this file under the web
 * config as part of `npm run test:e2e`.
 *
 * Behaviors covered:
 *   1. Scenario-based HTTP timeout — recovery reads use a budget well above the
 *      old 2.5s abort and below the 15s server budget (NOT a fixed constant, so
 *      this stays green when activation/watchdog use a shorter budget than force).
 *   2. Foreground staleness watchdog — a session the user is looking at recovers
 *      a silently-dropped content event with no user action, and an idle session
 *      does not poll on every tick.
 *   3. isVisible gate — a visible-but-not-focused session catches up on the resume
 *      broadcast (previously gated out of `fireHttpBackfill`). NOTE: this only
 *      covers the activation-event path; the visible-non-active MOUNT path is
 *      still active-gated (Cx1#1) — see the `it.todo` below.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchSpy = vi.hoisted(() => vi.fn());
const fetchTextTailSpy = vi.hoisted(() => vi.fn());
vi.mock('../src/api.js', () => ({
  fetchTimelineHistoryHttp: fetchSpy,
  fetchTimelineTextTailHttp: fetchTextTailSpy,
}));

import { act, cleanup, render, screen, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import type { TimelineEvent, WsClient } from '../src/ws-client.js';
import {
  __resetTimelineCacheForTests,
  ACTIVE_TIMELINE_REFRESH_EVENT,
  ingestTimelineEventForCache,
  useTimeline,
} from '../src/hooks/useTimeline.js';

function makeWs(): WsClient {
  return {
    connected: true,
    onMessage: () => () => {},
    sendTimelineHistoryRequest: vi.fn(() => 'history-weaknet'),
    sendTimelineReplayRequest: vi.fn(() => 'replay-weaknet'),
  } as unknown as WsClient;
}

function seedEvent(sessionName: string, serverId: string, ts: number, eventId: string): void {
  ingestTimelineEventForCache({
    eventId,
    sessionId: sessionName,
    ts,
    epoch: 1,
    seq: ts,
    source: 'daemon',
    confidence: 'high',
    type: 'assistant.text',
    payload: { text: eventId },
  }, serverId);
}

function recoveredEvent(sessionName: string, ts: number, eventId: string): TimelineEvent {
  return {
    eventId,
    sessionId: sessionName,
    ts,
    epoch: 1,
    seq: ts,
    source: 'daemon',
    confidence: 'high',
    type: 'assistant.text',
    payload: { text: eventId },
  } as TimelineEvent;
}

describe('weak-network auto-sync (cycle 1 validation)', () => {
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

  it('backfill uses the 10s recovery budget instead of the old 2.5s abort', async () => {
    const sessionName = `deck_weaknet_timeout_${Date.now()}`;
    const serverId = `srv-weaknet-timeout-${Date.now()}`;
    fetchSpy.mockResolvedValue({ events: [], epoch: 1, hasMore: false, nextCursor: null });
    seedEvent(sessionName, serverId, 1000, `${sessionName}-seed`);

    const ws = makeWs();
    function Probe() {
      const { events } = useTimeline(sessionName, ws, serverId, { isActiveSession: true });
      return h('div', { 'data-testid': 'probe' }, String(events.length));
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe));
    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('1');
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });

    expect(fetchSpy).toHaveBeenCalled();
    // The keystone: every backfill request must carry a recovery budget well
    // above the old 2.5s abort and strictly below the 15s server relay budget.
    // Asserted as a RANGE, not a fixed constant — the budget is scenario-based
    // (silent probes get less than a manual/force refresh), so a `=== 10000`
    // would ossify the implementation and block the scenario-timeout work.
    for (const call of fetchSpy.mock.calls) {
      const timeoutMs = (call[2] as { timeoutMs?: number }).timeoutMs;
      expect(timeoutMs).toBeGreaterThan(2500);
      expect(timeoutMs).toBeLessThan(15000);
    }
  });

  it('foreground watchdog recovers a silently-dropped event with no user action', async () => {
    const sessionName = `deck_weaknet_watchdog_${Date.now()}`;
    const serverId = `srv-weaknet-watchdog-${Date.now()}`;
    // Mount-time backfill returns empty (no gap yet).
    fetchSpy.mockResolvedValue({ events: [], epoch: 1, hasMore: false, nextCursor: null });
    seedEvent(sessionName, serverId, 1000, `${sessionName}-seed`);

    const ws = makeWs();
    function Probe() {
      const { events } = useTimeline(sessionName, ws, serverId, { isActiveSession: true });
      return h('div', { 'data-testid': 'probe' }, String(events.length));
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe));
    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('1');
    });
    // Consume the mount backfill (stamps the verified-fresh baseline).
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    fetchSpy.mockClear();

    // One interval tick before the 45s stale threshold: must NOT poll (an idle
    // foreground session shouldn't hammer HTTP on every tick).
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchSpy).not.toHaveBeenCalled();

    // A live event was silently dropped server-side; the daemon now has it.
    // The next watchdog tick past the stale threshold must pull it in WITHOUT
    // any focus / reconnect / user action.
    fetchSpy.mockResolvedValue({
      events: [recoveredEvent(sessionName, 2000, `${sessionName}-dropped`)],
      epoch: 1,
      hasMore: false,
      nextCursor: null,
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('2');
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('visible-but-not-focused session catches up on resume (isVisible gate)', async () => {
    const sessionName = `deck_weaknet_visible_${Date.now()}`;
    const serverId = `srv-weaknet-visible-${Date.now()}`;
    fetchSpy.mockResolvedValue({ events: [], epoch: 1, hasMore: false, nextCursor: null });
    seedEvent(sessionName, serverId, 1000, `${sessionName}-seed`);

    const ws = makeWs();
    function Probe() {
      // Not the active session, but mounted and visible (e.g. an open
      // sub-session card / window on desktop).
      const { events } = useTimeline(sessionName, ws, serverId, { isActiveSession: false, isVisible: true });
      return h('div', { 'data-testid': 'probe' }, String(events.length));
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe));
    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('1');
    });
    // A visible-non-active mount does NOT fire its own HTTP backfill (mount
    // path is active-gated), so the spy is clean here.
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    fetchSpy.mockClear();

    // Resume broadcast (focus / visibility / app foreground). Before the gate
    // fix this was silently dropped for non-active sessions; now it backfills.
    await act(async () => {
      window.dispatchEvent(new CustomEvent(ACTIVE_TIMELINE_REFRESH_EVENT));
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls.at(-1) as [string, string, { timeoutMs?: number }];
    expect(call[0]).toBe(serverId);
    expect(call[1]).toBe(sessionName);
    expect(call[2].timeoutMs).toBeGreaterThan(2500);
    expect(call[2].timeoutMs).toBeLessThan(15000);
  });

  // Known gap (round-4 Cx1#1): the visible-but-not-active MOUNT path (HTTP
  // backfill at useTimeline.ts and WS forward-history `requestDaemonHistory`)
  // is still `isActiveSession`-gated. Only the activation-event path above is
  // fixed. A visible card therefore waits for a resume broadcast instead of
  // catching up on mount. Tracked for cycle-2 (shared job + refreshEligible).
  it.todo('visible-non-active MOUNT catches up within a bounded delay without waiting for a resume broadcast');
});
