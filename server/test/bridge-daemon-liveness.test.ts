/**
 * A link-worker heartbeat must never become an empty daemon.stats.
 *
 * With the core-lane link worker on, the heartbeat carries only event-loop
 * liveness while the main thread sends the full daemon.stats every 5 s. The
 * bridge used to rebuild ANY heartbeat with a core-lane field as a full
 * daemon.stats, so every other frame a viewer received had cpu/mem/load/uptime
 * missing, and a viewer that replaces its last stats with each frame showed
 * "NaN / NaN MB", "%", "/ /" and "unknown" -- the empty status card.
 *
 * @vitest-environment node
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsBridge } from '../src/ws/bridge.js';
import { SHARE_SCOPED_DAEMON_MESSAGE_POLICY } from '../src/ws/share-policy.js';
import { DAEMON_LIVENESS_MSG, DAEMON_STATS_MSG, DAEMON_STATS_NUMERIC_KEYS } from '../../shared/daemon-stats.js';

vi.mock('../src/security/crypto.js', () => ({ sha256Hex: (_s: string) => 'valid-hash' }));
vi.mock('../src/routes/push.js', () => ({ dispatchPush: vi.fn() }));

class MockWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  closed = false;
  readyState = 1;
  send(data: string | Buffer, _opts?: unknown, callback?: (err?: Error) => void): void {
    this.sent.push(data);
    callback?.();
  }
  close(): void { this.closed = true; this.readyState = 3; this.emit('close'); }
  get sentJson(): Array<Record<string, unknown>> {
    return this.sent.filter((s): s is string => typeof s === 'string').map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

function makeDb() {
  return {
    queryOne: async () => ({ token_hash: 'valid-hash', owner_status: 'active', node_role: 'full', revoked_at: null }),
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
    close: () => {},
  } as unknown as import('../src/db/client.js').Database;
}

const flushAsync = () => new Promise<void>((resolve) => { setImmediate(resolve); });

const fullStats = {
  daemonVersion: '1.2.3',
  cpu: 12, memUsed: 1024, memTotal: 2048,
  load1: 0.1, load5: 0.2, load15: 0.3, uptime: 100,
};

// Exactly what src/daemon/server-link-worker.ts sendHeartbeat() puts on the wire.
const workerHeartbeat = (blockedMs: number, busy: boolean) => ({
  type: 'heartbeat',
  daemonVersion: '1.2.3',
  sentAt: 1_700_000_000_000,
  mainEventLoopLagMs: 4,
  mainEventLoopBlockedMs: blockedMs,
  mainEventLoopBusy: busy,
});

describe('WsBridge: liveness-only heartbeats do not masquerade as daemon.stats', () => {
  let serverId: string;

  beforeEach(() => { serverId = `test-${Math.random().toString(36).slice(2)}`; });
  afterEach(() => { WsBridge.getAll().clear(); vi.clearAllMocks(); });

  async function connect() {
    const bridge = WsBridge.get(serverId);
    const daemon = new MockWs();
    const browser = new MockWs();
    bridge.handleDaemonConnection(daemon as never, makeDb() as never, {} as never);
    bridge.handleBrowserConnection(browser as never, { id: 'user-a' } as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token' }));
    await flushAsync();
    return { daemon, browser };
  }

  it('sends a worker heartbeat as daemon.liveness and never as a stats frame missing its numbers', async () => {
    const { daemon, browser } = await connect();
    daemon.emit('message', JSON.stringify(workerHeartbeat(30_000, true)));
    await flushAsync();

    const frames = browser.sentJson;
    expect(frames.filter((f) => f.type === DAEMON_STATS_MSG)).toEqual([]);
    expect(frames.find((f) => f.type === DAEMON_LIVENESS_MSG)).toEqual({
      type: DAEMON_LIVENESS_MSG,
      daemonVersion: '1.2.3',
      mainEventLoopLagMs: 4,
      mainEventLoopBlockedMs: 30_000,
      mainEventLoopBusy: true,
    });
  });

  it('every daemon.stats a viewer receives carries all system numbers, however heartbeats and stats interleave', async () => {
    const { daemon, browser } = await connect();
    for (let i = 0; i < 4; i += 1) {
      daemon.emit('message', JSON.stringify({ type: 'daemon.stats', ...fullStats, cpu: 10 + i }));
      daemon.emit('message', JSON.stringify(workerHeartbeat(i * 1_000, false)));
    }
    await flushAsync();

    const statsFrames = browser.sentJson.filter((f) => f.type === DAEMON_STATS_MSG);
    expect(statsFrames).toHaveLength(4);
    for (const frame of statsFrames) {
      for (const key of DAEMON_STATS_NUMERIC_KEYS) {
        expect(Number.isFinite(frame[key]), `${key} in ${JSON.stringify(frame)}`).toBe(true);
      }
    }
    expect(browser.sentJson.filter((f) => f.type === DAEMON_LIVENESS_MSG)).toHaveLength(4);
  });

  it('keeps the kill-switch path unchanged: a main-thread heartbeat carrying system stats is still a full daemon.stats', async () => {
    const { daemon, browser } = await connect();
    daemon.emit('message', JSON.stringify({ type: 'heartbeat', ...fullStats, sentAt: 1_700_000_000_000 }));
    await flushAsync();

    expect(browser.sentJson.find((f) => f.type === DAEMON_STATS_MSG)).toMatchObject({ cpu: 12, memUsed: 1024, memTotal: 2048, uptime: 100 });
    expect(browser.sentJson.some((f) => f.type === DAEMON_LIVENESS_MSG)).toBe(false);
  });

  it('a heartbeat with neither system stats nor liveness produces no status frame at all', async () => {
    const { daemon, browser } = await connect();
    daemon.emit('message', JSON.stringify({ type: 'heartbeat', daemonVersion: '1.2.3', sentAt: 1_700_000_000_000 }));
    await flushAsync();

    expect(browser.sentJson.filter((f) => f.type === DAEMON_STATS_MSG || f.type === DAEMON_LIVENESS_MSG)).toEqual([]);
  });

  it('never delivers daemon.liveness to a share-scoped participant, and drops a stats frame without numbers', () => {
    // Unknown daemon message types are default-denied for share-scoped sockets,
    // so liveness stays owner-only exactly as the busy flags always were.
    expect(SHARE_SCOPED_DAEMON_MESSAGE_POLICY.has(DAEMON_LIVENESS_MSG)).toBe(false);

    const policy = SHARE_SCOPED_DAEMON_MESSAGE_POLICY.get(DAEMON_STATS_MSG);
    const state = { snapshot: { effectiveRole: 'participant' }, target: { kind: 'server', serverId } } as never;
    expect(policy?.redact?.({ type: DAEMON_STATS_MSG, daemonVersion: '1.2.3', latestDaemonVersion: null }, state)).toBeNull();
    expect(policy?.redact?.({ type: DAEMON_STATS_MSG, ...fullStats }, state)).toMatchObject({ cpu: 12, uptime: 100 });
  });
});
