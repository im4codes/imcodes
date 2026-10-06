/**
 * Integration test: terminal streaming
 * daemon connect → browser subscribe → daemon sends update → browser receives diff
 *
 * Tests end-to-end relay through WsBridge using mock WebSockets.
 * No real network or PostgreSQL required.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { WsBridge } from '../src/ws/bridge.js';

// ── Mock WebSocket ─────────────────────────────────────────────────────────────

class MockWs extends EventEmitter {
  sent: string[] = [];
  sentBinary: Buffer[] = [];
  closed = false;
  readyState = 1; // WebSocket.OPEN — required by safeSend

  send(data: string | Buffer, _opts?: unknown, callback?: (err?: Error) => void) {
    if (this.closed) {
      const err = new Error('socket closed');
      if (callback) { callback(err); return; }
      throw err;
    }
    if (typeof data === 'string') this.sent.push(data);
    else this.sentBinary.push(Buffer.from(data));
    callback?.();
  }

  close(code?: number, reason?: string) {
    this.closed = true;
    this.readyState = 3; // WebSocket.CLOSED
    this.emit('close', code, reason);
  }
}

// ── Mock DB ────────────────────────────────────────────────────────────────────

function makeDb() {
  return {
    queryOne: async () => ({ token_hash: 'valid-hash', user_id: 'user-1' }),
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    close: () => {},
  } as unknown as import('../src/db/client.js').Database;
}

vi.mock('../src/security/crypto.js', () => ({
  sha256Hex: (_s: string) => 'valid-hash',
}));

vi.mock('../src/routes/push.js', () => ({
  dispatchPush: vi.fn(),
}));

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => process.nextTick(r));
}

// ── Setup: authenticated bridge with daemon + browser ──────────────────────────

async function setupStreamingBridge() {
  const serverId = `stream-${Math.random().toString(36).slice(2)}`;
  const bridge = WsBridge.get(serverId);

  const daemonWs = new MockWs();
  bridge.handleDaemonConnection(daemonWs as never, makeDb(), {} as never);
  daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'valid-token' }));
  await flush();

  const browserWs = new MockWs();
  bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb());

  return { serverId, bridge, daemonWs, browserWs };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

afterEach(() => {
  WsBridge.getAll().clear();
  vi.clearAllMocks();
});

describe('Terminal streaming integration', () => {
  it('browser receives terminal.diff when daemon sends terminal_update', async () => {
    const { daemonWs, browserWs } = await setupStreamingBridge();

    // Browser must be subscribed to the session (default-deny routing)
    browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'deck_myapp_brain' }));
    await flush();
    browserWs.sent.length = 0; // clear daemon.reconnected / subscribe ack noise

    daemonWs.emit('message', JSON.stringify({
      type: 'terminal_update',
      diff: { sessionName: 'deck_myapp_brain', rows: ['line1', 'line2'], cursor: { x: 0, y: 1 } },
    }));
    await flush();

    expect(browserWs.sent).toHaveLength(1);
    const msg = JSON.parse(browserWs.sent[0]) as { type: string; diff: unknown };
    expect(msg.type).toBe('terminal.diff');
    expect(msg.diff).toBeTruthy();
  });

  it('browser receives session.event when daemon sends session_event', async () => {
    const { daemonWs, browserWs } = await setupStreamingBridge();

    daemonWs.emit('message', JSON.stringify({
      type: 'session_event',
      session: 'deck_myapp_brain',
      event: 'started',
    }));
    await flush();

    expect(browserWs.sent).toHaveLength(1);
    const msg = JSON.parse(browserWs.sent[0]) as { type: string; event: string };
    expect(msg.type).toBe('session.event');
    expect(msg.event).toBe('started');
  });

  it('multiple browser connections all receive session_event broadcast', async () => {
    const { daemonWs, bridge } = await setupStreamingBridge();

    // Add two more browsers
    const browser2 = new MockWs();
    const browser3 = new MockWs();
    bridge.handleBrowserConnection(browser2 as never, 'test-user', makeDb());
    bridge.handleBrowserConnection(browser3 as never, 'test-user', makeDb());

    expect(bridge.browserCount).toBe(3);

    // session_event is a whitelisted broadcast type — all browsers must receive it
    daemonWs.emit('message', JSON.stringify({ type: 'session_event', event: 'started', session: 'sess' }));
    await flush();

    expect(browser2.sent).toHaveLength(1);
    expect(browser3.sent).toHaveLength(1);
  });

  it('browser subscribe message is forwarded to daemon', async () => {
    const { daemonWs, browserWs } = await setupStreamingBridge();

    browserWs.emit('message', JSON.stringify({
      type: 'terminal.subscribe',
      session: 'deck_myapp_brain',
    }));
    await flush(); // terminal.subscribe ownership check is async
    expect(daemonWs.sent.some((s) => s.includes('terminal.subscribe'))).toBe(true);
  });

  it('routes timeline events to passive subscribers for transport-named sessions', async () => {
    const { daemonWs, browserWs } = await setupStreamingBridge();

    browserWs.emit('message', JSON.stringify({
      type: 'terminal.subscribe',
      session: 'deck_transport_brain',
      raw: false,
    }));
    await flush();
    browserWs.sent.length = 0;

    daemonWs.emit('message', JSON.stringify({
      type: 'timeline.event',
      event: {
        eventId: 'evt-transport-1',
        sessionId: 'deck_transport_brain',
        ts: 123,
        type: 'assistant.text',
        payload: { text: 'transport message' },
      },
    }));
    await flush();

    expect(browserWs.sent).toHaveLength(1);
    const msg = JSON.parse(browserWs.sent[0]) as { type: string; event: { sessionId: string; payload: { text: string } } };
    expect(msg.type).toBe('timeline.event');
    expect(msg.event.sessionId).toBe('deck_transport_brain');
    expect(msg.event.payload.text).toBe('transport message');
  });

  it('raw:false subscribe is forwarded upstream and still preserves non-binary terminal delivery', async () => {
    const { daemonWs, browserWs } = await setupStreamingBridge();

    browserWs.emit('message', JSON.stringify({
      type: 'terminal.subscribe',
      session: 'deck_myapp_brain',
      raw: false,
    }));
    await flush();

    const forwarded = daemonWs.sent.find((s) => s.includes('terminal.subscribe') && s.includes('deck_myapp_brain'));
    expect(forwarded).toBeTruthy();
    expect(forwarded).toContain('"raw":false');

    browserWs.sent.length = 0;
    daemonWs.emit('message', JSON.stringify({
      type: 'terminal_update',
      diff: { sessionName: 'deck_myapp_brain', rows: ['chat-safe-line'] },
    }));
    await flush();

    expect(browserWs.sent).toHaveLength(1);
    const msg = JSON.parse(browserWs.sent[0]) as { type: string; diff: unknown };
    expect(msg.type).toBe('terminal.diff');
    expect(msg.diff).toBeTruthy();
  });

  it('relays raw PTY bytes even when the same browser has a summary timeline subscription', async () => {
    const { daemonWs, browserWs } = await setupStreamingBridge();
    const session = 'deck_myapp_brain';

    // Timeline mode is independent from the terminal data plane. This is the
    // normal browser state while a terminal is visible beside a compact chat.
    browserWs.emit('message', JSON.stringify({
      type: 'timeline.subscribe',
      sessionName: session,
      mode: 'summary',
    }));
    browserWs.emit('message', JSON.stringify({
      type: 'terminal.subscribe',
      session,
      raw: true,
    }));
    await flush();
    browserWs.sent.length = 0;
    browserWs.sentBinary.length = 0;

    const sessionBytes = Buffer.from(session, 'utf8');
    const frame = Buffer.concat([
      Buffer.from([1, (sessionBytes.length >>> 8) & 0xff, sessionBytes.length & 0xff]),
      sessionBytes,
      Buffer.from('PTY_RAW_MARKER', 'utf8'),
    ]);
    daemonWs.emit('message', frame, true);
    await flush();

    expect(browserWs.sentBinary).toHaveLength(1);
    expect(browserWs.sentBinary[0].equals(frame)).toBe(true);
  });

  it('daemon reconnect drains queued browser messages', async () => {
    const serverId = `drain-${Math.random().toString(36).slice(2)}`;
    const bridge = WsBridge.get(serverId);

    // Browser connects before daemon
    const browserWs = new MockWs();
    bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb());

    // Browser sends messages — they queue up
    browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess1' }));
    browserWs.emit('message', JSON.stringify({ type: 'get_sessions' }));

    // Daemon connects and authenticates
    const daemonWs = new MockWs();
    bridge.handleDaemonConnection(daemonWs as never, makeDb(), {} as never);
    daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'valid-token' }));
    await flush();

    // Both queued messages should have been delivered
    expect(daemonWs.sent.some((s) => s.includes('terminal.subscribe'))).toBe(true);
    expect(daemonWs.sent.some((s) => s.includes('get_sessions'))).toBe(true);
  });

  it('daemon reconnect does not replay commands buffered longer than the replay window', async () => {
    const serverId = `stale-${Math.random().toString(36).slice(2)}`;
    const bridge = WsBridge.get(serverId);
    const browserWs = new MockWs();
    bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb());

    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow);
    try {
      browserWs.emit('message', JSON.stringify({ type: 'get_sessions' }));
      // Daemon stays unreachable for 11 minutes, then a fresh command arrives.
      nowSpy.mockReturnValue(realNow + 11 * 60 * 1000);
      browserWs.emit('message', JSON.stringify({ type: 'get_sessions', marker: 'fresh' }));

      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb(), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'valid-token' }));
      await flush();

      const replayed = daemonWs.sent.filter((s) => s.includes('get_sessions'));
      expect(replayed).toHaveLength(1);
      expect(replayed[0]).toContain('fresh');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('daemon reconnect sends an inflight session.send once, not again from the raw queue', async () => {
    const serverId = `dupsend-${Math.random().toString(36).slice(2)}`;
    const bridge = WsBridge.get(serverId);
    const browserWs = new MockWs();
    bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb());

    // The browser sent session.send while the daemon was down: it is tracked as
    // an inflight command AND a raw copy sits in the generic queue.
    const raw = JSON.stringify({ type: 'session.send', session: 'deck_x_brain', text: 'hello', commandId: 'cmd-once' });
    (bridge as unknown as { inflightCommands: Map<string, unknown> }).inflightCommands.set('cmd-once', {
      commandId: 'cmd-once',
      sessionName: 'deck_x_brain',
      browser: browserWs,
      rawPayload: raw,
      state: 'buffered',
      sentAt: Date.now(),
      dispatchAttempts: 0,
      timeoutTimer: null,
    });
    bridge.sendToDaemon(raw); // daemon not authenticated yet -> lands in the generic queue

    const daemonWs = new MockWs();
    bridge.handleDaemonConnection(daemonWs as never, makeDb(), {} as never);
    daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'valid-token' }));
    await flush();

    expect(daemonWs.sent.filter((s) => s.includes('cmd-once'))).toHaveLength(1);
  });

  // ── Replay lock ──────────────────────────────────────────────────────────
  // A daemon reconnect must never hand the daemon a command it already accepted.
  async function reconnectDaemon(bridge: WsBridge, serverId: string): Promise<MockWs> {
    const next = new MockWs();
    bridge.handleDaemonConnection(next as never, makeDb(), {} as never);
    next.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'valid-token' }));
    await flush();
    return next;
  }

  it('an acked session.send is not delivered again when the daemon reconnects', async () => {
    const { serverId, bridge, daemonWs, browserWs } = await setupStreamingBridge();
    browserWs.emit('message', JSON.stringify({ type: 'session.send', session: 'deck_x_brain', text: '/model a', commandId: 'cmd-acked' }));
    await flush();
    expect(daemonWs.sent.filter((s) => s.includes('cmd-acked'))).toHaveLength(1);

    daemonWs.emit('message', JSON.stringify({ type: 'command.ack', commandId: 'cmd-acked', session: 'deck_x_brain', status: 'accepted' }));
    await flush();

    daemonWs.close();
    await flush();
    const next = await reconnectDaemon(bridge, serverId);

    expect(next.sent.filter((s) => s.includes('cmd-acked'))).toHaveLength(0);
  });

  it('a session.send whose ack was lost is retried at most once per reconnect and carries the bridge-retry marker', async () => {
    const { serverId, bridge, daemonWs, browserWs } = await setupStreamingBridge();
    browserWs.emit('message', JSON.stringify({ type: 'session.send', session: 'deck_x_brain', text: 'hi', commandId: 'cmd-unacked' }));
    await flush();

    daemonWs.close();
    await flush();
    const next = await reconnectDaemon(bridge, serverId);

    const resent = next.sent.filter((s) => s.includes('cmd-unacked'));
    expect(resent).toHaveLength(1);
    // The daemon relies on this marker to re-ack instead of erroring/duplicating.
    expect(JSON.parse(resent[0]!)).toMatchObject({ commandId: 'cmd-unacked', __bridgeRetry: true });
  });

  it('commands flushed on one reconnect are not flushed again on the next', async () => {
    const serverId = `flushonce-${Math.random().toString(36).slice(2)}`;
    const bridge = WsBridge.get(serverId);
    const browserWs = new MockWs();
    bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb());
    browserWs.emit('message', JSON.stringify({ type: 'get_sessions', marker: 'queued-once' }));

    const first = await reconnectDaemon(bridge, serverId);
    expect(first.sent.filter((s) => s.includes('queued-once'))).toHaveLength(1);

    first.close();
    await flush();
    const second = await reconnectDaemon(bridge, serverId);
    expect(second.sent.filter((s) => s.includes('queued-once'))).toHaveLength(0);
  });

  it('a browser double-sending the same commandId reaches the daemon once', async () => {
    const { daemonWs, browserWs } = await setupStreamingBridge();
    const frame = JSON.stringify({ type: 'session.send', session: 'deck_x_brain', text: 'once', commandId: 'cmd-double' });
    browserWs.emit('message', frame);
    browserWs.emit('message', frame);
    await flush();

    expect(daemonWs.sent.filter((s) => s.includes('cmd-double'))).toHaveLength(1);
  });

  it('daemon reconnect broadcasts daemon.reconnected to browsers', async () => {
    const { serverId, daemonWs, browserWs } = await setupStreamingBridge();

    // Simulate daemon disconnect + reconnect
    daemonWs.close();
    await flush();

    const daemonWs2 = new MockWs();
    const bridge = WsBridge.get(serverId);
    bridge.handleDaemonConnection(daemonWs2 as never, makeDb(), {} as never);
    daemonWs2.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'valid-token' }));
    await flush();

    const reconnectMsg = browserWs.sent.find((s) => s.includes('daemon.reconnected'));
    expect(reconnectMsg).toBeTruthy();
  });
});
