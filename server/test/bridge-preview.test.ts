import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { WsBridge } from '../src/ws/bridge.js';
import { LocalWebPreviewRegistry } from '../src/preview/registry.js';
import {
  PREVIEW_BINARY_FRAME,
  PREVIEW_MSG,
  PREVIEW_LIMITS,
  packPreviewBinaryFrame,
} from '../../shared/preview-types.js';

class MockWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  closed = false;
  readyState = 1;

  send(data: string | Buffer, _opts?: unknown, callback?: (err?: Error) => void) {
    if (this.closed) {
      const err = new Error('socket closed');
      callback?.(err);
      if (!callback) throw err;
      return;
    }
    this.sent.push(data);
    callback?.();
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    this.emit('close');
  }

  get sentStrings(): string[] {
    return this.sent.filter((s): s is string => typeof s === 'string');
  }
}

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
  // randomHex must be present: LocalWebPreviewRegistry.create() uses it for the
  // V-cleanup-relay test which seeds a real preview. Unique-ish per call so the
  // preview id and token differ.
  randomHex: (n: number) => 'c'.repeat(n) + Math.random().toString(36).slice(2, 6),
}));

vi.mock('../src/routes/push.js', () => ({
  dispatchPush: vi.fn(),
}));

async function flushAsync() {
  for (let i = 0; i < 5; i++) await new Promise((r) => process.nextTick(r));
}

