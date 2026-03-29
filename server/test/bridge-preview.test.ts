import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { WsBridge } from '../src/ws/bridge.js';
import {
  PREVIEW_BINARY_FRAME,
  PREVIEW_MSG,
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
}));

vi.mock('../src/routes/push.js', () => ({
  dispatchPush: vi.fn(),
}));

async function flushAsync() {
  for (let i = 0; i < 5; i++) await new Promise((r) => process.nextTick(r));
}

describe('WsBridge preview relay', () => {
  let serverId: string;

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
    const relay = bridge.createPreviewRelay('req-1');

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
    const relay = bridge.createPreviewRelay('req-timeout', 25);

    vi.advanceTimersByTime(30);
    await expect(relay.start).rejects.toThrow('preview relay response start timeout');
    expect(daemon.sentStrings.some((msg) => msg.includes(`"type":"${PREVIEW_MSG.ABORT}"`) && msg.includes('req-timeout'))).toBe(true);
  });

  it('keeps an sse-style relay alive while chunks continue arriving before idle timeout', async () => {
    vi.useFakeTimers();
    const { bridge, daemon } = await setupBridge();
    const relay = bridge.createPreviewRelay('req-sse', 25);

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
    const relay = bridge.createPreviewRelay('req-sse-idle', 25);

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
    const relay = bridge.createPreviewRelay('req-cancel');

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
});
