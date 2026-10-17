import { activeUserAnswer } from './helpers/user-status.js';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it } from 'vitest';
import { WsBridge, __setShareBridgeClockForTests } from '../src/ws/bridge.js';
import { sha256Hex } from '../src/security/crypto.js';
import {
  SHARE_REASONS,
  evaluateShareCommand,
  type EffectiveCoverage,
  type ShareTarget,
} from '../src/ws/share-policy.js';
import { SHARE_MESSAGE_LANE, shareBrowserMessageLane } from '../src/ws/share-lanes.js';
import { resetSharedCommandRateLimitsForTests } from '../src/share/share-rate-limit.js';
import { shareCancelDispatchDenial } from '../../shared/tab-sharing.js';
import { DAEMON_COMMAND_TYPES } from '../../shared/daemon-command-types.js';
import { SHARED_MACHINE_AUTHORITY_FIELD } from '../../shared/shared-machine-authority.js';
import { verifyJwt } from '../src/security/crypto.js';

class MockWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  closed = false;
  readyState = 1;
  closeReason: string | undefined;
  send(data: string | Buffer, _opts?: unknown, callback?: (err?: Error) => void) { this.sent.push(data); callback?.(); }
  close(_code?: number, reason?: string) { this.closed = true; this.readyState = 3; this.closeReason = reason; this.emit('close'); }
  get json(): Record<string, unknown>[] {
    return this.sent.filter((item): item is string => typeof item === 'string').flatMap((item) => { try { return [JSON.parse(item) as Record<string, unknown>]; } catch { return []; } });
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = () => new Promise((resolve) => setImmediate(resolve));

function coverage(target: ShareTarget, role: 'viewer' | 'participant', now: number): EffectiveCoverage {
  return { target, effectiveRole: role, historyCutoffAt: now - 1_000, nextCoverageRecheckAt: null, coveringShareIds: ['share-1'], primaryShareId: 'share-1', authorizedAt: now };
}

/** A DB that counts queries and answers the share-coverage ones, each after `delay(n)` ms. */
function makeCountingDb(delay: (callNo: number) => number, counts = { n: 0, audits: 0 }, hangAudit = false) {
  const wait = () => sleep(delay(counts.n));
  const db = {
    queryOne: async (sql: string) => {
      { const activeUser = activeUserAnswer(sql); if (activeUser) return activeUser as never; }
      if (sql.includes('SELECT token_hash')) return { token_hash: sha256Hex('t'), owner_status: 'active' };
      counts.n += 1; await wait();
      if (sql.includes('EXISTS')) return { exists: true };
      if (sql.includes('runtime_type')) return { runtime_type: 'transport' };
      if (sql.includes('FROM users')) return { id: 'u', display_name: 'U', username: 'u' };
      return null;
    },
    query: async (sql: string, params?: unknown[]) => {
      counts.n += 1; await wait();
      if (sql.includes('FROM session_shares')) {
        return [{ target_kind: 'main', id: 'sh1', server_id: String(params?.[2]), session_name: 'deck_proj_brain', sub_session_id: null, target_user_id: 'u', role: 'participant', created_by: 'o', created_at: 1, updated_at: 1, expires_at: null, revoked_at: null }];
      }
      return [];
    },
    execute: async (sql: string) => {
      if (sql.includes('INSERT INTO share_audit_events')) {
        counts.audits += 1;
        if (hangAudit) await new Promise(() => {});
      }
      return { changes: 1 };
    },
    exec: async () => {},
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
    close: () => {},
  };
  return db as never;
}

async function connect(serverId: string, db: never, opts: { userId?: string; role?: 'viewer' | 'participant'; realResolver?: boolean } = {}) {
  const bridge = WsBridge.get(serverId);
  const target: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
  const daemon = new MockWs();
  bridge.handleDaemonConnection(daemon as never, db, { JWT_SIGNING_KEY: 'share-hot-path-key' } as never);
  daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
  await flush();
  daemon.emit('message', JSON.stringify({ type: 'session_list', sessions: [{ name: 'deck_proj_brain', runtimeType: 'transport' }] }));
  await flush();
  daemon.sent.length = 0;
  const now = Date.now();
  const connectSocket = (userId: string) => {
    const ws = new MockWs();
    bridge.handleShareBrowserConnection(ws as never, userId, db, { ticketId: `t-${userId}`, target, snapshot: coverage(target, opts.role ?? 'participant', now) });
    return ws;
  };
  return { bridge, daemon, target, connectSocket, ws: connectSocket(opts.userId ?? 'u') };
}

const input = (data: string) => JSON.stringify({ type: DAEMON_COMMAND_TYPES.SESSION_INPUT, sessionName: 'deck_proj_brain', data });
const inputsAt = (daemon: MockWs) => daemon.json.filter((m) => m.type === DAEMON_COMMAND_TYPES.SESSION_INPUT).map((m) => String(m.data));

describe('share participant command hot path', () => {
  let serverId: string;
  beforeEach(() => {
    serverId = `share-hot-${Math.random().toString(36).slice(2)}`;
    __setShareBridgeClockForTests(() => Date.now());
    resetSharedCommandRateLimitsForTests();
  });

  it('keeps keystrokes in order even when each DB answer takes a different time', async () => {
    // Deterministic jitter (20..44 ms) that makes a later query overtake an earlier one.
    const { daemon, ws } = await connect(serverId, makeCountingDb((n) => 20 + ((n * 7) % 5) * 6));
    const letters = 'abcdefghijklmnopqrst'.split('');
    for (const ch of letters) { ws.emit('message', input(ch)); await sleep(1); }
    const deadline = Date.now() + 5_000;
    while (inputsAt(daemon).length < letters.length && Date.now() < deadline) await sleep(5);
    expect(inputsAt(daemon).join('')).toBe(letters.join(''));
  });

  it('reads the DB once for a burst of keystrokes, not four times per keystroke', async () => {
    const counts = { n: 0, audits: 0 };
    const { daemon, ws } = await connect(serverId, makeCountingDb(() => 1, counts));
    ws.emit('message', input('a'));
    while (inputsAt(daemon).length < 1) await sleep(2);
    const afterFirst = counts.n;
    for (let i = 0; i < 40; i += 1) ws.emit('message', input(String(i % 10)));
    const deadline = Date.now() + 3_000;
    while (inputsAt(daemon).length < 41 && Date.now() < deadline) await sleep(2);
    expect(inputsAt(daemon)).toHaveLength(41);
    expect(counts.n).toBe(afterFirst);
  });

  it('re-reads the grant after the TTL, and denies (not forwards) when the DB cannot answer', async () => {
    let now = Date.now();
    __setShareBridgeClockForTests(() => now);
    const counts = { n: 0, audits: 0 };
    const { bridge, daemon, ws } = await connect(serverId, makeCountingDb(() => 0, counts));
    ws.emit('message', input('a'));
    while (inputsAt(daemon).length < 1) await sleep(2);
    const warm = counts.n;
    now += 6_000;
    ws.emit('message', input('b'));
    while (inputsAt(daemon).length < 2) await sleep(2);
    expect(counts.n).toBeGreaterThan(warm);
    now += 6_000;
    bridge.setShareCoverageResolverForTests(async () => { throw new Error('db down'); });
    ws.emit('message', input('c'));
    await sleep(30);
    expect(inputsAt(daemon)).toEqual(['a', 'b']);
  });

  it('a revoke or downgrade takes effect on the very next command, not after the cache window', async () => {
    const { bridge, daemon, ws } = await connect(serverId, makeCountingDb(() => 0));
    ws.emit('message', input('a'));
    while (inputsAt(daemon).length < 1) await sleep(2);

    // Revoked: the push (not awaited) must already have invalidated the cached grant.
    bridge.setShareCoverageResolverForTests(async () => null);
    void bridge.revalidateShareSocketsForUser('u');
    ws.emit('message', input('b'));
    await sleep(30);
    expect(inputsAt(daemon)).toEqual(['a']);
    expect(ws.closed).toBe(true);
  });

  it('a downgrade to viewer stops input on the next command', async () => {
    const { bridge, daemon, target, ws } = await connect(serverId, makeCountingDb(() => 0));
    ws.emit('message', input('a'));
    while (inputsAt(daemon).length < 1) await sleep(2);
    bridge.setShareCoverageResolverForTests(async () => coverage(target, 'viewer', Date.now()));
    void bridge.revalidateShareSocketsForTarget(target);
    ws.emit('message', input('b'));
    await sleep(30);
    expect(inputsAt(daemon)).toEqual(['a']);
  });

  it("one user's revoke does not touch another user's socket, and cached grants are per socket", async () => {
    const { bridge, daemon, target, connectSocket, ws: a } = await connect(serverId, makeCountingDb(() => 0), { userId: 'user-a' });
    const b = connectSocket('user-b');
    bridge.setShareCoverageResolverForTests(async ({ userId }) => (userId === 'user-a' ? null : coverage(target, 'participant', Date.now())));
    void bridge.revalidateShareSocketsForUser('user-a');
    a.emit('message', input('A'));
    b.emit('message', input('B'));
    await sleep(40);
    expect(inputsAt(daemon)).toEqual(['B']);
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(false);
  });

  it("schedules per socket: input and other commands are ordered in separate lanes, and stop/approval/ping are never queued behind either", async () => {
    const bridge = WsBridge.get(serverId);
    const schedule = (bridge as unknown as {
      scheduleShareBrowserMessage: (ws: unknown, data: unknown, run: (d: unknown) => Promise<void>) => void;
    }).scheduleShareBrowserMessage.bind(bridge);
    const ws = new MockWs();
    const ran: string[] = [];
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => { release = resolve; });
    const msg = (type: string, tag: string) => JSON.stringify({ type, tag });
    // A slow input and a slow command, each with more behind it.
    schedule(ws, msg('session.input', 'in-1'), async () => { await slow; ran.push('in-1'); });
    schedule(ws, msg('session.input', 'in-2'), async () => { ran.push('in-2'); });
    schedule(ws, msg('session.send', 'cmd-1'), async () => { await slow; ran.push('cmd-1'); });
    schedule(ws, msg('session.send', 'cmd-2'), async () => { ran.push('cmd-2'); });
    schedule(ws, msg('session.cancel', 'stop'), async () => { ran.push('stop'); });
    schedule(ws, msg('chat.approval_response', 'approve'), async () => { ran.push('approve'); });
    schedule(ws, msg('ping', 'ping'), async () => { ran.push('ping'); });
    await flush();
    // Priority work ran while both lanes were stuck; nothing in a lane overtook its predecessor.
    expect(ran).toEqual(['stop', 'approve', 'ping']);
    release();
    await sleep(10);
    expect(ran.filter((tag) => tag.startsWith('in-'))).toEqual(['in-1', 'in-2']);
    expect(ran.filter((tag) => tag.startsWith('cmd-'))).toEqual(['cmd-1', 'cmd-2']);
  });

  it('a failing command does not stall the commands behind it on the same socket', async () => {
    const bridge = WsBridge.get(serverId);
    const schedule = (bridge as unknown as {
      scheduleShareBrowserMessage: (ws: unknown, data: unknown, run: (d: unknown) => Promise<void>) => void;
    }).scheduleShareBrowserMessage.bind(bridge);
    const ws = new MockWs();
    const ran: string[] = [];
    schedule(ws, JSON.stringify({ type: 'session.input', n: 1 }), async () => { throw new Error('boom'); });
    schedule(ws, JSON.stringify({ type: 'session.input', n: 2 }), async () => { ran.push('after'); });
    await sleep(10);
    expect(ran).toEqual(['after']);
  });

  it('does not hold a command back for its audit row, and drops audit rows past the bound instead of piling up', async () => {
    const counts = { n: 0, audits: 0 };
    const { bridge, daemon, ws } = await connect(serverId, makeCountingDb(() => 0, counts, true));
    bridge.setShareCoverageResolverForTests(async ({ target }) => coverage(target, 'participant', Date.now()));
    ws.emit('message', JSON.stringify({ type: DAEMON_COMMAND_TYPES.SESSION_CANCEL, commandId: 'stop-audit', sessionName: 'deck_proj_brain' }));
    await sleep(30);
    expect(daemon.json.some((m) => m.commandId === 'stop-audit')).toBe(true);
    // The audit write never finishes; further rows are bounded.
    const queue = (bridge as unknown as { queueShareCommandAudit: (s: unknown, m: unknown, d: unknown) => void }).queueShareCommandAudit.bind(bridge);
    const state = { userId: 'u', snapshot: { effectiveRole: 'participant', primaryShareId: 'share-1' }, target: { kind: 'main', serverId, sessionName: 'deck_proj_brain' } };
    for (let i = 0; i < 700; i += 1) queue(state, { type: DAEMON_COMMAND_TYPES.SESSION_CANCEL, commandId: `c${i}`, sessionName: 'deck_proj_brain' }, { allowed: true });
    await sleep(20);
    expect(counts.audits).toBeLessThanOrEqual(501);
  });

  it('classifies stop, approvals and pings as priority and keyboard input as its own lane', () => {
    expect(shareBrowserMessageLane(JSON.stringify({ type: 'session.cancel', sessionName: 's' }))).toBe(SHARE_MESSAGE_LANE.PRIORITY);
    expect(shareBrowserMessageLane(JSON.stringify({ type: 'chat.approval_response', id: 'x' }))).toBe(SHARE_MESSAGE_LANE.PRIORITY);
    expect(shareBrowserMessageLane(JSON.stringify({ type: 'ping' }))).toBe(SHARE_MESSAGE_LANE.PRIORITY);
    expect(shareBrowserMessageLane(Buffer.from(JSON.stringify({ type: 'session.input', data: 'a' })))).toBe(SHARE_MESSAGE_LANE.INPUT);
    expect(shareBrowserMessageLane(JSON.stringify({ type: 'session.resize', cols: 80 }))).toBe(SHARE_MESSAGE_LANE.INPUT);
    expect(shareBrowserMessageLane(JSON.stringify({ type: 'session.send', text: 'x' }))).toBe(SHARE_MESSAGE_LANE.COMMAND);
    expect(shareBrowserMessageLane(JSON.stringify({ text: 'x', type: 'session.cancel' }))).toBe(SHARE_MESSAGE_LANE.COMMAND);
  });
});

