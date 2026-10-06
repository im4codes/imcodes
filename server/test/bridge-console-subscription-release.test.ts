/**
 * tsk_58c8fb1b73: the daemon keeps one task-console subscription per viewer and
 * sends every delta once per subscription. A browser socket that vanishes
 * (tab closed, phone asleep, network drop) never sent an UNSUBSCRIBE, so its
 * subscription - and the per-delta work it costs - outlived it. The bridge now
 * remembers what each socket subscribed to and releases it on the daemon's
 * behalf when the socket goes away.
 *
 * @vitest-environment node
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsBridge } from '../src/ws/bridge.js';
import { SUPERVISION_TASK_CONSOLE_MSG } from '../../shared/supervision-task-console.js';

vi.mock('../src/security/crypto.js', () => ({ sha256Hex: (_s: string) => 'valid-hash' }));
vi.mock('../src/routes/push.js', () => ({ dispatchPush: vi.fn() }));

class MockWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  closed = false;
  readyState = 1;
  send(data: string | Buffer, _opts?: unknown, callback?: (err?: Error) => void): void {
    if (this.closed) { callback?.(new Error('socket closed')); return; }
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

const flush = () => new Promise<void>((resolve) => { setImmediate(resolve); });
const SCOPE = { projectName: 'cd', coordinatorSessionName: 'deck_cd_brain' };

describe('WsBridge releases a vanished browser\'s task-console subscriptions', () => {
  let serverId: string;
  beforeEach(() => { serverId = `console-release-${Math.random().toString(36).slice(2)}`; });
  afterEach(() => { WsBridge.getAll().clear(); vi.clearAllMocks(); });

  async function setup() {
    const bridge = WsBridge.get(serverId);
    const daemon = new MockWs();
    const browserA = new MockWs();
    const browserB = new MockWs();
    bridge.handleDaemonConnection(daemon as never, makeDb() as never, {} as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'tok' }));
    await flush();
    bridge.handleBrowserConnection(browserA as never, { id: 'user-a' } as never);
    bridge.handleBrowserConnection(browserB as never, { id: 'user-a' } as never);
    return { bridge, daemon, browserA, browserB };
  }

  const subscribe = (subscriptionId: string, clientId?: string) => JSON.stringify({
    type: SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE, subscriptionId, scope: SCOPE, afterEventId: null, reason: 'initial',
    ...(clientId ? { clientId } : {}),
  });
  const unsubscribesOf = (daemon: MockWs) => daemon.sentStrings
    .map((raw) => JSON.parse(raw))
    .filter((frame) => frame.type === SUPERVISION_TASK_CONSOLE_MSG.UNSUBSCRIBE);

  it('sends the daemon an UNSUBSCRIBE for each subscription the closed socket held, and leaves other sockets alone', async () => {
    const { daemon, browserA, browserB } = await setup();
    browserA.emit('message', subscribe('sub-A', 'tab-A'));
    browserB.emit('message', subscribe('sub-B', 'tab-B'));
    await flush();
    expect(unsubscribesOf(daemon)).toEqual([]);

    browserA.close();
    await flush();
    expect(unsubscribesOf(daemon)).toEqual([
      { type: SUPERVISION_TASK_CONSOLE_MSG.UNSUBSCRIBE, subscriptionId: 'sub-A', scope: SCOPE },
    ]);
  });

  it('only the viewer\'s newest subscription is released (a re-subscribe replaces the older id)', async () => {
    const { daemon, browserA } = await setup();
    browserA.emit('message', subscribe('a-1', 'tab-A'));
    browserA.emit('message', subscribe('a-2', 'tab-A'));
    browserA.emit('message', subscribe('a-3', 'tab-A'));
    await flush();
    browserA.close();
    await flush();
    expect(unsubscribesOf(daemon).map((frame) => frame.subscriptionId)).toEqual(['a-3']);
  });

  it('an explicit UNSUBSCRIBE is forwarded once and not repeated at close', async () => {
    const { daemon, browserA } = await setup();
    browserA.emit('message', subscribe('sub-A', 'tab-A'));
    browserA.emit('message', JSON.stringify({ type: SUPERVISION_TASK_CONSOLE_MSG.UNSUBSCRIBE, subscriptionId: 'sub-A', scope: SCOPE }));
    await flush();
    expect(unsubscribesOf(daemon)).toHaveLength(1);
    browserA.close();
    await flush();
    expect(unsubscribesOf(daemon)).toHaveLength(1);
  });

  it('a socket that never subscribed releases nothing', async () => {
    const { daemon, browserA } = await setup();
    browserA.close();
    await flush();
    expect(unsubscribesOf(daemon)).toEqual([]);
  });

  it('bounds what one socket can make the bridge remember', async () => {
    const { daemon, browserA } = await setup();
    for (let i = 0; i < 100; i += 1) browserA.emit('message', subscribe(`s-${i}`, `viewer-${i}`));
    await flush();
    browserA.close();
    await flush();
    expect(unsubscribesOf(daemon).length).toBeLessThanOrEqual(32);
  });
});