describe('WsBridge preview relay', () => {
  let serverId: string;
  const previewId = 'preview-' + 'b'.repeat(16);

  beforeEach(() => {
    serverId = `preview-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    WsBridge.getAll().clear();
    vi.useRealTimers();
  });

  async function setupBridge() {
    const bridge = WsBridge.get(serverId);
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, makeDb('valid-hash'), {} as never);
    daemon.emit('message', Buffer.from(JSON.stringify({ type: 'auth', serverId, token: 't' })), false);
    await flushAsync();
    return { bridge, daemon };
  }

  it('streams preview response chunks in order and completes once', async () => {
    const { bridge, daemon } = await setupBridge();
    const relay = bridge.createPreviewRelay('req-1', previewId);

    daemon.emit('message', Buffer.from(JSON.stringify({
      type: PREVIEW_MSG.RESPONSE_START,
      requestId: 'req-1',
      status: 200,
      headers: { 'content-type': 'text/plain' },
    })), false);
    daemon.emit('message', packPreviewBinaryFrame(PREVIEW_BINARY_FRAME.RESPONSE_BODY, 'req-1', Buffer.from('hello ')), true);
    daemon.emit('message', packPreviewBinaryFrame(PREVIEW_BINARY_FRAME.RESPONSE_BODY, 'req-1', Buffer.from('world')), true);
    daemon.emit('message', Buffer.from(JSON.stringify({ type: PREVIEW_MSG.RESPONSE_END, requestId: 'req-1' })), false);
    daemon.emit('message', Buffer.from(JSON.stringify({ type: PREVIEW_MSG.RESPONSE_END, requestId: 'req-1' })), false);

    const started = await relay.start;
    const chunks: Buffer[] = [];
    for await (const chunk of started.body as ReadableStream<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }

    expect(started.status).toBe(200);
    expect(Buffer.concat(chunks).toString()).toBe('hello world');
  });

  it('propagates timeout as abort to daemon and rejects start promise', async () => {
    vi.useFakeTimers();
    const { bridge, daemon } = await setupBridge();
    const relay = bridge.createPreviewRelay('req-timeout', previewId, 25);

    vi.advanceTimersByTime(30);
    await expect(relay.start).rejects.toThrow('preview relay response start timeout');
    expect(daemon.sentStrings.some((msg) => msg.includes(`"type":"${PREVIEW_MSG.ABORT}"`) && msg.includes('req-timeout'))).toBe(true);
  });

  it('keeps an sse-style relay alive while chunks continue arriving before idle timeout', async () => {
    vi.useFakeTimers();
    const { bridge, daemon } = await setupBridge();
    const relay = bridge.createPreviewRelay('req-sse', previewId, 25);

    daemon.emit('message', Buffer.from(JSON.stringify({
      type: PREVIEW_MSG.RESPONSE_START,
      requestId: 'req-sse',
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })), false);

    const started = await relay.start;
    const reader = started.body.getReader();

    daemon.emit('message', packPreviewBinaryFrame(PREVIEW_BINARY_FRAME.RESPONSE_BODY, 'req-sse', Buffer.from('data: one\n\n')), true);
    await reader.read();

    vi.advanceTimersByTime(110_000);
    daemon.emit('message', packPreviewBinaryFrame(PREVIEW_BINARY_FRAME.RESPONSE_BODY, 'req-sse', Buffer.from('data: two\n\n')), true);
    const second = await reader.read();

    expect(Buffer.from(second.value ?? []).toString()).toBe('data: two\n\n');
    expect(daemon.sentStrings.some((msg) => msg.includes(`"type":"${PREVIEW_MSG.ABORT}"`) && msg.includes('req-sse'))).toBe(false);
  });

  it('times out an sse-style relay after idle timeout following response start', async () => {
    vi.useFakeTimers();
    const { bridge, daemon } = await setupBridge();
    const relay = bridge.createPreviewRelay('req-sse-idle', previewId, 25);

    daemon.emit('message', Buffer.from(JSON.stringify({
      type: PREVIEW_MSG.RESPONSE_START,
      requestId: 'req-sse-idle',
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })), false);

    const started = await relay.start;
    const reader = started.body.getReader();

    vi.advanceTimersByTime(120_001);
    await expect(reader.read()).rejects.toThrow('preview relay stream idle timeout');
    expect(daemon.sentStrings.some((msg) => msg.includes(`"type":"${PREVIEW_MSG.ABORT}"`) && msg.includes('req-sse-idle'))).toBe(true);
  });

  it('sends binary request body frames to daemon', async () => {
    const { bridge, daemon } = await setupBridge();
    bridge.sendPreviewRequestBodyChunk('req-binary', Buffer.from([1, 2, 3]));
    const frame = daemon.sent.find((item): item is Buffer => Buffer.isBuffer(item));
    expect(frame?.[0]).toBe(PREVIEW_BINARY_FRAME.REQUEST_BODY);
  });

  it('aborts upstream relay when browser cancels the response body', async () => {
    const { bridge, daemon } = await setupBridge();
    const relay = bridge.createPreviewRelay('req-cancel', previewId);

    daemon.emit('message', Buffer.from(JSON.stringify({
      type: PREVIEW_MSG.RESPONSE_START,
      requestId: 'req-cancel',
      status: 200,
      headers: {},
    })), false);
    const started = await relay.start;

    await started.body.cancel('client gone');

    expect(daemon.sentStrings.some((msg) => msg.includes(`"type":"${PREVIEW_MSG.ABORT}"`) && msg.includes('req-cancel'))).toBe(true);
  });

  // ── hasActivePreviewRelay (cleanup×relay interface, P1.4.1) ──────────────────
  it('reports an active relay for a previewId with a pending request', async () => {
    const { bridge } = await setupBridge();
    expect(bridge.hasActivePreviewRelay(previewId)).toBe(false);
    bridge.createPreviewRelay('req-active', previewId, 60_000);
    expect(bridge.hasActivePreviewRelay(previewId)).toBe(true);
  });

  // ── V-cleanup-relay (run 8a975732-23a P1.4.3) ────────────────────────────────
  it('V-cleanup-relay: registry eviction aborts the previewId pending relays with a deterministic terminal', async () => {
    const { bridge, daemon } = await setupBridge();
    // Real preview in THIS server's registry so cleanup eviction routes through
    // the bridge's installed eviction hook (matched by serverId).
    const reg = LocalWebPreviewRegistry.get(bridgeServerId(bridge));
    const { preview } = reg.create('user1', 3000, '/');

    const relay = bridge.createPreviewRelay('req-evict', preview.id, 60_000);
    daemon.emit('message', Buffer.from(JSON.stringify({
      type: PREVIEW_MSG.RESPONSE_START,
      requestId: 'req-evict',
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })), false);
    const started = await relay.start;
    const reader = started.body.getReader();

    // Force the preview past its hard ceiling so cleanup evicts it even though
    // it has an active relay — the bridge MUST then tear the relay down.
    vi.useFakeTimers();
    vi.setSystemTime(preview.createdAt + PREVIEW_LIMITS.PREVIEW_MAX_LIFETIME_HARD_MS + 1);
    reg.cleanup();

    // Deterministic terminal: an ABORT was propagated to the daemon and reading
    // the body now rejects (errored controller — not a half-dead stream).
    expect(daemon.sentStrings.some((s) => {
      try { const m = JSON.parse(s); return m.type === PREVIEW_MSG.ABORT && m.requestId === 'req-evict'; }
      catch { return false; }
    })).toBe(true);
    await expect(reader.read()).rejects.toBeTruthy();
  });

  // ── daemon disconnect rejects pending HTTP relays ────────────────────────────
  // streaming spec "流式失败模式": daemon 断连 → 该 preview 全部 pending relay 被
  // rejectAllPending 拒绝(确定性终态),不留半死流。WS tunnels 的断连已另有用例;
  // 这里覆盖 HTTP relay 的两种状态:RESPONSE_START 之前(start 拒绝)与之后(流 error)。
  it('rejects a pending (pre-RESPONSE_START) preview relay when the daemon disconnects', async () => {
    const { bridge, daemon } = await setupBridge();
    const relay = bridge.createPreviewRelay('req-dc-pending', previewId, 60_000);
    expect(bridge.hasActivePreviewRelay(previewId)).toBe(true);

    daemon.close(); // daemon WS drops mid-flight
    await flushAsync();

    await expect(relay.start).rejects.toThrow(/daemon/);
    // The in-flight slot is released on this terminal — preview is no longer live.
    expect(bridge.hasActivePreviewRelay(previewId)).toBe(false);
  });

  it('errors an in-flight (post-RESPONSE_START) preview stream when the daemon disconnects', async () => {
    const { bridge, daemon } = await setupBridge();
    const relay = bridge.createPreviewRelay('req-dc-active', previewId, 60_000);
    daemon.emit('message', Buffer.from(JSON.stringify({
      type: PREVIEW_MSG.RESPONSE_START,
      requestId: 'req-dc-active',
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })), false);
    const started = await relay.start;
    const reader = started.body.getReader();

    daemon.close();
    await flushAsync();

    // Deterministic terminal: the live stream errors (not a half-dead SSE).
    await expect(reader.read()).rejects.toBeTruthy();
    expect(bridge.hasActivePreviewRelay(previewId)).toBe(false);
  });
});

/** Reach the bridge's private serverId for tests (the constructor stores it). */
function bridgeServerId(bridge: unknown): string {
  return (bridge as { serverId: string }).serverId;
}