describe('participant terminal input carries the participant actor (process sessions)', () => {
  const target: ShareTarget = { kind: 'main', serverId: 'srv', sessionName: 'deck_proj_brain' };
  const state = (role: 'viewer' | 'participant') => ({
    userId: 'alice', actorDisplayName: 'Alice', ticketId: 't', target, snapshot: coverage(target, role, 1_000), connectedAt: 1_000,
  });
  const decide = (msg: Record<string, unknown>, role: 'viewer' | 'participant' = 'participant') => evaluateShareCommand({
    msg, state: state(role), now: 1_000, runtimeType: 'unknown', activeDispatchId: null,
  });

  it('stamps session.input with the server-built participant actor and drops client-supplied identity', () => {
    const decision = decide({
      type: DAEMON_COMMAND_TYPES.SESSION_INPUT, sessionName: 'deck_proj_brain', data: 'ls\r',
      sharedActor: { actorUserId: 'owner', effectiveActorRole: 'owner' },
      [SHARED_MACHINE_AUTHORITY_FIELD]: 'forged-token',
    });
    expect(decision.allowed).toBe(true);
    const stamped = (decision as { stampedMessage?: Record<string, unknown> }).stampedMessage!;
    expect(stamped.data).toBe('ls\r');
    expect(stamped.sharedActor).toMatchObject({ actorUserId: 'alice', effectiveActorRole: 'participant' });
    expect(stamped).not.toHaveProperty(SHARED_MACHINE_AUTHORITY_FIELD);
  });

  it('still denies a viewer and a session the share does not cover, and stamps nothing else that never feeds an agent', () => {
    expect(decide({ type: DAEMON_COMMAND_TYPES.SESSION_INPUT, sessionName: 'deck_proj_brain', data: 'x' }, 'viewer'))
      .toMatchObject({ allowed: false });
    expect(decide({ type: DAEMON_COMMAND_TYPES.SESSION_INPUT, sessionName: 'deck_other_brain', data: 'x' }))
      .toMatchObject({ allowed: false });
    expect(decide({ type: DAEMON_COMMAND_TYPES.SESSION_RESIZE, sessionName: 'deck_proj_brain', cols: 80, rows: 24 }))
      .toEqual({ allowed: true });
  });

  it('control keys (ESC, Ctrl-C) are ordinary stamped input: stop stays usable', () => {
    for (const data of ['\u001b', '\u0003']) {
      const decision = decide({ type: DAEMON_COMMAND_TYPES.SESSION_INPUT, sessionName: 'deck_proj_brain', data });
      expect(decision).toMatchObject({ allowed: true, stampedMessage: { data, sharedActor: { effectiveActorRole: 'participant' } } });
    }
  });
});

