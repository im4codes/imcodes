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

export interface TreeSessionActorBinding {
  kind: 'owner' | 'participant';
  actorUserId: string | null;
  authority: string | null;
}

export interface TreeAuthorityState {
  rootSessionName: string;
  generation: number;
  kind: 'owner' | 'participant' | 'mixed';
  actorUserId: string | null;
  authority: string | null;
  tokenHash: string | null;
  linkGeneration?: number;
  activeSessions: Set<string>;
  sessionActors: Map<string, TreeSessionActorBinding>;
  updatedAt: number;
}

let globalTreeGeneration = 0;
const treeAuthorities = new Map<string, TreeAuthorityState>();
export type TreeSessionActivityProbe = (sessionName: string) => boolean;
const treeActivityProbes = new Set<TreeSessionActivityProbe>();
const idleGuardTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function registerTreeSessionActivityProbe(probe: TreeSessionActivityProbe): () => void {
  treeActivityProbes.add(probe);
  return () => {
    treeActivityProbes.delete(probe);
  };
}

function clearIdleGuardTimer(sessionName: string): void {
  const existing = idleGuardTimers.get(sessionName);
  if (existing) {
    clearTimeout(existing);
    idleGuardTimers.delete(sessionName);
  }
}

function sendTurnAuthorityRevoke(
  rootSessionName: string,
  tokenHash: string,
  expectedLinkGeneration?: number,
): void {
  const link = getActiveServerLink();
  if (!link || (link.isConnected && !link.isConnected())) return;
  if (
    expectedLinkGeneration !== undefined
    && link.getConnectionGeneration
    && link.getConnectionGeneration() !== expectedLinkGeneration
  ) {
    return;
  }
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

function isSessionItselfActive(sessionName: string): boolean {
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
  return false;
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
    if (isSessionItselfActive(sessionName)) return true;
  }
  return false;
}

function maybeRevokeIdleTreeAuthority(
  rootSessionName: string,
  expectedTokenHash: string | null,
  expectedGeneration?: number,
): void {
  const entry = treeAuthorities.get(rootSessionName);
  if (!entry) return;
  if (expectedGeneration !== undefined && entry.generation !== expectedGeneration) return;
  if (entry.tokenHash !== expectedTokenHash) return;
  if (isAnyTreeSessionStillActive(rootSessionName, entry)) return;
  treeAuthorities.delete(rootSessionName);
  if (expectedTokenHash) {
    sendTurnAuthorityRevoke(rootSessionName, expectedTokenHash, entry.linkGeneration);
  }
}

function sameSessionActor(a: TreeSessionActorBinding, b: TreeSessionActorBinding): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'participant') {
    return a.actorUserId === b.actorUserId && a.authority === b.authority && !!a.actorUserId && !!a.authority;
  }
  return true;
}

function pruneInactiveOtherSessions(entry: TreeAuthorityState, currentSessionName: string): void {
  for (const sName of [...entry.sessionActors.keys()]) {
    if (sName === currentSessionName) continue;
    if (!entry.activeSessions.has(sName) && !isSessionItselfActive(sName)) {
      entry.sessionActors.delete(sName);
    }
  }
  for (const sName of [...entry.activeSessions]) {
    if (sName === currentSessionName) continue;
    // Keep explicitly marked activeSessions unless neither sessionActors nor probes indicate anything is possible;
    // explicit `markTreeSessionIdle` deletes them on completion/failure/error.
  }
}

function hasOtherActiveConflictingSession(
  entry: TreeAuthorityState,
  currentSessionName: string,
  incoming: TreeSessionActorBinding,
): boolean {
  for (const otherName of entry.activeSessions) {
    if (otherName === currentSessionName) continue;
    const otherActor = entry.sessionActors.get(otherName) ?? {
      kind: entry.kind === 'mixed' ? 'participant' : entry.kind,
      actorUserId: entry.actorUserId,
      authority: entry.authority,
    };
    if (!sameSessionActor(otherActor, incoming)) return true;
  }
  return false;
}

