import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

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
});