describe('participant keystrokes through the bridge', () => {
  let serverId: string;
  beforeEach(() => {
    serverId = `share-input-${Math.random().toString(36).slice(2)}`;
    __setShareBridgeClockForTests(() => Date.now());
    resetSharedCommandRateLimitsForTests();
  });

  /** The counting DB, plus the session binding lookup a machine-authority mint needs. */
  function dbWithBinding(counts: { n: number; audits: number }, bindings: { n: number; fail?: boolean }) {
    const db = makeCountingDb(() => 0, counts) as unknown as { queryOne: (sql: string, params?: unknown[]) => Promise<unknown> };
    const inner = db.queryOne.bind(db);
    db.queryOne = async (sql: string, params?: unknown[]) => {
      { const activeUser = activeUserAnswer(sql); if (activeUser) return activeUser as never; }
      if (sql.includes('SELECT project_name FROM sessions')) {
        bindings.n += 1;
        return bindings.fail ? null : { project_name: 'proj' };
      }
      return inner(sql, params);
    };
    return db as never;
  }

  const stampedInputs = (daemon: MockWs) => daemon.json.filter((m) => m.type === DAEMON_COMMAND_TYPES.SESSION_INPUT);

  it('stamps every keystroke, replaces a forged identity, and mints one token per window instead of per keystroke', async () => {
    const counts = { n: 0, audits: 0 };
    const bindings = { n: 0 };
    const { daemon, ws } = await connect(serverId, dbWithBinding(counts, bindings));
    ws.emit('message', JSON.stringify({
      type: DAEMON_COMMAND_TYPES.SESSION_INPUT, sessionName: 'deck_proj_brain', data: 'a',
      sharedActor: { actorUserId: 'owner', effectiveActorRole: 'owner' }, [SHARED_MACHINE_AUTHORITY_FIELD]: 'forged',
    }));
    while (stampedInputs(daemon).length < 1) await sleep(2);
    for (let i = 0; i < 30; i += 1) ws.emit('message', input(String(i % 10)));
    const deadline = Date.now() + 3_000;
    while (stampedInputs(daemon).length < 31 && Date.now() < deadline) await sleep(2);
    const sent = stampedInputs(daemon);
    expect(sent).toHaveLength(31);
    for (const message of sent) {
      expect(message.sharedActor).toMatchObject({ actorUserId: 'u', effectiveActorRole: 'participant' });
    }
    const tokens = new Set(sent.map((message) => String(message[SHARED_MACHINE_AUTHORITY_FIELD])));
    expect(tokens.size).toBe(1);
    const token = [...tokens][0]!;
    expect(token).not.toBe('forged');
    expect(verifyJwt(token, 'share-hot-path-key')).toMatchObject({ sub: 'u', sessionName: 'deck_proj_brain', projectName: 'proj' });
    expect(bindings.n).toBe(1);
  });

  it('refreshes the token after the reuse window, and never reads the DB per keystroke even when it cannot mint', async () => {
    let now = Date.now();
    __setShareBridgeClockForTests(() => now);
    const counts = { n: 0, audits: 0 };
    const bindings = { n: 0, fail: true };
    const { daemon, ws } = await connect(serverId, dbWithBinding(counts, bindings));
    for (let i = 0; i < 20; i += 1) { ws.emit('message', input('x')); await sleep(1); }
    const deadline = Date.now() + 3_000;
    while (stampedInputs(daemon).length < 20 && Date.now() < deadline) await sleep(2);
    const failed = stampedInputs(daemon);
    // No token could be minted: the keystrokes still go through (stop must keep working), stamped as the
    // participant and carrying no authority, so the daemon fails closed for machine tools.
    expect(failed).toHaveLength(20);
    expect(failed.every((message) => message.sharedActor && !(SHARED_MACHINE_AUTHORITY_FIELD in message))).toBe(true);
    expect(bindings.n).toBe(1);
    now += 31_000;
    bindings.fail = false;
    ws.emit('message', input('y'));
    while (stampedInputs(daemon).length < 21) await sleep(2);
    expect(bindings.n).toBe(2);
    expect(stampedInputs(daemon)[20]![SHARED_MACHINE_AUTHORITY_FIELD]).toEqual(expect.any(String));
  });
});

