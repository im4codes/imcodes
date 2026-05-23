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

vi.mock('../../src/util/daemon-status.js', () => ({
  recordDaemonServerLinkStatus: vi.fn(),
}));

import { ServerLink, __setServerLinkDataPlaneQueueConfigForTests } from '../../src/daemon/server-link.js';
import { recordDaemonServerLinkStatus } from '../../src/util/daemon-status.js';
import { TIMELINE_MESSAGES, TIMELINE_PROTOCOL_CAPABILITY } from '../../shared/timeline-protocol.js';
import { TRANSPORT_EVENT } from '../../shared/transport-events.js';
import { FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY } from '../../shared/transport/file-transfer.js';

const recordDaemonServerLinkStatusMock = vi.mocked(recordDaemonServerLinkStatus);

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

  it('advertises relay upload fetch capability for server-side compatibility gating', () => {
    expect(link.getDaemonCapabilities()).toContain(FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY);
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

  it('does not queue live timeline events behind bulk history sends', async () => {
    link.connect();
    link.send({
      type: 'chat.history',
      sessionId: 'deck_test_brain',
      events: [{ text: 'x'.repeat(4096) }],
    });
    link.sendTimelineEvent({
      eventId: 'evt-live',
      sessionId: 'deck_test_brain',
      ts: 1,
      seq: 1,
      epoch: 1,
      type: 'assistant.text',
      payload: { text: 'streaming token', streaming: true },
    });

    expect(mockWsInstance.send).toHaveBeenCalledTimes(1);
    const immediate = JSON.parse(mockWsInstance.send.mock.calls[0][0] as string);
    expect(immediate.type).toBe(TIMELINE_MESSAGES.EVENT);
    expect(immediate.event.payload.text).toBe('streaming token');

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockWsInstance.send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mockWsInstance.send.mock.calls[1][0] as string).type).toBe('chat.history');
  });

  it('does not queue live transport deltas behind bulk history sends', async () => {
    link.connect();
    link.send({
      type: 'chat.history',
      sessionId: 'deck_test_brain',
      events: [{ text: 'x'.repeat(4096) }],
    });
    link.send({
      type: TRANSPORT_EVENT.CHAT_DELTA,
      sessionId: 'deck_test_brain',
      content: 'streaming token',
    });

    expect(mockWsInstance.send).toHaveBeenCalledTimes(1);
    const immediate = JSON.parse(mockWsInstance.send.mock.calls[0][0] as string);
    expect(immediate.type).toBe(TRANSPORT_EVENT.CHAT_DELTA);
    expect(immediate.content).toBe('streaming token');

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockWsInstance.send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mockWsInstance.send.mock.calls[1][0] as string).type).toBe('chat.history');
  });

  it('records heartbeat ack proof even when runtime status was just written', () => {
    link.connect();
    const messageHandler = mockWsInstance.addEventListener.mock.calls.find(([type]) => type === 'message')?.[1] as
      | ((event: MessageEvent) => void)
      | undefined;
    expect(messageHandler).toBeDefined();

    const writesBeforeAck = recordDaemonServerLinkStatusMock.mock.calls.length;
    messageHandler?.({ data: JSON.stringify({ type: 'heartbeat_ack' }) } as MessageEvent);

    expect(recordDaemonServerLinkStatusMock).toHaveBeenCalledTimes(writesBeforeAck + 1);
    expect(recordDaemonServerLinkStatusMock.mock.calls.at(-1)?.[0]).toMatchObject({
      state: 'connected',
      lastHeartbeatAckAt: expect.any(Number),
      clearError: true,
    });
  });

  it('accepts Blob binary messages from Node WebSocket without throwing', async () => {
    link.connect();
    const binaryHandler = vi.fn();
    link.onBinaryMessage(binaryHandler);

    const messageHandler = mockWsInstance.addEventListener.mock.calls.find(([type]) => type === 'message')?.[1] as
      | ((event: MessageEvent) => void)
      | undefined;
    expect(messageHandler).toBeDefined();

    messageHandler?.({ data: new Blob([Uint8Array.from([1, 2, 3])]) } as MessageEvent);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(binaryHandler).toHaveBeenCalledOnce();
    expect(binaryHandler.mock.calls[0][0]).toEqual(Buffer.from([1, 2, 3]));
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

  it('drain leaves the queued data-plane item intact when the socket is not OPEN and resends it after reconnect', async () => {
    // Section-10 (post-deploy audit fix for commit f25f72e7) anchor:
    // before the fix, the drain loop ran `shift()` and then `trySend()`
    // and ignored the trySend return value, so a brief WS-not-OPEN
    // window silently dropped the queue head. The peek-then-shift fix
    // requires that the item stay queued until trySend confirms send.
    link.connect();
    expect(mockWsInstance.readyState).toBe(1); // OPEN

    // Simulate WS leaving OPEN state right before the drain runs:
    // any data-plane message enqueued here must not be sent until OPEN
    // is restored.
    mockWsInstance.readyState = 2; // CLOSING

    const payload = { type: TIMELINE_MESSAGES.HISTORY, requestId: 'hist-1', sessionId: 'deck_test_brain', events: [{ text: 'x'.repeat(256) }] };
    link.send(payload);
    // Let the setImmediate drain tick run while the socket is not OPEN.
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Peek-then-shift: the item must NOT have been sent and (critically)
    // must NOT have been silently dropped — it stays in the queue.
    expect(mockWsInstance.send).not.toHaveBeenCalledWith(
      expect.stringContaining('"type":"timeline.history"'),
    );

    // Reconnect: socket becomes OPEN again, the WS open handler calls
    // flushDataPlaneAfterReconnect() which restarts the drain.
    mockWsInstance.readyState = 1;
    link.flushDataPlaneAfterReconnect();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const sentTypes = mockWsInstance.send.mock.calls.map((c) => {
      try { return JSON.parse(c[0] as string).type as string; } catch { return ''; }
    });
    expect(sentTypes).toContain(TIMELINE_MESSAGES.HISTORY);
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
