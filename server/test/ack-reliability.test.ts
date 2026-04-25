import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { WsBridge } from '../src/ws/bridge.js';
import {
  MSG_COMMAND_ACK,
  MSG_COMMAND_FAILED,
  MSG_DAEMON_ONLINE,
  MSG_DAEMON_OFFLINE,
  RECONNECT_GRACE_MS,
  ACK_TIMEOUT_MS,
  ACK_TIMEOUT_RETRY_LIMIT,
} from '../../shared/ack-protocol.js';

class MockWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  closed = false;
  readyState = 1; // WebSocket.OPEN
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
    this.readyState = 3; // WebSocket.CLOSED
    this.closeCode = code;
    this.closeReason = reason;
    this.emit('close');
  }

  get sentStrings(): string[] {
    return this.sent.filter((s): s is string => typeof s === 'string');
  }

  sentByType(type: string): Array<Record<string, unknown>> {
    return this.sentStrings
      .map((s) => { try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; } })
      .filter((m): m is Record<string, unknown> => !!m && m.type === type);
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
}));
vi.mock('../src/routes/push.js', () => ({
  dispatchPush: vi.fn(),
}));

async function flushAsync() {
  for (let i = 0; i < 5; i++) await new Promise((r) => process.nextTick(r));
}

async function connectAndAuthenticateDaemon(
  bridge: WsBridge,
  serverId: string,
): Promise<MockWs> {
  const daemonWs = new MockWs();
  bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash') as never, {} as never);
  daemonWs.emit('message', Buffer.from(JSON.stringify({ type: 'auth', serverId, token: 't' })));
  await flushAsync();
  return daemonWs;
}

function addBrowserSubscriber(bridge: WsBridge, sessionName: string): MockWs {
  const browser = new MockWs();
  bridge.handleBrowserConnection(browser as never, 'user-1', makeDb('valid-hash') as never, false);
  // Pretend subscription — skip ownership check by directly poking subscription state.
  // Simpler: just emit terminal.subscribe, but ownership check will reject.
  // Instead, the tests that need session-scoped routing will use the Test helper.
  return browser;
}

