import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import type { PushPayload } from '../routes/push.js';
import type { RemoteDesktopAutoUnlockEvent } from '../ws/remote-desktop-router.js';
import { REMOTE_DESKTOP_AUDIT_EVENT } from '../../../shared/remote-desktop.js';
import { REMOTE_DESKTOP_ACTOR_SOURCE } from '../../../shared/remote-desktop-access.js';
import logger from '../util/logger.js';

export interface RemoteDesktopAutoUnlockNotifierDeps {
  dispatchPush?: (payload: PushPayload, db: Database, env: Env) => Promise<void>;
}

const NAME_MAX = 64;

function bounded(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > NAME_MAX ? `${trimmed.slice(0, NAME_MAX - 1)}…` : trimmed;
}

async function actorLabel(db: Database, event: RemoteDesktopAutoUnlockEvent): Promise<string> {
  switch (event.actor.source) {
    case REMOTE_DESKTOP_ACTOR_SOURCE.ACCOUNT: {
      if (!event.userId) return 'an account';
      const user = await db.queryOne<{ display_name: string | null; username: string | null }>(
        'SELECT display_name, username FROM users WHERE id = $1',
        [event.userId],
      );
      return bounded(user?.display_name) ?? bounded(user?.username) ?? 'an account';
    }
    case REMOTE_DESKTOP_ACTOR_SOURCE.ATTENDED_LINK:
      return 'a guest link';
    case REMOTE_DESKTOP_ACTOR_SOURCE.UNATTENDED_LINK:
      return 'an unattended guest link';
    case REMOTE_DESKTOP_ACTOR_SOURCE.NODE_PASSWORD:
      return 'the node password';
    default:
      return 'a remote session';
  }
}

/**
 * Tell the machine owner that the node's built-in auto unlock opened its lock
 * screen for a remote-desktop connection. The router already guarantees one
 * call per route; this only resolves the owner and sends one ordinary push.
 * Failures are logged and never affect the session.
 */
export async function notifyRemoteDesktopAutoUnlock(
  db: Database,
  env: Env,
  event: RemoteDesktopAutoUnlockEvent,
  deps: RemoteDesktopAutoUnlockNotifierDeps = {},
): Promise<boolean> {
  try {
    const server = await db.queryOne<{ user_id: string | null; name: string | null }>(
      'SELECT user_id, name FROM servers WHERE id = $1',
      [event.serverId],
    );
    if (!server?.user_id) return false;
    const machine = bounded(server.name) ?? 'Your machine';
    const dispatch = deps.dispatchPush
      ?? (await import('../routes/push.js')).dispatchPush as (payload: PushPayload, db: Database, env: Env) => Promise<void>;
    await dispatch({
      userId: server.user_id,
      title: 'Remote desktop auto unlock',
      body: `${machine} was unlocked by auto unlock for ${await actorLabel(db, event)}.`,
      data: { serverId: event.serverId, type: REMOTE_DESKTOP_AUDIT_EVENT.AUTO_UNLOCK_SUCCEEDED },
    }, db, env);
    return true;
  } catch (error) {
    logger.warn({
      serverId: event.serverId,
      error: error instanceof Error ? error.message : String(error),
    }, 'remote desktop auto-unlock notification failed');
    return false;
  }
}
