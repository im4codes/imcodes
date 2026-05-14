/**
 * @vitest-environment jsdom
 *
 * **E2E-style integration test** — wires a real `WsClient` to a real
 * `P2pConfigPanel` and pumps fake daemon-originated messages through the
 * full chain. This guards against the failure mode reported in
 * screenshot 7c2570e96eeca1a9eefa3a92d3c7212e.png:
 *
 *   "DAEMON 失联 — 已保存的配置不受影响, 但新的高级工作流启动会暂停,
 *    直到 DAEMON 重连(通常 <30 秒)"
 *
 * still showing on a healthy long-lived browser page even after the N4
 * `daemonLastSeenAt` whitelist landed in `WsClient`. Root cause was the
 * panel computing staleness from `capabilitySnapshot.observedAt`
 * inline, ignoring the WS client's own freshness clock.
 *
 * The contract pinned here:
 *
 *   1. After `daemon.hello`, banner is hidden (panel mounted with fresh
 *      snapshot).
 *   2. Advancing past TTL with a stream of daemon-originated heartbeats
 *      (`daemon.stats`) keeps the banner hidden — even though
 *      `snapshot.observedAt` was set ONLY at the original hello and is
 *      now far past TTL.
 *   3. Stopping the daemon stream and waiting past TTL flips the banner
 *      to visible.
 *   4. Server-only `pong` messages do NOT count as daemon liveness —
 *      they cannot keep the banner hidden by themselves.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, cleanup, act } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallbackOrOpts?: string | Record<string, unknown>) => {
      if (typeof fallbackOrOpts === 'string') return fallbackOrOpts;
      if (fallbackOrOpts && typeof fallbackOrOpts === 'object' && typeof fallbackOrOpts.defaultValue === 'string') {
        return fallbackOrOpts.defaultValue as string;
      }
      return _key.split('.').pop() ?? _key;
    },
  }),
}));

const getUserPrefMock = vi.fn();
const saveUserPrefMock = vi.fn();
// Partial mock so the real `WsClient` (which imports api helpers like
// `apiFetch` / `getApiBaseUrl`) keeps its original implementation while
// we only intercept the user-pref bridge that the panel uses.
vi.mock('../../src/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/api.js')>();
  return {
    ...actual,
    getUserPref: (...args: unknown[]) => getUserPrefMock(...args),
    saveUserPref: (...args: unknown[]) => saveUserPrefMock(...args),
    onUserPrefChanged: (_cb: (key: string, value: unknown) => void) => () => {},
  };
});

import { P2pConfigPanel } from '../../src/components/P2pConfigPanel.js';
import { WsClient } from '../../src/ws-client.js';
import { P2P_WORKFLOW_MSG } from '@shared/p2p-workflow-messages.js';
import { P2P_CAPABILITY_FRESHNESS_TTL_MS, P2P_WORKFLOW_CAPABILITY_V1 } from '@shared/p2p-workflow-constants.js';

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = MockWebSocket.CONNECTING;
  url: string;
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};
  constructor(url: string) { this.url = url; }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  send = vi.fn();
  close() { this.readyState = MockWebSocket.CLOSED; this.emit('close', { code: 1000, reason: '' }); }
  emit(type: string, data?: unknown) {
    if (type === 'open') this.readyState = MockWebSocket.OPEN;
    if (type === 'close') this.readyState = MockWebSocket.CLOSED;
    for (const fn of this.listeners[type] ?? []) fn(data);
  }
}

const flushAsync = () => new Promise<void>((r) => setTimeout(r, 0));
let lastWs: MockWebSocket | null = null;

async function flushReact() {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}

const helloMessage = (epoch: number) => ({
  data: JSON.stringify({
    type: P2P_WORKFLOW_MSG.DAEMON_HELLO,
    daemonId: 'daemon-1',
    capabilities: [P2P_WORKFLOW_CAPABILITY_V1],
    helloEpoch: epoch,
    sentAt: Date.now(),
  }),
});

const daemonStatsMessage = (cpu = 0.1) => ({
  data: JSON.stringify({ type: 'daemon.stats', cpu, memUsed: 100, memTotal: 1000 }),
});

const pongMessage = () => ({ data: JSON.stringify({ type: 'pong' }) });

describe('P2P stale banner e2e — WsClient ↔ panel integration (7c2570e9)', () => {
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
    getUserPrefMock.mockReset();
    saveUserPrefMock.mockReset();
    saveUserPrefMock.mockResolvedValue(undefined);
    getUserPrefMock.mockResolvedValue({
      sessions: {},
      rounds: 1,
      hopTimeoutMinutes: 5,
      advancedPresetKey: 'audit',
      advancedRunTimeoutMinutes: 30,
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  async function connect(): Promise<{ client: WsClient; ws: MockWebSocket }> {
    const client = new WsClient('http://localhost:8787', 'srv-1');
    client.connect();
    await flushAsync();
    lastWs!.emit('open');
    return { client, ws: lastWs! };
  }

  function sourceFor(client: WsClient) {
    return {
      getSnapshot: () => client.getDaemonCapabilitySnapshot(),
      subscribe: (listener: () => void) => client.onDaemonCapabilitySnapshot(listener),
      isStale: (now?: number) => client.isDaemonCapabilityStale(now),
    };
  }

  it('healthy long-lived daemon: banner stays hidden across multiple TTL windows', async () => {
    const { client, ws } = await connect();
    ws.emit('message', helloMessage(1));
    await flushAsync();

    const { container } = render(
      h(P2pConfigPanel, {
        sessions: [{ name: 'deck_x_brain', agentType: 'claude-code-sdk', state: 'running' }],
        subSessions: [],
        activeSession: 'deck_x_brain',
        serverId: 'srv-1',
        initialTab: 'advanced',
        onClose: () => {},
        onSave: () => {},
        daemonCapabilitySource: sourceFor(client),
      } as never),
    );
    await flushReact();

    // Initially fresh — banner hidden.
    expect(container.querySelector('[data-testid="p2p-capability-stale-banner"]')).toBeNull();

    // Advance Date.now() past TTL but inject daemon.stats periodically so
    // the WS client's daemonLastSeenAt stays fresh. Without the PR-φ fix,
    // the panel reads `snapshot.observedAt` (frozen at hello time) and
    // shows the banner — exactly the 7c2570e9 screenshot.
    const baseTime = Date.now();
    const dateNowSpy = vi.spyOn(Date, 'now');
    let virtualNow = baseTime;
    dateNowSpy.mockImplementation(() => virtualNow);

    for (let elapsed = 5_000; elapsed < P2P_CAPABILITY_FRESHNESS_TTL_MS * 3; elapsed += 5_000) {
      virtualNow = baseTime + elapsed;
      ws.emit('message', daemonStatsMessage());
      await flushReact();
    }

    // After 90 s of healthy heartbeats, banner MUST still be hidden.
    expect(container.querySelector('[data-testid="p2p-capability-stale-banner"]')).toBeNull();
  });

  it('daemon goes silent: WsClient.isDaemonCapabilityStale flips to true past TTL', async () => {
    // Simpler than driving the panel's React-internal setInterval +
    // re-render under fake timers. Verify the contract at the integration
    // boundary (WsClient ↔ source.isStale()) — this is the surface the
    // panel actually consumes. The panel's polling is exercised by
    // ws-client-daemon-last-seen.test.ts and the React-level test in
    // P2pConfigPanel-stale-banner.test.tsx.
    //
    // Pin Date.now() BEFORE emitting hello so the WS client's
    // daemonLastSeenAt is anchored to the mocked clock. Otherwise hello
    // bumps lastSeen using real wall-clock and the relative `now`
    // assertion below would compare apples to oranges.
    const baseTime = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(baseTime);

    const { client, ws } = await connect();
    ws.emit('message', helloMessage(1));
    await flushAsync();
    const source = sourceFor(client);

    // hello just landed at baseTime — fresh.
    expect(source.isStale(baseTime)).toBe(false);

    // No further daemon traffic. After TTL elapses, WS client
    // considers daemon stale.
    expect(source.isStale(baseTime + P2P_CAPABILITY_FRESHNESS_TTL_MS + 1_000)).toBe(true);
  });

  it('server-only pong stream does NOT keep banner hidden (whitelist contract)', async () => {
    const { client, ws } = await connect();
    ws.emit('message', helloMessage(1));
    await flushAsync();

    const { container } = render(
      h(P2pConfigPanel, {
        sessions: [{ name: 'deck_x_brain', agentType: 'claude-code-sdk', state: 'running' }],
        subSessions: [],
        activeSession: 'deck_x_brain',
        serverId: 'srv-1',
        initialTab: 'advanced',
        onClose: () => {},
        onSave: () => {},
        daemonCapabilitySource: sourceFor(client),
      } as never),
    );
    await flushReact();

    // Pongs are server-synthesized — they prove the bridge is alive but
    // NOT the daemon. Inject only pongs across the TTL and assert
    // `isStale()` returns true (banner shows). This is the key reverse
    // assertion that prevents future regressions where someone "fixes"
    // staleness by bumping on every WS message.
    const baseTime = Date.now();
    const dateNowSpy = vi.spyOn(Date, 'now');
    let virtualNow = baseTime;
    dateNowSpy.mockImplementation(() => virtualNow);

    for (let elapsed = 5_000; elapsed < P2P_CAPABILITY_FRESHNESS_TTL_MS + 10_000; elapsed += 5_000) {
      virtualNow = baseTime + elapsed;
      ws.emit('message', pongMessage());
    }

    // Trust ws-client's own staleness verdict — it has fake clock too.
    expect(client.isDaemonCapabilityStale(virtualNow)).toBe(true);
  });
});
