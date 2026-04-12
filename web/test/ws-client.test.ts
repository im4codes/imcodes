import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WsClient } from '../src/ws-client.js';
import { DAEMON_MSG } from '@shared/daemon-events.js';
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

  it('send() throws when not connected', () => {
    const client = new WsClient('http://localhost:8787', 'srv-1');
    expect(() => client.send({ type: 'ping' })).toThrow('WebSocket not connected');
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

    it('retries terminal.stream_reset with raw=true', async () => {
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

        await vi.advanceTimersByTimeAsync(1000);
        expect(lastWs!.send).toHaveBeenCalled();
        expect(JSON.parse(lastWs!.send.mock.calls.at(-1)[0] as string)).toEqual({
          type: 'terminal.subscribe',
          session: 'stream-session',
          raw: true,
        });
      } finally {
        client.disconnect();
        vi.useRealTimers();
      }
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
