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
import { scrubLoadedTransportQueueMemoryAuthorities } from './transport-queue-store.js';

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
}

const MAX_SUPERSEDED_HASHES_PER_TREE = 64;

function recordSupersededHash(set: Set<string>, tokenHash: string | null | undefined): void {
  if (!tokenHash) return;
  if (set.has(tokenHash)) {
    set.delete(tokenHash);
  } else if (set.size >= MAX_SUPERSEDED_HASHES_PER_TREE) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(tokenHash);
}

export interface TreeAuthorityState {
  rootSessionName: string;
  generation: number;
  kind: 'owner' | 'participant' | 'mixed';
  actorUserId: string | null;
  authority: string | null;
  tokenHash: string | null;
  tokenIssueSeq: number;
  linkGeneration?: number;
  activeSessions: Set<string>;
  sessionActors: Map<string, TreeSessionActorBinding>;
  supersededTokenHashes: Set<string>;
  pendingRevokeHashes: Map<string, number | undefined>;
  updatedAt: number;
}

let globalTreeGeneration = 0;
let globalActivityEpoch = 0;
let globalTurnAuthorityIssueSeq = 0;
let globalTurnAuthorityDisconnectGeneration = 0;
const treeAuthorities = new Map<string, TreeAuthorityState>();
/**
 * Pure-RAM connection-generation-scoped revoke outbox that survives `treeAuthorities.delete`
 * and local disconnect security scrubs while the failed link generation remains active.
 */
const pendingIdleRevokeHashes = new Map<string, { rootSessionName: string; linkGeneration: number | undefined }>();
export type TreeSessionActivityProbe = (sessionName: string) => boolean;
const treeActivityProbes = new Set<TreeSessionActivityProbe>();
const idleGuardTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function allocateTurnAuthorityIssueSeq(): number {
  return ++globalTurnAuthorityIssueSeq;
}

export function getTurnAuthorityDisconnectGeneration(): number {
  return globalTurnAuthorityDisconnectGeneration;
}

function recordIdleRevokeFallback(
  rootSessionName: string,
  hash: string | null | undefined,
  linkGeneration: number | undefined,
): void {
  if (!hash) return;
  pendingIdleRevokeHashes.set(hash, { rootSessionName, linkGeneration });
}

