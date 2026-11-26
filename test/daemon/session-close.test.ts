import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessions = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const warn = vi.hoisted(() => vi.fn());
const info = vi.hoisted(() => vi.fn());

vi.mock('../../src/store/session-store.js', () => ({
  getSession: (name: string) => sessions.get(name),
  listSessions: () => [...sessions.values()],
}));
vi.mock('../../src/util/logger.js', () => ({
  default: { debug: vi.fn(), warn, info, error: vi.fn() },
}));

import {
  closeSessionOnBehalf,
  closeSubSession,
  evaluateSessionClose,
  isSessionClosing,
  type SessionActivity,
} from '../../src/daemon/session-close.js';
import {
  flushPendingSubSessionClosedNotices,
  pendingSubSessionClosedNoticeCount,
  resetActiveServerLinkForTests,
  type ActiveServerLink,
} from '../../src/daemon/active-server-link.js';
import { SESSION_CLOSE_REFUSAL, SESSION_CLOSE_STATUS } from '../../shared/session-close.js';
import type { SessionRecord } from '../../src/store/session-store.js';

const IDLE: SessionActivity = { openPairs: [], turnRunning: false, queuedMessages: 0 };

function rec(name: string, overrides: Record<string, unknown> = {}): SessionRecord {
  const record = {
    name, projectName: 'proj', role: 'w1', agentType: 'claude-code-sdk', projectDir: '/tmp/proj',
    state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
    ...overrides,
  } as unknown as SessionRecord;
  sessions.set(name, record as unknown as Record<string, unknown>);
  return record;
}

const brain = () => rec('deck_proj_brain', { role: 'brain' });
/** A sub-session created by `createdBy` for a pair (the marker `pairCreatedMetadata`, injected: the creating tasks are separate). */
const marked = (name: string, createdBy = 'deck_proj_brain', extra: Record<string, unknown> = {}) => rec(name, {
  parentSession: 'deck_proj_brain',
  pairCreatedMetadata: { autoCreated: true, source: 'pair_create', createdBy, pairTaskId: 'tsk_1', role: 'executor', createdAt: 1 },
  ...extra,
});
const userOwn = (name: string) => rec(name, { parentSession: 'deck_proj_brain', userCreated: true });

function decide(callerName: string, targetName: string, request: Record<string, unknown> = {}, activity: SessionActivity = IDLE) {
  return evaluateSessionClose({
    caller: sessions.get(callerName) as unknown as SessionRecord,
    target: sessions.get(targetName) as unknown as SessionRecord,
    request: { target: targetName, ...request },
    activity,
    sessions: [...sessions.values()] as unknown as SessionRecord[],
  });
}

beforeEach(() => {
  sessions.clear();
  warn.mockClear();
  info.mockClear();
  resetActiveServerLinkForTests();
});