/**
 * Update or establish the unified in-memory grant for a session's root tree.
 * Returns the bound monotonic `generation` so the caller's turn can detect superseded or mixed trees.
 */
export function bindTreeTurnAuthority(
  sessionName: string,
  activity: SharedMachineActivity,
  opts: { now?: number; markActive?: boolean } = {},
): number {
  const now = opts.now ?? Date.now();
  const rootSessionName = resolveDaemonRootSessionName(sessionName);
  const existing = treeAuthorities.get(rootSessionName);
  const markActive = opts.markActive !== false;
  const currentLinkGeneration = getActiveServerLink()?.getConnectionGeneration?.();

  const normalizedIncoming: TreeSessionActorBinding = activity.kind === SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT
    ? {
        kind: 'participant',
        actorUserId: activity.actorUserId?.trim() || null,
        authority: typeof activity.authority === 'string' && activity.authority.trim()
          ? activity.authority.trim()
          : null,
      }
    : {
        kind: 'owner',
        actorUserId: null,
        authority: typeof activity.authority === 'string' && activity.authority.trim()
          ? activity.authority.trim()
          : null,
      };

  const incomingInvalidParticipant = normalizedIncoming.kind === 'participant'
    && (!normalizedIncoming.actorUserId || !normalizedIncoming.authority);

  if (existing) {
    pruneInactiveOtherSessions(existing, sessionName);
    const otherActiveExists = [...existing.activeSessions].some((name) => name !== sessionName);
    const sameTurnActor = !incomingInvalidParticipant
      && existing.kind === normalizedIncoming.kind
      && (normalizedIncoming.kind === 'owner'
        ? (!normalizedIncoming.authority || existing.authority === normalizedIncoming.authority)
        : (existing.actorUserId === normalizedIncoming.actorUserId && existing.authority === normalizedIncoming.authority));

    // Sticky mixed while other sessions (or current unfinished session in an already-mixed tree) remain active.
    const existingMixedSticky = existing.kind === 'mixed' && (otherActiveExists || existing.activeSessions.has(sessionName));
    const conflictsWithOther = otherActiveExists && hasOtherActiveConflictingSession(existing, sessionName, normalizedIncoming);

    if (incomingInvalidParticipant || existingMixedSticky || conflictsWithOther) {
      const priorTokenHash = existing.tokenHash;
      const priorLinkGen = existing.linkGeneration;
      const generation = ++globalTreeGeneration;
      const activeSessions = existing.activeSessions;
      if (markActive) activeSessions.add(sessionName);
      const sessionActors = existing.sessionActors;
      sessionActors.set(sessionName, normalizedIncoming);
      treeAuthorities.set(rootSessionName, {
        rootSessionName,
        generation,
        kind: 'mixed',
        actorUserId: normalizedIncoming.kind === 'participant' ? normalizedIncoming.actorUserId : existing.actorUserId,
        authority: null,
        tokenHash: null,
        linkGeneration: currentLinkGeneration,
        activeSessions,
        sessionActors,
        updatedAt: now,
      });
      if (priorTokenHash) {
        sendTurnAuthorityRevoke(rootSessionName, priorTokenHash, priorLinkGen);
      }
      return generation;
    }

    if (sameTurnActor) {
      if (markActive) existing.activeSessions.add(sessionName);
      existing.sessionActors.set(sessionName, normalizedIncoming);
      if (normalizedIncoming.authority && !existing.authority) {
        existing.authority = normalizedIncoming.authority;
        existing.tokenHash = sha256Hex(normalizedIncoming.authority);
        existing.linkGeneration = currentLinkGeneration;
      }
      existing.updatedAt = now;
      return existing.generation;
    }
  }

  const activeSessions = existing?.activeSessions ?? new Set<string>();
  const sessionActors = existing?.sessionActors ?? new Map<string, TreeSessionActorBinding>();
  if (markActive) activeSessions.add(sessionName);
  sessionActors.set(sessionName, normalizedIncoming);

  if (incomingInvalidParticipant) {
    const generation = ++globalTreeGeneration;
    treeAuthorities.set(rootSessionName, {
      rootSessionName,
      generation,
      kind: 'mixed',
      actorUserId: normalizedIncoming.actorUserId,
      authority: null,
      tokenHash: null,
      linkGeneration: currentLinkGeneration,
      activeSessions,
      sessionActors,
      updatedAt: now,
    });
    return generation;
  }

  if (normalizedIncoming.kind === 'participant') {
    const generation = ++globalTreeGeneration;
    treeAuthorities.set(rootSessionName, {
      rootSessionName,
      generation,
      kind: 'participant',
      actorUserId: normalizedIncoming.actorUserId,
      authority: normalizedIncoming.authority,
      tokenHash: sha256Hex(normalizedIncoming.authority!),
      linkGeneration: currentLinkGeneration,
      activeSessions,
      sessionActors,
      updatedAt: now,
    });
    return generation;
  }

  const generation = ++globalTreeGeneration;
  treeAuthorities.set(rootSessionName, {
    rootSessionName,
    generation,
    kind: 'owner',
    actorUserId: null,
    authority: normalizedIncoming.authority,
    tokenHash: normalizedIncoming.authority ? sha256Hex(normalizedIncoming.authority) : null,
    linkGeneration: currentLinkGeneration,
    activeSessions,
    sessionActors,
    updatedAt: now,
  });
  return generation;
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
  entry.sessionActors.delete(sessionName);
  entry.updatedAt = now;
  const expectedTokenHash = entry.tokenHash;
  const expectedGeneration = entry.generation;
  queueMicrotask(() => {
    maybeRevokeIdleTreeAuthority(rootSessionName, expectedTokenHash, expectedGeneration);
  });
}