function flushRetainedIdleRevokes(): void {
  if (pendingIdleRevokeHashes.size === 0) return;
  const link = getActiveServerLink();
  const currentLinkGeneration = link?.getConnectionGeneration?.();
  let needsForceReconnect = false;
  for (const [hash, item] of [...pendingIdleRevokeHashes.entries()]) {
    if (
      item.linkGeneration !== undefined
      && currentLinkGeneration !== undefined
      && item.linkGeneration !== currentLinkGeneration
    ) {
      pendingIdleRevokeHashes.delete(hash);
      continue;
    }
    if (sendTurnAuthorityRevoke(item.rootSessionName, hash, item.linkGeneration)) {
      pendingIdleRevokeHashes.delete(hash);
    } else if (link && (!link.isConnected || link.isConnected())) {
      needsForceReconnect = true;
    }
  }
  if (needsForceReconnect && link?.forceReconnect) {
    try {
      link.forceReconnect('turn_authority_revoke_send_failed');
    } catch {
      // Retain hashes in pure RAM until send succeeds or link generation advances.
    }
  }
}

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
): boolean {
  const link = getActiveServerLink();
  if (!link || (link.isConnected && !link.isConnected())) return false;
  if (
    expectedLinkGeneration !== undefined
    && link.getConnectionGeneration
    && link.getConnectionGeneration() !== expectedLinkGeneration
  ) {
    return false;
  }
  try {
    const frame = {
      type: DAEMON_MSG.TURN_AUTHORITY_REVOKE,
      rootSessionName,
      tokenHash,
    };
    if (link.trySend) return link.trySend(frame) !== false;
    link.send(frame);
    return true;
  } catch {
    // Socket unavailable: server WS disconnect handler sweeps all grants for this serverId.
    return false;
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
  const queued = new Set<string>();
  if (expectedTokenHash) {
    queued.add(expectedTokenHash);
    recordIdleRevokeFallback(rootSessionName, expectedTokenHash, entry.linkGeneration);
  }
  for (const [hash, linkGen] of entry.pendingRevokeHashes) {
    if (queued.has(hash)) continue;
    queued.add(hash);
    recordIdleRevokeFallback(rootSessionName, hash, linkGen);
  }
  flushRetainedIdleRevokes();
}

export interface SdkTurnOriginInput {
  sharedActor?: { effectiveActorRole?: string; actorUserId?: string };
  sharedMachineAuthority?: string;
  ownerMachineAuthority?: string;
  authorityIssueSeq?: number;
}

export interface SdkTurnOriginSummary {
  state: 'none' | 'owner' | 'participant' | 'mixed';
  actorUserId: string | null;
  authority: string | null;
  authorityIssueSeq: number | null;
  /**
   * Non-callable SHA-256 hashes of every valid token in `origins` that is not the active authority:
   * - when `state === 'mixed'`: all valid tokens across conflicting/unstamped entries so every one is revoked;
   * - when single-sender multiple-turn merge: earlier superseded tokens replaced by the latest token.
   */
  revokeTokenHashes: string[];
}

function selectLatestIssuedOrigin(
  origins: ReadonlyArray<SdkTurnOriginInput>,
  readToken: (entry: SdkTurnOriginInput) => string | undefined,
): { authority: string | null; authorityIssueSeq: number | null } {
  let bestToken: string | null = null;
  let bestSeq: number | undefined;
  for (const entry of origins) {
    const raw = readToken(entry);
    const trimmed = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    if (!trimmed) continue;
    const seq = typeof entry.authorityIssueSeq === 'number' ? entry.authorityIssueSeq : undefined;
    const shouldReplace = bestToken === null
      || (seq !== undefined && bestSeq !== undefined && seq >= bestSeq)
      || (seq !== undefined && bestSeq === undefined)
      || (seq === undefined && bestSeq === undefined);
    if (shouldReplace) {
      bestToken = trimmed;
      if (seq !== undefined) bestSeq = seq;
    }
  }
  return {
    authority: bestToken,
    authorityIssueSeq: bestSeq ?? null,
  };
}

/**
 * Shared origin summarizer used by both `onTurnAdmitted` (session-manager) and canonical
 * local runtime reading (`transport-session-runtime` / `readLocalTurnAuthorityView`).
 */
export function summarizeSdkTurnOrigins(origins: ReadonlyArray<SdkTurnOriginInput>): SdkTurnOriginSummary {
  if (origins.length === 0) {
    return { state: 'none', actorUserId: null, authority: null, authorityIssueSeq: null, revokeTokenHashes: [] };
  }

  const allTokenHashes: string[] = [];
  const seenHashes = new Set<string>();
  const addTokenHash = (token: string | undefined | null) => {
    const trimmed = typeof token === 'string' ? token.trim() : '';
    if (!trimmed) return;
    const hash = sha256Hex(trimmed);
    if (!seenHashes.has(hash)) {
      seenHashes.add(hash);
      allTokenHashes.push(hash);
    }
  };
  for (const entry of origins) {
    addTokenHash(entry.sharedMachineAuthority);
    addTokenHash(entry.ownerMachineAuthority);
  }

  const hasParticipant = origins.some((entry) => entry.sharedActor?.effectiveActorRole === 'participant');
  if (hasParticipant) {
    const actors = [...new Set(
      origins
        .filter((entry) => entry.sharedActor?.effectiveActorRole === 'participant')
        .map((entry) => entry.sharedActor?.actorUserId?.trim() ?? '')
        .filter(Boolean),
    )];
    const hasOwnerEntry = origins.some((entry) => entry.sharedActor?.effectiveActorRole !== 'participant');
    const allEntriesValidParticipant = origins.every(
      (entry) => entry.sharedActor?.effectiveActorRole === 'participant'
        && Boolean(entry.sharedActor.actorUserId?.trim())
        && Boolean(entry.sharedMachineAuthority?.trim()),
    );
    if (!hasOwnerEntry && actors.length === 1 && allEntriesValidParticipant) {
      const selected = selectLatestIssuedOrigin(origins, (entry) => entry.sharedMachineAuthority);
      const liveHash = selected.authority ? sha256Hex(selected.authority) : null;
      return {
        state: 'participant',
        actorUserId: actors[0]!,
        authority: selected.authority,
        authorityIssueSeq: selected.authorityIssueSeq,
        revokeTokenHashes: allTokenHashes.filter((hash) => hash !== liveHash),
      };
    }
    return {
      state: 'mixed',
      actorUserId: actors.length === 1 ? actors[0]! : AMBIGUOUS_TREE_PARTICIPANT_ACTOR,
      authority: null,
      authorityIssueSeq: null,
      revokeTokenHashes: allTokenHashes,
    };
  }

  const allHaveOwnerToken = origins.every(
    (entry) => typeof entry.ownerMachineAuthority === 'string' && entry.ownerMachineAuthority.trim().length > 0,
  );
  const selectedOwner = allHaveOwnerToken
    ? selectLatestIssuedOrigin(origins, (entry) => entry.ownerMachineAuthority)
    : { authority: null, authorityIssueSeq: null };
  const liveHash = selectedOwner.authority ? sha256Hex(selectedOwner.authority) : null;
  return {
    state: 'owner',
    actorUserId: null,
    authority: selectedOwner.authority,
    authorityIssueSeq: selectedOwner.authorityIssueSeq,
    revokeTokenHashes: allTokenHashes.filter((hash) => hash !== liveHash),
  };
}

/**
 * Production `onTurnAdmitted` handler binding summarized SDK turn origins into
 * `treeAuthorities`, advancing same-sender tokens and revoking all conflicting hashes.
 */
export function bindSdkTurnOriginsAuthority(
  sessionName: string,
  origins: ReadonlyArray<SdkTurnOriginInput>,
  opts: { now?: number } = {},
): number | null {
  const summary = summarizeSdkTurnOrigins(origins);
  if (summary.state === 'none') return null;
  if (summary.state === 'mixed') {
    return bindTreeTurnAuthority(sessionName, {
      kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT,
      actorUserId: summary.actorUserId === AMBIGUOUS_TREE_PARTICIPANT_ACTOR ? '' : (summary.actorUserId ?? ''),
    }, {
      ...opts,
      markActive: true,
      conflict: true,
      conflictRevokeHashes: summary.revokeTokenHashes,
    });
  }
  if (summary.state === 'participant') {
    return bindTreeTurnAuthority(sessionName, {
      kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT,
      actorUserId: summary.actorUserId ?? '',
      ...(summary.authority ? { authority: summary.authority } : {}),
    }, {
      ...opts,
      markActive: true,
      ...(summary.authorityIssueSeq !== null ? { issueSeq: summary.authorityIssueSeq } : {}),
      ...(summary.revokeTokenHashes.length > 0 ? { supersededHashes: summary.revokeTokenHashes } : {}),
    });
  }
  return bindTreeTurnAuthority(sessionName, {
    kind: SHARED_MACHINE_ACTIVITY_KIND.OWNER,
    ...(summary.authority ? { authority: summary.authority } : {}),
  }, {
    ...opts,
    markActive: true,
    ...(summary.authorityIssueSeq !== null ? { issueSeq: summary.authorityIssueSeq } : {}),
    ...(summary.revokeTokenHashes.length > 0 ? { supersededHashes: summary.revokeTokenHashes } : {}),
  });
}

function sameStableSender(
  a: { kind: 'owner' | 'participant' | 'mixed'; actorUserId: string | null },
  b: { kind: 'owner' | 'participant' | 'mixed'; actorUserId: string | null },
): boolean {
  if (a.kind === 'mixed' || b.kind === 'mixed') return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'participant') {
    return a.actorUserId === b.actorUserId && !!a.actorUserId;
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
    };
    if (!sameStableSender(otherActor, incoming)) return true;
  }
  return false;
}

