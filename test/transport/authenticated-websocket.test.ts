import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthenticatedWebSocketClient,
  type AuthenticatedWebSocketLike,
} from '../../src/transport/authenticated-websocket.js';

class FakeSocket extends EventEmitter implements AuthenticatedWebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  closeCalls = 0;
  terminateCalls = 0;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  terminate(): void {
    this.terminateCalls += 1;
    this.readyState = 3;
    // Deliberately omit a close event. The reconnect owner must not depend on it.
  }
}

function createClient(
  createSocket: () => AuthenticatedWebSocketLike,
  onClose = vi.fn(),
  extra: Partial<ConstructorParameters<typeof AuthenticatedWebSocketClient>[0]> = {},
): AuthenticatedWebSocketClient {
  return new AuthenticatedWebSocketClient({
    url: 'wss://controlled-node.invalid/ws',
    auth: { type: 'auth' },
    createSocket,
    onMessage: vi.fn(),
    onClose,
    initialBackoffMs: 100,
    maxBackoffMs: 100,
    connectTimeoutMs: 1_000,
    heartbeatMs: 100,
    silenceTimeoutMs: 300,
    heartbeatMessage: { type: 'heartbeat' },
    ...extra,
  });
}

describe('AuthenticatedWebSocketClient reconnect ownership', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconnects when a failed socket emits error without close', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const onClose = vi.fn();
    const client = createClient(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    }, onClose);

    client.start();
    expect(sockets).toHaveLength(1);
    sockets[0]!.emit('error', new Error('network adapter disappeared'));
    sockets[0]!.emit('close');

    expect(sockets[0]!.terminateCalls).toBe(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets).toHaveLength(2);

    client.stop();
  });

  it('retries when socket creation throws synchronously', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const createSocket = vi.fn<() => AuthenticatedWebSocketLike>()
      .mockImplementationOnce(() => {
        throw new Error('temporary websocket construction failure');
      })
      .mockReturnValueOnce(socket);
    const client = createClient(createSocket);

    expect(() => client.start()).not.toThrow();
    expect(createSocket).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(createSocket).toHaveBeenCalledTimes(2);

    client.stop();
  });

  it('reconnects after connect timeout even if terminate never emits close', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const client = createClient(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });

    client.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets[0]!.terminateCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets[0]!.terminateCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);

    client.stop();
  });

  it('reconnects on inbound silence even if terminate never emits close', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const client = createClient(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });

    client.start();
    sockets[0]!.readyState = 1;
    sockets[0]!.emit('open');
    await vi.advanceTimersByTimeAsync(300);
    expect(sockets[0]!.terminateCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets).toHaveLength(2);

    client.stop();
  });

  it('uses monotonic silence age so a backward wall-clock correction cannot suppress reconnect', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    let wallNow = 10_000;
    let monotonicNow = 0;
    const diagnostics = vi.fn();
    const client = createClient(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    }, vi.fn(), {
      wallNow: () => wallNow,
      monotonicNow: () => monotonicNow,
      onDiagnostic: diagnostics,
    });

    client.start();
    sockets[0]!.readyState = 1;
    sockets[0]!.emit('open');
    wallNow -= 60 * 60_000;
    // Keep both monotonic liveness ages below the silence threshold: only the
    // backward wall-clock discontinuity can justify this reconnect.
    monotonicNow = 100;
    await vi.advanceTimersByTimeAsync(100);

    expect(sockets[0]!.terminateCalls).toBe(1);
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      type: 'socket_lost',
      reason: 'system_resume_or_clock_change',
    }));
    client.stop();
  });

  it('treats an overslept watchdog tick as resume and reconnects before reusing a half-open socket', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    let wallNow = 20_000;
    let monotonicNow = 500;
    const diagnostics = vi.fn();
    const client = createClient(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    }, vi.fn(), {
      wallNow: () => wallNow,
      monotonicNow: () => monotonicNow,
      onDiagnostic: diagnostics,
    });

    client.start();
    sockets[0]!.readyState = 1;
    sockets[0]!.emit('open');
    // A suspended process runs no timers. On resume, either the wall clock or
    // the monotonic clock (platform-dependent) exposes the long tick gap.
    wallNow += 5 * 60_000;
    monotonicNow += 100;
    await vi.advanceTimersByTimeAsync(100);

    expect(sockets[0]!.terminateCalls).toBe(1);
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      type: 'socket_lost',
      reason: 'system_resume_or_clock_change',
    }));
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets).toHaveLength(2);
    client.stop();
  });

  it('keeps reconnecting even if the close observer throws', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    let closeCalls = 0;
    const client = createClient(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    }, vi.fn(() => {
      closeCalls += 1;
      if (closeCalls === 1) throw new Error('observer failure');
    }));

    client.start();
    expect(() => sockets[0]!.emit('close')).not.toThrow();
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets).toHaveLength(2);

    client.stop();
  });

  it('reports server authentication refusal without logging credentials or frames', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const diagnostics = vi.fn();
    const client = createClient(() => socket, vi.fn(), { onDiagnostic: diagnostics });
    client.start();
    socket.emit('close', 4003, Buffer.from('revoked'));
    expect(diagnostics).toHaveBeenCalledWith({ type: 'socket_lost', reason: 'credential_revoked' });
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('controlled-node.invalid');
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('"auth"');
    client.stop();
  });

  it('does not reconnect after stop when failed-socket events arrive late', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const client = createClient(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });

    client.start();
    sockets[0]!.emit('error', new Error('network adapter disappeared'));
    client.stop();
    sockets[0]!.emit('close');
    sockets[0]!.emit('error', new Error('late socket error'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(1);
  });
});
