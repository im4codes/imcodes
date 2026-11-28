import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '../db/client.js';
import { resolveEffectiveShareCoverage } from '../db/tab-sharing.js';
import { isSharedOrContributedServer, isWholeServerShareUser } from '../security/server-share-boundary.js';
import { isUserStatusActive } from '../../../shared/user-status.js';
import {
  TURN_AUTHORITY_TOKEN_PREFIX,
  type OwnerMachineAuthorityClaims,
  type SharedMachineAuthorityClaims,
} from '../../../shared/shared-machine-authority.js';
import type { ShareTarget } from '../../../shared/tab-sharing.js';
import {
  MACHINE_DENIAL_REASON,
  evaluateMachineAction,
  type MachineAction,
  type MachineDenialReason,
} from '../../../shared/machine-access-policy.js';
import {
  canOperateControlledMachine,
  listAccessibleControlledMachines,
  resolveControlledMachineOperatorAccess,
  type ControlledMachineOperatorAccessRow,
} from './machine-access.js';

/** Active turn-grant idle ceiling; verified use slides the expiry forward while full-tree idle or sender switch deletes it immediately. */
export const TURN_AUTHORITY_TTL_MS = 30 * 60 * 1000;
const MAX_SUB_SESSION_TREE_DEPTH = 16;

export interface TurnAuthorityGrantRecord {
  tokenHash: string;
  serverId: string;
  rootSessionName: string;
  sessionName: string;
  projectName: string;
  actorUserId: string;
  ownerUserId: string;
  kind: 'owner' | 'participant';
  shareTarget?: ShareTarget;
  actionId: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
}

const STORE_SYMBOL = Symbol.for('imcodes.server.turnAuthorityGrantStore.v1');
interface TurnAuthorityGrantStore {
  grantsByHash: Map<string, TurnAuthorityGrantRecord>;
  hashesByTree: Map<string, Set<string>>;
  hashesByServer: Map<string, Set<string>>;
}
function getGrantStore(): TurnAuthorityGrantStore {
  const g = globalThis as Record<symbol, TurnAuthorityGrantStore | undefined>;
  if (!g[STORE_SYMBOL]) {
    g[STORE_SYMBOL] = {
      grantsByHash: new Map(),
      hashesByTree: new Map(),
      hashesByServer: new Map(),
    };
  }
  return g[STORE_SYMBOL]!;
}
const { grantsByHash, hashesByTree, hashesByServer } = getGrantStore();

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function treeKey(serverId: string, rootSessionName: string): string {
  return `${serverId}\u0000${rootSessionName}`;
}

function deleteGrantByHash(tokenHash: string): boolean {
  const existing = grantsByHash.get(tokenHash);
  if (!existing) return false;
  grantsByHash.delete(tokenHash);
  const tKey = treeKey(existing.serverId, existing.rootSessionName);
  const treeSet = hashesByTree.get(tKey);
  if (treeSet) {
    treeSet.delete(tokenHash);
    if (treeSet.size === 0) hashesByTree.delete(tKey);
  }
  const serverSet = hashesByServer.get(existing.serverId);
  if (serverSet) {
    serverSet.delete(tokenHash);
    if (serverSet.size === 0) hashesByServer.delete(existing.serverId);
  }
  return true;
}

/** Delete every active turn grant for a single `(serverId, rootSessionName)` main-session tree. */
export function revokeTurnAuthorityGrantsForTree(serverId: string, rootSessionName: string): number {
  const treeSet = hashesByTree.get(treeKey(serverId, rootSessionName));
  if (!treeSet || treeSet.size === 0) return 0;
  let removed = 0;
  for (const tokenHash of [...treeSet]) {
    if (deleteGrantByHash(tokenHash)) removed += 1;
  }
  return removed;
}

/**
 * Revoke a tree's active grant only when its stored `tokenHash` matches the daemon's
 * idle notification, preventing a late revoke from deleting a freshly minted replacement turn.
 */
