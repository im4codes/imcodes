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
    queryOne: async () => ({ token_hash: tokenHash }),
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
});
