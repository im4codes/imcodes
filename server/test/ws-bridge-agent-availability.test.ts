/**
 * @vitest-environment node
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsBridge } from '../src/ws/bridge.js';
import { AGENT_AVAILABILITY_MSG } from '../../shared/agent-availability.js';

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

describe('WsBridge: agent availability relay', () => {
  let serverId: string;

  beforeEach(() => { serverId = `test-avail-${Math.random().toString(36).slice(2)}`; });
  afterEach(() => { WsBridge.getAll().clear(); vi.clearAllMocks(); });

  it('forwards session.detect_agents from browser to daemon and broadcasts session.agents_availability to browsers', async () => {
    const bridge = WsBridge.get(serverId);
    const daemon = new MockWs();
    const browser = new MockWs();
    bridge.handleDaemonConnection(daemon as never, makeDb() as never, {} as never);
    bridge.handleBrowserConnection(browser as never, { id: 'user-a' } as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token' }));
    await flushAsync();

    browser.emit('message', JSON.stringify({ type: AGENT_AVAILABILITY_MSG.DETECT, forceRefresh: true }));
    await flushAsync();

    expect(daemon.sentJson).toContainEqual({
      type: AGENT_AVAILABILITY_MSG.DETECT,
      forceRefresh: true,
    });

    const availabilityPayload = {
      type: AGENT_AVAILABILITY_MSG.RESULT,
      agents: { 'agy-sdk': { installed: false }, 'codex-sdk': { installed: true } },
      checkedAt: 1_700_000_000_000,
    };
    daemon.emit('message', JSON.stringify(availabilityPayload));
    await flushAsync();

    expect(browser.sentJson).toContainEqual(availabilityPayload);
  });
});
