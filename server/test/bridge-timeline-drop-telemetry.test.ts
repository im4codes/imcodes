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
import { TIMELINE_MESSAGES, TIMELINE_SUBSCRIPTION_MODES } from '../../shared/timeline-protocol.js';
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

class SlowWs extends MockWs {
  bufferedAmount = 2 * 1024 * 1024;

  override send(data: string | Buffer, _opts?: unknown, _callback?: (err?: Error) => void): void {
    if (this.closed) return;
    this.sent.push(data);
    // Deliberately never acknowledge: this models a browser whose event loop
    // stopped reading. The bounded timeline queue must emit a seq gap rather
    // than growing without limit.
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

  it('delivers live timeline events to a same-user companion without its own transient session subscription', async () => {
    const { daemon, bridge } = await setupAuthedDaemon();
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

  it('filters streaming deltas per socket while summary still receives the final assistant text and tool summary', async () => {
    const { bridge, daemon } = await setupAuthedDaemon();
    const full = new MockWs();
    const summary = new MockWs();
    bridge.handleBrowserConnection(full as never, 'user-1', makeDb());
    bridge.handleBrowserConnection(summary as never, 'user-1', makeDb());
    full.emit('message', JSON.stringify({ type: TIMELINE_MESSAGES.SUBSCRIBE, sessionName: SESSION, mode: TIMELINE_SUBSCRIPTION_MODES.FULL }));
    summary.emit('message', JSON.stringify({ type: TIMELINE_MESSAGES.SUBSCRIBE, sessionName: SESSION, mode: TIMELINE_SUBSCRIPTION_MODES.SUMMARY }));
    await flushAsync();
    full.sent.length = 0;
    summary.sent.length = 0;

    const emit = (type: string, payload: Record<string, unknown>, seq: number) => daemon.emit('message', JSON.stringify({
      type: TIMELINE_MESSAGES.EVENT,
      event: { eventId: `evt-${seq}`, sessionId: SESSION, ts: Date.now(), seq, epoch: 1, type, payload },
    }));
    emit('assistant.text', { text: 'partial', streaming: true }, 1);
    emit('tool.result', { name: 'shell', status: 'ok', output: 'a very long body that summary must bound' }, 2);
    emit('assistant.text', { text: 'complete answer', streaming: false }, 3);
    await flushAsync();

    const fullEvents = full.sentStrings.map((raw) => JSON.parse(raw)).filter((msg) => msg.type === TIMELINE_MESSAGES.EVENT);
    const summaryEvents = summary.sentStrings.map((raw) => JSON.parse(raw)).filter((msg) => msg.type === TIMELINE_MESSAGES.EVENT);
    expect(fullEvents.map((msg) => msg.event.payload.text)).toContain('partial');
    expect(fullEvents.map((msg) => msg.event.payload.text)).toContain('complete answer');
    expect(summaryEvents.map((msg) => msg.event.payload.text)).not.toContain('partial');
    expect(summaryEvents.map((msg) => msg.event.payload.text)).toContain('complete answer');
    const tool = summaryEvents.find((msg) => msg.event.type === 'tool.result');
    expect(tool?.event.summary).toBe(true);
    expect(tool?.event.detailAvailable).toBe(true);
    expect(tool?.event.payload.output).toBeUndefined();
  });

  it('does not copy an explicit timeline stream to a companion socket without its own subscription', async () => {
    const { bridge, daemon } = await setupAuthedDaemon();
    const active = new MockWs();
    const companion = new MockWs();
    bridge.handleBrowserConnection(active as never, 'user-1', makeDb());
    bridge.handleBrowserConnection(companion as never, 'user-1', makeDb());
    active.emit('message', JSON.stringify({ type: TIMELINE_MESSAGES.SUBSCRIBE, sessionName: SESSION, mode: TIMELINE_SUBSCRIPTION_MODES.FULL }));
    await flushAsync();
    active.sent.length = 0;
    companion.sent.length = 0;
    daemon.emit('message', timelineEvent('assistant.text', 'only active saw this'));
    await flushAsync();
    expect(active.sentStrings.some((raw) => JSON.parse(raw).type === TIMELINE_MESSAGES.EVENT)).toBe(true);
    expect(companion.sentStrings.some((raw) => JSON.parse(raw).type === TIMELINE_MESSAGES.EVENT)).toBe(false);
  });

  it('never coalesces a healthy full-mode stream, including latest-value updates', async () => {
    const { bridge, daemon } = await setupAuthedDaemon();
    const full = new MockWs();
    bridge.handleBrowserConnection(full as never, 'user-1', makeDb());
    full.emit('message', JSON.stringify({
      type: TIMELINE_MESSAGES.SUBSCRIBE,
      sessionName: SESSION,
      mode: TIMELINE_SUBSCRIPTION_MODES.FULL,
    }));
    await flushAsync();
    full.sent.length = 0;
    for (let seq = 1; seq <= 4; seq += 1) {
      daemon.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.EVENT,
        event: {
          eventId: `status-${seq}`,
          sessionId: SESSION,
          ts: Date.now(),
          seq,
          epoch: 1,
          type: 'agent.status',
          payload: { status: `step-${seq}` },
        },
      }));
    }
    await flushAsync();
    const statuses = full.sentStrings
      .map((raw) => JSON.parse(raw))
      .filter((msg) => msg.type === TIMELINE_MESSAGES.EVENT && msg.event?.type === 'agent.status');
    expect(statuses).toHaveLength(4);
    expect(statuses.map((msg) => msg.event.seq)).toEqual([1, 2, 3, 4]);
    expect(getCounter(TIMELINE_DELIVERY_METRICS.SERVER_SOCKET_COALESCED)).toBe(0);
  });

