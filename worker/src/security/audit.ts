/**
 * Audit logging: all state-changing ops logged to D1 audit_log.
 * 90-day retention enforced by scheduled cleanup cron.
 */
import type { Env } from '../types.js';
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
 * Write an audit log entry to D1.
 * Errors are logged but do not fail the calling operation.
 */
export async function logAudit(entry: AuditEntry, db: Env['DB']): Promise<void> {
  try {
    await db
      .prepare(
        'INSERT INTO audit_log (id, user_id, server_id, action, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        randomHex(16),
        entry.userId ?? null,
        entry.serverId ?? null,
        entry.action,
        entry.details ? JSON.stringify(entry.details) : null,
        entry.ip ?? null,
        Date.now(),
      )
      .run();
  } catch (err) {
    logger.error({ action: entry.action, err }, 'Audit log write failed');
  }
}

/**
 * Clean up audit log entries older than 90 days.
 * Called by scheduled cron.
 */
export async function cleanupAuditLog(db: Env['DB']): Promise<number> {
  const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
  const result = await db
    .prepare('DELETE FROM audit_log WHERE created_at < ?')
    .bind(cutoff)
    .run();
  return result.meta.changes ?? 0;
}

/**
 * Hono middleware that logs all POST/PUT/DELETE requests to audit_log.
 */
export function auditMiddleware(env: Env) {
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
        env.DB,
      );
    }
    await next();
  };
}
