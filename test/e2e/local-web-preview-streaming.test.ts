/**
 * E2E — Local Web Preview streaming protocols against REAL dev-server-shaped
 * upstreams (run 8a975732-23a, tasks.md R.3 "E2E 应用矩阵:Vite HMR(WS) / 原生
 * EventSource SSE / webpack-dev-server").
 *
 * Unlike the per-side unit tests (`test/daemon/preview-relay.test.ts`,
 * `server/test/bridge-preview*.test.ts`, `server/test/local-web-preview-stream.test.ts`)
 * which mock one half, this wires the REAL daemon relay (`src/daemon/preview-relay.ts`)
 * to the REAL server bridge (`server/src/ws/bridge.ts`) through the REAL wire
 * protocol (PREVIEW_MSG frames + binary RESPONSE_BODY / WS_DATA frames), and
 * drives them against REAL loopback `http`/`ws` upstreams that behave like the
 * dev servers we must support:
 *
 *   - native EventSource SSE / webpack-hot-middleware  → `text/event-stream`
 *   - streaming NDJSON logs                            → `application/x-ndjson`
 *   - Vite HMR                                         → WebSocket + subprotocol
 *   - webpack-dev-server live-reload                   → WebSocket (binary frames)
 *
 * The only pieces NOT real are (a) the browser socket (a MockWs) and (b) the
 * daemon↔server network hop, replaced by an in-memory `EventEmitter` link that
 * carries the SAME frames a production WS would. Everything else — undici
 * `fetch` to the upstream, the `ws` client→upstream handshake + subprotocol
 * negotiation, the shared `isStreamingResponse` classifier on BOTH sides, the
 * cumulative byte-cap exemption, and the server-side unconsumed-buffer cap — is
 * the production code path.
 *
 * NOTE: this file deliberately does NOT use the `SKIP_TMUX_TESTS` / `CLAUDECODE`
 * guard the other e2e files use: the preview proxy is independent of tmux/agent
 * sessions, so it runs anywhere Node + loopback sockets work (incl. CI and inside
 * a Claude Code session). It creates NO tmux/main/sub sessions or temp cwds, so
 * `shared/test-session-guard.ts` does not apply.
 *
 * Discovered constraint that shapes the matrix: undici `fetch` consumes/strips
 * the hop-by-hop `Transfer-Encoding` header, so a real chunked upstream does NOT
 * surface `transfer-encoding: chunked` to the relay. Streaming classification is
 * therefore exercised via the MIME-based signals (`text/event-stream`,
 * `application/x-ndjson`) which ARE reliable end-to-end; the chunked+JSON
 * exclusion / "no-Content-Length-not-sufficient" rules stay covered by the unit
 * tests, and the non-streaming byte-cap path is exercised here via a JSON body.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws';

// Auth + push are mocked exactly like the bridge unit tests so the daemon
// handshake passes without a real DB / APNs.
vi.mock('../../server/src/security/crypto.js', () => ({
  sha256Hex: () => 'valid-hash',
  randomHex: (n = 32) => 'a'.repeat(n),
}));
vi.mock('../../server/src/routes/push.js', () => ({ dispatchPush: vi.fn() }));

// ── In-memory daemon↔server link (carries real frames) ──────────────────────

/**
 * Stands in for the production daemon WebSocket as the bridge sees it. The
 * bridge calls `.send(data)` to talk to the daemon; we route that straight into
 * the real daemon relay handlers. The bridge listens to our `'message'` events
 * for daemon→server frames.
 */
class DaemonLink extends EventEmitter {
  readyState = 1; // OPEN
  route: (data: string | Buffer) => void = () => {};
  send(data: string | Buffer, optsOrCb?: unknown, cb?: (err?: Error) => void): void {
    const callback = typeof optsOrCb === 'function' ? (optsOrCb as (e?: Error) => void) : cb;
    try {
      this.route(data);
      callback?.();
    } catch (err) {
      callback?.(err as Error);
    }
  }
  close(code?: number, reason?: string): void {
    this.readyState = 3; // CLOSED
    this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
  }
}

