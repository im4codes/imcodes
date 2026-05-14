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

import { ServerLink, __setServerLinkDataPlaneQueueConfigForTests } from '../../src/daemon/server-link.js';
import { TIMELINE_PROTOCOL_CAPABILITY } from '../../shared/timeline-protocol.js';

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
    __setServerLinkDataPlaneQueueConfigForTests(null);
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

  it('advertises the shared timeline protocol capability in daemon hello capabilities', () => {
    expect(link.getDaemonCapabilities()).toContain(TIMELINE_PROTOCOL_CAPABILITY);
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

  it('prioritizes control-plane sends ahead of queued data-plane sends', async () => {
    link.connect();
    link.send({ type: 'chat.history', sessionId: 'deck_test_brain', events: [{ text: 'x'.repeat(4096) }] });
    link.send({ type: 'command.ack', commandId: 'cmd-priority' });

    expect(mockWsInstance.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockWsInstance.send.mock.calls[0][0] as string).type).toBe('command.ack');

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockWsInstance.send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mockWsInstance.send.mock.calls[1][0] as string).type).toBe('chat.history');
  });

  it('drops stale queued data-plane sends without blocking later control-plane sends', async () => {
    __setServerLinkDataPlaneQueueConfigForTests({ softCap: 1, hardCap: 2, staleMs: 0 });
    link.connect();
    link.send({ type: 'chat.history', requestId: 'hist-stale', sessionId: 'deck_test_brain', events: [{ text: 'synthetic' }] });
    link.send({ type: 'command.ack', commandId: 'cmd-after-stale' });

    expect(mockWsInstance.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockWsInstance.send.mock.calls[0][0] as string).type).toBe('command.ack');

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockWsInstance.send).toHaveBeenCalledTimes(1);
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
