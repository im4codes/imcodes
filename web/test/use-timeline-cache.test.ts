/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import type { ServerMessage, TimelineEvent, WsClient } from '../src/ws-client.js';
import { TIMELINE_CURSOR_DIRECTIONS, TIMELINE_MESSAGES, TIMELINE_RESPONSE_STATUS } from '../../shared/timeline-protocol.js';
import { TIMELINE_DETAIL_ERROR_REASONS, TIMELINE_HISTORY_ERROR_REASONS } from '../../shared/timeline-history-errors.js';
import { TimelineDB } from '../src/timeline-db.js';
import { mergeTimelineEvents } from '../../src/shared/timeline/merge.js';
const fetchHistorySpy = vi.hoisted(() => vi.fn());
const fetchTextTailSpy = vi.hoisted(() => vi.fn());
vi.mock('../src/api.js', () => ({
  fetchTimelineHistoryHttp: fetchHistorySpy,
  fetchTimelineTextTailHttp: fetchTextTailSpy,
}));
import {
  __clearPersistedTimelineSnapshotsForTests,
  __getTimelineCacheKeysForTests,
  __getSharedTimelineBaseForTests,
  __resetTimelineCacheForTests,
  __setTimelineCacheForTests,
  ingestTimelineEventForCache,
  useTimeline,
} from '../src/hooks/useTimeline.js';

function makeEvents(sessionId: string, count: number): TimelineEvent[] {
  return Array.from({ length: count }, (_, idx) => ({
    eventId: `${sessionId}-${idx}`,
    sessionId,
    ts: idx,
    epoch: 1,
    seq: idx,
    source: 'daemon',
    confidence: 'high',
    type: 'assistant.text',
    payload: { text: `${sessionId}-${idx}` },
  }));
}

