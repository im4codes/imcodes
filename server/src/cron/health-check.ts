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

  let markedOffline = 0;
  for (const server of staleServers) {
    const result = await env.DB.execute(
      "UPDATE servers SET status = 'offline' WHERE id = $1 AND status = 'online' AND (last_heartbeat_at IS NULL OR last_heartbeat_at < $2)",
      [server.id, cutoff],
    );
    const changes = (result as { changes?: number } | undefined)?.changes ?? 1;
    if (changes <= 0) continue;

    markedOffline += 1;
    logger.info({ serverId: server.id, serverName: server.name }, 'Server heartbeat timeout — marking offline');

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

  logger.info({ markedOffline }, 'Health check cron complete');
}
