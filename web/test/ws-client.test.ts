import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WsClient } from '../src/ws-client.js';
import { DAEMON_MSG } from '@shared/daemon-events.js';
import { P2P_WORKFLOW_MSG, isP2pWorkflowRequestId } from '@shared/p2p-workflow-messages.js';
import { TRANSPORT_MSG } from '@shared/transport-events.js';
import { ASK_ANSWER_ACK_CAPABILITY_V1 } from '@shared/ask-answer.js';
import { REPO_MSG } from '@shared/repo-types.js';
import { TIMELINE_MESSAGES, TIMELINE_PROTOCOL_CAPABILITY, TIMELINE_ASSISTANT_TEXT_EVENT_TYPE } from '@shared/timeline-protocol.js';
import { FS_TRANSPORT_MSG } from '@shared/fs-transport-messages.js';
import { FS_GENERIC_ERROR_CODES } from '@shared/fs-error-codes.js';
import { FS_WRITE_MAX_BYTES } from '@shared/fs-write-limits.js';
import type { MessageHandler } from '../src/ws-client.js';

// Mock WebSocket implementation
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  url: string;
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, fn: (ev: unknown) => void) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  }

  send = vi.fn();

  close(code?: number, reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', { code, reason });
  }

  /** Test helper: trigger an event */
  emit(type: string, data?: unknown) {
    if (type === 'open') this.readyState = MockWebSocket.OPEN;
    if (type === 'close') this.readyState = MockWebSocket.CLOSED;
    for (const fn of this.listeners[type] ?? []) fn(data);
  }
}

/** Flush the microtask queue so the async openSocket() completes after the mocked fetch. */
const flushAsync = () => new Promise<void>((r) => setTimeout(r, 0));

let lastWs: MockWebSocket | null;

function setDocumentVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

async function connectClient(): Promise<WsClient> {
  const client = new WsClient('http://localhost:8787', 'srv-1');
  client.connect();
  await flushAsync();
  lastWs!.emit('open');
  return client;
}

