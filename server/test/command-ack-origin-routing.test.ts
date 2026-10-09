/**
 * command.ack must reach the browser socket that sent the originating
 * command, even when that socket is not subscribed to the session (owner
 * report, 199: identity save/apply from a settings page not subscribed to
 * that session timed out at 20s, though the daemon acked in 2-4s).
 *
 * This covers the generic commandId-tracking path (CommandAckOriginRouter),
 * exercised end-to-end here via session.identity.refresh -- the command that
 * exposed the bug -- while confirming the pre-existing subscriber fan-out
 * (sendJsonToSessionSubscribers) is unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { WsBridge } from '../src/ws/bridge.js';
import { MSG_COMMAND_ACK } from '../../shared/ack-protocol.js';
import { DAEMON_COMMAND_TYPES } from '../../shared/daemon-command-types.js';

class MockWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  closed = false;
  readyState = 1;

  send(data: string | Buffer, _opts?: unknown, callback?: (err?: Error) => void) {
    if (this.closed) { const err = new Error('socket closed'); if (callback) { callback(err); return; } throw err; }
    this.sent.push(data);
    callback?.();
  }

  close() { this.closed = true; this.readyState = 3; this.emit('close'); }

  get sentStrings(): string[] { return this.sent.filter((s): s is string => typeof s === 'string'); }

  sentByType(type: string): Array<Record<string, unknown>> {
    return this.sentStrings
      .map((s) => { try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; } })
      .filter((m): m is Record<string, unknown> => !!m && m.type === type);
  }
}

function makeDb() {
  return {
    queryOne: async () => ({ token_hash: 'valid-hash', owner_status: 'active', node_role: 'full', revoked_at: null, os: null }),
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    close: () => {},
  } as unknown as import('../src/db/client.js').Database;
}

vi.mock('../src/security/crypto.js', () => ({ sha256Hex: (_s: string) => 'valid-hash' }));

async function flushAsync() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => process.nextTick(resolve));
}

async function setup(serverId: string) {
  const bridge = WsBridge.get(serverId);
  const daemonWs = new MockWs();
  bridge.handleDaemonConnection(daemonWs as never, makeDb(), {} as never);
  daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
  await flushAsync();
  return { bridge, daemonWs };
}

function browser(bridge: WsBridge): MockWs {
  const ws = new MockWs();
  bridge.handleBrowserConnection(ws as never, 'test-user', makeDb());
  return ws;
}

describe('command.ack reaches the command\'s originating socket', () => {
  let serverId: string;

  beforeEach(() => { serverId = `ack-origin-${Math.random().toString(36).slice(2)}`; });
  afterEach(() => { WsBridge.getAll().clear(); vi.clearAllMocks(); });

  it('an unsubscribed sender still gets its own ack; a subscribed tab keeps getting it too', async () => {
    const { bridge, daemonWs } = await setup(serverId);
    const subscribed = browser(bridge);
    const unsubscribed = browser(bridge);

    subscribed.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'deck_proj_brain' }));
    await flushAsync();
    subscribed.sent.length = 0;

    // Sent from the UNSUBSCRIBED tab (e.g. a settings dialog not open on this session).
    unsubscribed.emit('message', JSON.stringify({
      type: DAEMON_COMMAND_TYPES.SESSION_IDENTITY_REFRESH,
      sessionName: 'deck_proj_brain',
      commandId: 'identity-refresh-1',
    }));
    await flushAsync();

    daemonWs.emit('message', JSON.stringify({
      type: MSG_COMMAND_ACK,
      session: 'deck_proj_brain',
      commandId: 'identity-refresh-1',
      status: 'ok',
    }));
    await flushAsync();

    expect(unsubscribed.sentByType(MSG_COMMAND_ACK)).toHaveLength(1);
    expect(unsubscribed.sentByType(MSG_COMMAND_ACK)[0]).toMatchObject({ commandId: 'identity-refresh-1', status: 'ok' });
    // Unchanged existing behaviour: the subscribed tab still gets it too.
    expect(subscribed.sentByType(MSG_COMMAND_ACK)).toHaveLength(1);
  });

  it('never double-delivers when the sender is also a subscriber', async () => {
    const { bridge, daemonWs } = await setup(serverId);
    const sender = browser(bridge);
    sender.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'deck_proj_brain' }));
    await flushAsync();
    sender.sent.length = 0;

    sender.emit('message', JSON.stringify({
      type: DAEMON_COMMAND_TYPES.SESSION_IDENTITY_REFRESH,
      sessionName: 'deck_proj_brain',
      commandId: 'identity-refresh-2',
    }));
    await flushAsync();
    daemonWs.emit('message', JSON.stringify({
      type: MSG_COMMAND_ACK, session: 'deck_proj_brain', commandId: 'identity-refresh-2', status: 'ok',
    }));
    await flushAsync();

    expect(sender.sentByType(MSG_COMMAND_ACK)).toHaveLength(1);
  });

  it('a replayed ack (outbox flush after reconnect) does not re-deliver to the origin a second time', async () => {
    const { bridge, daemonWs } = await setup(serverId);
    const sender = browser(bridge);

    sender.emit('message', JSON.stringify({
      type: DAEMON_COMMAND_TYPES.SESSION_IDENTITY_REFRESH,
      sessionName: 'deck_proj_brain',
      commandId: 'identity-refresh-3',
    }));
    await flushAsync();

    const ack = JSON.stringify({
      type: MSG_COMMAND_ACK, session: 'deck_proj_brain', commandId: 'identity-refresh-3', status: 'ok',
    });
    daemonWs.emit('message', ack);
    await flushAsync();
    expect(sender.sentByType(MSG_COMMAND_ACK)).toHaveLength(1);

    // The daemon replays its outbox verbatim on reconnect/redelivery; the
    // origin route was already consumed (one-shot), so this must not re-fire.
    daemonWs.emit('message', ack);
    await flushAsync();
    expect(sender.sentByType(MSG_COMMAND_ACK)).toHaveLength(1);
  });

  it('an origin route is dropped when its socket disconnects before the ack arrives', async () => {
    const { bridge, daemonWs } = await setup(serverId);
    const sender = browser(bridge);

    sender.emit('message', JSON.stringify({
      type: DAEMON_COMMAND_TYPES.SESSION_IDENTITY_REFRESH,
      sessionName: 'deck_proj_brain',
      commandId: 'identity-refresh-4',
    }));
    await flushAsync();
    sender.close();
    await flushAsync();

    // Must not throw when the origin socket is already gone.
    daemonWs.emit('message', JSON.stringify({
      type: MSG_COMMAND_ACK, session: 'deck_proj_brain', commandId: 'identity-refresh-4', status: 'ok',
    }));
    await flushAsync();
    expect(sender.sentByType(MSG_COMMAND_ACK)).toHaveLength(0);
  });
});
