/**
 * Cron handler: every 5 minutes — check server heartbeats, mark offline.
 */
import type { Env } from '../env.js';
import { logAudit } from '../security/audit.js';
import logger from '../util/logger.js';

const HEARTBEAT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export async function healthCheckCron(env: Env): Promise<void> {
  const cutoff = Date.now() - HEARTBEAT_TIMEOUT_MS;

  const staleServers = await env.DB.query<{ id: string; name: string; user_id: string; last_heartbeat_at: number | null }>(
    "SELECT id, name, user_id, last_heartbeat_at FROM servers WHERE status = 'online' AND (last_heartbeat_at IS NULL OR last_heartbeat_at < $1)",
    [cutoff],
  );

  for (const server of staleServers) {
    logger.info({ serverId: server.id, serverName: server.name }, 'Server heartbeat timeout — marking offline');

    await env.DB.execute(
      "UPDATE servers SET status = 'offline' WHERE id = $1",
      [server.id],
    );

    await logAudit(
      {
        userId: server.user_id,
        serverId: server.id,
        action: 'server.offline',
        details: { lastHeartbeat: server.last_heartbeat_at, reason: 'heartbeat_timeout' },
      },
      env.DB,
    );
  }

  logger.info({ markedOffline: staleServers.length }, 'Health check cron complete');
}
