import { createHash } from 'node:crypto';
import { DAEMON_COMMAND_TYPES } from '../../shared/daemon-command-types.js';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import {
  OWNER_MACHINE_AUTHORITY_FIELD,
  SHARED_MACHINE_ACTIVITY_KIND,
  SHARED_MACHINE_AUTHORITY_ACTOR_KIND,
  type SharedMachineActivity,
  type SharedMachineAuthorityActorKind,
} from '../../shared/shared-machine-authority.js';
import type { SharedActorEnvelope } from '../../shared/tab-sharing.js';
import { getSession, listSessions } from '../store/session-store.js';
import { getActiveServerLink } from './active-server-link.js';

const MAX_ROOT_TREE_DEPTH = 16;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Resolve the canonical root session name for any session in a tree (walking
 * `parentSession` bounded against cycles; standalone sessions return themselves).
 */
export function resolveDaemonRootSessionName(sessionName: string): string {
  let current = sessionName;
  const visited = new Set<string>();
  for (let depth = 0; depth < MAX_ROOT_TREE_DEPTH; depth += 1) {
    if (visited.has(current)) break;
    visited.add(current);
    const parent = getSession(current)?.parentSession;
    if (!parent) break;
    current = parent;
  }
  return current;
}

export interface TreeAuthorityState {
  rootSessionName: string;
  kind: 'owner' | 'participant' | 'mixed';
  actorUserId: string | null;
  authority: string | null;
  tokenHash: string | null;
  activeSessions: Set<string>;
  updatedAt: number;
}

const treeAuthorities = new Map<string, TreeAuthorityState>();
export type TreeSessionActivityProbe = (sessionName: string) => boolean;
const treeActivityProbes = new Set<TreeSessionActivityProbe>();

export function registerTreeSessionActivityProbe(probe: TreeSessionActivityProbe): () => void {
  treeActivityProbes.add(probe);
  return () => {
    treeActivityProbes.delete(probe);
  };
}

function sendTurnAuthorityRevoke(rootSessionName: string, tokenHash: string): void {
  const link = getActiveServerLink();
  if (!link || (link.isConnected && !link.isConnected())) return;
  try {
    const frame = {
      type: DAEMON_MSG.TURN_AUTHORITY_REVOKE,
      rootSessionName,
      tokenHash,
    };
    if (link.trySend) link.trySend(frame);
    else link.send(frame);
  } catch {
    // Socket unavailable: server WS disconnect handler sweeps all grants for this serverId.
  }
}

function isAnyTreeSessionStillActive(rootSessionName: string, entry: TreeAuthorityState): boolean {
  if (entry.activeSessions.size > 0) return true;
  const candidateSessions = new Set<string>();
  for (const s of listSessions()) {
    if (resolveDaemonRootSessionName(s.name) === rootSessionName) candidateSessions.add(s.name);
  }
  for (const sName of windows.keys()) {
    if (resolveDaemonRootSessionName(sName) === rootSessionName) candidateSessions.add(sName);
  }
  for (const sessionName of candidateSessions) {
    const win = windows.get(sessionName);
    if (win && win.turns > 0) return true;
    const record = getSession(sessionName);
    if (record?.state === 'running') return true;
    for (const probe of treeActivityProbes) {
      try {
        if (probe(sessionName)) return true;
      } catch {
        // Ignore probe errors; fall through conservatively only when positive.
      }
    }
  }
  return false;
}

function maybeRevokeIdleTreeAuthority(rootSessionName: string, expectedTokenHash: string | null): void {
  const entry = treeAuthorities.get(rootSessionName);
  if (!entry || entry.tokenHash !== expectedTokenHash) return;
  if (isAnyTreeSessionStillActive(rootSessionName, entry)) return;
  treeAuthorities.delete(rootSessionName);
  if (expectedTokenHash) {
    sendTurnAuthorityRevoke(rootSessionName, expectedTokenHash);
  }
}

