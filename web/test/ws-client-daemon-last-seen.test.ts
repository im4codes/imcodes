/**
 * Audit fix (e940d73f-a8e / N4) regression tests.
 *
 * Pin the contract that:
 *   - daemon-originated messages bump `daemonLastSeenAt` so the
 *     `isDaemonCapabilityStale()` judgment stays fresh during long
 *     daemon sessions;
 *   - server-synthesized messages (`pong`, `session.event`,
 *     `daemon.offline`) do NOT bump it — those don't prove the daemon
 *     is reachable;
 *   - WS close (auto or explicit) clears `daemonLastSeenAt` along with
 *     the capability snapshot.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WsClient } from '../src/ws-client.js';
import { P2P_WORKFLOW_MSG } from '@shared/p2p-workflow-messages.js';
import { P2P_CAPABILITY_FRESHNESS_TTL_MS } from '@shared/p2p-workflow-constants.js';

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  url: string;
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};

  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  }
  send = vi.fn();
  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', { code: 1000, reason: '' });
  }
  emit(type: string, data?: unknown) {
    if (type === 'open') this.readyState = MockWebSocket.OPEN;
    if (type === 'close') this.readyState = MockWebSocket.CLOSED;
    for (const fn of this.listeners[type] ?? []) fn(data);
  }
}

const flushAsync = () => new Promise<void>((r) => setTimeout(r, 0));
let lastWs: MockWebSocket | null = null;

const seedHello = (ws: MockWebSocket) => {
  ws.emit('message', {
    data: JSON.stringify({
      type: P2P_WORKFLOW_MSG.DAEMON_HELLO,
      daemonId: 'daemon-1',
      capabilities: ['p2p_workflow_v1'],
      helloEpoch: 1,
      sentAt: Date.now(),
    }),
  });
};

const sendDaemonMsg = (ws: MockWebSocket, type: string, extra: Record<string, unknown> = {}) => {
  ws.emit('message', { data: JSON.stringify({ type, ...extra }) });
};

describe('WsClient daemonLastSeenAt freshness whitelist (N4)', () => {
  beforeEach(() => {
    lastWs = null;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    vi.stubGlobal('WebSocket', class extends MockWebSocket {
      constructor(url: string) { super(url); lastWs = this; }
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ticket: 'test-ticket' }) }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllTimers();
  });

  async function connect(): Promise<{ client: WsClient; ws: MockWebSocket }> {
    const client = new WsClient('http://localhost:8787', 'srv-1');
    client.connect();
    await flushAsync();
    lastWs!.emit('open');
    return { client, ws: lastWs! };
  }

  it('isDaemonCapabilityStale returns true before any hello arrives', async () => {
    const { client } = await connect();
    expect(client.isDaemonCapabilityStale()).toBe(true);
  });

  it('after daemon.hello, snapshot is fresh', async () => {
    const { client, ws } = await connect();
    seedHello(ws);
    expect(client.isDaemonCapabilityStale()).toBe(false);
  });

  it('daemon.stats keeps the connection fresh past the hello TTL window', async () => {
    // Connect FIRST (real timers), then explicitly drive `now` via the
    // `isDaemonCapabilityStale(now)` argument. `vi.useFakeTimers()`
    // would block `flushAsync()`'s setTimeout.
    const { client, ws } = await connect();
    const baseTime = 1_000_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(baseTime);
    seedHello(ws);
    expect(client.isDaemonCapabilityStale(baseTime + 1_000)).toBe(false);

    // Inject a daemon.stats just before the original hello's TTL would expire.
    vi.spyOn(Date, 'now').mockReturnValue(baseTime + P2P_CAPABILITY_FRESHNESS_TTL_MS - 1_000);
    sendDaemonMsg(ws, 'daemon.stats', { cpu: 0.1 });

    // Jump well past the hello's TTL — but within TTL of the latest
    // daemon.stats. Stale judgment must be FRESH (the contract N4
    // pins).
    const queryAt = baseTime + P2P_CAPABILITY_FRESHNESS_TTL_MS + 5_000;
    expect(client.isDaemonCapabilityStale(queryAt)).toBe(false);
  });

  it('server-synthesized pong does NOT keep the snapshot fresh', async () => {
    const { client, ws } = await connect();
    const baseTime = 1_000_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(baseTime);
    seedHello(ws);

    // Inject only pongs across the TTL — these should NOT extend freshness.
    for (let t = 5_000; t < P2P_CAPABILITY_FRESHNESS_TTL_MS + 10_000; t += 5_000) {
      vi.spyOn(Date, 'now').mockReturnValue(baseTime + t);
      ws.emit('message', { data: JSON.stringify({ type: 'pong' }) });
    }
    const queryAt = baseTime + P2P_CAPABILITY_FRESHNESS_TTL_MS + 10_000;
    expect(client.isDaemonCapabilityStale(queryAt)).toBe(true);
  });

  it('WS close clears the capability snapshot (and lastSeenAt resets)', async () => {
    const { client, ws } = await connect();
    seedHello(ws);
    expect(client.isDaemonCapabilityStale()).toBe(false);
    ws.emit('close', { code: 1000, reason: '' });
    // After close + snapshot null, isDaemonCapabilityStale must be true again.
    expect(client.isDaemonCapabilityStale()).toBe(true);
  });
});
