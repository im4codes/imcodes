import type { Database } from '../db/client.js';
import { shareTargetFromSessionName, targetExists } from '../db/tab-sharing.js';
import { resolveHttpShareAccessForCoveredSession } from './share-http-auth.js';

export async function authorizeTimelineSession(
  db: Database,
  params: { serverId: string; userId: string; sessionName: string },
): Promise<{ ok: true } | { ok: false; reason?: string }> {
  const target = shareTargetFromSessionName(params.serverId, params.sessionName);
  if (!target) return { ok: false, reason: 'share-target-unavailable' };
  const access = await resolveHttpShareAccessForCoveredSession(db, {
    serverId: params.serverId,
    userId: params.userId,
    target,
  });
  if (access.actor.kind === 'server-member') {
    return await targetExists(db, target)
      ? { ok: true }
      : { ok: false };
  }
  if (access.actor.kind === 'share') return { ok: true };
  return { ok: false };
}
