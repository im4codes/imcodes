import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it } from 'vitest';
import { WsBridge, __setShareBridgeClockForTests } from '../src/ws/bridge.js';
import { sha256Hex } from '../src/security/crypto.js';
import { SHARE_REASONS, type EffectiveCoverage, type ShareTarget } from '../src/ws/share-policy.js';
import { resetSharedCommandRateLimitsForTests } from '../src/share/share-rate-limit.js';
import { DAEMON_COMMAND_TYPES } from '../../shared/daemon-command-types.js';
import { MSG_COMMAND_ACK, MSG_COMMAND_FAILED } from '../../shared/ack-protocol.js';
import { TRANSPORT_MSG } from '../../shared/transport-events.js';

const SESSION = 'deck_proj_brain';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class MockWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  readyState = 1;
  send(data: string | Buffer, _opts?: unknown, cb?: (e?: Error) => void) { this.sent.push(data); cb?.(); }
  close() { this.readyState = 3; this.emit('close'); }
  get json(): Record<string, unknown>[] {
    return this.sent.filter((d): d is string => typeof d === 'string').flatMap((d) => { try { return [JSON.parse(d) as Record<string, unknown>]; } catch { return []; } });
  }
}

/** Counting DB with a fixed per-query latency: every share check pays it. */
function makeDb(latencyMs: number) {
  const wait = () => sleep(latencyMs);
  const db = {
    queryOne: async (sql: string) => {
      if (sql.includes('SELECT token_hash')) return { token_hash: sha256Hex('t') };
      await wait();
      if (sql.includes('EXISTS')) return { exists: true };
      if (sql.includes('runtime_type')) return { runtime_type: 'transport' };
      if (sql.includes('FROM users')) return { id: 'u', display_name: 'U', username: 'u' };
      if (sql.includes('FROM sessions')) return { project_name: 'proj', name: SESSION, runtime_type: 'transport' };
      return null;
    },
    query: async (sql: string, params?: unknown[]) => {
      await wait();
      if (sql.includes('FROM session_shares')) {
        return [{ target_kind: 'main', id: 'sh1', server_id: String(params?.[2]), session_name: SESSION, sub_session_id: null, target_user_id: 'u', role: 'participant', created_by: 'o', created_at: 1, updated_at: 1, expires_at: null, revoked_at: null }];
      }
      return [];
    },
    execute: async () => { await wait(); return { changes: 1 }; },
    exec: async () => {}, transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db), close: () => {},
  };
  return db as never;
}

const coverage = (target: ShareTarget, now: number): EffectiveCoverage => ({
  target, effectiveRole: 'participant', historyCutoffAt: now - 1_000, nextCoverageRecheckAt: null,
  coveringShareIds: ['sh1'], primaryShareId: 'sh1', authorizedAt: now,
});

/**
 * The daemon as the participant's Stop meets it: it receives `session.cancel`,
 * accepts it at once (command.ack accepted) and reports the session idle -- what
 * cancelTransportTurnNow does before the provider's own interrupt settles.
 */
function attachProvider(bridge: WsBridge, daemon: MockWs) {
  const received = new Map<string, number>();
  const send = daemon.send.bind(daemon);
  daemon.send = (data, opts, cb) => {
    send(data, opts, cb);
    if (typeof data !== 'string') return;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(data) as Record<string, unknown>; } catch { return; }
    if (msg.type === DAEMON_COMMAND_TYPES.SESSION_CANCEL && typeof msg.commandId === 'string') {
      received.set(msg.commandId, performance.now());
      setTimeout(() => {
        daemon.emit('message', JSON.stringify({ type: MSG_COMMAND_ACK, commandId: msg.commandId, session: SESSION, status: 'accepted' }));
        daemon.emit('message', JSON.stringify({ type: 'session.idle', session: SESSION }));
      }, 1);
    }
    if (msg.type === 'session.send' && typeof msg.commandId === 'string') {
      setTimeout(() => daemon.emit('message', JSON.stringify({ type: MSG_COMMAND_ACK, commandId: msg.commandId, session: SESSION, status: 'accepted' })), 1);
    }
  };
  void bridge;
  return received;
}

