/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import type { ServerMessage, TimelineEvent, WsClient } from '../src/ws-client.js';
import {
  __getTimelineCacheKeysForTests,
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
    cleanup();
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
});