describe('who may close what', () => {
  it('lets a session close the sub-session it created', () => {
    brain();
    rec('deck_sub_exec', { parentSession: 'deck_proj_brain' });
    marked('deck_sub_a', 'deck_sub_exec');
    expect(decide('deck_sub_exec', 'deck_sub_a')).toMatchObject({ ok: true, authority: 'creator', forced: false });
  });

  it('lets the project Brain close an automatically created sub-session, and a user\'s own only when confirmed', () => {
    brain();
    marked('deck_sub_a', 'deck_sub_other');
    userOwn('deck_sub_mine');
    expect(decide('deck_proj_brain', 'deck_sub_a')).toMatchObject({ ok: true, authority: 'brain' });
    expect(decide('deck_proj_brain', 'deck_sub_mine')).toMatchObject({ ok: false, reason: SESSION_CLOSE_REFUSAL.USER_CREATED_NEEDS_CONFIRMATION });
    expect(decide('deck_proj_brain', 'deck_sub_mine', { confirmUserCreated: true })).toMatchObject({ ok: true, authority: 'brain' });
  });

  it('refuses everyone else: a sibling that did not create it, and a session of another project', () => {
    brain();
    rec('deck_sub_peer', { parentSession: 'deck_proj_brain' });
    marked('deck_sub_a');
    expect(decide('deck_sub_peer', 'deck_sub_a')).toMatchObject({ ok: false, reason: SESSION_CLOSE_REFUSAL.NOT_AUTHORIZED });

    rec('deck_other_brain', { role: 'brain', projectName: 'other' });
    expect(decide('deck_other_brain', 'deck_sub_a')).toMatchObject({ ok: false, reason: SESSION_CLOSE_REFUSAL.NOT_AUTHORIZED });
    // A sub-session's project is its parent's, so a creator marker from another project does not travel either.
    rec('deck_sub_foreign', { parentSession: 'deck_other_brain', projectName: 'other' });
    expect(decide('deck_sub_foreign', 'deck_sub_a')).toMatchObject({ ok: false, reason: SESSION_CLOSE_REFUSAL.NOT_AUTHORIZED });
  });

  it('never closes a Brain or a main session, however authorized the caller looks', () => {
    brain();
    rec('deck_proj_w1', { role: 'w1' });
    rec('deck_sub_x', { parentSession: 'deck_proj_brain', role: 'brain' });
    rec('deck_sub_exec', { parentSession: 'deck_proj_brain' });
    expect(decide('deck_sub_exec', 'deck_proj_brain')).toMatchObject({ ok: false, reason: SESSION_CLOSE_REFUSAL.NOT_A_SUB_SESSION });
    expect(decide('deck_proj_brain', 'deck_proj_w1', { force: true, confirmUserCreated: true })).toMatchObject({ ok: false, reason: SESSION_CLOSE_REFUSAL.NOT_A_SUB_SESSION });
    expect(decide('deck_proj_brain', 'deck_sub_x', { force: true })).toMatchObject({ ok: false, reason: SESSION_CLOSE_REFUSAL.NOT_A_SUB_SESSION });
  });

  it('points an execution clone at destroy_execution_clone and refuses to close itself', () => {
    brain();
    rec('deck_sub_clone', { parentSession: 'deck_proj_brain', executionCloneMetadata: { kind: 'execution_clone' } });
    expect(decide('deck_proj_brain', 'deck_sub_clone')).toMatchObject({ ok: false, reason: SESSION_CLOSE_REFUSAL.EXECUTION_CLONE });
    marked('deck_sub_self');
    expect(decide('deck_sub_self', 'deck_sub_self')).toMatchObject({ ok: false, reason: SESSION_CLOSE_REFUSAL.SELF });
  });
});

describe('work in flight', () => {
  it('refuses while a pair is open, a turn runs or messages are queued, and says which', () => {
    brain();
    marked('deck_sub_a');
    expect(decide('deck_proj_brain', 'deck_sub_a', {}, { ...IDLE, openPairs: ['tsk_9'] }))
      .toMatchObject({ ok: false, reason: SESSION_CLOSE_REFUSAL.OPEN_PAIR, detail: expect.stringContaining('tsk_9') });
    expect(decide('deck_proj_brain', 'deck_sub_a', {}, { ...IDLE, turnRunning: true }))
      .toMatchObject({ ok: false, reason: SESSION_CLOSE_REFUSAL.TURN_RUNNING });
    expect(decide('deck_proj_brain', 'deck_sub_a', {}, { ...IDLE, queuedMessages: 3 }))
      .toMatchObject({ ok: false, reason: SESSION_CLOSE_REFUSAL.QUEUED_MESSAGES, detail: expect.stringContaining('3') });
    const all = decide('deck_proj_brain', 'deck_sub_a', {}, { openPairs: ['tsk_9'], turnRunning: true, queuedMessages: 2 });
    expect(all).toMatchObject({ ok: false, reason: SESSION_CLOSE_REFUSAL.OPEN_PAIR });
    expect((all as { detail: string }).detail).toMatch(/tsk_9.*turn.*2 message/su);
  });

  it('lets only the Brain force, and reports exactly what a forced close discards', () => {
    brain();
    rec('deck_sub_exec', { parentSession: 'deck_proj_brain' });
    marked('deck_sub_a', 'deck_sub_other');
    marked('deck_sub_b', 'deck_sub_exec');
    const busy: SessionActivity = { openPairs: ['tsk_9'], turnRunning: true, queuedMessages: 2 };
    expect(decide('deck_proj_brain', 'deck_sub_a', { force: true }, busy)).toEqual({
      ok: true, authority: 'brain', forced: true,
      discarded: { openPairs: ['tsk_9'], turnWasRunning: true, queuedMessages: 2 },
    });
    // A creator that is not the Brain may not force, busy or not: authority does not grow with the flag.
    expect(decide('deck_sub_exec', 'deck_sub_b', { force: true }, busy)).toMatchObject({ ok: false, reason: SESSION_CLOSE_REFUSAL.FORCE_NOT_PERMITTED });
    expect(decide('deck_sub_exec', 'deck_sub_b', { force: true }, IDLE)).toMatchObject({ ok: false, reason: SESSION_CLOSE_REFUSAL.FORCE_NOT_PERMITTED });
    // Force never overrides an authority or kind refusal.
    rec('deck_sub_peer', { parentSession: 'deck_proj_brain' });
    expect(decide('deck_sub_peer', 'deck_sub_a', { force: true }, busy)).toMatchObject({ ok: false });
  });
});

