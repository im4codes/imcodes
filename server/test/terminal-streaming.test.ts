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
  closed = false;
  readyState = 1; // WebSocket.OPEN — required by safeSend

  send(data: string | Buffer, _opts?: unknown, callback?: (err?: Error) => void) {
    if (this.closed) {
      const err = new Error('socket closed');
      if (callback) { callback(err); return; }
      throw err;
    }
    this.sent.push(typeof data === 'string' ? data : data.toString('utf8'));
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