/** Update or establish the unified in-memory grant for a session's root tree. */
export function bindTreeTurnAuthority(
  sessionName: string,
  activity: SharedMachineActivity,
  opts: { now?: number; markActive?: boolean } = {},
): void {
  const now = opts.now ?? Date.now();
  const rootSessionName = resolveDaemonRootSessionName(sessionName);
  const existing = treeAuthorities.get(rootSessionName);
  const markActive = opts.markActive !== false;

  if (activity.kind === SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT) {
    const authority = typeof activity.authority === 'string' && activity.authority.trim()
      ? activity.authority.trim()
      : null;
    if (authority) {
      const tokenHash = sha256Hex(authority);
      const activeSessions = existing?.activeSessions ?? new Set<string>();
      if (markActive) activeSessions.add(sessionName);
      treeAuthorities.set(rootSessionName, {
        rootSessionName,
        kind: 'participant',
        actorUserId: activity.actorUserId || null,
        authority,
        tokenHash,
        activeSessions,
        updatedAt: now,
      });
      return;
    }
    const activeSessions = existing?.activeSessions ?? new Set<string>();
    if (markActive) activeSessions.add(sessionName);
    treeAuthorities.set(rootSessionName, {
      rootSessionName,
      kind: 'mixed',
      actorUserId: activity.actorUserId || null,
      authority: null,
      tokenHash: null,
      activeSessions,
      updatedAt: now,
    });
    return;
  }

  const ownerAuthority = typeof activity.authority === 'string' && activity.authority.trim()
    ? activity.authority.trim()
    : null;
  if (ownerAuthority) {
    const tokenHash = sha256Hex(ownerAuthority);
    const activeSessions = existing?.activeSessions ?? new Set<string>();
    if (markActive) activeSessions.add(sessionName);
    treeAuthorities.set(rootSessionName, {
      rootSessionName,
      kind: 'owner',
      actorUserId: null,
      authority: ownerAuthority,
      tokenHash,
      activeSessions,
      updatedAt: now,
    });
    return;
  }

  if (existing && markActive) {
    existing.activeSessions.add(sessionName);
    existing.updatedAt = now;
  }
}

export function markTreeSessionActive(sessionName: string, now = Date.now()): void {
  const rootSessionName = resolveDaemonRootSessionName(sessionName);
  const entry = treeAuthorities.get(rootSessionName);
  if (!entry) return;
  entry.activeSessions.add(sessionName);
  entry.updatedAt = now;
}

export function markTreeSessionIdle(sessionName: string, now = Date.now()): void {
  const rootSessionName = resolveDaemonRootSessionName(sessionName);
  const entry = treeAuthorities.get(rootSessionName);
  if (!entry) return;
  entry.activeSessions.delete(sessionName);
  entry.updatedAt = now;
  const expectedTokenHash = entry.tokenHash;
  queueMicrotask(() => {
    maybeRevokeIdleTreeAuthority(rootSessionName, expectedTokenHash);
  });
}

export function readActiveTreeAuthorityForSession(
  sessionName: string,
): { kind: 'owner' | 'participant' | 'mixed'; actorUserId: string | null; authority: string | null; rootSessionName: string } | null {
  const rootSessionName = resolveDaemonRootSessionName(sessionName);
  const entry = treeAuthorities.get(rootSessionName);
  if (!entry) return null;
  return {
    kind: entry.kind,
    actorUserId: entry.actorUserId,
    authority: entry.authority,
    rootSessionName: entry.rootSessionName,
  };
}

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
  /** Latest server-minted owner-turn authority token when only authenticated owner activity ran in this window. */
  ownerAuthority: string | null;
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
      identity, owner: false, participants: new Set(), authority: null, ownerAuthority: null, lastActivityAt: now,
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
    window.ownerAuthority = activity.authority ?? null;
  } else {
    window.participants.add(activity.actorUserId);
    window.ownerAuthority = null;
    // Keep the participant marker even without a token: a participant turn must
    // never degrade into the ordinary source-owner path because propagation failed.
    if (activity.authority) window.authority = activity.authority;
  }
  if (startsTurn || activity.authority) {
    bindTreeTurnAuthority(sessionName, activity, { now, markActive: startsTurn });
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
      if (bound.turns === 0) {
        const rootSessionName = resolveDaemonRootSessionName(sessionName);
        const entry = treeAuthorities.get(rootSessionName);
        if (entry) {
          queueMicrotask(() => {
            if (!isAnyTreeSessionStillActive(rootSessionName, entry)) {
              maybeRevokeIdleTreeAuthority(rootSessionName, entry.tokenHash);
            }
          });
        }
      }
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
  const ownerAuthority = typeof cmd[OWNER_MACHINE_AUTHORITY_FIELD] === 'string' && String(cmd[OWNER_MACHINE_AUTHORITY_FIELD]).trim()
    ? String(cmd[OWNER_MACHINE_AUTHORITY_FIELD]).trim()
    : undefined;
  const activity: SharedMachineActivity = actor?.effectiveActorRole === 'participant'
    ? {
        kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT,
        actorUserId: typeof actor.actorUserId === 'string' ? actor.actorUserId : '',
        authority,
      }
    : {
        kind: SHARED_MACHINE_ACTIVITY_KIND.OWNER,
        ...(ownerAuthority ? { authority: ownerAuthority } : {}),
      };
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
  if (window) {
    if (now - window.lastActivityAt < PROCESS_SHARED_MACHINE_IDLE_GUARD_MS) return;
    if (window.undelivered > 0 && window.turns - window.undelivered <= 0) return;
    if (window.turns > 1) {
      window.turns -= 1;
      window.owner = false;
      if (window.participants.size > 0) window.ownerAuthority = null;
      window.lastActivityAt = now;
      return;
    }
    windows.delete(sessionName);
  }
  markTreeSessionIdle(sessionName, now);
}