export function revokeTurnAuthorityGrantByHash(
  serverId: string,
  rootSessionName: string,
  tokenHash: string,
): boolean {
  const normalized = tokenHash.trim().toLowerCase();
  const grant = grantsByHash.get(normalized);
  if (!grant || grant.serverId !== serverId || grant.rootSessionName !== rootSessionName) return false;
  return deleteGrantByHash(normalized);
}

/** Revoke a live turn grant by raw opaque token for a specific source serverId (any tree). */
export function revokeTurnAuthorityGrantByToken(serverId: string, token: string): boolean {
  if (!token) return false;
  const tokenHash = sha256Hex(token);
  const grant = grantsByHash.get(tokenHash);
  if (!grant || grant.serverId !== serverId) return false;
  return deleteGrantByHash(tokenHash);
}

function confirmAndSlideLocalGrantRecord(
  tokenHash: string,
  expectedGrant: TurnAuthorityGrantRecord,
  now: number,
): boolean {
  const live = grantsByHash.get(tokenHash);
  if (live !== expectedGrant || live.expiresAt <= now) {
    if (live && live.expiresAt <= now) deleteGrantByHash(tokenHash);
    return false;
  }
  live.lastUsedAt = now;
  live.expiresAt = Math.max(live.expiresAt, now + TURN_AUTHORITY_TTL_MS);
  return true;
}

function reconfirmLocalTurnAuthorityGrantLiveness(input: {
  tokenHash: string;
  serverId: string;
  expectedCreatedAt: number;
  now: number;
}): boolean {
  const live = grantsByHash.get(input.tokenHash);
  if (!live || live.serverId !== input.serverId || live.createdAt !== input.expectedCreatedAt) return false;
  if (live.expiresAt <= input.now) {
    deleteGrantByHash(input.tokenHash);
    return false;
  }
  return true;
}

/** Delete every active turn grant associated with a disconnected/replaced daemon server WS. */
export function revokeAllTurnAuthorityGrantsForServer(serverId: string): number {
  const serverSet = hashesByServer.get(serverId);
  if (!serverSet || serverSet.size === 0) return 0;
  let removed = 0;
  for (const tokenHash of [...serverSet]) {
    if (deleteGrantByHash(tokenHash)) removed += 1;
  }
  return removed;
}

/** Synchronous in-memory liveness check for server input caching. Never logs or leaks the token. */
export function isTurnAuthorityGrantActive(token: string | undefined | null, now = Date.now()): boolean {
  if (!token) return false;
  const grant = grantsByHash.get(sha256Hex(token));
  return Boolean(grant && grant.expiresAt > now);
}

export function clearTurnAuthorityGrantsForTests(): void {
  grantsByHash.clear();
  hashesByTree.clear();
  hashesByServer.clear();
}

export function getTurnAuthorityGrantCountForTests(): number {
  return grantsByHash.size;
}

