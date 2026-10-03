/**
 * @vitest-environment jsdom
 *
 * Regression for a real "chat history loading spins forever" report: the
 * "History … ✓ cache 217 ○ daemon" state never resolves, even though the
 * local cache step is long done and the 217 cached messages are already on
 * screen. Root cause lives in `sendForwardHistoryRequest` /
 * `armForwardHistoryTimeout`: `ws.sendTimelineHistoryRequest` de-dupes
 * requests by (session, limit, afterTs) — a call for a key that already has
 * one outstanding puts NO new frame on the wire and just hands back the SAME
 * requestId. `sendForwardHistoryRequest` re-armed a fresh 8s give-up timer on
 * EVERY such call regardless, so a caller that retries more often than the
 * window (the explicit sync button, a reconnect burst, a bootstrap effect
 * re-run) can push the deadline out indefinitely: the fallback that is
 * supposed to flip the daemon step out of pending/running and stop the
 * spinner never fires — and the daemon never even sees a second real request
 * to log, exactly as observed on the real machine (zero matching log lines).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/api.js', () => ({
  fetchTimelineHistoryHttp: vi.fn().mockResolvedValue({ events: [] }),
  fetchTimelineTextTailHttp: vi.fn().mockResolvedValue(null),
}));

import { render, cleanup, act } from '@testing-library/preact';
import { h } from 'preact';
import type { ServerMessage, TimelineEvent, WsClient } from '../src/ws-client.js';
import { TimelineDB } from '../src/timeline-db.js';
import { TIMELINE_MESSAGES } from '../../shared/timeline-protocol.js';
import {
  __resetTimelineCacheForTests,
  useTimeline,
  type TimelineHistoryStatus,
} from '../src/hooks/useTimeline.js';

function cachedEvent(sessionName: string, i: number): TimelineEvent {
  return {
    eventId: `${sessionName}-cached-${i}`,
    sessionId: sessionName,
    ts: 1_000 + i,
    epoch: 1,
    seq: i,
    source: 'daemon',
    confidence: 'high',
    type: 'assistant.text',
    payload: { text: `cached-${i}` },
  } as unknown as TimelineEvent;
}

/** Exactly ChatView's own `showHistoryProgress` formula (ChatView.tsx ~3518):
 *  any non-skipped step still pending/running keeps the spinner up. */
function isSpinning(status: TimelineHistoryStatus): boolean {
  return status.phase !== 'idle'
    && Object.values(status.steps).some((state) => state === 'pending' || state === 'running');
}

