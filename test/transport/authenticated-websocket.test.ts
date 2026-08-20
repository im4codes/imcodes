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
