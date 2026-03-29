import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws';
import { AddressInfo } from 'net';
import {
  PREVIEW_BINARY_FRAME,
  PREVIEW_LIMITS,
  PREVIEW_MSG,
  packPreviewWsFrame,
  parsePreviewWsFrame,
} from '../../shared/preview-types.js';
import { handlePreviewBinaryFrame, handlePreviewCommand } from '../../src/daemon/preview-relay.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function createServerLink() {
  return {
    send: vi.fn(),
    sendBinary: vi.fn(),
  };
}

/** Start a local WebSocket server on an OS-assigned port. Returns { wss, port, close }. */
function createUpstreamWss(): Promise<{ wss: WebSocketServer; port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on('listening', () => {
      const { port } = wss.address() as AddressInfo;
      resolve({
        wss,
        port,
        close: () => new Promise<void>((res) => {
          for (const client of wss.clients) {
            try { client.close(); } catch { /* ignore */ }
          }
          wss.close(() => res());
        }),
      });
    });
  });
}

/** Wait for a condition to become true (polling). */
async function waitFor(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const TEST_PREVIEW_ID = 'preview-ws-test';

/**
 * Generate a unique 32-char hex wsId per test.
 * The module-level activeWsTunnels Map persists across tests in the same worker,
 * so unique IDs prevent close-event handlers from one test polluting the next.
 */
function makeWsId(): string {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('daemon WS tunnel relay', () => {
  let upstream: Awaited<ReturnType<typeof createUpstreamWss>>;

  beforeEach(async () => {
    upstream = await createUpstreamWss();
  });

  afterEach(async () => {
    await upstream.close();
    vi.clearAllMocks();
  });

  // ── 5.1 / 5.2: Successful upstream connection ─────────────────────────────

  it('connects to upstream and sends preview.ws.opened', async () => {
    const wsId = makeWsId();
    const serverLink = createServerLink();

    handlePreviewCommand({
      type: PREVIEW_MSG.WS_OPEN,
      wsId,
      previewId: TEST_PREVIEW_ID,
      port: upstream.port,
      path: '/',
      headers: {},
      protocols: [],
    }, serverLink as never);

    await waitFor(() => serverLink.send.mock.calls.some((c) => (c[0] as { type: string }).type === PREVIEW_MSG.WS_OPENED));

    const openedCall = serverLink.send.mock.calls.find((c) => (c[0] as { type: string }).type === PREVIEW_MSG.WS_OPENED);
    expect(openedCall?.[0]).toMatchObject({ type: PREVIEW_MSG.WS_OPENED, wsId });
    // No error should have been sent.
    expect(serverLink.send.mock.calls.some((c) => (c[0] as { type: string }).type === PREVIEW_MSG.WS_ERROR)).toBe(false);
  });

  // ── 5.1: Connection failure → sends preview.ws.error ──────────────────────

  it('sends preview.ws.error when upstream is not listening', async () => {
    const wsId = makeWsId();
    const serverLink = createServerLink();
    // Use a port that has nothing listening.
    const unusedPort = upstream.port + 1000;

    handlePreviewCommand({
      type: PREVIEW_MSG.WS_OPEN,
      wsId,
      previewId: TEST_PREVIEW_ID,
      port: unusedPort,
      path: '/',
      headers: {},
      protocols: [],
    }, serverLink as never);

    await waitFor(() => serverLink.send.mock.calls.some((c) => (c[0] as { type: string }).type === PREVIEW_MSG.WS_ERROR), 3000);

    const errCall = serverLink.send.mock.calls.find((c) => (c[0] as { type: string }).type === PREVIEW_MSG.WS_ERROR);
    expect(errCall?.[0]).toMatchObject({ type: PREVIEW_MSG.WS_ERROR, wsId });
    expect(typeof (errCall?.[0] as { error: string }).error).toBe('string');
  });

  // ── 5.1: Port mismatch rejection ──────────────────────────────────────────

  it('sends preview.ws.error on port mismatch', async () => {
    const wsId = makeWsId();
    const serverLink = createServerLink();
    const mismatchPreviewId = `preview-mismatch-${wsId}`;

    // Register the preview with a specific port by sending an HTTP request message.
    handlePreviewCommand({
      type: PREVIEW_MSG.REQUEST,
      requestId: `req-port-check-${wsId}`,
      previewId: mismatchPreviewId,
      port: 9999,
      method: 'GET',
      path: '/',
      headers: {},
      hasBody: false,
    }, serverLink as never);

    // Now try to open WS with a different port — should be rejected.
    const serverLink2 = createServerLink();
    handlePreviewCommand({
      type: PREVIEW_MSG.WS_OPEN,
      wsId,
      previewId: mismatchPreviewId,
      port: 1234, // mismatch!
      path: '/',
      headers: {},
      protocols: [],
    }, serverLink2 as never);

    // Should have been rejected synchronously (within current tick).
    await new Promise((r) => setTimeout(r, 10));
    const errCall = serverLink2.send.mock.calls.find((c) => (c[0] as { type: string }).type === PREVIEW_MSG.WS_ERROR);
    expect(errCall?.[0]).toMatchObject({ type: PREVIEW_MSG.WS_ERROR, wsId, error: 'port mismatch' });
  });

  // ── 5.1: Invalid port rejected ────────────────────────────────────────────

  it('sends preview.ws.error on out-of-range port', async () => {
    const wsId = makeWsId();
    const serverLink = createServerLink();

    handlePreviewCommand({
      type: PREVIEW_MSG.WS_OPEN,
      wsId,
      previewId: TEST_PREVIEW_ID,
      port: 99999, // invalid
      path: '/',
      headers: {},
      protocols: [],
    }, serverLink as never);

    await new Promise((r) => setTimeout(r, 10));
    const errCall = serverLink.send.mock.calls.find((c) => (c[0] as { type: string }).type === PREVIEW_MSG.WS_ERROR);
    expect(errCall?.[0]).toMatchObject({ type: PREVIEW_MSG.WS_ERROR, wsId, error: 'invalid port' });
  });

  // ── 5.1: Path normalization ───────────────────────────────────────────────

  it('normalizes path before connecting (///ws → /ws)', async () => {
    const wsId = makeWsId();
    const serverLink = createServerLink();
    const receivedPaths: string[] = [];

    upstream.wss.on('connection', (_ws, req) => {
      receivedPaths.push(req.url ?? '');
    });

    handlePreviewCommand({
      type: PREVIEW_MSG.WS_OPEN,
      wsId,
      previewId: TEST_PREVIEW_ID,
      port: upstream.port,
      path: '///ws',
      headers: {},
      protocols: [],
    }, serverLink as never);

    await waitFor(() => serverLink.send.mock.calls.some((c) => (c[0] as { type: string }).type === PREVIEW_MSG.WS_OPENED));
    expect(receivedPaths[0]).toBe('/ws');
  });

  // ── 5.3: Upstream → daemon (text message) ─────────────────────────────────

  it('relays upstream text message to server as WS_DATA binary frame', async () => {
    const wsId = makeWsId();
    const serverLink = createServerLink();
    let upstreamConn: WsWebSocket | null = null;

    upstream.wss.on('connection', (ws) => {
      upstreamConn = ws;
    });

    handlePreviewCommand({
      type: PREVIEW_MSG.WS_OPEN,
      wsId,
      previewId: TEST_PREVIEW_ID,
      port: upstream.port,
      path: '/',
      headers: {},
      protocols: [],
    }, serverLink as never);

    await waitFor(() => upstreamConn !== null);
    await waitFor(() => serverLink.send.mock.calls.some((c) => (c[0] as { type: string }).type === PREVIEW_MSG.WS_OPENED));

    upstreamConn!.send('hello world');

    await waitFor(() => serverLink.sendBinary.mock.calls.length > 0);

    const frame = serverLink.sendBinary.mock.calls[0][0] as Buffer;
    expect(frame[0]).toBe(PREVIEW_BINARY_FRAME.WS_DATA);
    const parsed = parsePreviewWsFrame(frame);
    expect(parsed).not.toBeNull();
    expect(parsed!.wsId).toBe(wsId);
    expect(parsed!.isBinary).toBe(false);
    expect(parsed!.payload.toString('utf8')).toBe('hello world');
  });

  // ── 5.3: Upstream → daemon (binary message) ───────────────────────────────

  it('relays upstream binary message with binary flag set', async () => {
    const wsId = makeWsId();
    const serverLink = createServerLink();
    let upstreamConn: WsWebSocket | null = null;

    upstream.wss.on('connection', (ws) => {
      upstreamConn = ws;
    });

    handlePreviewCommand({
      type: PREVIEW_MSG.WS_OPEN,
      wsId,
      previewId: TEST_PREVIEW_ID,
      port: upstream.port,
      path: '/',
      headers: {},
      protocols: [],
    }, serverLink as never);

    await waitFor(() => upstreamConn !== null);
    await waitFor(() => serverLink.send.mock.calls.some((c) => (c[0] as { type: string }).type === PREVIEW_MSG.WS_OPENED));

    upstreamConn!.send(Buffer.from([0x01, 0x02, 0x03]));

    await waitFor(() => serverLink.sendBinary.mock.calls.length > 0);

    const frame = serverLink.sendBinary.mock.calls[0][0] as Buffer;
    const parsed = parsePreviewWsFrame(frame);
    expect(parsed).not.toBeNull();
    expect(parsed!.isBinary).toBe(true);
    expect(parsed!.payload).toEqual(Buffer.from([0x01, 0x02, 0x03]));
  });

  // ── 5.4: Daemon → upstream (text) ─────────────────────────────────────────

  it('forwards text WS_DATA frame from server to upstream', async () => {
    const wsId = makeWsId();
    const serverLink = createServerLink();
    const received: Array<{ data: Buffer | string; isBinary: boolean }> = [];
    let upstreamConn: WsWebSocket | null = null;

    upstream.wss.on('connection', (ws) => {
      upstreamConn = ws;
      ws.on('message', (data, isBinary) => {
        received.push({ data: data as Buffer, isBinary });
      });
    });

    handlePreviewCommand({
      type: PREVIEW_MSG.WS_OPEN,
      wsId,
      previewId: TEST_PREVIEW_ID,
      port: upstream.port,
      path: '/',
      headers: {},
      protocols: [],
    }, serverLink as never);

    await waitFor(() => upstreamConn !== null);
    await waitFor(() => serverLink.send.mock.calls.some((c) => (c[0] as { type: string }).type === PREVIEW_MSG.WS_OPENED));

    // Server sends a WS_DATA text frame to daemon.
    const frame = packPreviewWsFrame(wsId, false, Buffer.from('from server'));
    handlePreviewBinaryFrame(frame, serverLink as never);

    await waitFor(() => received.length > 0);
    expect(received[0].isBinary).toBe(false);
    expect(received[0].data.toString()).toBe('from server');
  });

  // ── 5.4: Daemon → upstream (binary) ───────────────────────────────────────

  it('forwards binary WS_DATA frame to upstream with binary flag', async () => {
    const wsId = makeWsId();
    const serverLink = createServerLink();
    const received: Array<{ data: Buffer; isBinary: boolean }> = [];
    let upstreamConn: WsWebSocket | null = null;

    upstream.wss.on('connection', (ws) => {
      upstreamConn = ws;
      ws.on('message', (data, isBinary) => {
        received.push({ data: data as Buffer, isBinary });
      });
    });

    handlePreviewCommand({
      type: PREVIEW_MSG.WS_OPEN,
      wsId,
      previewId: TEST_PREVIEW_ID,
      port: upstream.port,
      path: '/',
      headers: {},
      protocols: [],
    }, serverLink as never);

    await waitFor(() => upstreamConn !== null);
    await waitFor(() => serverLink.send.mock.calls.some((c) => (c[0] as { type: string }).type === PREVIEW_MSG.WS_OPENED));

    const frame = packPreviewWsFrame(wsId, true, Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]));
    handlePreviewBinaryFrame(frame, serverLink as never);

    await waitFor(() => received.length > 0);
    expect(received[0].isBinary).toBe(true);
    expect(received[0].data).toEqual(Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]));
  });

  // ── 5.6: Upstream close (standard code) ───────────────────────────────────

  it('sends preview.ws.close when upstream closes with code 1000', async () => {
    const wsId = makeWsId();
    const serverLink = createServerLink();
    let upstreamConn: WsWebSocket | null = null;

    upstream.wss.on('connection', (ws) => {
      upstreamConn = ws;
    });

    handlePreviewCommand({
      type: PREVIEW_MSG.WS_OPEN,
      wsId,
      previewId: TEST_PREVIEW_ID,
      port: upstream.port,
      path: '/',
      headers: {},
      protocols: [],
    }, serverLink as never);

    await waitFor(() => upstreamConn !== null);
    await waitFor(() => serverLink.send.mock.calls.some((c) => (c[0] as { type: string }).type === PREVIEW_MSG.WS_OPENED));

    upstreamConn!.close(1000, 'done');

    await waitFor(() => serverLink.send.mock.calls.some((c) => (c[0] as { type: string }).type === PREVIEW_MSG.WS_CLOSE));

    const closeCall = serverLink.send.mock.calls.find((c) => (c[0] as { type: string }).type === PREVIEW_MSG.WS_CLOSE);
    expect(closeCall?.[0]).toMatchObject({ type: PREVIEW_MSG.WS_CLOSE, wsId, code: 1000, reason: 'done' });
  });

  // ── 5.6: Upstream close with custom code (4000-4999) ─────────────────────

  it('passes through custom close code 4001 verbatim', async () => {
    const wsId = makeWsId();
    const serverLink = createServerLink();
    let upstreamConn: WsWebSocket | null = null;

    upstream.wss.on('connection', (ws) => {
      upstreamConn = ws;
    });

    handlePreviewCommand({
      type: PREVIEW_MSG.WS_OPEN,
      wsId,
      previewId: TEST_PREVIEW_ID,
      port: upstream.port,
      path: '/',
      headers: {},
      protocols: [],
    }, serverLink as never);

    await waitFor(() => upstreamConn !== null);
    await waitFor(() => serverLink.send.mock.calls.some((c) => (c[0] as { type: string }).type === PREVIEW_MSG.WS_OPENED));

    upstreamConn!.close(4001, 'session expired');

    await waitFor(() => serverLink.send.mock.calls.some((c) => (c[0] as { type: string }).type === PREVIEW_MSG.WS_CLOSE));

    const closeCall = serverLink.send.mock.calls.find((c) => (c[0] as { type: string }).type === PREVIEW_MSG.WS_CLOSE);
    expect(closeCall?.[0]).toMatchObject({ type: PREVIEW_MSG.WS_CLOSE, wsId, code: 4001, reason: 'session expired' });
  });

  // ── 5.5: Server-side close forwarded to upstream ─────────────────────────

  it('closes upstream when preview.ws.close received from server', async () => {
    const wsId = makeWsId();
    const serverLink = createServerLink();
    let upstreamConn: WsWebSocket | null = null;
    const upstreamCloseCodes: number[] = [];

    upstream.wss.on('connection', (ws) => {
      upstreamConn = ws;
      ws.on('close', (code) => {
        upstreamCloseCodes.push(code);
      });
    });

    handlePreviewCommand({
      type: PREVIEW_MSG.WS_OPEN,
      wsId,
      previewId: TEST_PREVIEW_ID,
      port: upstream.port,
      path: '/',
      headers: {},
      protocols: [],
    }, serverLink as never);

    await waitFor(() => upstreamConn !== null);
    await waitFor(() => serverLink.send.mock.calls.some((c) => (c[0] as { type: string }).type === PREVIEW_MSG.WS_OPENED));

    handlePreviewCommand({
      type: PREVIEW_MSG.WS_CLOSE,
      wsId,
      code: 1001,
      reason: 'going away',
    }, serverLink as never);

    await waitFor(() => upstreamCloseCodes.length > 0);
    expect(upstreamCloseCodes[0]).toBe(1001);
  });

  // ── Message size enforcement (upstream → server) ──────────────────────────

  it('closes tunnel with code 1009 when upstream sends message over 1MB', async () => {
    const wsId = makeWsId();
    const serverLink = createServerLink();
    let upstreamConn: WsWebSocket | null = null;

    upstream.wss.on('connection', (ws) => {
      upstreamConn = ws;
    });

    handlePreviewCommand({
      type: PREVIEW_MSG.WS_OPEN,
      wsId,
      previewId: TEST_PREVIEW_ID,
      port: upstream.port,
      path: '/',
      headers: {},
      protocols: [],
    }, serverLink as never);

    await waitFor(() => upstreamConn !== null);
    await waitFor(() => serverLink.send.mock.calls.some((c) => (c[0] as { type: string }).type === PREVIEW_MSG.WS_OPENED));

    // Send a message just over the 1MB limit.
    const huge = Buffer.alloc(PREVIEW_LIMITS.MAX_WS_MESSAGE_BYTES + 1, 0x41);
    upstreamConn!.send(huge);

    await waitFor(() => serverLink.send.mock.calls.some((c) => (c[0] as { type: string }).type === PREVIEW_MSG.WS_CLOSE));

    const closeCall = serverLink.send.mock.calls.find((c) => (c[0] as { type: string }).type === PREVIEW_MSG.WS_CLOSE);
    expect(closeCall?.[0]).toMatchObject({ type: PREVIEW_MSG.WS_CLOSE, wsId, code: 1009 });
  });

  // ── Message size enforcement (server → upstream) ──────────────────────────

  it('closes tunnel with code 1009 when server sends WS_DATA frame over 1MB', async () => {
    const wsId = makeWsId();
    const serverLink = createServerLink();
    let upstreamConn: WsWebSocket | null = null;

    upstream.wss.on('connection', (ws) => {
      upstreamConn = ws;
    });

    handlePreviewCommand({
      type: PREVIEW_MSG.WS_OPEN,
      wsId,
      previewId: TEST_PREVIEW_ID,
      port: upstream.port,
      path: '/',
      headers: {},
      protocols: [],
    }, serverLink as never);

    await waitFor(() => upstreamConn !== null);
    await waitFor(() => serverLink.send.mock.calls.some((c) => (c[0] as { type: string }).type === PREVIEW_MSG.WS_OPENED));

    const huge = Buffer.alloc(PREVIEW_LIMITS.MAX_WS_MESSAGE_BYTES + 1, 0x42);
    const frame = packPreviewWsFrame(wsId, true, huge);
    handlePreviewBinaryFrame(frame, serverLink as never);

    await waitFor(() => serverLink.send.mock.calls.some((c) => (c[0] as { type: string }).type === PREVIEW_MSG.WS_CLOSE));

    const closeCall = serverLink.send.mock.calls.find((c) => (c[0] as { type: string }).type === PREVIEW_MSG.WS_CLOSE);
    expect(closeCall?.[0]).toMatchObject({ type: PREVIEW_MSG.WS_CLOSE, wsId, code: 1009 });
  });

  // ── UUID-format wsId normalization ────────────────────────────────────────

  it('handles UUID-format wsId (with dashes) transparently', async () => {
    const serverLink = createServerLink();
    // Use a UUID-format wsId — the normalized hex part is unique enough.
    const base = makeWsId();
    const uuidWsId = `${base.slice(0, 8)}-${base.slice(8, 12)}-${base.slice(12, 16)}-${base.slice(16, 20)}-${base.slice(20)}`;

    handlePreviewCommand({
      type: PREVIEW_MSG.WS_OPEN,
      wsId: uuidWsId,
      previewId: TEST_PREVIEW_ID,
      port: upstream.port,
      path: '/',
      headers: {},
      protocols: [],
    }, serverLink as never);

    await waitFor(() => serverLink.send.mock.calls.some((c) => (c[0] as { type: string }).type === PREVIEW_MSG.WS_OPENED));

    const openedCall = serverLink.send.mock.calls.find((c) => (c[0] as { type: string }).type === PREVIEW_MSG.WS_OPENED);
    // wsId in the reply should preserve the original format the server sent.
    expect(openedCall?.[0]).toMatchObject({ type: PREVIEW_MSG.WS_OPENED, wsId: uuidWsId });
  });
});
