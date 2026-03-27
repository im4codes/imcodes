/**
 * Audit logging: all state-changing ops logged to audit_log table.
 * 90-day retention enforced by scheduled cleanup cron.
 */
import type { Database } from '../db/client.js';
import { randomHex } from './crypto.js';
import logger from '../util/logger.js';

export interface AuditEntry {
  userId?: string;
  serverId?: string;
  action: string;
  details?: Record<string, unknown>;
  ip?: string;
}

/**
 * Write an audit log entry to the database.
 * Errors are logged but do not fail the calling operation.
 */
export async function logAudit(entry: AuditEntry, db: Database): Promise<void> {
  try {
    await db.execute(
      'INSERT INTO audit_log (id, user_id, server_id, action, details, ip, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [
        randomHex(16),
        entry.userId ?? null,
        entry.serverId ?? null,
        entry.action,
        entry.details ? JSON.stringify(entry.details) : null,
        entry.ip ?? null,
        Date.now(),
      ],
    );
  } catch (err) {
    logger.error({ action: entry.action, err }, 'Audit log write failed');
  }
}

/**
 * Clean up audit log entries older than 90 days.
 * Called by scheduled cron.
 */
export async function cleanupAuditLog(db: Database): Promise<number> {
  const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
  const result = await db.execute('DELETE FROM audit_log WHERE created_at < $1', [cutoff]);
  return result.changes ?? 0;
}

/**
 * Hono middleware that logs all POST/PUT/DELETE requests to audit_log.
 */
export function auditMiddleware(db: Database) {
  return async (c: { req: { method: string; url: string }; var: Record<string, unknown>; next?: () => Promise<void> }, next: () => Promise<void>) => {
    const method = c.req.method;
    // Only log state-changing operations
    if (method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH') {
      await logAudit(
        {
          userId: c.var['userId'] as string | undefined,
          serverId: c.var['serverId'] as string | undefined,
          action: `${method} ${new URL(c.req.url).pathname}`,
        },
        db,
      );
    }
    await next();
  };
}
