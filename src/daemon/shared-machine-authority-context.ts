import { DAEMON_COMMAND_TYPES } from '../../shared/daemon-command-types.js';
import {
  SHARED_MACHINE_ACTIVITY_KIND,
  type SharedMachineActivity,
} from '../../shared/shared-machine-authority.js';
import type { SharedActorEnvelope } from '../../shared/tab-sharing.js';

type RuntimeIdentity = { sessionInstanceId: string; runtimeEpoch: string };
type Window = {
  /** null when the session record carried no runtime identity: every read then fails closed. */
  identity: RuntimeIdentity | null;
  /** The owner (or any non-participant source) fed this session during the window. */
  owner: boolean;
  /** Distinct participant users that fed this session during the window. */
  participants: Set<string>;
  /** Latest server-minted token of the (single) participant; the server re-verifies it on every use. */
  authority: string | null;
  lastActivityAt: number;
  /**
   * Every turn that can still run on the session, counting the one already in
   * flight when the window opened (the daemon did not see it start), the ones
   * queued behind it in the TUI, and the ones bound but not typed yet. A
   * turn-producing input is a message, or a line submitted with Enter (plain
   * typing is not). One idle edge ends one turn.
   */
  turns: number;
  /** Of `turns`: bound, but the daemon has not written them to the terminal yet (recall, delivery lock). */
  undelivered: number;
};

/**
 * A running process-session turn has no per-message boundary the daemon can
 * see (terminal keystrokes, queued TUI input), so the context is a window over
 * everything that fed the session since it was last idle:
 *
 *   - participant activity only, one user  -> that user's authority
 *   - owner activity only                  -> no restriction (`required: false`)
 *   - owner + participant, or two users    -> fail closed (`required`, no authority)
 *
 * Owner activity never clears the window. An idle edge ends one turn
 * ({@link releaseProcessSharedMachineAuthority}); the window is released only
 * when no further turn can still run (see `turns`), so input queued in the TUI
 * behind a running turn, or still being delivered, stays bound to its author.
 * Mirrors the transport rule in TransportSessionRuntime.getActiveSharedMachineAuthority.
 */
const windows = new Map<string, Window>();

/**
 * A window with no new activity for this long is released at the next bind/read
 * unless the session is still running a turn. A long running turn keeps its
 * window (and so its restriction) for as long as the session says it is running.
 */
export const PROCESS_SHARED_MACHINE_WINDOW_QUIET_MS = 10 * 60 * 1000;

function sameIdentity(a: RuntimeIdentity | null, b: RuntimeIdentity | null): boolean {
  return !!a && !!b && a.sessionInstanceId === b.sessionInstanceId && a.runtimeEpoch === b.runtimeEpoch;
}

function quietAndIdle(window: Window, now: number, sessionRunning: boolean): boolean {
  return !sessionRunning && now - window.lastActivityAt >= PROCESS_SHARED_MACHINE_WINDOW_QUIET_MS;
}

/**
 * Handle for one bound turn-producing input. `typed()` says the daemon wrote it
 * to the terminal (from then on an idle edge may end its turn); `settle()` says
 * delivery is over, whatever happened: an input that was never typed (failed,
 * rerouted to a transport runtime, rejected) is not a turn that will run.
 * Both are idempotent.
 */
export interface ProcessSharedMachineBinding {
  typed(at?: number): void;
  settle(): void;
}
const NO_BINDING: ProcessSharedMachineBinding = { typed() { /* not a turn */ }, settle() { /* not a turn */ } };

/** Record who just fed a process session. Runs per keystroke: a Map lookup, no I/O. */
export function bindProcessSharedMachineActivity(
  sessionName: string,
  identity: RuntimeIdentity | null,
  activity: SharedMachineActivity,
  opts: {
    now?: number;
    sessionRunning?: boolean;
    /** The activity submits a turn (a message, an Enter). Plain typing does not. Default true. */
    startsTurn?: boolean;
  } = {},
): ProcessSharedMachineBinding {
  const now = opts.now ?? Date.now();
  let window = windows.get(sessionName);
  // A restarted runtime or a long-quiet idle session starts a fresh window.
  if (window && window.identity && identity && !sameIdentity(window.identity, identity)) window = undefined;
  if (window && quietAndIdle(window, now, opts.sessionRunning ?? false)) window = undefined;
  if (!window) {
    // A session that is running when the window opens is running a turn the daemon never saw start
    // (typed in the local tmux, an automation write): it is ahead of this input and must be counted.
    window = {
      identity, owner: false, participants: new Set(), authority: null, lastActivityAt: now,
      turns: opts.sessionRunning ? 1 : 0, undelivered: 0,
    };
    windows.set(sessionName, window);
  }
  window.lastActivityAt = now;
  const startsTurn = opts.startsTurn ?? true;
  if (startsTurn) {
    window.turns += 1;
    window.undelivered += 1;
  }
  if (!identity) window.identity = null;
  if (activity.kind === SHARED_MACHINE_ACTIVITY_KIND.OWNER) {
    window.owner = true;
  } else {
    window.participants.add(activity.actorUserId);
    // Keep the participant marker even without a token: a participant turn must
    // never degrade into the ordinary source-owner path because propagation failed.
    if (activity.authority) window.authority = activity.authority;
  }
  if (!startsTurn) return NO_BINDING;
  const bound = window;
  let pending = true;
  return {
    typed(at = Date.now()) {
      if (!pending) return;
      pending = false;
      if (windows.get(sessionName) !== bound || bound.undelivered <= 0) return;
      bound.undelivered -= 1;
      // The terminal just received it: an idle edge right after is the tail of the previous turn.
      bound.lastActivityAt = at;
    },
    settle() {
      if (!pending) return;
      pending = false;
      if (windows.get(sessionName) !== bound || bound.undelivered <= 0) return;
      bound.undelivered -= 1;
      bound.turns = Math.max(0, bound.turns - 1);
    },
  };
}

