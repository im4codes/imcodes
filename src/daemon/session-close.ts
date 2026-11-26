/**
 * Closing sub-sessions.
 *
 * Two layers, so nothing is written twice:
 *
 * - `closeSubSession(name)` is THE close: the existing `stopSubSession` (stop the runtime, release its resources, remove the daemon
 *   record) plus a guarantee the server hears about it. The server stamps `sub_sessions.closed_at`, revokes shares and broadcasts
 *   `subsession.removed`, which every browser already handles. A close that happens while the link is down is replayed on reconnect
 *   (`active-server-link.ts`). The `session_close` tool and the discarding of a half-made session both go through it.
 * - `closeSessionOnBehalf(caller, request)` is the authorization and safety policy of the MCP tool: who may close what, and when the
 *   close would throw away work.
 *
 * Authority, in order: a main session or a Brain can never be closed; an execution clone is destroyed by its creator with
 * `destroy_execution_clone`; a session closes itself never; the session's creator (the marker's `createdBy`) may close it; the
 * project's Brain may close any sub-session of the project, but one nobody created automatically (a user's own) only with an explicit
 * `confirmUserCreated`. Everyone else is refused. Work in flight (an open pair, a running turn, queued messages) refuses the close by
 * default; `force` overrides that for the Brain only, the response lists exactly what was discarded, and the override is logged.
 */
import logger from '../util/logger.js';
import { getSession, listSessions, type SessionRecord } from '../store/session-store.js';
import { resolveEffectiveProjectName } from '../../shared/session-scope.js';
import type { TaskPairCreatedSessionMetadata } from '../../shared/task-pair.js';
import {
  SESSION_CLOSE_AUTHORITY,
  SESSION_CLOSE_REFUSAL,
  SESSION_CLOSE_STATUS,
  type SessionCloseAuthority,
  type SessionCloseDiscarded,
  type SessionCloseRefusal,
  type SessionCloseRequest,
  type SessionCloseResult,
} from '../../shared/session-close.js';
import { getActiveServerLink, notifySubSessionClosed, type ActiveServerLink, type SubSessionClosedNotice } from './active-server-link.js';

const SUB_SESSION_PREFIX = 'deck_sub_';

// ---- the one close -----------------------------------------------------------------------------------------------------------------

export interface CloseSubSessionOutcome {
  ok: boolean;
  /** The session was not there to close. */
  alreadyClosed: boolean;
  /** The server was told now (false: kept for replay on the next connection, or there was no link). */
  serverNotified: boolean;
  error?: string;
}

export interface CloseSubSessionOptions {
  serverLink?: ActiveServerLink | null;
  /** Test seam; production is `stopSubSession`. */
  stop?: (sessionName: string, link: { send(msg: object): void }) => Promise<{ ok: boolean; failed: Array<{ stage: string; message: string }> }>;
}

async function defaultStop(sessionName: string, link: { send(msg: object): void }) {
  const { stopSubSession } = await import('./subsession-manager.js');
  return stopSubSession(sessionName, link);
}

const closing = new Map<string, Promise<CloseSubSessionOutcome>>();

/** True while a close of this session is running; a second close of it joins that one instead of stopping the runtime twice. */
export function isSessionClosing(sessionName: string): boolean {
  return closing.has(sessionName);
}

