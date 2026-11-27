import type { Database } from '../db/client.js';
import type { EffectiveCoverage, SharedActorEnvelope } from '../../../shared/tab-sharing.js';
import type { HttpShareAccess } from '../routes/share-http-auth.js';

export function isWholeServerShareAccess(access: HttpShareAccess): boolean {
  if (access.actor.kind !== 'share') return false;
  // Production resolvers always set shareProvenance from covering grant ids.
  // The fallback preserves old internal test fixtures that model a server
  // grant directly as a server-target coverage snapshot.
  return access.shareProvenance === 'server'
    || (access.shareProvenance === undefined && access.actor.coverage?.target?.kind === 'server');
}

export async function buildHttpSharedActor(
  db: Database,
  params: {
    userId: string;
    coverage: EffectiveCoverage;
    actionId: string;
    now: number;
    origin?: SharedActorEnvelope['origin'];
  },
): Promise<SharedActorEnvelope> {
  const user = await db.queryOne?.<{ display_name: string | null; username: string | null }>(
    'SELECT display_name, username FROM users WHERE id = $1',
    [params.userId],
  );
  return {
    actorUserId: params.userId,
    actorDisplayName: user?.display_name ?? user?.username ?? params.userId,
    snapshot: params.coverage,
    primaryShareId: params.coverage.primaryShareId,
    effectiveActorRole: params.coverage.effectiveRole,
    actionId: params.actionId,
    origin: params.origin ?? (params.coverage.target.kind === 'server' ? 'shared-server' : 'shared-tab'),
    authorizedAt: params.coverage.authorizedAt,
    queuedAt: params.now,
  };
}