/**
 * Bind one admitted command (a stamped send or terminal input) to the session's
 * window. Only the server-stamped envelope can make it a participant command;
 * anything unstamped is owner activity.
 */
export function bindProcessSharedMachineCommand(
  sessionName: string,
  record: { sessionInstanceId?: string; runtimeEpoch?: string; state?: string } | undefined,
  cmd: Record<string, unknown>,
  now?: number,
): ProcessSharedMachineBinding {
  const identity = record?.sessionInstanceId && record.runtimeEpoch
    ? { sessionInstanceId: record.sessionInstanceId, runtimeEpoch: record.runtimeEpoch }
    : null;
  const actor = cmd.sharedActor && typeof cmd.sharedActor === 'object'
    ? cmd.sharedActor as Partial<SharedActorEnvelope>
    : undefined;
  const authority = typeof cmd.sharedMachineAuthority === 'string' && cmd.sharedMachineAuthority.trim()
    ? cmd.sharedMachineAuthority.trim()
    : undefined;
  const activity: SharedMachineActivity = actor?.effectiveActorRole === 'participant'
    ? {
        kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT,
        actorUserId: typeof actor.actorUserId === 'string' ? actor.actorUserId : '',
        authority,
      }
    : { kind: SHARED_MACHINE_ACTIVITY_KIND.OWNER };
  // Keystrokes only start a turn when they submit a line (Enter); a message always does.
  const startsTurn = cmd.type === DAEMON_COMMAND_TYPES.SESSION_INPUT
    ? typeof cmd.data === 'string' && /[\r\n]/.test(cmd.data)
    : true;
  return bindProcessSharedMachineActivity(sessionName, identity, activity, {
    startsTurn,
    sessionRunning: record?.state === 'running',
    ...(now === undefined ? {} : { now }),
  });
}

/**
 * An idle signal within this long of the latest activity is the tail of the
 * PREVIOUS turn (a late Stop hook, a terminal idle timer armed before the input
 * arrived), not the end of the turn that activity started. Ignoring it fails
 * closed: a window that really did finish stays until the next real idle, or
 * until it has been quiet for {@link PROCESS_SHARED_MACHINE_WINDOW_QUIET_MS} on an idle session.
 */
export const PROCESS_SHARED_MACHINE_IDLE_GUARD_MS = 1_500;

/**
 * The session returned to idle: ONE turn is over. `turns` counts every turn that
 * can still run (in flight, queued in the TUI, or bound but not typed yet), so
 * while more than one remains the window carries on: participants and token are
 * kept, the owner flag is cleared (a queued owner turn then runs more restricted
 * than needed, never less). It is released only when no further turn can run.
 * An owner-only window carries too, at no cost (it reads as unrestricted), so a
 * participant that joins while an owner turn is still ahead is counted behind it.
 * An edge never consumes a turn that has not been typed yet: it ended an earlier
 * one. Driven by the daemon's `session.state` = idle timeline event (Claude Code
 * Stop hook, Codex/Gemini watchers, terminal-streamer quiet timer).
 */
export function releaseProcessSharedMachineAuthority(sessionName: string, now = Date.now()): void {
  const window = windows.get(sessionName);
  if (!window) return;
  if (now - window.lastActivityAt < PROCESS_SHARED_MACHINE_IDLE_GUARD_MS) return;
  if (window.undelivered > 0 && window.turns - window.undelivered <= 0) return;
  if (window.turns > 1) {
    window.turns -= 1;
    window.owner = false;
    window.lastActivityAt = now;
    return;
  }
  windows.delete(sessionName);
}

export function readProcessSharedMachineAuthority(
  sessionName: string,
  identity: RuntimeIdentity,
  now = Date.now(),
  sessionRunning = false,
): { required: boolean; authority: string | null } {
  const window = windows.get(sessionName);
  if (!window) return { required: false, authority: null };
  if (quietAndIdle(window, now, sessionRunning)) {
    windows.delete(sessionName);
    return { required: false, authority: null };
  }
  // Owner-only activity is the ordinary unrestricted path.
  if (window.participants.size === 0) return { required: false, authority: null };
  if (!sameIdentity(window.identity, identity)) return { required: true, authority: null };
  if (window.owner || window.participants.size > 1) return { required: true, authority: null };
  return { required: true, authority: window.authority };
}

export function clearProcessSharedMachineAuthoritiesForTests(): void {
  windows.clear();
}