export function closeSubSession(sessionName: string, options: CloseSubSessionOptions = {}): Promise<CloseSubSessionOutcome> {
  const running = closing.get(sessionName);
  if (running) return running;
  const operation = (async (): Promise<CloseSubSessionOutcome> => {
    if (!getSession(sessionName)) return { ok: true, alreadyClosed: true, serverNotified: true };
    // stopSubSession reports the close by sending to the link it is given. Give it a recorder, so the notice is delivered (or kept for
    // replay) by the one place that knows whether the socket is up.
    let captured: SubSessionClosedNotice | undefined;
    const recorder = {
      send(message: object): void {
        const candidate = message as Partial<SubSessionClosedNotice>;
        if (candidate.type === 'subsession.closed' && typeof candidate.id === 'string' && typeof candidate.sessionName === 'string') {
          captured = { type: 'subsession.closed', id: candidate.id, sessionName: candidate.sessionName };
        }
      },
    };
    let result;
    try {
      result = await (options.stop ?? defaultStop)(sessionName, recorder);
    } catch (error) {
      return { ok: false, alreadyClosed: false, serverNotified: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!result.ok) {
      return {
        ok: false,
        alreadyClosed: false,
        serverNotified: false,
        error: result.failed.map((failure) => `${failure.stage}: ${failure.message}`).join('; ') || 'the session could not be stopped',
      };
    }
    const notice = captured ?? (sessionName.startsWith(SUB_SESSION_PREFIX)
      ? { type: 'subsession.closed' as const, id: sessionName.slice(SUB_SESSION_PREFIX.length), sessionName }
      : undefined);
    const serverNotified = notice ? notifySubSessionClosed(notice, options.serverLink ?? getActiveServerLink()) : true;
    return { ok: true, alreadyClosed: false, serverNotified };
  })().finally(() => { closing.delete(sessionName); });
  closing.set(sessionName, operation);
  return operation;
}

// ---- what a close would throw away -------------------------------------------------------------------------------------------------

export interface SessionActivity {
  /** Task ids of pairs that have not ended and name this session as executor or auditor (started or queued). */
  openPairs: string[];
  turnRunning: boolean;
  queuedMessages: number;
}

export async function inspectSessionActivity(record: SessionRecord): Promise<SessionActivity> {
  const { getTaskPairStore } = await import('./task-pairs/store.js');
  const openPairs = getTaskPairStore().pairsForSession(record.name)
    .filter((pair) => pair.state.executor === record.name || pair.state.auditor === record.name)
    .map((pair) => pair.state.taskId);
  const { getTransportRuntime } = await import('../agent/session-manager.js');
  const runtime = getTransportRuntime(record.name);
  const turnRunning = runtime ? runtime.getStatus() !== 'idle' : record.state === 'running';
  return { openPairs, turnRunning, queuedMessages: runtime?.pendingCount ?? 0 };
}

/** The marker of a session something other than the user created, or undefined for a user's own session. */
export function readCreationMarker(record: SessionRecord): TaskPairCreatedSessionMetadata | undefined {
  const marker = record.pairCreatedMetadata as Partial<TaskPairCreatedSessionMetadata> | null | undefined;
  if (!marker || marker.autoCreated !== true || typeof marker.createdBy !== 'string' || !marker.createdBy) return undefined;
  return marker as TaskPairCreatedSessionMetadata;
}

function isExecutionClone(record: SessionRecord): boolean {
  return Boolean((record as SessionRecord & { executionCloneMetadata?: unknown }).executionCloneMetadata);
}

// ---- policy ------------------------------------------------------------------------------------------------------------------------

export type SessionCloseDecision =
  | { ok: true; authority: SessionCloseAuthority; forced: boolean; discarded?: SessionCloseDiscarded }
  | { ok: false; reason: SessionCloseRefusal; detail: string };

export function evaluateSessionClose(input: {
  caller: SessionRecord;
  target: SessionRecord;
  request: SessionCloseRequest;
  activity: SessionActivity;
  /** Every session of the daemon: a sub-session's project is its parent's (see resolveEffectiveProjectName). */
  sessions: readonly SessionRecord[];
}): SessionCloseDecision {
  const { caller, target, request, activity, sessions } = input;
  const refuse = (reason: SessionCloseRefusal, detail: string): SessionCloseDecision => ({ ok: false, reason, detail });
  if (resolveEffectiveProjectName(caller, sessions) !== resolveEffectiveProjectName(target, sessions)) {
    return refuse(SESSION_CLOSE_REFUSAL.NOT_AUTHORIZED, 'the target is not a session of the caller\'s project');
  }
  if (target.role === 'brain' || !target.parentSession || !target.name.startsWith(SUB_SESSION_PREFIX)) {
    return refuse(SESSION_CLOSE_REFUSAL.NOT_A_SUB_SESSION, 'only sub-sessions can be closed; a Brain or a main session never is');
  }
  if (isExecutionClone(target)) {
    return refuse(SESSION_CLOSE_REFUSAL.EXECUTION_CLONE, 'an execution clone is removed by its creator with destroy_execution_clone');
  }
  if (caller.name === target.name) {
    return refuse(SESSION_CLOSE_REFUSAL.SELF, 'a session cannot close itself');
  }

  const marker = readCreationMarker(target);
  const callerIsBrain = caller.role === 'brain' && !caller.parentSession;
  let authority: SessionCloseAuthority;
  if (marker && marker.createdBy === caller.name) {
    authority = SESSION_CLOSE_AUTHORITY.CREATOR;
  } else if (callerIsBrain) {
    authority = SESSION_CLOSE_AUTHORITY.BRAIN;
  } else {
    return refuse(SESSION_CLOSE_REFUSAL.NOT_AUTHORIZED, 'only the session\'s creator or the project Brain may close it');
  }
  if (!marker && request.confirmUserCreated !== true) {
    return refuse(
      SESSION_CLOSE_REFUSAL.USER_CREATED_NEEDS_CONFIRMATION,
      'nobody created this session automatically, so it is a user\'s own; pass confirmUserCreated=true to close it',
    );
  }
  if (request.force === true && !callerIsBrain) {
    return refuse(SESSION_CLOSE_REFUSAL.FORCE_NOT_PERMITTED, 'only the project Brain may force a close');
  }

  const blockers: Array<{ reason: SessionCloseRefusal; detail: string }> = [];
  if (activity.openPairs.length > 0) {
    blockers.push({ reason: SESSION_CLOSE_REFUSAL.OPEN_PAIR, detail: `it is executor or auditor of open pair(s) ${activity.openPairs.join(', ')}` });
  }
  if (activity.turnRunning) blockers.push({ reason: SESSION_CLOSE_REFUSAL.TURN_RUNNING, detail: 'a turn is running' });
  if (activity.queuedMessages > 0) {
    blockers.push({ reason: SESSION_CLOSE_REFUSAL.QUEUED_MESSAGES, detail: `${activity.queuedMessages} message(s) are queued for it and would be dropped` });
  }
  if (blockers.length > 0 && request.force !== true) {
    return refuse(blockers[0]!.reason, blockers.map((blocker) => blocker.detail).join('; ') + '; force=true (Brain only) overrides');
  }
  return {
    ok: true,
    authority,
    forced: blockers.length > 0,
    ...(blockers.length > 0
      ? { discarded: { openPairs: activity.openPairs, turnWasRunning: activity.turnRunning, queuedMessages: activity.queuedMessages } }
      : {}),
  };
}

// ---- the tool's entry point --------------------------------------------------------------------------------------------------------

export interface SessionCloseDeps {
  getSession?: (name: string) => SessionRecord | undefined;
  listSessions?: () => SessionRecord[];
  inspectActivity?: (record: SessionRecord) => Promise<SessionActivity>;
  close?: (sessionName: string) => Promise<CloseSubSessionOutcome>;
}

/**
 * Close `request.target` on behalf of the session `callerName`. Idempotent: a target that is already gone answers `already_closed`.
 * Concurrent closes of one session share one operation, and the activity is read again under that operation's name so a pair that
 * claimed the session in between still stops the close.
 */
export async function closeSessionOnBehalf(
  callerName: string,
  request: SessionCloseRequest,
  deps: SessionCloseDeps = {},
): Promise<SessionCloseResult> {
  const lookup = deps.getSession ?? getSession;
  const caller = lookup(callerName);
  if (!caller || caller.state === 'stopped') {
    return { status: SESSION_CLOSE_STATUS.REFUSED, target: request.target, reason: SESSION_CLOSE_REFUSAL.NOT_AUTHORIZED, detail: 'the caller\'s session is unavailable' };
  }
  const target = lookup(request.target);
  if (!target) return { status: SESSION_CLOSE_STATUS.ALREADY_CLOSED, target: request.target };

  const inspect = deps.inspectActivity ?? inspectSessionActivity;
  const sessions = (deps.listSessions ?? listSessions)();
  const decision = evaluateSessionClose({ caller, target, request, activity: await inspect(target), sessions });
  if (!decision.ok) {
    return { status: SESSION_CLOSE_STATUS.REFUSED, target: target.name, reason: decision.reason, detail: decision.detail };
  }
  // A concurrent assignment may have claimed the session while we were looking: decide again right before stopping it.
  const fresh = lookup(target.name);
  if (!fresh) return { status: SESSION_CLOSE_STATUS.ALREADY_CLOSED, target: target.name };
  const recheck = evaluateSessionClose({ caller, target: fresh, request, activity: await inspect(fresh), sessions: (deps.listSessions ?? listSessions)() });
  if (!recheck.ok) {
    return { status: SESSION_CLOSE_STATUS.REFUSED, target: fresh.name, reason: recheck.reason, detail: recheck.detail };
  }
  if (decision.forced) {
    logger.warn({
      caller: caller.name, target: target.name, authority: decision.authority, discarded: recheck.ok ? recheck.discarded : decision.discarded,
    }, 'session_close: forced close discarded in-flight work');
  } else {
    logger.info({ caller: caller.name, target: target.name, authority: decision.authority }, 'session_close: closing sub-session');
  }
  const outcome = await (deps.close ?? ((name: string) => closeSubSession(name)))(target.name);
  if (outcome.alreadyClosed) return { status: SESSION_CLOSE_STATUS.ALREADY_CLOSED, target: target.name };
  if (!outcome.ok) return { status: SESSION_CLOSE_STATUS.FAILED, target: target.name, error: outcome.error ?? 'the session could not be stopped' };
  return {
    status: SESSION_CLOSE_STATUS.CLOSED,
    target: target.name,
    authority: decision.authority,
    serverNotified: outcome.serverNotified,
    forced: recheck.ok ? recheck.forced : decision.forced,
    ...((recheck.ok ? recheck.discarded : decision.discarded) ? { discarded: (recheck.ok ? recheck.discarded : decision.discarded)! } : {}),
  };
}