function flushConflictRevokeHashes(
  rootSessionName: string,
  supersededTokenHashes: Set<string>,
  pendingRevokeHashes: Map<string, number | undefined>,
  currentLinkGeneration: number | undefined,
  extraHashes: ReadonlyArray<[string | null | undefined, number | undefined]>,
): void {
  const link = getActiveServerLink();
  for (const [hash, linkGen] of extraHashes) {
    if (!hash) continue;
    recordSupersededHash(supersededTokenHashes, hash);
    pendingRevokeHashes.set(hash, linkGen);
  }
  let needsForceReconnect = false;
  for (const [hash, linkGen] of [...pendingRevokeHashes.entries()]) {
    if (
      linkGen !== undefined
      && currentLinkGeneration !== undefined
      && linkGen !== currentLinkGeneration
    ) {
      // Previous WS connection generation already disconnected and wiped all grants on the server.
      pendingRevokeHashes.delete(hash);
      continue;
    }
    if (sendTurnAuthorityRevoke(rootSessionName, hash, linkGen)) {
      pendingRevokeHashes.delete(hash);
    } else if (link && (!link.isConnected || link.isConnected())) {
      needsForceReconnect = true;
    }
  }
  if (needsForceReconnect && link?.forceReconnect) {
    try {
      link.forceReconnect('turn_authority_revoke_send_failed');
    } catch {
      // Pending hashes stay in RAM for retry on the same link generation.
    }
  }
}

