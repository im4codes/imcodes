/**
 * A daemon link-restore resync must never raise push notifications.
 *
 * Observed on the 43 deployment: a gateway blip dropped four daemons' sockets;
 * all four re-authenticated within two seconds, and 276ms later ~90 push
 * dispatches went out inside a 500ms window — one "Task complete — ready for
 * input" per idle session, several quoting work that had finished long before.
 *
 * `resyncTransportSessionStatesAfterLinkRestore()` re-states every session's
 * CURRENT state so browsers stop rendering a stale "working" spinner. Those
 * events are re-announcements, not completions. The existing
 * `PUSH_TIMELINE_EVENT_MAX_AGE_MS` guard cannot filter them, because a resync
 * event is newly minted (ts = now) even though the state it describes is old.
 *
 * The daemon now stamps `suppressPush`, but this server-side check is what makes
 * a server deploy sufficient: daemons are user-installed and upgrade on their own
 * schedule, so recognising the resync marker here stops the storm for every
 * daemon version already in the field.
 *
 * @vitest-environment node
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsBridge } from '../src/ws/bridge.js';
import { TIMELINE_MESSAGES } from '../../shared/timeline-protocol.js';
import { TIMELINE_SUPPRESS_PUSH_FIELD } from '../../shared/push-notifications.js';
import { SESSION_STATE_DECISION_REASON_SERVER_LINK_RESYNC } from '../../shared/session-activity-types.js';

vi.mock('../src/security/crypto.js', () => ({ sha256Hex: (_s: string) => 'valid-hash' }));
vi.mock('../src/routes/push.js', () => ({ dispatchPush: vi.fn() }));

class MockWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  readyState = 1;
  send(data: string | Buffer, _opts?: unknown, cb?: (err?: Error) => void): void {
    this.sent.push(data);
    cb?.();
  }
  close(): void { this.readyState = 3; this.emit('close'); }
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

const SESSION = 'deck_resyncpush_brain';

function idleStateEvent(payload: Record<string, unknown>): string {
  return JSON.stringify({
    type: TIMELINE_MESSAGES.EVENT,
    event: {
      eventId: `evt-${Math.random().toString(36).slice(2)}`,
      sessionId: SESSION,
      ts: Date.now(),
      seq: 1,
      epoch: 1,
      type: 'session.state',
      payload: { state: 'idle', ...payload },
    },
  });
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}

/**
 * Whether a push is queued for this session. Read synchronously right after the
 * daemon message: with the test settle window at 0ms the flush is a microtask,
 * so waiting first would drain the map and hide the difference.
 */
function pendingIdlePushCount(bridge: WsBridge): number {
  const pending = (bridge as unknown as { pendingIdlePushes: Map<string, unknown> }).pendingIdlePushes;
  return pending.size;
}

describe('WsBridge — link-restore resync must not push', () => {
  let serverId: string;

  beforeEach(() => { serverId = `resync-${Math.random().toString(36).slice(2)}`; });
  afterEach(() => { WsBridge.getAll().clear(); vi.clearAllMocks(); });

  async function authedDaemon() {
    const bridge = WsBridge.get(serverId);
    const daemon = new MockWs();
    // env must be truthy for the push branch to be reachable at all.
    bridge.handleDaemonConnection(daemon as never, makeDb() as never, {} as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'tok' }));
    await flush();
    expect(bridge.isAuthenticated).toBe(true);
    return { bridge, daemon };
  }

  it('schedules no push for a resync idle even without the daemon-side suppressPush flag', async () => {
    // The already-deployed-daemon case: only `decisionReason` identifies it.
    const { bridge, daemon } = await authedDaemon();

    daemon.emit('message', idleStateEvent({
      decisionReason: SESSION_STATE_DECISION_REASON_SERVER_LINK_RESYNC,
    }));

    expect(pendingIdlePushCount(bridge)).toBe(0);
  });

  it('schedules no push when the daemon marks the resync with suppressPush', async () => {
    const { bridge, daemon } = await authedDaemon();

    daemon.emit('message', idleStateEvent({
      decisionReason: SESSION_STATE_DECISION_REASON_SERVER_LINK_RESYNC,
      [TIMELINE_SUPPRESS_PUSH_FIELD]: true,
    }));

    expect(pendingIdlePushCount(bridge)).toBe(0);
  });

  it('STILL pushes for a genuine live idle — the guard must not silence real completions', async () => {
    // Without this the fix could "work" by breaking notifications entirely.
    const { bridge, daemon } = await authedDaemon();

    daemon.emit('message', idleStateEvent({ decisionReason: 'activity_reconciler_clear' }));

    expect(pendingIdlePushCount(bridge)).toBe(1);
  });

  it('does not fan one push per session when many sessions resync at once', async () => {
    // The storm's actual shape: every session re-stated in one burst.
    const { bridge, daemon } = await authedDaemon();

    for (let i = 0; i < 25; i++) {
      daemon.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.EVENT,
        event: {
          eventId: `evt-${i}`,
          sessionId: `deck_resyncpush_w${i}`,
          ts: Date.now(),
          seq: i,
          epoch: 1,
          type: 'session.state',
          payload: { state: 'idle', decisionReason: SESSION_STATE_DECISION_REASON_SERVER_LINK_RESYNC },
        },
      }));
    }

    expect(pendingIdlePushCount(bridge)).toBe(0);
  });
});