/**
 * Clean up `target` from tree `activeSessions` ONLY if the session has no active local or queued work
 * (e.g. a failed/skipped task-pair dispatch). Keeps delivered or active turns bound until idle.
 */
export function markTreeSessionIdleIfInactive(sessionName: string, now = Date.now()): void {
  if (isSessionItselfActive(sessionName)) return;
  markTreeSessionIdle(sessionName, now);
}

export function readActiveTreeAuthorityForSession(
  sessionName: string,
): {
  kind: 'owner' | 'participant' | 'mixed';
  actorUserId: string | null;
  authority: string | null;
  rootSessionName: string;
  generation: number;
} | null {
  const rootSessionName = resolveDaemonRootSessionName(sessionName);
  const entry = treeAuthorities.get(rootSessionName);
  if (!entry) return null;
  return {
    kind: entry.kind,
    actorUserId: entry.actorUserId,
    authority: entry.authority,
    rootSessionName: entry.rootSessionName,
    generation: entry.generation,
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
  treeGeneration: number | null;
  activityEpoch: number;
  lastActivityAt: number;
  turns: number;
  undelivered: number;
};

const windows = new Map<string, Window>();

export const PROCESS_SHARED_MACHINE_WINDOW_QUIET_MS = 10 * 60 * 1000;

function sameIdentity(a: RuntimeIdentity | null, b: RuntimeIdentity | null): boolean {
  return !!a && !!b && a.sessionInstanceId === b.sessionInstanceId && a.runtimeEpoch === b.runtimeEpoch;
}

function quietAndIdle(window: Window, now: number, sessionRunning: boolean): boolean {
  return !sessionRunning && now - window.lastActivityAt >= PROCESS_SHARED_MACHINE_WINDOW_QUIET_MS;
}

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
    startsTurn?: boolean;
  } = {},
): ProcessSharedMachineBinding {
  const now = opts.now ?? Date.now();
  clearIdleGuardTimer(sessionName);
  let window = windows.get(sessionName);
  if (window && window.identity && identity && !sameIdentity(window.identity, identity)) window = undefined;
  if (window && quietAndIdle(window, now, opts.sessionRunning ?? false)) window = undefined;
  if (!window) {
    window = {
      identity,
      owner: false,
      participants: new Set(),
      authority: null,
      ownerAuthority: null,
      treeGeneration: null,
      activityEpoch: 0,
      lastActivityAt: now,
      turns: opts.sessionRunning ? 1 : 0,
      undelivered: 0,
    };
    windows.set(sessionName, window);
  }
  window.lastActivityAt = now;
  window.activityEpoch += 1;
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
    if (activity.authority) window.authority = activity.authority;
  }
  const hasConflictInWindow = window.participants.size > 0 && (window.owner || window.participants.size > 1 || !window.authority);
  if (startsTurn || activity.authority || hasConflictInWindow) {
    const treeActivity: SharedMachineActivity = hasConflictInWindow
      ? { kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT, actorUserId: '' }
      : activity;
    window.treeGeneration = bindTreeTurnAuthority(sessionName, treeActivity, { now, markActive: startsTurn || hasConflictInWindow });
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
      bound.lastActivityAt = at;
      bound.activityEpoch += 1;
      clearIdleGuardTimer(sessionName);
    },
    settle() {
      if (!pending) return;
      pending = false;
      if (windows.get(sessionName) !== bound || bound.undelivered <= 0) return;
      bound.undelivered -= 1;
      bound.turns = Math.max(0, bound.turns - 1);
      if (bound.turns === 0) {
        clearIdleGuardTimer(sessionName);
        if (windows.get(sessionName) === bound) windows.delete(sessionName);
        markTreeSessionIdleIfInactive(sessionName);
      }
    },
  };
}

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
  const startsTurn = cmd.type === DAEMON_COMMAND_TYPES.SESSION_INPUT
    ? typeof cmd.data === 'string' && /[\r\n]/.test(cmd.data)
    : true;
  return bindProcessSharedMachineActivity(sessionName, identity, activity, {
    startsTurn,
    sessionRunning: record?.state === 'running',
    ...(now === undefined ? {} : { now }),
  });
}

