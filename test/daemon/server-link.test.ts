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

  it('send() throws when not connected', () => {
    expect(() => link.send({ type: 'test' })).toThrow();
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
});
