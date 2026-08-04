/**
 * Bridge-level observability for timeline events that never reach a browser.
 *
 * Timeline events fan out from a subscribed viewer to that user's companion
 * browser connections. A companion's transient subscription state must not
 * make one device stream while another only catches the persisted final event;
 * users with no subscribed viewer remain isolated.
 *
 * The client now heals that automatically (activation/reconnect request the full
 * newest window with no lower bound), so the drop itself has to be counted or a
 * rising drop rate would be permanently masked by the recovery.
 *
 * @vitest-environment node
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsBridge } from '../src/ws/bridge.js';
import { TIMELINE_MESSAGES } from '../../shared/timeline-protocol.js';
import { TIMELINE_DELIVERY_METRICS } from '../../shared/timeline-delivery-telemetry.js';
import { getCounter, resetMetricsForTests } from '../src/util/metrics.js';

vi.mock('../src/security/crypto.js', () => ({
  sha256Hex: (_s: string) => 'valid-hash',
}));

vi.mock('../src/routes/push.js', () => ({
  dispatchPush: vi.fn(),
}));

class MockWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  closed = false;
  readyState = 1;

  send(data: string | Buffer, _opts?: unknown, callback?: (err?: Error) => void): void {
    if (this.closed) { callback?.(new Error('socket closed')); return; }
    this.sent.push(data);
    callback?.();
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.emit('close');
  }

  get sentStrings(): string[] {
    return this.sent.filter((s): s is string => typeof s === 'string');
  }
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

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}

const SESSION = 'deck_droptelemetry_brain';

function timelineEvent(type: string, text = 'hello'): string {
  return JSON.stringify({
    type: TIMELINE_MESSAGES.EVENT,
    event: {
      eventId: `evt-${Math.random().toString(36).slice(2)}`,
      sessionId: SESSION,
      ts: Date.now(),
      seq: 1,
      epoch: 1,
      type,
      payload: { text },
    },
  });
}

describe('WsBridge timeline drop telemetry', () => {
  let serverId: string;

  beforeEach(() => {
    serverId = `drop-${Math.random().toString(36).slice(2)}`;
    resetMetricsForTests();
  });

  afterEach(() => {
    WsBridge.getAll().clear();
    vi.clearAllMocks();
  });

  async function setupAuthedDaemon() {
    const bridge = WsBridge.get(serverId);
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, makeDb() as never, {} as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'tok' }));
    await flushAsync();
    expect(bridge.isAuthenticated).toBe(true);
    return { bridge, daemon };
  }

  it('counts a content-bearing timeline event discarded because no browser is connected', async () => {
    const { daemon } = await setupAuthedDaemon();

    daemon.emit('message', timelineEvent('assistant.text', 'answer nobody saw'));
    await flushAsync();

    expect(getCounter(TIMELINE_DELIVERY_METRICS.SERVER_NO_SUBSCRIBER_DROPPED, { eventType: 'assistant.text' }))
      .toBe(1);
    expect(getCounter(TIMELINE_DELIVERY_METRICS.SERVER_DELIVERED, { eventType: 'assistant.text' }))
      .toBe(0);
  });

  // Skipped alongside `companionDeviceFanoutEnabled` in bridge.ts — see the
  // flag's comment. Un-skip when the fan-out comes back.
  it.skip('delivers live timeline events to a same-user companion without its own transient session subscription', async () => {
    const { bridge, daemon } = await setupAuthedDaemon();
    const subscribed = new MockWs();
    const companion = new MockWs();
    bridge.handleBrowserConnection(subscribed as never, 'user-1', makeDb());
    bridge.handleBrowserConnection(companion as never, 'user-1', makeDb());
    subscribed.emit('message', JSON.stringify({
      type: 'terminal.subscribe',
      session: SESSION,
      raw: false,
    }));
    await flushAsync();
    subscribed.sent.length = 0;
    companion.sent.length = 0;

    daemon.emit('message', timelineEvent('assistant.text', 'streaming on every device'));
    await flushAsync();

    for (const browser of [subscribed, companion]) {
      const events = browser.sentStrings
        .map((raw) => JSON.parse(raw) as { type: string; event?: { payload?: { text?: string } } })
        .filter((msg) => msg.type === TIMELINE_MESSAGES.EVENT);
      expect(events).toHaveLength(1);
      expect(events[0]?.event?.payload?.text).toBe('streaming on every device');
    }
    expect(getCounter(TIMELINE_DELIVERY_METRICS.SERVER_DELIVERED, { eventType: 'assistant.text' }))
      .toBe(1);
    expect(getCounter(TIMELINE_DELIVERY_METRICS.SERVER_NO_SUBSCRIBER_DROPPED, { eventType: 'assistant.text' }))
      .toBe(0);
  });

  it('does not count high-frequency status chatter, only content', async () => {
    // agent.status fires ~1/s during a turn; counting it would drown the signal.
    const { daemon } = await setupAuthedDaemon();

    daemon.emit('message', timelineEvent('agent.status'));
    daemon.emit('message', timelineEvent('usage.update'));
    await flushAsync();

    expect(getCounter(TIMELINE_DELIVERY_METRICS.SERVER_NO_SUBSCRIBER_DROPPED, { eventType: 'agent.status' }))
      .toBe(0);
    expect(getCounter(TIMELINE_DELIVERY_METRICS.SERVER_NO_SUBSCRIBER_DROPPED, { eventType: 'usage.update' }))
      .toBe(0);
  });

  it('exposes a running total so a whole backgrounded window is visible as one number', async () => {
    const { bridge, daemon } = await setupAuthedDaemon();

    daemon.emit('message', timelineEvent('assistant.text', 'one'));
    daemon.emit('message', timelineEvent('tool.call', 'two'));
    daemon.emit('message', timelineEvent('user.message', 'three'));
    await flushAsync();

    expect(bridge.timelineNoSubscriberDropCount).toBe(3);
  });
});
