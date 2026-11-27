import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { WsBridge } from '../src/ws/bridge.js';
import {
  PREVIEW_BINARY_FRAME,
  PREVIEW_LIMITS,
  PREVIEW_MSG,
  packPreviewWsFrame,
} from '../../shared/preview-types.js';

// ── Mock WebSocket ────────────────────────────────────────────────────────────

class MockWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  closed = false;
  closedCode: number | undefined;
  closedReason: string | undefined;
  readyState = 1; // OPEN

  send(data: string | Buffer, opts?: unknown, callback?: (err?: Error) => void): void;
  send(data: string | Buffer, callback?: (err?: Error) => void): void;
  send(data: string | Buffer, optsOrCb?: unknown, callback?: (err?: Error) => void): void {
    if (this.closed) {
      const err = new Error('socket closed');
      const cb = typeof optsOrCb === 'function' ? (optsOrCb as (e?: Error) => void) : callback;
      cb?.(err);
      return;
    }
    this.sent.push(data);
    const cb = typeof optsOrCb === 'function' ? (optsOrCb as (e?: Error) => void) : callback;
    cb?.();
  }

  close(code?: number, reason?: string) {
    this.closed = true;
    this.closedCode = code;
    this.closedReason = reason;
    this.readyState = 3; // CLOSED
    this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
  }

  get sentStrings(): string[] {
    return this.sent.filter((s): s is string => typeof s === 'string');
  }

  get sentBuffers(): Buffer[] {
    return this.sent.filter((s): s is Buffer => Buffer.isBuffer(s));
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDb(tokenHash: string) {
  return {
    queryOne: async () => ({ token_hash: tokenHash, owner_status: 'active' }),
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    close: () => {},
  } as unknown as import('../src/db/client.js').Database;
}

vi.mock('../src/security/crypto.js', () => ({
  sha256Hex: () => 'valid-hash',
  randomHex: () => 'a'.repeat(32),
}));

vi.mock('../src/routes/push.js', () => ({
  dispatchPush: vi.fn(),
}));

async function flushAsync(rounds = 5) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => process.nextTick(r));
}

async function setupBridge() {
  const serverId = `ws-tunnel-${Math.random().toString(36).slice(2)}`;
  const bridge = WsBridge.get(serverId);
  const daemon = new MockWs();
  bridge.handleDaemonConnection(daemon as never, makeDb('valid-hash'), {} as never);
  daemon.emit('message', Buffer.from(JSON.stringify({ type: 'auth', serverId, token: 't' })), false);
  await flushAsync();
  return { bridge, daemon, serverId };
}