/**
 * Resolve the effective hook authority for any session in a tree (main session or sub-session):
 * 1. Mixed or tokenless local turn always fails closed (`required: true, authority: null`).
 * 2. Active tree authority (`treeAuthorities` keyed by `rootSessionName`) governs the whole tree
 *    uniformly — including child sub-sessions whose parent Brain already went idle.
 * 3. Falls back to the session's own transport/process context when no tree grant is registered.
 */
export function resolveSessionEffectiveSharedMachineAuthority(input: {
  sessionName: string;
  identity: RuntimeIdentity;
  sessionRunning?: boolean;
  now?: number;
  runtime?: {
    requiresSharedMachineAuthority?: () => boolean;
    getActiveSharedMachineAuthority?: () => string | null;
    getActiveOwnerMachineAuthority?: () => string | null;
  } | null;
}): { required: boolean; actorKind?: SharedMachineAuthorityActorKind; authority: string | null } {
  const now = input.now ?? Date.now();
  const sessionRunning = input.sessionRunning ?? false;
  if (input.runtime) {
    const localRequired = input.runtime.requiresSharedMachineAuthority?.() === true;
    const localSharedAuth = input.runtime.getActiveSharedMachineAuthority?.() ?? null;
    if (localRequired && !localSharedAuth) {
      return { required: true, authority: null };
    }
    const tree = readActiveTreeAuthorityForSession(input.sessionName);
    if (tree) {
      if (tree.kind === 'mixed' || (tree.kind === 'participant' && !tree.authority)) {
        return { required: true, authority: null };
      }
      if (tree.kind === 'participant') {
        return {
          required: true,
          actorKind: SHARED_MACHINE_AUTHORITY_ACTOR_KIND.PARTICIPANT,
          authority: tree.authority,
        };
      }
      return tree.authority
        ? { required: false, actorKind: SHARED_MACHINE_AUTHORITY_ACTOR_KIND.OWNER, authority: tree.authority }
        : { required: false, authority: null };
    }
    if (localRequired) {
      return {
        required: true,
        actorKind: SHARED_MACHINE_AUTHORITY_ACTOR_KIND.PARTICIPANT,
        authority: localSharedAuth,
      };
    }
    const localOwnerAuth = input.runtime.getActiveOwnerMachineAuthority?.() ?? null;
    return localOwnerAuth
      ? { required: false, actorKind: SHARED_MACHINE_AUTHORITY_ACTOR_KIND.OWNER, authority: localOwnerAuth }
      : { required: false, authority: null };
  }

  const processContext = readProcessSharedMachineAuthority(input.sessionName, input.identity, now, sessionRunning);
  if (processContext.required && !processContext.authority) {
    return { required: true, authority: null };
  }
  const tree = readActiveTreeAuthorityForSession(input.sessionName);
  if (tree) {
    if (tree.kind === 'mixed' || (tree.kind === 'participant' && !tree.authority)) {
      return { required: true, authority: null };
    }
    if (tree.kind === 'participant') {
      return {
        required: true,
        actorKind: SHARED_MACHINE_AUTHORITY_ACTOR_KIND.PARTICIPANT,
        authority: tree.authority,
      };
    }
    return tree.authority
      ? { required: false, actorKind: SHARED_MACHINE_AUTHORITY_ACTOR_KIND.OWNER, authority: tree.authority }
      : { required: false, authority: null };
  }
  return processContext;
}

export function readProcessSharedMachineAuthority(
  sessionName: string,
  identity: RuntimeIdentity,
  now = Date.now(),
  sessionRunning = false,
): { required: boolean; actorKind?: SharedMachineAuthorityActorKind; authority: string | null } {
  const window = windows.get(sessionName);
  if (!window) return { required: false, authority: null };
  if (quietAndIdle(window, now, sessionRunning)) {
    windows.delete(sessionName);
    return { required: false, authority: null };
  }
  // Owner-only activity is the ordinary unrestricted path; on shared hosts it carries its server-signed owner token.
  if (window.participants.size === 0) {
    const ownerAuthority = sameIdentity(window.identity, identity) ? window.ownerAuthority : null;
    return ownerAuthority
      ? { required: false, actorKind: SHARED_MACHINE_AUTHORITY_ACTOR_KIND.OWNER, authority: ownerAuthority }
      : { required: false, authority: null };
  }
  if (!sameIdentity(window.identity, identity)) return { required: true, authority: null };
  if (window.owner || window.participants.size > 1) return { required: true, authority: null };
  return { required: true, authority: window.authority };
}

/** The participant users that fed the session during the current window (empty for owner-only or no window). */
export function readProcessSharedMachineParticipants(sessionName: string): string[] {
  return [...(windows.get(sessionName)?.participants ?? [])];
}

export function clearProcessSharedMachineAuthoritiesForTests(): void {
  windows.clear();
  treeAuthorities.clear();
}
