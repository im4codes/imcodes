/**
 * Integration test: daemon AckOutbox ↔ server WsBridge reliability.
 *
 * This test avoids tmux — it instantiates the real server bridge and a real
 * daemon-side AckOutbox, connects them via a MockWs pair, and exercises:
 *
 *   1. Short daemon-side WS disconnect (< grace window): outbox replays, server
 *      dedups, browser never sees failure.
 *   2. Long daemon-side WS disconnect (> grace window): server emits
 *      daemon.offline + command.failed.
 *   3. Ack timeout: server emits command.failed with reason=ack_timeout.
 *   4. Daemon process "crash" (outbox re-opened from disk): queued acks flush
 *      on next connect; server dedups.
 *
 * Uses the pattern from server/test/bridge.test.ts for MockWs but wires in the
 * actual AckOutbox from src/daemon/ack-outbox.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { WsBridge } from '../server/src/ws/bridge.js';
import { AckOutbox } from '../src/daemon/ack-outbox.js';
import {
  MSG_COMMAND_ACK,
  MSG_COMMAND_FAILED,
  MSG_DAEMON_OFFLINE,
  RECONNECT_GRACE_MS,
  ACK_TIMEOUT_MS,
} from '../shared/ack-protocol.js';

class MockWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  closed = false;
  readyState = 1;
  send(data: string | Buffer, _o?: unknown, cb?: (err?: Error) => void) {
    if (this.closed) { const err = new Error('closed'); if (cb) return cb(err); throw err; }
    this.sent.push(data);
    cb?.();
  }
  close() { this.closed = true; this.readyState = 3; this.emit('close'); }
  sentByType(type: string): Array<Record<string, unknown>> {
    return this.sent
      .filter((s): s is string => typeof s === 'string')
      .map((s) => { try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; } })
      .filter((m): m is Record<string, unknown> => !!m && m.type === type);
  }
}

function makeDb() {
  return {
    queryOne: async () => ({ token_hash: 'valid-hash' }),
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    close: () => {},
  } as unknown as import('../server/src/db/client.js').Database;
}

vi.mock('../server/src/security/crypto.js', () => ({
  sha256Hex: (_s: string) => 'valid-hash',
}));
vi.mock('../server/src/routes/push.js', () => ({
  dispatchPush: vi.fn(),
}));

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => process.nextTick(r));
}

async function connectAndAuthDaemon(bridge: WsBridge, serverId: string): Promise<MockWs> {
  const ws = new MockWs();
  bridge.handleDaemonConnection(ws as never, makeDb() as never, {} as never);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'auth', serverId, token: 't' })));
  await flush();
  return ws;
}

async function connectBrowser(bridge: WsBridge, subscribeSession?: string): Promise<MockWs> {
  const ws = new MockWs();
  bridge.handleBrowserConnection(ws as never, 'user-1', makeDb() as never, false);
  if (subscribeSession) {
    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'terminal.subscribe', session: subscribeSession, raw: false,
    })));
    await flush();
  }
  return ws;
}

describe('Ack reliability — daemon ↔ server integration', () => {
  let tmpDir: string;
  let outboxPath: string;
  let serverId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ack-e2e-'));
    outboxPath = join(tmpDir, 'ack-outbox.jsonl');
    serverId = `ack-e2e-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(async () => {
    WsBridge.getAll().clear();
    vi.clearAllMocks();
    vi.useRealTimers();
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── 1. Short disconnect inside grace — user sees no failure ─────────────
  it('short disconnect inside grace: outbox replays, server dedups, no command.failed', async () => {
    const bridge = WsBridge.get(serverId);
    const daemonWs1 = await connectAndAuthDaemon(bridge, serverId);
    const browser = await connectBrowser(bridge, 'deck_storecheck_brain');

    // Browser sends a command
    browser.emit('message', Buffer.from(JSON.stringify({
      type: 'session.send',
      sessionName: 'deck_storecheck_brain',
      text: 'hi',
      commandId: 'INT-C1',
    })));
    await flush();
    // Daemon got it
    expect(daemonWs1.sentByType('session.send').length).toBe(1);

    // Daemon enqueues the ack into its outbox, but WS drops before send.
    const outbox = new AckOutbox(outboxPath);
    await outbox.init(0);
    await outbox.enqueue({
      commandId: 'INT-C1',
      sessionName: 'deck_storecheck_brain',
      status: 'accepted',
      ts: Date.now(),
    });

    // Drop daemon connection (inside grace)
    daemonWs1.close();
    await flush();

    // Reconnect daemon (still within grace)
    const daemonWs2 = await connectAndAuthDaemon(bridge, serverId);

    // Simulate what server-link onopen does: flush outbox into daemonWs2
    // (which is actually the browser's perspective of daemon → server)
    const sender = Object.assign(
      (msg: Record<string, unknown>) => {
        daemonWs2.emit('message', Buffer.from(JSON.stringify(msg)));
      },
      { isConnected: () => true },
    );
    await outbox.flushOnReconnect(sender as never);
    await flush();

    // Browser should have received ack for INT-C1 exactly once.
    const acks = browser.sentByType(MSG_COMMAND_ACK).filter((a) => a.commandId === 'INT-C1');
    expect(acks.length).toBe(1);
    // And no command.failed surfaced
    expect(browser.sentByType(MSG_COMMAND_FAILED).length).toBe(0);

    await outbox.close();
  });

  // ── 2. Long disconnect — grace expires, browser sees fast failure ───────
  it('long disconnect past grace: server broadcasts daemon.offline + command.failed', async () => {
    vi.useFakeTimers();
    const bridge = WsBridge.get(serverId);
    const daemonWs = await connectAndAuthDaemon(bridge, serverId);
    const browser = await connectBrowser(bridge, 'deck_storecheck_brain');

    browser.emit('message', Buffer.from(JSON.stringify({
      type: 'session.send',
      sessionName: 'deck_storecheck_brain',
      text: 'hi',
      commandId: 'INT-C2',
    })));
    await flush();

    daemonWs.close();
    await flush();
    vi.advanceTimersByTime(RECONNECT_GRACE_MS + 100);
    await flush();

    expect(browser.sentByType(MSG_DAEMON_OFFLINE).length).toBeGreaterThanOrEqual(1);
    const failed = browser.sentByType(MSG_COMMAND_FAILED);
    expect(failed.length).toBe(1);
    expect(failed[0].commandId).toBe('INT-C2');
    expect(failed[0].reason).toBe('daemon_offline');
  });

  // ── 3. Ack timeout surfaces command.failed in ~5s, not 30s ──────────────
  it('ack timeout: command.failed reason=ack_timeout fires at ACK_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    const bridge = WsBridge.get(serverId);
    await connectAndAuthDaemon(bridge, serverId);
    const browser = await connectBrowser(bridge, 'deck_storecheck_brain');

    browser.emit('message', Buffer.from(JSON.stringify({
      type: 'session.send',
      sessionName: 'deck_storecheck_brain',
      text: 'hi',
      commandId: 'INT-C3',
    })));
    await flush();

    vi.advanceTimersByTime(ACK_TIMEOUT_MS + 100);
    await flush();

    const failed = browser.sentByType(MSG_COMMAND_FAILED);
    expect(failed.length).toBe(1);
    expect(failed[0].commandId).toBe('INT-C3');
    expect(failed[0].reason).toBe('ack_timeout');
  });

  // ── 4. Daemon "crash" (outbox reloaded from disk) → flush on reconnect ──
  it('outbox survives process restart: reloaded ack flushes on next connect, server dedups', async () => {
    const bridge = WsBridge.get(serverId);
    const daemonWs1 = await connectAndAuthDaemon(bridge, serverId);
    const browser = await connectBrowser(bridge, 'deck_storecheck_brain');

    // Pre-plant an inflight on the server by having browser send.
    browser.emit('message', Buffer.from(JSON.stringify({
      type: 'session.send',
      sessionName: 'deck_storecheck_brain',
      text: 'hi',
      commandId: 'INT-C4',
    })));
    await flush();

    // First daemon process writes outbox then crashes without sending ack.
    {
      const outbox1 = new AckOutbox(outboxPath);
      await outbox1.init(0);
      await outbox1.enqueue({
        commandId: 'INT-C4',
        sessionName: 'deck_storecheck_brain',
        status: 'accepted',
        ts: Date.now(),
      });
      await outbox1.close();
    }
    daemonWs1.close();
    await flush();

    // Second daemon process starts: reads outbox, reconnects, flushes.
    const daemonWs2 = await connectAndAuthDaemon(bridge, serverId);
    const outbox2 = new AckOutbox(outboxPath);
    await outbox2.init(0);
    expect(outbox2.size()).toBe(1);

    const sender = Object.assign(
      (msg: Record<string, unknown>) => { daemonWs2.emit('message', Buffer.from(JSON.stringify(msg))); },
      { isConnected: () => true },
    );
    await outbox2.flushOnReconnect(sender as never);
    await flush();

    // Browser receives the ack exactly once.
    const acks = browser.sentByType(MSG_COMMAND_ACK).filter((a) => a.commandId === 'INT-C4');
    expect(acks.length).toBe(1);
    expect(outbox2.size()).toBe(0);

    // A second replay (simulating a rogue double-flush) must be deduped by the server.
    const outbox3 = new AckOutbox(outboxPath);
    await outbox3.init(0);
    await outbox3.enqueue({
      commandId: 'INT-C4',
      sessionName: 'deck_storecheck_brain',
      status: 'accepted',
      ts: Date.now(),
    });
    await outbox3.flushOnReconnect(sender as never);
    await flush();
    const acksAfter = browser.sentByType(MSG_COMMAND_ACK).filter((a) => a.commandId === 'INT-C4');
    expect(acksAfter.length).toBe(1); // still 1 — server dedup held.
    await outbox3.close();
  });
});