export const PROCESS_SHARED_MACHINE_IDLE_GUARD_MS = 1_500;

export function releaseProcessSharedMachineAuthority(sessionName: string, now = Date.now()): void {
  const window = windows.get(sessionName);
  if (window) {
    const elapsed = now - window.lastActivityAt;
    if (elapsed < PROCESS_SHARED_MACHINE_IDLE_GUARD_MS) {
      clearIdleGuardTimer(sessionName);
      const expectedEpoch = window.activityEpoch;
      const delayMs = Math.max(1, PROCESS_SHARED_MACHINE_IDLE_GUARD_MS - elapsed + 5);
      const timer = setTimeout(() => {
        idleGuardTimers.delete(sessionName);
        const live = windows.get(sessionName);
        if (!live || live !== window || live.activityEpoch !== expectedEpoch) return;
        if (getSession(sessionName)?.state === 'running') return;
        releaseProcessSharedMachineAuthority(sessionName, Date.now());
      }, delayMs);
      timer.unref?.();
      idleGuardTimers.set(sessionName, timer);
      return;
    }
    if (window.undelivered > 0 && window.turns - window.undelivered <= 0) return;
    if (window.turns > 1) {
      window.turns -= 1;
      window.owner = false;
      if (window.participants.size > 0) window.ownerAuthority = null;
      window.lastActivityAt = now;
      window.activityEpoch += 1;
      clearIdleGuardTimer(sessionName);
      return;
    }
    clearIdleGuardTimer(sessionName);
    windows.delete(sessionName);
  }
  markTreeSessionIdle(sessionName, now);
}

/**
 * Scrub all pure-RAM turn grants and tree authorities on ServerLink disconnect.
 * Active participant contexts keep their participant provenance with `authority = null`
 * (fail closed) until their turns finish so in-flight turns cannot downgrade to owner.
 */