describe('closeSessionOnBehalf', () => {
  const closeOk = (serverNotified = true) => vi.fn(async () => ({ ok: true, alreadyClosed: false, serverNotified }));

  it('closes, reports the authority, and is idempotent', async () => {
    brain();
    marked('deck_sub_a', 'deck_sub_other');
    const close = closeOk();
    const first = await closeSessionOnBehalf('deck_proj_brain', { target: 'deck_sub_a' }, { inspectActivity: async () => IDLE, close });
    expect(first).toEqual({ status: SESSION_CLOSE_STATUS.CLOSED, target: 'deck_sub_a', authority: 'brain', serverNotified: true, forced: false });
    expect(close).toHaveBeenCalledWith('deck_sub_a');
    sessions.delete('deck_sub_a');
    expect(await closeSessionOnBehalf('deck_proj_brain', { target: 'deck_sub_a' }, { inspectActivity: async () => IDLE, close }))
      .toEqual({ status: SESSION_CLOSE_STATUS.ALREADY_CLOSED, target: 'deck_sub_a' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('names the creator as the authority when the Brain closes a session it created itself', async () => {
    brain();
    marked('deck_sub_a');
    expect(await closeSessionOnBehalf('deck_proj_brain', { target: 'deck_sub_a' }, { inspectActivity: async () => IDLE, close: closeOk() }))
      .toMatchObject({ status: 'closed', authority: 'creator' });
  });

  it('refuses without stopping anything, and an unavailable caller changes nothing', async () => {
    brain();
    marked('deck_sub_a');
    const close = closeOk();
    expect(await closeSessionOnBehalf('deck_proj_brain', { target: 'deck_sub_a' }, { inspectActivity: async () => ({ ...IDLE, turnRunning: true }), close }))
      .toMatchObject({ status: SESSION_CLOSE_STATUS.REFUSED, reason: SESSION_CLOSE_REFUSAL.TURN_RUNNING });
    expect(await closeSessionOnBehalf('deck_ghost', { target: 'deck_sub_a' }, { inspectActivity: async () => IDLE, close }))
      .toMatchObject({ status: SESSION_CLOSE_STATUS.REFUSED, reason: SESSION_CLOSE_REFUSAL.NOT_AUTHORIZED });
    expect(close).not.toHaveBeenCalled();
  });

  it('logs and reports a forced close, and a plain close is not logged as forced', async () => {
    brain();
    marked('deck_sub_a');
    const result = await closeSessionOnBehalf('deck_proj_brain', { target: 'deck_sub_a', force: true }, {
      inspectActivity: async () => ({ openPairs: ['tsk_9'], turnRunning: false, queuedMessages: 1 }),
      close: closeOk(),
    });
    expect(result).toMatchObject({ status: 'closed', forced: true, discarded: { openPairs: ['tsk_9'], queuedMessages: 1 } });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ caller: 'deck_proj_brain', target: 'deck_sub_a' }), expect.stringContaining('forced close'));
    warn.mockClear();
    marked('deck_sub_b');
    await closeSessionOnBehalf('deck_proj_brain', { target: 'deck_sub_b' }, { inspectActivity: async () => IDLE, close: closeOk() });
    expect(warn).not.toHaveBeenCalled();
  });

  it('decides again right before stopping: a pair that claimed the session in between stops the close', async () => {
    brain();
    marked('deck_sub_a');
    const close = closeOk();
    let looks = 0;
    const result = await closeSessionOnBehalf('deck_proj_brain', { target: 'deck_sub_a' }, {
      inspectActivity: async () => (++looks === 1 ? IDLE : { ...IDLE, openPairs: ['tsk_new'] }),
      close,
    });
    expect(result).toMatchObject({ status: 'refused', reason: SESSION_CLOSE_REFUSAL.OPEN_PAIR });
    expect(close).not.toHaveBeenCalled();
  });

  it('reports a failed stop as failed, not as closed', async () => {
    brain();
    marked('deck_sub_a');
    const result = await closeSessionOnBehalf('deck_proj_brain', { target: 'deck_sub_a' }, {
      inspectActivity: async () => IDLE,
      close: async () => ({ ok: false, alreadyClosed: false, serverNotified: false, error: 'runtime: still running' }),
    });
    expect(result).toEqual({ status: 'failed', target: 'deck_sub_a', error: 'runtime: still running' });
  });
});

describe('closeSubSession', () => {
  function link(connected = true): ActiveServerLink & { sent: object[] } {
    const sent: object[] = [];
    return {
      sent,
      send: (message) => { sent.push(message); },
      trySend: (message) => { if (!connected) return false; sent.push(message as object); return true; },
      isConnected: () => connected,
    };
  }
  /** The real stopSubSession reports by sending `subsession.closed` to the link it is given. */
  const stopReporting = (sessionName: string) => async (_name: string, to: { send(msg: object): void }) => {
    to.send({ type: 'subsession.closed', id: sessionName.replace(/^deck_sub_/u, ''), sessionName });
    sessions.delete(sessionName);
    return { ok: true, failed: [] };
  };

  it('stops the session and tells the server, so the browsers drop the row', async () => {
    marked('deck_sub_a');
    const serverLink = link();
    const outcome = await closeSubSession('deck_sub_a', { serverLink, stop: stopReporting('deck_sub_a') });
    expect(outcome).toEqual({ ok: true, alreadyClosed: false, serverNotified: true });
    expect(serverLink.sent).toEqual([{ type: 'subsession.closed', id: 'a', sessionName: 'deck_sub_a' }]);
    expect(pendingSubSessionClosedNoticeCount()).toBe(0);
  });

  it('keeps the notice while the link is down and replays it on the next connection', async () => {
    marked('deck_sub_a');
    const down = link(false);
    const outcome = await closeSubSession('deck_sub_a', { serverLink: down, stop: stopReporting('deck_sub_a') });
    expect(outcome).toEqual({ ok: true, alreadyClosed: false, serverNotified: false });
    expect(down.sent).toEqual([]);
    expect(pendingSubSessionClosedNoticeCount()).toBe(1);

    const up = link(true);
    expect(flushPendingSubSessionClosedNotices(up)).toBe(1);
    expect(up.sent).toEqual([{ type: 'subsession.closed', id: 'a', sessionName: 'deck_sub_a' }]);
    expect(pendingSubSessionClosedNoticeCount()).toBe(0);
    expect(flushPendingSubSessionClosedNotices(up)).toBe(0);
  });

  it('is idempotent for a session that is already gone, and shares one stop between concurrent closes', async () => {
    expect(await closeSubSession('deck_sub_none', { serverLink: link(), stop: vi.fn() })).toEqual({ ok: true, alreadyClosed: true, serverNotified: true });

    marked('deck_sub_a');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const stop = vi.fn(async (name: string, to: { send(msg: object): void }) => {
      await gate;
      return stopReporting(name)(name, to);
    });
    const serverLink = link();
    const first = closeSubSession('deck_sub_a', { serverLink, stop });
    const second = closeSubSession('deck_sub_a', { serverLink, stop });
    expect(isSessionClosing('deck_sub_a')).toBe(true);
    release();
    expect(await first).toEqual(await second);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(serverLink.sent).toHaveLength(1);
    expect(isSessionClosing('deck_sub_a')).toBe(false);
  });

  it('reports a runtime that would not stop, and tells the server nothing', async () => {
    marked('deck_sub_a');
    const serverLink = link();
    const outcome = await closeSubSession('deck_sub_a', {
      serverLink,
      stop: async () => ({ ok: false, failed: [{ stage: 'runtime', message: 'still active' }] }),
    });
    expect(outcome).toMatchObject({ ok: false, alreadyClosed: false, error: 'runtime: still active' });
    expect(serverLink.sent).toEqual([]);
    expect(pendingSubSessionClosedNoticeCount()).toBe(0);
    expect(isSessionClosing('deck_sub_a')).toBe(false);
  });
});
