import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { WsBridge } from '../src/ws/bridge.js';

// ── Mock WebSocket ─────────────────────────────────────────────────────────────

class MockWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  closed = false;
  readyState = 1; // WebSocket.OPEN
  closeCode: number | undefined;
  closeReason: string | undefined;

  send(data: string | Buffer, _opts?: unknown, callback?: (err?: Error) => void) {
    if (this.closed) {
      const err = new Error('socket closed');
      if (callback) { callback(err); return; }
      throw err;
    }
    this.sent.push(data);
    callback?.();
  }

  close(code?: number, reason?: string) {
    this.closed = true;
    this.readyState = 3; // WebSocket.CLOSED
    this.closeCode = code;
    this.closeReason = reason;
    this.emit('close');
  }

  /** Sent strings only (excludes binary frames) */
  get sentStrings(): string[] {
    return this.sent.filter((s): s is string => typeof s === 'string');
  }
}

// ── Build v1 binary frame ─────────────────────────────────────────────────────

function packFrame(sessionName: string, payload: Buffer): Buffer {
  const nameBytes = Buffer.from(sessionName, 'utf8');
  const header = Buffer.allocUnsafe(3 + nameBytes.length);
  header[0] = 0x01;
  header.writeUInt16BE(nameBytes.length, 1);
  nameBytes.copy(header, 3);
  return Buffer.concat([header, payload]);
}

// ── Mock DB ────────────────────────────────────────────────────────────────────

function makeDb(tokenHash: string) {
  return {
    queryOne: async () => ({ token_hash: tokenHash }),
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    close: () => {},
  } as unknown as import('../src/db/client.js').Database;
}

// ── Mock crypto + push ─────────────────────────────────────────────────────────

vi.mock('../src/security/crypto.js', () => ({
  sha256Hex: (_s: string) => 'valid-hash',
}));

vi.mock('../src/routes/push.js', () => ({
  dispatchPush: vi.fn(),
}));

