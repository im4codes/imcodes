import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock WebSocket before importing ServerLink
const mockWsInstance = {
  send: vi.fn(),
  close: vi.fn(),
  addEventListener: vi.fn(),
  readyState: 1, // OPEN
};
const MockWebSocket = vi.fn(() => mockWsInstance);
MockWebSocket.OPEN = 1;
vi.stubGlobal('WebSocket', MockWebSocket);

import { ServerLink } from '../../src/daemon/server-link.js';

describe('ServerLink', () => {
  let link: ServerLink;

  beforeEach(() => {
    vi.clearAllMocks();
    link = new ServerLink({
      workerUrl: 'wss://test.workers.dev',
      serverId: 'srv-123',
      token: 'srv-token',
    });
  });

  afterEach(() => {
    link.disconnect();
  });

  it('constructs without connecting', () => {
    expect(MockWebSocket).not.toHaveBeenCalled();
  });

  it('connect() creates a WebSocket', () => {
    link.connect();
    expect(MockWebSocket).toHaveBeenCalledOnce();
    expect(MockWebSocket).toHaveBeenCalledWith(
      expect.stringContaining('wss://test.workers.dev'),
    );
  });

  it('send() silently drops messages when not connected (fire-and-forget safe)', () => {
    // The daemon must never die from transient disconnects — ServerLink.send()
    // is best-effort and must not throw. Callers that need delivery
    // confirmation should check isConnected() first.
    expect(() => link.send({ type: 'test' })).not.toThrow();
    expect(mockWsInstance.send).not.toHaveBeenCalled();
    expect(link.isConnected()).toBe(false);
  });

  it('isConnected() reflects WebSocket readyState', () => {
    expect(link.isConnected()).toBe(false);
    link.connect();
    expect(link.isConnected()).toBe(true);
  });

  it('send() serializes message to JSON', () => {
    link.connect();
    link.send({ type: 'heartbeat' });
    expect(mockWsInstance.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"heartbeat"'),
    );
  });

  it('send() adds monotonic seq counter', () => {
    link.connect();
    link.send({ type: 'msg1' });
    link.send({ type: 'msg2' });
    const calls = mockWsInstance.send.mock.calls;
    const msg1 = JSON.parse(calls[0][0] as string);
    const msg2 = JSON.parse(calls[1][0] as string);
    expect(msg2.seq).toBeGreaterThan(msg1.seq);
  });

  it('disconnect() closes the WebSocket', () => {
    link.connect();
    link.disconnect();
    expect(mockWsInstance.close).toHaveBeenCalled();
  });

  it('reconnect via connect() closes the previous WebSocket to prevent TCP/socket leak', () => {
    // Regression test: previously `connect()` overwrote `this.ws` without
    // closing the old instance. On error/close → scheduleReconnect → connect
    // loops, this accumulated ESTAB TCP connections + Node WebSocket internal
    // buffers (7 concurrent WS observed on a leaking production daemon before
    // OOM). Every reconnect MUST close the prior ws even though the stale
    // guards in the event handlers already prevent handler-level confusion.
    link.connect();
    expect(MockWebSocket).toHaveBeenCalledTimes(1);
    expect(mockWsInstance.close).not.toHaveBeenCalled();

    // Simulate a reconnect: call connect() again while a socket exists.
    link.connect();
    expect(MockWebSocket).toHaveBeenCalledTimes(2);
    // The previous WS instance must have been explicitly closed.
    expect(mockWsInstance.close).toHaveBeenCalledTimes(1);
  });
});