describe('participant stop guard', () => {
  const target: ShareTarget = { kind: 'main', serverId: 'srv', sessionName: 'deck_proj_brain' };
  const decide = (observed: string | undefined, active: string | null) => evaluateShareCommand({
    msg: { type: 'session.cancel', commandId: 'c', sessionName: 'deck_proj_brain', ...(observed !== undefined ? { observedDispatchId: observed } : {}) },
    state: { userId: 'u', actorDisplayName: 'U', ticketId: 't', target, snapshot: coverage(target, 'participant', 1_000), connectedAt: 1_000 },
    now: 1_000,
    runtimeType: 'transport',
    activeDispatchId: active,
  });

  it('refuses only when the server knows a different running turn, and then says so', () => {
    expect(decide('A', 'A')).toMatchObject({ allowed: true });
    expect(decide('A', 'B')).toEqual({ allowed: false, reason: SHARE_REASONS.DISPATCH_CHANGED });
    expect(decide(undefined, 'B')).toEqual({ allowed: false, reason: SHARE_REASONS.DISPATCH_CHANGED });
    expect(shareCancelDispatchDenial('A', 'B')).toBe('share-dispatch-changed');
  });

  it('lets a stop through when the server knows no running turn (queue drain, pair/agent send, cron start turns outside the bridge)', () => {
    expect(decide(undefined, null)).toMatchObject({ allowed: true });
    expect(decide('A', null)).toMatchObject({ allowed: true });
  });
});

