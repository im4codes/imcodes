/**
 * @vitest-environment jsdom
 *
 * Causal verification for mobile chat history sync failure recovery:
 * 1. Base failure vs Head pass on error clearing upon successful HTTP backfill / forceRefresh.
 * 2. Proper classification of request_canceled as 'canceled' rather than false-positive 'error'.
 * 3. Scope isolation for late-arriving responses across session switches.
 * 4. Preserving genuine failure indication when all transports fail (no false-positive success).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchSpy = vi.hoisted(() => vi.fn());
const fetchTextTailSpy = vi.hoisted(() => vi.fn());
vi.mock('../src/api.js', () => ({
  fetchTimelineHistoryHttp: fetchSpy,
  fetchTimelineTextTailHttp: fetchTextTailSpy,
}));

import { render, screen, cleanup, act, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import type { ServerMessage, TimelineEvent, WsClient } from '../src/ws-client.js';
import { TIMELINE_MESSAGES, TIMELINE_RESPONSE_STATUS } from '../../shared/timeline-protocol.js';
import { TIMELINE_HISTORY_ERROR_REASONS } from '../../shared/timeline-history-errors.js';
import {
  __resetTimelineCacheForTests,
  ingestTimelineEventForCache,
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

describe('useTimeline — history recovery and error clearing contract', () => {
  beforeEach(() => {
    __resetTimelineCacheForTests();
    cleanup();
    fetchSpy.mockReset();
    fetchTextTailSpy.mockReset();
    fetchTextTailSpy.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('classifies request_canceled as canceled, not error, avoiding permanent red exclamation mark', async () => {
    const sessionName = `deck_cancel_test_${Date.now()}`;
    let handler: ((msg: ServerMessage) => void) | null = null;
    const sendTimelineHistoryRequest = vi.fn(() => 'req-cancel-1');

    const ws: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineHistoryRequest,
    } as unknown as WsClient;

    let timeline: ReturnType<typeof useTimeline> | null = null;
    function Probe() {
      timeline = useTimeline(sessionName, ws, 'srv-1');
      return h('div', {
        'data-testid': 'probe',
        'data-response': timeline?.historyStatus.response?.state ?? '',
      }, 'probe');
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe));

    await waitFor(() => {
      expect(sendTimelineHistoryRequest).toHaveBeenCalledTimes(1);
    });

    // Simulate server bridge sending request_canceled (e.g. mobile client backgrounded or timed out)
    await act(async () => {
      handler?.({
        type: 'timeline.history',
        sessionName,
        requestId: 'req-cancel-1',
        epoch: 1,
        events: [],
        status: TIMELINE_RESPONSE_STATUS.ERROR,
        errorReason: TIMELINE_HISTORY_ERROR_REASONS.REQUEST_CANCELED,
        recoverable: false,
      } as ServerMessage);
      await vi.advanceTimersByTimeAsync(0);
    });

    // Must be classified as 'canceled', NOT 'error', so UsageFooter does not trigger is-error
    expect(timeline!.historyStatus.response?.state).toBe('canceled');
  });

  it('clears previous error state when forceRefresh is clicked', async () => {
    const sessionName = `deck_force_refresh_clear_${Date.now()}`;
    let handler: ((msg: ServerMessage) => void) | null = null;
    const sendTimelineHistoryRequest = vi.fn(() => 'req-error-1');

    const ws: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineHistoryRequest,
    } as unknown as WsClient;

    let timeline: ReturnType<typeof useTimeline> | null = null;
    function Probe() {
      timeline = useTimeline(sessionName, ws, 'srv-1');
      return h('div', {
        'data-testid': 'probe',
        'data-response': timeline?.historyStatus.response?.state ?? '',
      }, 'probe');
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe));

    await waitFor(() => {
      expect(sendTimelineHistoryRequest).toHaveBeenCalledTimes(1);
    });

    // First: a real error occurs
    await act(async () => {
      handler?.({
        type: 'timeline.history',
        sessionName,
        requestId: 'req-error-1',
        epoch: 1,
        events: [],
        status: TIMELINE_RESPONSE_STATUS.ERROR,
        errorReason: TIMELINE_HISTORY_ERROR_REASONS.QUEUE_FULL,
        recoverable: false,
      } as ServerMessage);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(timeline!.historyStatus.response?.state).toBe('error');

    const inFlightFetch = deferred<unknown>();
    fetchSpy.mockImplementation(() => inFlightFetch.promise);

    // User taps ↻ (forceRefresh). Refresh is initiated.
    await act(async () => {
      timeline!.forceRefresh();
    });

    expect(timeline!.refreshing).toBe(true);

    // Now resolve the refresh successfully
    await act(async () => {
      inFlightFetch.resolve({ events: [], epoch: 1, hasMore: false, nextCursor: null });
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(timeline!.historyStatus.response?.state).not.toBe('error');
  });

  it('HTTP backfill clears stale error state upon successful recovery', async () => {
    const sessionName = `deck_http_recover_${Date.now()}`;
    const serverId = `srv-recover-${Date.now()}`;
    let handler: ((msg: ServerMessage) => void) | null = null;
    const sendTimelineHistoryRequest = vi.fn(() => 'req-err-recover');

    const recoveredEvent: TimelineEvent = {
      eventId: `${sessionName}-ev-1`,
      sessionId: sessionName,
      ts: 2000,
      epoch: 1,
      seq: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'recovered-by-http' },
    };

    fetchSpy.mockResolvedValue({
      events: [recoveredEvent],
      epoch: 1,
      hasMore: false,
      nextCursor: null,
    });

    const ws: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineHistoryRequest,
    } as unknown as WsClient;

    let timeline: ReturnType<typeof useTimeline> | null = null;
    function Probe() {
      timeline = useTimeline(sessionName, ws, serverId);
      return h('div', {
        'data-testid': 'probe',
        'data-response': timeline?.historyStatus.response?.state ?? '',
      }, 'probe');
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe));

    await waitFor(() => {
      expect(sendTimelineHistoryRequest).toHaveBeenCalledTimes(1);
    });

    // Induce error state on timeline
    await act(async () => {
      handler?.({
        type: 'timeline.history',
        sessionName,
        requestId: 'req-err-recover',
        epoch: 1,
        events: [],
        status: TIMELINE_RESPONSE_STATUS.ERROR,
        errorReason: TIMELINE_HISTORY_ERROR_REASONS.DEADLINE_EXCEEDED,
        recoverable: false,
      } as ServerMessage);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(timeline!.historyStatus.response?.state).toBe('error');

    // Now trigger HTTP backfill recovery (e.g. manual refresh or reconnect)
    await act(async () => {
      timeline!.forceRefresh();
      // Allow HTTP fetch and idle settlement to complete
      await vi.advanceTimersByTimeAsync(500);
    });

    // The recovered event must be merged
    expect(timeline!.events.some((e) => e.eventId === recoveredEvent.eventId)).toBe(true);
    // The error MUST be cleared after successful recovery
    expect(timeline!.historyStatus.response?.state).not.toBe('error');
  });

  it('preserves genuine failure notification when both WS and HTTP fail on manual refresh', async () => {
    const sessionName = `deck_genuine_fail_${Date.now()}`;
    const serverId = `srv-fail-${Date.now()}`;

    // HTTP fails
    fetchSpy.mockRejectedValue(new Error('network_offline'));

    const ws: WsClient = {
      connected: false, // WS offline
      onMessage: () => () => {},
      sendTimelineHistoryRequest: vi.fn(),
    } as unknown as WsClient;

    let timeline: ReturnType<typeof useTimeline> | null = null;
    function Probe() {
      timeline = useTimeline(sessionName, ws, serverId);
      return h('div', null, 'probe');
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe));

    await act(async () => {
      timeline!.forceRefresh();
      await vi.advanceTimersByTimeAsync(100);
    });

    // When both transports fail, error MUST be displayed (not hidden)
    expect(timeline!.historyStatus.response?.state).toBe('error');
  });

  it('discards late-arriving HTTP response when session scope switches mid-flight', async () => {
    const sessionA = `deck_scope_a_${Date.now()}`;
    const sessionB = `deck_scope_b_${Date.now()}`;
    const serverId = `srv-scope-${Date.now()}`;

    const httpFetchA = deferred<unknown>();
    fetchSpy.mockImplementation(({ afterTs }: { afterTs?: number }) => {
      return httpFetchA.promise;
    });

    let currentSession = sessionA;
    let timeline: ReturnType<typeof useTimeline> | null = null;

    const ws: WsClient = {
      connected: true,
      onMessage: () => () => {},
      sendTimelineHistoryRequest: vi.fn(),
    } as unknown as WsClient;

    function Probe(props: { session: string }) {
      timeline = useTimeline(props.session, ws, serverId);
      return h('div', { 'data-testid': 'probe' }, props.session);
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { rerender } = render(h(Probe, { session: currentSession }));

    // Mount session A triggers HTTP backfill
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    // Now switch to session B while session A's HTTP fetch is in flight
    currentSession = sessionB;
    rerender(h(Probe, { session: sessionB }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    // Settle session A's HTTP fetch with events for session A
    await act(async () => {
      httpFetchA.resolve({
        events: [{
          eventId: `${sessionA}-late`,
          sessionId: sessionA,
          ts: 1000,
          epoch: 1,
          seq: 1,
          source: 'daemon',
          confidence: 'high',
          type: 'assistant.text',
          payload: { text: 'late-from-session-a' },
        }],
        epoch: 1,
        hasMore: false,
        nextCursor: null,
      });
      await vi.advanceTimersByTimeAsync(50);
    });

    // Session B must NOT have Session A's events
    expect(timeline!.events.some((e) => e.sessionId === sessionA)).toBe(false);
  });

  it('recovers sub-session chat history and clears transient error on sub-session pane', async () => {
    const subSession = `deck_sub_recover_${Date.now()}`;
    const serverId = `srv-sub-${Date.now()}`;
    let handler: ((msg: ServerMessage) => void) | null = null;
    const sendTimelineHistoryRequest = vi.fn(() => 'req-sub-err');

    const subEvent: TimelineEvent = {
      eventId: `${subSession}-ev-1`,
      sessionId: subSession,
      ts: 3000,
      epoch: 1,
      seq: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'sub-session-recovered' },
    };

    fetchSpy.mockResolvedValue({
      events: [subEvent],
      epoch: 1,
      hasMore: false,
      nextCursor: null,
    });

    const ws: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineHistoryRequest,
    } as unknown as WsClient;

    let timeline: ReturnType<typeof useTimeline> | null = null;
    function Probe() {
      timeline = useTimeline(subSession, ws, serverId, { isVisible: true });
      return h('div', null, 'probe');
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe));

    await waitFor(() => {
      expect(sendTimelineHistoryRequest).toHaveBeenCalledTimes(1);
    });

    // Sub-session encounters a transient error
    await act(async () => {
      handler?.({
        type: 'timeline.history',
        sessionName: subSession,
        requestId: 'req-sub-err',
        epoch: 1,
        events: [],
        status: TIMELINE_RESPONSE_STATUS.ERROR,
        errorReason: TIMELINE_HISTORY_ERROR_REASONS.TIMEOUT,
        recoverable: true,
      } as ServerMessage);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(timeline!.historyStatus.response?.state).toBe('error');

    // Force refresh recovers the sub-session history
    await act(async () => {
      timeline!.forceRefresh();
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(timeline!.events.some((e) => e.eventId === subEvent.eventId)).toBe(true);
    expect(timeline!.historyStatus.response?.state).not.toBe('error');
  });

  it('retries transient null HTTP backfill and clears error once retry succeeds', async () => {
    const sessionName = `deck_retry_clear_${Date.now()}`;
    const serverId = `srv-retry-${Date.now()}`;
    let handler: ((msg: ServerMessage) => void) | null = null;
    const sendTimelineHistoryRequest = vi.fn(() => 'req-retry-err');

    const event: TimelineEvent = {
      eventId: `${sessionName}-ev-retry`,
      sessionId: sessionName,
      ts: 4000,
      epoch: 1,
      seq: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'after-retry' },
    };

    // First attempt returns null (transient blip), second attempt succeeds
    fetchSpy
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        events: [event],
        epoch: 1,
        hasMore: false,
        nextCursor: null,
      });

    const ws: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineHistoryRequest,
    } as unknown as WsClient;

    let timeline: ReturnType<typeof useTimeline> | null = null;
    function Probe() {
      timeline = useTimeline(sessionName, ws, serverId);
      return h('div', null, 'probe');
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe));

    await waitFor(() => {
      expect(sendTimelineHistoryRequest).toHaveBeenCalledTimes(1);
    });

    // Set error on timeline
    await act(async () => {
      handler?.({
        type: 'timeline.history',
        sessionName,
        requestId: 'req-retry-err',
        epoch: 1,
        events: [],
        status: TIMELINE_RESPONSE_STATUS.ERROR,
        errorReason: TIMELINE_HISTORY_ERROR_REASONS.QUEUE_FULL,
        recoverable: true,
      } as ServerMessage);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(timeline!.historyStatus.response?.state).toBe('error');

    // Trigger refresh: first HTTP fetch returns null, then retries after delay and succeeds
    await act(async () => {
      timeline!.forceRefresh();
      // First attempt
      await vi.advanceTimersByTimeAsync(100);
      // Wait for retry delay (800ms)
      await vi.advanceTimersByTimeAsync(900);
    });

    expect(timeline!.events.some((e) => e.eventId === event.eventId)).toBe(true);
    expect(timeline!.historyStatus.response?.state).not.toBe('error');
  });

  describe('audit regression & boundary invariants', () => {
    beforeEach(() => {
      __resetTimelineCacheForTests();
      cleanup();
      fetchSpy.mockReset();
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      cleanup();
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    function auditEvent(session: string, id = 'good', ts = 1000) {
      return {
        eventId: session + id,
        sessionId: session,
        ts,
        epoch: 1,
        seq: 1,
        source: 'daemon',
        confidence: 'high',
        type: 'assistant.text',
        payload: { text: id },
      } as any;
    }

    function auditFixture(session: string) {
      let timeline: any;
      let handler: any;
      let n = 0;
      const ws: any = {
        connected: true,
        onMessage: (cb: any) => {
          handler = cb;
          return () => { handler = null; };
        },
        sendTimelineHistoryRequest: vi.fn(() => `r${++n}`),
      };
      function Probe(props: { session: string }) {
        timeline = useTimeline(props.session, ws, 'audit-server');
        return h('div', null, props.session);
      }
      const rendered = render(h(Probe, { session }));
      return {
        get tl() { return timeline; },
        get handler() { return handler; },
        get rid() { return `r${n}`; },
        ws,
        switchTo: (s: string) => rendered.rerender(h(Probe, { session: s })),
      };
    }

    it('audit: a newer daemon error must not be cleared by an earlier successful HTTP round', async () => {
      const s = 'audit-newer-error';
      ingestTimelineEventForCache(auditEvent(s), 'audit-server');
      fetchSpy.mockResolvedValue({ events: [], epoch: 1, hasMore: false, nextCursor: null });
      const f = auditFixture(s);
      await waitFor(() => expect(f.ws.sendTimelineHistoryRequest).toHaveBeenCalled());
      await act(async () => {
        f.handler({ type: 'timeline.history', sessionName: s, requestId: f.rid, epoch: 1, events: [auditEvent(s)] });
        await vi.advanceTimersByTimeAsync(300);
      });
      await act(async () => {
        f.tl.forceRefresh();
        await vi.advanceTimersByTimeAsync(100);
      });
      await act(async () => {
        f.handler({
          type: 'timeline.history',
          sessionName: s,
          requestId: f.rid,
          epoch: 1,
          events: [],
          status: 'error',
          errorReason: TIMELINE_HISTORY_ERROR_REASONS.QUEUE_FULL,
          recoverable: false,
        });
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(f.tl.historyStatus.response?.state).toBe('error');
    });

    it('audit: a payload-truncated HTTP page must not clear a real history error as recovered', async () => {
      const s = 'audit-incomplete';
      ingestTimelineEventForCache(auditEvent(s), 'audit-server');
      const pending = deferred<any>();
      fetchSpy.mockImplementation(() => pending.promise);
      const f = auditFixture(s);
      await waitFor(() => expect(f.ws.sendTimelineHistoryRequest).toHaveBeenCalled());
      await act(async () => {
        f.handler({
          type: 'timeline.history',
          sessionName: s,
          requestId: f.rid,
          epoch: 1,
          events: [],
          status: 'error',
          errorReason: TIMELINE_HISTORY_ERROR_REASONS.DEADLINE_EXCEEDED,
          recoverable: false,
        });
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(f.tl.historyStatus.response?.state).toBe('error');
      await act(async () => {
        pending.resolve({
          events: [auditEvent(s, 'partial', 2000)],
          epoch: 1,
          hasMore: true,
          payloadTruncated: true,
          nextCursor: null,
        });
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(f.tl.historyStatus.response?.state).toBe('error');
    });

    it('audit: old-scope completion must not end the current foreground HTTP refresh', async () => {
      const a = 'audit-scope-a';
      const b = 'audit-scope-b';
      for (const s of [a, b]) ingestTimelineEventForCache(auditEvent(s), 'audit-server');
      const pa = deferred<any>();
      const pb = deferred<any>();
      fetchSpy.mockImplementation((_server: any, s: any) => (s === a ? pa.promise : pb.promise));
      const f = auditFixture(a);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
        f.tl.forceRefresh();
        await vi.advanceTimersByTimeAsync(50);
      });
      f.switchTo(b);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
        f.tl.forceRefresh();
        await vi.advanceTimersByTimeAsync(50);
      });
      await act(async () => {
        f.handler({ type: 'timeline.history', sessionName: b, requestId: f.rid, epoch: 1, events: [auditEvent(b)] });
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(f.tl.refreshing).toBe(true);
      await act(async () => {
        pa.resolve({ events: [], epoch: 1, hasMore: false, nextCursor: null });
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(f.tl.refreshing).toBe(true);

      // Settle B's HTTP fetch
      await act(async () => {
        pb.resolve({ events: [], epoch: 1, hasMore: false, nextCursor: null });
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(f.tl.refreshing).toBe(false);
    });

    it('audit: A -> B -> A navigation isolates old generation from current session', async () => {
      const a = 'audit-scope-revisit-a';
      const b = 'audit-scope-revisit-b';
      for (const s of [a, b]) ingestTimelineEventForCache(auditEvent(s), 'audit-server');
      const paOld = deferred<any>();
      const pb = deferred<any>();
      const paNew = deferred<any>();
      let aCallCount = 0;
      fetchSpy.mockImplementation((_server: any, s: any) => {
        if (s === a) {
          aCallCount++;
          return aCallCount === 1 ? paOld.promise : paNew.promise;
        }
        return pb.promise;
      });

      // Generation 1: A
      const f = auditFixture(a);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
        f.tl.forceRefresh();
        await vi.advanceTimersByTimeAsync(50);
      });

      // Generation 2: B
      f.switchTo(b);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      // Generation 3: Back to A
      f.switchTo(a);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
        f.tl.forceRefresh();
        await vi.advanceTimersByTimeAsync(50);
      });

      // A's generation 3 WS completes, but A's generation 3 HTTP is still pending
      await act(async () => {
        f.handler({ type: 'timeline.history', sessionName: a, requestId: f.rid, epoch: 1, events: [auditEvent(a)] });
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(f.tl.refreshing).toBe(true);

      // Now generation 1 of A finally resolves late
      await act(async () => {
        paOld.resolve({ events: [], epoch: 1, hasMore: false, nextCursor: null });
        await vi.advanceTimersByTimeAsync(50);
      });

      // Must NOT terminate generation 3's in-flight refresh!
      expect(f.tl.refreshing).toBe(true);

      // Settle generation 3's HTTP
      await act(async () => {
        paNew.resolve({ events: [], epoch: 1, hasMore: false, nextCursor: null });
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(f.tl.refreshing).toBe(false);
    });
  });
});
