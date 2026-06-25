import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { contentTypeOf, isStreamingResponse } from '../../shared/preview-stream-policy.js';

/**
 * Server-side streaming behavior (run 8a975732-23a P1.2.4):
 *   - V-stream-bytes: a streaming response (classified via the shared predicate
 *     at RESPONSE_START) is EXEMPT from the cumulative MAX_RESPONSE_BYTES cap.
 *   - V-buffer-cap: a slow consumer letting the server-side UNCONSUMED buffer
 *     exceed MAX_PREVIEW_STREAM_BUFFER_BYTES is deterministically closed.
 *
 * Both ceilings read their env override at module-eval (`previewLimitFromEnv`),
 * so we stub env to SMALL thresholds and dynamically import after stubbing.
 */

class MockWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  closed = false;
  readyState = 1;
  send(data: string | Buffer, _opts?: unknown, cb?: (err?: Error) => void) {
    if (this.closed) { cb?.(new Error('closed')); return; }
    this.sent.push(data);
    cb?.();
  }
  close() { this.closed = true; this.readyState = 3; this.emit('close'); }
  get sentStrings(): string[] { return this.sent.filter((s): s is string => typeof s === 'string'); }
}

function makeDb() {
  return {
    queryOne: async () => ({ token_hash: 'valid-hash', user_id: 'u' }),
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
vi.mock('../src/routes/push.js', () => ({ dispatchPush: vi.fn() }));

async function flushAsync() {
  for (let i = 0; i < 5; i++) await new Promise((r) => process.nextTick(r));
}

const previewId = 'preview-' + 'b'.repeat(16);

async function setup() {
  const { WsBridge } = await import('../src/ws/bridge.js');
  const types = await import('../../shared/preview-types.js');
  const serverId = `stream-${Math.random().toString(36).slice(2)}`;
  const bridge = WsBridge.get(serverId);
  const daemon = new MockWs();
  bridge.handleDaemonConnection(daemon as never, makeDb(), {} as never);
  daemon.emit('message', Buffer.from(JSON.stringify({ type: 'auth', serverId, token: 't' })), false);
  await flushAsync();
  return { WsBridge, bridge, daemon, serverId, types };
}

describe('V-stream-bytes / V-buffer-cap', () => {
  beforeEach(() => {
    vi.resetModules();
    // Small thresholds: 4KB cumulative cap, 8KB unconsumed buffer high-watermark.
    vi.stubEnv('PREVIEW_MAX_RESPONSE_BYTES', '4096');
    vi.stubEnv('PREVIEW_MAX_STREAM_BUFFER_BYTES', '8192');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  // ── V-stream-bytes ───────────────────────────────────────────────────────────
  it('V-stream-bytes: a streaming SSE whose cumulative bytes exceed MAX_RESPONSE_BYTES is NOT LIMIT_EXCEEDED', async () => {
    const { bridge, daemon, types } = await setup();
    const { PREVIEW_MSG, PREVIEW_BINARY_FRAME, PREVIEW_LIMITS, packPreviewBinaryFrame } = types;
    expect(PREVIEW_LIMITS.MAX_RESPONSE_BYTES).toBe(4096);

    const relay = bridge.createPreviewRelay('sse-bytes', previewId, 60_000);
    daemon.emit('message', Buffer.from(JSON.stringify({
      type: PREVIEW_MSG.RESPONSE_START,
      requestId: 'sse-bytes',
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })), false);

    const started = await relay.start;
    const reader = started.body.getReader();

    // Push 8 × 1KB = 8KB cumulative (> 4KB cap) but READ each chunk promptly so
    // unconsumed never approaches the 8KB buffer cap. A streaming response must
    // NOT be aborted by the cumulative cap.
    for (let i = 0; i < 8; i++) {
      daemon.emit('message', packPreviewBinaryFrame(PREVIEW_BINARY_FRAME.RESPONSE_BODY, 'sse-bytes', Buffer.alloc(1024, 0x41)), true);
      const r = await reader.read();
      expect(r.done).toBe(false);
      expect(r.value?.byteLength).toBe(1024);
    }

    // No LIMIT_EXCEEDED abort was sent to the daemon for this stream.
    const aborted = daemon.sentStrings.some((s) => {
      try {
        const m = JSON.parse(s);
        return m.type === PREVIEW_MSG.ABORT && m.requestId === 'sse-bytes';
      } catch { return false; }
    });
    expect(aborted).toBe(false);
  });

  // ── V-buffer-cap ───────────────────────────────────────────────────────────
  it('V-buffer-cap: a slow consumer exceeding MAX_PREVIEW_STREAM_BUFFER_BYTES is deterministically closed', async () => {
    const { bridge, daemon, types } = await setup();
    const { PREVIEW_MSG, PREVIEW_BINARY_FRAME, PREVIEW_LIMITS, PREVIEW_ERROR, packPreviewBinaryFrame } = types;
    expect(PREVIEW_LIMITS.MAX_PREVIEW_STREAM_BUFFER_BYTES).toBe(8192);

    const relay = bridge.createPreviewRelay('sse-buf', previewId, 60_000);
    daemon.emit('message', Buffer.from(JSON.stringify({
      type: PREVIEW_MSG.RESPONSE_START,
      requestId: 'sse-buf',
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })), false);

    const started = await relay.start;
    // Do NOT read — let unconsumed bytes accumulate. Push 12KB (> 8KB cap).
    for (let i = 0; i < 12; i++) {
      daemon.emit('message', packPreviewBinaryFrame(PREVIEW_BINARY_FRAME.RESPONSE_BODY, 'sse-buf', Buffer.alloc(1024, 0x42)), true);
    }
    await flushAsync();

    // The stream is deterministically closed: a LIMIT_EXCEEDED abort was sent to
    // the daemon, and reading the body now rejects (errored controller).
    const aborted = daemon.sentStrings.some((s) => {
      try {
        const m = JSON.parse(s);
        return m.type === PREVIEW_MSG.ABORT && m.requestId === 'sse-buf' && m.reason === PREVIEW_ERROR.LIMIT_EXCEEDED;
      } catch { return false; }
    });
    expect(aborted).toBe(true);

    await expect(started.body.getReader().read()).rejects.toBeTruthy();
  });

  // ── T-R-A V-buffer-cap-partial-drain ─────────────────────────────────────────
  // Proves the high-watermark is an EXPLICIT unconsumed-byte counter with
  // symmetric enqueue(+=)/pull(-=) accounting — NOT a "max-ever-pushed" gate and
  // NOT controller.desiredSize. A consumer that PARTIALLY drains keeps the
  // *unconsumed* total under the cap even when CUMULATIVE pushed bytes exceed it,
  // so the stream is not closed; only letting unconsumed bytes exceed the cap
  // (no draining) deterministically closes it.
  //
  // Concrete arithmetic (cap = 1000 bytes, chunks of 300 bytes):
  //   Phase A (interleaved read after each push): unconsumed oscillates 0 ↔ 300,
  //     never > 1000, while CUMULATIVE pushed climbs to 1200 (> cap). NOT closed.
  //   Phase B (no draining): 0 → 300 → 600 → 900 → 1200 (> 1000) → closed.
  it('V-buffer-cap-partial-drain: partial draining decrements the unconsumed counter (no premature close); only un-drained accumulation > cap closes', async () => {
    // Override the beforeEach buffer-cap stub with a small, exact value BEFORE the
    // dynamic import in setup() (previewLimitFromEnv reads at module-eval time).
    vi.stubEnv('PREVIEW_MAX_STREAM_BUFFER_BYTES', '1000');
    const { bridge, daemon, types } = await setup();
    const { PREVIEW_MSG, PREVIEW_BINARY_FRAME, PREVIEW_LIMITS, PREVIEW_ERROR, packPreviewBinaryFrame } = types;
    expect(PREVIEW_LIMITS.MAX_PREVIEW_STREAM_BUFFER_BYTES).toBe(1000);

    const relay = bridge.createPreviewRelay('sse-drain', previewId, 60_000);
    daemon.emit('message', Buffer.from(JSON.stringify({
      type: PREVIEW_MSG.RESPONSE_START,
      requestId: 'sse-drain',
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })), false);

    const started = await relay.start;
    const reader = started.body.getReader();

    const CHUNK = 300;
    const pushChunk = () => daemon.emit(
      'message',
      packPreviewBinaryFrame(PREVIEW_BINARY_FRAME.RESPONSE_BODY, 'sse-drain', Buffer.alloc(CHUNK, 0x43)),
      true,
    );
    const isAborted = () => daemon.sentStrings.some((s) => {
      try {
        const m = JSON.parse(s);
        return m.type === PREVIEW_MSG.ABORT
          && m.requestId === 'sse-drain'
          && m.reason === PREVIEW_ERROR.LIMIT_EXCEEDED;
      } catch { return false; }
    });

    // ── Phase A: push 1 chunk then read it, 4 times. Unconsumed never exceeds 300
    // (well under cap=1000), but CUMULATIVE pushed = 4 × 300 = 1200 (> cap). A
    // "max-ever" gate would (wrongly) close here; the byte counter must not. The
    // read() that follows each push pulls the chunk out, invoking the stream `pull`
    // which decrements unconsumedBytes by exactly that chunk's size.
    for (let i = 0; i < 4; i++) {
      pushChunk();
      const r = await reader.read();
      expect(r.done).toBe(false);
      expect(r.value?.byteLength).toBe(CHUNK);
      // Counter went back down after the read → the same preview keeps accepting
      // more bytes (not desiredSize-gated, not a permanent ceiling).
      expect(isAborted()).toBe(false);
    }
    await flushAsync();
    // After 1200 cumulative bytes with full draining: still alive (no LIMIT_EXCEEDED).
    expect(isAborted()).toBe(false);

    // ── Phase B: now push WITHOUT draining. With the demand-driven metering, at
    // most ~1 chunk sits pre-buffered in the stream's internal queue (uncounted),
    // so the explicit unconsumed counter climbs over the 1000 cap on the 5th
    // un-drained push (effective bound = cap + one chunk) → deterministic close.
    for (let i = 0; i < 5; i++) pushChunk();
    await flushAsync();

    // Deterministic close: LIMIT_EXCEEDED abort sent to the daemon, and reading the
    // body now rejects (errored controller) — mirrors the V-buffer-cap assertion.
    expect(isAborted()).toBe(true);
    await expect(reader.read()).rejects.toBeTruthy();
  });

  // ── T-R-A-C: backlog partial-drain mis-kill gate (N1, audit 394c114e-11f) ─────
  // The unconsumed-byte counter must reflect ACTUAL consumer reads, not the
  // ReadableStream `pull` callback cadence. Under a real backlog (push N WITHOUT
  // reading, then read M<N), a `pull`-driven decrement under-fires (HWM=1: `pull`
  // only fires when desiredSize>0, i.e. when the queue is nearly drained), so the
  // counter drifts HIGH and a healthy bursty stream is wrongly LIMIT_EXCEEDED.
  // cap=1500, chunk=300: push×4 (=1200, no read) → read×2 (true unconsumed 600) →
  // push×2 (true unconsumed 1200 < 1500). MUST NOT abort.
  it('T-R-A-C backlog mis-kill gate: deep backlog then partial drain does NOT wrongly close a healthy stream', async () => {
    vi.stubEnv('PREVIEW_MAX_STREAM_BUFFER_BYTES', '1500');
    const { bridge, daemon, types } = await setup();
    const { PREVIEW_MSG, PREVIEW_BINARY_FRAME, PREVIEW_LIMITS, PREVIEW_ERROR, packPreviewBinaryFrame } = types;
    expect(PREVIEW_LIMITS.MAX_PREVIEW_STREAM_BUFFER_BYTES).toBe(1500);

    const relay = bridge.createPreviewRelay('sse-backlog', previewId, 60_000);
    daemon.emit('message', Buffer.from(JSON.stringify({
      type: PREVIEW_MSG.RESPONSE_START, requestId: 'sse-backlog', status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })), false);
    const started = await relay.start;
    const reader = started.body.getReader();

    const CHUNK = 300;
    const push = () => daemon.emit('message', packPreviewBinaryFrame(PREVIEW_BINARY_FRAME.RESPONSE_BODY, 'sse-backlog', Buffer.alloc(CHUNK, 0x45)), true);
    const isAborted = () => daemon.sentStrings.some((s) => {
      try { const m = JSON.parse(s); return m.type === PREVIEW_MSG.ABORT && m.requestId === 'sse-backlog' && m.reason === PREVIEW_ERROR.LIMIT_EXCEEDED; } catch { return false; }
    });

    for (let i = 0; i < 4; i++) push();   // deep backlog: 4×300 = 1200, NO read
    await flushAsync();
    expect(isAborted()).toBe(false);       // 1200 < 1500, fine
    for (let i = 0; i < 2; i++) { const r = await reader.read(); expect(r.done).toBe(false); }  // drain 2 → true unconsumed 600
    await flushAsync();
    for (let i = 0; i < 2; i++) push();     // true unconsumed 1200 < 1500
    await flushAsync();
    // A correct explicit-byte counter (decrement on real consumer read) stays at
    // 1200 < cap → NO abort. The buggy pull-cadence counter sits at ~1800 → aborts.
    expect(isAborted()).toBe(false);
  });

  // ── T-R-A-E: complete-drain gate (terminal-pending, audit 394c114e-11f) ───────
  // After RESPONSE_END with chunks still buffered, the consumer must read ALL of
  // them then see done=true, and the in-flight slot must release.
  it('T-R-A-E complete-drain gate: queued chunks survive RESPONSE_END and are fully delivered', async () => {
    vi.stubEnv('PREVIEW_MAX_STREAM_BUFFER_BYTES', '100000');
    const { bridge, daemon, types } = await setup();
    const { PREVIEW_MSG, PREVIEW_BINARY_FRAME, packPreviewBinaryFrame } = types;

    const relay = bridge.createPreviewRelay('sse-drain-end', previewId, 60_000);
    daemon.emit('message', Buffer.from(JSON.stringify({
      type: PREVIEW_MSG.RESPONSE_START, requestId: 'sse-drain-end', status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })), false);
    const started = await relay.start;
    const reader = started.body.getReader();

    const CHUNK = 300;
    for (let i = 0; i < 3; i++) daemon.emit('message', packPreviewBinaryFrame(PREVIEW_BINARY_FRAME.RESPONSE_BODY, 'sse-drain-end', Buffer.alloc(CHUNK, 0x46)), true);
    daemon.emit('message', Buffer.from(JSON.stringify({ type: PREVIEW_MSG.RESPONSE_END, requestId: 'sse-drain-end' })), false);
    await flushAsync();

    let total = 0;
    for (;;) { const r = await reader.read(); if (r.done) break; total += r.value?.byteLength ?? 0; }
    expect(total).toBe(3 * CHUNK);   // all queued chunks delivered, then done
    expect(bridge.canAcceptPreviewInflight(previewId)).toBe(true);  // slot released
  });

  // ── T-TE-charset (server-side parity) ────────────────────────────────────────
  // The streaming classifier must not be defeated by a `;charset=...` parameter on
  // the content-type. Asserts the shared predicate directly AND that the SERVER
  // bridge treats a charset-SSE RESPONSE_START as streaming (byte-cap-exempt),
  // modelled on V-stream-bytes above.
  it('T-TE-charset: isStreamingResponse / contentTypeOf ignore charset, and the bridge exempts charset-SSE from MAX_RESPONSE_BYTES', async () => {
    // Pure shared-predicate parity: charset must NOT defeat streaming classification.
    expect(isStreamingResponse({ 'content-type': 'text/event-stream;charset=utf-8' })).toBe(true);
    expect(isStreamingResponse({ 'content-type': 'application/x-ndjson; charset=utf-8' })).toBe(true);
    // contentTypeOf strips the parameter and lowercases.
    expect(contentTypeOf({ 'content-type': 'text/event-stream;charset=utf-8' })).toBe('text/event-stream');

    // Server-side parity: a charset-SSE RESPONSE_START is classified streaming, so a
    // cumulative byte count over MAX_RESPONSE_BYTES does NOT trigger LIMIT_EXCEEDED.
    const { bridge, daemon, types } = await setup();
    const { PREVIEW_MSG, PREVIEW_BINARY_FRAME, PREVIEW_LIMITS, packPreviewBinaryFrame } = types;
    expect(PREVIEW_LIMITS.MAX_RESPONSE_BYTES).toBe(4096);

    const relay = bridge.createPreviewRelay('sse-charset', previewId, 60_000);
    daemon.emit('message', Buffer.from(JSON.stringify({
      type: PREVIEW_MSG.RESPONSE_START,
      requestId: 'sse-charset',
      status: 200,
      headers: { 'content-type': 'text/event-stream;charset=utf-8' },
    })), false);

    const started = await relay.start;
    const reader = started.body.getReader();

    // 8 × 1KB = 8KB cumulative (> 4KB cap), read promptly so unconsumed stays low.
    for (let i = 0; i < 8; i++) {
      daemon.emit('message', packPreviewBinaryFrame(PREVIEW_BINARY_FRAME.RESPONSE_BODY, 'sse-charset', Buffer.alloc(1024, 0x44)), true);
      const r = await reader.read();
      expect(r.done).toBe(false);
      expect(r.value?.byteLength).toBe(1024);
    }

    const aborted = daemon.sentStrings.some((s) => {
      try {
        const m = JSON.parse(s);
        return m.type === PREVIEW_MSG.ABORT && m.requestId === 'sse-charset';
      } catch { return false; }
    });
    expect(aborted).toBe(false);
  });
});