export function clearAllDaemonTurnAuthoritiesOnDisconnect(hooks?: {
  scrubTransportRuntimes?: () => void;
  scrubResendQueues?: () => void;
  clearTaskPairAuthorities?: () => void;
}): void {
  for (const timer of idleGuardTimers.values()) clearTimeout(timer);
  idleGuardTimers.clear();

  for (const [sessionName, window] of [...windows.entries()]) {
    if (window.participants.size > 0 && (window.turns > 0 || getSession(sessionName)?.state === 'running')) {
      window.authority = null;
      window.ownerAuthority = null;
      window.treeGeneration = null;
    } else {
      windows.delete(sessionName);
    }
  }

  for (const [rootSessionName, entry] of [...treeAuthorities.entries()]) {
    if (entry.kind === 'owner' || !isAnyTreeSessionStillActive(rootSessionName, entry)) {
      treeAuthorities.delete(rootSessionName);
    } else {
      entry.authority = null;
      entry.tokenHash = null;
      entry.linkGeneration = undefined;
    }
  }

  hooks?.scrubTransportRuntimes?.();
  hooks?.scrubResendQueues?.();
  hooks?.clearTaskPairAuthorities?.();
}

export interface CanonicalRuntimeAuthorityAdapter {
  sending?: boolean;
  activeDispatchEntries?: ReadonlyArray<{ sharedActor?: { effectiveActorRole?: string; actorUserId?: string } }>;
  requiresSharedMachineAuthority?: () => boolean;
  getActiveSharedMachineAuthority?: () => string | null;
  getActiveOwnerMachineAuthority?: () => string | null;
  activeTurnParticipantUserIds?: () => string[];
  getActiveTreeGeneration?: () => number | null;
}

export interface CanonicalTurnAuthorityResolution {
  required: boolean;
  isParticipantScoped: boolean;
  actorKind?: SharedMachineAuthorityActorKind;
  actorUserId: string | null;
  authority: string | null;
}

export const AMBIGUOUS_TREE_PARTICIPANT_ACTOR = 'participant';

type LocalTurnAuthorityView =
  | { state: 'none' }
  | { state: 'mixed'; actorUserId: string }
  | {
      state: 'participant';
      actorUserId: string | null;
      authority: string | null;
      treeGeneration: number | null;
    }
  | {
      state: 'owner';
      authority: string | null;
      treeGeneration: number | null;
    };

function readLocalTurnAuthorityView(input: {
  sessionName: string;
  identity: RuntimeIdentity | null;
  sessionRunning: boolean;
  now: number;
  runtime?: CanonicalRuntimeAuthorityAdapter | null;
}): LocalTurnAuthorityView {
  if (input.runtime) {
    const rt = input.runtime;
    const localRequired = rt.requiresSharedMachineAuthority?.() === true;
    const localSharedAuth = rt.getActiveSharedMachineAuthority?.() ?? null;
    const localOwnerAuth = rt.getActiveOwnerMachineAuthority?.() ?? null;
    const localTreeGen = rt.getActiveTreeGeneration?.() ?? null;
    const hasDispatchEntries = (rt.activeDispatchEntries?.length ?? 0) > 0;
    const actors = rt.activeTurnParticipantUserIds?.()
      ?? (rt.activeDispatchEntries ?? [])
        .filter((entry) => entry.sharedActor?.effectiveActorRole === 'participant')
        .map((entry) => entry.sharedActor?.actorUserId ?? '')
        .filter((id) => id.length > 0);
    const singleActor = actors.length === 1 ? actors[0]! : null;

    if (localRequired) {
      if (!localSharedAuth || actors.length > 1) {
        return { state: 'mixed', actorUserId: singleActor ?? AMBIGUOUS_TREE_PARTICIPANT_ACTOR };
      }
      return {
        state: 'participant',
        actorUserId: singleActor,
        authority: localSharedAuth,
        treeGeneration: localTreeGen,
      };
    }

    if (localOwnerAuth || hasDispatchEntries || rt.sending) {
      return {
        state: 'owner',
        authority: localOwnerAuth,
        treeGeneration: localTreeGen,
      };
    }
    return { state: 'none' };
  }

  const window = windows.get(input.sessionName);
  if (!window) return { state: 'none' };
  if (quietAndIdle(window, input.now, input.sessionRunning)) {
    clearIdleGuardTimer(input.sessionName);
    windows.delete(input.sessionName);
    return { state: 'none' };
  }
  if (!sameIdentity(window.identity, input.identity)) {
    if (window.participants.size > 0) {
      const actors = [...window.participants];
      return { state: 'mixed', actorUserId: actors.length === 1 ? actors[0]! : AMBIGUOUS_TREE_PARTICIPANT_ACTOR };
    }
    return { state: 'none' };
  }
  if (window.participants.size > 0) {
    const actors = [...window.participants];
    const singleActor = actors.length === 1 ? actors[0]! : AMBIGUOUS_TREE_PARTICIPANT_ACTOR;
    if (window.owner || window.participants.size > 1 || !window.authority) {
      return { state: 'mixed', actorUserId: singleActor };
    }
    return {
      state: 'participant',
      actorUserId: singleActor,
      authority: window.authority,
      treeGeneration: window.treeGeneration,
    };
  }
  if (window.owner || window.ownerAuthority) {
    return {
      state: 'owner',
      authority: window.ownerAuthority,
      treeGeneration: window.treeGeneration,
    };
  }
  return { state: 'none' };
}

