import type { Database } from '../db/client.js';
import { getSubSessionById, isExecutionCloneRow } from '../db/queries.js';
import { listActiveSharesForUser, resolveEffectiveShareCoverage, type ShareTarget } from '../db/tab-sharing.js';
import { resolveServerRole, type ServerRole } from '../security/authorization.js';
import { resolveEffectiveActor, type ResolveEffectiveActorResult } from '../../../shared/tab-sharing.js';

export interface HttpShareAccess {
  membership: ServerRole;
  actor: ResolveEffectiveActorResult;
}

export type ServerMemberAccessOrShareDeny =
  | { ok: true; role: Exclude<ServerRole, 'none'> }
  | { ok: false; reason: 'share-direct-surface-denied' | 'not_authorized_for_server' };

export async function resolveHttpShareAccess(
  db: Database,
  params: { serverId: string; userId: string; target: ShareTarget; now?: number },
): Promise<HttpShareAccess> {
  const now = params.now ?? Date.now();
  const membership = await resolveServerRole(db, params.serverId, params.userId);
  if (membership !== 'none') {
    return {
      membership,
      actor: resolveEffectiveActor(membership, null),
    };
  }
  // The WS path refuses a target belonging to another server before resolving
  // coverage (`resolveShareCoverageFromDb`); this one did not. Every caller
  // currently builds the target from the route's own serverId, so the two can
  // never disagree today — but a caller that starts reading the target from a
  // request body would turn that into cross-server access with no guard here
  // to stop it.
  if (params.target.serverId && params.target.serverId !== params.serverId) {
    return { membership, actor: resolveEffectiveActor(null, null) };
  }
  const coverage = await resolveEffectiveShareCoverage(db, { userId: params.userId, target: params.target, now });
  return {
    membership,
    actor: resolveEffectiveActor(null, coverage),
  };
}

/**
 * Resolve HTTP access to one concrete session using the same coverage model as
 * the share-scoped WebSocket. A main-session share includes its ordinary child
 * sub-sessions, but never execution clones.
 *
 * Direct membership, server shares, and explicit sub-session shares are
 * resolved first. The parent lookup is only needed for an otherwise-denied
 * sub-session target, keeping the common path unchanged.
 */
export async function resolveHttpShareAccessForCoveredSession(
  db: Database,
  params: { serverId: string; userId: string; target: ShareTarget; now?: number },
): Promise<HttpShareAccess> {
  const direct = await resolveHttpShareAccess(db, params);
  if (direct.actor.kind !== 'none' || params.target.kind !== 'subsession') return direct;

  const child = await getSubSessionById(db, params.target.subSessionId, params.serverId);
  if (!child || child.closed_at !== null || isExecutionCloneRow(child) || !child.parent_session) return direct;

  return resolveHttpShareAccess(db, {
    ...params,
    target: {
      kind: 'main',
      serverId: params.serverId,
      sessionName: child.parent_session,
    },
  });
}

export async function resolveServerMemberAccessOrShareDeny(
  db: Database,
  params: { serverId: string; userId: string; now?: number },
): Promise<ServerMemberAccessOrShareDeny> {
  const role = await resolveServerRole(db, params.serverId, params.userId);
  if (role !== 'none') return { ok: true, role };

  const shares = await listActiveSharesForUser(db, params.userId, params.now ?? Date.now());
  const hasShareForServer = shares.some((share) => share.serverId === params.serverId);
  return {
    ok: false,
    reason: hasShareForServer ? 'share-direct-surface-denied' : 'not_authorized_for_server',
  };
}
