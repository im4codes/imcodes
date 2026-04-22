/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import type { ServerMessage, TimelineEvent, WsClient } from '../src/ws-client.js';
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

  it('bootstraps from local snapshot, then PG text tail, before later authoritative reconciliation', async () => {
    const sessionName = `deck_text_tail_bootstrap_${Date.now()}`;
    const serverId = `srv-${Date.now()}`;
    let handler: ((msg: ServerMessage) => void) | null = null;

    ingestTimelineEventForCache({
      eventId: `${sessionName}-snap-1`,
      sessionId: sessionName,
      ts: 10,
      epoch: 1,
      seq: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'snapshot history' },
    }, serverId);

    fetchTextTailSpy.mockResolvedValue({
      events: [{
        eventId: `${sessionName}-tail-1`,
        ts: 20,
        type: 'assistant.text',
        text: 'pg tail text',
        source: 'daemon',
        confidence: 'high',
      }],
    });

    const ws: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineHistoryRequest: () => 'history-text-tail',
    } as unknown as WsClient;

    function Probe() {
      const { events } = useTimeline(sessionName, ws, serverId);
      return h('div', { 'data-testid': 'probe' }, events.map((event) => String(event.payload.text ?? '')).join('|'));
    }

    render(h(Probe));

    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('snapshot history');
    });

    await waitFor(() => {
      expect(fetchTextTailSpy).toHaveBeenCalledWith(serverId, sessionName);
      expect(screen.getByTestId('probe').textContent).toBe('snapshot history|pg tail text');
    });

    await act(async () => {
      handler?.({
        type: 'timeline.history',
        sessionName,
        requestId: 'history-text-tail',
        epoch: 2,
        events: [{
          eventId: `${sessionName}-auth-1`,
          sessionId: sessionName,
          ts: 30,
          epoch: 2,
          seq: 3,
          source: 'daemon',
          confidence: 'high',
          type: 'assistant.text',
          payload: { text: 'authoritative text' },
        }],
      } as ServerMessage);
    });

    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('snapshot history|pg tail text|authoritative text');
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
    expect(sendTimelineHistoryRequest).toHaveBeenCalledWith(sessionName, 300);

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

  it('merges PG text tail by eventId without regressing newer local entries', async () => {
    const sessionName = `deck_text_tail_merge_${Date.now()}`;
    const serverId = `srv-${Date.now()}`;

    ingestTimelineEventForCache({
      eventId: `${sessionName}-same`,
      sessionId: sessionName,
      ts: 50,
      epoch: 9,
      seq: 9,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'newer local copy', extra: 'keep-me' },
    }, serverId);

    fetchTextTailSpy.mockResolvedValue({
      events: [{
        eventId: `${sessionName}-same`,
        ts: 50,
        type: 'assistant.text',
        text: 'older tail copy',
        source: 'daemon',
        confidence: 'high',
      }, {
        eventId: `${sessionName}-tail-new`,
        ts: 60,
        type: 'user.message',
        text: 'new tail entry',
      }],
    });

    function Probe() {
      const { events } = useTimeline(sessionName, null, serverId);
      return h(
        'div',
        { 'data-testid': 'probe' },
        events.map((event) => String(event.payload.text ?? '')).join('|'),
      );
    }

    render(h(Probe));

    await waitFor(() => {
      expect(fetchTextTailSpy).toHaveBeenCalledWith(serverId, sessionName);
      expect(screen.getByTestId('probe').textContent).toBe('newer local copy|new tail entry');
    });
  });

  it('fails open when the text-tail endpoint fails and continues with the existing timeline bootstrap', async () => {
    const sessionName = `deck_text_tail_fail_open_${Date.now()}`;
    const serverId = `srv-${Date.now()}`;
    let handler: ((msg: ServerMessage) => void) | null = null;

    fetchTextTailSpy.mockResolvedValue(null);

    const ws: WsClient = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineHistoryRequest: () => 'history-fail-open',
    } as unknown as WsClient;

    function Probe() {
      const { events, loading } = useTimeline(sessionName, ws, serverId);
      return h(
        'div',
        {
          'data-testid': 'probe',
          'data-loading': String(loading),
        },
        events.map((event) => String(event.payload.text ?? '')).join('|'),
      );
    }

    render(h(Probe));

    await waitFor(() => {
      expect(fetchTextTailSpy).toHaveBeenCalledWith(serverId, sessionName);
      expect(screen.getByTestId('probe').getAttribute('data-loading')).toBe('true');
    });

    await act(async () => {
      handler?.({
        type: 'timeline.history',
        sessionName,
        requestId: 'history-fail-open',
        epoch: 1,
        events: [{
          eventId: `${sessionName}-auth`,
          sessionId: sessionName,
          ts: 1,
          epoch: 1,
          seq: 1,
          source: 'daemon',
          confidence: 'high',
          type: 'assistant.text',
          payload: { text: 'authoritative fallback' },
        }],
      } as ServerMessage);
    });

    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('authoritative fallback');
      expect(screen.getByTestId('probe').getAttribute('data-loading')).toBe('false');
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

    // Initial mount triggers a blank full-history request.
    expect(sendTimelineHistoryRequest).toHaveBeenCalledWith(sessionName, 300);
    sendTimelineHistoryRequest.mockClear();

    // Simulate browser WS reconnect. useTimeline should now gap-fill using
    // afterTs = max ts of currently-rendered events minus the 1ms overlap.
    await act(async () => {
      handler?.({ type: 'session.event', event: 'connected', session: '', state: 'connected' } as ServerMessage);
    });

    expect(sendTimelineHistoryRequest).toHaveBeenCalledTimes(1);
    expect(sendTimelineHistoryRequest).toHaveBeenCalledWith(sessionName, 300, 4999);
  });
});