/**
 * Single canonical authority resolver used by hook resolution, agent-to-agent participant/owner
 * stamping, and task-pair delivery. Cross-checks `(local, tree, treeGeneration)` and fails
 * closed on any actor, kind, token, or generation conflict.
 */
export function resolveCanonicalTurnAuthority(input: {
  sessionName: string;
  identity: RuntimeIdentity | null;
  sessionRunning?: boolean;
  now?: number;
  runtime?: CanonicalRuntimeAuthorityAdapter | null;
}): CanonicalTurnAuthorityResolution {
  const now = input.now ?? Date.now();
  const sessionRunning = input.sessionRunning ?? false;
  const local = readLocalTurnAuthorityView({
    sessionName: input.sessionName,
    identity: input.identity,
    sessionRunning,
    now,
    runtime: input.runtime,
  });

  if (local.state === 'mixed') {
    return {
      required: true,
      isParticipantScoped: true,
      actorUserId: local.actorUserId,
      authority: null,
    };
  }

  const tree = readActiveTreeAuthorityForSession(input.sessionName);
  if (tree) {
    if (tree.kind === 'mixed' || (tree.kind === 'participant' && !tree.authority)) {
      return {
        required: true,
        isParticipantScoped: true,
        actorUserId: tree.actorUserId ?? (local.state === 'participant' ? local.actorUserId : null) ?? AMBIGUOUS_TREE_PARTICIPANT_ACTOR,
        authority: null,
      };
    }

    if (local.state === 'participant') {
      if (tree.kind !== 'participant') {
        return {
          required: true,
          isParticipantScoped: true,
          actorUserId: local.actorUserId ?? AMBIGUOUS_TREE_PARTICIPANT_ACTOR,
          authority: null,
        };
      }
      if (local.actorUserId && tree.actorUserId && local.actorUserId !== tree.actorUserId) {
        return {
          required: true,
          isParticipantScoped: true,
          actorUserId: AMBIGUOUS_TREE_PARTICIPANT_ACTOR,
          authority: null,
        };
      }
      if (local.authority && tree.authority && local.authority !== tree.authority) {
        return {
          required: true,
          isParticipantScoped: true,
          actorUserId: AMBIGUOUS_TREE_PARTICIPANT_ACTOR,
          authority: null,
        };
      }
      if (local.treeGeneration !== null && local.treeGeneration !== tree.generation) {
        return {
          required: true,
          isParticipantScoped: true,
          actorUserId: AMBIGUOUS_TREE_PARTICIPANT_ACTOR,
          authority: null,
        };
      }
      return {
        required: true,
        isParticipantScoped: true,
        actorKind: SHARED_MACHINE_AUTHORITY_ACTOR_KIND.PARTICIPANT,
        actorUserId: tree.actorUserId ?? local.actorUserId ?? AMBIGUOUS_TREE_PARTICIPANT_ACTOR,
        authority: tree.authority,
      };
    }

    if (local.state === 'owner') {
      if (tree.kind === 'participant') {
        return {
          required: true,
          isParticipantScoped: true,
          actorUserId: tree.actorUserId ?? AMBIGUOUS_TREE_PARTICIPANT_ACTOR,
          authority: null,
        };
      }
      if (local.treeGeneration !== null && local.treeGeneration !== tree.generation) {
        return {
          required: false,
          isParticipantScoped: false,
          actorUserId: null,
          authority: null,
        };
      }
      if (local.authority && tree.authority && local.authority !== tree.authority) {
        return {
          required: false,
          isParticipantScoped: false,
          actorUserId: null,
          authority: null,
        };
      }
      return tree.authority
        ? {
            required: false,
            isParticipantScoped: false,
            actorKind: SHARED_MACHINE_AUTHORITY_ACTOR_KIND.OWNER,
            actorUserId: null,
            authority: tree.authority,
          }
        : { required: false, isParticipantScoped: false, actorUserId: null, authority: null };
    }

    // No active local turn on this session: inherit active tree grant.
    if (tree.kind === 'participant') {
      return {
        required: true,
        isParticipantScoped: true,
        actorKind: SHARED_MACHINE_AUTHORITY_ACTOR_KIND.PARTICIPANT,
        actorUserId: tree.actorUserId ?? AMBIGUOUS_TREE_PARTICIPANT_ACTOR,
        authority: tree.authority,
      };
    }
    return tree.authority
      ? {
          required: false,
          isParticipantScoped: false,
          actorKind: SHARED_MACHINE_AUTHORITY_ACTOR_KIND.OWNER,
          actorUserId: null,
          authority: tree.authority,
        }
      : { required: false, isParticipantScoped: false, actorUserId: null, authority: null };
  }

  if (local.state === 'participant') {
    return {
      required: true,
      isParticipantScoped: true,
      actorKind: SHARED_MACHINE_AUTHORITY_ACTOR_KIND.PARTICIPANT,
      actorUserId: local.actorUserId ?? AMBIGUOUS_TREE_PARTICIPANT_ACTOR,
      authority: local.authority,
    };
  }
  if (local.state === 'owner' && local.authority) {
    return {
      required: false,
      isParticipantScoped: false,
      actorKind: SHARED_MACHINE_AUTHORITY_ACTOR_KIND.OWNER,
      actorUserId: null,
      authority: local.authority,
    };
  }
  return { required: false, isParticipantScoped: false, actorUserId: null, authority: null };
}

