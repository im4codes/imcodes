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
    queryOne: async () => ({ token_hash: 'valid-hash', owner_status: 'active', user_id: 'u' }),
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

  it('wrapSseKeepaliveStream emits ": keepalive\\n\\n" when silent without dropping delayed data or leaking timers', async () => {
    const { wrapSseKeepaliveStream } = await import('../src/routes/local-web-preview.js');
    vi.useFakeTimers();

    let upstreamCtrl!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) { upstreamCtrl = c; },
      cancel() { cancelled = true; },
    });

    const wrapped = wrapSseKeepaliveStream(upstream, 500);
    const reader = wrapped.getReader();

    // Consumer awaits first chunk while upstream is silent > 500ms → emits keepalive comment.
    const r1Promise = reader.read();
    await vi.advanceTimersByTimeAsync(500);
    const r1 = await r1Promise;
    expect(r1.done).toBe(false);
    expect(Buffer.from(r1.value ?? []).toString('utf8')).toBe(': keepalive\n\n');

    // Consumer issues second read while upstream stays silent 300ms, then emits real SSE event.
    // The in-flight read MUST preserve the real event without losing or duplicating it!
    const r2Promise = reader.read();
    await vi.advanceTimersByTimeAsync(300);
    upstreamCtrl.enqueue(Buffer.from('data: hello\n\n', 'utf8'));
    const r2 = await r2Promise;
    expect(r2.done).toBe(false);
    expect(Buffer.from(r2.value ?? []).toString('utf8')).toBe('data: hello\n\n');

    // Another 500ms silence -> second keepalive comment.
    const r3Promise = reader.read();
    await vi.advanceTimersByTimeAsync(500);
    const r3 = await r3Promise;
    expect(Buffer.from(r3.value ?? []).toString('utf8')).toBe(': keepalive\n\n');

    // Also test real chunk arriving right AFTER timer resolved pull() (between pulls):
    // must still be delivered intact on the subsequent read!
    upstreamCtrl.enqueue(Buffer.from('data: trailing\n\n', 'utf8'));
    const r4 = await reader.read();
    expect(Buffer.from(r4.value ?? []).toString('utf8')).toBe('data: trailing\n\n');

    // Cancelling propagates cleanly to upstream and cleans timers.
    const cancelRead = reader.read();
    await reader.cancel('client gone');
    await expect(cancelRead).resolves.toMatchObject({ done: true });
    expect(cancelled).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
  });

  it('wrapSseKeepaliveStream NEVER injects ": keepalive\\n\\n" mid-line or mid-event across split LF/CRLF chunks', async () => {
    const { wrapSseKeepaliveStream } = await import('../src/routes/local-web-preview.js');
    vi.useFakeTimers();

    let upstreamCtrl!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) { upstreamCtrl = c; },
    });

    const wrapped = wrapSseKeepaliveStream(upstream, 100);
    const reader = wrapped.getReader();
    const collected: string[] = [];

    // 1) Split mid-field ("data: hel" then wait > keepaliveMs then "lo\n\n"):
    //    keepalive MUST NOT be inserted inside "data: hello".
    upstreamCtrl.enqueue(Buffer.from('data: hel', 'utf8'));
    const p1 = reader.read();
    expect(Buffer.from((await p1).value ?? []).toString('utf8')).toBe('data: hel');

    const p2 = reader.read();
    await vi.advanceTimersByTimeAsync(350); // 3.5x keepaliveMs while mid-line!
    upstreamCtrl.enqueue(Buffer.from('lo\n\n', 'utf8'));
    const r2 = await p2;
    collected.push(Buffer.from(r2.value ?? []).toString('utf8'));
    expect(collected[0]).toBe('lo\n\n');

    // 2) Now AT blank-line boundary -> silent > 100ms emits valid `: keepalive\n\n`.
    const p3 = reader.read();
    await vi.advanceTimersByTimeAsync(100);
    const r3 = await p3;
    expect(Buffer.from(r3.value ?? []).toString('utf8')).toBe(': keepalive\n\n');

    // 3) Split mid-event across CRLF (`id: 9\r` then silence then `\n` then silence then `data: ok\r\n` then silence):
    //    single EOL (even split `\r` + `\n`) MUST NOT emit `: keepalive\n\n` before `data: ok\r\n\r\n`.
    upstreamCtrl.enqueue(Buffer.from('id: 9\r', 'utf8'));
    expect(Buffer.from((await reader.read()).value ?? []).toString('utf8')).toBe('id: 9\r');
    const p4 = reader.read();
    await vi.advanceTimersByTimeAsync(250);
    upstreamCtrl.enqueue(Buffer.from('\n', 'utf8'));
    expect(Buffer.from((await p4).value ?? []).toString('utf8')).toBe('\n');

    const p5a = reader.read();
    await vi.advanceTimersByTimeAsync(250);
    upstreamCtrl.enqueue(Buffer.from('data: ok\r\n', 'utf8'));
    expect(Buffer.from((await p5a).value ?? []).toString('utf8')).toBe('data: ok\r\n');

    const p5b = reader.read();
    await vi.advanceTimersByTimeAsync(250);
    upstreamCtrl.enqueue(Buffer.from('\r\n', 'utf8'));
    expect(Buffer.from((await p5b).value ?? []).toString('utf8')).toBe('\r\n');

    // 4) Now CRLF blank line completed -> next silence emits `: keepalive\n\n` cleanly!
    const p6 = reader.read();
    await vi.advanceTimersByTimeAsync(100);
    expect(Buffer.from((await p6).value ?? []).toString('utf8')).toBe(': keepalive\n\n');

    await reader.cancel();
  });

  it('keeps pure CR events, delayed/split leading UTF-8 BOM after initial keepalive, and split CRLF intact under WHATWG SSE parsing', async () => {
    const { wrapSseKeepaliveStream } = await import('../src/routes/local-web-preview.js');
    vi.useFakeTimers();

    // Spec-exact WHATWG §9.2.5/9.2.6 SSE parser (ignores BOM ONLY via TextDecoder initial strip;
    // any BOM emitted AFTER an early `: keepalive\n\n` would corrupt `\uFEFFid` / `\uFEFFdata`).
    function parseWhatwgSse(chunks: Uint8Array[]): Array<{ id: string; data: string }> {
      const dec = new TextDecoder('utf-8');
      const text = chunks.map((c) => dec.decode(c, { stream: true })).join('') + dec.decode();
      // Normalize CRLF -> LF, then remaining CR -> LF per WHATWG EventSource stream decoding.
      const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
      const events: Array<{ id: string; data: string }> = [];
      let dataBuf = '';
      let lastEventId = '';
      for (const line of lines) {
        if (line === '') {
          if (dataBuf !== '') {
            events.push({
              id: lastEventId,
              data: dataBuf.endsWith('\n') ? dataBuf.slice(0, -1) : dataBuf,
            });
            dataBuf = '';
          }
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') dataBuf += `${value}\n`;
        else if (field === 'id' && !value.includes('\0')) lastEventId = value;
      }
      return events;
    }

    // Case A: Initial `: keepalive\n\n` fires BEFORE delayed + split UTF-8 BOM + first event.
    let ctrlA!: ReadableStreamDefaultController<Uint8Array>;
    const streamA = wrapSseKeepaliveStream(new ReadableStream<Uint8Array>({ start(c) { ctrlA = c; } }), 100);
    const readerA = streamA.getReader();
    const outA: Uint8Array[] = [];

    const firstKeepaliveP = readerA.read();
    await vi.advanceTimersByTimeAsync(100);
    const firstKeepalive = await firstKeepaliveP;
    expect(Buffer.from(firstKeepalive.value ?? []).toString('utf8')).toBe(': keepalive\n\n');
    outA.push(firstKeepalive.value!);

    // Split UTF-8 BOM `[0xef]`, pause > keepaliveMs (must NOT inject keepalive mid-BOM!), then `[0xbb, 0xbf]id: 7\ndata: bom-ok\n\n`
    ctrlA.enqueue(new Uint8Array([0xef]));
    const nextReadP = readerA.read();
    await vi.advanceTimersByTimeAsync(250);
    ctrlA.enqueue(Buffer.concat([new Uint8Array([0xbb, 0xbf]), Buffer.from('id: 7\ndata: bom-ok\n\n', 'utf8')]));
    const afterBom = await nextReadP;
    expect(Buffer.from(afterBom.value ?? []).toString('utf8')).toBe('id: 7\ndata: bom-ok\n\n');
    outA.push(afterBom.value!);

    // Case B: Pure CR silent events (`\r\r`) must STILL emit keepalive between silent events and preserve parsed events!
    ctrlA.enqueue(Buffer.from('id: 8\rdata: pure-cr-1\r\r', 'utf8'));
    outA.push((await readerA.read()).value!);
    const crKeepaliveP = readerA.read();
    await vi.advanceTimersByTimeAsync(100);
    const crKeepalive = await crKeepaliveP;
    expect(Buffer.from(crKeepalive.value ?? []).toString('utf8')).toBe(': keepalive\n\n');
    outA.push(crKeepalive.value!);

    ctrlA.enqueue(Buffer.from('id: 9\rdata: pure-cr-2\r\r', 'utf8'));
    outA.push((await readerA.read()).value!);

    // Case C: Split CRLF boundary (`\r\n\r` pause `\n`) keeps parsed events valid too.
    ctrlA.enqueue(Buffer.from('id: 10\r\ndata: crlf-split\r\n\r', 'utf8'));
    outA.push((await readerA.read()).value!);
    const midSplitRead = readerA.read();
    await vi.advanceTimersByTimeAsync(120);
    outA.push((await midSplitRead).value!); // keepalive after `\r\n\r` empty line
    ctrlA.enqueue(Buffer.from('\nid: 11\r\ndata: after-split\r\n\r\n', 'utf8'));
    outA.push((await readerA.read()).value!);

    ctrlA.close();
    while (true) {
      const n = await readerA.read();
      if (n.done) break;
      outA.push(n.value);
    }

    expect(parseWhatwgSse(outA)).toEqual([
      { id: '7', data: 'bom-ok' },
      { id: '8', data: 'pure-cr-1' },
      { id: '9', data: 'pure-cr-2' },
      { id: '10', data: 'crlf-split' },
      { id: '11', data: 'after-split' },
    ]);
  });
});