function mintTreeAuthorityGrant(input: {
  serverId: string;
  rootSessionName: string;
  sessionName: string;
  projectName: string;
  actorUserId: string;
  ownerUserId: string;
  kind: 'owner' | 'participant';
  shareTarget?: ShareTarget;
  actionId: string;
  now?: number;
}): string {
  const now = input.now ?? Date.now();
  // Every new turn or sender switch on the tree immediately invalidates all prior grants on that tree.
  revokeTurnAuthorityGrantsForTree(input.serverId, input.rootSessionName);

  const token = `${TURN_AUTHORITY_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const tokenHash = sha256Hex(token);
  const record: TurnAuthorityGrantRecord = {
    tokenHash,
    serverId: input.serverId,
    rootSessionName: input.rootSessionName,
    sessionName: input.sessionName,
    projectName: input.projectName,
    actorUserId: input.actorUserId,
    ownerUserId: input.ownerUserId,
    kind: input.kind,
    ...(input.shareTarget ? { shareTarget: input.shareTarget } : {}),
    actionId: input.actionId,
    createdAt: now,
    lastUsedAt: now,
    expiresAt: now + TURN_AUTHORITY_TTL_MS,
  };
  grantsByHash.set(tokenHash, record);
  const tKey = treeKey(input.serverId, input.rootSessionName);
  let treeSet = hashesByTree.get(tKey);
  if (!treeSet) {
    treeSet = new Set();
    hashesByTree.set(tKey, treeSet);
  }
  treeSet.add(tokenHash);
  let serverSet = hashesByServer.get(input.serverId);
  if (!serverSet) {
    serverSet = new Set();
    hashesByServer.set(input.serverId, serverSet);
  }
  serverSet.add(tokenHash);
  return token;
}

export function issueSharedMachineAuthority(
  claims: SharedMachineAuthorityClaims,
  _signingKey?: string,
  options?: { now?: number },
): string {
  const rootSessionName = claims.rootSessionName?.trim() || claims.sessionName;
  return mintTreeAuthorityGrant({
    serverId: claims.sourceServerId,
    rootSessionName,
    sessionName: claims.sessionName,
    projectName: claims.projectName,
    actorUserId: claims.sub,
    ownerUserId: claims.ownerUserId ?? claims.sub,
    kind: 'participant',
    shareTarget: claims.shareTarget,
    actionId: claims.actionId,
    now: options?.now,
  });
}

export function issueOwnerMachineAuthority(
  claims: OwnerMachineAuthorityClaims,
  _signingKey?: string,
  options?: { now?: number },
): string {
  const rootSessionName = claims.rootSessionName?.trim() || claims.sessionName;
  return mintTreeAuthorityGrant({
    serverId: claims.sourceServerId,
    rootSessionName,
    sessionName: claims.sessionName,
    projectName: claims.projectName,
    actorUserId: claims.sub,
    ownerUserId: claims.sub,
    kind: 'owner',
    actionId: claims.actionId,
    now: options?.now,
  });
}

async function isVerifiedRealServerOwner(
  db: Database,
  serverId: string,
  userId: string,
  now: number,
): Promise<boolean> {
  if (!serverId || !userId) return false;
  const row = await db.queryOne<{ user_id: string; user_status: string | null }>(
    `SELECT s.user_id, u.status AS user_status
       FROM servers s
       LEFT JOIN users u ON u.id = $2
      WHERE s.id = $1
      LIMIT 1`,
    [serverId, userId],
  );
  if (!row || row.user_id !== userId) return false;
  if (await isWholeServerShareUser(db, serverId, userId, now)) return false;
  return isUserStatusActive(row.user_status);
}

type SessionBinding = {
  rootSessionName: string;
  projectName: string;
  parentSessionName: string | null;
  subSessionId: string | null;
  ancestorSubSessionIds: Set<string>;
};

async function readSessionBinding(
  db: Database,
  sourceServerId: string,
  sessionName: string,
): Promise<SessionBinding | null> {
  const initialSubSessionId = sessionName.match(/^deck_sub_([A-Za-z0-9_-]+)$/)?.[1] ?? null;
  if (initialSubSessionId) {
    let currentSessionName = sessionName;
    let immediateParent: string | null = null;
    let resolvedProjectName = '';
    const ancestorSubSessionIds = new Set<string>();
    const visitedSessions = new Set<string>();

    for (let depth = 0; depth < MAX_SUB_SESSION_TREE_DEPTH; depth += 1) {
      if (visitedSessions.has(currentSessionName)) break;
      visitedSessions.add(currentSessionName);
      const subId = currentSessionName.match(/^deck_sub_([A-Za-z0-9_-]+)$/)?.[1];
      if (!subId) break;
      const row = await db.queryOne<{ project_name: string | null; parent_session: string | null }>(
        `SELECT s.project_name, ss.parent_session
           FROM sub_sessions ss
           LEFT JOIN sessions s ON s.server_id = ss.server_id AND s.name = ss.parent_session
          WHERE ss.server_id = $1 AND ss.id = $2 AND ss.closed_at IS NULL
          LIMIT 1`,
        [sourceServerId, subId],
      );
      if (!row) {
        return depth === 0 ? null : {
          rootSessionName: currentSessionName,
          projectName: resolvedProjectName,
          parentSessionName: immediateParent,
          subSessionId: initialSubSessionId,
          ancestorSubSessionIds,
        };
      }
      ancestorSubSessionIds.add(subId);
      if (depth === 0) immediateParent = row.parent_session;
      if (typeof row.project_name === 'string' && row.project_name) {
        resolvedProjectName = row.project_name;
      }
      if (!row.parent_session) {
        return {
          rootSessionName: currentSessionName,
          projectName: resolvedProjectName,
          parentSessionName: immediateParent,
          subSessionId: initialSubSessionId,
          ancestorSubSessionIds,
        };
      }
      if (!/^deck_sub_[A-Za-z0-9_-]+$/.test(row.parent_session)) {
        if (!resolvedProjectName) {
          const mainRow = await db.queryOne<{ project_name: string }>(
            'SELECT project_name FROM sessions WHERE server_id = $1 AND name = $2 LIMIT 1',
            [sourceServerId, row.parent_session],
          );
          if (mainRow?.project_name) resolvedProjectName = mainRow.project_name;
        }
        return {
          rootSessionName: row.parent_session,
          projectName: resolvedProjectName,
          parentSessionName: immediateParent,
          subSessionId: initialSubSessionId,
          ancestorSubSessionIds,
        };
      }
      currentSessionName = row.parent_session;
    }

    return {
      rootSessionName: currentSessionName,
      projectName: resolvedProjectName,
      parentSessionName: immediateParent,
      subSessionId: initialSubSessionId,
      ancestorSubSessionIds,
    };
  }
  const row = await db.queryOne<{ project_name: string }>(
    'SELECT project_name FROM sessions WHERE server_id = $1 AND name = $2 LIMIT 1',
    [sourceServerId, sessionName],
  );
  return row
    ? {
        rootSessionName: sessionName,
        projectName: row.project_name,
        parentSessionName: null,
        subSessionId: null,
        ancestorSubSessionIds: new Set(),
      }
    : null;
}

function targetCoversBinding(target: ShareTarget, sessionName: string, binding: SessionBinding): boolean {
  if (target.kind === 'server') return true;
  if (target.kind === 'main') {
    return target.sessionName === sessionName
      || target.sessionName === binding.rootSessionName
      || target.sessionName === binding.parentSessionName;
  }
  return binding.ancestorSubSessionIds.has(target.subSessionId) || target.subSessionId === binding.subSessionId;
}

export async function issueSharedMachineAuthorityForSession(
  db: Database,
  input: {
    actorUserId: string;
    sourceServerId: string;
    sessionName: string;
    shareTarget: ShareTarget;
    actionId: string;
    signingKey?: string;
    now?: number;
  },
): Promise<string | null> {
  const binding = await readSessionBinding(db, input.sourceServerId, input.sessionName);
  if (!binding || !targetCoversBinding(input.shareTarget, input.sessionName, binding)) return null;
  return mintTreeAuthorityGrant({
    serverId: input.sourceServerId,
    rootSessionName: binding.rootSessionName,
    sessionName: input.sessionName,
    projectName: binding.projectName ?? '',
    actorUserId: input.actorUserId,
    ownerUserId: '',
    kind: 'participant',
    shareTarget: input.shareTarget,
    actionId: input.actionId,
    now: input.now,
  });
}

export async function issueOwnerMachineAuthorityForSession(
  db: Database,
  input: {
    actorUserId: string;
    sourceServerId: string;
    sessionName: string;
    projectName?: string;
    actionId: string;
    signingKey?: string;
    now?: number;
  },
): Promise<string | null> {
  const now = input.now ?? Date.now();
  if (!input.sessionName) return null;
  if (!await isVerifiedRealServerOwner(db, input.sourceServerId, input.actorUserId, now)) return null;
  const hasExplicitProjectName = typeof input.projectName === 'string' && input.projectName.length > 0;
  const isSubSession = /^deck_sub_[A-Za-z0-9_-]+$/.test(input.sessionName);
  const binding = (!hasExplicitProjectName || isSubSession)
    ? await readSessionBinding(db, input.sourceServerId, input.sessionName)
    : null;
  const rootSessionName = binding?.rootSessionName ?? input.sessionName;
  const resolvedProjectName = hasExplicitProjectName
    ? input.projectName!
    : (binding?.projectName ?? '');
  return mintTreeAuthorityGrant({
    serverId: input.sourceServerId,
    rootSessionName,
    sessionName: input.sessionName,
    projectName: resolvedProjectName,
    actorUserId: input.actorUserId,
    ownerUserId: input.actorUserId,
    kind: 'owner',
    actionId: input.actionId,
    now,
  });
}

export type SharedMachineAuthorityDecision =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | {
      kind: 'owner';
      actorUserId: string;
      sessionName: string;
      rootSessionName: string;
      projectName: string;
      tokenHash: string;
      grantCreatedAt: number;
    }
  | {
      kind: 'participant';
      actorUserId: string;
      sessionName: string;
      rootSessionName: string;
      projectName: string;
      shareTarget?: ShareTarget;
      actionId: string;
      tokenHash: string;
      grantCreatedAt: number;
    };

/**
 * Verify the server-stateful in-memory opaque turn grant (single-process RAM Map)
 * and re-read the live share grant or owner identity from DB. Reconfirms live grant presence
 * after every DB await before sliding TTL so concurrent revocation rejects in-flight admissions.
 */
export async function resolveSharedMachineAuthority(
  db: Database,
  input: {
    token: string | undefined;
    signingKey?: string;
    authenticatedSourceServerId: string;
    sourceOwnerUserId?: string;
    now: number;
  },
): Promise<SharedMachineAuthorityDecision> {
  if (!input.token) return { kind: 'absent' };
  const tokenHash = sha256Hex(input.token);
  const now = input.now;
  const grant = grantsByHash.get(tokenHash);

  if (!grant || grant.serverId !== input.authenticatedSourceServerId) {
    return { kind: 'invalid' };
  }
  if (grant.expiresAt <= now) {
    deleteGrantByHash(tokenHash);
    return { kind: 'invalid' };
  }

  if (grant.kind === 'owner') {
    if (input.sourceOwnerUserId && grant.actorUserId !== input.sourceOwnerUserId) {
      return { kind: 'invalid' };
    }
    if (!await isVerifiedRealServerOwner(db, input.authenticatedSourceServerId, grant.actorUserId, now)) {
      return { kind: 'invalid' };
    }
    if (grant.projectName) {
      const binding = await readSessionBinding(db, input.authenticatedSourceServerId, grant.sessionName);
      if (binding && binding.projectName && binding.projectName !== grant.projectName) {
        return { kind: 'invalid' };
      }
    }
    if (!confirmAndSlideLocalGrantRecord(tokenHash, grant, now)) return { kind: 'invalid' };
    return {
      kind: 'owner',
      actorUserId: grant.actorUserId,
      sessionName: grant.sessionName,
      rootSessionName: grant.rootSessionName,
      projectName: grant.projectName,
      tokenHash: grant.tokenHash,
      grantCreatedAt: grant.createdAt,
    };
  }

  const shareTarget = grant.shareTarget;
  if (!shareTarget || shareTarget.serverId !== input.authenticatedSourceServerId) {
    return { kind: 'invalid' };
  }
  if (!grant.projectName && shareTarget.kind !== 'subsession') {
    return { kind: 'invalid' };
  }
  const binding = await readSessionBinding(db, input.authenticatedSourceServerId, grant.sessionName);
  if (!binding
    || (grant.projectName && binding.projectName && binding.projectName !== grant.projectName)
    || !targetCoversBinding(shareTarget, grant.sessionName, binding)) {
    return { kind: 'invalid' };
  }
  const coverage = await resolveEffectiveShareCoverage(db, {
    userId: grant.actorUserId,
    target: shareTarget,
    now,
  });
  if (!coverage || coverage.effectiveRole !== 'participant') {
    deleteGrantByHash(tokenHash);
    return { kind: 'invalid' };
  }
  if (!confirmAndSlideLocalGrantRecord(tokenHash, grant, now)) return { kind: 'invalid' };
  return {
    kind: 'participant',
    actorUserId: grant.actorUserId,
    sessionName: grant.sessionName,
    rootSessionName: grant.rootSessionName,
    projectName: grant.projectName,
    shareTarget,
    actionId: grant.actionId,
    tokenHash: grant.tokenHash,
    grantCreatedAt: grant.createdAt,
  };
}

interface DetailedOperationalUser {
  userId: string;
  delegatedActorUserId?: string;
  authorityKind: 'absent' | 'owner' | 'participant';
  tokenHash?: string;
  grantCreatedAt?: number;
}

async function resolveMachineOperationalUserDetailed(
  db: Database,
  input: {
    token: string | undefined;
    signingKey: string;
    authenticatedSourceServerId: string;
    sourceOwnerUserId: string;
    now: number;
  },
): Promise<DetailedOperationalUser | null> {
  const delegated = await resolveSharedMachineAuthority(db, input);
  if (delegated.kind === 'invalid') return null;
  if (delegated.kind === 'participant') {
    return {
      userId: input.sourceOwnerUserId,
      delegatedActorUserId: delegated.actorUserId,
      authorityKind: 'participant',
      tokenHash: delegated.tokenHash,
      grantCreatedAt: delegated.grantCreatedAt,
    };
  }
  if (delegated.kind === 'owner') {
    return {
      userId: input.sourceOwnerUserId,
      authorityKind: 'owner',
      tokenHash: delegated.tokenHash,
      grantCreatedAt: delegated.grantCreatedAt,
    };
  }
  return { userId: input.sourceOwnerUserId, authorityKind: 'absent' };
}

export async function resolveMachineOperationalUser(
  db: Database,
  input: {
    token: string | undefined;
    signingKey: string;
    authenticatedSourceServerId: string;
    sourceOwnerUserId: string;
    now: number;
  },
): Promise<{ userId: string; delegatedActorUserId?: string; authorityKind: 'absent' | 'owner' | 'participant' } | null> {
  const detailed = await resolveMachineOperationalUserDetailed(db, input);
  if (!detailed) return null;
  return {
    userId: detailed.userId,
    ...(detailed.delegatedActorUserId ? { delegatedActorUserId: detailed.delegatedActorUserId } : {}),
    authorityKind: detailed.authorityKind,
  };
}

/**
 * A shared-session turn runs on the owner's daemon with the owner's agent, but
 * a session share grants no machine access. The participant must hold their OWN
 * Owner/Participant access to the exact target (a machine share or a group
 * membership), read live from the DB. Source ownership authenticates the session,
 * not the target fleet. An
 * owner turn has no delegated actor and is unchanged.
 */
/** Current operable actor rows, not just visibility IDs: callers must not substitute the source owner's grants. */
export async function listActorOperableMachineAccess(
  db: Database,
  delegatedActorUserId: string,
  now: number,
  limit: number,
) {
  const rows = await listAccessibleControlledMachines(db, delegatedActorUserId, now, limit, true);
  return new Map(rows.filter((row) => canOperateControlledMachine(row.access_role)).map((row) => [row.id, row]));
}

/**
 * Single action-admission boundary for daemon-originated controlled-device
 * operations. The signed shared-turn context is verified against its exact
 * source session/project and live participant grant, then the exact target is
 * resolved as the actual actor's current controlled device (the source owner
 * only for a non-delegated turn). A
 * present but invalid delegated context never falls back to owner authority,
 * and a valid one never widens a participant beyond what they were given.
 *
 * Operating is not executing: the ACTION decides (shared/machine-access-policy.ts). An execute-class action additionally needs the node's
 * exec switch and the current ACTOR's device ownership or explicit execute grant. Only exec_remote additionally refuses participant turns. The action is a
 * REQUIRED argument, so a new call site cannot admit "something" without saying what.
 */
export interface MachineActionAdmissionInput {
  token: string | undefined;
  signingKey: string;
  authenticatedSourceServerId: string;
  sourceOwnerUserId: string;
  targetServerId: string;
  action: MachineAction;
  now: number;
}

export type MachineActionAdmission =
  | {
      ok: true;
      target: ControlledMachineOperatorAccessRow;
      delegatedActorUserId?: string;
    }
  | {
      ok: false;
      reason: MachineDenialReason;
      /** What the actor was, for the audit. Null when nothing could be resolved. */
      accessSource: string | null;
      delegatedActorUserId?: string;
    };

export async function admitMachineAction(
  db: Database,
  input: MachineActionAdmissionInput,
): Promise<MachineActionAdmission> {
  const operational = await resolveMachineOperationalUserDetailed(db, input);
  // An invalid / expired / foreign turn authority never falls back to the owner.
  if (!operational) return { ok: false, reason: MACHINE_DENIAL_REASON.NO_ACCESS, accessSource: null };
  const delegatedActorUserId = operational.delegatedActorUserId;
  // A shared or group-contributed source host must never use absent-header owner credentials
  // to operate/execute against other devices or without explicit per-turn owner or participant authority.
  if (
    operational.authorityKind === 'absent'
    && input.authenticatedSourceServerId
    && await isSharedOrContributedServer(db, input.authenticatedSourceServerId, input.now)
  ) {
    return { ok: false, reason: MACHINE_DENIAL_REASON.NO_ACCESS, accessSource: null };
  }
  const deny = (reason: MachineDenialReason, accessSource: string | null): MachineActionAdmission => ({
    ok: false, reason, accessSource, ...(delegatedActorUserId ? { delegatedActorUserId } : {}),
  });
  // Source session/project authority has already been verified. Resolve the
  // actor's own target, never an intersection with the source owner's fleet.
  const target = await resolveControlledMachineOperatorAccess(
    db, delegatedActorUserId ?? operational.userId, input.targetServerId, input.now,
  );
  if (!target) return deny(MACHINE_DENIAL_REASON.NO_ACCESS, null);
  const decision = evaluateMachineAction({
    accessRole: target.access_role,
    accessSource: target.access_source,
    execGranted: target.exec_granted === true,
    execEnabled: target.exec_enabled === true,
    participantTurn: Boolean(delegatedActorUserId),
  }, input.action);
  if (!decision.allowed) return deny(decision.reason, target.access_source);
  if (operational.authorityKind !== 'absent' && operational.tokenHash && operational.grantCreatedAt !== undefined) {
    const stillLive = reconfirmLocalTurnAuthorityGrantLiveness({
      tokenHash: operational.tokenHash,
      serverId: input.authenticatedSourceServerId,
      expectedCreatedAt: operational.grantCreatedAt,
      now: input.now,
    });
    if (!stillLive) return deny(MACHINE_DENIAL_REASON.NO_ACCESS, null);
  }
  return { ok: true, target, ...(delegatedActorUserId ? { delegatedActorUserId } : {}) };
}

/** The pre-split shape for callers that only need the target: null = refused. The action is required. */
export async function resolveMachineOperationalAccess(
  db: Database,
  input: MachineActionAdmissionInput,
): Promise<{
  target: ControlledMachineOperatorAccessRow;
  delegatedActorUserId?: string;
} | null> {
  const admission = await admitMachineAction(db, input);
  if (!admission.ok) return null;
  return {
    target: admission.target,
    ...(admission.delegatedActorUserId ? { delegatedActorUserId: admission.delegatedActorUserId } : {}),
  };
}