describe('WsClient', () => {
  let MockWS: typeof MockWebSocket;

  beforeEach(() => {
    lastWs = null;
    setDocumentVisibility('visible');
    MockWS = class extends MockWebSocket {
      constructor(url: string) {
        super(url);
        lastWs = this;
      }
    };
    vi.stubGlobal('WebSocket', MockWS);

    // openSocket() fetches a ws-ticket before creating the WebSocket.
    // Provide a minimal mock so the fetch resolves immediately.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ticket: 'test-ticket' }),
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllTimers();
  });

  it('can be instantiated with baseUrl and serverId', () => {
    const client = new WsClient('http://localhost:8787', 'srv-1');
    expect(client).toBeInstanceOf(WsClient);
  });

  it('starts disconnected before connect() is called', () => {
    const client = new WsClient('http://localhost:8787', 'srv-1');
    expect(client.connected).toBe(false);
  });

  it('coalesces concurrent session-list requests until the response arrives', async () => {
    const client = new WsClient('http://localhost:8787', 'srv-1');
    client.connect();
    await flushAsync();
    lastWs!.emit('open');
    lastWs!.send.mockClear();

    client.requestSessionList();
    client.requestSessionList();
    expect(lastWs!.send.mock.calls.filter(([raw]) => String(raw).includes('get_sessions'))).toHaveLength(1);

    lastWs!.emit('message', { data: JSON.stringify({ type: 'session_list', sessions: [] }) });
    client.requestSessionList();
    expect(lastWs!.send.mock.calls.filter(([raw]) => String(raw).includes('get_sessions'))).toHaveLength(2);
    client.disconnect();
  });

  it('dedupes identical sub-session rebuild payloads on one socket', async () => {
    const client = await connectClient();
    const payload = [{ id: 'sub-1', type: 'claude-code', runtimeType: 'transport' as const, label: 'worker' }];
    lastWs!.send.mockClear();

    client.subSessionRebuildAll(payload);
    client.subSessionRebuildAll(payload);

    const rebuilds = lastWs!.send.mock.calls
      .map(([raw]) => JSON.parse(String(raw)) as { type?: string });
    expect(rebuilds.filter((message) => message.type === 'subsession.rebuild_all')).toHaveLength(1);
    client.disconnect();
  });

  it('opens a WebSocket on connect()', async () => {
    const client = new WsClient('http://localhost:8787', 'srv-1');
    client.connect();
    await flushAsync();
    expect(lastWs).not.toBeNull();
  });

  it('builds the correct WebSocket URL with ws:// and ticket', async () => {
    const client = new WsClient('http://localhost:8787', 'srv-1');
    client.connect();
    await flushAsync();
    expect(lastWs!.url).toContain('ws://localhost:8787');
    expect(lastWs!.url).toContain('/api/server/srv-1/ws');
    expect(lastWs!.url).toContain('ticket=test-ticket');
  });

  it('sets connected=true after WebSocket open event', async () => {
    const client = new WsClient('http://localhost:8787', 'srv-1');
    client.connect();
    await flushAsync();
    lastWs!.emit('open');
    expect(client.connected).toBe(true);
  });

  it('dispatches terminal.diff messages to registered handlers', async () => {
    const client = new WsClient('http://localhost:8787', 'srv-1');
    const handler = vi.fn<Parameters<MessageHandler>>();
    client.onMessage(handler);
    client.connect();
    await flushAsync();
    lastWs!.emit('open');

    // open dispatches a synthetic session.event — clear it
    handler.mockClear();

    const msg = { type: 'terminal.diff', diff: { sessionName: 's1', timestamp: 1, lines: [], cols: 80, rows: 24 } };
    lastWs!.emit('message', { data: JSON.stringify(msg) });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(msg);
  });

  it('arbitrates timeline subscriptions with full for any active owner', async () => {
    const client = await connectClient();
    lastWs!.send.mockClear();
    const hidden = Symbol('hidden');
    const active = Symbol('active');
    client.subscribeTimelineSession('s1', hidden, 'summary');
    client.subscribeTimelineSession('s1', active, 'full');
    const sent = lastWs!.send.mock.calls.map((call) => JSON.parse(call[0] as string));
    expect(sent.at(-1)).toMatchObject({ type: TIMELINE_MESSAGES.SUBSCRIBE, sessionName: 's1', mode: 'full' });
    client.unsubscribeTimelineSession('s1', active);
    expect(JSON.parse(lastWs!.send.mock.calls.at(-1)![0] as string)).toMatchObject({ type: TIMELINE_MESSAGES.SUBSCRIBE, sessionName: 's1', mode: 'summary' });
  });

  it('keeps an active full subscription across browser visibility changes', async () => {
    const client = await connectClient();
    const owner = Symbol('active');
    client.subscribeTimelineSession('s1', owner, 'full');
    lastWs!.send.mockClear();
    setDocumentVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    setDocumentVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    const timelineFrames = lastWs!.send.mock.calls
      .map((call) => JSON.parse(call[0] as string))
      .filter((message) => message.type === TIMELINE_MESSAGES.SUBSCRIBE);
    expect(timelineFrames.every((message) => message.mode === 'full')).toBe(true);
  });

  it('routes timeline frames to the matching session handler', async () => {
    const client = await connectClient();
    const s1 = vi.fn();
    const s2 = vi.fn();
    client.onSessionMessage('s1', s1);
    client.onSessionMessage('s2', s2);
    const event = { eventId: 'e1', sessionId: 's1', ts: 1, seq: 1, epoch: 1, source: 'daemon', confidence: 'high', type: 'assistant.text', payload: { text: 'final', streaming: false } };
    lastWs!.emit('message', { data: JSON.stringify({ type: TIMELINE_MESSAGES.EVENT, event }) });
    expect(s1).toHaveBeenCalledOnce();
    expect(s2).not.toHaveBeenCalled();
  });

  it('does not dispatch pong messages to handlers', async () => {
    const client = new WsClient('http://localhost:8787', 'srv-1');
    const handler = vi.fn();
    client.onMessage(handler);
    client.connect();
    await flushAsync();
    lastWs!.emit('open');

    // open dispatches a synthetic session.event — clear it
    handler.mockClear();

    lastWs!.emit('message', { data: JSON.stringify({ type: 'pong' }) });

    expect(handler).not.toHaveBeenCalled();
  });

  it('unregisters a handler when the returned cleanup is called', async () => {
    const client = new WsClient('http://localhost:8787', 'srv-1');
    const handler = vi.fn();
    const unsub = client.onMessage(handler);
    unsub();

    client.connect();
    await flushAsync();
    lastWs!.emit('open');
    lastWs!.emit('message', { data: JSON.stringify({ type: 'session.event', event: 'x', session: 's', state: 'idle' }) });

    expect(handler).not.toHaveBeenCalled();
  });

  it('disconnect() sets connected=false and closes the socket', async () => {
    const client = new WsClient('http://localhost:8787', 'srv-1');
    client.connect();
    await flushAsync();
    lastWs!.emit('open');
    expect(client.connected).toBe(true);

    client.disconnect();
    expect(client.connected).toBe(false);
  });

  it('schedules reconnect after WebSocket closes', async () => {
    vi.useFakeTimers();
    const client = new WsClient('http://localhost:8787', 'srv-1');
    client.connect();
    // Flush the fetch promise with fake timers active
    await vi.advanceTimersByTimeAsync(0);
    lastWs!.emit('open');

    const firstWs = lastWs;
    firstWs!.emit('close');

    // After close, reconnectAttempt should increment and a new socket opens after delay
    await vi.advanceTimersByTimeAsync(2000);
    expect(lastWs).not.toBe(firstWs);

    vi.useRealTimers();
  });

  it('keeps connecting=true while the browser WebSocket is still CONNECTING', async () => {
    vi.useFakeTimers();
    const client = new WsClient('http://localhost:8787', 'srv-1');
    client.connect();
    await vi.advanceTimersByTimeAsync(0);

    expect(lastWs).not.toBeNull();
    expect(lastWs!.readyState).toBe(MockWebSocket.CONNECTING);
    expect(client.connected).toBe(false);
    expect(client.connecting).toBe(true);

    lastWs!.emit('open');
    expect(client.connected).toBe(true);
    expect(client.connecting).toBe(false);

    client.disconnect();
    vi.useRealTimers();
  });

  it.each(['probe', 'resume', 'forced-resume'] as const)('preserves a slow ticket across repeated %s nudges', async (nudge) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ ok: true, json: async () => ({ ticket: 'slow-ticket' }) }), 8_000);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new WsClient('http://localhost:8787', 'srv-1');
    try {
      client.connect();
      await vi.advanceTimersByTimeAsync(5_000);
      if (nudge === 'probe') client.probeConnection();
      else client.resumeConnection(nudge === 'forced-resume');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(lastWs?.url).toContain('slow-ticket');
      const opening = lastWs!;
      // A subsequent focus must also leave the in-progress socket alone.
      client.probeConnection();
      client.resumeConnection(true);
      expect(lastWs).toBe(opening);
      expect(opening.readyState).toBe(MockWebSocket.CONNECTING);
      opening.emit('open');
      expect(client.connected).toBe(true);
    } finally {
      client.disconnect();
    }
  });

  it('times out a hung ws-ticket request and retries instead of staying connecting forever', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new WsClient('http://localhost:8787', 'srv-1');
    client.connect();
    expect(client.connecting).toBe(true);

    for (let i = 0; i < 6; i++) {
      client.resumeConnection(true);
      client.probeConnection();
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.connected).toBe(false);
    // The first hung ticket attempt has yielded to a reconnect timer.
    expect(client.connecting).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    client.disconnect();
    vi.useRealTimers();
  });

  it('times out a WebSocket that never opens and schedules a fresh connection', async () => {
    vi.useFakeTimers();
    const client = new WsClient('http://localhost:8787', 'srv-1');
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    const firstWs = lastWs!;

    expect(firstWs.readyState).toBe(MockWebSocket.CONNECTING);
    for (let i = 0; i < 3; i++) {
      client.resumeConnection(true);
      client.probeConnection();
      await vi.advanceTimersByTimeAsync(5_000);
    }

    expect(firstWs.readyState).toBe(MockWebSocket.CLOSED);
    expect(client.connected).toBe(false);
    expect(client.connecting).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(lastWs).not.toBe(firstWs);
    expect(lastWs!.readyState).toBe(MockWebSocket.CONNECTING);

    client.disconnect();
    vi.useRealTimers();
  });

  it('still resumes immediately from retry backoff when no attempt is in flight', async () => {
    vi.useFakeTimers();
    const client = new WsClient('http://localhost:8787', 'srv-1');
    try {
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      const previous = lastWs;
      previous!.emit('close');
      expect(client.connecting).toBe(true);
      expect(client.connectionAttemptInFlight).toBe(false);
      client.resumeConnection(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(lastWs).not.toBe(previous);
      expect(client.connectionAttemptInFlight).toBe(true);
    } finally {
      client.disconnect();
    }
  });

  it('does not stack multiple reconnect timers for the same outage', async () => {
    vi.useFakeTimers();
    const client = new WsClient('http://localhost:8787', 'srv-1');
    const internal = client as unknown as { scheduleReconnect: () => void };

    internal.scheduleReconnect();
    internal.scheduleReconnect();
    internal.scheduleReconnect();

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(lastWs).not.toBeNull();
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    client.disconnect();
    vi.useRealTimers();
  });

  it('jitters the reconnect backoff so weak-network drops do not reconnect in lockstep', async () => {
    vi.useFakeTimers();
    // First attempt: ceiling = min(1000 * 2^0, 30000) = 1000ms. Equal jitter
    // picks a delay in [ceiling/2, ceiling]; Math.random()=0 → the 500ms floor.
    // The un-jittered backoff fired at a fixed 1000ms, so a reconnect that fires
    // at 500ms (and not before) proves the jitter is applied.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const client = new WsClient('http://localhost:8787', 'srv-1');
    const internal = client as unknown as { scheduleReconnect: () => void };
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;

    internal.scheduleReconnect();

    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    randomSpy.mockRestore();
    client.disconnect();
    vi.useRealTimers();
  });

  it('reconnectNow(false) closes a stale CONNECTING socket before opening another one', async () => {
    vi.useFakeTimers();
    const client = new WsClient('http://localhost:8787', 'srv-1');
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    const firstWs = lastWs!;

    expect(firstWs.readyState).toBe(MockWebSocket.CONNECTING);
    client.reconnectNow(false);
    expect(firstWs.readyState).toBe(MockWebSocket.CLOSED);

    await vi.advanceTimersByTimeAsync(0);
    expect(lastWs).not.toBe(firstWs);
    expect(lastWs!.readyState).toBe(MockWebSocket.CONNECTING);

    client.disconnect();
    vi.useRealTimers();
  });

  it('resumeConnection(true) force-reconnects a stale open socket with no confirmed pong', async () => {
    vi.useFakeTimers();
    const client = new WsClient('http://localhost:8787', 'srv-1');
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastWs!.emit('open');
    const firstWs = lastWs!;

    client.resumeConnection(true);
    expect(firstWs.readyState).toBe(MockWebSocket.CLOSED);
    expect(client.connected).toBe(false);

    await vi.advanceTimersByTimeAsync(0);
    expect(lastWs).not.toBe(firstWs);

    client.disconnect();
    vi.useRealTimers();
  });


  it('force reconnect refreshes a stale-open socket and replays subscriptions', async () => {
    vi.useFakeTimers();
    const client = new WsClient('http://localhost:8787', 'srv-1');
    const handler = vi.fn();
    client.onMessage(handler);
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastWs!.emit('open');
    const firstWs = lastWs!;
    handler.mockClear();

    client.subscribeTerminal('chat-session', false);
    client.subscribeTransportSession('transport-session');
    firstWs.send.mockClear();

    client.reconnectNow(true);
    expect(client.connected).toBe(false);
    expect(handler).toHaveBeenCalledWith({
      type: 'session.event',
      event: 'disconnected',
      session: '',
      state: 'disconnected',
      reason: 'socket_closed',
    });
    // Stale-socket window: send() drops the message (no delivery) but must NOT
    // throw — an uncaught throw here crashes the ChatView via the ErrorBoundary.
    expect(() => client.send({ type: 'session.send', sessionName: 's', text: 'lost guard' })).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    const secondWs = lastWs!;
    expect(secondWs).not.toBe(firstWs);
    secondWs.emit('open');
    await vi.advanceTimersByTimeAsync(200);

    expect(secondWs.send).toHaveBeenCalledWith(expect.stringContaining('"type":"terminal.subscribe"'));
    expect(secondWs.send).toHaveBeenCalledWith(expect.stringContaining('"type":"chat.subscribe"'));

    // Late close from the stale socket must not tear down the fresh connection.
    firstWs.emit('close');
    expect(client.connected).toBe(true);

    client.disconnect();
    vi.useRealTimers();
  });

  it('foreground probe blocks direct sends without tearing down live UI subscriptions', async () => {
    vi.useFakeTimers();
    const client = new WsClient('http://localhost:8787', 'srv-1');
    const handler = vi.fn();
    client.onMessage(handler);
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastWs!.emit('open');
    const socket = lastWs!;
    handler.mockClear();
    socket.send.mockClear();

    client.probeConnection();

    expect(client.connected).toBe(true);
    expect(handler).toHaveBeenCalledWith({
      type: 'session.event',
      event: 'probing',
      session: '',
      state: 'probing',
      reason: 'probe_start',
    });
    expect(handler).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'disconnected' }));
    expect(JSON.parse(socket.send.mock.calls[0][0] as string)).toEqual({ type: 'ping', id: expect.any(Number) });
    // Probe state is not a disconnect: regular sends remain available on the
    // open socket and must not be dropped.
    const callsBeforeGuarded = socket.send.mock.calls.length;
    expect(() => client.send({ type: 'session.send', sessionName: 's', text: 'guarded' })).not.toThrow();
    expect(socket.send.mock.calls.length).toBe(callsBeforeGuarded + 1);

    socket.emit('message', { data: JSON.stringify({ type: 'pong' }) });
    expect(client.connected).toBe(true);
    expect(handler).toHaveBeenCalledWith({
      type: 'session.event',
      event: 'connected',
      session: '',
      state: 'connected',
      reason: 'probe_recovered',
    });

    client.disconnect();
    vi.useRealTimers();
  });

  it('never silently drops terminal keystrokes typed during the foreground probe window', async () => {
    // Terminal input is fire-and-forget: sendInput() has no commandId, no ACK
    // and no replay, unlike session.send which the caller can retry. The probe
    // flips _connected=false on every tab resume while readyState is still
    // OPEN, so this window is hit constantly -- and every keystroke typed in it
    // is discarded with no way for the user or the client to know. Keystrokes
    // must survive the window in order, either by going out on the OS-open
    // socket or by being buffered and flushed when the probe resolves.
    vi.useFakeTimers();
    const client = new WsClient('http://localhost:8787', 'srv-1');
    client.onMessage(vi.fn());
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastWs!.emit('open');
    const socket = lastWs!;

    client.probeConnection();
    expect(client.connected).toBe(true);
    expect(socket.readyState).toBe(MockWebSocket.OPEN);
    socket.send.mockClear();

    // The user types while the tab is resuming.
    for (const ch of ['l', 's', '\r']) client.sendInput('deck_demo_brain', ch);

    // Probe resolves; the path was healthy the whole time.
    socket.emit('message', { data: JSON.stringify({ type: 'pong' }) });
    expect(client.connected).toBe(true);
    await vi.advanceTimersByTimeAsync(50);

    const delivered = socket.send.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .filter((m) => m.type === 'session.input')
      .map((m) => m.data);
    expect(delivered.join(''), 'every keystroke must survive the probe window in order').toBe('ls\r');
    vi.useRealTimers();
  });

  it('repairs already-sent transport subscriptions after foreground probe recovery without history replay', async () => {
    vi.useFakeTimers();
    const client = new WsClient('http://localhost:8787', 'srv-1');
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastWs!.emit('open');
    const socket = lastWs!;

    client.subscribeTerminal('live-session', false);
    await vi.advanceTimersByTimeAsync(60);
    client.subscribeTransportSession('live-session');
    socket.send.mockClear();

    client.probeConnection();
    expect(JSON.parse(socket.send.mock.calls[0][0] as string)).toEqual({ type: 'ping', id: expect.any(Number) });
    socket.send.mockClear();

    socket.emit('message', { data: JSON.stringify({ type: 'pong' }) });
    await vi.advanceTimersByTimeAsync(0);

    const messages = socket.send.mock.calls.map((call) => JSON.parse(call[0] as string));
    expect(messages).toContainEqual({ type: 'chat.subscribe', sessionId: 'live-session', forceHistory: false });
    expect(messages).not.toContainEqual({ type: 'terminal.subscribe', session: 'live-session', raw: false });

    client.disconnect();
    vi.useRealTimers();
  });

  it('sends live subscriptions created while foreground probe is pending', async () => {
    vi.useFakeTimers();
    const client = new WsClient('http://localhost:8787', 'srv-1');
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastWs!.emit('open');
    const socket = lastWs!;
    socket.send.mockClear();

    client.probeConnection();
    expect(JSON.parse(socket.send.mock.calls[0][0] as string)).toEqual({ type: 'ping', id: expect.any(Number) });
    socket.send.mockClear();

    client.subscribeTerminal('pending-session', true);
    client.subscribeTransportSession('pending-session');
    expect(socket.send).toHaveBeenCalled();

    socket.emit('message', { data: JSON.stringify({ type: 'pong' }) });
    await vi.advanceTimersByTimeAsync(0);

    const messages = socket.send.mock.calls.map((call) => JSON.parse(call[0] as string));
    expect(messages).toContainEqual({ type: 'chat.subscribe', sessionId: 'pending-session', forceHistory: true });
    expect(messages).toContainEqual({ type: 'terminal.subscribe', session: 'pending-session', raw: true });

    client.disconnect();
    vi.useRealTimers();
  });

  it('sends pending live unsubscriptions after foreground probe recovery', async () => {
    vi.useFakeTimers();
    const client = new WsClient('http://localhost:8787', 'srv-1');
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastWs!.emit('open');
    const socket = lastWs!;

    client.subscribeTerminal('gone-session', false);
    await vi.advanceTimersByTimeAsync(60);
    client.subscribeTransportSession('gone-session');
    socket.send.mockClear();

    client.probeConnection();
    socket.send.mockClear();

    client.unsubscribeTerminal('gone-session');
    client.unsubscribeTransportSession('gone-session');
    expect(socket.send).toHaveBeenCalled();

    socket.emit('message', { data: JSON.stringify({ type: 'pong' }) });
    await vi.advanceTimersByTimeAsync(0);

    const messages = socket.send.mock.calls.map((call) => JSON.parse(call[0] as string));
    expect(messages).toContainEqual({ type: 'chat.unsubscribe', sessionId: 'gone-session' });
    expect(messages).toContainEqual({ type: 'terminal.unsubscribe', session: 'gone-session' });

    client.disconnect();
    vi.useRealTimers();
  });

  it('does not run reconnect history refresh on foreground probe recovery', async () => {
    vi.useFakeTimers();
    const client = new WsClient('http://localhost:8787', 'srv-1');
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastWs!.emit('open');
    const socket = lastWs!;

    client.subscribeTransportSession('history-session');
    client.onMessage((msg) => {
      if (msg.type === 'session.event' && msg.event === 'connected') {
        if (msg.reason === 'probe_recovered') return;
        client.sendTimelineHistoryRequest('history-session', 25);
      }
    });
    socket.send.mockClear();

    client.probeConnection();
    socket.send.mockClear();
    socket.emit('message', { data: JSON.stringify({ type: 'pong' }) });

    const messages = socket.send.mock.calls.map((call) => JSON.parse(call[0] as string));
    expect(messages).toEqual([{ type: 'chat.subscribe', sessionId: 'history-session', forceHistory: false }]);

    client.disconnect();
    vi.useRealTimers();
  });

  it('foreground probe force-reconnects after two missed pongs', async () => {
    vi.useFakeTimers();
    const client = new WsClient('http://localhost:8787', 'srv-1');
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastWs!.emit('open');
    const firstWs = lastWs!;
    firstWs.send.mockClear();

    client.probeConnection();
    // First watchdog window (8s): no pong yet — still on the same socket.
    await vi.advanceTimersByTimeAsync(8_000);
    expect(firstWs.readyState).toBe(MockWebSocket.OPEN);
    expect(lastWs).toBe(firstWs);

    // Second watchdog window also misses → force reconnect.
    await vi.advanceTimersByTimeAsync(8_000);
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);

    expect(firstWs.readyState).toBe(MockWebSocket.CLOSED);
    expect(lastWs).not.toBe(firstWs);

    client.disconnect();
    vi.useRealTimers();
  });

  it('probeConnection short-circuits when a recent pong already proved liveness', async () => {
    vi.useFakeTimers();
    const client = new WsClient('http://localhost:8787', 'srv-1');
    const handler = vi.fn();
    client.onMessage(handler);
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastWs!.emit('open');
    const socket = lastWs!;

    // Heartbeat pong arrives — socket is provably alive.
    socket.emit('message', { data: JSON.stringify({ type: 'pong' }) });
    handler.mockClear();
    socket.send.mockClear();

    // A foreground probe immediately after should be a no-op:
    //   - no extra ping is sent
    //   - the socket is NOT marked disconnected (no UI flash)
    client.probeConnection();
    expect(client.connected).toBe(true);
    expect(socket.send).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'disconnected' }));

    client.disconnect();
    vi.useRealTimers();
  });

  it('probeConnection coalesces back-to-back calls into a single in-flight probe', async () => {
    vi.useFakeTimers();
    const client = new WsClient('http://localhost:8787', 'srv-1');
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastWs!.emit('open');
    const socket = lastWs!;
    socket.send.mockClear();

    // First probe: sends one ping.
    client.probeConnection();
    const pingsAfterFirst = socket.send.mock.calls.filter(
      (c) => JSON.parse(c[0] as string).type === 'ping',
    ).length;
    expect(pingsAfterFirst).toBe(1);

    // Stacking more probes from focus/pageshow/visibilitychange must not pile
    // up extra pings while the first probe's watchdog is still armed.
    client.probeConnection();
    client.probeConnection();
    const pingsAfterStacked = socket.send.mock.calls.filter(
      (c) => JSON.parse(c[0] as string).type === 'ping',
    ).length;
    expect(pingsAfterStacked).toBe(1);

    client.disconnect();
    vi.useRealTimers();
  });


  it('recovers a foreground probe when any current-socket message arrives', async () => {
    vi.useFakeTimers();
    const client = new WsClient('http://localhost:8787', 'srv-1');
    const handler = vi.fn();
    client.onMessage(handler);
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastWs!.emit('open');
    const socket = lastWs!;
    socket.send.mockClear();
    handler.mockClear();

    client.probeConnection();
    expect(client.connected).toBe(true);

    socket.emit('message', { data: JSON.stringify({ type: 'session_list', sessions: [] }) });

    expect(client.connected).toBe(true);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session.event',
      event: 'connected',
      reason: 'probe_recovered',
    }));

    socket.send.mockClear();
    client.requestSessionList();
    expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('get_sessions'));

    client.disconnect();
    vi.useRealTimers();
  });

  it('emits one recovery notice per probe, even when timeline frames keep arriving', async () => {
    vi.useFakeTimers();
    const client = new WsClient('http://localhost:8787', 'srv-1');
    const handler = vi.fn();
    client.onMessage(handler);
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastWs!.emit('open');
    const socket = lastWs!;
    handler.mockClear();

    client.probeConnection();
    socket.emit('message', { data: JSON.stringify({ type: 'session_list', sessions: [] }) });
    expect(handler.mock.calls.filter(([msg]) => msg?.reason === 'probe_recovered')).toHaveLength(1);

    // A second probe can be triggered while the first recovered socket is
    // still busy. Its first timeline frame restores the connected bit, but
    // must not fan out another expensive app-level resync immediately.
    client.probeConnection();
    socket.emit('message', { data: JSON.stringify({ type: 'timeline.event', event: { sessionId: 's1', eventId: 'e1', seq: 1, epoch: 1, type: 'assistant.text', payload: { text: 'x' } } }) });
    expect(handler.mock.calls.filter(([msg]) => msg?.reason === 'probe_recovered')).toHaveLength(2);

    client.disconnect();
    vi.useRealTimers();
  });

  it('emits exactly one recovery notice across a 1000-frame probe burst', async () => {
    vi.useFakeTimers();
    const client = new WsClient('http://localhost:8787', 'srv-1');
    const handler = vi.fn();
    client.onMessage(handler);
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastWs!.emit('open');
    const socket = lastWs!;
    handler.mockClear();

    client.probeConnection();
    for (let i = 0; i < 1_000; i++) {
      socket.emit('message', { data: JSON.stringify({
        type: 'timeline.event',
        event: { sessionId: 's1', eventId: `e${i}`, seq: i + 1, epoch: 1, type: 'assistant.text', payload: { text: 'x' } },
      }) });
    }

    expect(client.connected).toBe(true);
    expect(handler.mock.calls.filter(([msg]) => msg?.reason === 'probe_recovered')).toHaveLength(1);
    // Keep one event synchronous, then yield the backlog in bounded timer
    // batches so mounted timelines can render between batches.
    expect(handler.mock.calls.filter(([msg]) => msg?.type === 'timeline.event')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(handler.mock.calls.filter(([msg]) => msg?.type === 'timeline.event')).toHaveLength(1_000);
    client.disconnect();
    vi.useRealTimers();
  });

  it('coalesces queued transient status frames per session while preserving durable events', async () => {
    vi.useFakeTimers();
    const client = new WsClient('http://localhost:8787', 'srv-1');
    const handler = vi.fn();
    client.onMessage(handler);
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastWs!.emit('open');
    const socket = lastWs!;
    handler.mockClear();

    for (let i = 0; i < 1_000; i++) {
      socket.emit('message', { data: JSON.stringify({
        type: 'timeline.event',
        event: {
          sessionId: 's1', eventId: `state-${i}`, seq: i + 1, epoch: 1,
          type: 'session.state', summary: true, payload: { state: 'running' },
        },
      }) });
    }

    // One event is allowed through for first paint. The queued intermediate
    // states collapse to the latest state for this session/type.
    expect(handler.mock.calls.filter(([msg]) => msg?.type === 'timeline.event')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(handler.mock.calls.filter(([msg]) => msg?.type === 'timeline.event')).toHaveLength(2);
    const delivered = handler.mock.calls
      .map(([msg]) => msg)
      .filter((msg) => msg?.type === 'timeline.event')
      .at(-1);
    expect(delivered?.event?.eventId).toBe('state-999');

    client.disconnect();
    vi.useRealTimers();
  });

  it('never coalesces visible session.state stopping (user_cancel) when followed immediately by idle or running in summary mode', async () => {
    vi.useFakeTimers();
    const client = new WsClient('http://localhost:8787', 'srv-1');
    const delivered: Array<{ eventId: string; payload: Record<string, unknown> }> = [];
    client.onMessage((msg) => {
      if (msg.type === 'timeline.event') {
        delivered.push({ eventId: msg.event.eventId, payload: msg.event.payload });
      }
    });
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastWs!.emit('open');
    const socket = lastWs!;
    delivered.length = 0;

    // First paint event passes synchronously.
    socket.emit('message', { data: JSON.stringify({
      type: 'timeline.event',
      event: { sessionId: 's1', eventId: 'run-0', seq: 1, epoch: 1, type: 'session.state', summary: true, payload: { state: 'running' } },
    }) });
    // Now queue pending coalescible running -> visible stopping -> idle -> subsequent running.
    socket.emit('message', { data: JSON.stringify({
      type: 'timeline.event',
      event: { sessionId: 's1', eventId: 'run-1', seq: 2, epoch: 1, type: 'session.state', summary: true, payload: { state: 'running' } },
    }) });
    socket.emit('message', { data: JSON.stringify({
      type: 'timeline.event',
      event: { sessionId: 's1', eventId: 'stop-1', seq: 3, epoch: 1, type: 'session.state', summary: true, payload: { state: 'stopping', reason: 'user_cancel' } },
    }) });
    socket.emit('message', { data: JSON.stringify({
      type: 'timeline.event',
      event: { sessionId: 's1', eventId: 'idle-1', seq: 4, epoch: 1, type: 'session.state', summary: true, payload: { state: 'idle' } },
    }) });
    socket.emit('message', { data: JSON.stringify({
      type: 'timeline.event',
      event: { sessionId: 's1', eventId: 'run-2', seq: 5, epoch: 1, type: 'session.state', summary: true, payload: { state: 'running' } },
    }) });

    await vi.advanceTimersByTimeAsync(1);
    expect(delivered.map((d) => d.eventId)).toEqual(['run-0', 'run-1', 'stop-1', 'idle-1', 'run-2']);
    expect(delivered.find((d) => d.eventId === 'stop-1')?.payload).toEqual({ state: 'stopping', reason: 'user_cancel' });

    client.disconnect();
    vi.useRealTimers();
  });

  describe('queued cumulative stream snapshots', () => {
    async function start() {
      vi.useFakeTimers();
      const client = new WsClient('http://localhost:8787', 'srv-1');
      const delivered: Array<Record<string, any>> = [];
      client.onMessage(msg => { if (msg.type === TIMELINE_MESSAGES.EVENT) delivered.push(msg.event); });
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      const socket = lastWs!;
      socket.emit('open');
      const send = (seq: number, changes: Record<string, unknown> = {}) => {
        socket.emit('message', { data: JSON.stringify({ type: TIMELINE_MESSAGES.EVENT, event: {
          sessionId: 's1', eventId: 'stream', epoch: 1, seq,
          type: TIMELINE_ASSISTANT_TEXT_EVENT_TYPE,
          payload: { text: `snapshot-${seq}`, streaming: true }, ...changes,
        } }) });
      };
      return { client, delivered, send };
    }

    it('retains one undelivered snapshot, without mutating a previously delivered one', async () => {
      const { client, delivered, send } = await start();
      try {
        for (let i = 0; i < 1_500; i++) send(i);
        expect((client as unknown as { pendingTimelineEvents: unknown[] }).pendingTimelineEvents).toHaveLength(1);
        expect(delivered).toHaveLength(1);
        expect(delivered[0].payload.text).toBe('snapshot-0');
        await vi.advanceTimersByTimeAsync(10);
        expect(delivered.map(event => event.payload.text)).toEqual(['snapshot-0', 'snapshot-1499']);
        send(1500);
        await vi.advanceTimersByTimeAsync(10);
        expect(delivered.map(event => event.payload.text)).toEqual(['snapshot-0', 'snapshot-1499', 'snapshot-1500']);
      } finally { client.disconnect(); }
    });

    it('coalesces interleaved sessions independently, including identical message IDs', async () => {
      const { client, delivered, send } = await start();
      try {
        send(0, { type: 'user.message', payload: { text: 'bootstrap' } });
        send(1); send(1, { sessionId: 's2' }); send(2); send(2, { sessionId: 's2' });
        await vi.advanceTimersByTimeAsync(10);
        expect(delivered.slice(1).map(event => [event.sessionId, event.seq])).toEqual([['s1', 2], ['s2', 2]]);
      } finally { client.disconnect(); }
    });

    it('keeps every snapshot live when the consumer is keeping up', async () => {
      const { client, delivered, send } = await start();
      try {
        for (let i = 0; i < 10; i++) {
          send(i);
          await vi.advanceTimersByTimeAsync(10);
        }
        expect(delivered.map(event => event.seq)).toEqual(Array.from({ length: 10 }, (_, i) => i));
      } finally { client.disconnect(); }
    });

    it.each(['tool.call', 'tool.result', 'user.message', 'session.state'])('preserves the %s barrier and final text/metadata', async (type) => {
      const { client, delivered, send } = await start();
      try {
        send(0, { type: 'user.message', payload: { text: 'bootstrap' } });
        send(1); send(2);
        send(3, { type, eventId: 'boundary', payload: { state: 'idle', text: 'durable' } });
        send(4); send(5);
        send(6, { payload: { text: 'FINAL', streaming: false, retainedMetadata: 'yes' } });
        await vi.advanceTimersByTimeAsync(20);
        expect(delivered.map(event => event.seq)).toEqual([0, 2, 3, 5, 6]);
        expect(delivered.at(-1)?.payload).toEqual({ text: 'FINAL', streaming: false, retainedMetadata: 'yes' });
      } finally { client.disconnect(); }
    });

    it('does not merge epochs, distinct messages or backwards sequence revisions', async () => {
      const { client, delivered, send } = await start();
      try {
        send(0, { type: 'user.message', payload: { text: 'bootstrap' } });
        send(10); send(11, { epoch: 2 }); send(12, { eventId: 'other' });
        send(12, { eventId: 'other', ts: 1 }); send(9, { eventId: 'other' });
        await vi.advanceTimersByTimeAsync(20);
        expect(delivered.map(event => event.seq)).toEqual([0, 10, 11, 12, 12, 9]);
      } finally { client.disconnect(); }
    });

    it.each([{ eventId: '' }, { sessionId: '' }, { epoch: undefined }, { seq: undefined }, { payload: { streaming: true, delta: 'not a complete text snapshot' } }, { completeness: 'preview' }, { payload: { streaming: true, text: 'partial', payloadTruncated: true } }, { summary: true }, { hidden: true }])('keeps legacy or non-snapshot data unmodified: %j', async (changes) => {
      const { client, delivered, send } = await start();
      try {
        send(0, { type: 'user.message', payload: { text: 'bootstrap' } });
        send(1, changes); send(2, changes);
        await vi.advanceTimersByTimeAsync(10);
        expect(delivered).toHaveLength(3);
      } finally { client.disconnect(); }
    });

    it('drops both the queue and its stream references on disconnect', async () => {
      const { client, delivered, send } = await start();
      send(0); send(1);
      client.disconnect();
      await vi.advanceTimersByTimeAsync(10);
      expect(delivered).toHaveLength(1);
      expect((client as unknown as { pendingTimelineStreams: Map<string, unknown> }).pendingTimelineStreams.size).toBe(0);
    });
  });

  it('keeps full-mode transient status frames live', async () => {
    vi.useFakeTimers();
    const client = new WsClient('http://localhost:8787', 'srv-1');
    const handler = vi.fn();
    client.onMessage(handler);
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastWs!.emit('open');
    const socket = lastWs!;
    handler.mockClear();

    for (let i = 0; i < 100; i++) {
      socket.emit('message', { data: JSON.stringify({
        type: 'timeline.event',
        event: {
          sessionId: 's1', eventId: `full-state-${i}`, seq: i + 1, epoch: 1,
          type: 'session.state', payload: { state: 'running' },
        },
      }) });
    }

    await vi.advanceTimersByTimeAsync(100);
    const delivered = handler.mock.calls
      .map(([msg]) => msg)
      .filter((msg) => msg?.type === 'timeline.event');
    expect(delivered).toHaveLength(100);
    expect(delivered.at(-1)?.event?.eventId).toBe('full-state-99');

    client.disconnect();
    vi.useRealTimers();
  });

  it('delivers every terminal idle transition instead of coalescing it away', async () => {
    vi.useFakeTimers();
    const client = new WsClient('http://localhost:8787', 'srv-1');
    const handler = vi.fn();
    client.onMessage(handler);
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastWs!.emit('open');
    const socket = lastWs!;
    handler.mockClear();

    for (let i = 0; i < 50; i += 1) {
      socket.emit('message', { data: JSON.stringify({
        type: 'timeline.event',
        event: {
          sessionId: 's1', eventId: `idle-${i}`, seq: i + 1, epoch: 1,
          type: 'session.state', payload: { state: 'idle' },
        },
      }) });
    }

    await vi.advanceTimersByTimeAsync(100);
    const delivered = handler.mock.calls
      .map(([msg]) => msg)
      .filter((msg) => msg?.type === 'timeline.event');
    expect(delivered).toHaveLength(50);
    expect(delivered.every((msg) => msg.event?.payload?.state === 'idle')).toBe(true);

    client.disconnect();
    vi.useRealTimers();
  });

  it('send() is a safe no-op when not connected (does not throw)', () => {
    // Fire-and-forget transport must never throw to React effects/listeners —
    // an uncaught throw crashes the ChatView via the ErrorBoundary.
    const client = new WsClient('http://localhost:8787', 'srv-1');
    expect(() => client.send({ type: 'ping' })).not.toThrow();
  });

  it('skips Claude weekly quota opt-in without throwing while disconnected', () => {
    const client = new WsClient('http://localhost:8787', 'srv-1');
    expect(() => client.setClaudeWeeklyQuotaOptIn(true)).not.toThrow();
  });

  describe('dead-socket detection (pong timeout)', () => {
    it('force-reconnects a new socket after two missed heartbeat pongs', async () => {
      // Regression: mobile OS commonly half-closes the TCP on background
      // eviction without propagating close() to the WebView — the old client
      // believed it was "connected" indefinitely while no events arrived.
      // Now we ping every HEARTBEAT_MS (10s) and force-reconnect if two
      // consecutive 8s watchdog windows miss their pongs.
      vi.useFakeTimers();
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      const firstWs = lastWs!;

      // Initial ping fires after the post-open settle window so it doesn't queue behind subscriptions.
      await vi.advanceTimersByTimeAsync(1_500);
      const initialPings = firstWs.send.mock.calls.filter(
        (c) => JSON.parse(c[0] as string).type === 'ping',
      );
      expect(initialPings.length).toBeGreaterThanOrEqual(1);

      // Walk past the first 8s watchdog without ever sending a pong.
      await vi.advanceTimersByTimeAsync(8_000);
      expect(firstWs.readyState).toBe(MockWebSocket.OPEN);
      expect(lastWs).toBe(firstWs);

      // The confirming ping also missed; now the client reconnects.
      await vi.advanceTimersByTimeAsync(8_000);
      // reconnectNow(true) fires synchronously, but openSocket() awaits a
      // ticket fetch Promise — flush several microtask turns so the new
      // MockWebSocket is constructed before we assert.
      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
      expect(firstWs.readyState).toBe(MockWebSocket.CLOSED);
      expect(lastWs).not.toBe(firstWs);

      client.disconnect();
      vi.useRealTimers();
    });

    it('does NOT reconnect while pongs keep arriving', async () => {
      vi.useFakeTimers();
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      const firstWs = lastWs!;

      // Simulate a healthy server that pongs immediately after each ping.
      for (let i = 0; i < 5; i++) {
        firstWs.emit('message', { data: JSON.stringify({ type: 'pong' }) });
        await vi.advanceTimersByTimeAsync(10_000); // one heartbeat interval
        firstWs.emit('message', { data: JSON.stringify({ type: 'pong' }) });
      }

      // Still on the same socket — the watchdog was cleared by each pong.
      expect(lastWs).toBe(firstWs);

      client.disconnect();
      vi.useRealTimers();
    });

    it('does not force-reconnect from the heartbeat watchdog while the tab is hidden', async () => {
      vi.useFakeTimers();
      let visibilityState: DocumentVisibilityState = 'visible';
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => visibilityState,
      });
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      const firstWs = lastWs!;

      visibilityState = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));

      await vi.advanceTimersByTimeAsync(32_000);
      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);

      expect(lastWs).toBe(firstWs);
      expect(firstWs.readyState).toBe(MockWebSocket.OPEN);

      client.disconnect();
      vi.useRealTimers();
    });
  });

  describe('terminal subscription modes', () => {
    it('subscribeTerminal sends an explicit raw flag', async () => {
      vi.useFakeTimers();
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      lastWs!.send.mockClear();

      client.subscribeTerminal('chat-session', false);
      client.subscribeTerminal('terminal-session', true);

      expect(lastWs!.send).toHaveBeenCalledTimes(1);
      expect(JSON.parse(lastWs!.send.mock.calls[0][0] as string)).toEqual({
        type: 'terminal.subscribe',
        session: 'terminal-session',
        raw: true,
      });
      await vi.advanceTimersByTimeAsync(200);

      expect(lastWs!.send).toHaveBeenCalledTimes(2);
      expect(JSON.parse(lastWs!.send.mock.calls[1][0] as string)).toEqual({
        type: 'terminal.subscribe',
        session: 'chat-session',
        raw: false,
      });
      client.disconnect();
      vi.useRealTimers();
    });

    it('keeps raw mode while a raw hold is active despite passive resubscribe', async () => {
      vi.useFakeTimers();
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      lastWs!.send.mockClear();

      client.subscribeTerminal('shell-card', false);
      await vi.advanceTimersByTimeAsync(80);
      expect(JSON.parse(lastWs!.send.mock.calls.at(-1)?.[0] as string)).toEqual({
        type: 'terminal.subscribe',
        session: 'shell-card',
        raw: false,
      });

      const release = client.holdTerminalRaw('shell-card');
      await vi.advanceTimersByTimeAsync(80);
      expect(JSON.parse(lastWs!.send.mock.calls.at(-1)?.[0] as string)).toEqual({
        type: 'terminal.subscribe',
        session: 'shell-card',
        raw: true,
      });

      const callsBeforePassiveResubscribe = lastWs!.send.mock.calls.length;
      client.subscribeTerminal('shell-card', false);
      await vi.advanceTimersByTimeAsync(80);
      expect(lastWs!.send).toHaveBeenCalledTimes(callsBeforePassiveResubscribe);

      release();
      await vi.advanceTimersByTimeAsync(80);
      expect(JSON.parse(lastWs!.send.mock.calls.at(-1)?.[0] as string)).toEqual({
        type: 'terminal.subscribe',
        session: 'shell-card',
        raw: false,
      });

      client.disconnect();
      vi.useRealTimers();
    });

    it('debounces rapid passive terminal subscribe/unsubscribe churn to the final state', async () => {
      vi.useFakeTimers();
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      lastWs!.send.mockClear();

      client.subscribeTerminal('storm-session', false);
      client.unsubscribeTerminal('storm-session');
      client.subscribeTerminal('storm-session', false);
      client.unsubscribeTerminal('empty-session');

      expect(lastWs!.send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(120);

      const messages = lastWs!.send.mock.calls.map((call) => JSON.parse(call[0] as string));
      expect(messages).toEqual([
        { type: 'terminal.subscribe', session: 'storm-session', raw: false },
      ]);

      lastWs!.send.mockClear();
      client.unsubscribeTerminal('storm-session');
      client.subscribeTerminal('storm-session', false);
      await vi.advanceTimersByTimeAsync(120);

      expect(lastWs!.send).not.toHaveBeenCalled();

      client.disconnect();
      vi.useRealTimers();
    });

    it('sends raw terminal subscriptions immediately even behind a passive backlog', async () => {
      vi.useFakeTimers();
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      lastWs!.send.mockClear();

      for (let i = 0; i < 25; i++) {
        client.subscribeTerminal(`passive-${i}`, false);
      }
      expect(lastWs!.send).not.toHaveBeenCalled();

      client.subscribeTerminal('deck_sub_shell', true);

      expect(lastWs!.send).toHaveBeenCalledTimes(1);
      expect(JSON.parse(lastWs!.send.mock.calls[0][0] as string)).toEqual({
        type: 'terminal.subscribe',
        session: 'deck_sub_shell',
        raw: true,
      });

      client.disconnect();
      vi.useRealTimers();
    });

    it('replays remembered terminal subscriptions after reconnect', async () => {
      vi.useFakeTimers();
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      const firstWs = lastWs!;

      client.subscribeTerminal('chat-session', false);
      client.subscribeTerminal('terminal-session', true);
      firstWs.send.mockClear();

      firstWs.emit('close');
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(0);

      const secondWs = lastWs!;
      expect(secondWs).not.toBe(firstWs);

      secondWs.emit('open');

      await vi.advanceTimersByTimeAsync(200);

      expect(secondWs.send).toHaveBeenCalledTimes(2);
      expect(JSON.parse(secondWs.send.mock.calls[0][0] as string)).toEqual({
        type: 'terminal.subscribe',
        session: 'chat-session',
        raw: false,
      });
      expect(JSON.parse(secondWs.send.mock.calls[1][0] as string)).toEqual({
        type: 'terminal.subscribe',
        session: 'terminal-session',
        raw: true,
      });

      client.disconnect();
      vi.useRealTimers();
    });

    it('recovers from terminal.stream_reset by requesting a fresh snapshot (no resubscribe needed)', async () => {
      // The server keeps the subscription alive across an overflow stream_reset
      // (it just clears its per-(session, ws) queue and notifies the client).
      // So the client only needs to request a snapshot — re-subscribing was
      // the OLD design and could leave the terminal frozen during the
      // exponential backoff. New contract: a single snapshot request, no
      // backoff, no resubscribe, never frozen.
      const client = await connectClient();
      vi.useFakeTimers();
      lastWs!.send.mockClear();

      try {
        lastWs!.emit('message', {
          data: JSON.stringify({
            type: 'terminal.stream_reset',
            session: 'stream-session',
            reason: 'reset',
          }),
        });

        // Snapshot fires synchronously on receipt; advance timers a generous
        // amount and verify no resubscribe ever follows.
        await vi.advanceTimersByTimeAsync(20_000);
        const sendCalls = lastWs!.send.mock.calls.map((c: [string]) => {
          try { return JSON.parse(c[0] as string) as Record<string, unknown>; } catch { return {}; }
        });
        expect(sendCalls.some((m) => m.type === 'terminal.snapshot_request' && m.sessionName === 'stream-session')).toBe(true);
        expect(sendCalls.some((m) => m.type === 'terminal.subscribe')).toBe(false);
      } finally {
        client.disconnect();
        vi.useRealTimers();
      }
    });

    it('on terminal.stream_reset: synchronously requests a snapshot for fast recovery', async () => {
      // Regression: server-side overflow no longer unsubscribes, so the
      // client only needs a fresh snapshot to recover the dropped frames.
      // The snapshot request must fire IMMEDIATELY (synchronously) on
      // receipt of stream_reset — without it, the user stares at frozen
      // terminal content for the duration of the resubscribe backoff
      // (1s minimum) even though the subscription is healthy.
      const client = await connectClient();
      vi.useFakeTimers();
      lastWs!.send.mockClear();

      try {
        lastWs!.emit('message', {
          data: JSON.stringify({
            type: 'terminal.stream_reset',
            session: 'snap-session',
            reason: 'backpressure',
          }),
        });

        // Snapshot request must have fired synchronously (no timers needed).
        const sendCalls = lastWs!.send.mock.calls.map((c: [string]) => {
          try { return JSON.parse(c[0] as string) as Record<string, unknown>; } catch { return {}; }
        });
        const snapshotRequests = sendCalls.filter((m) => m.type === 'terminal.snapshot_request');
        expect(snapshotRequests).toHaveLength(1);
        expect(snapshotRequests[0]).toEqual({
          type: 'terminal.snapshot_request',
          sessionName: 'snap-session',
        });
      } finally {
        client.disconnect();
        vi.useRealTimers();
      }
    });

    it('rate-limits snapshot requests during a reset burst (one snapshot per 500ms window)', async () => {
      // A burst of stream_reset events (e.g. heavy output overflowing the
      // server queue several times in a single tick) must NOT result in a
      // snapshot request per reset — that would hammer the server. Instead
      // the client collapses bursts into one snapshot per 500ms window. A
      // pending snapshot is scheduled at the end of the window so the
      // terminal is GUARANTEED to recover even after the burst settles.
      const client = await connectClient();
      vi.useFakeTimers();
      try {
        // 8 resets in the same tick → exactly ONE synchronous snapshot, the
        // remaining 7 collapse into a single deferred snapshot at end of
        // window.
        for (let i = 0; i < 8; i++) {
          lastWs!.emit('message', {
            data: JSON.stringify({
              type: 'terminal.stream_reset',
              session: 'burst-session',
              reason: 'backpressure',
            }),
          });
        }
        let sendCalls = lastWs!.send.mock.calls.map((c: [string]) => {
          try { return JSON.parse(c[0] as string) as Record<string, unknown>; } catch { return {}; }
        });
        let snapshots = sendCalls.filter((m) => m.type === 'terminal.snapshot_request');
        expect(snapshots).toHaveLength(1);

        // Advance past the rate-limit window — the deferred snapshot fires
        // exactly once and the terminal is recovered.
        await vi.advanceTimersByTimeAsync(600);
        sendCalls = lastWs!.send.mock.calls.map((c: [string]) => {
          try { return JSON.parse(c[0] as string) as Record<string, unknown>; } catch { return {}; }
        });
        snapshots = sendCalls.filter((m) => m.type === 'terminal.snapshot_request');
        expect(snapshots).toHaveLength(2);
      } finally {
        client.disconnect();
        vi.useRealTimers();
      }
    });
  });

  describe('transport chat subscriptions', () => {
    it('subscribeTransportSession sends chat.subscribe and replays on reconnect', async () => {
      vi.useFakeTimers();
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      const firstWs = lastWs!;

      client.subscribeTransportSession('transport-session');
      expect(JSON.parse(firstWs.send.mock.calls.at(-1)[0] as string)).toEqual({
        type: 'chat.subscribe',
        sessionId: 'transport-session',
        forceHistory: true,
      });

      firstWs.send.mockClear();
      firstWs.emit('close');
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(0);
      const secondWs = lastWs!;
      secondWs.emit('open');

      // The LIVE subscription is restored synchronously so no realtime event is
      // dropped while reconnecting...
      expect(secondWs.send).toHaveBeenCalledWith(expect.stringContaining('"forceHistory":false'));
      // ...and the expensive history replay follows on a staggered timer, so a
      // reconnect with many open sessions cannot fire them all at once.
      await vi.advanceTimersByTimeAsync(500);
      expect(secondWs.send).toHaveBeenCalledWith(expect.stringContaining('"forceHistory":true'));
      client.disconnect();
      vi.useRealTimers();
    });

    it('governs snapshot requests across sessions instead of emitting one per terminal', async () => {
      vi.useFakeTimers();
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      const ws = lastWs!;
      ws.send.mockClear();

      const snapshots = () => ws.send.mock.calls
        .map((c) => String(c[0]))
        .filter((raw) => raw.includes('"terminal.snapshot_request"'));

      // A reconnect re-runs the snapshot effect in TerminalView, SessionPane and
      // SubSessionWindow. SessionPane/SubSessionWindow each render a
      // TerminalView, so the same session asks twice — times every session.
      const sessions = ['s1', 's2', 's3', 's4', 's5'];
      for (const name of sessions) {
        client.sendSnapshotRequest(name);
        client.sendSnapshotRequest(name);  // the nested TerminalView
      }

      // Ungoverned this was 10 requests in one tick. The global cursor lets one
      // through and defers the rest.
      expect(snapshots().length).toBeLessThanOrEqual(1);

      await vi.advanceTimersByTimeAsync(2_000);
      const targets = snapshots().map((raw) => JSON.parse(raw).sessionName as string);
      // Every session still recovers exactly once — governance must never starve
      // or permanently freeze a terminal.
      expect(new Set(targets)).toEqual(new Set(sessions));
      // 10 ungoverned calls collapse to at most one per session plus a single
      // deferred follow-up for the session that was already in flight — and
      // every one of them is spread out by the global cursor rather than
      // emitted in the same tick.
      expect(targets.length).toBeLessThanOrEqual(sessions.length + 1);

      client.disconnect();
      vi.useRealTimers();
    });

    it('does not re-send an unchanged terminal size', async () => {
      vi.useFakeTimers();
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      const ws = lastWs!;
      ws.send.mockClear();

      const resizes = () => ws.send.mock.calls
        .map((c) => String(c[0]))
        .filter((raw) => raw.includes('"session.resize"'));

      client.sendResize('s1', 120, 40);
      client.sendResize('s1', 120, 40);
      client.sendResize('s1', 120, 40);
      // tmux has one size per session; a redundant resize reflows the whole pane
      // and streams that reflow to every subscriber.
      expect(resizes()).toHaveLength(1);

      client.sendResize('s1', 121, 40);
      expect(resizes()).toHaveLength(2);

      client.disconnect();
      vi.useRealTimers();
    });

    it('staggers transport history replay instead of asking for every session at once', async () => {
      vi.useFakeTimers();
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      const firstWs = lastWs!;

      const sessions = ['s1', 's2', 's3', 's4', 's5'];
      for (const id of sessions) client.subscribeTransportSession(id);

      // Socket dies the way it does after a long lock, and everything reconnects.
      firstWs.send.mockClear();
      firstWs.emit('close');
      await vi.advanceTimersByTimeAsync(5000);
      const secondWs = lastWs!;
      expect(secondWs).not.toBe(firstWs);
      secondWs.emit('open');

      const subscribesWithHistory = () => secondWs.send.mock.calls
        .map((c) => String(c[0]))
        .filter((raw) => raw.includes(`"type":"${TRANSPORT_MSG.CHAT_SUBSCRIBE}"`) && raw.includes('"forceHistory":true'));
      const subscribesLiveOnly = () => secondWs.send.mock.calls
        .map((c) => String(c[0]))
        .filter((raw) => raw.includes(`"type":"${TRANSPORT_MSG.CHAT_SUBSCRIBE}"`) && raw.includes('"forceHistory":false'));

      // Every session gets its LIVE subscription back immediately — nothing may
      // sit unsubscribed while the histories trickle in, or the server silently
      // drops its realtime events.
      expect(subscribesLiveOnly()).toHaveLength(sessions.length);
      // ...but at most one history replay has been asked for so far. Before this
      // fix all five went out in the same synchronous loop.
      expect(subscribesWithHistory().length).toBeLessThanOrEqual(1);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(subscribesWithHistory()).toHaveLength(sessions.length);

      client.disconnect();
      vi.useRealTimers();
    });

    it('drops a queued history replay when the session is unsubscribed during the stagger window', async () => {
      vi.useFakeTimers();
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.onMessage(vi.fn());
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');

      for (const id of ['keep-1', 'keep-2', 'closed-3']) client.subscribeTransportSession(id);

      lastWs!.emit('close');
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(0);
      const secondWs = lastWs!;
      secondWs.send.mockClear();
      secondWs.emit('open');

      // User closes that window while its history request is still queued.
      client.unsubscribeTransportSession('closed-3');
      await vi.advanceTimersByTimeAsync(2_000);

      const historyTargets = secondWs.send.mock.calls
        .map((c) => String(c[0]))
        .filter((raw) => raw.includes('"forceHistory":true'))
        .map((raw) => JSON.parse(raw).sessionId as string);
      expect(historyTargets).not.toContain('closed-3');

      client.disconnect();
      vi.useRealTimers();
    });

    it('supports live-only passive transport subscriptions without history replay', async () => {
      vi.useFakeTimers();
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      const firstWs = lastWs!;

      client.subscribeTransportSession('passive-session', { replayHistory: false });
      expect(JSON.parse(firstWs.send.mock.calls.at(-1)[0] as string)).toEqual({
        type: 'chat.subscribe',
        sessionId: 'passive-session',
        forceHistory: false,
      });

      firstWs.send.mockClear();
      firstWs.emit('close');
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(0);
      const secondWs = lastWs!;
      secondWs.emit('open');

      expect(secondWs.send).toHaveBeenCalledWith(expect.stringContaining('"forceHistory":false'));
      expect(secondWs.send).not.toHaveBeenCalledWith(expect.stringContaining('"forceHistory":true'));
      client.disconnect();
      vi.useRealTimers();
    });

    it('can upgrade a live-only transport subscription to request history once', async () => {
      vi.useFakeTimers();
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      const socket = lastWs!;

      client.subscribeTransportSession('passive-session', { replayHistory: false });
      socket.send.mockClear();

      client.subscribeTransportSession('passive-session');
      expect(JSON.parse(socket.send.mock.calls.at(-1)[0] as string)).toEqual({
        type: 'chat.subscribe',
        sessionId: 'passive-session',
        forceHistory: true,
      });

      socket.send.mockClear();
      client.subscribeTransportSession('passive-session', { replayHistory: false });
      expect(socket.send).not.toHaveBeenCalled();
      client.disconnect();
      vi.useRealTimers();
    });

    it('respondTransportApproval sends chat.approval_response', async () => {
      const client = await connectClient();
      lastWs!.send.mockClear();

      client.respondTransportApproval('transport-session', 'req-1', true);

      expect(JSON.parse(lastWs!.send.mock.calls[0][0] as string)).toEqual({
        type: TRANSPORT_MSG.APPROVAL_RESPONSE,
        sessionId: 'transport-session',
        requestId: 'req-1',
        approved: true,
      });
      client.disconnect();
    });
  });

  it('stages reconnect-storm work without delaying timeline gap-fill requests', async () => {
    vi.useFakeTimers();
    const client = new WsClient('http://localhost:8787', 'srv-1');
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastWs!.emit('open');
    lastWs!.send.mockClear();

    client.subscribeTerminal('deck_storm_brain', false);
    client.unsubscribeTerminal('deck_storm_brain');
    client.subscribeTerminal('deck_storm_brain', true);
    const historyRequestId = client.sendTimelineHistoryRequest('deck_storm_brain', 300, 999);
    const replayRequestId = client.sendTimelineReplayRequest('deck_storm_brain', 42, 7);
    const fsRequestId = client.fsListDir('/tmp/deck_storm_project');
    const gitRequestId = client.fsGitStatus('/tmp/deck_storm_project');
    client.send({
      type: 'transport.list_models',
      agentType: 'codex-sdk',
      requestId: 'models-storm',
    });

    let messages = lastWs!.send.mock.calls.map((call) => JSON.parse(call[0] as string));
    expect(messages).toEqual([
      { type: 'terminal.subscribe', session: 'deck_storm_brain', raw: true },
      {
        type: TIMELINE_MESSAGES.HISTORY_REQUEST,
        sessionName: 'deck_storm_brain',
        requestId: historyRequestId,
        limit: 300,
        afterTs: 999,
      },
      {
        type: TIMELINE_MESSAGES.REPLAY_REQUEST,
        sessionName: 'deck_storm_brain',
        requestId: replayRequestId,
        afterSeq: 42,
        epoch: 7,
      },
    ]);

    await vi.advanceTimersByTimeAsync(120);
    messages = lastWs!.send.mock.calls.map((call) => JSON.parse(call[0] as string));
    expect(messages).toContainEqual({ type: 'terminal.subscribe', session: 'deck_storm_brain', raw: true });
    expect(messages.some((msg) => msg.type === 'fs.ls')).toBe(false);
    expect(messages.some((msg) => msg.type === 'fs.git_status')).toBe(false);
    expect(messages.some((msg) => msg.type === 'transport.list_models')).toBe(false);

    await vi.advanceTimersByTimeAsync(400);
    messages = lastWs!.send.mock.calls.map((call) => JSON.parse(call[0] as string));
    expect(messages).toContainEqual({
      type: 'fs.ls',
      path: '/tmp/deck_storm_project',
      requestId: fsRequestId,
      includeFiles: false,
      includeMetadata: false,
    });
    expect(messages).toContainEqual({
      type: 'fs.git_status',
      path: '/tmp/deck_storm_project',
      requestId: gitRequestId,
    });
    expect(messages).toContainEqual({
      type: 'transport.list_models',
      agentType: 'codex-sdk',
      requestId: 'models-storm',
    });

    client.disconnect();
    vi.useRealTimers();
  });

  describe('repo helpers', () => {
    it('sends checkout with session binding and force-capable branch/commit requests', async () => {
      const client = await connectClient();
      lastWs!.send.mockClear();

      const checkoutId = client.repoCheckoutBranch('/repo/project', 'feature/a', { sessionId: 'deck_proj_brain' });
      const branchesId = client.repoListBranches('/repo/project', { force: true });
      const commitsId = client.repoListCommits('/repo/project', { branch: 'feature/a', page: 2, force: true });
      const messages = lastWs!.send.mock.calls.map((call) => JSON.parse(call[0] as string));

      expect(messages).toEqual([
        {
          type: REPO_MSG.CHECKOUT_BRANCH,
          requestId: checkoutId,
          projectDir: '/repo/project',
          branch: 'feature/a',
          sessionId: 'deck_proj_brain',
        },
        {
          type: REPO_MSG.LIST_BRANCHES,
          requestId: branchesId,
          projectDir: '/repo/project',
          force: true,
        },
        {
          type: REPO_MSG.LIST_COMMITS,
          requestId: commitsId,
          projectDir: '/repo/project',
          branch: 'feature/a',
          page: 2,
          force: true,
        },
      ]);
      client.disconnect();
    });
  });

  describe('P2P workflow helpers', () => {
    it('p2pStatus sends a request-scoped status payload without runId', async () => {
      const client = await connectClient();
      lastWs!.send.mockClear();

      const requestId = client.p2pStatus();
      const msg = JSON.parse(lastWs!.send.mock.calls[0][0] as string);

      expect(isP2pWorkflowRequestId(requestId)).toBe(true);
      expect(msg).toEqual({
        type: P2P_WORKFLOW_MSG.STATUS,
        requestId,
      });
      client.disconnect();
    });

    it('p2pStatus includes runId when provided', async () => {
      const client = await connectClient();
      lastWs!.send.mockClear();

      const requestId = client.p2pStatus('run-123', { sessionName: 'deck_proj_brain' });
      const msg = JSON.parse(lastWs!.send.mock.calls[0][0] as string);

      expect(isP2pWorkflowRequestId(requestId)).toBe(true);
      expect(msg).toEqual({
        type: P2P_WORKFLOW_MSG.STATUS,
        requestId,
        runId: 'run-123',
        sessionName: 'deck_proj_brain',
      });
      client.disconnect();
    });

    it('p2pListDiscussions sends a request-scoped list payload', async () => {
      const client = await connectClient();
      lastWs!.send.mockClear();

      client.subscribeTerminal('deck_proj_brain', false);
      lastWs!.send.mockClear();
      const requestId = client.p2pListDiscussions({ projectDir: '/repo/project' });
      const msg = JSON.parse(lastWs!.send.mock.calls[0][0] as string);

      expect(isP2pWorkflowRequestId(requestId)).toBe(true);
      expect(msg).toEqual({
        type: P2P_WORKFLOW_MSG.LIST_DISCUSSIONS,
        requestId,
        sessionName: 'deck_proj_brain',
        projectDir: '/repo/project',
      });
      client.disconnect();
    });

    it('p2pReadDiscussion sends a request-scoped read payload', async () => {
      const client = await connectClient();
      lastWs!.send.mockClear();

      client.setP2pWorkflowRequestScope({ sessionName: 'deck_proj_w1', cwd: '/repo/project' });
      const requestId = client.p2pReadDiscussion('discussion-1');
      const msg = JSON.parse(lastWs!.send.mock.calls[0][0] as string);

      expect(isP2pWorkflowRequestId(requestId)).toBe(true);
      expect(msg).toEqual({
        type: P2P_WORKFLOW_MSG.READ_DISCUSSION,
        requestId,
        id: 'discussion-1',
        sessionName: 'deck_proj_w1',
        cwd: '/repo/project',
      });
      client.disconnect();
    });

    it('cleans pending P2P workflow requests on response, timeout, and disconnect', async () => {
      const client = await connectClient();
      vi.useFakeTimers();
      lastWs!.send.mockClear();

      const listRequestId = client.p2pListDiscussions();
      expect((client as any).p2pWorkflowPendingRequests.has(listRequestId)).toBe(true);
      lastWs!.emit('message', {
        data: JSON.stringify({
          type: P2P_WORKFLOW_MSG.LIST_DISCUSSIONS_RESPONSE,
          requestId: listRequestId,
          discussions: [],
        }),
      });
      expect((client as any).p2pWorkflowPendingRequests.has(listRequestId)).toBe(false);

      const statusRequestId = client.p2pStatus();
      expect((client as any).p2pWorkflowPendingRequests.has(statusRequestId)).toBe(true);
      vi.advanceTimersByTime(30_000);
      expect((client as any).p2pWorkflowPendingRequests.has(statusRequestId)).toBe(false);

      const readRequestId = client.p2pReadDiscussion('discussion-1');
      expect((client as any).p2pWorkflowPendingRequests.has(readRequestId)).toBe(true);
      client.disconnect();
      expect((client as any).p2pWorkflowPendingRequests.size).toBe(0);
    });
  });

  // ── daemon.disconnected / daemon.reconnected dispatch ──────────────────

  describe('daemon lifecycle messages', () => {
    async function connectClient(): Promise<WsClient> {
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.connect();
      await flushAsync();
      lastWs!.emit('open');
      return client;
    }

    it('dispatches daemon.disconnected to handlers', async () => {
      const client = await connectClient();
      const handler = vi.fn();
      client.onMessage(handler);
      handler.mockClear();

      lastWs!.emit('message', { data: JSON.stringify({ type: DAEMON_MSG.DISCONNECTED }) });
      expect(handler).toHaveBeenCalledWith({ type: DAEMON_MSG.DISCONNECTED });
      client.disconnect();
    });

    it('dispatches daemon.reconnected to handlers', async () => {
      const client = await connectClient();
      const handler = vi.fn();
      client.onMessage(handler);
      handler.mockClear();

      lastWs!.emit('message', { data: JSON.stringify({ type: DAEMON_MSG.RECONNECTED }) });
      expect(handler).toHaveBeenCalledWith({ type: DAEMON_MSG.RECONNECTED });
      client.disconnect();
    });

    it('stays connected (browser WS alive) even when daemon.disconnected arrives', async () => {
      const client = await connectClient();
      lastWs!.emit('message', { data: JSON.stringify({ type: DAEMON_MSG.DISCONNECTED }) });
      // The browser WebSocket should still be connected
      expect(client.connected).toBe(true);
      client.disconnect();
    });

    it('dispatches daemon.upgrade_blocked to handlers', async () => {
      const client = await connectClient();
      const handler = vi.fn();
      client.onMessage(handler);
      handler.mockClear();

      lastWs!.emit('message', { data: JSON.stringify({ type: DAEMON_MSG.UPGRADE_BLOCKED, reason: 'p2p_active', activeRunIds: ['run_1'] }) });
      expect(handler).toHaveBeenCalledWith({ type: DAEMON_MSG.UPGRADE_BLOCKED, reason: 'p2p_active', activeRunIds: ['run_1'] });
      client.disconnect();
    });

    it('dispatches daemon.upgrade_blocked transport_busy to handlers', async () => {
      const client = await connectClient();
      const handler = vi.fn();
      client.onMessage(handler);
      handler.mockClear();

      lastWs!.emit('message', { data: JSON.stringify({ type: DAEMON_MSG.UPGRADE_BLOCKED, reason: 'transport_busy', activeSessionNames: ['deck_proj_brain'] }) });
      expect(handler).toHaveBeenCalledWith({ type: DAEMON_MSG.UPGRADE_BLOCKED, reason: 'transport_busy', activeSessionNames: ['deck_proj_brain'] });
      client.disconnect();
    });
  });

  // ── fsListDir ─────────────────────────────────────────────────────────

  describe('fsListDir', () => {
    async function connectClient(): Promise<WsClient> {
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.connect();
      await flushAsync();
      lastWs!.emit('open');
      return client;
    }

    it('sends fs.ls message with path and requestId', async () => {
      vi.useFakeTimers();
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      lastWs!.send.mockClear();
      const requestId = client.fsListDir('/home/user/projects');
      await vi.advanceTimersByTimeAsync(300);
      expect(lastWs!.send).toHaveBeenCalled();
      const msg = JSON.parse(lastWs!.send.mock.calls.at(-1)[0]);
      expect(msg.type).toBe('fs.ls');
      expect(msg.path).toBe('/home/user/projects');
      expect(msg.requestId).toBe(requestId);
      expect(msg.includeFiles).toBe(false);
      client.disconnect();
      vi.useRealTimers();
    });

    it('sets includeFiles=true when requested', async () => {
      vi.useFakeTimers();
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      lastWs!.send.mockClear();
      client.fsListDir('/home/user', true);
      await vi.advanceTimersByTimeAsync(300);
      const msg = JSON.parse(lastWs!.send.mock.calls.at(-1)[0]);
      expect(msg.includeFiles).toBe(true);
      client.disconnect();
      vi.useRealTimers();
    });

    it('can request OpenSpec task stats for directory listings', async () => {
      vi.useFakeTimers();
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      lastWs!.send.mockClear();
      client.fsListDir('/repo/openspec/changes', false, false, { includeOpenSpecTaskStats: true });
      await vi.advanceTimersByTimeAsync(300);
      const msg = JSON.parse(lastWs!.send.mock.calls.at(-1)[0]);
      expect(msg).toMatchObject({
        type: 'fs.ls',
        path: '/repo/openspec/changes',
        includeFiles: false,
        includeMetadata: false,
        includeOpenSpecTaskStats: true,
      });
      client.disconnect();
      vi.useRealTimers();
    });

    it('returns a unique UUID as requestId', async () => {
      const client = await connectClient();
      const id1 = client.fsListDir('/home/user/a');
      const id2 = client.fsListDir('/home/user/b');
      expect(id1).not.toBe(id2);
      expect(typeof id1).toBe('string');
      client.disconnect();
    });

    it('single-flights identical owner reads until the matching response settles', async () => {
      vi.useFakeTimers();
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      lastWs!.send.mockClear();

      const first = client.fsListDir('/home/user/shared', true, false, { sessionName: 'deck_owner' });
      const duplicate = client.fsListDir('/home/user/shared', true, false, { sessionName: 'deck_owner' });
      expect(duplicate).toBe(first);
      await vi.advanceTimersByTimeAsync(400);
      expect(lastWs!.send.mock.calls
        .map(([raw]) => JSON.parse(String(raw)))
        .filter((message) => message.type === 'fs.ls')).toHaveLength(1);

      lastWs!.emit('message', { data: JSON.stringify({
        type: 'fs.ls_response', requestId: first, path: '/home/user/shared', status: 'ok', entries: [],
      }) });
      const afterSettle = client.fsListDir('/home/user/shared', true, false, { sessionName: 'deck_owner' });
      expect(afterSettle).not.toBe(first);
      await vi.advanceTimersByTimeAsync(400);
      expect(lastWs!.send.mock.calls
        .map(([raw]) => JSON.parse(String(raw)))
        .filter((message) => message.type === 'fs.ls')).toHaveLength(2);

      client.disconnect();
      vi.useRealTimers();
    });

    it('forgetOwnedDataRequest lets a caller-side give-up retry actually hit the wire', async () => {
      vi.useFakeTimers();
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      lastWs!.send.mockClear();

      const first = client.fsListDir('/home/user/shared', true, false, { sessionName: 'deck_owner' });
      // A caller (e.g. FileBrowser) that gives up locally before any response
      // arrives -- its own timeout fired -- must be able to retry without the
      // dedup entry silently absorbing the retry into the dead requestId.
      client.forgetOwnedDataRequest(first);
      const retry = client.fsListDir('/home/user/shared', true, false, { sessionName: 'deck_owner' });
      expect(retry).not.toBe(first);
      await vi.advanceTimersByTimeAsync(400);
      expect(lastWs!.send.mock.calls
        .map(([raw]) => JSON.parse(String(raw)))
        .filter((message) => message.type === 'fs.ls')).toHaveLength(2);

      client.disconnect();
      vi.useRealTimers();
    });

    it('fs.ls_response is dispatched to onMessage handlers', async () => {
      const client = await connectClient();
      const handler = vi.fn();
      client.onMessage(handler);
      const requestId = client.fsListDir('/home/user');
      const responseMsg = {
        type: 'fs.ls_response',
        requestId,
        path: '/home/user',
        resolvedPath: '/home/user',
        status: 'ok',
        entries: [{ name: 'projects', isDir: true, hidden: false }],
      };
      lastWs!.emit('message', { data: JSON.stringify(responseMsg) });
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'fs.ls_response', requestId }));
      client.disconnect();
    });
  });

  it('single-flights timeline history, git status and model catalogue reads by semantic owner key', async () => {
    vi.useFakeTimers();
    const client = new WsClient('http://localhost:8787', 'srv-1');
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastWs!.emit('open');
    lastWs!.send.mockClear();

    expect(client.sendTimelineHistoryRequest('deck_owner', 500))
      .toBe(client.sendTimelineHistoryRequest('deck_owner', 500));
    expect(client.fsGitStatus('/repo', { includeStats: true, sessionName: 'deck_owner' }))
      .toBe(client.fsGitStatus('/repo', { includeStats: true, sessionName: 'deck_owner' }));
    expect(client.requestTransportModels({ agentType: 'codex-sdk', sessionName: 'deck_owner' }))
      .toBe(client.requestTransportModels({ agentType: 'codex-sdk', sessionName: 'deck_owner' }));

    await vi.advanceTimersByTimeAsync(500);
    const sent = lastWs!.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as { type: string });
    expect(sent.filter((message) => message.type === TIMELINE_MESSAGES.HISTORY_REQUEST)).toHaveLength(1);
    expect(sent.filter((message) => message.type === 'fs.git_status')).toHaveLength(1);
    expect(sent.filter((message) => message.type === TRANSPORT_MSG.LIST_MODELS)).toHaveLength(1);

    client.disconnect();
    vi.useRealTimers();
  });

  it('includes byte budgets on bounded newer history and older page requests', async () => {
    const client = await connectClient();
    lastWs!.send.mockClear();
    lastWs!.emit('message', { data: JSON.stringify({
      type: 'daemon.hello',
      daemonId: 'daemon-bounded',
      capabilities: [TIMELINE_PROTOCOL_CAPABILITY],
      timelineProtocolRevision: 1,
      helloEpoch: 1,
      sentAt: Date.now(),
    }) });

    client.sendTimelineHistoryRequest('deck_bounded', 200, undefined, undefined, {
      epoch: 7,
      afterSeq: 41,
      direction: 'newer',
    }, 1024 * 1024);
    client.sendTimelinePageRequest('deck_bounded', {
      epoch: 7,
      beforeTs: 1234,
      direction: 'older',
    }, 200, 1024 * 1024);

    const messages = lastWs!.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as Record<string, unknown>);
    expect(messages).toEqual([
      expect.objectContaining({
        type: TIMELINE_MESSAGES.HISTORY_REQUEST,
        sessionName: 'deck_bounded',
        limit: 200,
        budgetBytes: 1024 * 1024,
        cursor: { epoch: 7, afterSeq: 41, direction: 'newer' },
      }),
      expect.objectContaining({
        type: TIMELINE_MESSAGES.PAGE_REQUEST,
        sessionName: 'deck_bounded',
        limit: 200,
        budgetBytes: 1024 * 1024,
        cursor: { epoch: 7, beforeTs: 1234, direction: 'older' },
      }),
    ]);
    client.disconnect();
  });

  it('puts a text-only contentFilter on the wire and keeps it a different owner key from the unfiltered window', async () => {
    const client = await connectClient();
    lastWs!.send.mockClear();
    const peek = client.sendTimelineHistoryRequest('deck_peek', 30, undefined, undefined, undefined, 256 * 1024, 'text');
    const window = client.sendTimelineHistoryRequest('deck_peek', 30, undefined, undefined, undefined, 256 * 1024);
    // Identical peeks single-flight; the unfiltered request with the same bounds is another read.
    expect(client.sendTimelineHistoryRequest('deck_peek', 30, undefined, undefined, undefined, 256 * 1024, 'text')).toBe(peek);
    expect(window).not.toBe(peek);
    const messages = lastWs!.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as Record<string, unknown>)
      .filter((message) => message.type === TIMELINE_MESSAGES.HISTORY_REQUEST);
    expect(messages).toHaveLength(2);
    expect(messages.find((message) => message.requestId === peek)).toMatchObject({ contentFilter: 'text', limit: 30, budgetBytes: 256 * 1024 });
    expect(messages.find((message) => message.requestId === window)?.contentFilter).toBeUndefined();
    client.disconnect();
  });

  it('rate-limits unique owner data reads without blocking control traffic and emits a recoverable result', async () => {
    const client = await connectClient();
    const handler = vi.fn();
    client.onMessage(handler);
    lastWs!.send.mockClear();

    let rejectedRequestId = '';
    for (let index = 0; index < 65; index += 1) {
      rejectedRequestId = client.sendTimelineHistoryRequest(`deck_owner_${index}`, 500);
    }
    client.send({ type: 'session.send', sessionName: 'deck_owner_0', text: 'still-live', commandId: 'cmd-live' });
    await Promise.resolve();

    const sent = lastWs!.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as { type: string });
    expect(sent.filter((message) => message.type === TIMELINE_MESSAGES.HISTORY_REQUEST)).toHaveLength(64);
    expect(sent).toContainEqual(expect.objectContaining({ type: 'session.send', commandId: 'cmd-live' }));
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      type: TIMELINE_MESSAGES.HISTORY,
      requestId: rejectedRequestId,
      status: 'error',
      errorReason: 'queue_full',
      recoverable: true,
    }));
    client.disconnect();
  });

  describe('fs rename/delete', () => {
    it('includes the owning session when renaming', async () => {
      const client = await connectClient();
      lastWs!.send.mockClear();
      const requestId = client.fsRename('/home/user/project/a.txt', '/home/user/project/b.txt', 'deck_proj_brain');
      const msg = JSON.parse(lastWs!.send.mock.calls.at(-1)[0]);
      expect(msg).toMatchObject({
        type: FS_TRANSPORT_MSG.RENAME,
        requestId,
        path: '/home/user/project/a.txt',
        newPath: '/home/user/project/b.txt',
        sessionName: 'deck_proj_brain',
      });
      client.disconnect();
    });

    it('includes the owning session when deleting', async () => {
      const client = await connectClient();
      lastWs!.send.mockClear();
      const requestId = client.fsDelete('/home/user/project/a.txt', 'deck_proj_brain');
      const msg = JSON.parse(lastWs!.send.mock.calls.at(-1)[0]);
      expect(msg).toMatchObject({
        type: FS_TRANSPORT_MSG.DELETE,
        requestId,
        path: '/home/user/project/a.txt',
        sessionName: 'deck_proj_brain',
      });
      client.disconnect();
    });
  });

  describe('urgent send (stop / cancel high-priority path)', () => {
    // Pins the user-reported "stop button stopped working again" regression.
    // probeConnection() flips `_connected = false` for ~50-200 ms on every
    // visibility/focus tick while it pings the server. During that window the
    // regular `send()` is gated and drops the message (it no-ops rather than
    // throwing — throwing crashed the ChatView), so a stop tap landing in that
    // window would otherwise vanish.
    // sendUrgent / sendSessionCommandUrgent bypass the probe gate (still
    // checking the OS-level readyState). Caller HTTP-fallback handles the
    // genuinely-dead-socket case.

    it('sendUrgent succeeds when readyState is OPEN even if _connected=false', async () => {
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.connect();
      await flushAsync();
      lastWs!.emit('open');
      expect(client.connected).toBe(true);

      const sentMessages: string[] = [];
      const origSend = lastWs!.send.bind(lastWs);
      lastWs!.send = (data: string) => { sentMessages.push(data); origSend(data); };

      // Simulate the probe-state flip — _connected=false but socket still
      // OPEN at the OS level (the exact regression window).
      (client as unknown as { _connected: boolean })._connected = false;

      // Regular send() is gated during the probe window — no delivery — but
      // must NOT throw (an uncaught throw crashes the ChatView).
      expect(() => client.send({ type: 'session.send', text: 'normal' })).not.toThrow();
      expect(sentMessages).toHaveLength(0);

      // sendUrgent goes through.
      expect(() => client.sendUrgent({ type: 'session.send', text: '/stop' })).not.toThrow();
      expect(sentMessages).toHaveLength(1);
      expect(JSON.parse(sentMessages[0])).toEqual({ type: 'session.send', text: '/stop' });

      client.disconnect();
    });

    it('sendUrgent still throws when the socket is genuinely closed', async () => {
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.connect();
      await flushAsync();
      lastWs!.emit('open');
      lastWs!.emit('close', { code: 1006, reason: 'lost' });
      // Socket is gone; even urgent send must throw so the caller falls
      // back to HTTP rather than silently dropping.
      expect(() => client.sendUrgent({ type: 'session.send', text: '/stop' })).toThrow('WebSocket not connected');
    });

    describe('askAnswer', () => {
      const hello = (capabilities: string[]) => ({ data: JSON.stringify({
        type: 'daemon.hello',
        daemonId: 'daemon-ask',
        capabilities,
        helloEpoch: 1,
        sentAt: Date.now(),
      }) });

      it('reports a socket that is not open instead of silently dropping the answer', async () => {
        const client = await connectClient();
        lastWs!.emit('close', { code: 1006, reason: 'lost' });
        expect(client.askAnswer('deck_brain', 'A', { toolUseId: 'toolu_1' })).toEqual({ ok: false, reason: 'not_connected' });
      });

      it('still delivers during the probe window where the gated send() would drop it', async () => {
        const client = await connectClient();
        lastWs!.send.mockClear();
        (client as unknown as { _connected: boolean })._connected = false;
        const result = client.askAnswer('deck_brain', 'A');
        expect(result).toEqual({ ok: true });
        expect(JSON.parse(String(lastWs!.send.mock.calls[0]![0]))).toEqual({
          type: 'ask.answer', sessionName: 'deck_brain', answer: 'A',
        });
        client.disconnect();
      });

      it('reports an over-size answer', async () => {
        const client = await connectClient();
        lastWs!.send.mockClear();
        expect(client.askAnswer('deck_brain', 'x'.repeat(5 * 1024 * 1024))).toEqual({ ok: false, reason: 'too_large' });
        expect(lastWs!.send).not.toHaveBeenCalled();
        client.disconnect();
      });

      it('adds a commandId + toolUseId only when the daemon advertises answer acks', async () => {
        const client = await connectClient();
        lastWs!.emit('message', hello([ASK_ANSWER_ACK_CAPABILITY_V1]));
        lastWs!.send.mockClear();
        const result = client.askAnswer('deck_brain', 'A', { toolUseId: 'toolu_1' });
        expect(result.ok).toBe(true);
        const frame = JSON.parse(String(lastWs!.send.mock.calls[0]![0])) as Record<string, unknown>;
        expect(frame).toMatchObject({ type: 'ask.answer', sessionName: 'deck_brain', answer: 'A', toolUseId: 'toolu_1' });
        expect(typeof frame.commandId).toBe('string');
        expect(result).toEqual({ ok: true, commandId: frame.commandId });
        client.disconnect();
      });

      it('sends the legacy frame (no commandId) to a daemon without the capability', async () => {
        const client = await connectClient();
        lastWs!.emit('message', hello([]));
        lastWs!.send.mockClear();
        const result = client.askAnswer('deck_brain', 'A', { toolUseId: 'toolu_1' });
        expect(result).toEqual({ ok: true });
        expect(JSON.parse(String(lastWs!.send.mock.calls[0]![0]))).not.toHaveProperty('commandId');
        client.disconnect();
      });
    });

    it('sendSessionCommandUrgent maps cancel to session.cancel without /stop text', async () => {
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.connect();
      await flushAsync();
      lastWs!.emit('open');

      const sentMessages: string[] = [];
      const origSend = lastWs!.send.bind(lastWs);
      lastWs!.send = (data: string) => { sentMessages.push(data); origSend(data); };

      (client as unknown as { _connected: boolean })._connected = false;
      client.sendSessionCommandUrgent('cancel', { sessionName: 'deck_brain', commandId: 'cmd-1' });
      expect(JSON.parse(sentMessages[0])).toEqual({
        type: 'session.cancel',
        sessionName: 'deck_brain',
        commandId: 'cmd-1',
      });

      client.disconnect();
    });

    it('sendSessionCommandUrgent delivers session.send during _connected=false probe and throws when socket is not OPEN', async () => {
      const client = new WsClient('http://localhost:8787', 'srv-1');
      // 1. Disconnected (no open socket): must throw so caller can fall back to HTTP instead of silent drop.
      expect(() => client.sendSessionCommandUrgent('send', { sessionName: 'deck_brain', text: 'hi', commandId: 'cmd-drop' })).toThrow('WebSocket not connected');

      // 2. Open socket mid-probe (_connected=false): urgent send bypasses the probe gate.
      client.connect();
      await flushAsync();
      lastWs!.emit('open');
      (client as unknown as { _connected: boolean })._connected = false;
      lastWs!.send.mockClear();

      client.sendSessionCommandUrgent('send', { sessionName: 'deck_brain', text: 'hi', commandId: 'cmd-probe' });
      expect(JSON.parse(String(lastWs!.send.mock.calls[0]?.[0]))).toEqual({
        type: 'session.send',
        sessionName: 'deck_brain',
        text: 'hi',
        commandId: 'cmd-probe',
      });

      // 3. Closed socket: throws again instead of silently dropping.
      lastWs!.readyState = 3; // CLOSED
      expect(() => client.sendSessionCommandUrgent('send', { sessionName: 'deck_brain', text: 'hi', commandId: 'cmd-closed' })).toThrow('WebSocket not connected');

      client.disconnect();
    });
  });

  describe('eager probe on interaction (zombie-socket recovery)', () => {
    const hasPingFrame = (ws: MockWebSocket) =>
      ws.send.mock.calls.some(([raw]) => (JSON.parse(String(raw)) as { type?: string }).type === 'ping');

    it('probes the socket when subscribing after the liveness window lapses', async () => {
      const client = await connectClient();
      const events: Array<{ event?: string }> = [];
      client.onMessage((m) => events.push(m as { event?: string }));
      // Saw a pong long ago, socket still reports OPEN → classic zombie.
      (client as unknown as { _lastPongAt: number })._lastPongAt = Date.now() - 20_000;
      lastWs!.send.mockClear();

      client.subscribeTerminal('deck_sub_zombie', false);

      // A verification ping fires immediately instead of stalling until the
      // heartbeat watchdog (~36s) or a manual tab switch.
      expect(hasPingFrame(lastWs!)).toBe(true);
      // And it's surfaced as a soft "probing", not a hard disconnect.
      expect(events.some((e) => e?.event === 'probing')).toBe(true);

      client.disconnect();
    });

    it('does NOT probe when a recent pong already proved the socket alive', async () => {
      const client = await connectClient();
      const events: Array<{ event?: string }> = [];
      client.onMessage((m) => events.push(m as { event?: string }));
      (client as unknown as { _lastPongAt: number })._lastPongAt = Date.now(); // fresh
      lastWs!.send.mockClear();

      client.subscribeTerminal('deck_sub_healthy', false);

      expect(hasPingFrame(lastWs!)).toBe(false);
      expect(events.some((e) => e?.event === 'probing')).toBe(false);

      client.disconnect();
    });

    it('does NOT probe immediately after connect (no pong observed yet)', async () => {
      const client = await connectClient(); // _lastPongAt is still 0
      lastWs!.send.mockClear();

      client.subscribeTerminal('deck_sub_fresh', false);

      expect(hasPingFrame(lastWs!)).toBe(false);

      client.disconnect();
    });

    it('holdTerminalRaw also recovers a stalled socket', async () => {
      const client = await connectClient();
      (client as unknown as { _lastPongAt: number })._lastPongAt = Date.now() - 20_000;
      lastWs!.send.mockClear();

      const release = client.holdTerminalRaw('deck_sub_shell');
      expect(hasPingFrame(lastWs!)).toBe(true);
      release();

      client.disconnect();
    });

    it('sendTimelineHistoryRequest also recovers a stalled socket', async () => {
      const client = await connectClient();
      (client as unknown as { _lastPongAt: number })._lastPongAt = Date.now() - 20_000;
      lastWs!.send.mockClear();

      client.sendTimelineHistoryRequest('deck_sub_chat');
      expect(hasPingFrame(lastWs!)).toBe(true);

      client.disconnect();
    });

    it('is a safe no-op when never connected', async () => {
      const client = new WsClient('http://localhost:8787', 'srv-1');
      expect(() => client.subscribeTerminal('s', false)).not.toThrow();
      expect(lastWs).toBeNull();
    });

    it('resets _lastPongAt on forced resume so post-open timeline/terminal interactions do not loop reconnectNow', async () => {
      vi.useFakeTimers();
      try {
        const client = new WsClient('http://localhost:8787', 'srv-1');
        client.connect();
        await vi.advanceTimersByTimeAsync(0);
        const sock1 = lastWs!;
        sock1.emit('open');
        // Record a real pong, then sleep longer than 2x stale threshold (>60s).
        sock1.emit('message', { data: JSON.stringify({ type: 'pong' }) });
        vi.setSystemTime(Date.now() + 90_000);

        const events: Array<{ event?: string; reason?: string }> = [];
        client.onMessage((msg) => {
          if (msg.type === 'session.event') events.push(msg);
          if (msg.type === 'session.event' && msg.event === 'connected') {
            // Mirrors App.tsx on('connected'): immediately refresh timeline + subscribe
            // before the new socket's first pong arrives.
            client.sendTimelineHistoryRequest('deck_sub_chat');
            client.subscribeTerminal('deck_sub_term', false);
          }
        });

        client.resumeConnection(true);
        await vi.advanceTimersByTimeAsync(0);
        const sock2 = lastWs!;
        expect(sock2).not.toBe(sock1);
        events.length = 0;

        sock2.emit('open');
        sock2.send.mockClear();
        // Also simulate a focus probe right after open before first pong arrives.
        client.probeConnection();

        expect(sock2.readyState).toBe(MockWebSocket.OPEN);
        expect(lastWs).toBe(sock2);
        expect(client.connected).toBe(true);
        expect(events.filter((e) => e.event === 'disconnected')).toHaveLength(0);

        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('send() never throws on a disconnected socket (ChatView crash guard)', () => {
    // Regression: send() is called from React effects / document listeners
    // (focus/visibility → requestSessionList, discussionList). When the socket
    // is momentarily down, an uncaught "WebSocket not connected" throw bubbled
    // to the ErrorBoundary and crashed the whole ChatView.
    it('does not throw when never connected', () => {
      const client = new WsClient('http://localhost:8787', 'srv-1');
      expect(client.connected).toBe(false);
      expect(() => client.send({ type: 'get_sessions' })).not.toThrow();
      expect(() => client.requestSessionList()).not.toThrow();
      expect(() => client.discussionList()).not.toThrow();
    });

    it('does not throw after the socket closes', async () => {
      const client = await connectClient();
      expect(client.connected).toBe(true);
      lastWs!.emit('close', { code: 1006 });
      expect(client.connected).toBe(false);
      expect(() => client.send({ type: 'get_sessions' })).not.toThrow();
      expect(() => client.requestSessionList()).not.toThrow();
      expect(() => client.discussionList()).not.toThrow();
    });

    it('still forwards to the socket while connected', async () => {
      const client = await connectClient();
      lastWs!.send.mockClear();
      client.send({ type: 'get_sessions' });
      expect(lastWs!.send).toHaveBeenCalledTimes(1);
      expect(JSON.parse(lastWs!.send.mock.calls[0]![0] as string)).toMatchObject({ type: 'get_sessions' });
    });

    it('sendUrgent() STILL throws when disconnected (preserves HTTP fallback)', () => {
      const client = new WsClient('http://localhost:8787', 'srv-1');
      expect(() => client.sendUrgent({ type: 'session.stop', sessionName: 's' })).toThrow(/not connected/i);
    });
  });

  describe('fs.write payload limits', () => {
    it('allows daemon-sized file saves above the default small message cap', async () => {
      const client = await connectClient();
      lastWs!.send.mockClear();
      const content = 'x'.repeat(70_000);

      const requestId = client.fsWriteFile('/tmp/big.txt', content);

      expect(requestId).toBeTruthy();
      expect(lastWs!.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(lastWs!.send.mock.calls[0]![0] as string);
      expect(sent).toMatchObject({ type: 'fs.write', path: '/tmp/big.txt', content });
    });

    it('fails before sending when content exceeds the daemon file-save limit', async () => {
      const client = await connectClient();
      lastWs!.send.mockClear();
      const content = 'x'.repeat(FS_WRITE_MAX_BYTES + 1);

      expect(() => client.fsWriteFile('/tmp/too-big.txt', content)).toThrow(FS_GENERIC_ERROR_CODES.FILE_TOO_LARGE);
      expect(lastWs!.send).not.toHaveBeenCalled();
    });
  });

  describe('codex reset credits', () => {
    it('sends codex.reset_credits.list with the requestId', async () => {
      const client = await connectClient();
      lastWs!.send.mockClear();
      client.listCodexResetCredits('req-1');
      expect(JSON.parse(lastWs!.send.mock.calls[0]![0] as string)).toEqual({
        type: 'codex.reset_credits.list',
        requestId: 'req-1',
      });
    });

    it('sends codex.reset_credits.consume with requestId + idempotencyKey', async () => {
      const client = await connectClient();
      lastWs!.send.mockClear();
      client.consumeCodexResetCredit('req-2', 'idem-abc');
      expect(JSON.parse(lastWs!.send.mock.calls[0]![0] as string)).toEqual({
        type: 'codex.reset_credits.consume',
        requestId: 'req-2',
        idempotencyKey: 'idem-abc',
      });
    });

    it('does not send consume without an idempotencyKey', async () => {
      const client = await connectClient();
      lastWs!.send.mockClear();
      client.consumeCodexResetCredit('req-3', '');
      expect(lastWs!.send).not.toHaveBeenCalled();
    });
  });

  describe('beginOwnedDataRequest disconnect resilience', () => {
    it('does not poison ownedDataRequests when called while disconnected before socket open', async () => {
      vi.useFakeTimers();
      const client = new WsClient('http://localhost:8787', 'srv-1');
      expect(client.connected).toBe(false);

      const preConnectId = client.fsListDir('/srv/alpha', true, false);
      const preConnectGitId = client.fsGitStatus('/srv/alpha', { includeStats: true });

      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      lastWs!.send.mockClear();

      const liveId = client.fsListDir('/srv/alpha', true, false);
      const liveGitId = client.fsGitStatus('/srv/alpha', { includeStats: true });
      expect(liveId).not.toBe(preConnectId);
      expect(liveGitId).not.toBe(preConnectGitId);

      await vi.advanceTimersByTimeAsync(500);
      const sent = lastWs!.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as { type: string; requestId?: string });
      expect(sent.find((m) => m.type === 'fs.ls')?.requestId).toBe(liveId);
      expect(sent.find((m) => m.type === 'fs.git_status')?.requestId).toBe(liveGitId);

      client.disconnect();
      vi.useRealTimers();
    });

    it('clears orphaned ownedDataRequests on socket close so reconnect retries hit the wire', async () => {
      vi.useFakeTimers();
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');

      const firstId = client.fsListDir('/srv/alpha', true, false);
      lastWs!.emit('close', { code: 1006 });

      // Reconnect opens a new socket
      await vi.advanceTimersByTimeAsync(1_500);
      lastWs!.emit('open');
      lastWs!.send.mockClear();

      const retryId = client.fsListDir('/srv/alpha', true, false);
      expect(retryId).not.toBe(firstId);
      await vi.advanceTimersByTimeAsync(500);
      const sent = lastWs!.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as { type: string; requestId?: string });
      expect(sent.find((m) => m.type === 'fs.ls')?.requestId).toBe(retryId);

      client.disconnect();
      vi.useRealTimers();
    });
  });

  describe('latency correlation & connect-burst suppression', () => {
    it('correlates ping/pong by id, ignores mismatched pong ids, and supports legacy un-tagged pong frames', async () => {
      vi.useFakeTimers();
      const latencies: number[] = [];
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.onLatency((ms) => latencies.push(ms));
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      const socket = lastWs!;

      // Initial ping does not fire synchronously ahead of subscriptions.
      expect(socket.send.mock.calls.filter(([r]) => JSON.parse(String(r)).type === 'ping')).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1_500);
      const ping1 = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0])) as { type: string; id: number };
      expect(ping1.type).toBe('ping');
      expect(typeof ping1.id).toBe('number');

      // Mismatched/stale pong id must NOT report RTT or clear the pending ping.
      await vi.advanceTimersByTimeAsync(25);
      socket.emit('message', { data: JSON.stringify({ type: 'pong', id: ping1.id + 999 }) });
      expect(latencies).toEqual([]);
      expect(client.pingLatency).toBeNull();

      // Matching pong updates RTT accurately (from initial 25ms + 15ms = 40ms).
      await vi.advanceTimersByTimeAsync(15);
      socket.emit('message', { data: JSON.stringify({ type: 'pong', id: ping1.id }) });
      expect(latencies).toEqual([40]);
      expect(client.pingLatency).toBe(40);

      // Next heartbeat interval (at t=10_000ms, 8_460ms after t=1_540ms) accepts legacy { type: 'pong' }.
      await vi.advanceTimersByTimeAsync(8_460);
      const ping2 = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0])) as { type: string; id: number };
      expect(ping2.id).toBeGreaterThan(ping1.id);
      await vi.advanceTimersByTimeAsync(18);
      socket.emit('message', { data: JSON.stringify({ type: 'pong' }) });
      expect(latencies).toEqual([40, 18]);

      client.disconnect();
      vi.useRealTimers();
    });

    it('prevents heartbeat armPing from overlapping an active resume probe', async () => {
      vi.useFakeTimers();
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      const socket = lastWs!;
      socket.send.mockClear();

      // Start foreground probe while _initialPingTimer is pending.
      client.probeConnection(5_000);
      const pingsAfterProbe = () => socket.send.mock.calls
        .map(([raw]) => JSON.parse(String(raw)) as { type: string; id: number })
        .filter((m) => m.type === 'ping');
      expect(pingsAfterProbe()).toHaveLength(1);

      // Crossing the 1500ms initial heartbeat delay while probe is in flight must not send a duplicate ping.
      await vi.advanceTimersByTimeAsync(1_500);
      expect(pingsAfterProbe()).toHaveLength(1);

      client.disconnect();
      vi.useRealTimers();
    });

    it('uses monotonic clock elapsed time when Date.now steps backward between ping and pong', async () => {
      vi.useFakeTimers();
      const latencies: number[] = [];
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.onLatency((ms) => latencies.push(ms));
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      const socket = lastWs!;

      await vi.advanceTimersByTimeAsync(1_500);
      const ping = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0])) as { type: string; id: number };

      const origDateNow = Date.now;
      const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => origDateNow() - 5_000);
      try {
        await vi.advanceTimersByTimeAsync(23);
        socket.emit('message', { data: JSON.stringify({ type: 'pong', id: ping.id }) });
        expect(latencies).toEqual([23]);
      } finally {
        dateSpy.mockRestore();
      }

      client.disconnect();
      vi.useRealTimers();
    });

    it('reuses an in-flight heartbeat ping when probeConnection runs and measures true legacy untagged RTT', async () => {
      vi.useFakeTimers();
      const latencies: number[] = [];
      const events: Array<{ event?: string; reason?: string }> = [];
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.onLatency((ms) => latencies.push(ms));
      client.onMessage((m) => events.push(m as { event?: string; reason?: string }));
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      const socket = lastWs!;

      // Heartbeat ping 1 fires at 1_500ms.
      await vi.advanceTimersByTimeAsync(1_500);
      const sentPings = () => socket.send.mock.calls
        .map(([raw]) => JSON.parse(String(raw)) as { type: string; id: number })
        .filter((m) => m.type === 'ping');
      expect(sentPings()).toHaveLength(1);

      // 122ms later, probeConnection runs while ping 1 is still in flight:
      // must adopt ping 1 instead of emitting a duplicate second ping.
      await vi.advanceTimersByTimeAsync(122);
      client.probeConnection();
      expect(sentPings()).toHaveLength(1);
      expect(events.some((e) => e.reason === 'probe_start')).toBe(true);

      // 5ms later (127ms total since ping 1), legacy server sends untagged pong.
      await vi.advanceTimersByTimeAsync(5);
      socket.emit('message', { data: JSON.stringify({ type: 'pong' }) });
      expect(latencies).toEqual([127]);
      expect(client.pingLatency).toBe(127);
      expect(events.some((e) => e.reason === 'probe_recovered')).toBe(true);

      client.disconnect();
      vi.useRealTimers();
    });

    it('preserves the two-miss reconnect bound when probeConnection adopts an already-in-flight heartbeat ping', async () => {
      vi.useFakeTimers();
      const client = new WsClient('http://localhost:8787', 'srv-1');
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      const firstWs = lastWs!;

      // Initial ping fires at 1_500ms.
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(1_000);
      client.probeConnection(8_000);

      // Remaining budget on ping 1 is 7_000ms (8_000 - 1_000).
      await vi.advanceTimersByTimeAsync(6_999);
      expect(firstWs.readyState).toBe(MockWebSocket.OPEN);

      // At 7_000ms remaining, miss #1 triggers confirming probe ping 2.
      await vi.advanceTimersByTimeAsync(1);
      expect(firstWs.readyState).toBe(MockWebSocket.OPEN);
      const pings = firstWs.send.mock.calls.filter(([raw]) => JSON.parse(String(raw)).type === 'ping');
      expect(pings).toHaveLength(2);

      // Second miss after full 8_000ms triggers reconnect.
      await vi.advanceTimersByTimeAsync(8_000);
      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
      expect(firstWs.readyState).toBe(MockWebSocket.CLOSED);
      expect(lastWs).not.toBe(firstWs);

      client.disconnect();
      vi.useRealTimers();
    });

    it('rejects late untagged pong after retry, visibility reset, or inbound-frame watchdog clear while preserving liveness', async () => {
      // 1. Watchdog timeout retry -> late untagged pong for ping 1 arrives after ping 2 sent.
      vi.useFakeTimers();
      const latenciesRetry: number[] = [];
      const clientRetry = new WsClient('http://localhost:8787', 'srv-1');
      clientRetry.onLatency((ms) => latenciesRetry.push(ms));
      clientRetry.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      const wsRetry = lastWs!;

      await vi.advanceTimersByTimeAsync(1_500); // ping 1
      await vi.advanceTimersByTimeAsync(8_000); // watchdog miss 1 -> retry ping 2
      await vi.advanceTimersByTimeAsync(10);
      // Late untagged pong for ping 1 arrives: must NOT emit 10ms RTT, must keep socket alive.
      wsRetry.emit('message', { data: JSON.stringify({ type: 'pong' }) });
      expect(latenciesRetry).toEqual([]);
      await vi.advanceTimersByTimeAsync(15);
      // Untagged pong for ping 2 drains count to 0 (also skipped for safety), then clean next ping samples.
      wsRetry.emit('message', { data: JSON.stringify({ type: 'pong' }) });
      expect(latenciesRetry).toEqual([]);
      expect(lastWs).toBe(wsRetry);

      // Next clean heartbeat interval (at t = 10_000ms, 475ms after t = 9_525ms) samples cleanly again.
      await vi.advanceTimersByTimeAsync(475);
      await vi.advanceTimersByTimeAsync(22);
      wsRetry.emit('message', { data: JSON.stringify({ type: 'pong' }) });
      expect(latenciesRetry).toEqual([22]);
      clientRetry.disconnect();

      // 2. Tagged pong after retry still reports exact RTT for ping 2.
      const latenciesTagged: number[] = [];
      const clientTagged = new WsClient('http://localhost:8787', 'srv-1');
      clientTagged.onLatency((ms) => latenciesTagged.push(ms));
      clientTagged.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      const wsTagged = lastWs!;
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(8_000); // retry ping 2 sent
      const retryPing2 = JSON.parse(String(wsTagged.send.mock.calls.at(-1)?.[0])) as { type: string; id: number };
      await vi.advanceTimersByTimeAsync(19);
      wsTagged.emit('message', { data: JSON.stringify({ type: 'pong', id: retryPing2.id }) });
      expect(latenciesTagged).toEqual([19]);
      clientTagged.disconnect();

      // 3. Tab hidden clears watchdog -> foreground probe sends ping 2 -> delayed pre-hide untagged pong ignored.
      const latenciesBg: number[] = [];
      const clientBg = new WsClient('http://localhost:8787', 'srv-1');
      clientBg.onLatency((ms) => latenciesBg.push(ms));
      clientBg.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      const wsBg = lastWs!;
      await vi.advanceTimersByTimeAsync(1_500); // ping 1 sent
      setDocumentVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      setDocumentVisibility('visible');
      await vi.advanceTimersByTimeAsync(500);
      clientBg.probeConnection(); // ping 2 sent while ping 1 still un-acked
      await vi.advanceTimersByTimeAsync(5);
      wsBg.emit('message', { data: JSON.stringify({ type: 'pong' }) });
      expect(latenciesBg).toEqual([]);
      expect(lastWs).toBe(wsBg);
      clientBg.disconnect();

      // 3b. Background gap > 30s (e.g. 31s, < app 60s reconnect threshold) must STILL reject late untagged pong
      //     from pre-hide ping 1 on resumeConnection(false), then recover RTT sampling after pending pongs drain.
      const latenciesBg31s: number[] = [];
      const clientBg31s = new WsClient('http://localhost:8787', 'srv-1');
      clientBg31s.onLatency((ms) => latenciesBg31s.push(ms));
      clientBg31s.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      const wsBg31s = lastWs!;
      await vi.advanceTimersByTimeAsync(1_500); // ping 1 sent
      setDocumentVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      // Advance 31s while hidden (heartbeat skips while document is hidden).
      await vi.advanceTimersByTimeAsync(31_000);
      setDocumentVisibility('visible');
      clientBg31s.resumeConnection(false); // sends ping 2 while ping 1 never received a pong
      expect(lastWs).toBe(wsBg31s);
      await vi.advanceTimersByTimeAsync(6);
      wsBg31s.emit('message', { data: JSON.stringify({ type: 'pong' }) }); // late untagged pong from ping 1
      expect(latenciesBg31s).toEqual([]);
      await vi.advanceTimersByTimeAsync(14);
      wsBg31s.emit('message', { data: JSON.stringify({ type: 'pong' }) }); // untagged pong from ping 2 drains _unackedPingCount -> 0
      expect(latenciesBg31s).toEqual([]);
      // Next clean heartbeat interval (t = 40_000ms, 7_480ms after t = 32_520ms) recovers untagged RTT sampling.
      await vi.advanceTimersByTimeAsync(7_480);
      await vi.advanceTimersByTimeAsync(24);
      wsBg31s.emit('message', { data: JSON.stringify({ type: 'pong' }) });
      expect(latenciesBg31s).toEqual([24]);
      clientBg31s.disconnect();

      // 4. Inbound non-pong frame clears watchdog: single ping still measures if answered before next ping,
      //    and if superseded by next ping, late untagged pong is ignored.
      const latenciesInbound: number[] = [];
      const clientInbound = new WsClient('http://localhost:8787', 'srv-1');
      clientInbound.onLatency((ms) => latenciesInbound.push(ms));
      clientInbound.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastWs!.emit('open');
      const wsInb = lastWs!;
      await vi.advanceTimersByTimeAsync(1_500); // ping 1 sent
      await vi.advanceTimersByTimeAsync(20);
      wsInb.emit('message', { data: JSON.stringify({ type: 'session_list', sessions: [] }) }); // clears _pongTimer
      await vi.advanceTimersByTimeAsync(8_480); // reaches 10_000ms -> heartbeat sends ping 2
      await vi.advanceTimersByTimeAsync(7);
      wsInb.emit('message', { data: JSON.stringify({ type: 'pong' }) }); // late untagged pong from ping 1
      expect(latenciesInbound).toEqual([]);
      clientInbound.disconnect();

      vi.useRealTimers();
    });

    it('absorbs isolated latency spikes via 1s confirmation ping and promptly emits sustained high latency', async () => {
      vi.useFakeTimers();
      try {
        // 1. Healthy baseline (40ms) -> isolated 4852ms spike held -> 1s reprobe (45ms) emits 45ms cleanly.
        const latencies1: number[] = [];
        const client1 = new WsClient('http://localhost:8787', 'srv-1');
        client1.onLatency((ms) => latencies1.push(ms));
        client1.connect();
        await vi.advanceTimersByTimeAsync(0);
        lastWs!.emit('open');
        const ws1 = lastWs!;

        await vi.advanceTimersByTimeAsync(1_500);
        const ping1 = JSON.parse(String(ws1.send.mock.calls.at(-1)?.[0])) as { type: string; id: number };
        await vi.advanceTimersByTimeAsync(40);
        ws1.emit('message', { data: JSON.stringify({ type: 'pong', id: ping1.id }) });
        expect(latencies1).toEqual([40]);

        // Next heartbeat at t = 10_000ms receives an isolated 4852ms stall
        await vi.advanceTimersByTimeAsync(8_460);
        const ping2 = JSON.parse(String(ws1.send.mock.calls.at(-1)?.[0])) as { type: string; id: number };
        await vi.advanceTimersByTimeAsync(4_852);
        ws1.emit('message', { data: JSON.stringify({ type: 'pong', id: ping2.id }) });
        // Spike is NOT emitted and prior healthy baseline remains
        expect(latencies1).toEqual([40]);
        expect(client1.pingLatency).toBe(40);

        // 1s later a confirmation ping fires; returning 45ms absorbs the transient spike
        await vi.advanceTimersByTimeAsync(1_000);
        const reprobePing = JSON.parse(String(ws1.send.mock.calls.at(-1)?.[0])) as { type: string; id: number };
        expect(reprobePing.type).toBe('ping');
        expect(reprobePing.id).not.toBe(ping2.id);
        await vi.advanceTimersByTimeAsync(45);
        ws1.emit('message', { data: JSON.stringify({ type: 'pong', id: reprobePing.id }) });
        expect(latencies1).toEqual([40, 45]);
        expect(client1.pingLatency).toBe(45);
        client1.disconnect();

        // 2. Sustained high latency: 2500ms spike -> 1s confirmation 2100ms emits 2100ms;
        //    subsequent 2400ms (< 3x) emits immediately without extra reprobe; recovery to 50ms emits immediately.
        const latencies2: number[] = [];
        const client2 = new WsClient('http://localhost:8787', 'srv-1');
        client2.onLatency((ms) => latencies2.push(ms));
        client2.connect();
        await vi.advanceTimersByTimeAsync(0);
        lastWs!.emit('open');
        const ws2 = lastWs!;

        await vi.advanceTimersByTimeAsync(1_500);
        const p2Init = JSON.parse(String(ws2.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(40);
        ws2.emit('message', { data: JSON.stringify({ type: 'pong', id: p2Init.id }) });
        expect(latencies2).toEqual([40]);

        await vi.advanceTimersByTimeAsync(8_460); // t = 10_000
        const p2Spike = JSON.parse(String(ws2.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(2_500);
        ws2.emit('message', { data: JSON.stringify({ type: 'pong', id: p2Spike.id }) });
        expect(latencies2).toEqual([40]);

        await vi.advanceTimersByTimeAsync(1_000);
        const p2Confirm = JSON.parse(String(ws2.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(2_100);
        ws2.emit('message', { data: JSON.stringify({ type: 'pong', id: p2Confirm.id }) });
        expect(latencies2).toEqual([40, 2100]);

        // Next regular heartbeat at t = 20_000ms (4_400ms later) emits 2400ms directly (no reprobe loop)
        await vi.advanceTimersByTimeAsync(4_400);
        const p2Next = JSON.parse(String(ws2.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(2_400);
        ws2.emit('message', { data: JSON.stringify({ type: 'pong', id: p2Next.id }) });
        expect(latencies2).toEqual([40, 2100, 2400]);

        // Recovery at t = 30_000ms (7_600ms later) emits 50ms immediately
        await vi.advanceTimersByTimeAsync(7_600);
        const p2Recover = JSON.parse(String(ws2.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(50);
        ws2.emit('message', { data: JSON.stringify({ type: 'pong', id: p2Recover.id }) });
        expect(latencies2).toEqual([40, 2100, 2400, 50]);
        client2.disconnect();

        // 3. Initial/resume ping with pingLatency === null holds 4852ms spike and emits 38ms on confirmation.
        const latencies3: number[] = [];
        const client3 = new WsClient('http://localhost:8787', 'srv-1');
        client3.onLatency((ms) => latencies3.push(ms));
        client3.connect();
        await vi.advanceTimersByTimeAsync(0);
        lastWs!.emit('open');
        const ws3 = lastWs!;

        await vi.advanceTimersByTimeAsync(1_500);
        const p3Init = JSON.parse(String(ws3.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(4_852);
        ws3.emit('message', { data: JSON.stringify({ type: 'pong', id: p3Init.id }) });
        expect(latencies3).toEqual([]);
        expect(client3.pingLatency).toBeNull();

        await vi.advanceTimersByTimeAsync(1_000);
        const p3Confirm = JSON.parse(String(ws3.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(38);
        ws3.emit('message', { data: JSON.stringify({ type: 'pong', id: p3Confirm.id }) });
        expect(latencies3).toEqual([38]);
        client3.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    it('clears pending ping sample and spike reprobe on notifyBackgrounded, pagehide, and freeze', async () => {
      vi.useFakeTimers();
      try {
        for (const trigger of ['notifyBackgrounded', 'pagehide', 'freeze'] as const) {
          const latencies: number[] = [];
          const client = new WsClient('http://localhost:8787', 'srv-1');
          client.onLatency((ms) => latencies.push(ms));
          client.connect();
          await vi.advanceTimersByTimeAsync(0);
          lastWs!.emit('open');
          const socket = lastWs!;

          // First ping stalls 1200ms (arms _spikeReprobeTimer)
          await vi.advanceTimersByTimeAsync(1_500);
          const spikePing = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0])) as { id: number };
          await vi.advanceTimersByTimeAsync(1_200);
          socket.emit('message', { data: JSON.stringify({ type: 'pong', id: spikePing.id }) });
          expect(latencies).toEqual([]);

          const pingsBeforeBg = socket.send.mock.calls
            .map(([raw]) => JSON.parse(String(raw)) as { type: string })
            .filter((m) => m.type === 'ping').length;

          if (trigger === 'notifyBackgrounded') {
            client.notifyBackgrounded();
          } else if (trigger === 'pagehide') {
            window.dispatchEvent(new Event('pagehide'));
          } else {
            document.dispatchEvent(new Event('freeze'));
          }

          // Spike reprobe timer and heartbeat remain paused while native-backgrounded / frozen / pagehidden
          await vi.advanceTimersByTimeAsync(10_000);
          const pingsAfterBg = socket.send.mock.calls
            .map(([raw]) => JSON.parse(String(raw)) as { type: string })
            .filter((m) => m.type === 'ping').length;
          expect(pingsAfterBg).toBe(pingsBeforeBg);

          // Returning to foreground via explicit native/page recovery + resumeConnection() yields clean RTT
          if (trigger === 'notifyBackgrounded') {
            client.notifyForegrounded();
          } else if (trigger === 'pagehide') {
            window.dispatchEvent(new Event('pageshow'));
          } else {
            window.dispatchEvent(new Event('focus'));
          }
          client.resumeConnection();
          const fgPing = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0])) as { id: number };
          await vi.advanceTimersByTimeAsync(22);
          socket.emit('message', { data: JSON.stringify({ type: 'pong', id: fgPing.id }) });
          expect(latencies).toEqual([22]);
          expect(lastWs).toBe(socket);

          // Also verify in-flight ping before background/pagehide/freeze discards delayed post-pause pong
          const pInFlight = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0])) as { id: number };
          const countBeforePause = socket.send.mock.calls.length;
          expect(countBeforePause).toBeGreaterThan(0);
          client.disconnect();

          const latenciesInFlight: number[] = [];
          const c2 = new WsClient('http://localhost:8787', 'srv-1');
          c2.onLatency((ms) => latenciesInFlight.push(ms));
          c2.connect();
          await vi.advanceTimersByTimeAsync(0);
          lastWs!.emit('open');
          const sock2 = lastWs!;
          await vi.advanceTimersByTimeAsync(1_500);
          const pingBeforePause = JSON.parse(String(sock2.send.mock.calls.at(-1)?.[0])) as { id: number };
          if (trigger === 'notifyBackgrounded') {
            c2.notifyBackgrounded();
          } else if (trigger === 'pagehide') {
            window.dispatchEvent(new Event('pagehide'));
          } else {
            document.dispatchEvent(new Event('freeze'));
          }
          await vi.advanceTimersByTimeAsync(4_852);
          sock2.emit('message', { data: JSON.stringify({ type: 'pong', id: pingBeforePause.id }) });
          expect(latenciesInFlight).toEqual([]);
          expect(pInFlight.id).toBeGreaterThan(0);
          c2.disconnect();
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('cancels in-flight resume probe watchdogs across visibility hidden and native backgrounded states without sending background retries or recording suspended RTT', async () => {
      vi.useFakeTimers();
      try {
        for (const mode of ['visibility_hidden', 'native_backgrounded_visible_dom'] as const) {
          const latencies: number[] = [];
          const client = new WsClient('http://localhost:8787', 'srv-1');
          client.onLatency((ms) => latencies.push(ms));
          client.connect();
          await vi.advanceTimersByTimeAsync(0);
          lastWs!.emit('open');
          const socket = lastWs!;

          // Establish a >=400ms baseline (confirmed after 1s reprobe) so an uncancelled
          // background probe retry would bypass the spike gate if its delayed pong were still sampled.
          await vi.advanceTimersByTimeAsync(1_500);
          const baselinePing = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0])) as { id: number };
          await vi.advanceTimersByTimeAsync(450);
          socket.emit('message', { data: JSON.stringify({ type: 'pong', id: baselinePing.id }) });
          expect(latencies).toEqual([]);
          await vi.advanceTimersByTimeAsync(1_000);
          const baselineConfirm = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0])) as { id: number };
          await vi.advanceTimersByTimeAsync(450);
          socket.emit('message', { data: JSON.stringify({ type: 'pong', id: baselineConfirm.id }) });
          expect(latencies).toEqual([450]);

          // Advance past PROBE_FRESHNESS_MS (5s) + start probeConnection() so _resumeProbeTimer is armed
          await vi.advanceTimersByTimeAsync(6_000);
          client.probeConnection();
          const probePing = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0])) as { id: number };
          expect(probePing.id).toBeGreaterThan(baselineConfirm.id);

          const pingsAtPause = socket.send.mock.calls
            .map(([raw]) => JSON.parse(String(raw)) as { type: string })
            .filter((m) => m.type === 'ping').length;

          if (mode === 'visibility_hidden') {
            setDocumentVisibility('hidden');
            document.dispatchEvent(new Event('visibilitychange'));
          } else {
            // Native iOS appStateChange({ isActive: false }) keeps DOM visible
            setDocumentVisibility('visible');
            client.notifyBackgrounded();
          }

          // Advance across multiple RESUME_PROBE_TIMEOUT_MS (5s) & HEARTBEAT_MS (10s) windows:
          // zero retries, zero heartbeats, and no false reconnect.
          await vi.advanceTimersByTimeAsync(25_000);
          const pingsDuringPause = socket.send.mock.calls
            .map(([raw]) => JSON.parse(String(raw)) as { type: string })
            .filter((m) => m.type === 'ping').length;
          expect(pingsDuringPause).toBe(pingsAtPause);
          expect(lastWs).toBe(socket);

          // Delayed pong arriving while still paused must NOT record suspended RTT
          socket.emit('message', { data: JSON.stringify({ type: 'pong', id: probePing.id }) });
          expect(latencies).toEqual([450]);

          // Foreground return unlocks heartbeat sampling on next 10s interval (t = 40_000, 5_600ms after t = 34_400)
          setDocumentVisibility('visible');
          if (mode === 'native_backgrounded_visible_dom') {
            client.notifyForegrounded();
          }
          client.resumeConnection(false);
          await vi.advanceTimersByTimeAsync(5_600);
          const nextPing = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0])) as { id: number };
          expect(nextPing.id).toBeGreaterThan(probePing.id);
          await vi.advanceTimersByTimeAsync(31);
          socket.emit('message', { data: JSON.stringify({ type: 'pong', id: nextPing.id }) });
          expect(latencies).toEqual([450, 31]);
          client.disconnect();

          // Also verify foreground resume BEFORE delayed pre-pause pong sends a fresh resume probe
          // immediately and ignores the late pre-pause pong.
          const latenciesResume = [] as number[];
          const clientResume = new WsClient('http://localhost:8787', 'srv-1');
          clientResume.onLatency((ms) => latenciesResume.push(ms));
          clientResume.connect();
          await vi.advanceTimersByTimeAsync(0);
          lastWs!.emit('open');
          const sockResume = lastWs!;
          await vi.advanceTimersByTimeAsync(1_500);
          const bPing = JSON.parse(String(sockResume.send.mock.calls.at(-1)?.[0])) as { id: number };
          await vi.advanceTimersByTimeAsync(450);
          sockResume.emit('message', { data: JSON.stringify({ type: 'pong', id: bPing.id }) });
          await vi.advanceTimersByTimeAsync(1_000);
          const bConfirm = JSON.parse(String(sockResume.send.mock.calls.at(-1)?.[0])) as { id: number };
          await vi.advanceTimersByTimeAsync(450);
          sockResume.emit('message', { data: JSON.stringify({ type: 'pong', id: bConfirm.id }) });
          await vi.advanceTimersByTimeAsync(6_000);
          clientResume.probeConnection();
          const staleProbePing = JSON.parse(String(sockResume.send.mock.calls.at(-1)?.[0])) as { id: number };
          if (mode === 'visibility_hidden') {
            setDocumentVisibility('hidden');
            document.dispatchEvent(new Event('visibilitychange'));
          } else {
            clientResume.notifyBackgrounded();
          }
          await vi.advanceTimersByTimeAsync(25_000);
          setDocumentVisibility('visible');
          if (mode === 'native_backgrounded_visible_dom') {
            clientResume.notifyForegrounded();
          }
          clientResume.resumeConnection(false);
          const fgResumePing = JSON.parse(String(sockResume.send.mock.calls.at(-1)?.[0])) as { id: number };
          expect(fgResumePing.id).toBeGreaterThan(staleProbePing.id);
          await vi.advanceTimersByTimeAsync(5);
          sockResume.emit('message', { data: JSON.stringify({ type: 'pong', id: staleProbePing.id }) });
          expect(latenciesResume).toEqual([450]);
          await vi.advanceTimersByTimeAsync(26);
          sockResume.emit('message', { data: JSON.stringify({ type: 'pong', id: fgResumePing.id }) });
          expect(latenciesResume).toEqual([450, 31]);
          clientResume.disconnect();
        }
      } finally {
        setDocumentVisibility('visible');
        vi.useRealTimers();
      }
    });

    it('emits onPongLiveness on correlated pongs even when an isolated RTT spike suppresses onLatency', async () => {
      vi.useFakeTimers();
      try {
        const latencies: number[] = [];
        let pongLivenessCount = 0;
        const client = new WsClient('http://localhost:8787', 'srv-1');
        client.onLatency((ms) => latencies.push(ms));
        client.onPongLiveness(() => { pongLivenessCount += 1; });
        client.connect();
        await vi.advanceTimersByTimeAsync(0);
        lastWs!.emit('open');
        const socket = lastWs!;

        // 1. Healthy baseline
        await vi.advanceTimersByTimeAsync(1_500);
        const p1 = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(32);
        socket.emit('message', { data: JSON.stringify({ type: 'pong', id: p1.id }) });
        expect(latencies).toEqual([32]);
        expect(pongLivenessCount).toBe(1);

        // 2. Transient 4852ms spike suppresses onLatency, but STILL fires onPongLiveness immediately
        await vi.advanceTimersByTimeAsync(8_468); // t = 10_000
        const pSpike = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(4_852);
        socket.emit('message', { data: JSON.stringify({ type: 'pong', id: pSpike.id }) });
        expect(latencies).toEqual([32]);
        expect(pongLivenessCount).toBe(2);

        // 3. Stale/uncorrelated pong id must not spuriously fire onPongLiveness
        socket.emit('message', { data: JSON.stringify({ type: 'pong', id: pSpike.id }) });
        expect(pongLivenessCount).toBe(2);

        // 4. Confirmation reprobe 1s later restores onLatency and fires onPongLiveness again
        await vi.advanceTimersByTimeAsync(1_000);
        const pConfirm = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(28);
        socket.emit('message', { data: JSON.stringify({ type: 'pong', id: pConfirm.id }) });
        expect(latencies).toEqual([32, 28]);
        expect(pongLivenessCount).toBe(3);
        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    it('filters isolated 200-599ms spikes on healthy baselines and initial pings via 1s confirmation', async () => {
      vi.useFakeTimers();
      try {
        // 1. Healthy 40ms baseline absorbs 380ms and 520ms spikes (<600ms) after 1s reprobe.
        const latencies: number[] = [];
        const client = new WsClient('http://localhost:8787', 'srv-1');
        client.onLatency((ms) => latencies.push(ms));
        client.connect();
        await vi.advanceTimersByTimeAsync(0);
        lastWs!.emit('open');
        const ws = lastWs!;

        await vi.advanceTimersByTimeAsync(1_500);
        const p1 = JSON.parse(String(ws.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(40);
        ws.emit('message', { data: JSON.stringify({ type: 'pong', id: p1.id }) });
        expect(latencies).toEqual([40]);

        // t = 10_000: 380ms spike -> held
        await vi.advanceTimersByTimeAsync(8_460);
        const pSpike1 = JSON.parse(String(ws.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(380);
        ws.emit('message', { data: JSON.stringify({ type: 'pong', id: pSpike1.id }) });
        expect(latencies).toEqual([40]);
        expect(client.pingLatency).toBe(40);

        // 1s reprobe returns 44ms -> absorbed
        await vi.advanceTimersByTimeAsync(1_000);
        const pConfirm1 = JSON.parse(String(ws.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(44);
        ws.emit('message', { data: JSON.stringify({ type: 'pong', id: pConfirm1.id }) });
        expect(latencies).toEqual([40, 44]);

        // t = 20_000 (8_576ms later): 520ms spike -> held; 1s reprobe returns 43ms -> 3-sample median = 43ms
        await vi.advanceTimersByTimeAsync(8_576);
        const pSpike2 = JSON.parse(String(ws.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(520);
        ws.emit('message', { data: JSON.stringify({ type: 'pong', id: pSpike2.id }) });
        expect(latencies).toEqual([40, 44]);

        await vi.advanceTimersByTimeAsync(1_000);
        const pConfirm2 = JSON.parse(String(ws.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(43);
        ws.emit('message', { data: JSON.stringify({ type: 'pong', id: pConfirm2.id }) });
        expect(latencies).toEqual([40, 44, 43]);
        expect(client.pingLatency).toBe(43);
        client.disconnect();

        // 2. Initial ping with null baseline >= 250ms (320ms) is held and confirmed at 39ms.
        const initLatencies: number[] = [];
        const clientInit = new WsClient('http://localhost:8787', 'srv-1');
        clientInit.onLatency((ms) => initLatencies.push(ms));
        clientInit.connect();
        await vi.advanceTimersByTimeAsync(0);
        lastWs!.emit('open');
        const wsInit = lastWs!;

        await vi.advanceTimersByTimeAsync(1_500);
        const pInit = JSON.parse(String(wsInit.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(320);
        wsInit.emit('message', { data: JSON.stringify({ type: 'pong', id: pInit.id }) });
        expect(initLatencies).toEqual([]);
        expect(clientInit.pingLatency).toBeNull();

        await vi.advanceTimersByTimeAsync(1_000);
        const pInitConfirm = JSON.parse(String(wsInit.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(39);
        wsInit.emit('message', { data: JSON.stringify({ type: 'pong', id: pInitConfirm.id }) });
        expect(initLatencies).toEqual([39]);
        clientInit.disconnect();

        // 3. Near-150ms healthy baseline (145ms < 150ms): 250ms (< 3x baseline) still triggers 1s confirmation,
        //    so 145 -> 250 -> 145 never flashes yellow; full window [143, 144, 145] -> 250 -> 250 confirms at reprobe.
        const near150Transient: number[] = [];
        const cNear1 = new WsClient('http://localhost:8787', 'srv-1');
        cNear1.onLatency((ms) => near150Transient.push(ms));
        cNear1.connect();
        await vi.advanceTimersByTimeAsync(0);
        lastWs!.emit('open');
        const wsNear1 = lastWs!;

        await vi.advanceTimersByTimeAsync(1_500);
        const pN1 = JSON.parse(String(wsNear1.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(145);
        wsNear1.emit('message', { data: JSON.stringify({ type: 'pong', id: pN1.id }) });
        expect(near150Transient).toEqual([145]);

        await vi.advanceTimersByTimeAsync(8_355); // t = 10_000
        const pN1Spike = JSON.parse(String(wsNear1.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(250);
        wsNear1.emit('message', { data: JSON.stringify({ type: 'pong', id: pN1Spike.id }) });
        expect(near150Transient).toEqual([145]);
        expect(cNear1.pingLatency).toBe(145);

        await vi.advanceTimersByTimeAsync(1_000);
        const pN1Confirm = JSON.parse(String(wsNear1.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(145);
        wsNear1.emit('message', { data: JSON.stringify({ type: 'pong', id: pN1Confirm.id }) });
        expect(near150Transient).toEqual([145, 145]);
        cNear1.disconnect();

        // Exact 200ms boundary on healthy 145ms baseline also triggers 1s confirmation (no yellow flash).
        const near200Boundary: number[] = [];
        const cBoundary = new WsClient('http://localhost:8787', 'srv-1');
        cBoundary.onLatency((ms) => near200Boundary.push(ms));
        cBoundary.connect();
        await vi.advanceTimersByTimeAsync(0);
        lastWs!.emit('open');
        const wsBoundary = lastWs!;
        await vi.advanceTimersByTimeAsync(1_500);
        const pB1 = JSON.parse(String(wsBoundary.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(145);
        wsBoundary.emit('message', { data: JSON.stringify({ type: 'pong', id: pB1.id }) });
        await vi.advanceTimersByTimeAsync(8_355);
        const pBSpike = JSON.parse(String(wsBoundary.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(200);
        wsBoundary.emit('message', { data: JSON.stringify({ type: 'pong', id: pBSpike.id }) });
        expect(near200Boundary).toEqual([145]);
        await vi.advanceTimersByTimeAsync(1_000);
        const pBConfirm = JSON.parse(String(wsBoundary.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(145);
        wsBoundary.emit('message', { data: JSON.stringify({ type: 'pong', id: pBConfirm.id }) });
        expect(near200Boundary).toEqual([145, 145]);
        cBoundary.disconnect();

        const near150Sustained: number[] = [];
        const cNear2 = new WsClient('http://localhost:8787', 'srv-1');
        cNear2.onLatency((ms) => near150Sustained.push(ms));
        cNear2.connect();
        await vi.advanceTimersByTimeAsync(0);
        lastWs!.emit('open');
        const wsNear2 = lastWs!;

        await vi.advanceTimersByTimeAsync(1_500);
        const pM1 = JSON.parse(String(wsNear2.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(143);
        wsNear2.emit('message', { data: JSON.stringify({ type: 'pong', id: pM1.id }) });

        await vi.advanceTimersByTimeAsync(8_357); // t = 10_000
        const pM2 = JSON.parse(String(wsNear2.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(144);
        wsNear2.emit('message', { data: JSON.stringify({ type: 'pong', id: pM2.id }) });

        await vi.advanceTimersByTimeAsync(9_856); // t = 20_000
        const pM3 = JSON.parse(String(wsNear2.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(145);
        wsNear2.emit('message', { data: JSON.stringify({ type: 'pong', id: pM3.id }) });
        expect(near150Sustained).toEqual([143, 144, 144]);

        await vi.advanceTimersByTimeAsync(9_855); // t = 30_000
        const pM4Spike = JSON.parse(String(wsNear2.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(250);
        wsNear2.emit('message', { data: JSON.stringify({ type: 'pong', id: pM4Spike.id }) });
        expect(near150Sustained).toEqual([143, 144, 144]);

        await vi.advanceTimersByTimeAsync(1_000);
        const pM4Confirm = JSON.parse(String(wsNear2.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(250);
        wsNear2.emit('message', { data: JSON.stringify({ type: 'pong', id: pM4Confirm.id }) });
        expect(near150Sustained).toEqual([143, 144, 144, 250]);
        cNear2.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    it('promptly reports genuine 300ms sustained latency without reprobe loops and recovers immediately', async () => {
      vi.useFakeTimers();
      try {
        const latencies: number[] = [];
        const client = new WsClient('http://localhost:8787', 'srv-1');
        client.onLatency((ms) => latencies.push(ms));
        client.connect();
        await vi.advanceTimersByTimeAsync(0);
        lastWs!.emit('open');
        const ws = lastWs!;

        // Initial 310ms (>= 250ms) triggers 1s confirmation -> 295ms confirmed and emitted promptly
        await vi.advanceTimersByTimeAsync(1_500);
        const pInit = JSON.parse(String(ws.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(310);
        ws.emit('message', { data: JSON.stringify({ type: 'pong', id: pInit.id }) });
        expect(latencies).toEqual([]);

        await vi.advanceTimersByTimeAsync(1_000);
        const pConfirm = JSON.parse(String(ws.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(295);
        ws.emit('message', { data: JSON.stringify({ type: 'pong', id: pConfirm.id }) });
        expect(latencies).toEqual([295]);

        // Next heartbeat at t = 10_000 (6_895ms later) returns 305ms -> emitted directly (no reprobe loop)
        await vi.advanceTimersByTimeAsync(6_895);
        const pNext = JSON.parse(String(ws.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(305);
        ws.emit('message', { data: JSON.stringify({ type: 'pong', id: pNext.id }) });
        expect(latencies).toEqual([295, 305]);

        // Next heartbeat at t = 20_000 (9_695ms later) returns 290ms -> 3-sample median = 295ms
        await vi.advanceTimersByTimeAsync(9_695);
        const pThird = JSON.parse(String(ws.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(290);
        ws.emit('message', { data: JSON.stringify({ type: 'pong', id: pThird.id }) });
        expect(latencies).toEqual([295, 305, 295]);

        // Recovery at t = 30_000 (9_710ms later) drops to 45ms immediately without median lag
        await vi.advanceTimersByTimeAsync(9_710);
        const pRecover = JSON.parse(String(ws.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(45);
        ws.emit('message', { data: JSON.stringify({ type: 'pong', id: pRecover.id }) });
        expect(latencies).toEqual([295, 305, 295, 45]);
        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    it('smooths single-sample 150-199ms jitter via 3-sample median while reporting consecutive high samples', async () => {
      vi.useFakeTimers();
      try {
        const latencies: number[] = [];
        const client = new WsClient('http://localhost:8787', 'srv-1');
        client.onLatency((ms) => latencies.push(ms));
        client.connect();
        await vi.advanceTimersByTimeAsync(0);
        lastWs!.emit('open');
        const ws = lastWs!;

        await vi.advanceTimersByTimeAsync(1_500);
        const p1 = JSON.parse(String(ws.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(40);
        ws.emit('message', { data: JSON.stringify({ type: 'pong', id: p1.id }) });

        await vi.advanceTimersByTimeAsync(8_460); // t = 10_000
        const p2 = JSON.parse(String(ws.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(45);
        ws.emit('message', { data: JSON.stringify({ type: 'pong', id: p2.id }) });
        expect(latencies).toEqual([40, 45]);

        // Single mild 180ms jitter after [40, 45] -> median [40, 45, 180] = 45ms (stays green)
        await vi.advanceTimersByTimeAsync(9_955); // t = 20_000
        const p3 = JSON.parse(String(ws.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(180);
        ws.emit('message', { data: JSON.stringify({ type: 'pong', id: p3.id }) });
        expect(latencies).toEqual([40, 45, 45]);

        // Consecutive 185ms -> median [45, 180, 185] = 180ms (truthfully yellow)
        await vi.advanceTimersByTimeAsync(9_820); // t = 30_000
        const p4 = JSON.parse(String(ws.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(185);
        ws.emit('message', { data: JSON.stringify({ type: 'pong', id: p4.id }) });
        expect(latencies).toEqual([40, 45, 45, 180]);
        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    it('confirms congestion-contaminated pings during outbound bufferedAmount or timeline backlog drain and resets smoothing on reconnect', async () => {
      vi.useFakeTimers();
      try {
        // 1. Outbound bufferedAmount > 4096 causes 210ms on 80ms baseline (< 3x multiplier) to hold for 1s reprobe.
        const latenciesOut: number[] = [];
        const cOut = new WsClient('http://localhost:8787', 'srv-1');
        cOut.onLatency((ms) => latenciesOut.push(ms));
        cOut.connect();
        await vi.advanceTimersByTimeAsync(0);
        lastWs!.emit('open');
        const wsOut = lastWs!;

        await vi.advanceTimersByTimeAsync(1_500);
        const p1 = JSON.parse(String(wsOut.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(80);
        wsOut.emit('message', { data: JSON.stringify({ type: 'pong', id: p1.id }) });
        expect(latenciesOut).toEqual([80]);

        await vi.advanceTimersByTimeAsync(8_419); // t = 9_999 (set backlog before t = 10_000 heartbeat)
        (wsOut as unknown as { bufferedAmount?: number }).bufferedAmount = 8_192;
        await vi.advanceTimersByTimeAsync(1); // t = 10_000 heartbeat fires while bufferedAmount > 4096
        const pCongestedOut = JSON.parse(String(wsOut.send.mock.calls.at(-1)?.[0])) as { id: number };
        // At t = 10_000 ping was sent with bufferedAmount=8192; even if socket drains before pong, _pingSampleCongested remains set.
        (wsOut as unknown as { bufferedAmount?: number }).bufferedAmount = 0;
        await vi.advanceTimersByTimeAsync(210);
        wsOut.emit('message', { data: JSON.stringify({ type: 'pong', id: pCongestedOut.id }) });
        expect(latenciesOut).toEqual([80]);

        await vi.advanceTimersByTimeAsync(1_000);
        const pOutConfirm = JSON.parse(String(wsOut.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(78);
        wsOut.emit('message', { data: JSON.stringify({ type: 'pong', id: pOutConfirm.id }) });
        expect(latenciesOut).toEqual([80, 78]);

        // Also prove congestion gating on an elevated (>= 150ms) baseline: 160ms -> 350ms (< 600ms)
        // emits directly when uncongested, but is held for 1s confirmation when bufferedAmount > 4096.
        const latenciesElevated: number[] = [];
        const cElev = new WsClient('http://localhost:8787', 'srv-1');
        cElev.onLatency((ms) => latenciesElevated.push(ms));
        cElev.connect();
        await vi.advanceTimersByTimeAsync(0);
        lastWs!.emit('open');
        const wsElev = lastWs!;
        await vi.advanceTimersByTimeAsync(1_500);
        const pE1 = JSON.parse(String(wsElev.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(160);
        wsElev.emit('message', { data: JSON.stringify({ type: 'pong', id: pE1.id }) });
        expect(latenciesElevated).toEqual([160]);

        await vi.advanceTimersByTimeAsync(8_339); // t = 9_999
        (wsElev as unknown as { bufferedAmount?: number }).bufferedAmount = 8_192;
        await vi.advanceTimersByTimeAsync(1); // t = 10_000 heartbeat fires with backlog
        const pECong = JSON.parse(String(wsElev.send.mock.calls.at(-1)?.[0])) as { id: number };
        (wsElev as unknown as { bufferedAmount?: number }).bufferedAmount = 0;
        await vi.advanceTimersByTimeAsync(350);
        wsElev.emit('message', { data: JSON.stringify({ type: 'pong', id: pECong.id }) });
        expect(latenciesElevated).toEqual([160]);

        await vi.advanceTimersByTimeAsync(1_000);
        const pEConfirm = JSON.parse(String(wsElev.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(162);
        wsElev.emit('message', { data: JSON.stringify({ type: 'pong', id: pEConfirm.id }) });
        expect(latenciesElevated).toEqual([160, 162]);
        cElev.disconnect();
        cOut.disconnect();

        // 2. Inbound deferTimelineEvent burst while ping is in flight sets _pingSampleCongested -> confirms 220ms on 85ms baseline.
        const latenciesIn: number[] = [];
        const cIn = new WsClient('http://localhost:8787', 'srv-1');
        cIn.onLatency((ms) => latenciesIn.push(ms));
        cIn.connect();
        await vi.advanceTimersByTimeAsync(0);
        lastWs!.emit('open');
        const wsIn = lastWs!;

        await vi.advanceTimersByTimeAsync(1_500);
        const pIn1 = JSON.parse(String(wsIn.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(85);
        wsIn.emit('message', { data: JSON.stringify({ type: 'pong', id: pIn1.id }) });
        expect(latenciesIn).toEqual([85]);

        await vi.advanceTimersByTimeAsync(8_415); // t = 10_000
        const pInCong = JSON.parse(String(wsIn.send.mock.calls.at(-1)?.[0])) as { id: number };
        // Two timeline.event frames in the same tick defer the second event via deferTimelineEvent()
        wsIn.emit('message', {
          data: JSON.stringify({
            type: TIMELINE_MESSAGES.EVENT,
            event: { sessionId: 's1', eventId: 'ev-1', seq: 1, epoch: 1, type: 'assistant.text', payload: { text: 'a' } },
          }),
        });
        wsIn.emit('message', {
          data: JSON.stringify({
            type: TIMELINE_MESSAGES.EVENT,
            event: { sessionId: 's1', eventId: 'ev-2', seq: 2, epoch: 1, type: 'assistant.text', payload: { text: 'b' } },
          }),
        });
        await vi.advanceTimersByTimeAsync(220);
        wsIn.emit('message', { data: JSON.stringify({ type: 'pong', id: pInCong.id }) });
        expect(latenciesIn).toEqual([85]);

        await vi.advanceTimersByTimeAsync(1_000);
        const pInConfirm = JSON.parse(String(wsIn.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(84);
        wsIn.emit('message', { data: JSON.stringify({ type: 'pong', id: pInConfirm.id }) });
        expect(latenciesIn).toEqual([85, 84]);

        // 3. Socket close & reconnect clears _recentLatencySamples so first sample on new socket (50ms) emits 50ms, not stale median.
        wsIn.emit('close', { code: 1006, reason: 'drop' });
        await vi.advanceTimersByTimeAsync(2_000);
        const wsReconnected = lastWs!;
        expect(wsReconnected).not.toBe(wsIn);
        wsReconnected.emit('open');
        await vi.advanceTimersByTimeAsync(1_500);
        const pReconn = JSON.parse(String(wsReconnected.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(50);
        wsReconnected.emit('message', { data: JSON.stringify({ type: 'pong', id: pReconn.id }) });
        expect(latenciesIn).toEqual([85, 84, 50]);
        cIn.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps native inactive and browser page-suspended pauses intact across pending open, socket reconnect, and non-activating resumeConnection calls', async () => {
      vi.useFakeTimers();
      try {
        setDocumentVisibility('visible');
        const countPings = (sock: MockWebSocket) => sock.send.mock.calls
          .map(([raw]) => JSON.parse(String(raw)) as { type: string })
          .filter((m) => m.type === 'ping').length;

        // 1. Socket connecting (open pending) -> notifyBackgrounded() -> open fires while DOM stays visible:
        //    even after 1.5s initial ping window, 10s heartbeat, focus/pageshow/visibilitychange, and resumeConnection(false),
        //    ZERO pings are sent until notifyForegrounded().
        const latenciesOpenPending: number[] = [];
        const c1 = new WsClient('http://localhost:8787', 'srv-1');
        c1.onLatency((ms) => latenciesOpenPending.push(ms));
        c1.connect();
        await vi.advanceTimersByTimeAsync(0);
        const ws1 = lastWs!;
        c1.notifyBackgrounded();
        ws1.emit('open');

        await vi.advanceTimersByTimeAsync(15_000);
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new Event('pageshow'));
        document.dispatchEvent(new Event('visibilitychange'));
        c1.resumeConnection(false);
        expect(countPings(ws1)).toBe(0);
        expect(latenciesOpenPending).toEqual([]);

        c1.notifyForegrounded();
        c1.resumeConnection(false);
        expect(countPings(ws1)).toBe(1);
        const fgPing1 = JSON.parse(String(ws1.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(24);
        ws1.emit('message', { data: JSON.stringify({ type: 'pong', id: fgPing1.id }) });
        expect(latenciesOpenPending).toEqual([24]);
        c1.disconnect();

        // 2. Backgrounded socket closes and reconnects while native inactive (and receives online->resumeConnection(false)):
        //    clearSocketTimers and new socket open keep _nativeBackgrounded active -> ZERO pings until notifyForegrounded().
        const latenciesReconnect: number[] = [];
        const c2 = new WsClient('http://localhost:8787', 'srv-1');
        c2.onLatency((ms) => latenciesReconnect.push(ms));
        c2.connect();
        await vi.advanceTimersByTimeAsync(0);
        const sockA = lastWs!;
        sockA.emit('open');
        await vi.advanceTimersByTimeAsync(1_500);
        const pA = JSON.parse(String(sockA.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(20);
        sockA.emit('message', { data: JSON.stringify({ type: 'pong', id: pA.id }) });
        expect(latenciesReconnect).toEqual([20]);

        c2.notifyBackgrounded();
        sockA.emit('close', { code: 1006, reason: 'network_drop' });
        await vi.advanceTimersByTimeAsync(2_000);
        const sockB = lastWs!;
        expect(sockB).not.toBe(sockA);
        sockB.emit('open');

        await vi.advanceTimersByTimeAsync(15_000);
        c2.resumeConnection(false); // e.g. online event while still native inactive
        expect(countPings(sockB)).toBe(0);
        expect(latenciesReconnect).toEqual([20]);

        c2.notifyForegrounded();
        c2.resumeConnection(false);
        expect(countPings(sockB)).toBe(1);
        const fgPing2 = JSON.parse(String(sockB.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(19);
        sockB.emit('message', { data: JSON.stringify({ type: 'pong', id: fgPing2.id }) });
        expect(latenciesReconnect).toEqual([20, 19]);
        c2.disconnect();

        // 3. Browser pagehide while open is pending stays suspended across open and resumeConnection(false),
        //    then resumes cleanly once pageshow fires with visible DOM.
        const latenciesPageSuspend: number[] = [];
        const c3 = new WsClient('http://localhost:8787', 'srv-1');
        c3.onLatency((ms) => latenciesPageSuspend.push(ms));
        c3.connect();
        await vi.advanceTimersByTimeAsync(0);
        const sock3 = lastWs!;
        window.dispatchEvent(new Event('pagehide'));
        sock3.emit('open');

        await vi.advanceTimersByTimeAsync(15_000);
        c3.resumeConnection(false);
        expect(countPings(sock3)).toBe(0);

        window.dispatchEvent(new Event('pageshow'));
        c3.resumeConnection(false);
        expect(countPings(sock3)).toBe(1);
        const fgPing3 = JSON.parse(String(sock3.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(18);
        sock3.emit('message', { data: JSON.stringify({ type: 'pong', id: fgPing3.id }) });
        expect(latenciesPageSuspend).toEqual([18]);
        c3.disconnect();

        // 4. open -> pagehide -> socket close -> pageshow + resumeConnection(false) DURING reconnect backoff -> new socket open:
        //    lifecycle listeners remain attached across socket close/backoff so pageshow clears _pageSuspended,
        //    allowing the new foreground socket to emit its initial heartbeat ping and record clean RTT;
        //    meanwhile a native-backgrounded client receiving pageshow during backoff still emits 0 pings until notifyForegrounded().
        const latenciesBackoffResume: number[] = [];
        const c4 = new WsClient('http://localhost:8787', 'srv-1');
        c4.onLatency((ms) => latenciesBackoffResume.push(ms));
        c4.connect();
        await vi.advanceTimersByTimeAsync(0);
        const sock4a = lastWs!;
        sock4a.emit('open');

        window.dispatchEvent(new Event('pagehide'));
        sock4a.emit('close', { code: 1006, reason: 'network_drop' });
        await vi.advanceTimersByTimeAsync(200); // still in reconnect backoff before second socket opens

        window.dispatchEvent(new Event('pageshow'));
        c4.resumeConnection(false);
        await vi.advanceTimersByTimeAsync(2_000);
        const sock4b = lastWs!;
        expect(sock4b).not.toBe(sock4a);
        sock4b.emit('open');
        await vi.advanceTimersByTimeAsync(1_500);
        expect(countPings(sock4b)).toBe(1);
        const backoffPing = JSON.parse(String(sock4b.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(17);
        sock4b.emit('message', { data: JSON.stringify({ type: 'pong', id: backoffPing.id }) });
        expect(latenciesBackoffResume).toEqual([17]);
        c4.disconnect();

        const latenciesNativeBackoff: number[] = [];
        const c5 = new WsClient('http://localhost:8787', 'srv-1');
        c5.onLatency((ms) => latenciesNativeBackoff.push(ms));
        c5.connect();
        await vi.advanceTimersByTimeAsync(0);
        const sock5a = lastWs!;
        sock5a.emit('open');
        c5.notifyBackgrounded();
        sock5a.emit('close', { code: 1006, reason: 'network_drop' });
        await vi.advanceTimersByTimeAsync(200);
        window.dispatchEvent(new Event('pageshow'));
        window.dispatchEvent(new Event('focus'));
        c5.resumeConnection(false);
        await vi.advanceTimersByTimeAsync(2_000);
        const sock5b = lastWs!;
        expect(sock5b).not.toBe(sock5a);
        sock5b.emit('open');
        await vi.advanceTimersByTimeAsync(15_000);
        expect(countPings(sock5b)).toBe(0);

        c5.notifyForegrounded();
        c5.resumeConnection(false);
        expect(countPings(sock5b)).toBe(1);
        const fgPing5 = JSON.parse(String(sock5b.send.mock.calls.at(-1)?.[0])) as { id: number };
        await vi.advanceTimersByTimeAsync(21);
        sock5b.emit('message', { data: JSON.stringify({ type: 'pong', id: fgPing5.id }) });
        expect(latenciesNativeBackoff).toEqual([21]);
        c5.disconnect();
      } finally {
        setDocumentVisibility('visible');
        vi.useRealTimers();
      }
    });
  });

  describe('share ticket coverage snapshot', () => {
    it('emits authoritative viewer role from /api/shares/ws-ticket claims on initial open and reconnect', async () => {
      vi.useFakeTimers();
      try {
        const target = { kind: 'main' as const, serverId: 'srv-1', sessionName: 'deck_shared_brain' };
        let ticketIndex = 0;
        const responses = [
          {
            ticket: 't-init-viewer',
            claims: {
              type: 'share-ws-ticket',
              sub: 'user-2',
              jti: 'jti-1',
              serverId: 'srv-1',
              target,
              snapshot: {
                target,
                effectiveRole: 'viewer',
                historyCutoffAt: 0,
                nextCoverageRecheckAt: null,
                coveringShareIds: ['s-viewer'],
                primaryShareId: 's-viewer',
                authorizedAt: 1000,
              },
              issuedAt: 1000,
              expiresAt: 31_000,
            },
          },
          {
            ticket: 't-reconnect-participant',
            claims: {
              type: 'share-ws-ticket',
              sub: 'user-2',
              jti: 'jti-2',
              serverId: 'srv-1',
              target,
              snapshot: {
                target,
                effectiveRole: 'participant',
                historyCutoffAt: 0,
                nextCoverageRecheckAt: null,
                coveringShareIds: ['s-part'],
                primaryShareId: 's-part',
                authorizedAt: 2000,
              },
              issuedAt: 2000,
              expiresAt: 32_000,
            },
          },
          {
            ticket: 't-reconnect-downgraded-viewer',
            claims: {
              type: 'share-ws-ticket',
              sub: 'user-2',
              jti: 'jti-3',
              serverId: 'srv-1',
              target,
              snapshot: {
                target,
                effectiveRole: 'viewer',
                historyCutoffAt: 0,
                nextCoverageRecheckAt: null,
                coveringShareIds: ['s-viewer'],
                primaryShareId: 's-viewer',
                authorizedAt: 3000,
              },
              issuedAt: 3000,
              expiresAt: 33_000,
            },
          },
        ];
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => ({
            ok: true,
            json: async () => responses[Math.min(ticketIndex++, responses.length - 1)],
          })),
        );

        const client = new WsClient('http://localhost:8787', 'srv-1', { shareTarget: target });
        const roleEvents: Array<{ reason?: string; effectiveRole: string; target: unknown }> = [];
        client.onMessage((msg) => {
          if (msg.type === 'share.role_changed') {
            roleEvents.push({ reason: msg.reason, effectiveRole: msg.effectiveRole, target: msg.target });
          }
        });

        client.connect();
        await vi.advanceTimersByTimeAsync(0);
        const sock1 = lastWs!;
        sock1.emit('open');
        expect(client.getShareCoverageSnapshot()?.effectiveRole).toBe('viewer');
        expect(roleEvents).toHaveLength(1);
        expect(roleEvents[0]).toMatchObject({ reason: 'share-ticket-snapshot', effectiveRole: 'viewer', target });

        // Reconnect #1 gets participant ticket -> open emits participant
        sock1.emit('close', { code: 1006, reason: 'drop-1' });
        await vi.advanceTimersByTimeAsync(2_000);
        const sock2 = lastWs!;
        expect(sock2).not.toBe(sock1);
        sock2.emit('open');
        expect(client.getShareCoverageSnapshot()?.effectiveRole).toBe('participant');
        expect(roleEvents[1]).toMatchObject({ reason: 'share-ticket-snapshot', effectiveRole: 'participant', target });

        // Reconnect #2 during participant->viewer downgrade gets viewer ticket -> emits viewer even without WsBridge share.role_changed
        sock2.emit('close', { code: 1006, reason: 'drop-2' });
        await vi.advanceTimersByTimeAsync(2_000);
        const sock3 = lastWs!;
        expect(sock3).not.toBe(sock2);
        sock3.emit('open');
        expect(client.getShareCoverageSnapshot()?.effectiveRole).toBe('viewer');
        expect(roleEvents[2]).toMatchObject({ reason: 'share-ticket-snapshot', effectiveRole: 'viewer', target });

        client.disconnect();
        expect(client.getShareCoverageSnapshot()).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('ignores mismatched or legacy ws-ticket responses lacking matching claims.snapshot', async () => {
      vi.useFakeTimers();
      try {
        const target = { kind: 'main' as const, serverId: 'srv-1', sessionName: 'deck_shared_brain' };
        let call = 0;
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => ({
            ok: true,
            json: async () => (call++ === 0
              ? { ticket: 't-legacy' }
              : {
                  ticket: 't-mismatch',
                  claims: {
                    type: 'share-ws-ticket',
                    sub: 'user-2',
                    jti: 'jti-x',
                    serverId: 'srv-other',
                    target: { kind: 'main', serverId: 'srv-other', sessionName: 'deck_shared_brain' },
                    snapshot: {
                      target: { kind: 'main', serverId: 'srv-other', sessionName: 'deck_shared_brain' },
                      effectiveRole: 'participant',
                      historyCutoffAt: 0,
                      nextCoverageRecheckAt: null,
                      coveringShareIds: ['s-x'],
                      primaryShareId: 's-x',
                      authorizedAt: 1000,
                    },
                    issuedAt: 1000,
                    expiresAt: 31_000,
                  },
                }),
          })),
        );

        const client = new WsClient('http://localhost:8787', 'srv-1', { shareTarget: target });
        const roleEvents: unknown[] = [];
        client.onMessage((msg) => {
          if (msg.type === 'share.role_changed') roleEvents.push(msg);
        });

        client.connect();
        await vi.advanceTimersByTimeAsync(0);
        lastWs!.emit('open');
        expect(client.getShareCoverageSnapshot()).toBeNull();
        expect(roleEvents).toEqual([]);

        lastWs!.emit('close', { code: 1006, reason: 'drop' });
        await vi.advanceTimersByTimeAsync(2_000);
        lastWs!.emit('open');
        expect(client.getShareCoverageSnapshot()).toBeNull();
        expect(roleEvents).toEqual([]);
        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