describe('participant stop rate limit is per user and session', () => {
  it("one participant exhausting their stops does not limit another on the same session", async () => {
    const serverId = `share-rl-${Math.random().toString(36).slice(2)}`;
    resetSharedCommandRateLimitsForTests();
    __setShareBridgeClockForTests(() => Date.now());
    const { bridge, daemon, target, connectSocket, ws: a } = await connect(serverId, makeCountingDb(() => 0), { userId: 'user-a' });
    bridge.setShareCoverageResolverForTests(async () => coverage(target, 'participant', Date.now()));
    const b = connectSocket('user-b');
    for (let i = 0; i < 12; i += 1) a.emit('message', JSON.stringify({ type: 'session.cancel', commandId: `a-${i}`, sessionName: 'deck_proj_brain' }));
    b.emit('message', JSON.stringify({ type: 'session.cancel', commandId: 'b-0', sessionName: 'deck_proj_brain' }));
    await sleep(60);
    const forwarded = daemon.json.filter((m) => m.type === 'session.cancel').map((m) => m.commandId);
    expect(forwarded.filter((id) => String(id).startsWith('a-'))).toHaveLength(10);
    expect(forwarded).toContain('b-0');
    expect(a.json.filter((m) => m.type === 'command.failed' && m.reason === SHARE_REASONS.RATE_LIMITED)).toHaveLength(2);
  });
});