/** Browser-facing socket the bridge relays to (text/binary recorded for asserts). */
class MockBrowserWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  closed = false;
  closedCode: number | undefined;
  closedReason: string | undefined;
  readyState = 1;
  send(data: string | Buffer, optsOrCb?: unknown, cb?: (err?: Error) => void): void {
    const callback = typeof optsOrCb === 'function' ? (optsOrCb as (e?: Error) => void) : cb;
    if (this.closed) { callback?.(new Error('closed')); return; }
    this.sent.push(data);
    callback?.();
  }
  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closedCode = code;
    this.closedReason = reason;
    this.readyState = 3;
    this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
  }
  get sentStrings(): string[] { return this.sent.filter((s): s is string => typeof s === 'string'); }
  get sentBuffers(): Buffer[] { return this.sent.filter((s): s is Buffer => Buffer.isBuffer(s)); }
  /**
   * All frames decoded to text. The bridge relays WS frames to the browser as
   * `browserWs.send(payload, { binary })` where `payload` is ALWAYS a Buffer
   * (byte-oriented) — even for upstream text frames — so a real text payload
   * lands here as a Buffer, not a JS string. Decode both for content asserts.
   */
  get sentText(): string[] {
    return this.sent.map((s) => (Buffer.isBuffer(s) ? s.toString('utf8') : s));
  }
}

function makeDb() {
  return {
    queryOne: async () => ({ token_hash: 'valid-hash', user_id: 'u' }),
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    close: () => {},
  } as unknown as import('../../server/src/db/client.js').Database;
}

async function flushAsync(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => process.nextTick(r));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
}

// ── Real loopback upstreams ──────────────────────────────────────────────────

interface HttpUpstream { port: number; close: () => Promise<void>; }

async function startHttpUpstream(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<HttpUpstream> {
  const server: HttpServer = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

interface WsUpstream { port: number; close: () => Promise<void>; }

/**
 * A Vite/webpack-style HMR WebSocket upstream: negotiates a subprotocol, greets
 * with a `connected` message on open, and echoes whatever it receives (so the
 * test can assert a full browser→upstream→browser round trip).
 */
async function startWsUpstream(opts: { selectProtocol?: string } = {}): Promise<WsUpstream> {
  const wss = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    handleProtocols: (protocols: Set<string>) => {
      const offered = protocols instanceof Set ? [...protocols] : Array.from(protocols ?? []);
      if (opts.selectProtocol && offered.includes(opts.selectProtocol)) return opts.selectProtocol;
      return offered.length > 0 ? offered[0] : false;
    },
  });
  await new Promise<void>((resolve) => wss.on('listening', () => resolve()));
  wss.on('connection', (ws: WsWebSocket) => {
    try { ws.send(JSON.stringify({ type: 'connected' })); } catch { /* ignore */ }
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      // Echo back verbatim, preserving text/binary framing.
      try { ws.send(data, { binary: isBinary }); } catch { /* ignore */ }
    });
  });
  const port = (wss.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => {
      for (const c of wss.clients) { try { c.terminate(); } catch { /* ignore */ } }
      wss.close(() => resolve());
    }),
  };
}

// ── Wiring: real daemon relay ↔ real server bridge ───────────────────────────