describe('useTimeline — the daemon history give-up timeout cannot be livelocked by duplicate requests', () => {
  beforeEach(() => {
    __resetTimelineCacheForTests();
    cleanup();
    vi.spyOn(TimelineDB.prototype, 'open').mockResolvedValue();
    vi.spyOn(TimelineDB.prototype, 'memoryOnly', 'get').mockReturnValue(false);
    vi.spyOn(TimelineDB.prototype, 'pruneOldEvents').mockResolvedValue({ deleted: 0, done: true });
    vi.spyOn(TimelineDB.prototype, 'drainLegacySignals').mockResolvedValue({ deleted: 0, done: true, deletedIds: [] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stops spinning at most 8s after the FIRST attempt, and never stops showing the 217 cached messages, even when the daemon never answers and something keeps retrying (dedup no-ops) faster than the timeout', async () => {
    const sessionName = `deck_daemon_stuck_${Date.now()}`;
    const serverId = `srv-daemon-stuck-${Date.now()}`;
    const cached = Array.from({ length: 217 }, (_, i) => cachedEvent(sessionName, i));
    vi.spyOn(TimelineDB.prototype, 'getRecentEvents').mockResolvedValue(cached);
    vi.spyOn(TimelineDB.prototype, 'getLastSeqAndEpoch').mockResolvedValue({ seq: 217, epoch: 1 });

    // Real ws-client de-dup: a repeat call for the same (session, limit,
    // afterTs) key while a request is still outstanding returns the SAME id
    // without sending anything new. The daemon in this scenario never answers
    // at all, so every call in this test hits that exact same dedup slot.
    const sendTimelineHistoryRequest = vi.fn(() => 'daemon-history-req-stuck');
    const ws: WsClient = {
      connected: true,
      onMessage: () => () => {},
      sendTimelineReplayRequest: vi.fn(() => 'replay-stuck'),
      sendTimelineHistoryRequest,
    } as unknown as WsClient;

    const hook: { current: ReturnType<typeof useTimeline> | null } = { current: null };
    function Probe() {
      hook.current = useTimeline(sessionName, ws, serverId, { isActiveSession: true });
      return h('div', null, 'mounted');
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe));
    // Let the bootstrap's own IDB read + first daemon request settle.
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(hook.current!.events).toHaveLength(217);
    expect(sendTimelineHistoryRequest).toHaveBeenCalled();

    // Something keeps retrying more often than the 8s give-up window — the
    // explicit sync button and a reconnect burst both call this same path —
    // for 9 seconds total, well past the window measured from the FIRST
    // attempt above.
    for (let elapsed = 0; elapsed < 9_000; elapsed += 3_000) {
      await act(async () => {
        hook.current!.forceRefresh();
        await vi.advanceTimersByTimeAsync(3_000);
      });
    }

    expect(isSpinning(hook.current!.historyStatus)).toBe(false);
    // The 217 cached messages were never blocked by the stuck daemon step.
    expect(hook.current!.events).toHaveLength(217);

    // The dedup contract itself: every one of these calls returned the SAME
    // id, i.e. only the very first ever put a real frame on the wire — a
    // stuck daemon in this scenario would show none of these as new log
    // lines, exactly as reported.
    expect(new Set(sendTimelineHistoryRequest.mock.results.map((result) => result.value)).size).toBe(1);
  });

  it('still merges history that arrives late, after the give-up timeout already stopped the spinner — the fallback never loses history', async () => {
    const sessionName = `deck_daemon_late_reply_${Date.now()}`;
    const serverId = `srv-daemon-late-${Date.now()}`;
    vi.spyOn(TimelineDB.prototype, 'getRecentEvents').mockResolvedValue([]);
    vi.spyOn(TimelineDB.prototype, 'getLastSeqAndEpoch').mockResolvedValue(null);

    let handler: ((msg: ServerMessage) => void) | null = null;
    const ws: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => { handler = next; return () => { handler = null; }; },
      sendTimelineReplayRequest: vi.fn(() => 'replay-late'),
      sendTimelineHistoryRequest: vi.fn(() => 'daemon-history-req-late'),
    } as unknown as WsClient;

    const hook: { current: ReturnType<typeof useTimeline> | null } = { current: null };
    function Probe() {
      hook.current = useTimeline(sessionName, ws, serverId, { isActiveSession: true });
      return h('div', null, 'mounted');
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });

    // Give up: the fallback stops the spinner after the window.
    await act(async () => { await vi.advanceTimersByTimeAsync(8_100); });
    expect(isSpinning(hook.current!.historyStatus)).toBe(false);
    expect(hook.current!.events).toHaveLength(0);

    // The original request finally answers, long after the client gave up on it.
    await act(async () => {
      handler?.({
        type: TIMELINE_MESSAGES.HISTORY,
        sessionName,
        requestId: 'daemon-history-req-late',
        status: 'ok',
        source: 'daemon',
        events: [cachedEvent(sessionName, 1)],
        payloadTruncated: false,
        hasMore: false,
      } as unknown as ServerMessage);
    });

    expect(hook.current!.events.map((e) => e.eventId)).toContain(`${sessionName}-cached-1`);
    expect(isSpinning(hook.current!.historyStatus)).toBe(false);
  });
});
