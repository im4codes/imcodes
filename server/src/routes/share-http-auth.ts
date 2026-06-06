import type { Database } from '../db/client.js';
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
  const coverage = await resolveEffectiveShareCoverage(db, { userId: params.userId, target: params.target, now });
  return {
    membership,
    actor: resolveEffectiveActor(null, coverage),
  };
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
