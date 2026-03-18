/**
 * Cron handler: every 5 minutes — check server heartbeats, mark offline, notify users.
 */
import type { Env } from '../types.js';
import { logAudit } from '../security/audit.js';
import logger from '../util/logger.js';

const HEARTBEAT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes without heartbeat = offline

export async function healthCheckCron(env: Env): Promise<void> {
  const cutoff = Date.now() - HEARTBEAT_TIMEOUT_MS;

  // Find servers that haven't sent a heartbeat recently
  const staleServers = await env.DB
    .prepare(
      "SELECT id, name, user_id, last_heartbeat_at FROM servers WHERE status = 'online' AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?)",
    )
    .bind(cutoff)
    .all<{ id: string; name: string; user_id: string; last_heartbeat_at: number | null }>();

  for (const server of staleServers.results) {
    logger.info({ serverId: server.id, serverName: server.name }, 'Server heartbeat timeout — marking offline');

    await env.DB
      .prepare("UPDATE servers SET status = 'offline' WHERE id = ?")
      .bind(server.id)
      .run();

    await logAudit(
      {
        userId: server.user_id,
        serverId: server.id,
        action: 'server.offline',
        details: { lastHeartbeat: server.last_heartbeat_at, reason: 'heartbeat_timeout' },
      },
      env.DB,
    );

    // TODO: Push notification to user's registered devices (section 10)
    // await notifyUser(server.user_id, `Server "${server.name}" is offline`, env);
  }

  logger.info({ markedOffline: staleServers.results.length }, 'Health check cron complete');
}