/**
 * Update or establish the unified in-memory grant for a session's root tree.
 * Separating stable sender identity from replaceable turn tokens lets the same
 * sender (`O` or `P1`) start follow-up turns across active sessions in one tree
 * while immediately replacing the tree token and fencing stale callbacks.
 */
export function bindTreeTurnAuthority(
  sessionName: string,
  activity: SharedMachineActivity,
  opts: {
    now?: number;
    markActive?: boolean;
    conflict?: boolean;
    conflictRevokeHashes?: ReadonlyArray<string>;
    supersededHashes?: ReadonlyArray<string>;
    issueSeq?: number;
  } = {},
): number {
  const now = opts.now ?? Date.now();
  const rootSessionName = resolveDaemonRootSessionName(sessionName);
  flushRetainedIdleRevokes();
  const existing = treeAuthorities.get(rootSessionName);
  const markActive = opts.markActive !== false;
  const currentLinkGeneration = getActiveServerLink()?.getConnectionGeneration?.();

  const incomingAuthority = typeof activity.authority === 'string' && activity.authority.trim()
    ? activity.authority.trim()
    : null;
  const incomingIssueSeq = typeof opts.issueSeq === 'number'
    ? opts.issueSeq
    : (incomingAuthority && opts.conflict !== true ? allocateTurnAuthorityIssueSeq() : 0);
  const normalizedIncoming: TreeSessionActorBinding = activity.kind === SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT
    ? {
        kind: 'participant',
        actorUserId: activity.actorUserId?.trim() || null,
      }
    : {
        kind: 'owner',
        actorUserId: null,
      };

  const incomingHash = incomingAuthority ? sha256Hex(incomingAuthority) : null;
  const incomingInvalidParticipant = normalizedIncoming.kind === 'participant'
    && (!normalizedIncoming.actorUserId || !incomingAuthority);
  const explicitConflict = opts.conflict === true;
  const conflictHashesFromOpts = (opts.conflictRevokeHashes ?? [])
    .map((hash) => [hash, currentLinkGeneration] as [string, number | undefined]);

  if (existing) {
    pruneInactiveOtherSessions(existing, sessionName);
    if (opts.supersededHashes?.length) {
      for (const hash of opts.supersededHashes) {
        recordSupersededHash(existing.supersededTokenHashes, hash);
      }
    }
    const otherActiveExists = [...existing.activeSessions].some((name) => name !== sessionName);
    const sameSenderAsTree = !explicitConflict
      && existing.kind !== 'mixed'
      && sameStableSender(existing, normalizedIncoming);
    const currentActorOnSameSession = existing.activeSessions.has(sessionName)
      ? existing.sessionActors.get(sessionName)
      : undefined;
    const sameSessionConflict = Boolean(
      currentActorOnSameSession
      && !sameStableSender(currentActorOnSameSession, normalizedIncoming),
    );
    const existingMixedSticky = existing.kind === 'mixed' && (otherActiveExists || existing.activeSessions.has(sessionName));
    const conflictsWithOther = otherActiveExists && hasOtherActiveConflictingSession(existing, sessionName, normalizedIncoming);

    if (explicitConflict || incomingInvalidParticipant || existingMixedSticky || conflictsWithOther || sameSessionConflict) {
      const generation = ++globalTreeGeneration;
      const activeSessions = existing.activeSessions;
      if (markActive) activeSessions.add(sessionName);
      const sessionActors = existing.sessionActors;
      sessionActors.set(sessionName, normalizedIncoming);
      flushConflictRevokeHashes(
        rootSessionName,
        existing.supersededTokenHashes,
        existing.pendingRevokeHashes,
        currentLinkGeneration,
        [
          [existing.tokenHash, existing.linkGeneration],
          [incomingHash, currentLinkGeneration],
          ...conflictHashesFromOpts,
        ],
      );
      treeAuthorities.set(rootSessionName, {
        rootSessionName,
        generation,
        kind: 'mixed',
        actorUserId: normalizedIncoming.kind === 'participant' ? normalizedIncoming.actorUserId : existing.actorUserId,
        authority: null,
        tokenHash: null,
        tokenIssueSeq: Math.max(existing.tokenIssueSeq, incomingIssueSeq),
        linkGeneration: currentLinkGeneration,
        activeSessions,
        sessionActors,
        supersededTokenHashes: existing.supersededTokenHashes,
        pendingRevokeHashes: existing.pendingRevokeHashes,
        updatedAt: now,
      });
      return generation;
    }

    if (incomingHash && existing.supersededTokenHashes.has(incomingHash)) {
      if (sameSenderAsTree && markActive) {
        existing.activeSessions.add(sessionName);
      }
      return existing.generation;
    }

    if (sameSenderAsTree) {
      if (markActive) existing.activeSessions.add(sessionName);
      if (incomingHash && incomingHash !== existing.tokenHash) {
        if (existing.tokenHash && incomingIssueSeq < existing.tokenIssueSeq) {
          // Out-of-order delayed admission (e.g. an older SDK active-turn append completing AFTER
          // another sub-session already advanced the tree to a newer token) must NEVER regress the tree.
          recordSupersededHash(existing.supersededTokenHashes, incomingHash);
          existing.sessionActors.set(sessionName, {
            kind: existing.kind === 'participant' ? 'participant' : 'owner',
            actorUserId: existing.actorUserId,
          });
          existing.updatedAt = now;
          return existing.generation;
        }
        recordSupersededHash(existing.supersededTokenHashes, existing.tokenHash);
        existing.generation = ++globalTreeGeneration;
        existing.authority = incomingAuthority;
        existing.tokenHash = incomingHash;
        existing.tokenIssueSeq = incomingIssueSeq;
        existing.linkGeneration = currentLinkGeneration;
      } else if (incomingAuthority && !existing.authority) {
        existing.authority = incomingAuthority;
        existing.tokenHash = incomingHash;
        existing.tokenIssueSeq = incomingIssueSeq;
        existing.linkGeneration = currentLinkGeneration;
      }
      existing.sessionActors.set(sessionName, normalizedIncoming);
      if (existing.pendingRevokeHashes.size > 0) {
        flushConflictRevokeHashes(
          rootSessionName,
          existing.supersededTokenHashes,
          existing.pendingRevokeHashes,
          currentLinkGeneration,
          [],
        );
      }
      existing.updatedAt = now;
      return existing.generation;
    }
  }

  const activeSessions = existing?.activeSessions ?? new Set<string>();
  const sessionActors = existing?.sessionActors ?? new Map<string, TreeSessionActorBinding>();
  const supersededTokenHashes = existing?.supersededTokenHashes ?? new Set<string>();
  const pendingRevokeHashes = existing?.pendingRevokeHashes ?? new Map<string, number | undefined>();
  if (opts.supersededHashes?.length) {
    for (const hash of opts.supersededHashes) {
      recordSupersededHash(supersededTokenHashes, hash);
    }
  }
  if (existing?.tokenHash) recordSupersededHash(supersededTokenHashes, existing.tokenHash);
  if (existing && pendingRevokeHashes.size > 0) {
    flushConflictRevokeHashes(
      rootSessionName,
      supersededTokenHashes,
      pendingRevokeHashes,
      currentLinkGeneration,
      [],
    );
  }
  if (markActive) activeSessions.add(sessionName);
  sessionActors.set(sessionName, normalizedIncoming);

  if (explicitConflict || incomingInvalidParticipant || (incomingHash && supersededTokenHashes.has(incomingHash))) {
    const generation = ++globalTreeGeneration;
    flushConflictRevokeHashes(
      rootSessionName,
      supersededTokenHashes,
      pendingRevokeHashes,
      currentLinkGeneration,
      [
        [existing?.tokenHash, existing?.linkGeneration],
        [incomingHash, currentLinkGeneration],
        ...conflictHashesFromOpts,
      ],
    );
    treeAuthorities.set(rootSessionName, {
      rootSessionName,
      generation,
      kind: 'mixed',
      actorUserId: normalizedIncoming.actorUserId,
      authority: null,
      tokenHash: null,
      tokenIssueSeq: Math.max(existing?.tokenIssueSeq ?? 0, incomingIssueSeq),
      linkGeneration: currentLinkGeneration,
      activeSessions,
      sessionActors,
      supersededTokenHashes,
      pendingRevokeHashes,
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
      authority: incomingAuthority,
      tokenHash: sha256Hex(incomingAuthority!),
      tokenIssueSeq: incomingIssueSeq,
      linkGeneration: currentLinkGeneration,
      activeSessions,
      sessionActors,
      supersededTokenHashes,
      pendingRevokeHashes,
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
    authority: incomingAuthority,
    tokenHash: incomingAuthority ? sha256Hex(incomingAuthority) : null,
    tokenIssueSeq: incomingIssueSeq,
    linkGeneration: currentLinkGeneration,
    activeSessions,
    sessionActors,
    supersededTokenHashes,
    pendingRevokeHashes,
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

export function readTreeSessionActorsForTests(sessionName: string): TreeSessionActorBinding[] {
  const rootSessionName = resolveDaemonRootSessionName(sessionName);
  const entry = treeAuthorities.get(rootSessionName);
  return entry ? [...entry.sessionActors.values()] : [];
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
    issueSeq?: number;
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
      activityEpoch: ++globalActivityEpoch,
      lastActivityAt: now,
      turns: opts.sessionRunning ? 1 : 0,
      undelivered: 0,
    };
    windows.set(sessionName, window);
  }
  window.lastActivityAt = now;
  window.activityEpoch = ++globalActivityEpoch;
  const startsTurn = opts.startsTurn ?? true;
  if (startsTurn) {
    window.turns += 1;
    window.undelivered += 1;
  }
  const priorWindowAuthorityHash = window.authority ? sha256Hex(window.authority) : null;
  const priorWindowOwnerAuthorityHash = window.ownerAuthority ? sha256Hex(window.ownerAuthority) : null;
  const incomingAuthorityHash = activity.authority ? sha256Hex(activity.authority) : null;
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
  const conflictRevokeHashes = hasConflictInWindow
    ? [...new Set([priorWindowAuthorityHash, priorWindowOwnerAuthorityHash, incomingAuthorityHash].filter((hash): hash is string => Boolean(hash)))]
    : undefined;
  if (startsTurn || activity.authority || hasConflictInWindow) {
    const treeActivity: SharedMachineActivity = hasConflictInWindow
      ? { kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT, actorUserId: '' }
      : activity;
    window.treeGeneration = bindTreeTurnAuthority(sessionName, treeActivity, {
      now,
      markActive: startsTurn || hasConflictInWindow,
      ...(opts.issueSeq !== undefined ? { issueSeq: opts.issueSeq } : {}),
      ...(hasConflictInWindow ? { conflict: true, conflictRevokeHashes } : {}),
    });
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
      bound.activityEpoch = ++globalActivityEpoch;
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
  issueSeq?: number,
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
    ...(issueSeq === undefined ? {} : { issueSeq }),
  });
}

export const PROCESS_SHARED_MACHINE_IDLE_GUARD_MS = 1_500;

export interface ReleaseProcessSharedMachineAuthorityOptions {
  now?: number;
  /** Completion epoch snapshot captured at timer/completion start (`null` = no active window at start). */
  expectedActivityEpoch?: number | null;
  /** Terminate/error settlement: immediately clear local process window and tree active marker. */
  forceSettle?: boolean;
}

export function readProcessSharedMachineActivityEpoch(sessionName: string): number | null {
  return windows.get(sessionName)?.activityEpoch ?? null;
}

const timelineEventActivityEpochs = new WeakMap<object, number | null>();

export function recordTimelineEventActivityEpoch(event: object, activityEpoch: number | null): void {
  timelineEventActivityEpochs.set(event, activityEpoch);
}

export function readTimelineEventActivityEpoch(event: object): number | null | undefined {
  return timelineEventActivityEpochs.get(event);
}

export function releaseProcessSharedMachineAuthority(
  sessionName: string,
  nowOrOptions: number | ReleaseProcessSharedMachineAuthorityOptions = Date.now(),
): void {
  const opts: ReleaseProcessSharedMachineAuthorityOptions = typeof nowOrOptions === 'number'
    ? { now: nowOrOptions }
    : nowOrOptions;
  const now = opts.now ?? Date.now();
  const window = windows.get(sessionName);

  if (opts.forceSettle) {
    clearIdleGuardTimer(sessionName);
    windows.delete(sessionName);
    markTreeSessionIdle(sessionName, now);
    return;
  }

  if (window) {
    if (opts.expectedActivityEpoch !== undefined) {
      if (opts.expectedActivityEpoch === null || window.activityEpoch !== opts.expectedActivityEpoch) {
        return; // Stale idle edge from an empty pre-window timer or earlier activity epoch must never affect a newer turn.
      }
    } else {
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
          releaseProcessSharedMachineAuthority(sessionName, { now: Date.now(), expectedActivityEpoch: expectedEpoch });
        }, delayMs);
        timer.unref?.();
        idleGuardTimers.set(sessionName, timer);
        return;
      }
    }
    if (window.undelivered > 0 && window.turns - window.undelivered <= 0) return;
    if (window.turns > 1) {
      window.turns -= 1;
      window.owner = false;
      if (window.participants.size > 0) window.ownerAuthority = null;
      window.lastActivityAt = now;
      window.activityEpoch = ++globalActivityEpoch;
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
  scrubQueueStore?: () => void;
}): void {
  globalTurnAuthorityDisconnectGeneration += 1;
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

  const currentLinkGeneration = getActiveServerLink()?.getConnectionGeneration?.();
  for (const [hash, item] of [...pendingIdleRevokeHashes.entries()]) {
    if (
      item.linkGeneration !== undefined
      && currentLinkGeneration !== undefined
      && item.linkGeneration !== currentLinkGeneration
    ) {
      pendingIdleRevokeHashes.delete(hash);
    }
  }

  for (const [rootSessionName, entry] of [...treeAuthorities.entries()]) {
    for (const [hash, linkGen] of entry.pendingRevokeHashes) {
      if (
        linkGen === undefined
        || currentLinkGeneration === undefined
        || linkGen === currentLinkGeneration
      ) {
        recordIdleRevokeFallback(rootSessionName, hash, linkGen);
      }
    }
    entry.pendingRevokeHashes.clear();
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
  (hooks?.scrubQueueStore ?? scrubLoadedTransportQueueMemoryAuthorities)();
  hooks?.clearTaskPairAuthorities?.();
}

export interface CanonicalRuntimeAuthorityAdapter {
  sending?: boolean;
  activeDispatchEntries?: ReadonlyArray<{ sharedActor?: { effectiveActorRole?: string; actorUserId?: string } }>;
  getTurnOriginSummary?: () => SdkTurnOriginSummary;
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
    const localTreeGen = rt.getActiveTreeGeneration?.() ?? null;
    const hasDispatchEntries = (rt.activeDispatchEntries?.length ?? 0) > 0;
    if (rt.getTurnOriginSummary) {
      const summary = rt.getTurnOriginSummary();
      if (summary.state === 'mixed') {
        return {
          state: 'mixed',
          actorUserId: summary.actorUserId ?? AMBIGUOUS_TREE_PARTICIPANT_ACTOR,
        };
      }
      if (summary.state === 'participant') {
        if (!summary.authority || !summary.actorUserId) {
          return {
            state: 'mixed',
            actorUserId: summary.actorUserId ?? AMBIGUOUS_TREE_PARTICIPANT_ACTOR,
          };
        }
        return {
          state: 'participant',
          actorUserId: summary.actorUserId,
          authority: summary.authority,
          treeGeneration: localTreeGen,
        };
      }
      if (summary.state === 'owner') {
        if (summary.authority || hasDispatchEntries || rt.sending) {
          return {
            state: 'owner',
            authority: summary.authority,
            treeGeneration: localTreeGen,
          };
        }
      }
      if (rt.sending || hasDispatchEntries) {
        return {
          state: 'owner',
          authority: null,
          treeGeneration: localTreeGen,
        };
      }
      return { state: 'none' };
    }

    const localRequired = rt.requiresSharedMachineAuthority?.() === true;
    const localSharedAuth = rt.getActiveSharedMachineAuthority?.() ?? null;
    const localOwnerAuth = rt.getActiveOwnerMachineAuthority?.() ?? null;
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
      // Same verified participant in the same tree inherits the live tree authority
      // even when the same sender started a newer turn on another session in the tree.
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
      // Same verified owner in the same tree inherits the live tree authority across turns.
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
  pendingIdleRevokeHashes.clear();
}