describe('useTimeline global cache bounds', () => {
  beforeEach(() => {
    __resetTimelineCacheForTests();
    __clearPersistedTimelineSnapshotsForTests();
    cleanup();
    fetchHistorySpy.mockReset();
    fetchTextTailSpy.mockReset();
    fetchHistorySpy.mockResolvedValue(null);
    fetchTextTailSpy.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('evicts least recently used sessions when session-count cap is exceeded', () => {
    for (let i = 0; i < 13; i++) {
      __setTimelineCacheForTests(`server:s${i}`, makeEvents(`s${i}`, 100));
    }

    const keys = __getTimelineCacheKeysForTests();
    expect(keys).toHaveLength(12);
    expect(keys).not.toContain('server:s0');
    expect(keys).toContain('server:s12');
  });

  it('evicts older sessions when total cached events exceed the global cap', () => {
    __setTimelineCacheForTests('server:a', makeEvents('a', 4000));
    __setTimelineCacheForTests('server:b', makeEvents('b', 4000));
    __setTimelineCacheForTests('server:c', makeEvents('c', 4000));
    __setTimelineCacheForTests('server:d', makeEvents('d', 4000));

    const keys = __getTimelineCacheKeysForTests();
    expect(keys).toHaveLength(3);
    expect(keys).not.toContain('server:a');
    expect(keys).toContain('server:b');
    expect(keys).toContain('server:c');
    expect(keys).toContain('server:d');
  });

  it('pushes cache updates to already-mounted hooks for the same session', async () => {
    function Probe({ name }: { name: string }) {
      const { events } = useTimeline('deck_sub_codex', null, 'srv');
      return h('div', { 'data-testid': name }, String(events.length));
    }

    render(
      h('div', null,
        h(Probe, { name: 'card' }),
        h(Probe, { name: 'window' }),
      ),
    );

    expect(screen.getByTestId('card').textContent).toBe('0');
    expect(screen.getByTestId('window').textContent).toBe('0');

    await act(async () => {
      __setTimelineCacheForTests('srv:deck_sub_codex', makeEvents('deck_sub_codex', 3));
    });

    expect(screen.getByTestId('card').textContent).toBe('3');
    expect(screen.getByTestId('window').textContent).toBe('3');
  });

  it('stays idle for shell/script sessions with history disabled', async () => {
    const sessionName = `deck_shell_${Date.now()}`;
    const serverId = `srv-${Date.now()}`;
    const sendTimelineHistoryRequest = vi.fn(() => 'history-shell');
    const ws: WsClient = {
      connected: true,
      onMessage: () => () => {},
      sendTimelineHistoryRequest,
    } as unknown as WsClient;

    function Probe() {
      const { events, loading, refreshing, hasOlderHistory, historyStatus } = useTimeline(sessionName, ws, serverId, {
        disableHistory: true,
      });
      return h(
        'div',
        {
          'data-testid': 'probe',
          'data-loading': String(loading),
          'data-refreshing': String(refreshing),
          'data-older': String(hasOlderHistory),
          'data-phase': historyStatus.phase,
        },
        String(events.length),
      );
    }

    render(h(Probe));

    await waitFor(() => {
      const probe = screen.getByTestId('probe');
      expect(probe.textContent).toBe('0');
      expect(probe.getAttribute('data-loading')).toBe('false');
      expect(probe.getAttribute('data-refreshing')).toBe('false');
      expect(probe.getAttribute('data-older')).toBe('false');
      expect(probe.getAttribute('data-phase')).toBe('idle');
    });

    expect(sendTimelineHistoryRequest).not.toHaveBeenCalled();
    expect(fetchTextTailSpy).not.toHaveBeenCalled();
    expect(fetchHistorySpy).not.toHaveBeenCalled();
  });

  it('keeps active session cache resident so a late stale instance cannot wipe history on the next event', async () => {
    const sessionName = `deck_transport_live_${Date.now()}`;
    const cacheKey = `srv:${sessionName}`;
    let handlerA: ((msg: ServerMessage) => void) | null = null;
    let handlerB: ((msg: ServerMessage) => void) | null = null;

    const wsA: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handlerA = next;
        return () => { handlerA = null; };
      },
      sendTimelineHistoryRequest: () => 'history-a',
    } as unknown as WsClient;

    const wsB: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handlerB = next;
        return () => { handlerB = null; };
      },
      sendTimelineHistoryRequest: () => 'history-b',
    } as unknown as WsClient;

    function Probe({ name, ws }: { name: string; ws: WsClient }) {
      const { events } = useTimeline(sessionName, ws, 'srv');
      return h(
        'div',
        { 'data-testid': name },
        events.map((event) => String(event.payload.text ?? '')).join('|'),
      );
    }

    const view = render(h(Probe, { name: 'primary', ws: wsA }));

    await act(async () => {
      handlerA?.({
        type: 'timeline.history',
        sessionName,
        requestId: 'history-a',
        epoch: 1,
        events: [
          {
            eventId: `${sessionName}-1`,
            sessionId: sessionName,
            ts: 1,
            epoch: 1,
            seq: 1,
            source: 'daemon',
            confidence: 'high',
            type: 'user.message',
            payload: { text: 'first' },
          },
          {
            eventId: `${sessionName}-2`,
            sessionId: sessionName,
            ts: 2,
            epoch: 1,
            seq: 2,
            source: 'daemon',
            confidence: 'high',
            type: 'assistant.text',
            payload: { text: 'second' },
          },
        ],
      } as ServerMessage);
    });

    await waitFor(() => {
      expect(screen.getByTestId('primary').textContent).toBe('first|second');
    });

    for (let i = 0; i < 13; i++) {
      __setTimelineCacheForTests(`srv:other-${i}`, makeEvents(`other-${i}`, 100));
    }

    expect(__getTimelineCacheKeysForTests()).toContain(cacheKey);

    vi.spyOn(TimelineDB.prototype, 'open').mockImplementation(() => new Promise(() => {}));

    view.rerender(
      h('div', null,
        h(Probe, { name: 'primary', ws: wsA }),
        h(Probe, { name: 'secondary', ws: wsB }),
      ),
    );

    await act(async () => {
      handlerB?.({
        type: 'timeline.event',
        event: {
          eventId: `${sessionName}-3`,
          sessionId: sessionName,
          ts: 3,
          epoch: 1,
          seq: 3,
          source: 'daemon',
          confidence: 'high',
          type: 'assistant.text',
          payload: { text: 'third' },
        },
      } as ServerMessage);
    });

    await waitFor(() => {
      expect(screen.getByTestId('primary').textContent).toBe('first|second|third');
      expect(screen.getByTestId('secondary').textContent).toBe('first|second|third');
    });
  });

  it('uses the shared cache as the merge base when a late instance is locally stale', () => {
    const sessionName = `deck_transport_${Date.now()}`;
    const cacheKey = `srv:${sessionName}`;
    const history = [
      {
        eventId: `${sessionName}-1`,
        sessionId: sessionName,
        ts: 1,
        epoch: 1,
        seq: 1,
        source: 'daemon',
        confidence: 'high',
        type: 'user.message',
        payload: { text: 'first' },
      },
      {
        eventId: `${sessionName}-2`,
        sessionId: sessionName,
        ts: 2,
        epoch: 1,
        seq: 2,
        source: 'daemon',
        confidence: 'high',
        type: 'assistant.text',
        payload: { text: 'second' },
      },
    ] satisfies TimelineEvent[];

    __setTimelineCacheForTests(cacheKey, history);

    const base = __getSharedTimelineBaseForTests(cacheKey, []);
    const next = mergeTimelineEvents(base, [{
      eventId: `${sessionName}-3`,
      sessionId: sessionName,
      ts: 3,
      epoch: 1,
      seq: 3,
      source: 'daemon',
      confidence: 'high',
      type: 'user.message',
      payload: { text: 'third' },
    }], 300);

    expect(base).toEqual(history);
    expect(next.map((event) => String(event.payload.text ?? ''))).toEqual(['first', 'second', 'third']);
  });

  it('restores history from IndexedDB using the server-scoped cache key after remount', async () => {
    const sessionName = `deck_sub_transport_${Date.now()}`;
    const serverId = `srv-${Date.now()}`;
    let handler: ((msg: ServerMessage) => void) | null = null;
    let requestId = 'history-1';

    const ws: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineHistoryRequest: () => requestId,
    } as unknown as WsClient;

    function Probe({ name }: { name: string }) {
      const { events } = useTimeline(sessionName, ws, serverId);
      return h('div', { 'data-testid': name }, String(events.length));
    }

    const first = render(h(Probe, { name: 'probe' }));

    await act(async () => {
      handler?.({
        type: 'timeline.history',
        sessionName,
        requestId,
        epoch: 100,
        events: [{
          eventId: `${sessionName}-e1`,
          sessionId: sessionName,
          ts: 1,
          epoch: 100,
          seq: 1,
          source: 'daemon',
          confidence: 'high',
          type: 'assistant.text',
          payload: { text: 'hello' },
        }],
      } as ServerMessage);
    });

    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('1');
    });

    first.unmount();
    __resetTimelineCacheForTests();
    requestId = 'history-2';

    render(h(Probe, { name: 'probe-2' }));

    await waitFor(() => {
      expect(screen.getByTestId('probe-2').textContent).toBe('1');
    });
  });

  it('renders immediately from the persisted local snapshot before IndexedDB resolves', async () => {
    const sessionName = `deck_local_snapshot_${Date.now()}`;
    const serverId = `srv-${Date.now()}`;

    ingestTimelineEventForCache({
      eventId: `${sessionName}-snap-1`,
      sessionId: sessionName,
      ts: 1,
      epoch: 1,
      seq: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'snapshot history' },
    }, serverId);

    __resetTimelineCacheForTests();
    vi.spyOn(TimelineDB.prototype, 'open').mockImplementation(() => new Promise(() => {}));

    function Probe() {
      const { events, loading } = useTimeline(sessionName, null, serverId);
      return h('div', { 'data-testid': 'probe', 'data-loading': String(loading) }, events.map((event) => String(event.payload.text ?? '')).join('|'));
    }

    render(h(Probe));

    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('snapshot history');
      expect(screen.getByTestId('probe').getAttribute('data-loading')).toBe('false');
    });
  });

  it('does not use the PostgreSQL text-tail bootstrap path', async () => {
    const sessionName = `deck_no_text_tail_${Date.now()}`;
    const serverId = `srv-${Date.now()}`;
    const sendTimelineHistoryRequest = vi.fn(() => 'history-no-text-tail');
    const ws: WsClient = {
      connected: true,
      onMessage: () => () => {},
      sendTimelineHistoryRequest,
    } as unknown as WsClient;

    function Probe() {
      const { historyStatus } = useTimeline(sessionName, ws, serverId);
      return h('div', { 'data-testid': 'probe', 'data-text-tail': historyStatus.steps.textTail }, 'probe');
    }

    render(h(Probe));

    await waitFor(() => {
      expect(sendTimelineHistoryRequest).toHaveBeenCalledWith(sessionName);
      expect(fetchTextTailSpy).not.toHaveBeenCalled();
      expect(screen.getByTestId('probe').getAttribute('data-text-tail')).toBe('skipped');
    });
  });

  it('requests timeline history when the socket connects after the first mount', async () => {
    const sessionName = `deck_late_connect_${Date.now()}`;
    const serverId = `srv-${Date.now()}`;
    let connected = false;
    const sendTimelineHistoryRequest = vi.fn(() => 'history-late-connect');

    const ws: WsClient = {
      get connected() {
        return connected;
      },
      onMessage: () => () => {},
      sendTimelineHistoryRequest,
    } as unknown as WsClient;

    function Probe({ tick }: { tick: number }) {
      const { loading } = useTimeline(sessionName, ws, serverId);
      return h('div', { 'data-testid': 'probe', 'data-tick': String(tick) }, String(loading));
    }

    const view = render(h(Probe, { tick: 0 }));

    expect(sendTimelineHistoryRequest).not.toHaveBeenCalled();

    connected = true;
    view.rerender(h(Probe, { tick: 1 }));

    await waitFor(() => {
      expect(sendTimelineHistoryRequest).toHaveBeenCalledWith(sessionName);
    });
  });

  it('marks refreshing during a cold WS history bootstrap with no local cache', async () => {
    const sessionName = `deck_cold_history_refreshing_${Date.now()}`;
    const serverId = `srv-${Date.now()}`;
    let handler: ((msg: ServerMessage) => void) | null = null;

    const ws: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineHistoryRequest: vi.fn(() => 'history-cold-refreshing'),
    } as unknown as WsClient;

    function Probe() {
      const { refreshing } = useTimeline(sessionName, ws, serverId);
      return h('div', { 'data-testid': 'probe', 'data-refreshing': String(refreshing) }, 'probe');
    }

    render(h(Probe));

    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-refreshing')).toBe('true');
    });

    await act(async () => {
      handler?.({
        type: 'timeline.history',
        sessionName,
        requestId: 'history-cold-refreshing',
        epoch: 1,
        events: [],
      } as ServerMessage);
    });

    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-refreshing')).toBe('false');
    });
  });

  it('does not retry explicit queue-full timeline history errors during bootstrap', async () => {
    const sessionName = `deck_queue_full_history_${Date.now()}`;
    let handler: ((msg: ServerMessage) => void) | null = null;
    const sendTimelineHistoryRequest = vi.fn(() => 'history-queue-full');
    const ws: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineHistoryRequest,
    } as unknown as WsClient;

    function Probe() {
      const { loading, refreshing, historyStatus } = useTimeline(sessionName, ws);
      return h('div', {
        'data-testid': 'probe',
        'data-loading': String(loading),
        'data-refreshing': String(refreshing),
        'data-response': historyStatus.response?.state ?? '',
        'data-key': historyStatus.response?.i18nKey ?? '',
      }, 'probe');
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe));

    await waitFor(() => {
      expect(sendTimelineHistoryRequest).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      handler?.({
        type: 'timeline.history',
        sessionName,
        requestId: 'history-queue-full',
        epoch: 1,
        events: [],
        status: TIMELINE_RESPONSE_STATUS.ERROR,
        errorReason: TIMELINE_HISTORY_ERROR_REASONS.QUEUE_FULL,
        recoverable: false,
      } as ServerMessage);
      await vi.advanceTimersByTimeAsync(2_500);
    });

    expect(sendTimelineHistoryRequest).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('probe').getAttribute('data-loading')).toBe('false');
    expect(screen.getByTestId('probe').getAttribute('data-refreshing')).toBe('false');
    expect(screen.getByTestId('probe').getAttribute('data-response')).toBe('error');
    expect(screen.getByTestId('probe').getAttribute('data-key')).toBe('chat.timelineStatus.queueFull');
  });

  it('does not blindly retry non-recoverable worker timeout or unavailable history errors', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const cases = [
      {
        reason: TIMELINE_HISTORY_ERROR_REASONS.TIMEOUT,
        expectedKey: 'chat.timelineStatus.timeout',
      },
      {
        reason: TIMELINE_HISTORY_ERROR_REASONS.UNAVAILABLE,
        expectedKey: 'chat.timelineStatus.unavailable',
      },
    ] as const;

    for (const { reason, expectedKey } of cases) {
      cleanup();
      __resetTimelineCacheForTests();
      __clearPersistedTimelineSnapshotsForTests();

      const sessionName = `deck_worker_error_${reason}_${Date.now()}`;
      const requestId = `history-${reason}`;
      let handler: ((msg: ServerMessage) => void) | null = null;
      const sendTimelineHistoryRequest = vi.fn(() => requestId);
      const ws: WsClient = {
        connected: true,
        onMessage: (next: (msg: ServerMessage) => void) => {
          handler = next;
          return () => { handler = null; };
        },
        sendTimelineHistoryRequest,
      } as unknown as WsClient;

      function Probe() {
        const { loading, refreshing, historyStatus } = useTimeline(sessionName, ws);
        return h('div', {
          'data-testid': 'probe',
          'data-loading': String(loading),
          'data-refreshing': String(refreshing),
          'data-response': historyStatus.response?.state ?? '',
          'data-key': historyStatus.response?.i18nKey ?? '',
        }, 'probe');
      }

      render(h(Probe));

      await waitFor(() => {
        expect(sendTimelineHistoryRequest).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        handler?.({
          type: TIMELINE_MESSAGES.HISTORY,
          sessionName,
          requestId,
          epoch: 1,
          events: [],
          status: TIMELINE_RESPONSE_STATUS.ERROR,
          errorReason: reason,
          recoverable: false,
        } as ServerMessage);
        await vi.advanceTimersByTimeAsync(2_500);
      });

      expect(sendTimelineHistoryRequest).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('probe').getAttribute('data-loading')).toBe('false');
      expect(screen.getByTestId('probe').getAttribute('data-refreshing')).toBe('false');
      expect(screen.getByTestId('probe').getAttribute('data-response')).toBe('error');
      expect(screen.getByTestId('probe').getAttribute('data-key')).toBe(expectedKey);
    }
  });

  it('keeps legacy replay-gap truncated separate from payload truncation', async () => {
    const sessionName = `deck_replay_truncation_${Date.now()}`;
    let handler: ((msg: ServerMessage) => void) | null = null;
    const sendSnapshotRequest = vi.fn();
    const ws: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineHistoryRequest: vi.fn(() => 'history-replay-truncation'),
      sendSnapshotRequest,
    } as unknown as WsClient;

    function Probe() {
      const { historyStatus } = useTimeline(sessionName, ws);
      return h('div', {
        'data-testid': 'probe',
        'data-key': historyStatus.response?.i18nKey ?? '',
      }, 'probe');
    }

    render(h(Probe));

    await waitFor(() => {
      expect(ws.sendTimelineHistoryRequest).toHaveBeenCalledWith(sessionName);
    });

    await act(async () => {
      handler?.({
        type: TIMELINE_MESSAGES.REPLAY,
        sessionName,
        epoch: 1,
        events: [],
        status: TIMELINE_RESPONSE_STATUS.PARTIAL,
        payloadTruncated: true,
      } as ServerMessage);
    });

    expect(sendSnapshotRequest).not.toHaveBeenCalled();
    expect(screen.getByTestId('probe').getAttribute('data-key')).toBe('chat.timelineStatus.payloadTruncated');

    await act(async () => {
      handler?.({
        type: TIMELINE_MESSAGES.REPLAY,
        sessionName,
        epoch: 1,
        events: [],
        truncated: true,
      } as ServerMessage);
    });

    expect(sendSnapshotRequest).toHaveBeenCalledTimes(1);
    expect(sendSnapshotRequest).toHaveBeenCalledWith(sessionName);
  });

  it('keeps older pagination driven by hasMore plus structured nextCursor', async () => {
    const sessionName = `deck_partial_older_${Date.now()}`;
    let handler: ((msg: ServerMessage) => void) | null = null;
    let requestSeq = 0;
    let lastRequestId = '';
    const sendTimelineHistoryRequest = vi.fn(() => {
      requestSeq += 1;
      lastRequestId = `history-${requestSeq}`;
      return lastRequestId;
    });
    const sendTimelinePageRequest = vi.fn(() => {
      requestSeq += 1;
      lastRequestId = `page-${requestSeq}`;
      return lastRequestId;
    });

    __setTimelineCacheForTests(sessionName, [{
      eventId: `${sessionName}-seed`,
      sessionId: sessionName,
      ts: 1000,
      epoch: 1,
      seq: 10,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'seed' },
    }]);

    const ws: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineHistoryRequest,
      sendTimelinePageRequest,
      supportsTimelineProtocolRevision: vi.fn(() => true),
    } as unknown as WsClient;

    function Probe() {
      const timeline = useTimeline(sessionName, ws);
      return h('button', {
        type: 'button',
        'data-testid': 'older',
        'data-older': String(timeline.hasOlderHistory),
        'data-loading': String(timeline.loadingOlder),
        'data-events': String(timeline.events.length),
        'data-text': timeline.events.map((event) => String(event.payload.text ?? '')).join('|'),
        onClick: timeline.loadOlderEvents,
      }, 'older');
    }

    render(h(Probe));

    await waitFor(() => {
      expect(screen.getByTestId('older').getAttribute('data-events')).toBe('1');
      expect(sendTimelineHistoryRequest).toHaveBeenCalled();
    });
    const initialRequestId = lastRequestId;
    await act(async () => {
      handler?.({
        type: TIMELINE_MESSAGES.HISTORY,
        sessionName,
        requestId: initialRequestId,
        epoch: 1,
        events: [],
        status: TIMELINE_RESPONSE_STATUS.PARTIAL,
        payloadTruncated: true,
        hasMore: true,
        nextCursor: { epoch: 1, beforeTs: 1000, direction: TIMELINE_CURSOR_DIRECTIONS.OLDER },
      } as ServerMessage);
    });
    sendTimelineHistoryRequest.mockClear();

    await act(async () => {
      screen.getByTestId('older').click();
    });
    expect(sendTimelinePageRequest).toHaveBeenCalledWith(
      sessionName,
      { epoch: 1, beforeTs: 1000, direction: TIMELINE_CURSOR_DIRECTIONS.OLDER },
      300,
    );
    expect(sendTimelineHistoryRequest).not.toHaveBeenCalled();
    const olderRequestId = lastRequestId;

    await act(async () => {
      handler?.({
        type: TIMELINE_MESSAGES.PAGE,
        sessionName,
        requestId: olderRequestId,
        epoch: 1,
        events: [],
        status: TIMELINE_RESPONSE_STATUS.PARTIAL,
        payloadTruncated: true,
        hasMore: true,
        nextCursor: { epoch: 1, beforeTs: 500, direction: TIMELINE_CURSOR_DIRECTIONS.OLDER },
      } as ServerMessage);
    });

    await waitFor(() => {
      expect(screen.getByTestId('older').getAttribute('data-loading')).toBe('false');
      expect(screen.getByTestId('older').getAttribute('data-older')).toBe('true');
    });

    sendTimelineHistoryRequest.mockClear();
    sendTimelinePageRequest.mockClear();
    await act(async () => {
      screen.getByTestId('older').click();
    });

    expect(sendTimelinePageRequest).toHaveBeenCalledWith(
      sessionName,
      { epoch: 1, beforeTs: 500, direction: TIMELINE_CURSOR_DIRECTIONS.OLDER },
      300,
    );
    expect(sendTimelineHistoryRequest).not.toHaveBeenCalled();

    const pageRequestId = lastRequestId;
    await act(async () => {
      handler?.({
        type: TIMELINE_MESSAGES.PAGE,
        sessionName,
        requestId: pageRequestId,
        epoch: 1,
        events: [{
          eventId: `${sessionName}-older-page`,
          sessionId: sessionName,
          ts: 400,
          epoch: 1,
          seq: 4,
          source: 'daemon',
          confidence: 'high',
          type: 'assistant.text',
          payload: { text: 'older-page' },
        }],
        status: TIMELINE_RESPONSE_STATUS.PARTIAL,
        payloadTruncated: true,
        hasMore: false,
      } as ServerMessage);
    });

    await waitFor(() => {
      expect(screen.getByTestId('older').getAttribute('data-events')).toBe('2');
      expect(screen.getByTestId('older').getAttribute('data-text')).toBe('older-page|seed');
      expect(screen.getByTestId('older').getAttribute('data-loading')).toBe('false');
      expect(screen.getByTestId('older').getAttribute('data-older')).toBe('false');
    });
  });

  it('does not close older pagination on terminal or deferred page outcomes', async () => {
    const sessionName = `deck_older_errors_${Date.now()}`;
    let handler: ((msg: ServerMessage) => void) | null = null;
    let requestSeq = 0;
    const sendTimelinePageRequest = vi.fn(() => `page-${++requestSeq}`);

    __setTimelineCacheForTests(sessionName, [{
      eventId: `${sessionName}-seed`,
      sessionId: sessionName,
      ts: 1000,
      epoch: 1,
      seq: 10,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'seed' },
    }]);

    const ws: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineHistoryRequest: vi.fn(() => 'history-older-errors'),
      sendTimelinePageRequest,
      supportsTimelineProtocolRevision: vi.fn(() => true),
    } as unknown as WsClient;

    function Probe() {
      const timeline = useTimeline(sessionName, ws);
      return h('button', {
        type: 'button',
        'data-testid': 'older-errors',
        'data-older': String(timeline.hasOlderHistory),
        'data-loading': String(timeline.loadingOlder),
        onClick: timeline.loadOlderEvents,
      }, 'older');
    }

    render(h(Probe));

    await waitFor(() => {
      expect(screen.getByTestId('older-errors').getAttribute('data-older')).toBe('true');
    });

    await act(async () => {
      handler?.({
        type: TIMELINE_MESSAGES.HISTORY,
        sessionName,
        requestId: 'history-older-errors',
        epoch: 1,
        events: [],
        status: TIMELINE_RESPONSE_STATUS.OK,
        hasMore: true,
        nextCursor: { epoch: 1, beforeTs: 1000, direction: TIMELINE_CURSOR_DIRECTIONS.OLDER },
      } as ServerMessage);
    });

    const outcomes = [
      { status: TIMELINE_RESPONSE_STATUS.ERROR, errorReason: TIMELINE_HISTORY_ERROR_REASONS.QUEUE_FULL },
      { status: TIMELINE_RESPONSE_STATUS.ERROR, errorReason: TIMELINE_HISTORY_ERROR_REASONS.TIMEOUT },
      { status: TIMELINE_RESPONSE_STATUS.CANCELED, errorReason: TIMELINE_HISTORY_ERROR_REASONS.REQUEST_CANCELED },
      { status: TIMELINE_RESPONSE_STATUS.DEFERRED },
    ] as const;

    for (const outcome of outcomes) {
      await act(async () => {
        screen.getByTestId('older-errors').click();
      });
      const requestId = `page-${requestSeq}`;
      await act(async () => {
        handler?.({
          type: TIMELINE_MESSAGES.PAGE,
          sessionName,
          requestId,
          epoch: 1,
          events: [],
          hasMore: false,
          ...outcome,
        } as ServerMessage);
      });

      expect(screen.getByTestId('older-errors').getAttribute('data-loading')).toBe('false');
      expect(screen.getByTestId('older-errors').getAttribute('data-older')).toBe('true');
    }
  });

  it('does not issue legacy older requests when structured cursor capability is missing', async () => {
    const sessionName = `deck_legacy_older_${Date.now()}`;
    let handler: ((msg: ServerMessage) => void) | null = null;
    const sendTimelineHistoryRequest = vi.fn(() => 'history-legacy-older');
    const sendTimelinePageRequest = vi.fn(() => 'page-legacy-older');

    __setTimelineCacheForTests(sessionName, [{
      eventId: `${sessionName}-seed`,
      sessionId: sessionName,
      ts: 1000,
      epoch: 1,
      seq: 10,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'seed' },
    }]);

    const ws: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineHistoryRequest,
      sendTimelinePageRequest,
      supportsTimelineProtocolRevision: vi.fn(() => false),
    } as unknown as WsClient;

    function Probe() {
      const timeline = useTimeline(sessionName, ws);
      return h('button', {
        type: 'button',
        'data-testid': 'legacy-older',
        onClick: timeline.loadOlderEvents,
      }, 'older');
    }

    render(h(Probe));

    await waitFor(() => {
      expect(sendTimelineHistoryRequest).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      handler?.({
        type: TIMELINE_MESSAGES.HISTORY,
        sessionName,
        requestId: 'history-legacy-older',
        epoch: 1,
        events: [],
        status: TIMELINE_RESPONSE_STATUS.OK,
        hasMore: true,
        nextCursor: { epoch: 1, beforeTs: 1000, direction: TIMELINE_CURSOR_DIRECTIONS.OLDER },
      } as ServerMessage);
    });
    sendTimelineHistoryRequest.mockClear();

    await act(async () => {
      screen.getByTestId('legacy-older').click();
    });

    expect(sendTimelineHistoryRequest).not.toHaveBeenCalled();
    expect(sendTimelinePageRequest).not.toHaveBeenCalled();
  });

  it('does not let bounded preview history overwrite a full cached event', async () => {
    const sessionName = `deck_full_cache_preview_${Date.now()}`;
    const eventId = `${sessionName}-tool-result`;
    let handler: ((msg: ServerMessage) => void) | null = null;
    const sendTimelineHistoryRequest = vi.fn(() => 'history-preview');

    __setTimelineCacheForTests(sessionName, [{
      eventId,
      sessionId: sessionName,
      ts: 10,
      epoch: 1,
      seq: 10,
      source: 'daemon',
      confidence: 'high',
      type: 'tool.result',
      payload: { text: 'complete cached output', completeness: 'full' },
    }]);

    const ws: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineHistoryRequest,
    } as unknown as WsClient;

    function Probe() {
      const { events } = useTimeline(sessionName, ws);
      return h('div', {
        'data-testid': 'probe',
        'data-events': String(events.length),
      }, events.map((event) => String(event.payload.text ?? '')).join('|'));
    }

    render(h(Probe));

    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('complete cached output');
      expect(sendTimelineHistoryRequest).toHaveBeenCalledWith(sessionName, 300, 9);
    });

    await act(async () => {
      handler?.({
        type: TIMELINE_MESSAGES.HISTORY,
        sessionName,
        requestId: 'history-preview',
        epoch: 1,
        events: [{
          eventId,
          sessionId: sessionName,
          ts: 11,
          epoch: 1,
          seq: 11,
          source: 'daemon',
          confidence: 'high',
          type: 'tool.result',
          payload: {
            text: 'preview output',
            completeness: 'preview',
            detailRefs: [{ detailId: 'td_preview', eventId, fieldPath: 'payload.text' }],
          },
        }],
        status: TIMELINE_RESPONSE_STATUS.PARTIAL,
        payloadTruncated: true,
      } as ServerMessage);
    });

    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-events')).toBe('1');
      expect(screen.getByTestId('probe').textContent).toBe('complete cached output');
    });
  });

  it('keeps rendered preview usable after missing or expired detail errors and recovers with a full page', async () => {
    const sessionName = `deck_detail_recovery_${Date.now()}`;
    const eventId = `${sessionName}-large-detail`;
    let handler: ((msg: ServerMessage) => void) | null = null;
    const sendTimelineHistoryRequest = vi.fn(() => 'history-detail-recovery');

    __setTimelineCacheForTests(sessionName, [{
      eventId,
      sessionId: sessionName,
      ts: 10,
      epoch: 1,
      seq: 10,
      source: 'daemon',
      confidence: 'high',
      type: 'tool.result',
      payload: {
        text: 'preview stays visible',
        completeness: 'preview',
        detailRefs: [{ detailId: 'td_old', eventId, fieldPath: 'payload.text' }],
      },
    }]);

    const ws: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineHistoryRequest,
    } as unknown as WsClient;

    function Probe() {
      const { events, historyStatus } = useTimeline(sessionName, ws);
      return h('div', {
        'data-testid': 'probe',
        'data-key': historyStatus.response?.i18nKey ?? '',
        'data-response': historyStatus.response?.state ?? '',
      }, events.map((event) => String(event.payload.text ?? '')).join('|'));
    }

    render(h(Probe));

    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('preview stays visible');
    });

    await act(async () => {
      handler?.({
        type: TIMELINE_MESSAGES.DETAIL,
        sessionName,
        requestId: 'detail-expired',
        detailId: 'td_old',
        eventId,
        fieldPath: 'payload.text',
        status: TIMELINE_RESPONSE_STATUS.ERROR,
        errorReason: TIMELINE_DETAIL_ERROR_REASONS.EXPIRED,
        recoverable: false,
      } as ServerMessage);
    });

    expect(screen.getByTestId('probe').textContent).toBe('preview stays visible');
    expect(screen.getByTestId('probe').getAttribute('data-response')).toBe('error');
    expect(screen.getByTestId('probe').getAttribute('data-key')).toBe('chat.timelineStatus.detailExpired');

    await act(async () => {
      handler?.({
        type: TIMELINE_MESSAGES.DETAIL,
        sessionName,
        requestId: 'detail-missing',
        detailId: 'td_old',
        eventId,
        fieldPath: 'payload.text',
        status: TIMELINE_RESPONSE_STATUS.ERROR,
        errorReason: TIMELINE_DETAIL_ERROR_REASONS.MISSING,
        recoverable: false,
      } as ServerMessage);
    });

    expect(screen.getByTestId('probe').textContent).toBe('preview stays visible');
    expect(screen.getByTestId('probe').getAttribute('data-response')).toBe('error');
    expect(screen.getByTestId('probe').getAttribute('data-key')).toBe('chat.timelineStatus.detailMissing');

    await act(async () => {
      handler?.({
        type: TIMELINE_MESSAGES.HISTORY,
        sessionName,
        requestId: 'history-detail-recovery',
        epoch: 1,
        events: [{
          eventId,
          sessionId: sessionName,
          ts: 11,
          epoch: 1,
          seq: 11,
          source: 'daemon',
          confidence: 'high',
          type: 'tool.result',
          payload: { text: 'full output recovered', completeness: 'full' },
        }],
        status: TIMELINE_RESPONSE_STATUS.OK,
      } as ServerMessage);
    });

    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('full output recovered');
      expect(screen.getByTestId('probe').getAttribute('data-response')).toBe('ok');
      expect(screen.getByTestId('probe').getAttribute('data-key')).toBe('chat.timelineStatus.ok');
    });
  });

  it('hydrates detail success without reporting empty history and maps terminal detail errors', async () => {
    const sessionName = `deck_detail_status_${Date.now()}`;
    const eventId = `${sessionName}-preview`;
    let handler: ((msg: ServerMessage) => void) | null = null;
    const sendTimelineHistoryRequest = vi.fn(() => 'history-detail-status');

    __setTimelineCacheForTests(sessionName, [{
      eventId,
      sessionId: sessionName,
      ts: 10,
      epoch: 1,
      seq: 10,
      source: 'daemon',
      confidence: 'high',
      type: 'tool.result',
      payload: {
        text: 'preview survives detail status',
        completeness: 'preview',
        detailRefs: [{ detailId: 'td_status', eventId, fieldPath: 'payload.text' }],
      },
    }]);

    const ws: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineHistoryRequest,
    } as unknown as WsClient;

    function Probe() {
      const { events, historyStatus } = useTimeline(sessionName, ws);
      return h('div', {
        'data-testid': 'probe',
        'data-key': historyStatus.response?.i18nKey ?? '',
        'data-response': historyStatus.response?.state ?? '',
      }, events.map((event) => String(event.payload.text ?? '')).join('|'));
    }

    render(h(Probe));

    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('preview survives detail status');
    });

    await act(async () => {
      handler?.({
        type: TIMELINE_MESSAGES.DETAIL,
        sessionName,
        requestId: 'detail-ok',
        detailId: 'td_status',
        eventId,
        fieldPath: 'payload.text',
        status: TIMELINE_RESPONSE_STATUS.OK,
        value: 'full detail payload',
        payloadBytes: 512,
        payloadTruncated: false,
      } as ServerMessage);
    });

    expect(screen.getByTestId('probe').textContent).toBe('full detail payload');
    expect(screen.getByTestId('probe').getAttribute('data-response')).toBe('detail');
    expect(screen.getByTestId('probe').getAttribute('data-key')).toBe('chat.timelineStatus.detailHydrated');

    const cases = [
      [TIMELINE_DETAIL_ERROR_REASONS.UNAUTHORIZED, 'chat.timelineStatus.detailUnauthorized'],
      [TIMELINE_DETAIL_ERROR_REASONS.OVERSIZED, 'chat.timelineStatus.detailOversized'],
      [TIMELINE_DETAIL_ERROR_REASONS.MALFORMED, 'chat.timelineStatus.detailMalformed'],
    ] as const;

    for (const [errorReason, key] of cases) {
      await act(async () => {
        handler?.({
          type: TIMELINE_MESSAGES.DETAIL,
          sessionName,
          requestId: `detail-${errorReason}`,
          detailId: 'td_status',
          eventId,
          fieldPath: 'payload.text',
          status: TIMELINE_RESPONSE_STATUS.ERROR,
          errorReason,
          recoverable: false,
        } as ServerMessage);
      });

      expect(screen.getByTestId('probe').textContent).toBe('full detail payload');
      expect(screen.getByTestId('probe').getAttribute('data-response')).toBe('error');
      expect(screen.getByTestId('probe').getAttribute('data-key')).toBe(key);
    }
  });

  it('rejects unsafe, unknown, and cross-event detail field paths', async () => {
    const sessionName = `deck_detail_safety_${Date.now()}`;
    const eventId = `${sessionName}-preview`;
    const otherEventId = `${sessionName}-other`;
    let handler: ((msg: ServerMessage) => void) | null = null;

    __setTimelineCacheForTests(sessionName, [{
      eventId,
      sessionId: sessionName,
      ts: 10,
      epoch: 1,
      seq: 10,
      source: 'daemon',
      confidence: 'high',
      type: 'tool.result',
      payload: {
        text: 'safe preview',
        completeness: 'preview',
        detailRefs: [{ detailId: 'td_safe', eventId, fieldPath: 'payload.text' }],
      },
    }, {
      eventId: otherEventId,
      sessionId: sessionName,
      ts: 11,
      epoch: 1,
      seq: 11,
      source: 'daemon',
      confidence: 'high',
      type: 'tool.result',
      payload: {
        text: 'other preview',
        completeness: 'preview',
        detailRefs: [{ detailId: 'td_other', eventId: otherEventId, fieldPath: 'payload.text' }],
      },
    }]);

    const ws: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineHistoryRequest: vi.fn(() => 'history-detail-safety'),
    } as unknown as WsClient;

    function Probe() {
      const { events } = useTimeline(sessionName, ws);
      return h('div', { 'data-testid': 'probe' }, events.map((event) => String(event.payload.text ?? '')).join('|'));
    }

    render(h(Probe));

    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('safe preview|other preview');
    });

    const rejected = [
      { detailId: 'td_safe', eventId, fieldPath: 'payload.__proto__' },
      { detailId: 'td_safe', eventId, fieldPath: 'payload.constructor' },
      { detailId: 'td_safe', eventId, fieldPath: 'payload.detail.raw' },
      { detailId: 'td_other', eventId, fieldPath: 'payload.text' },
    ];

    for (const detail of rejected) {
      await act(async () => {
        handler?.({
          type: TIMELINE_MESSAGES.DETAIL,
          sessionName,
          requestId: `detail-${detail.fieldPath}`,
          status: TIMELINE_RESPONSE_STATUS.OK,
          value: 'polluted',
          ...detail,
        } as ServerMessage);
      });
      expect(screen.getByTestId('probe').textContent).toBe('safe preview|other preview');
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    }

    await act(async () => {
      handler?.({
        type: TIMELINE_MESSAGES.DETAIL,
        sessionName,
        requestId: 'detail-safe',
        detailId: 'td_safe',
        eventId,
        fieldPath: 'payload.text',
        status: TIMELINE_RESPONSE_STATUS.OK,
        value: 'hydrated safely',
      } as ServerMessage);
    });

    expect(screen.getByTestId('probe').textContent).toBe('hydrated safely|other preview');
  });

  it('renders immediately from globally ingested timeline events before the first history request returns', async () => {
    const sessionName = `deck_sub_codex_sdk_${Date.now()}`;
    const serverId = `srv-${Date.now()}`;
    let handler: ((msg: ServerMessage) => void) | null = null;
    const sendTimelineHistoryRequest = vi.fn(() => 'history-live');

    ingestTimelineEventForCache({
      eventId: `${sessionName}-live-1`,
      sessionId: sessionName,
      ts: 1,
      epoch: 7,
      seq: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'live cached text' },
    }, serverId);

    const ws: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineReplayRequest: vi.fn(() => 'replay-after-ts'),
      sendTimelineHistoryRequest,
    } as unknown as WsClient;

    function Probe() {
      const { events } = useTimeline(sessionName, ws, serverId);
      return h('div', { 'data-testid': 'probe' }, events[0]?.payload.text as string ?? '');
    }

    render(h(Probe, {}));

    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('live cached text');
    });
    expect(sendTimelineHistoryRequest).toHaveBeenCalledWith(sessionName, 300, 0);

    await act(async () => {
      handler?.({
        type: 'timeline.history',
        sessionName,
        requestId: 'history-live',
        epoch: 7,
        events: [],
      } as ServerMessage);
    });

    expect(screen.getByTestId('probe').textContent).toBe('live cached text');
  });

  it('does not let a late IndexedDB restore overwrite newer live timeline events', async () => {
    const sessionName = `deck_transport_${Date.now()}`;
    const serverId = `srv-${Date.now()}`;
    const stored = [{
      eventId: `${sessionName}-stored-1`,
      sessionId: sessionName,
      ts: 1,
      epoch: 5,
      seq: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'stored history' },
    }] satisfies TimelineEvent[];
    let resolveRecentEvents: ((events: TimelineEvent[]) => void) | null = null;

    vi.spyOn(TimelineDB.prototype, 'open').mockResolvedValue();
    vi.spyOn(TimelineDB.prototype, 'getLastSeqAndEpoch').mockResolvedValue({ seq: 1, epoch: 5 });
    vi.spyOn(TimelineDB.prototype, 'getRecentEvents').mockImplementation(
      () => new Promise<TimelineEvent[]>((resolve) => {
        resolveRecentEvents = resolve;
      }),
    );

    function Probe() {
      const { events } = useTimeline(sessionName, null, serverId);
      return h(
        'div',
        { 'data-testid': 'probe' },
        events.map((event) => String(event.payload.text ?? '')).join('|'),
      );
    }

    render(h(Probe, {}));

    await act(async () => {
      ingestTimelineEventForCache({
        eventId: `${sessionName}-live-1`,
        sessionId: sessionName,
        ts: 2,
        epoch: 5,
        seq: 2,
        source: 'daemon',
        confidence: 'high',
        type: 'user.message',
        payload: { text: 'live transport send' },
      }, serverId);
    });

    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('live transport send');
    });

    await act(async () => {
      resolveRecentEvents?.(stored);
    });

    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('stored history|live transport send');
    });
  });

  it('does not dedup confirmed user messages marked allowDuplicate', async () => {
    const sessionName = `deck_transport_dup_${Date.now()}`;
    const serverId = `srv-${Date.now()}`;
    let handler: ((msg: ServerMessage) => void) | null = null;

    const ws: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineHistoryRequest: () => 'history-dup',
    } as unknown as WsClient;

    function Probe() {
      const { events } = useTimeline(sessionName, ws, serverId);
      return h(
        'div',
        { 'data-testid': 'probe-dup' },
        events.filter((event) => event.type === 'user.message').map((event) => String(event.payload.text ?? '')).join('|'),
      );
    }

    render(h(Probe, {}));

    await act(async () => {
      handler?.({
        type: 'timeline.event',
        event: {
          eventId: `${sessionName}-u1`,
          sessionId: sessionName,
          ts: 1,
          epoch: 1,
          seq: 1,
          source: 'daemon',
          confidence: 'high',
          type: 'user.message',
          payload: { text: 'retry', allowDuplicate: true },
        },
      } as ServerMessage);
      handler?.({
        type: 'timeline.event',
        event: {
          eventId: `${sessionName}-u2`,
          sessionId: sessionName,
          ts: 2,
          epoch: 1,
          seq: 2,
          source: 'daemon',
          confidence: 'high',
          type: 'user.message',
          payload: { text: 'retry', allowDuplicate: true },
        },
      } as ServerMessage);
    });

    await waitFor(() => {
      expect(screen.getByTestId('probe-dup').textContent).toBe('retry|retry');
    });
  });

  it('keeps timeline history isolated across servers for the same session name', async () => {
    const sessionName = `deck_shared_${Date.now()}`;
    let handlerA: ((msg: ServerMessage) => void) | null = null;
    let handlerB: ((msg: ServerMessage) => void) | null = null;

    const wsA: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handlerA = next;
        return () => { handlerA = null; };
      },
      sendTimelineHistoryRequest: () => 'history-a',
    } as unknown as WsClient;

    const wsB: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handlerB = next;
        return () => { handlerB = null; };
      },
      sendTimelineHistoryRequest: () => 'history-b',
    } as unknown as WsClient;

    function Probe({ name, ws, serverId }: { name: string; ws: WsClient; serverId: string }) {
      const { events } = useTimeline(sessionName, ws, serverId);
      return h('div', { 'data-testid': name }, String(events.length));
    }

    const first = render(h(Probe, { name: 'server-a', ws: wsA, serverId: 'srv-a' }));

    await act(async () => {
      handlerA?.({
        type: 'timeline.history',
        sessionName,
        requestId: 'history-a',
        epoch: 100,
        events: [{
          eventId: `${sessionName}-a1`,
          sessionId: sessionName,
          ts: 1,
          epoch: 100,
          seq: 1,
          source: 'daemon',
          confidence: 'high',
          type: 'assistant.text',
          payload: { text: 'from-a' },
        }],
      } as ServerMessage);
    });

    await waitFor(() => {
      expect(screen.getByTestId('server-a').textContent).toBe('1');
    });

    first.unmount();
    __resetTimelineCacheForTests();

    render(
      h('div', null,
        h(Probe, { name: 'server-b', ws: wsB, serverId: 'srv-b' }),
        h(Probe, { name: 'server-a-remount', ws: wsA, serverId: 'srv-a' }),
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId('server-b').textContent).toBe('0');
      expect(screen.getByTestId('server-a-remount').textContent).toBe('1');
    });
  });

  it('hydrates an empty transport timeline from chat.history before authoritative history arrives', async () => {
    const sessionName = `deck_transport_history_${Date.now()}`;
    let handler: ((msg: ServerMessage) => void) | null = null;

    const ws: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineHistoryRequest: () => 'history-transport',
    } as unknown as WsClient;

    function Probe() {
      const { events, loading } = useTimeline(sessionName, ws, 'srv');
      return h(
        'div',
        {
          'data-testid': 'probe',
          'data-loading': String(loading),
        },
        events.map((event) => `${event.type}:${String(event.payload.text ?? event.payload.output ?? '')}`).join('|'),
      );
    }

    render(h(Probe));

    await act(async () => {
      handler?.({
        type: 'chat.history',
        sessionId: sessionName,
        events: [
          { type: 'user.message', sessionId: sessionName, text: 'hello', _ts: 10 },
          { type: 'assistant.text', sessionId: sessionName, text: 'world', _ts: 11 },
        ],
      } as ServerMessage);
    });

    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-loading')).toBe('false');
      expect(screen.getByTestId('probe').textContent).toBe('user.message:hello|assistant.text:world');
    });
  });

  it('replaces provisional transport history with authoritative timeline.history instead of duplicating it', async () => {
    const sessionName = `deck_transport_history_replace_${Date.now()}`;
    let handler: ((msg: ServerMessage) => void) | null = null;

    const ws: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineHistoryRequest: () => 'history-transport-replace',
    } as unknown as WsClient;

    function Probe() {
      const { events } = useTimeline(sessionName, ws, 'srv');
      return h('div', { 'data-testid': 'probe' }, events.map((event) => String(event.payload.text ?? '')).join('|'));
    }

    render(h(Probe));

    await act(async () => {
      handler?.({
        type: 'chat.history',
        sessionId: sessionName,
        events: [
          { type: 'assistant.text', sessionId: sessionName, text: 'provisional', _ts: 10 },
        ],
      } as ServerMessage);
    });

    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('provisional');
    });

    await act(async () => {
      handler?.({
        type: 'timeline.history',
        sessionName,
        requestId: 'history-transport-replace',
        epoch: 1,
        events: [
          {
            eventId: `${sessionName}-1`,
            sessionId: sessionName,
            ts: 20,
            epoch: 1,
            seq: 1,
            source: 'daemon',
            confidence: 'high',
            type: 'assistant.text',
            payload: { text: 'authoritative', streaming: false },
          },
        ],
      } as ServerMessage);
    });

    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('authoritative');
    });
  });

  it('passes afterTs on browser-reconnect history request so the server gap-fills only missed events', async () => {
    // Regression: when the browser WS reconnected after a mobile background
    // the client fired a blank full-history request, which dumped at most
    // MAX_MEMORY_EVENTS (300) of recent events. Gaps longer than that window
    // silently dropped events. Now we compute the max ts of events already
    // rendered and pass it as afterTs so the server replays only the delta.
    const sessionName = `deck_reconnect_after_ts_${Date.now()}`;
    const serverId = `srv-${Date.now()}`;
    let handler: ((msg: ServerMessage) => void) | null = null;
    const sendTimelineHistoryRequest = vi.fn(() => 'history-reconnect');

    // Seed the shared cache so the hook mounts with known events — the
    // most recent has ts=5000, so reconnect should request from 4999 to keep
    // a 1ms overlap and avoid dropping an event on the boundary.
    ingestTimelineEventForCache({
      eventId: `${sessionName}-ingest-1`,
      sessionId: sessionName,
      ts: 3000,
      epoch: 1,
      seq: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'older' },
    }, serverId);
    ingestTimelineEventForCache({
      eventId: `${sessionName}-ingest-2`,
      sessionId: sessionName,
      ts: 5000,
      epoch: 1,
      seq: 2,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'newest' },
    }, serverId);

    const ws: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineReplayRequest: vi.fn(() => 'replay-after-ts'),
      sendTimelineHistoryRequest,
    } as unknown as WsClient;

    function Probe() {
      useTimeline(sessionName, ws, serverId);
      return h('div', { 'data-testid': 'probe' }, 'mounted');
    }

    render(h(Probe));
    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('mounted');
    });

    // Initial mount already has cached cursor state, so it asks only for the
    // missed tail instead of re-downloading a full recent-history snapshot.
    expect(sendTimelineHistoryRequest).toHaveBeenCalledWith(sessionName, 300, 4999);
    sendTimelineHistoryRequest.mockClear();

    // Simulate browser WS reconnect. useTimeline should now gap-fill using
    // afterTs = max ts of currently-rendered events minus the 1ms overlap.
    await act(async () => {
      handler?.({ type: 'session.event', event: 'connected', session: '', state: 'connected' } as ServerMessage);
    });

    expect(ws.sendTimelineReplayRequest).toHaveBeenCalledWith(sessionName, 2, 1);
    expect(sendTimelineHistoryRequest).toHaveBeenCalledTimes(1);
    expect(sendTimelineHistoryRequest).toHaveBeenCalledWith(sessionName, 300, 4999);
  });
});