async function scenario(serverId: string, participants: number) {
  const db = makeDb(5);
  const bridge = WsBridge.get(serverId);
  const target: ShareTarget = { kind: 'main', serverId, sessionName: SESSION };
  const daemon = new MockWs();
  bridge.handleDaemonConnection(daemon as never, db, { JWT_SIGNING_KEY: 'share-stop-e2e-key' } as never);
  daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
  await sleep(10);
  daemon.emit('message', JSON.stringify({ type: 'session_list', sessions: [{ name: SESSION, runtimeType: 'transport' }] }));
  await sleep(5);
  const providerSaw = attachProvider(bridge, daemon);
  const owner = new MockWs();
  bridge.handleBrowserConnection(owner as never, 'owner', db);
  owner.emit('message', JSON.stringify({ type: TRANSPORT_MSG.CHAT_SUBSCRIBE, sessionId: SESSION }));
  const now = Date.now();
  const people = Array.from({ length: participants }, (_, i) => {
    const ws = new MockWs();
    bridge.handleShareBrowserConnection(ws as never, `participant-${i}`, db, { ticketId: `t-${i}`, target, snapshot: coverage(target, now) });
    ws.emit('message', JSON.stringify({ type: TRANSPORT_MSG.CHAT_SUBSCRIBE, sessionId: SESSION }));
    return ws;
  });
  // Subscriptions are confirmed asynchronously (session ownership check); real participants have long been subscribed.
  await sleep(300);
  daemon.sent.length = 0;
  const lastAckDispatch = (ws: MockWs): string | undefined => {
    const acks = ws.json.filter((m) => m.type === MSG_COMMAND_ACK && 'activeDispatchId' in m);
    const id = acks.at(-1)?.activeDispatchId;
    return typeof id === 'string' ? id : undefined;
  };
  return { bridge, daemon, owner, people, providerSaw, lastAckDispatch };
}

/** Taps Stop on every participant at once; resolves with when each participant got a confirmation. */
async function tapStopAll(ctx: Awaited<ReturnType<typeof scenario>>, observed: (i: number) => string | undefined, tag: string) {
  const start = performance.now();
  ctx.people.forEach((ws, i) => {
    const obs = observed(i);
    ws.emit('message', JSON.stringify({
      type: DAEMON_COMMAND_TYPES.SESSION_CANCEL, commandId: `${tag}-${i}`, sessionName: SESSION,
      ...(obs ? { observedDispatchId: obs } : {}),
    }));
  });
  const deadline = Date.now() + 1_500;
  const done = (i: number) => ctx.people[i]!.json.some((m) => m.commandId === `${tag}-${i}` && (m.type === MSG_COMMAND_ACK || m.type === MSG_COMMAND_FAILED));
  while (!ctx.people.every((_, i) => done(i)) && Date.now() < deadline) await sleep(2);
  const elapsedMs = performance.now() - start;
  if (process.env.SHARE_STOP_E2E_LOG) console.info(`STOP-LATENCY ${tag} participants=${ctx.people.length} all-confirmed-in=${elapsedMs.toFixed(0)}ms (DB 5ms/query)`);
  return { elapsedMs };
}

