import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { WsBridge } from '../src/ws/bridge.js';

// ── Mock WebSocket ─────────────────────────────────────────────────────────────

class MockWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  closed = false;
  readyState = 1;
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
    this.readyState = 3;
    this.closeCode = code;
    this.closeReason = reason;
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
  sha256Hex: (_s: string) => 'valid-hash',
  randomHex: (n: number) => 'a'.repeat(n * 2),
}));

vi.mock('../src/routes/push.js', () => ({
  dispatchPush: vi.fn(),
}));

async function flushAsync() {
  for (let i = 0; i < 5; i++) await new Promise((r) => process.nextTick(r));
}

async function authDaemon(bridge: WsBridge, daemonWs: MockWs, db: ReturnType<typeof makeDb>) {
  bridge.handleDaemonConnection(daemonWs as never, db, {} as never);
  daemonWs.emit('message', Buffer.from(JSON.stringify({
    type: 'auth', serverId: 'test', token: 'tok',
  })));
  await flushAsync();
}

describe('WsBridge file transfer', () => {
  let serverId: string;

  beforeEach(() => {
    serverId = `test-ft-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    WsBridge.getAll().clear();
  });

  it('isDaemonConnected returns false before auth', () => {
    const bridge = WsBridge.get(serverId);
    expect(bridge.isDaemonConnected()).toBe(false);
  });

  it('isDaemonConnected returns true after auth', async () => {
    const bridge = WsBridge.get(serverId);
    const daemon = new MockWs();
    await authDaemon(bridge, daemon, makeDb('valid-hash'));
    expect(bridge.isDaemonConnected()).toBe(true);
  });

  it('sendFileTransferRequest rejects when daemon offline', async () => {
    const bridge = WsBridge.get(serverId);
    await expect(
      bridge.sendFileTransferRequest('req1', { type: 'file.upload' }, 5000),
    ).rejects.toThrow('daemon_offline');
  });

  it('sendFileTransferRequest sends to daemon and resolves on upload_done', async () => {
    const bridge = WsBridge.get(serverId);
    const daemon = new MockWs();
    await authDaemon(bridge, daemon, makeDb('valid-hash'));

    const promise = bridge.sendFileTransferRequest('upload-1', {
      type: 'file.upload',
      uploadId: 'upload-1',
      filename: 'test.txt',
      content: 'aGVsbG8=',
      size: 5,
    }, 5000);

    // Verify daemon received the message
    const sent = daemon.sentStrings;
    const uploadMsg = sent.find((s) => s.includes('file.upload'));
    expect(uploadMsg).toBeDefined();

    // Simulate daemon response
    daemon.emit('message', Buffer.from(JSON.stringify({
      type: 'file.upload_done',
      uploadId: 'upload-1',
      attachment: { id: 'test.txt', daemonPath: '/tmp/imcodes-uploads/test.txt', downloadable: true },
    })));
    await flushAsync();

    const result = await promise;
    expect(result.type).toBe('file.upload_done');
    expect((result.attachment as Record<string, unknown>).id).toBe('test.txt');
  });

  it('sendFileTransferRequest resolves on upload_error', async () => {
    const bridge = WsBridge.get(serverId);
    const daemon = new MockWs();
    await authDaemon(bridge, daemon, makeDb('valid-hash'));

    const promise = bridge.sendFileTransferRequest('upload-2', {
      type: 'file.upload', uploadId: 'upload-2',
    }, 5000);

    daemon.emit('message', Buffer.from(JSON.stringify({
      type: 'file.upload_error',
      uploadId: 'upload-2',
      message: 'disk_full',
    })));
    await flushAsync();

    const result = await promise;
    expect(result.type).toBe('file.upload_error');
    expect(result.message).toBe('disk_full');
  });

  it('sendFileTransferRequest times out', async () => {
    vi.useFakeTimers();
    const bridge = WsBridge.get(serverId);
    const daemon = new MockWs();
    await authDaemon(bridge, daemon, makeDb('valid-hash'));

    const promise = bridge.sendFileTransferRequest('upload-3', {
      type: 'file.upload', uploadId: 'upload-3',
    }, 100);

    vi.advanceTimersByTime(150);

    await expect(promise).rejects.toThrow('timeout');
    vi.useRealTimers();
  });

  it('download response resolves correctly', async () => {
    const bridge = WsBridge.get(serverId);
    const daemon = new MockWs();
    await authDaemon(bridge, daemon, makeDb('valid-hash'));

    const promise = bridge.sendFileTransferRequest('dl-1', {
      type: 'file.download', downloadId: 'dl-1', attachmentId: 'abc123.txt',
    }, 5000);

    daemon.emit('message', Buffer.from(JSON.stringify({
      type: 'file.download_done',
      downloadId: 'dl-1',
      content: 'aGVsbG8=',
      mime: 'text/plain',
      filename: 'abc123.txt',
    })));
    await flushAsync();

    const result = await promise;
    expect(result.type).toBe('file.download_done');
    expect(result.content).toBe('aGVsbG8=');
  });

  it('download error for expired handle', async () => {
    const bridge = WsBridge.get(serverId);
    const daemon = new MockWs();
    await authDaemon(bridge, daemon, makeDb('valid-hash'));

    const promise = bridge.sendFileTransferRequest('dl-2', {
      type: 'file.download', downloadId: 'dl-2', attachmentId: 'expired.txt',
    }, 5000);

    daemon.emit('message', Buffer.from(JSON.stringify({
      type: 'file.download_error',
      downloadId: 'dl-2',
      message: 'expired',
    })));
    await flushAsync();

    const result = await promise;
    expect(result.type).toBe('file.download_error');
    expect(result.message).toBe('expired');
  });

  it('orphan responses are silently discarded', async () => {
    const bridge = WsBridge.get(serverId);
    const daemon = new MockWs();
    await authDaemon(bridge, daemon, makeDb('valid-hash'));

    // No pending request for this uploadId
    const resolved = bridge.resolveFileTransfer('nonexistent', {
      type: 'file.upload_done', uploadId: 'nonexistent',
    });
    expect(resolved).toBe(false);
  });

  it('daemon disconnect immediately rejects pending file transfers', async () => {
    const bridge = WsBridge.get(serverId);
    const daemon = new MockWs();
    await authDaemon(bridge, daemon, makeDb('valid-hash'));

    const promise = bridge.sendFileTransferRequest('upload-dc', {
      type: 'file.upload', uploadId: 'upload-dc',
    }, 30000);

    // Simulate daemon disconnect
    daemon.close(1001, 'going away');
    await flushAsync();

    await expect(promise).rejects.toThrow('daemon_disconnected');
  });
});