describe('WsBridge — command ack reliability', () => {
  let serverId: string;

  beforeEach(() => {
    serverId = `ack-test-${Math.random().toString(36).slice(2)}`;
    vi.useRealTimers();
  });

  afterEach(() => {
    WsBridge.getAll().clear();
    vi.clearAllMocks();
  });

  it('dispatches session.send to daemon and tracks inflight', async () => {
    const bridge = WsBridge.get(serverId);
    const daemonWs = await connectAndAuthenticateDaemon(bridge, serverId);
    const browser = addBrowserSubscriber(bridge, 'deck_test_brain');

    browser.emit('message', Buffer.from(JSON.stringify({
      type: 'session.send',
      sessionName: 'deck_test_brain',
      text: 'hi',
      commandId: 'C1',
    })));
    await flushAsync();

    const forwarded = daemonWs.sentByType('session.send');
    expect(forwarded.length).toBe(1);
    expect(forwarded[0].commandId).toBe('C1');
    expect(bridge._getInflightCountForTest()).toBe(1);
  });

  it('does not forward an in-flight duplicate commandId to the daemon', async () => {
    const bridge = WsBridge.get(serverId);
    const daemonWs = await connectAndAuthenticateDaemon(bridge, serverId);
    const browser = addBrowserSubscriber(bridge, 'deck_test_brain');

    browser.emit('message', Buffer.from(JSON.stringify({
      type: 'session.send',
      sessionName: 'deck_test_brain',
      text: 'hi',
      commandId: 'C1-INFLIGHT-DUP',
    })));
    browser.emit('message', Buffer.from(JSON.stringify({
      type: 'session.send',
      sessionName: 'deck_test_brain',
      text: 'hi again',
      commandId: 'C1-INFLIGHT-DUP',
    })));
    await flushAsync();

    const forwarded = daemonWs.sentByType('session.send')
      .filter((msg) => msg.commandId === 'C1-INFLIGHT-DUP');
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].text).toBe('hi');
    expect(bridge._getInflightCountForTest()).toBe(1);
  });

  it('clears inflight and dedups replayed ack via seenCommandAcks', async () => {
    const bridge = WsBridge.get(serverId);
    const daemonWs = await connectAndAuthenticateDaemon(bridge, serverId);
    const browser = addBrowserSubscriber(bridge, 'deck_test_brain');

    browser.emit('message', Buffer.from(JSON.stringify({
      type: 'session.send',
      sessionName: 'deck_test_brain',
      text: 'hi',
      commandId: 'C1',
    })));
    await flushAsync();

    // Daemon replies
    daemonWs.emit('message', Buffer.from(JSON.stringify({
      type: MSG_COMMAND_ACK,
      commandId: 'C1',
      status: 'accepted',
      session: 'deck_test_brain',
    })));
    await flushAsync();

    expect(bridge._getInflightCountForTest()).toBe(0);
    expect(bridge._hasSeenAckForTest('C1')).toBe(true);

    // Replay (outbox flush) — should be deduped and not re-increment inflight
    daemonWs.emit('message', Buffer.from(JSON.stringify({
      type: MSG_COMMAND_ACK,
      commandId: 'C1',
      status: 'accepted',
      session: 'deck_test_brain',
    })));
    await flushAsync();
    // No new inflight, still seen
    expect(bridge._getInflightCountForTest()).toBe(0);
    expect(bridge._hasSeenAckForTest('C1')).toBe(true);
  });

  it('during grace: buffers sends, does NOT broadcast offline, replays on reconnect', async () => {
    const bridge = WsBridge.get(serverId);
    const daemonWs = await connectAndAuthenticateDaemon(bridge, serverId);
    const browser = addBrowserSubscriber(bridge, 'deck_test_brain');

    // Drop daemon WS
    daemonWs.close();
    await flushAsync();

    expect(bridge._isDaemonOfflineAnnouncedForTest()).toBe(false);

    // Send during grace
    browser.emit('message', Buffer.from(JSON.stringify({
      type: 'session.send',
      sessionName: 'deck_test_brain',
      text: 'hi',
      commandId: 'C2',
    })));
    await flushAsync();
    expect(bridge._getInflightCountForTest()).toBe(1);
    // No command.failed yet
    expect(browser.sentByType(MSG_COMMAND_FAILED).length).toBe(0);

    // Reconnect before grace expires
    const daemonWs2 = await connectAndAuthenticateDaemon(bridge, serverId);
    const replay = daemonWs2.sentByType('session.send');
    expect(replay.length).toBe(1);
    expect(replay[0].commandId).toBe('C2');
    // Never announced offline
    expect(bridge._isDaemonOfflineAnnouncedForTest()).toBe(false);
    // daemon.online broadcast sent
    expect(browser.sentByType(MSG_DAEMON_ONLINE).length).toBeGreaterThanOrEqual(1);
  });

  it('after grace expiry: broadcasts daemon.offline and fails all inflight', async () => {
    vi.useFakeTimers();
    const bridge = WsBridge.get(serverId);
    const daemonWs = await connectAndAuthenticateDaemon(bridge, serverId);
    const browser = addBrowserSubscriber(bridge, 'deck_test_brain');

    browser.emit('message', Buffer.from(JSON.stringify({
      type: 'session.send',
      sessionName: 'deck_test_brain',
      text: 'hi',
      commandId: 'C3',
    })));
    await flushAsync();
    expect(bridge._getInflightCountForTest()).toBe(1);

    daemonWs.close();
    await flushAsync();
    vi.advanceTimersByTime(RECONNECT_GRACE_MS + 100);
    await flushAsync();

    const failed = browser.sentByType(MSG_COMMAND_FAILED);
    expect(failed.length).toBe(1);
    expect(failed[0].commandId).toBe('C3');
    expect(failed[0].reason).toBe('daemon_offline');
    expect(failed[0].retryable).toBe(true);
    expect(browser.sentByType(MSG_DAEMON_OFFLINE).length).toBeGreaterThanOrEqual(1);
    expect(bridge._getInflightCountForTest()).toBe(0);
  });

  it('ack timeout retries session.send before command.failed ack_timeout when daemon stays silent', async () => {
    vi.useFakeTimers();
    const bridge = WsBridge.get(serverId);
    const daemonWs = await connectAndAuthenticateDaemon(bridge, serverId);
    const browser = addBrowserSubscriber(bridge, 'deck_test_brain');

    browser.emit('message', Buffer.from(JSON.stringify({
      type: 'session.send',
      sessionName: 'deck_test_brain',
      text: 'hi',
      commandId: 'C4',
    })));
    await flushAsync();

    for (let attempt = 1; attempt <= ACK_TIMEOUT_RETRY_LIMIT; attempt++) {
      vi.advanceTimersByTime(ACK_TIMEOUT_MS + 100);
      await flushAsync();
      const forwarded = daemonWs.sentByType('session.send').filter((msg) => msg.commandId === 'C4');
      expect(forwarded).toHaveLength(attempt + 1);
      expect(forwarded[attempt].__bridgeRetry).toBe(true);
      expect(forwarded[attempt].__bridgeRetryAttempt).toBe(attempt + 1);
      expect(browser.sentByType(MSG_COMMAND_FAILED)).toHaveLength(0);
    }

    vi.advanceTimersByTime(ACK_TIMEOUT_MS + 100);
    await flushAsync();

    const failed = browser.sentByType(MSG_COMMAND_FAILED);
    expect(failed.length).toBe(1);
    expect(failed[0].commandId).toBe('C4');
    expect(failed[0].reason).toBe('ack_timeout');
  });

  it('authoritative user.message echo clears ack timeout even if command.ack is late', async () => {
    vi.useFakeTimers();
    const bridge = WsBridge.get(serverId);
    const daemonWs = await connectAndAuthenticateDaemon(bridge, serverId);
    const browser = addBrowserSubscriber(bridge, 'deck_test_brain');

    browser.emit('message', Buffer.from(JSON.stringify({
      type: 'session.send',
      sessionName: 'deck_test_brain',
      text: 'hi',
      commandId: 'C4-echo',
    })));
    await flushAsync();
    expect(bridge._getInflightCountForTest()).toBe(1);

    daemonWs.emit('message', Buffer.from(JSON.stringify({
      type: 'timeline.event',
      event: {
        eventId: 'evt-user-c4-echo',
        sessionId: 'deck_test_brain',
        type: 'user.message',
        ts: Date.now(),
        seq: 1,
        epoch: 1,
        source: 'daemon',
        confidence: 'high',
        payload: { text: 'hi', commandId: 'C4-echo' },
      },
    })));
    await flushAsync();
    expect(bridge._getInflightCountForTest()).toBe(0);

    vi.advanceTimersByTime(ACK_TIMEOUT_MS + 100);
    await flushAsync();
    expect(browser.sentByType(MSG_COMMAND_FAILED)).toHaveLength(0);

    daemonWs.emit('message', Buffer.from(JSON.stringify({
      type: MSG_COMMAND_ACK,
      commandId: 'C4-echo',
      status: 'accepted',
      session: 'deck_test_brain',
    })));
    await flushAsync();
    expect(bridge._hasSeenAckForTest('C4-echo')).toBe(true);
  });

  it('send while daemon is fully offline (past grace) fails immediately', async () => {
    vi.useFakeTimers();
    const bridge = WsBridge.get(serverId);
    const daemonWs = await connectAndAuthenticateDaemon(bridge, serverId);
    const browser = addBrowserSubscriber(bridge, 'deck_test_brain');

    daemonWs.close();
    await flushAsync();
    vi.advanceTimersByTime(RECONNECT_GRACE_MS + 100);
    await flushAsync();
    vi.useRealTimers();

    expect(bridge._isDaemonOfflineAnnouncedForTest()).toBe(true);

    browser.emit('message', Buffer.from(JSON.stringify({
      type: 'session.send',
      sessionName: 'deck_test_brain',
      text: 'hi',
      commandId: 'C5',
    })));
    await flushAsync();

    const failed = browser.sentByType(MSG_COMMAND_FAILED);
    expect(failed.some((m) => m.commandId === 'C5' && m.reason === 'daemon_offline')).toBe(true);
    expect(bridge._getInflightCountForTest()).toBe(0);
  });

  it('daemon.online broadcast fires on first auth and on reconnect', async () => {
    const bridge = WsBridge.get(serverId);
    const browser = addBrowserSubscriber(bridge, 'deck_test_brain');
    // First daemon connect
    const daemonWs1 = await connectAndAuthenticateDaemon(bridge, serverId);
    expect(browser.sentByType(MSG_DAEMON_ONLINE).length).toBe(1);
    daemonWs1.close();
    await flushAsync();
    // Reconnect within grace
    await connectAndAuthenticateDaemon(bridge, serverId);
    expect(browser.sentByType(MSG_DAEMON_ONLINE).length).toBe(2);
  });
});