  it('mode switch with a cursor reuses timeline.history_request for backfill', async () => {
    const { bridge, daemon } = await setupAuthedDaemon();
    const browser = new MockWs();
    bridge.handleBrowserConnection(browser as never, 'user-1', makeDb());
    browser.emit('message', JSON.stringify({
      type: TIMELINE_MESSAGES.SUBSCRIBE,
      sessionName: SESSION,
      mode: TIMELINE_SUBSCRIPTION_MODES.FULL,
      epoch: 7,
      afterSeq: 42,
      requestId: 'backfill-1',
    }));
    await flushAsync();
    const request = daemon.sentStrings.map((raw) => JSON.parse(raw)).find((msg) => msg.type === TIMELINE_MESSAGES.HISTORY_REQUEST);
    expect(request).toMatchObject({
      type: TIMELINE_MESSAGES.HISTORY_REQUEST,
      sessionName: SESSION,
      requestId: 'backfill-1',
      cursor: { epoch: 7, afterSeq: 42, direction: 'newer' },
    });
  });

  it('emits seq_gap when a slow summary socket exhausts its bounded queue', async () => {
    const { bridge, daemon } = await setupAuthedDaemon();
    const slow = new SlowWs();
    bridge.handleBrowserConnection(slow as never, 'user-1', makeDb());
    slow.emit('message', JSON.stringify({ type: TIMELINE_MESSAGES.SUBSCRIBE, sessionName: SESSION, mode: TIMELINE_SUBSCRIPTION_MODES.SUMMARY }));
    await flushAsync();
    slow.sent.length = 0;
    for (let seq = 1; seq <= 600; seq += 1) {
      daemon.emit('message', timelineEvent('user.message', `message-${seq}`));
    }
    await flushAsync();
    const gaps = slow.sentStrings.map((raw) => JSON.parse(raw)).filter((msg) => msg.type === TIMELINE_MESSAGES.SEQ_GAP);
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps[0]).toMatchObject({ sessionId: SESSION, epoch: 1, backfill: true, reason: 'backpressure' });
  });

  it('emits seq_gap metadata when a slow socket coalesces a latest-value frame', async () => {
    const { bridge, daemon } = await setupAuthedDaemon();
    const slow = new SlowWs();
    bridge.handleBrowserConnection(slow as never, 'user-1', makeDb());
    slow.emit('message', JSON.stringify({
      type: TIMELINE_MESSAGES.SUBSCRIBE,
      sessionName: SESSION,
      mode: TIMELINE_SUBSCRIPTION_MODES.SUMMARY,
    }));
    await flushAsync();
    slow.sent.length = 0;
    daemon.emit('message', JSON.stringify({
      type: TIMELINE_MESSAGES.EVENT,
      event: {
        eventId: 'durable-10',
        sessionId: SESSION,
        ts: Date.now(),
        seq: 10,
        epoch: 2,
        type: 'user.message',
        payload: { text: 'hold the queue open' },
      },
    }));
    for (const seq of [11, 12]) {
      daemon.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.EVENT,
        event: {
          eventId: `status-${seq}`,
          sessionId: SESSION,
          ts: Date.now(),
          seq,
          epoch: 2,
          type: 'agent.status',
          payload: { status: `step-${seq}` },
        },
      }));
    }
    await flushAsync();
    const gaps = slow.sentStrings.map((raw) => JSON.parse(raw))
      .filter((msg) => msg.type === TIMELINE_MESSAGES.SEQ_GAP);
    expect(gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: SESSION, epoch: 2, fromSeq: 11, toSeq: 11, backfill: true }),
    ]));
  });
});