export function resolveSessionEffectiveSharedMachineAuthority(input: {
  sessionName: string;
  identity: RuntimeIdentity;
  sessionRunning?: boolean;
  now?: number;
  runtime?: CanonicalRuntimeAuthorityAdapter | null;
}): { required: boolean; actorKind?: SharedMachineAuthorityActorKind; authority: string | null } {
  const resolved = resolveCanonicalTurnAuthority({
    sessionName: input.sessionName,
    identity: input.identity,
    sessionRunning: input.sessionRunning,
    now: input.now,
    runtime: input.runtime,
  });
  return {
    required: resolved.required,
    ...(resolved.actorKind ? { actorKind: resolved.actorKind } : {}),
    authority: resolved.authority,
  };
}

export function readProcessSharedMachineAuthority(
  sessionName: string,
  identity: RuntimeIdentity,
  now = Date.now(),
  sessionRunning = false,
): { required: boolean; actorKind?: SharedMachineAuthorityActorKind; authority: string | null } {
  const local = readLocalTurnAuthorityView({ sessionName, identity, sessionRunning, now });
  if (local.state === 'mixed') return { required: true, authority: null };
  if (local.state === 'participant') {
    return {
      required: true,
      authority: local.authority,
    };
  }
  if (local.state === 'owner' && local.authority) {
    return { required: false, actorKind: SHARED_MACHINE_AUTHORITY_ACTOR_KIND.OWNER, authority: local.authority };
  }
  return { required: false, authority: null };
}

/** The participant users that fed the session during the current window (empty for owner-only or no window). */
export function readProcessSharedMachineParticipants(sessionName: string): string[] {
  return [...(windows.get(sessionName)?.participants ?? [])];
}

export function clearProcessSharedMachineAuthoritiesForTests(): void {
  for (const timer of idleGuardTimers.values()) clearTimeout(timer);
  idleGuardTimers.clear();
  windows.clear();
  treeAuthorities.clear();
}