async function setup() {
  // Fresh module graph each test so the daemon relay's module-level maps and the
  // env-driven PREVIEW_LIMITS (read at module eval) are isolated per test.
  vi.resetModules();
  const [bridgeMod, relay, types] = await Promise.all([
    import('../../server/src/ws/bridge.js'),
    import('../../src/daemon/preview-relay.js'),
    import('../../shared/preview-types.js'),
  ]);
  const { WsBridge } = bridgeMod;

  const serverId = `preview-e2e-${Math.random().toString(36).slice(2)}`;
  const previewId = 'preview-' + 'b'.repeat(16);
  const bridge = WsBridge.get(serverId);

  const daemonToBridge: Array<Record<string, unknown>> = [];
  const bridgeToDaemon: Array<Record<string, unknown>> = [];

  const daemonLink = new DaemonLink();
  // Daemon → server: the relay's ServerLink surface. Forward as the real frames.
  const fakeServerLink = {
    send: (obj: Record<string, unknown>) => {
      daemonToBridge.push(obj);
      daemonLink.emit('message', Buffer.from(JSON.stringify(obj)), false);
    },
    sendBinary: (buf: Uint8Array) => {
      daemonLink.emit('message', Buffer.from(buf), true);
    },
  };
  // Server → daemon: route bridge sends straight into the real relay entrypoints.
  daemonLink.route = (data: string | Buffer) => {
    if (typeof data === 'string') {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      bridgeToDaemon.push(parsed);
      relay.handlePreviewCommand(parsed, fakeServerLink as never);
    } else if (Buffer.isBuffer(data)) {
      relay.handlePreviewBinaryFrame(data, fakeServerLink as never);
    }
  };

  bridge.handleDaemonConnection(daemonLink as never, makeDb(), {} as never);
  daemonLink.emit('message', Buffer.from(JSON.stringify({ type: 'auth', serverId, token: 't' })), false);
  await flushAsync();

  /** Inject the PREVIEW_MSG.REQUEST the HTTP route would forward to the daemon. */
  const injectHttpRequest = (requestId: string, port: number, path: string, method = 'GET') => {
    relay.handlePreviewCommand({
      type: types.PREVIEW_MSG.REQUEST,
      requestId,
      previewId,
      port,
      method,
      path,
      headers: {},
      hasBody: false,
    } as Record<string, unknown>, fakeServerLink as never);
  };

  return { bridge, types, serverId, previewId, daemonToBridge, bridgeToDaemon, injectHttpRequest, WsBridge };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('E2E: Local Web Preview streaming protocols (real upstreams, real daemon↔bridge wire)', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) {
      try { await c(); } catch { /* ignore */ }
    }
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  // ── 1. SSE (native EventSource / webpack-hot-middleware / Astro) ───────────
  it('streams a real text/event-stream end-to-end, incrementally, EXEMPT from the cumulative byte cap', async () => {
    // Tiny cumulative cap so the real SSE stream trivially exceeds it. If the
    // shared classifier failed to mark SSE as streaming on EITHER side, the byte
    // cap would abort it and we would never see all 8 events + RESPONSE_END.
    vi.stubEnv('PREVIEW_MAX_RESPONSE_BYTES', '16');

    const TOTAL = 8;
    const upstream = await startHttpUpstream((req, res) => {
      if (!req.url?.startsWith('/events')) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: 0\n\n'); // first event flushed immediately
      let i = 1;
      const timer = setInterval(() => {
        if (i >= TOTAL) { clearInterval(timer); res.end(); return; }
        res.write(`data: ${i}\n\n`);
        i += 1;
      }, 10);
      res.on('close', () => clearInterval(timer));
    });
    cleanups.push(() => upstream.close());

    const { bridge, types, previewId, daemonToBridge, injectHttpRequest, WsBridge } = await setup();
    cleanups.push(() => WsBridge.getAll().clear());

    const requestId = 'sse-1';
    const relay = bridge.createPreviewRelay(requestId, previewId, 10_000);
    // Cross-tier liveness (P1.4): a live relay must mark the preview non-idle.
    expect(bridge.hasActivePreviewRelay(previewId)).toBe(true);
    injectHttpRequest(requestId, upstream.port, '/events');

    const started = await relay.start;
    expect(started.status).toBe(200);
    expect(String((started.headers as Record<string, string>)['content-type'])).toContain('text/event-stream');

    const reader = started.body.getReader();
    // First event arrives BEFORE the upstream has sent the rest (it withholds
    // events 1..N behind a 10ms interval) — proving incremental, non-buffered flow.
    const first = await reader.read();
    expect(Buffer.from(first.value ?? []).toString()).toContain('data: 0');

    let acc = Buffer.from(first.value ?? []);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) acc = Buffer.concat([acc, Buffer.from(value)]);
    }

    const text = acc.toString();
    for (let i = 0; i < TOTAL; i++) expect(text).toContain(`data: ${i}`);
    expect(acc.byteLength).toBeGreaterThan(16); // genuinely exceeded the cap

    // No LIMIT_EXCEEDED was reported by the daemon; the stream completed cleanly.
    expect(daemonToBridge.some((m) => m.type === types.PREVIEW_MSG.ERROR && m.requestId === requestId)).toBe(false);
    expect(daemonToBridge.some((m) => m.type === types.PREVIEW_MSG.RESPONSE_END && m.requestId === requestId)).toBe(true);
    // Relay settled → preview is idle again.
    expect(bridge.hasActivePreviewRelay(previewId)).toBe(false);
  });

  // ── 2. NDJSON streaming logs ───────────────────────────────────────────────
  it('streams a real application/x-ndjson response end-to-end, EXEMPT from the cumulative byte cap', async () => {
    vi.stubEnv('PREVIEW_MAX_RESPONSE_BYTES', '16');

    const TOTAL = 6;
    const upstream = await startHttpUpstream((req, res) => {
      if (!req.url?.startsWith('/logs')) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      for (let i = 0; i < TOTAL; i++) res.write(JSON.stringify({ n: i }) + '\n');
      res.end();
    });
    cleanups.push(() => upstream.close());

    const { bridge, types, previewId, daemonToBridge, injectHttpRequest, WsBridge } = await setup();
    cleanups.push(() => WsBridge.getAll().clear());

    const requestId = 'ndjson-1';
    const relay = bridge.createPreviewRelay(requestId, previewId, 10_000);
    injectHttpRequest(requestId, upstream.port, '/logs');

    const started = await relay.start;
    expect(started.status).toBe(200);

    let acc = Buffer.alloc(0);
    const reader = started.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) acc = Buffer.concat([acc, Buffer.from(value)]);
    }
    const lines = acc.toString().trim().split('\n');
    expect(lines).toHaveLength(TOTAL);
    expect(JSON.parse(lines[0])).toEqual({ n: 0 });
    expect(acc.byteLength).toBeGreaterThan(16);
    expect(daemonToBridge.some((m) => m.type === types.PREVIEW_MSG.ERROR && m.requestId === requestId)).toBe(false);
    expect(daemonToBridge.some((m) => m.type === types.PREVIEW_MSG.RESPONSE_END && m.requestId === requestId)).toBe(true);
  });

  // ── 3. Non-streaming JSON over the cap → LIMIT_EXCEEDED (classifier negative) ─
  it('still enforces the cumulative byte cap on a real non-streaming (application/json) response', async () => {
    vi.stubEnv('PREVIEW_MAX_RESPONSE_BYTES', '16');

    const upstream = await startHttpUpstream((req, res) => {
      if (!req.url?.startsWith('/api')) { res.writeHead(404).end(); return; }
      const body = JSON.stringify({ items: Array.from({ length: 40 }, (_v, i) => i) }); // >> 16 bytes
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) });
      res.end(body);
    });
    cleanups.push(() => upstream.close());

    const { bridge, types, previewId, daemonToBridge, injectHttpRequest, WsBridge } = await setup();
    cleanups.push(() => WsBridge.getAll().clear());

    const requestId = 'json-cap';
    const relay = bridge.createPreviewRelay(requestId, previewId, 10_000);
    injectHttpRequest(requestId, upstream.port, '/api');

    // RESPONSE_START still resolves (status/headers precede the body cap trip).
    const started = await relay.start;
    expect(started.status).toBe(200);

    // Draining the body rejects (errored controller — not a silent truncation).
    await expect((async () => {
      const reader = started.body.getReader();
      for (;;) { const { done } = await reader.read(); if (done) break; }
    })()).rejects.toBeTruthy();

    // The daemon reported LIMIT_EXCEEDED for this non-streaming response.
    expect(daemonToBridge.some((m) =>
      m.type === types.PREVIEW_MSG.ERROR
      && m.requestId === requestId
      && m.code === types.PREVIEW_ERROR.LIMIT_EXCEEDED,
    )).toBe(true);
  });

  // ── 4. Vite HMR: WebSocket + subprotocol negotiation + bidirectional frames ─
  it('negotiates a WS subprotocol against a real ws upstream and relays frames both ways (Vite HMR shape)', async () => {
    const upstream = await startWsUpstream({ selectProtocol: 'vite-hmr' });
    cleanups.push(() => upstream.close());

    const { bridge, previewId, WsBridge } = await setup();
    cleanups.push(() => WsBridge.getAll().clear());

    const wsId = 'a'.repeat(32);
    const browserWs = new MockBrowserWs();
    cleanups.push(() => { try { browserWs.close(); } catch { /* ignore */ } });

    let negotiated: string | undefined = 'NOT_CALLED';
    // Deferred upgrade: the browser handshake completes only once the daemon has
    // negotiated the upstream subprotocol and reported it via WS_OPENED.protocol.
    bridge.beginPreviewWsTunnel({
      wsId,
      previewId,
      port: upstream.port,
      path: '/',
      headers: {},
      protocols: ['vite-hmr'],
      completeUpgrade: async (protocol) => { negotiated = protocol; return browserWs as never; },
    });

    // Real ws handshake → upstream selects `vite-hmr` → WS_OPENED.protocol echoes it.
    await waitFor(() => negotiated !== 'NOT_CALLED', 10_000, 'ws handshake completes');
    expect(negotiated).toBe('vite-hmr');

    // Browser → upstream → browser round trip (HMR-style text frame). The deferred
    // upgrade adopts the browser socket on a microtask AFTER WS_OPENED, so retry
    // the send until the active tunnel relays it: an early ping lands before the
    // bridge has wired `browserWs` and is harmlessly dropped — exactly like a real
    // browser, which is not connected until the upgrade completes. The echo coming
    // back is itself a daemon→browser delivery, so this proves BOTH directions.
    let echoed = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !echoed) {
      browserWs.emit('message', Buffer.from(JSON.stringify({ type: 'ping', id: 7 })), false);
      await new Promise((r) => setTimeout(r, 50));
      echoed = browserWs.sentText.some((s) => s.includes('"type":"ping"') && s.includes('"id":7'));
    }
    expect(echoed).toBe(true);

    expect(bridge.getPreviewWsCount(previewId)).toBe(1);
  });

  // ── 5. webpack-dev-server live-reload: WS binary frame round trip ──────────
  it('relays a real WS binary frame round trip against a ws upstream (webpack-dev-server shape)', async () => {
    const upstream = await startWsUpstream(); // no subprotocol
    cleanups.push(() => upstream.close());

    const { bridge, previewId, WsBridge } = await setup();
    cleanups.push(() => WsBridge.getAll().clear());

    const wsId = 'c'.repeat(32);
    const browserWs = new MockBrowserWs();
    cleanups.push(() => { try { browserWs.close(); } catch { /* ignore */ } });

    bridge.createPreviewWsTunnel(wsId, previewId, upstream.port, '/ws', browserWs as never, {}, []);

    // Wait for the daemon→upstream handshake + greeting to reach the browser.
    await waitFor(() => browserWs.sentText.some((s) => s.includes('connected')), 10_000, 'connected greeting');

    const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    browserWs.emit('message', payload, true); // binary frame from browser
    await waitFor(
      () => browserWs.sentBuffers.some((b) => b.equals(payload)),
      10_000,
      'binary echo',
    );
  });

  // ── 6. Server-side unconsumed-buffer cap: slow consumer is deterministically closed ─
  it('deterministically closes a real SSE stream when a slow consumer exceeds MAX_PREVIEW_STREAM_BUFFER_BYTES', async () => {
    // Small unconsumed-buffer high-watermark; leave the cumulative byte cap at its
    // (large) default so it is the BUFFER cap — not the cumulative cap — that trips.
    vi.stubEnv('PREVIEW_MAX_STREAM_BUFFER_BYTES', '4096');

    const upstream = await startHttpUpstream((req, res) => {
      if (!req.url?.startsWith('/flood')) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      // Push 32KB (>> 4KB watermark) up front, then hold the connection open.
      res.write(`data: ${'x'.repeat(32 * 1024)}\n\n`);
      // Intentionally do not end — the relay must tear this down via the cap.
    });
    cleanups.push(() => upstream.close());

    const { bridge, types, previewId, bridgeToDaemon, injectHttpRequest, WsBridge } = await setup();
    cleanups.push(() => WsBridge.getAll().clear());

    const requestId = 'sse-flood';
    const relay = bridge.createPreviewRelay(requestId, previewId, 10_000);
    injectHttpRequest(requestId, upstream.port, '/flood');

    const started = await relay.start;
    // Do NOT read: let the server-side unconsumed buffer grow past the watermark.
    await expect(started.body.getReader().read()).rejects.toBeTruthy();

    // Deterministic close: the bridge sent an ABORT(LIMIT_EXCEEDED) to the daemon.
    expect(bridgeToDaemon.some((m) =>
      m.type === types.PREVIEW_MSG.ABORT
      && m.requestId === requestId
      && m.reason === types.PREVIEW_ERROR.LIMIT_EXCEEDED,
    )).toBe(true);
  });
});
