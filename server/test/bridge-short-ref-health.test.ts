/**
 * Memory-handle persistence failures have to reach a person.
 *
 * The daemon's own two signals cannot: the counter is a process-local map that a
 * restart clears, and the throttled warning goes to the daemon log — on the same
 * disk whose exhaustion is usually the failure being reported. So the daemon
 * puts a sticky health record on its heartbeat instead.
 *
 * That only helps if the bridge forwards it. It previously rebuilt daemon.stats
 * from a fixed field list, so the record arrived at the pod and went no further:
 * no UI, no alert, nothing. A daemon-side test cannot catch that — it has to be
 * asserted here, where the frame crosses to the browser.
 *
 * @vitest-environment node
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsBridge } from '../src/ws/bridge.js';

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
  get sentStrings(): string[] { return this.sent.filter((s): s is string => typeof s === 'string'); }
}

function makeDb() {
  return {
    queryOne: async () => ({ token_hash: 'valid-hash', node_role: 'full', revoked_at: null }),
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
    close: () => {},
  } as unknown as import('../src/db/client.js').Database;
}

const flushAsync = () => new Promise<void>((resolve) => { setImmediate(resolve); });

describe('WsBridge forwards memory-handle persistence health to browsers', () => {
  let serverId: string;

  beforeEach(() => { serverId = `test-${Math.random().toString(36).slice(2)}`; });
  afterEach(() => { WsBridge.getAll().clear(); vi.clearAllMocks(); });

  const shortRefHealth = {
    stage: 'persist_store',
    failures: 3,
    lastFailureAt: 1_700_000_000_000,
    lastError: 'ENOSPC: no space left on device',
  };

  const baseStats = {
    daemonVersion: '1.2.3',
    cpu: 12, memUsed: 1, memTotal: 2,
    load1: 0.1, load5: 0.2, load15: 0.3, uptime: 100,
  };

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

  function statsSeenByBrowser(browser: MockWs): Record<string, unknown> | undefined {
    for (const raw of browser.sentStrings) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed.type === 'daemon.stats') return parsed;
    }
    return undefined;
  }

  it('delivers the health record from a daemon.stats frame to the browser', async () => {
    const { daemon, browser } = await connect();

    daemon.emit('message', JSON.stringify({ type: 'daemon.stats', ...baseStats, shortRefHealth }));
    await flushAsync();

    expect(statsSeenByBrowser(browser)).toMatchObject({ type: 'daemon.stats', shortRefHealth });
  });

  it('delivers it from a heartbeat frame as well, so a reconnect still surfaces it', async () => {
    // The daemon repeats the sticky record on every beat; an operator who
    // connects after the incident learns about it from the next one.
    const { daemon, browser } = await connect();

    daemon.emit('message', JSON.stringify({ type: 'heartbeat', ...baseStats, shortRefHealth }));
    await flushAsync();

    expect(statsSeenByBrowser(browser)).toMatchObject({ shortRefHealth });
  });

  it('omits the field entirely while persistence is healthy', async () => {
    const { daemon, browser } = await connect();

    daemon.emit('message', JSON.stringify({ type: 'daemon.stats', ...baseStats }));
    await flushAsync();

    const stats = statsSeenByBrowser(browser);
    expect(stats).toBeDefined();
    expect(stats).not.toHaveProperty('shortRefHealth');
  });

  it('drops a non-object health value rather than forwarding junk', async () => {
    const { daemon, browser } = await connect();

    daemon.emit('message', JSON.stringify({ type: 'daemon.stats', ...baseStats, shortRefHealth: 'disk full' }));
    await flushAsync();

    expect(statsSeenByBrowser(browser)).not.toHaveProperty('shortRefHealth');
  });
});