// Flush all pending microtasks/promises
async function flushAsync() {
  // Multiple rounds to handle promise chains inside async message handlers
  for (let i = 0; i < 5; i++) await new Promise((r) => process.nextTick(r));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WsBridge', () => {
  let serverId: string;

  beforeEach(() => {
    serverId = `test-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    WsBridge.getAll().clear();
    vi.clearAllMocks();
  });

  describe('daemon auth', () => {
    it('authenticates with valid token', async () => {
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('valid-hash'), {} as never);

      ws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token' }));
      await flushAsync();
      expect(bridge.isAuthenticated).toBe(true);
    });

    it('closes on auth timeout', async () => {
      vi.useFakeTimers();
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('hash') as never, {} as never);

      vi.advanceTimersByTime(5001);
      await flushAsync();
      vi.useRealTimers();
      expect(ws.closed).toBe(true);
      expect(ws.closeCode).toBe(4001);
    });

    it('closes on invalid token', async () => {
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('different-hash'), {} as never);

      ws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'bad-token' }));
      await flushAsync();
      expect(ws.closed).toBe(true);
    });
  });

  describe('message relay daemon→browser', () => {
    async function setupAuthenticatedBridge() {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      return { bridge, daemonWs, browserWs };
    }

    it('translates terminal_update → terminal.diff (with sessionName)', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      // Browser must be subscribed to the session for the routed message to arrive
      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess-tu' }));
      await flushAsync();
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({ type: 'terminal_update', diff: { sessionName: 'sess-tu', a: 1 } }));
      await flushAsync();
      expect(JSON.parse(browserWs.sentStrings[0]).type).toBe('terminal.diff');
    });

    it('translates session_event → session.event', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      daemonWs.emit('message', JSON.stringify({ type: 'session_event', session: 'x' }));
      await flushAsync();
      expect(JSON.parse(browserWs.sent[0]).type).toBe('session.event');
    });

    it('passes through session.idle to subscribed browser', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess-idle' }));
      await flushAsync();
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({ type: 'session.idle', session: 'sess-idle' }));
      await flushAsync();
      expect(JSON.parse(browserWs.sentStrings[0]).type).toBe('session.idle');
    });

    it('removes erroring browser socket on send failure', async () => {
      const { bridge, daemonWs, browserWs } = await setupAuthenticatedBridge();
      browserWs.closed = true; // next send throws
      // Use a broadcast type (session_event) so the closed socket is detected via broadcastToBrowsers
      daemonWs.emit('message', JSON.stringify({ type: 'session_event', event: 'started', session: 'x' }));
      await flushAsync();
      expect(bridge.browserCount).toBe(0);
    });
  });

  describe('browser→daemon whitelist', () => {
    async function setupBridge() {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      return { daemonWs, browserWs };
    }

    it('forwards whitelisted type', async () => {
      const { daemonWs, browserWs } = await setupBridge();
      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'x' }));
      await flushAsync(); // terminal.subscribe ownership check is async
      expect(daemonWs.sentStrings.some((s) => s.includes('terminal.subscribe'))).toBe(true);
    });

    it('forwards any valid message type to daemon (no whitelist)', async () => {
      const { daemonWs, browserWs } = await setupBridge();
      browserWs.emit('message', JSON.stringify({ type: 'admin.shutdown' }));
      expect(daemonWs.sentStrings.some((s) => s.includes('admin.shutdown'))).toBe(true);
    });

    it('drops oversized payload', async () => {
      const { daemonWs, browserWs } = await setupBridge();
      browserWs.emit('message', JSON.stringify({ type: 'session.send', text: 'x'.repeat(70000) }));
      expect(daemonWs.sent).toHaveLength(0);
    });

    it('drops with error after rate limit exceeded', async () => {
      const { daemonWs, browserWs } = await setupBridge();
      for (let i = 0; i < 120; i++) {
        browserWs.emit('message', JSON.stringify({ type: 'get_sessions' }));
      }
      const countBefore = daemonWs.sent.length;
      browserWs.emit('message', JSON.stringify({ type: 'get_sessions' }));
      // Message not forwarded to daemon
      expect(daemonWs.sent.length).toBe(countBefore);
      // Error sent back to browser
      const lastBrowserMsg = JSON.parse(browserWs.sent[browserWs.sent.length - 1] as string);
      expect(lastBrowserMsg.type).toBe('error');
      expect(lastBrowserMsg.code).toBe('rate_limited');
    });
  });

  describe('queue drain on reconnect', () => {
    it('drains queued browser messages when daemon authenticates', async () => {
      const bridge = WsBridge.get(serverId);

      // Browser sends message before daemon connects (goes to queue)
      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      browserWs.emit('message', JSON.stringify({ type: 'get_sessions' }));

      // Daemon connects and authenticates
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      expect(daemonWs.sentStrings.some((s) => s.includes('get_sessions'))).toBe(true);
    });
  });

  // ── Helpers shared by subscription / binary tests ─────────────────────────

  async function setupAuth() {
    const bridge = WsBridge.get(serverId);
    const daemonWs = new MockWs();
    bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
    daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
    await flushAsync();
    return { bridge, daemonWs };
  }

  // ── Multi-browser ref counting ─────────────────────────────────────────────

  describe('per-session daemon subscription ref counting', () => {
    it('sends terminal.subscribe to daemon only on 0→1', async () => {
      const { bridge, daemonWs } = await setupAuth();

      const b1 = new MockWs();
      const b2 = new MockWs();
      bridge.handleBrowserConnection(b1 as never);
      bridge.handleBrowserConnection(b2 as never);

      // First browser subscribes → 0→1, should forward to daemon
      const sentBefore = daemonWs.sentStrings.filter((s) => s.includes('terminal.subscribe')).length;
      b1.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess1' }));
      await flushAsync();
      const afterFirst = daemonWs.sentStrings.filter((s) => s.includes('terminal.subscribe')).length;
      expect(afterFirst).toBe(sentBefore + 1);

      // Second browser subscribes same session → 1→2, must NOT forward again
      b2.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess1' }));
      await flushAsync();
      const afterSecond = daemonWs.sentStrings.filter((s) => s.includes('terminal.subscribe')).length;
      expect(afterSecond).toBe(sentBefore + 1); // no additional forward
    });

    it('sends terminal.unsubscribe to daemon only on 1→0', async () => {
      const { bridge, daemonWs } = await setupAuth();

      const b1 = new MockWs();
      const b2 = new MockWs();
      bridge.handleBrowserConnection(b1 as never);
      bridge.handleBrowserConnection(b2 as never);

      b1.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess2' }));
      b2.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess2' }));
      await flushAsync();

      const unsubBefore = daemonWs.sentStrings.filter((s) => s.includes('terminal.unsubscribe')).length;

      // First unsubscribe → 2→1, must NOT forward
      b1.emit('message', JSON.stringify({ type: 'terminal.unsubscribe', session: 'sess2' }));
      await flushAsync();
      expect(daemonWs.sentStrings.filter((s) => s.includes('terminal.unsubscribe')).length).toBe(unsubBefore);

      // Second unsubscribe → 1→0, must forward
      b2.emit('message', JSON.stringify({ type: 'terminal.unsubscribe', session: 'sess2' }));
      await flushAsync();
      expect(daemonWs.sentStrings.filter((s) => s.includes('terminal.unsubscribe')).length).toBe(unsubBefore + 1);
    });

    it('browser disconnect drives 1→0 and sends terminal.unsubscribe', async () => {
      const { daemonWs } = await setupAuth();
      const bridge = WsBridge.get(serverId);

      const b = new MockWs();
      bridge.handleBrowserConnection(b as never);
      b.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess3' }));
      await flushAsync();

      const unsubBefore = daemonWs.sentStrings.filter((s) => s.includes('terminal.unsubscribe')).length;

      // Simulate browser disconnect
      b.emit('close');
      await flushAsync();

      expect(daemonWs.sentStrings.filter((s) => s.includes('terminal.unsubscribe')).length).toBe(unsubBefore + 1);
    });
  });

  // ── bufferedBytes balance ──────────────────────────────────────────────────

  describe('TerminalForwardQueue bufferedBytes balance', () => {
    it('reclaims bytes after each successful send — no overflow after many frames', async () => {
      const { bridge, daemonWs } = await setupAuth();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess4' }));
      await flushAsync();

      // Send 600 frames × 1 KB each = 600 KB total dispatched.
      // QUEUE_MAX_BYTES = 512 KB. If bufferedBytes weren't reclaimed, this would overflow.
      // Since MockWs invokes the send callback synchronously (success), bytes are reclaimed immediately.
      const payload = Buffer.alloc(1024, 0x41); // 1 KB
      const frame = packFrame('sess4', payload);

      for (let i = 0; i < 600; i++) {
        daemonWs.emit('message', frame, true);
      }
      await flushAsync();

      // No stream_reset should have been sent to the browser
      const resets = browserWs.sentStrings.filter((s) => s.includes('stream_reset'));
      expect(resets).toHaveLength(0);

      // All 600 frames should have been forwarded as binary
      const binaryFrames = browserWs.sent.filter((s) => Buffer.isBuffer(s));
      expect(binaryFrames).toHaveLength(600);
    });
  });

  // ── Daemon reconnect subscription replay ──────────────────────────────────

  describe('daemon reconnect subscription replay', () => {
    it('replays active subscriptions to daemon after reconnect', async () => {
      const bridge = WsBridge.get(serverId);

      const daemonWs1 = new MockWs();
      bridge.handleDaemonConnection(daemonWs1 as never, makeDb('valid-hash'), {} as never);
      daemonWs1.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sessR' }));
      await flushAsync();

      // Daemon disconnects
      daemonWs1.emit('close');
      await flushAsync();

      // New daemon connects and authenticates
      const daemonWs2 = new MockWs();
      bridge.handleDaemonConnection(daemonWs2 as never, makeDb('valid-hash'), {} as never);
      daemonWs2.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      // Bridge should have re-sent terminal.subscribe for sessR to the new daemon
      expect(daemonWs2.sentStrings.some((s) => {
        try { return (JSON.parse(s) as { type: string; session: string }).session === 'sessR'; } catch { return false; }
      })).toBe(true);
    });

    it('does not replay terminal.subscribe from offline queue (prevents duplicates)', async () => {
      const bridge = WsBridge.get(serverId);

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));

      // Browser subscribes while daemon is offline → goes to queue
      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sessD' }));
      await flushAsync();

      // Daemon connects and authenticates
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      // Should send exactly ONE terminal.subscribe (from refs replay, not from queue replay)
      const subscribes = daemonWs.sentStrings.filter((s) => {
        try { return (JSON.parse(s) as { type: string }).type === 'terminal.subscribe'; } catch { return false; }
      });
      expect(subscribes).toHaveLength(1);
    });
  });

  // ── Daemon disconnect notification ─────────────────────────────────────────

  describe('daemon disconnect broadcasts daemon.disconnected to browsers', () => {
    it('sends daemon.disconnected when daemon socket closes', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      browserWs.sent.length = 0;

      // Daemon disconnects
      daemonWs.emit('close');
      await flushAsync();

      const disconnectMsg = browserWs.sentStrings.find((s) => {
        try { return (JSON.parse(s) as { type: string }).type === 'daemon.disconnected'; } catch { return false; }
      });
      expect(disconnectMsg).toBeDefined();
    });

    it('does NOT send daemon.disconnected when a replaced daemon closes', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs1 = new MockWs();
      bridge.handleDaemonConnection(daemonWs1 as never, makeDb('valid-hash'), {} as never);
      daemonWs1.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));

      // New daemon replaces old one (closes daemonWs1)
      const daemonWs2 = new MockWs();
      bridge.handleDaemonConnection(daemonWs2 as never, makeDb('valid-hash'), {} as never);
      browserWs.sent.length = 0;

      // Old daemon's close fires — but bridge.daemonWs is now daemonWs2, so guard prevents broadcast
      daemonWs1.emit('close');
      await flushAsync();

      const disconnectMsg = browserWs.sentStrings.find((s) => {
        try { return (JSON.parse(s) as { type: string }).type === 'daemon.disconnected'; } catch { return false; }
      });
      // The close of the replaced daemon should NOT trigger daemon.disconnected because
      // bridge.daemonWs !== daemonWs1 (it's already daemonWs2)
      expect(disconnectMsg).toBeUndefined();
    });

    it('sends daemon.reconnected after daemon re-authenticates', async () => {
      const bridge = WsBridge.get(serverId);

      const daemonWs1 = new MockWs();
      bridge.handleDaemonConnection(daemonWs1 as never, makeDb('valid-hash'), {} as never);
      daemonWs1.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));

      // Daemon disconnects
      daemonWs1.emit('close');
      await flushAsync();
      browserWs.sent.length = 0;

      // New daemon connects and authenticates
      const daemonWs2 = new MockWs();
      bridge.handleDaemonConnection(daemonWs2 as never, makeDb('valid-hash'), {} as never);
      daemonWs2.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const reconnectMsg = browserWs.sentStrings.find((s) => {
        try { return (JSON.parse(s) as { type: string }).type === 'daemon.reconnected'; } catch { return false; }
      });
      expect(reconnectMsg).toBeDefined();
    });
  });

  // ── Daemon rapid reconnect (flapping) does not crash ────────────────────

  describe('daemon rapid reconnect (flapping) resilience', () => {
    it('survives 10 rapid daemon reconnects without crashing', async () => {
      const bridge = WsBridge.get(serverId);
      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));

      for (let i = 0; i < 10; i++) {
        const dws = new MockWs();
        bridge.handleDaemonConnection(dws as never, makeDb('valid-hash'), {} as never);
        dws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
        await flushAsync();
        dws.emit('close');
        await flushAsync();
      }

      // Bridge is still functional — connect a final daemon and verify it works
      const finalDaemon = new MockWs();
      bridge.handleDaemonConnection(finalDaemon as never, makeDb('valid-hash'), {} as never);
      finalDaemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      expect(bridge.isAuthenticated).toBe(true);
      expect(bridge.browserCount).toBe(1);
    });

    it('browser receives daemon.reconnected after each reconnect cycle', async () => {
      const bridge = WsBridge.get(serverId);
      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));

      let reconnectCount = 0;
      let disconnectCount = 0;

      for (let i = 0; i < 5; i++) {
        browserWs.sent.length = 0;
        const dws = new MockWs();
        bridge.handleDaemonConnection(dws as never, makeDb('valid-hash'), {} as never);
        dws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
        await flushAsync();

        reconnectCount += browserWs.sentStrings.filter((s) => {
          try { return (JSON.parse(s) as { type: string }).type === 'daemon.reconnected'; } catch { return false; }
        }).length;

        browserWs.sent.length = 0;
        dws.emit('close');
        await flushAsync();

        disconnectCount += browserWs.sentStrings.filter((s) => {
          try { return (JSON.parse(s) as { type: string }).type === 'daemon.disconnected'; } catch { return false; }
        }).length;
      }

      expect(reconnectCount).toBe(5);
      expect(disconnectCount).toBe(5);
    });

    it('rapid replace without auth does not crash or leak', async () => {
      const bridge = WsBridge.get(serverId);
      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));

      // Rapid daemon connections that never authenticate
      for (let i = 0; i < 20; i++) {
        const dws = new MockWs();
        bridge.handleDaemonConnection(dws as never, makeDb('valid-hash'), {} as never);
        // Don't send auth — immediately replaced by next iteration
      }

      // Final daemon authenticates successfully
      const finalDaemon = new MockWs();
      bridge.handleDaemonConnection(finalDaemon as never, makeDb('valid-hash'), {} as never);
      finalDaemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      expect(bridge.isAuthenticated).toBe(true);
    });
  });

  // ── Whitelist completeness ────────────────────────────────────────────────

  describe('browser→daemon whitelist completeness', () => {
    async function setupBridge() {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      return { daemonWs, browserWs };
    }

    it('forwards subsession.set_model to daemon', async () => {
      const { daemonWs, browserWs } = await setupBridge();
      browserWs.emit('message', JSON.stringify({ type: 'subsession.set_model', sessionName: 's', model: 'gpt-4' }));
      await flushAsync();
      expect(daemonWs.sentStrings.some((s) => s.includes('subsession.set_model'))).toBe(true);
    });

    it('forwards ask.answer to daemon', async () => {
      const { daemonWs, browserWs } = await setupBridge();
      browserWs.emit('message', JSON.stringify({ type: 'ask.answer', sessionName: 's', answer: 'yes' }));
      await flushAsync();
      expect(daemonWs.sentStrings.some((s) => s.includes('ask.answer'))).toBe(true);
    });
  });

  // ── P0: session-scoped privacy routing ────────────────────────────────────
  // These tests verify that session-private messages (timeline history/replay,
  // notifications, tool state, command acks) are NEVER broadcast to browsers
  // subscribed to a different session.

  describe('session-scoped privacy routing (P0)', () => {
    /** Set up bridge with daemon + two browsers each subscribed to a different session */
    async function setupTwoBrowsers() {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserA = new MockWs();
      const browserB = new MockWs();
      bridge.handleBrowserConnection(browserA as never, 'user-a', makeDb('valid-hash'));
      bridge.handleBrowserConnection(browserB as never, 'user-b', makeDb('valid-hash'));

      browserA.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'session-a' }));
      browserB.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'session-b' }));
      await flushAsync();

      // Clear setup noise
      browserA.sent.length = 0;
      browserB.sent.length = 0;

      return { bridge, daemonWs, browserA, browserB };
    }

    const sessionScopedCases: Array<[string, Record<string, unknown>, string]> = [
      ['timeline.history', { type: 'timeline.history', sessionName: 'session-a', events: [{ eventId: 'e1' }], epoch: 1 }, 'session-a'],
      ['timeline.replay', { type: 'timeline.replay', sessionName: 'session-a', events: [], truncated: false, epoch: 1 }, 'session-a'],
      ['timeline.event', { type: 'timeline.event', event: { sessionId: 'session-a', eventId: 'e2', type: 'test' } }, 'session-a'],
      ['command.ack', { type: 'command.ack', session: 'session-a', commandId: 'c1', status: 'ok' }, 'session-a'],
      ['subsession.response', { type: 'subsession.response', sessionName: 'session-a', status: 'idle' }, 'session-a'],
      ['session.idle', { type: 'session.idle', session: 'session-a', project: 'p', agentType: 'claude-code' }, 'session-a'],
      ['session.notification', { type: 'session.notification', session: 'session-a', project: 'p', title: 't', message: 'm' }, 'session-a'],
      ['session.tool', { type: 'session.tool', session: 'session-a', tool: 'bash' }, 'session-a'],
    ];

    for (const [label, daemonMsg, targetSession] of sessionScopedCases) {
      it(`${label}: delivered only to ${targetSession} subscriber, not to other session`, async () => {
        const { daemonWs, browserA, browserB } = await setupTwoBrowsers();

        daemonWs.emit('message', JSON.stringify(daemonMsg));
        await flushAsync();

        // browserA (subscribed to session-a) must receive it
        expect(browserA.sentStrings.length).toBeGreaterThan(0);
        // browserB (subscribed to session-b) must NOT receive it — privacy violation
        expect(browserB.sentStrings.length).toBe(0);
      });
    }

    it('timeline.history for session-b is NOT delivered to session-a subscriber', async () => {
      const { daemonWs, browserA, browserB } = await setupTwoBrowsers();

      daemonWs.emit('message', JSON.stringify({
        type: 'timeline.history', sessionName: 'session-b', events: [{ secret: 'data' }], epoch: 1,
      }));
      await flushAsync();

      expect(browserA.sentStrings.length).toBe(0); // session-a browser must be silent
      expect(browserB.sentStrings.length).toBeGreaterThan(0);
    });

    it('session_event (lifecycle) is broadcast to all browsers', async () => {
      const { daemonWs, browserA, browserB } = await setupTwoBrowsers();

      daemonWs.emit('message', JSON.stringify({ type: 'session_event', event: 'started', session: 'session-a' }));
      await flushAsync();

      // session lifecycle events (connected/disconnected) are intentionally broadcast
      expect(browserA.sentStrings.length).toBeGreaterThan(0);
      expect(browserB.sentStrings.length).toBeGreaterThan(0);
    });
  });

  // ── P0: default-deny — missing session identifier → discard, NOT broadcast ─
  // These tests verify the "fail-closed" routing policy:
  // any session-scoped message that omits its session identifier must be
  // silently discarded, never broadcast to unrelated browsers.

  describe('default-deny: missing session ID → discard, not broadcast (P0)', () => {
    async function setupBrowserNoSub() {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      // Intentionally NOT subscribed to any session
      return { daemonWs, browserWs };
    }

    it('terminal_update without sessionName in diff → discarded, not broadcast', async () => {
      const { daemonWs, browserWs } = await setupBrowserNoSub();
      daemonWs.emit('message', JSON.stringify({ type: 'terminal_update', diff: { rows: [] } }));
      await flushAsync();
      expect(browserWs.sentStrings).toHaveLength(0);
    });

    it('command.ack without session → discarded, not broadcast', async () => {
      const { daemonWs, browserWs } = await setupBrowserNoSub();
      daemonWs.emit('message', JSON.stringify({ type: 'command.ack', commandId: 'c1', status: 'ok' }));
      await flushAsync();
      expect(browserWs.sentStrings).toHaveLength(0);
    });

    it('subsession.response without sessionName → discarded, not broadcast', async () => {
      const { daemonWs, browserWs } = await setupBrowserNoSub();
      daemonWs.emit('message', JSON.stringify({ type: 'subsession.response', status: 'idle' }));
      await flushAsync();
      expect(browserWs.sentStrings).toHaveLength(0);
    });

    it('timeline.history without sessionName → discarded, not broadcast', async () => {
      const { daemonWs, browserWs } = await setupBrowserNoSub();
      daemonWs.emit('message', JSON.stringify({ type: 'timeline.history', events: [{ secret: 'data' }] }));
      await flushAsync();
      expect(browserWs.sentStrings).toHaveLength(0);
    });

    it('timeline.replay without sessionName → discarded, not broadcast', async () => {
      const { daemonWs, browserWs } = await setupBrowserNoSub();
      daemonWs.emit('message', JSON.stringify({ type: 'timeline.replay', events: [], truncated: false }));
      await flushAsync();
      expect(browserWs.sentStrings).toHaveLength(0);
    });

    it('timeline.event without sessionId in event → discarded, not broadcast', async () => {
      const { daemonWs, browserWs } = await setupBrowserNoSub();
      daemonWs.emit('message', JSON.stringify({ type: 'timeline.event', event: { type: 'assistant.text' } }));
      await flushAsync();
      expect(browserWs.sentStrings).toHaveLength(0);
    });

    it('session.idle without session → discarded, not broadcast', async () => {
      const { daemonWs, browserWs } = await setupBrowserNoSub();
      daemonWs.emit('message', JSON.stringify({ type: 'session.idle' }));
      await flushAsync();
      expect(browserWs.sentStrings).toHaveLength(0);
    });

    it('session.notification without session → discarded, not broadcast', async () => {
      const { daemonWs, browserWs } = await setupBrowserNoSub();
      daemonWs.emit('message', JSON.stringify({ type: 'session.notification', title: 'done' }));
      await flushAsync();
      expect(browserWs.sentStrings).toHaveLength(0);
    });

    it('session.tool without session → discarded, not broadcast', async () => {
      const { daemonWs, browserWs } = await setupBrowserNoSub();
      daemonWs.emit('message', JSON.stringify({ type: 'session.tool', tool: 'bash' }));
      await flushAsync();
      expect(browserWs.sentStrings).toHaveLength(0);
    });

    it('unknown message type → discarded, not broadcast (default-deny)', async () => {
      const { daemonWs, browserWs } = await setupBrowserNoSub();
      daemonWs.emit('message', JSON.stringify({ type: 'future.unknown.type', data: 'secret' }));
      await flushAsync();
      expect(browserWs.sentStrings).toHaveLength(0);
    });

    it('session_list → broadcast to all browsers (whitelist)', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const b1 = new MockWs();
      const b2 = new MockWs();
      bridge.handleBrowserConnection(b1 as never, 'user-1', makeDb('valid-hash'));
      bridge.handleBrowserConnection(b2 as never, 'user-2', makeDb('valid-hash'));

      daemonWs.emit('message', JSON.stringify({ type: 'session_list', sessions: [] }));
      await flushAsync();

      expect(b1.sentStrings.length).toBeGreaterThan(0);
      expect(b2.sentStrings.length).toBeGreaterThan(0);
      expect(JSON.parse(b1.sentStrings[0]).type).toBe('session_list');
    });

    it('terminal_update for wrong session → not delivered to unsubscribed browser', async () => {
      const { daemonWs, browserWs } = await setupBrowserNoSub();
      // browser is not subscribed to any session
      daemonWs.emit('message', JSON.stringify({
        type: 'terminal_update', diff: { sessionName: 'other-session', rows: [] },
      }));
      await flushAsync();
      expect(browserWs.sentStrings).toHaveLength(0);
    });
  });

  // ── Repo message relay ──────────────────────────────────────────────────────

  describe('repo message relay', () => {
    async function setupBridge() {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      return { bridge, daemonWs, browserWs };
    }

    it('repo.detect from browser reaches daemon (not rate-limited)', async () => {
      const { daemonWs, browserWs } = await setupBridge();

      // Send many repo.detect messages — they should not be rate-limited
      for (let i = 0; i < 35; i++) {
        browserWs.emit('message', JSON.stringify({
          type: 'repo.detect',
          requestId: `detect-${i}`,
          projectDir: '/home/user/myproject',
        }));
      }
      await flushAsync();

      // All 35 should have reached the daemon (repo.detect is rate-limit exempt)
      const detectMessages = daemonWs.sentStrings.filter((s) => {
        try { return (JSON.parse(s) as { type: string }).type === 'repo.detect'; } catch { return false; }
      });
      expect(detectMessages).toHaveLength(35);
    });

    it('repo.detect_response from daemon reaches browser', async () => {
      const { daemonWs, browserWs } = await setupBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'repo.detect_response',
        requestId: 'req-1',
        projectDir: '/home/user/myproject',
        status: 'ok',
        info: { platform: 'github', owner: 'acme', repo: 'widgets' },
        cliVersion: '2.50.0',
        cliAuth: true,
      }));
      await flushAsync();

      expect(browserWs.sentStrings.length).toBeGreaterThan(0);
      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('repo.detect_response');
      expect(msg.requestId).toBe('req-1');
      expect(msg.status).toBe('ok');
      expect(msg.info.platform).toBe('github');
    });

    it('repo.error from daemon reaches browser', async () => {
      const { daemonWs, browserWs } = await setupBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'repo.error',
        requestId: 'req-2',
        error: 'gh CLI not found',
      }));
      await flushAsync();

      expect(browserWs.sentStrings.length).toBeGreaterThan(0);
      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('repo.error');
      expect(msg.error).toBe('gh CLI not found');
    });

    it('repo.detected (push) from daemon reaches browser', async () => {
      const { daemonWs, browserWs } = await setupBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'repo.detected',
        projectDir: '/home/user/myproject',
        context: {
          status: 'ok',
          info: { platform: 'github', owner: 'acme', repo: 'widgets' },
        },
      }));
      await flushAsync();

      expect(browserWs.sentStrings.length).toBeGreaterThan(0);
      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('repo.detected');
      expect(msg.projectDir).toBe('/home/user/myproject');
      expect(msg.context.status).toBe('ok');
    });

    it('repo.issues_response reaches browser', async () => {
      const { daemonWs, browserWs } = await setupBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'repo.issues_response',
        requestId: 'req-issues',
        projectDir: '/home/user/myproject',
        items: [{ number: 1, title: 'Bug', state: 'open' }],
        page: 1,
        hasMore: false,
      }));
      await flushAsync();

      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('repo.issues_response');
      expect(msg.items).toHaveLength(1);
      expect(msg.items[0].title).toBe('Bug');
    });

    it('repo.prs_response reaches browser', async () => {
      const { daemonWs, browserWs } = await setupBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'repo.prs_response',
        requestId: 'req-prs',
        projectDir: '/home/user/myproject',
        items: [{ number: 10, title: 'Feature PR', state: 'open' }],
        page: 1,
        hasMore: true,
      }));
      await flushAsync();

      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('repo.prs_response');
      expect(msg.items[0].title).toBe('Feature PR');
      expect(msg.hasMore).toBe(true);
    });

    it('repo.branches_response reaches browser', async () => {
      const { daemonWs, browserWs } = await setupBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'repo.branches_response',
        requestId: 'req-branches',
        projectDir: '/home/user/myproject',
        items: [{ name: 'main', current: true }, { name: 'dev', current: false }],
        page: 1,
        hasMore: false,
      }));
      await flushAsync();

      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('repo.branches_response');
      expect(msg.items).toHaveLength(2);
    });

    it('repo.commits_response reaches browser', async () => {
      const { daemonWs, browserWs } = await setupBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'repo.commits_response',
        requestId: 'req-commits',
        projectDir: '/home/user/myproject',
        items: [{ sha: 'abc123', message: 'initial commit' }],
        page: 1,
        hasMore: false,
      }));
      await flushAsync();

      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('repo.commits_response');
      expect(msg.items[0].sha).toBe('abc123');
    });

    it('repo messages are broadcast to all connected browsers', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browser1 = new MockWs();
      const browser2 = new MockWs();
      bridge.handleBrowserConnection(browser1 as never, 'user-1', makeDb('valid-hash'));
      bridge.handleBrowserConnection(browser2 as never, 'user-2', makeDb('valid-hash'));

      daemonWs.emit('message', JSON.stringify({
        type: 'repo.detect_response',
        requestId: 'req-bc',
        projectDir: '/proj',
        status: 'ok',
        info: { platform: 'github', owner: 'x', repo: 'y' },
      }));
      await flushAsync();

      // Both browsers should receive the message
      expect(browser1.sentStrings.length).toBeGreaterThan(0);
      expect(browser2.sentStrings.length).toBeGreaterThan(0);
      expect(JSON.parse(browser1.sentStrings[0]).type).toBe('repo.detect_response');
      expect(JSON.parse(browser2.sentStrings[0]).type).toBe('repo.detect_response');
    });
  });

  // ── Sub-session sync + P2P conflict relay ─────────────────────────────────

  describe('sub-session sync and P2P conflict relay', () => {
    async function setupAuthBridge() {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      browserWs.sent.length = 0;

      return { bridge, daemonWs, browserWs };
    }

    it('subsession.sync from daemon → persists to DB + broadcasts subsession.created to browsers', async () => {
      const { daemonWs, browserWs } = await setupAuthBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'subsession.sync',
        id: 'sub-123',
        sessionType: 'claude-code',
        shellBin: '/bin/bash',
        cwd: '/home/user/project',
        label: 'worker-1',
        ccSessionId: 'cc-abc',
        parentSession: 'deck_myapp_brain',
      }));
      await flushAsync();

      // Browser should receive subsession.created broadcast
      expect(browserWs.sentStrings.length).toBeGreaterThan(0);
      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('subsession.created');
      expect(msg.id).toBe('sub-123');
      expect(msg.sessionName).toBe('deck_sub_sub-123');
      expect(msg.sessionType).toBe('claude-code');
      expect(msg.cwd).toBe('/home/user/project');
      expect(msg.label).toBe('worker-1');
      expect(msg.parentSession).toBe('deck_myapp_brain');
      expect(msg.state).toBe('running');
    });

    it('subsession.closed from daemon → updates DB + broadcasts subsession.removed to browsers', async () => {
      const { daemonWs, browserWs } = await setupAuthBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'subsession.closed',
        id: 'sub-456',
        sessionName: 'deck_sub_sub-456',
      }));
      await flushAsync();

      // Browser should receive subsession.removed broadcast
      expect(browserWs.sentStrings.length).toBeGreaterThan(0);
      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('subsession.removed');
      expect(msg.id).toBe('sub-456');
      expect(msg.sessionName).toBe('deck_sub_sub-456');
    });

    it('subsession.closed without id → no broadcast', async () => {
      const { daemonWs, browserWs } = await setupAuthBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'subsession.closed',
        // no id
        sessionName: 'deck_sub_missing',
      }));
      await flushAsync();

      expect(browserWs.sentStrings).toHaveLength(0);
    });

    it('p2p.conflict from daemon → broadcasts to all browsers', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browser1 = new MockWs();
      const browser2 = new MockWs();
      bridge.handleBrowserConnection(browser1 as never, 'user-1', makeDb('valid-hash'));
      bridge.handleBrowserConnection(browser2 as never, 'user-2', makeDb('valid-hash'));
      browser1.sent.length = 0;
      browser2.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'p2p.conflict',
        topic: 'review code',
        existingRunId: 'run-old',
      }));
      await flushAsync();

      // Both browsers should receive the p2p.conflict message
      expect(browser1.sentStrings.length).toBeGreaterThan(0);
      expect(browser2.sentStrings.length).toBeGreaterThan(0);
      const msg1 = JSON.parse(browser1.sentStrings[0]);
      const msg2 = JSON.parse(browser2.sentStrings[0]);
      expect(msg1.type).toBe('p2p.conflict');
      expect(msg1.topic).toBe('review code');
      expect(msg2.type).toBe('p2p.conflict');
    });

    it('p2p.conflict is not session-scoped — reaches unsubscribed browsers', async () => {
      const { daemonWs, browserWs } = await setupAuthBridge();
      // browserWs is not subscribed to any session

      daemonWs.emit('message', JSON.stringify({
        type: 'p2p.conflict',
        topic: 'refactor',
        existingRunId: 'run-x',
      }));
      await flushAsync();

      expect(browserWs.sentStrings.length).toBeGreaterThan(0);
      expect(JSON.parse(browserWs.sentStrings[0]).type).toBe('p2p.conflict');
    });
  });

  describe('push notifications', () => {
    function makePushDb(tokenHash: string) {
      return {
        queryOne: async (sql: string) => {
          if (sql.includes('FROM servers')) return { token_hash: tokenHash, user_id: 'user-1', name: 'my-server' };
          if (sql.includes('FROM sessions')) return { project_name: 'codedeck', agent_type: 'claude-code', label: null };
          return { token_hash: tokenHash };
        },
        query: async () => [],
        execute: async () => ({ changes: 1 }),
        exec: async () => {},
        close: () => {},
      } as unknown as import('../src/db/client.js').Database;
    }

    async function setupPushBridge() {
      const db = makePushDb('valid-hash');
      const env = { APNS_KEY: 'test', APNS_KEY_ID: 'kid', APNS_TEAM_ID: 'tid' } as never;
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, db, env);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();
      return { bridge, daemonWs, db, env };
    }

    it('includes server name and session metadata in push title', async () => {
      const { dispatchPush } = await import('../src/routes/push.js');
      const { daemonWs } = await setupPushBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'session.idle', session: 'deck_cd_brain', lastText: 'Done implementing the feature.',
      }));
      await flushAsync();

      expect(dispatchPush).toHaveBeenCalled();
      const call = vi.mocked(dispatchPush).mock.calls[0];
      const payload = call[0];
      expect(payload.title).toContain('my-server');
      expect(payload.title).toContain('codedeck');
      expect(payload.title).toContain('claude-code');
      expect(payload.body).toContain('Done implementing');
    });

    it('uses lastText as push body for session.idle', async () => {
      const { dispatchPush } = await import('../src/routes/push.js');
      const { daemonWs } = await setupPushBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'session.idle', session: 'deck_cd_brain', lastText: 'All tests passing.',
      }));
      await flushAsync();

      const payload = vi.mocked(dispatchPush).mock.calls[0][0];
      expect(payload.body).toBe('All tests passing.');
    });

    it('falls back to default body when no lastText', async () => {
      const { dispatchPush } = await import('../src/routes/push.js');
      const { daemonWs } = await setupPushBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'session.idle', session: 'deck_cd_brain',
      }));
      await flushAsync();

      const payload = vi.mocked(dispatchPush).mock.calls[0][0];
      expect(payload.body).toContain('ready for input');
    });

    it('skips push when mobile client is connected', async () => {
      const { dispatchPush } = await import('../src/routes/push.js');
      const { bridge, daemonWs } = await setupPushBridge();

      // Connect a mobile browser
      const mobileWs = new MockWs();
      bridge.handleBrowserConnection(mobileWs as never, 'user-1', makePushDb('valid-hash'), true);

      daemonWs.emit('message', JSON.stringify({
        type: 'session.idle', session: 'deck_cd_brain',
      }));
      await flushAsync();

      expect(dispatchPush).not.toHaveBeenCalled();
    });

    it('sends push when only desktop browser is connected', async () => {
      const { dispatchPush } = await import('../src/routes/push.js');
      const { bridge, daemonWs } = await setupPushBridge();

      // Connect a desktop browser (isMobile = false)
      const desktopWs = new MockWs();
      bridge.handleBrowserConnection(desktopWs as never, 'user-1', makePushDb('valid-hash'), false);

      daemonWs.emit('message', JSON.stringify({
        type: 'session.idle', session: 'deck_cd_brain', lastText: 'Completed.',
      }));
      await flushAsync();

      expect(dispatchPush).toHaveBeenCalled();
    });
  });

  describe('transport provider relay', () => {
    async function setupAuthenticatedBridge() {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      return { bridge, daemonWs, browserWs };
    }

    it('relays provider.status to all browsers (broadcast)', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      daemonWs.emit('message', JSON.stringify({
        type: 'provider.status', providerId: 'openclaw', connected: true,
      }));
      await flushAsync();
      const msg = JSON.parse(browserWs.sentStrings.at(-1)!);
      expect(msg.type).toBe('provider.status');
      expect(msg.providerId).toBe('openclaw');
      expect(msg.connected).toBe(true);
    });

    it('relays provider.status disconnected', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      daemonWs.emit('message', JSON.stringify({
        type: 'provider.status', providerId: 'openclaw', connected: false,
      }));
      await flushAsync();
      const msg = JSON.parse(browserWs.sentStrings.at(-1)!);
      expect(msg.type).toBe('provider.status');
      expect(msg.connected).toBe(false);
    });

    it('relays transport chat events to subscribed browsers', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      // Subscribe browser to transport session
      browserWs.emit('message', JSON.stringify({ type: 'chat.subscribe', sessionId: 'ts-123' }));
      await flushAsync();
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'chat.delta', sessionId: 'ts-123', delta: 'hello',
      }));
      await flushAsync();
      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('chat.delta');
      expect(msg.sessionId).toBe('ts-123');
    });

    it('does NOT relay transport chat events to unsubscribed browsers', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      // Don't subscribe
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'chat.delta', sessionId: 'ts-456', delta: 'nope',
      }));
      await flushAsync();
      // Should not receive transport event (only provider.status is broadcast)
      const transportMsgs = browserWs.sentStrings.filter(s => JSON.parse(s).type === 'chat.delta');
      expect(transportMsgs.length).toBe(0);
    });

    it('discards unknown message types (default-deny)', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      browserWs.sent.length = 0;
      daemonWs.emit('message', JSON.stringify({ type: 'totally.unknown.type', foo: 'bar' }));
      await flushAsync();
      // No message should reach browser
      const msgs = browserWs.sentStrings.filter(s => JSON.parse(s).type === 'totally.unknown.type');
      expect(msgs.length).toBe(0);
    });

    it('provider.status broadcasts to ALL connected browsers', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browser1 = new MockWs();
      const browser2 = new MockWs();
      const browser3 = new MockWs();
      bridge.handleBrowserConnection(browser1 as never, 'user-1', makeDb('valid-hash'));
      bridge.handleBrowserConnection(browser2 as never, 'user-2', makeDb('valid-hash'));
      bridge.handleBrowserConnection(browser3 as never, 'user-3', makeDb('valid-hash'));
      browser1.sent.length = 0;
      browser2.sent.length = 0;
      browser3.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'provider.status', providerId: 'openclaw', connected: true,
      }));
      await flushAsync();

      for (const browser of [browser1, browser2, browser3]) {
        const msg = JSON.parse(browser.sentStrings.at(-1)!);
        expect(msg.type).toBe('provider.status');
        expect(msg.providerId).toBe('openclaw');
        expect(msg.connected).toBe(true);
      }
    });

    it('chat.subscribe → receive events → chat.unsubscribe → stop receiving', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();

      // Subscribe to transport session
      browserWs.emit('message', JSON.stringify({ type: 'chat.subscribe', sessionId: 'ts-sub-test' }));
      await flushAsync();
      browserWs.sent.length = 0;

      // Should receive events for subscribed session
      daemonWs.emit('message', JSON.stringify({
        type: 'chat.delta', sessionId: 'ts-sub-test', delta: 'hello',
      }));
      await flushAsync();
      expect(browserWs.sentStrings.some(s => JSON.parse(s).type === 'chat.delta')).toBe(true);
      browserWs.sent.length = 0;

      // Unsubscribe
      browserWs.emit('message', JSON.stringify({ type: 'chat.unsubscribe', sessionId: 'ts-sub-test' }));
      await flushAsync();
      browserWs.sent.length = 0;

      // Should NOT receive events after unsubscribe
      daemonWs.emit('message', JSON.stringify({
        type: 'chat.delta', sessionId: 'ts-sub-test', delta: 'should not arrive',
      }));
      await flushAsync();
      expect(browserWs.sentStrings.filter(s => JSON.parse(s).type === 'chat.delta')).toHaveLength(0);
    });

    it('relays chat.complete events to subscribed browsers', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      browserWs.emit('message', JSON.stringify({ type: 'chat.subscribe', sessionId: 'ts-complete' }));
      await flushAsync();
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'chat.complete', sessionId: 'ts-complete', messageId: 'msg-1',
      }));
      await flushAsync();

      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('chat.complete');
      expect(msg.sessionId).toBe('ts-complete');
      expect(msg.messageId).toBe('msg-1');
    });

    it('relays chat.error events to subscribed browsers', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      browserWs.emit('message', JSON.stringify({ type: 'chat.subscribe', sessionId: 'ts-err' }));
      await flushAsync();
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'chat.error', sessionId: 'ts-err', error: 'rate limited', code: 'RATE_LIMITED',
      }));
      await flushAsync();

      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('chat.error');
      expect(msg.error).toBe('rate limited');
      expect(msg.code).toBe('RATE_LIMITED');
    });

    it('relays chat.status events to subscribed browsers', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      browserWs.emit('message', JSON.stringify({ type: 'chat.subscribe', sessionId: 'ts-status' }));
      await flushAsync();
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'chat.status', sessionId: 'ts-status', status: 'streaming',
      }));
      await flushAsync();

      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('chat.status');
      expect(msg.status).toBe('streaming');
    });

    it('relays chat.tool events to subscribed browsers', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      browserWs.emit('message', JSON.stringify({ type: 'chat.subscribe', sessionId: 'ts-tool' }));
      await flushAsync();
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'chat.tool', sessionId: 'ts-tool', messageId: 'msg-1',
        tool: { name: 'read_file', status: 'started' },
      }));
      await flushAsync();

      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('chat.tool');
      expect(msg.tool.name).toBe('read_file');
    });

    it('relays chat.approval events to subscribed browsers', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      browserWs.emit('message', JSON.stringify({ type: 'chat.subscribe', sessionId: 'ts-approval' }));
      await flushAsync();
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'chat.approval', sessionId: 'ts-approval', requestId: 'req-1',
        description: 'Write to file /etc/passwd',
      }));
      await flushAsync();

      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('chat.approval');
      expect(msg.requestId).toBe('req-1');
      expect(msg.description).toBe('Write to file /etc/passwd');
    });

    it('isolates transport subscriptions between browsers', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browser1 = new MockWs();
      const browser2 = new MockWs();
      bridge.handleBrowserConnection(browser1 as never, 'user-1', makeDb('valid-hash'));
      bridge.handleBrowserConnection(browser2 as never, 'user-2', makeDb('valid-hash'));

      // browser1 subscribes to session A, browser2 subscribes to session B
      browser1.emit('message', JSON.stringify({ type: 'chat.subscribe', sessionId: 'sess-A' }));
      browser2.emit('message', JSON.stringify({ type: 'chat.subscribe', sessionId: 'sess-B' }));
      await flushAsync();
      browser1.sent.length = 0;
      browser2.sent.length = 0;

      // Delta for session A — only browser1 should get it
      daemonWs.emit('message', JSON.stringify({
        type: 'chat.delta', sessionId: 'sess-A', delta: 'for-browser-1',
      }));
      await flushAsync();

      expect(browser1.sentStrings.filter(s => JSON.parse(s).type === 'chat.delta')).toHaveLength(1);
      expect(browser2.sentStrings.filter(s => JSON.parse(s).type === 'chat.delta')).toHaveLength(0);

      browser1.sent.length = 0;
      browser2.sent.length = 0;

      // Delta for session B — only browser2 should get it
      daemonWs.emit('message', JSON.stringify({
        type: 'chat.delta', sessionId: 'sess-B', delta: 'for-browser-2',
      }));
      await flushAsync();

      expect(browser1.sentStrings.filter(s => JSON.parse(s).type === 'chat.delta')).toHaveLength(0);
      expect(browser2.sentStrings.filter(s => JSON.parse(s).type === 'chat.delta')).toHaveLength(1);
    });

    it('provider.status still reaches browsers that have no transport subscriptions', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      // Browser has NOT subscribed to any transport session
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'provider.status', providerId: 'openclaw', connected: true,
      }));
      await flushAsync();

      // provider.status is broadcast (not subscription-gated)
      const msg = JSON.parse(browserWs.sentStrings.at(-1)!);
      expect(msg.type).toBe('provider.status');
      expect(msg.connected).toBe(true);
    });

    it('provider connect → disconnect sequence reaches browser in order', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'provider.status', providerId: 'openclaw', connected: true,
      }));
      daemonWs.emit('message', JSON.stringify({
        type: 'provider.status', providerId: 'openclaw', connected: false,
      }));
      await flushAsync();

      const statusMsgs = browserWs.sentStrings
        .map(s => JSON.parse(s))
        .filter((m: Record<string, unknown>) => m.type === 'provider.status');

      expect(statusMsgs).toHaveLength(2);
      expect(statusMsgs[0].connected).toBe(true);
      expect(statusMsgs[1].connected).toBe(false);
    });
  });
});