describe('participant Stop, end to end (browser socket -> bridge -> daemon -> confirmation)', () => {
  let serverId: string;
  beforeEach(() => {
    serverId = `share-stop-${Math.random().toString(36).slice(2)}`;
    __setShareBridgeClockForTests(() => Date.now());
    resetSharedCommandRateLimitsForTests();
  });

  for (const n of [1, 10, 50]) {
    it(`N=${n}: a turn the owner started -- every participant's Stop reaches the daemon and is confirmed`, async () => {
      const ctx = await scenario(serverId, n);
      ctx.owner.emit('message', JSON.stringify({ type: 'session.send', commandId: 'owner-turn', sessionName: SESSION, text: 'go' }));
      await sleep(40);
      // Every participant learned the running turn from the broadcast ack, as the web does.
      const observed = ctx.people.map((ws) => ctx.lastAckDispatch(ws));
      expect(observed.every((id) => id === 'owner-turn')).toBe(true);
      const { elapsedMs } = await tapStopAll(ctx, (i) => observed[i], 'owner-turn-stop');
      expect(ctx.people.every((ws, i) => ws.json.some((m) => m.type === MSG_COMMAND_ACK && m.commandId === `owner-turn-stop-${i}` && m.status === 'accepted'))).toBe(true);
      expect(ctx.people.some((ws) => ws.json.some((m) => m.type === MSG_COMMAND_FAILED))).toBe(false);
      expect(ctx.providerSaw.size).toBe(n);
      expect(elapsedMs).toBeLessThan(1_000);
    });

    it(`N=${n}: a turn started outside the bridge (queue drain, pair/agent send, cron) -- Stop is not refused for want of a turn id`, async () => {
      const ctx = await scenario(serverId, n);
      // No session.send went through the bridge: the server knows no running turn and neither do the participants.
      const { elapsedMs } = await tapStopAll(ctx, () => undefined, 'drain-stop');
      expect(ctx.people.every((ws, i) => ws.json.some((m) => m.type === MSG_COMMAND_ACK && m.commandId === `drain-stop-${i}` && m.status === 'accepted'))).toBe(true);
      expect(ctx.people.some((ws) => ws.json.some((m) => m.type === MSG_COMMAND_FAILED))).toBe(false);
      expect(ctx.providerSaw.size).toBe(n);
      expect(elapsedMs).toBeLessThan(1_000);
    });

    it(`N=${n}: a participant looking at an old turn is told the turn changed (with the current one), and the next tap goes through`, async () => {
      const ctx = await scenario(serverId, n);
      ctx.owner.emit('message', JSON.stringify({ type: 'session.send', commandId: 'turn-2', sessionName: SESSION, text: 'next' }));
      await sleep(40);
      const stale = await tapStopAll(ctx, () => 'turn-1', 'stale');
      for (let i = 0; i < n; i += 1) {
        const failed = ctx.people[i]!.json.find((m) => m.type === MSG_COMMAND_FAILED && m.commandId === `stale-${i}`);
        expect(failed, `participant ${i} must be told`).toMatchObject({ reason: SHARE_REASONS.DISPATCH_CHANGED, activeDispatchId: 'turn-2' });
      }
      expect(ctx.providerSaw.size).toBe(0);
      expect(stale.elapsedMs).toBeLessThan(1_000);
      const retry = await tapStopAll(ctx, () => 'turn-2', 'retry');
      expect(ctx.people.every((ws, i) => ws.json.some((m) => m.type === MSG_COMMAND_ACK && m.commandId === `retry-${i}` && m.status === 'accepted'))).toBe(true);
      expect(ctx.providerSaw.size).toBe(n);
      expect(retry.elapsedMs).toBeLessThan(1_000);
    });
  }

  it('a Stop the grant no longer allows is answered, never swallowed (revoked grant, daemon offline)', async () => {
    const ctx = await scenario(serverId, 2);
    // Revoked: answered with a reason and the socket is torn down.
    ctx.bridge.setShareCoverageResolverForTests(async () => null);
    void ctx.bridge.revalidateShareSocketsForUser('participant-0');
    ctx.people[0]!.emit('message', JSON.stringify({ type: DAEMON_COMMAND_TYPES.SESSION_CANCEL, commandId: 'revoked-stop', sessionName: SESSION }));
    await sleep(40);
    const answers = ctx.people[0]!.json.filter((m) => m.commandId === 'revoked-stop' || m.type === 'share.teardown');
    expect(answers.length).toBeGreaterThan(0);
    // Grant read fails (DB down): the tap is answered too.
    ctx.bridge.setShareCoverageResolverForTests(async () => { throw new Error('db down'); });
    void ctx.bridge.revalidateShareSocketsForUser('participant-1');
    ctx.people[1]!.emit('message', JSON.stringify({ type: DAEMON_COMMAND_TYPES.SESSION_CANCEL, commandId: 'db-down-stop', sessionName: SESSION }));
    await sleep(40);
    expect(ctx.people[1]!.json.some((m) => m.commandId === 'db-down-stop' && (m.type === MSG_COMMAND_FAILED || m.type === MSG_COMMAND_ACK))).toBe(true);
  });
});