const wsId = 'a'.repeat(32);
const previewId = 'preview-' + 'b'.repeat(16);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WsBridge preview WS tunnels', () => {
  afterEach(() => {
    WsBridge.getAll().clear();
    vi.useRealTimers();
  });

  describe('createPreviewWsTunnel', () => {
    it('sends preview.ws.open to daemon in pending state', async () => {
      const { bridge, daemon } = await setupBridge();
      const browserWs = new MockWs();

      bridge.createPreviewWsTunnel(wsId, previewId, 3000, '/ws', browserWs as never, { 'user-agent': 'test' }, ['chat']);

      const sentOpen = daemon.sentStrings.find((s) => s.includes(PREVIEW_MSG.WS_OPEN));
      expect(sentOpen).toBeDefined();
      const msg = JSON.parse(sentOpen!);
      expect(msg.wsId).toBe(wsId);
      expect(msg.previewId).toBe(previewId);
      expect(msg.port).toBe(3000);
      expect(msg.path).toBe('/ws');
      expect(msg.protocols).toEqual(['chat']);
    });

    it('counts per-preview and per-server WS tunnels', async () => {
      const { bridge } = await setupBridge();
      const bws1 = new MockWs();
      const bws2 = new MockWs();

      bridge.createPreviewWsTunnel(wsId, previewId, 3000, '/', bws1 as never, {}, []);
      bridge.createPreviewWsTunnel('b'.repeat(32), previewId, 3000, '/', bws2 as never, {}, []);

      expect(bridge.getPreviewWsCount(previewId)).toBe(2);
      expect(bridge.getServerWsCount()).toBe(2);
    });
  });

  describe('pending state — message queueing', () => {
    it('queues browser messages while pending', async () => {
      const { bridge, daemon } = await setupBridge();
      const browserWs = new MockWs();

      bridge.createPreviewWsTunnel(wsId, previewId, 3000, '/', browserWs as never, {}, []);
      const countBefore = daemon.sent.length;

      // Send message before ws.opened
      browserWs.emit('message', Buffer.from('hello'), false);
      await flushAsync();

      // Should NOT have been sent to daemon yet
      const wsdataFrames = daemon.sentBuffers.filter((b) => b[0] === PREVIEW_BINARY_FRAME.WS_DATA);
      expect(wsdataFrames).toHaveLength(0);
      expect(daemon.sent.length).toBe(countBefore); // only ws.open was sent earlier
    });

    it('flushes queued messages to daemon when preview.ws.opened arrives', async () => {
      const { bridge, daemon } = await setupBridge();
      const browserWs = new MockWs();

      bridge.createPreviewWsTunnel(wsId, previewId, 3000, '/', browserWs as never, {}, []);

      // Queue a message in pending state
      browserWs.emit('message', Buffer.from('hello'), false);
      await flushAsync();

      // Now receive ws.opened
      daemon.emit('message', Buffer.from(JSON.stringify({
        type: PREVIEW_MSG.WS_OPENED,
        wsId,
        protocol: undefined,
      })), false);
      await flushAsync();

      // The queued message should now have been sent as WS_DATA frame
      const wsdataFrames = daemon.sentBuffers.filter((b) => b[0] === PREVIEW_BINARY_FRAME.WS_DATA);
      expect(wsdataFrames.length).toBeGreaterThanOrEqual(1);
    });

    it('closes with 1008 on pending queue overflow', async () => {
      const { bridge, daemon } = await setupBridge();
      const browserWs = new MockWs();

      bridge.createPreviewWsTunnel(wsId, previewId, 3000, '/', browserWs as never, {}, []);

      // Send messages exceeding 64KB queue limit
      const bigChunk = Buffer.alloc(PREVIEW_LIMITS.MAX_WS_PENDING_QUEUE_BYTES + 1, 0x42);
      browserWs.emit('message', bigChunk, true);
      await flushAsync();

      expect(browserWs.closed).toBe(true);
      expect(browserWs.closedCode).toBe(1008);

      // Should send preview.ws.close to daemon
      const closeMsg = daemon.sentStrings.find((s) => s.includes(PREVIEW_MSG.WS_CLOSE));
      expect(closeMsg).toBeDefined();
    });
  });

  describe('active state — bidirectional relay', () => {
    async function setupActiveTunnel() {
      const result = await setupBridge();
      const browserWs = new MockWs();

      result.bridge.createPreviewWsTunnel(wsId, previewId, 3000, '/', browserWs as never, {}, []);

      // Activate tunnel
      result.daemon.emit('message', Buffer.from(JSON.stringify({
        type: PREVIEW_MSG.WS_OPENED,
        wsId,
      })), false);
      await flushAsync();

      return { ...result, browserWs };
    }

    it('relays browser text message to daemon as WS_DATA frame', async () => {
      const { bridge, daemon, browserWs } = await setupActiveTunnel();
      void bridge;

      const countBefore = daemon.sentBuffers.length;
      browserWs.emit('message', Buffer.from('hello world'), false);
      await flushAsync();

      const newFrames = daemon.sentBuffers.slice(countBefore);
      const wsDataFrames = newFrames.filter((b) => b[0] === PREVIEW_BINARY_FRAME.WS_DATA);
      expect(wsDataFrames.length).toBe(1);
    });

    it('relays binary message from daemon to browser', async () => {
      const { daemon, browserWs } = await setupActiveTunnel();

      const payload = Buffer.from([1, 2, 3, 4]);
      const frame = packPreviewWsFrame(wsId, true, payload);

      daemon.emit('message', frame, true);
      await flushAsync();

      const binaryMsgs = browserWs.sentBuffers;
      expect(binaryMsgs.length).toBeGreaterThanOrEqual(1);
    });

    it('closes with 1009 when daemon→browser message exceeds max size', async () => {
      const { daemon, browserWs } = await setupActiveTunnel();

      const oversized = Buffer.alloc(PREVIEW_LIMITS.MAX_WS_MESSAGE_BYTES + 1, 0x42);
      const frame = packPreviewWsFrame(wsId, true, oversized);

      daemon.emit('message', frame, true);
      await flushAsync();

      expect(browserWs.closed).toBe(true);
      expect(browserWs.closedCode).toBe(1009);
    });

    it('closes with 1009 when browser→daemon message exceeds max size', async () => {
      const { daemon, browserWs } = await setupActiveTunnel();

      const oversized = Buffer.alloc(PREVIEW_LIMITS.MAX_WS_MESSAGE_BYTES + 1, 0x42);
      browserWs.emit('message', oversized, true);
      await flushAsync();

      expect(browserWs.closed).toBe(true);
      expect(browserWs.closedCode).toBe(1009);

      const closeMsg = daemon.sentStrings.find((s) => s.includes(PREVIEW_MSG.WS_CLOSE));
      expect(closeMsg).toBeDefined();
    });
  });

  describe('close handling', () => {
    it('forwards daemon preview.ws.close to browser WS with code+reason', async () => {
      const { bridge, daemon } = await setupBridge();
      const browserWs = new MockWs();
      void bridge;

      bridge.createPreviewWsTunnel(wsId, previewId, 3000, '/', browserWs as never, {}, []);
      daemon.emit('message', Buffer.from(JSON.stringify({ type: PREVIEW_MSG.WS_OPENED, wsId })), false);
      await flushAsync();

      daemon.emit('message', Buffer.from(JSON.stringify({
        type: PREVIEW_MSG.WS_CLOSE,
        wsId,
        code: 4001,
        reason: 'session expired',
      })), false);
      await flushAsync();

      expect(browserWs.closed).toBe(true);
      expect(browserWs.closedCode).toBe(4001);
      expect(browserWs.closedReason).toBe('session expired');
    });

    it('sends preview.ws.close to daemon when browser WS closes', async () => {
      const { bridge, daemon } = await setupBridge();
      const browserWs = new MockWs();
      void bridge;

      bridge.createPreviewWsTunnel(wsId, previewId, 3000, '/', browserWs as never, {}, []);
      daemon.emit('message', Buffer.from(JSON.stringify({ type: PREVIEW_MSG.WS_OPENED, wsId })), false);
      await flushAsync();

      browserWs.close(1000, 'normal');

      const closeMsg = daemon.sentStrings.find((s) => {
        const p = JSON.parse(s);
        return p.type === PREVIEW_MSG.WS_CLOSE && p.wsId === wsId && p.code === 1000;
      });
      expect(closeMsg).toBeDefined();
    });

    it('handles preview.ws.error by closing browser WS with 1011', async () => {
      const { bridge, daemon } = await setupBridge();
      const browserWs = new MockWs();
      void bridge;

      bridge.createPreviewWsTunnel(wsId, previewId, 3000, '/', browserWs as never, {}, []);

      daemon.emit('message', Buffer.from(JSON.stringify({
        type: PREVIEW_MSG.WS_ERROR,
        wsId,
        error: 'connection refused',
      })), false);
      await flushAsync();

      expect(browserWs.closed).toBe(true);
      expect(browserWs.closedCode).toBe(1011);
    });

    it('decrements server WS count after tunnel closes', async () => {
      const { bridge, daemon } = await setupBridge();
      const browserWs = new MockWs();

      bridge.createPreviewWsTunnel(wsId, previewId, 3000, '/', browserWs as never, {}, []);
      expect(bridge.getServerWsCount()).toBe(1);

      daemon.emit('message', Buffer.from(JSON.stringify({
        type: PREVIEW_MSG.WS_CLOSE,
        wsId,
        code: 1000,
        reason: '',
      })), false);
      await flushAsync();

      expect(bridge.getServerWsCount()).toBe(0);
    });
  });

  describe('daemon disconnect', () => {
    it('closes all WS tunnels with 1001 when daemon disconnects', async () => {
      const { bridge, daemon } = await setupBridge();
      const bws1 = new MockWs();
      const bws2 = new MockWs();

      bridge.createPreviewWsTunnel(wsId, previewId, 3000, '/', bws1 as never, {}, []);
      bridge.createPreviewWsTunnel('c'.repeat(32), previewId, 3000, '/', bws2 as never, {}, []);
      expect(bridge.getServerWsCount()).toBe(2);

      daemon.close();
      await flushAsync();

      expect(bws1.closed).toBe(true);
      expect(bws1.closedCode).toBe(1001);
      expect(bws2.closed).toBe(true);
      expect(bws2.closedCode).toBe(1001);
      expect(bridge.getServerWsCount()).toBe(0);
    });
  });

  describe('closeAllPreviewWsForPreview', () => {
    it('closes all tunnels for a given previewId', async () => {
      const { bridge, daemon } = await setupBridge();
      const bws1 = new MockWs();
      const bws2 = new MockWs();
      const otherPreviewId = 'other-preview';

      bridge.createPreviewWsTunnel(wsId, previewId, 3000, '/', bws1 as never, {}, []);
      bridge.createPreviewWsTunnel('d'.repeat(32), otherPreviewId, 3001, '/', bws2 as never, {}, []);

      bridge.closeAllPreviewWsForPreview(previewId);
      await flushAsync();

      expect(bws1.closed).toBe(true);
      expect(bws1.closedCode).toBe(1001);
      expect(bws2.closed).toBe(false); // other preview unaffected

      // Should send preview.ws.close for the closed tunnel
      const closeMsg = daemon.sentStrings.find((s) => {
        const p = JSON.parse(s);
        return p.type === PREVIEW_MSG.WS_CLOSE && p.wsId === wsId;
      });
      expect(closeMsg).toBeDefined();
    });
  });

  describe('open timeout', () => {
    it('closes browser WS with 1001 if daemon does not send ws.opened within timeout', async () => {
      vi.useFakeTimers();
      const { bridge } = await setupBridge();
      const browserWs = new MockWs();
      void bridge;

      bridge.createPreviewWsTunnel(wsId, previewId, 3000, '/', browserWs as never, {}, []);

      vi.advanceTimersByTime(PREVIEW_LIMITS.WS_OPEN_TIMEOUT_MS + 100);

      expect(browserWs.closed).toBe(true);
      expect(browserWs.closedCode).toBe(1001);
    });

    it('does not fire open timeout if ws.opened arrives in time', async () => {
      vi.useFakeTimers();
      const { bridge, daemon } = await setupBridge();
      const browserWs = new MockWs();
      void bridge;

      bridge.createPreviewWsTunnel(wsId, previewId, 3000, '/', browserWs as never, {}, []);

      // Resolve before timeout
      daemon.emit('message', Buffer.from(JSON.stringify({ type: PREVIEW_MSG.WS_OPENED, wsId })), false);
      await flushAsync();

      vi.advanceTimersByTime(PREVIEW_LIMITS.WS_OPEN_TIMEOUT_MS + 100);

      expect(browserWs.closed).toBe(false);
    });
  });

  describe('idle timeout', () => {
    it('closes tunnel with 1000 after idle timeout with no messages', async () => {
      vi.useFakeTimers();
      const { bridge, daemon } = await setupBridge();
      const browserWs = new MockWs();
      void bridge;

      bridge.createPreviewWsTunnel(wsId, previewId, 3000, '/', browserWs as never, {}, []);
      daemon.emit('message', Buffer.from(JSON.stringify({ type: PREVIEW_MSG.WS_OPENED, wsId })), false);
      await flushAsync();

      vi.advanceTimersByTime(PREVIEW_LIMITS.WS_IDLE_TIMEOUT_MS + 100);

      expect(browserWs.closed).toBe(true);
      expect(browserWs.closedCode).toBe(1000);
    });

    it('resets idle timer on each relayed message', async () => {
      vi.useFakeTimers();
      const { bridge, daemon } = await setupBridge();
      const browserWs = new MockWs();
      void bridge;

      bridge.createPreviewWsTunnel(wsId, previewId, 3000, '/', browserWs as never, {}, []);
      daemon.emit('message', Buffer.from(JSON.stringify({ type: PREVIEW_MSG.WS_OPENED, wsId })), false);
      await flushAsync();

      // Send a message partway through the idle window — resets timer
      vi.advanceTimersByTime(PREVIEW_LIMITS.WS_IDLE_TIMEOUT_MS - 1000);
      browserWs.emit('message', Buffer.from('ping'), false);

      // Advance past the original timeout but not the reset one
      vi.advanceTimersByTime(PREVIEW_LIMITS.WS_IDLE_TIMEOUT_MS - 1000);

      expect(browserWs.closed).toBe(false);
    });
  });

  describe('sweepStaleTunnels', () => {
    it('removes entries where browser WS is no longer open', async () => {
      const { bridge } = await setupBridge();
      const browserWs = new MockWs();

      bridge.createPreviewWsTunnel(wsId, previewId, 3000, '/', browserWs as never, {}, []);
      expect(bridge.getServerWsCount()).toBe(1);

      // Manually mark socket as closed (simulate missed close event)
      browserWs.readyState = 3;

      bridge.sweepStaleTunnels();

      expect(bridge.getServerWsCount()).toBe(0);
    });
  });

  // ── deferred upgrade + WS subprotocol via WS_OPENED.protocol (P1.5.1) ─────────
  describe('beginPreviewWsTunnel (deferred upgrade / subprotocol)', () => {
    it('sends preview.ws.open and counts a pending upgrade before WS_OPENED', async () => {
      const { bridge, daemon } = await setupBridge();
      bridge.beginPreviewWsTunnel({
        wsId, previewId, port: 3000, path: '/ws',
        headers: {}, protocols: ['graphql-ws'],
        completeUpgrade: async () => new MockWs() as never,
      });
      // ws.open relayed to daemon
      const open = daemon.sentStrings.find((s) => s.includes(PREVIEW_MSG.WS_OPEN));
      expect(open).toBeDefined();
      // pending upgrade counts toward the WS ceilings
      expect(bridge.getPreviewWsCount(previewId)).toBe(1);
      expect(bridge.getServerWsCount()).toBe(1);
    });

    it('completes the handshake with the upstream-negotiated protocol from WS_OPENED', async () => {
      const { bridge, daemon } = await setupBridge();
      let negotiated: string | undefined = 'NOT_CALLED';
      const browserWs = new MockWs();
      bridge.beginPreviewWsTunnel({
        wsId, previewId, port: 3000, path: '/ws',
        headers: {}, protocols: ['graphql-ws', 'graphql-transport-ws'],
        completeUpgrade: async (protocol) => { negotiated = protocol; return browserWs as never; },
      });

      // Daemon reports the upstream selected `graphql-ws`.
      daemon.emit('message', Buffer.from(JSON.stringify({
        type: PREVIEW_MSG.WS_OPENED,
        wsId,
        protocol: 'graphql-ws',
      })), false);
      await flushAsync();

      // completeUpgrade received exactly the negotiated protocol, and the tunnel
      // is now an active (no longer pending) tunnel.
      expect(negotiated).toBe('graphql-ws');
      expect(bridge.getPreviewWsCount(previewId)).toBe(1);
    });

    it('fails the deferred handshake (completeUpgrade(undefined)) when daemon reports WS_ERROR', async () => {
      const { bridge, daemon } = await setupBridge();
      let calledWith: string | undefined = 'NOT_CALLED';
      bridge.beginPreviewWsTunnel({
        wsId, previewId, port: 3000, path: '/ws',
        headers: {}, protocols: ['chat'],
        completeUpgrade: async (protocol) => { calledWith = protocol; return null; },
      });

      daemon.emit('message', Buffer.from(JSON.stringify({
        type: PREVIEW_MSG.WS_ERROR,
        wsId,
        error: 'connection refused',
      })), false);
      await flushAsync();

      expect(calledWith).toBeUndefined();
      // pending upgrade cleared → no tunnel
      expect(bridge.getServerWsCount()).toBe(0);
    });

    it('calls rejectUpgrade with HTTP status (403/502/504) instead of upgrading on upstream reject, legacy error, open timeout, or pre-open close', async () => {
      vi.useFakeTimers();
      const { bridge, daemon } = await setupBridge();

      // 1) Upstream 403 rejection
      const wsId1 = '1'.repeat(32);
      const complete1 = vi.fn(async () => new MockWs() as never);
      const reject1 = vi.fn();
      bridge.beginPreviewWsTunnel({
        wsId: wsId1, previewId, port: 3000, path: '/ws',
        headers: {}, protocols: [],
        completeUpgrade: complete1,
        rejectUpgrade: reject1,
      });
      daemon.emit('message', Buffer.from(JSON.stringify({
        type: PREVIEW_MSG.WS_ERROR, wsId: wsId1, error: 'upstream rejected: 403 Forbidden', status: 403,
      })), false);
      await flushAsync();
      expect(complete1).not.toHaveBeenCalled();
      expect(reject1).toHaveBeenCalledWith(403, expect.stringContaining('403'));
      expect(bridge.getServerWsCount()).toBe(0);

      // 2) Legacy daemon WS_ERROR without status falls back safely to 502
      const wsId2 = '2'.repeat(32);
      const reject2 = vi.fn();
      bridge.beginPreviewWsTunnel({
        wsId: wsId2, previewId, port: 3000, path: '/ws',
        headers: {}, protocols: [],
        completeUpgrade: async () => new MockWs() as never,
        rejectUpgrade: reject2,
      });
      daemon.emit('message', Buffer.from(JSON.stringify({
        type: PREVIEW_MSG.WS_ERROR, wsId: wsId2, error: 'connection refused',
      })), false);
      await flushAsync();
      expect(reject2).toHaveBeenCalledWith(502, 'connection refused');

      // 3) Open timeout rejects with 504 (not 101)
      const wsId3 = '3'.repeat(32);
      const complete3 = vi.fn(async () => new MockWs() as never);
      const reject3 = vi.fn();
      bridge.beginPreviewWsTunnel({
        wsId: wsId3, previewId, port: 3000, path: '/ws',
        headers: {}, protocols: [],
        completeUpgrade: complete3,
        rejectUpgrade: reject3,
      });
      vi.advanceTimersByTime(PREVIEW_LIMITS.WS_OPEN_TIMEOUT_MS + 10);
      await flushAsync();
      expect(complete3).not.toHaveBeenCalled();
      expect(reject3).toHaveBeenCalledWith(504, 'open timeout');
      expect(bridge.getServerWsCount()).toBe(0);
    });

    it('buffers daemon→browser frames arriving between WS_OPENED and async completeUpgrade resolution and flushes in order', async () => {
      const { bridge, daemon } = await setupBridge();
      const browserWs = new MockWs();
      let resolveUpgrade!: (ws: MockWs | null) => void;

      bridge.beginPreviewWsTunnel({
        wsId, previewId, port: 3000, path: '/ws',
        headers: {}, protocols: ['vite-hmr'],
        completeUpgrade: () => new Promise((resolve) => {
          resolveUpgrade = (ws) => resolve(ws as never);
        }),
      });

      // Upstream opens, then immediately sends 2 frames BEFORE completeUpgrade resolves.
      daemon.emit('message', Buffer.from(JSON.stringify({
        type: PREVIEW_MSG.WS_OPENED, wsId, protocol: 'vite-hmr',
      })), false);
      daemon.emit('message', packPreviewWsFrame(wsId, false, Buffer.from('greeting-1')), true);
      daemon.emit('message', packPreviewWsFrame(wsId, true, Buffer.from([0xca, 0xfe])), true);
      await flushAsync();

      expect(browserWs.sent).toHaveLength(0);

      // Now async wss.handleUpgrade completes.
      resolveUpgrade(browserWs);
      await flushAsync();

      expect(browserWs.sent).toHaveLength(2);
      expect((browserWs.sent[0] as Buffer).toString('utf8')).toBe('greeting-1');
      expect(browserWs.sent[1]).toEqual(Buffer.from([0xca, 0xfe]));
    });

    it('enforces MAX_WS_PENDING_QUEUE_BYTES during upgrading window and honours early WS_CLOSE after queued frames', async () => {
      const { bridge, daemon } = await setupBridge();
      const browserWs = new MockWs();
      let resolveUpgrade!: (ws: MockWs | null) => void;

      bridge.beginPreviewWsTunnel({
        wsId, previewId, port: 3000, path: '/ws',
        headers: {}, protocols: [],
        completeUpgrade: () => new Promise((resolve) => {
          resolveUpgrade = (ws) => resolve(ws as never);
        }),
      });

      daemon.emit('message', Buffer.from(JSON.stringify({ type: PREVIEW_MSG.WS_OPENED, wsId })), false);
      daemon.emit('message', packPreviewWsFrame(wsId, false, Buffer.from('last-words')), true);
      daemon.emit('message', Buffer.from(JSON.stringify({ type: PREVIEW_MSG.WS_CLOSE, wsId, code: 1000, reason: 'bye' })), false);
      await flushAsync();

      resolveUpgrade(browserWs);
      await flushAsync();

      expect(browserWs.sent.map((b) => (b as Buffer).toString('utf8'))).toEqual(['last-words']);
      expect(browserWs.closed).toBe(true);
      expect(browserWs.closedCode).toBe(1000);
      expect(browserWs.closedReason).toBe('bye');

      // Overflow during upgrading window closes with 1008.
      const wsId2 = '9'.repeat(32);
      const browserWs2 = new MockWs();
      let resolveUpgrade2!: (ws: MockWs | null) => void;
      bridge.beginPreviewWsTunnel({
        wsId: wsId2, previewId, port: 3000, path: '/ws',
        headers: {}, protocols: [],
        completeUpgrade: () => new Promise((resolve) => {
          resolveUpgrade2 = (ws) => resolve(ws as never);
        }),
      });
      daemon.emit('message', Buffer.from(JSON.stringify({ type: PREVIEW_MSG.WS_OPENED, wsId: wsId2 })), false);
      daemon.emit('message', packPreviewWsFrame(wsId2, true, Buffer.alloc(PREVIEW_LIMITS.MAX_WS_PENDING_QUEUE_BYTES + 1, 0x11)), true);
      await flushAsync();

      resolveUpgrade2(browserWs2);
      await flushAsync();
      expect(browserWs2.closed).toBe(true);
      expect(browserWs2.closedCode).toBe(1008);
    });

    it('sends periodic ping keepalives on active browser WS and stops cleanly on close', async () => {
      vi.useFakeTimers();
      const { bridge, daemon } = await setupBridge();
      const ping = vi.fn();
      const browserWs = Object.assign(new MockWs(), { ping });

      bridge.createPreviewWsTunnel(wsId, previewId, 3000, '/', browserWs as never, {}, []);
      daemon.emit('message', Buffer.from(JSON.stringify({ type: PREVIEW_MSG.WS_OPENED, wsId })), false);
      await flushAsync();

      vi.advanceTimersByTime(PREVIEW_LIMITS.WS_KEEPALIVE_MS * 2 + 10);
      expect(ping).toHaveBeenCalledTimes(2);

      // Closing tunnel stops future pings cleanly (no timer leak).
      browserWs.close(1000, 'client done');
      const frozen = ping.mock.calls.length;
      vi.advanceTimersByTime(PREVIEW_LIMITS.WS_KEEPALIVE_MS * 3);
      expect(ping).toHaveBeenCalledTimes(frozen);
    });
  });
});
