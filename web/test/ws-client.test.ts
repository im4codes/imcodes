import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WsClient } from '../src/ws-client.js';
import { DAEMON_MSG } from '@shared/daemon-events.js';
import { TRANSPORT_MSG } from '@shared/transport-events.js';
import type { MessageHandler } from '../src/ws-client.js';

// Mock WebSocket implementation
class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
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
    });
    expect(() => client.send({ type: 'session.send', sessionName: 's', text: 'lost guard' })).toThrow('WebSocket not connected');
    await vi.advanceTimersByTimeAsync(0);

    const secondWs = lastWs!;
    expect(secondWs).not.toBe(firstWs);
    secondWs.emit('open');

    expect(secondWs.send).toHaveBeenCalledWith(expect.stringContaining('"type":"terminal.subscribe"'));
    expect(secondWs.send).toHaveBeenCalledWith(expect.stringContaining('"type":"chat.subscribe"'));

    // Late close from the stale socket must not tear down the fresh connection.
    firstWs.emit('close');
    expect(client.connected).toBe(true);

    client.disconnect();
    vi.useRealTimers();
  });

  it('foreground probe blocks sends until pong confirms the socket', async () => {
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

    expect(client.connected).toBe(false);
    expect(handler).toHaveBeenCalledWith({
      type: 'session.event',
      event: 'disconnected',
      session: '',
      state: 'disconnected',
    });
    expect(JSON.parse(socket.send.mock.calls[0][0] as string)).toEqual({ type: 'ping' });
    expect(() => client.send({ type: 'session.send', sessionName: 's', text: 'guarded' })).toThrow('WebSocket not connected');

    socket.emit('message', { data: JSON.stringify({ type: 'pong' }) });
    expect(client.connected).toBe(true);
    expect(handler).toHaveBeenCalledWith({
      type: 'session.event',
      event: 'connected',
      session: '',
      state: 'connected',
    });

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

  it('send() throws when not connected', () => {
    const client = new WsClient('http://localhost:8787', 'srv-1');
    expect(() => client.send({ type: 'ping' })).toThrow('WebSocket not connected');
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

      // Initial ping fires on open; assert we sent one.
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
      const client = await connectClient();
      lastWs!.send.mockClear();

      client.subscribeTerminal('chat-session', false);
      client.subscribeTerminal('terminal-session', true);

      expect(lastWs!.send).toHaveBeenCalledTimes(2);
      expect(JSON.parse(lastWs!.send.mock.calls[0][0] as string)).toEqual({
        type: 'terminal.subscribe',
        session: 'chat-session',
        raw: false,
      });
      expect(JSON.parse(lastWs!.send.mock.calls[1][0] as string)).toEqual({
        type: 'terminal.subscribe',
        session: 'terminal-session',
        raw: true,
      });
      client.disconnect();
    });

    it('keeps raw mode while a raw hold is active despite passive resubscribe', async () => {
      const client = await connectClient();
      lastWs!.send.mockClear();

      client.subscribeTerminal('shell-card', false);
      expect(JSON.parse(lastWs!.send.mock.calls.at(-1)?.[0] as string)).toEqual({
        type: 'terminal.subscribe',
        session: 'shell-card',
        raw: false,
      });

      const release = client.holdTerminalRaw('shell-card');
      expect(JSON.parse(lastWs!.send.mock.calls.at(-1)?.[0] as string)).toEqual({
        type: 'terminal.subscribe',
        session: 'shell-card',
        raw: true,
      });

      client.subscribeTerminal('shell-card', false);
      expect(JSON.parse(lastWs!.send.mock.calls.at(-1)?.[0] as string)).toEqual({
        type: 'terminal.subscribe',
        session: 'shell-card',
        raw: true,
      });

      release();
      expect(JSON.parse(lastWs!.send.mock.calls.at(-1)?.[0] as string)).toEqual({
        type: 'terminal.subscribe',
        session: 'shell-card',
        raw: false,
      });

      client.disconnect();
    });

    it('replays remembered terminal subscriptions immediately after reconnect', async () => {
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

      expect(secondWs.send).toHaveBeenCalledTimes(3);
      expect(JSON.parse(secondWs.send.mock.calls[0][0] as string)).toEqual({ type: 'ping' });
      expect(JSON.parse(secondWs.send.mock.calls[1][0] as string)).toEqual({
        type: 'terminal.subscribe',
        session: 'chat-session',
        raw: false,
      });
      expect(JSON.parse(secondWs.send.mock.calls[2][0] as string)).toEqual({
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
      });

      firstWs.send.mockClear();
      firstWs.emit('close');
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(0);
      const secondWs = lastWs!;
      secondWs.emit('open');

      expect(secondWs.send).toHaveBeenCalledWith(expect.stringContaining('"chat.subscribe"'));
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
      const client = await connectClient();
      const requestId = client.fsListDir('/home/user/projects');
      expect(lastWs!.send).toHaveBeenCalled();
      const msg = JSON.parse(lastWs!.send.mock.calls.at(-1)[0]);
      expect(msg.type).toBe('fs.ls');
      expect(msg.path).toBe('/home/user/projects');
      expect(msg.requestId).toBe(requestId);
      expect(msg.includeFiles).toBe(false);
      client.disconnect();
    });

    it('sets includeFiles=true when requested', async () => {
      const client = await connectClient();
      client.fsListDir('/home/user', true);
      const msg = JSON.parse(lastWs!.send.mock.calls.at(-1)[0]);
      expect(msg.includeFiles).toBe(true);
      client.disconnect();
    });

    it('returns a unique UUID as requestId', async () => {
      const client = await connectClient();
      const id1 = client.fsListDir('/home/user/a');
      const id2 = client.fsListDir('/home/user/b');
      expect(id1).not.toBe(id2);
      expect(typeof id1).toBe('string');
      client.disconnect();
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
});
