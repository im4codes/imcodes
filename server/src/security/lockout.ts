/**
 * Auth lockout: 5 failed attempts → 15 min lockout per IP/identity.
 * DB-backed (PostgreSQL) for multi-instance deployments.
 *
 * rateLimiter singleton is kept for WS JTI single-use tracking only.
 */
import { MemoryRateLimiter } from '../ws/rate-limiter.js';
import type { PgDatabase } from '../db/client.js';
import logger from '../util/logger.js';

export interface LockoutResult {
  locked: boolean;
  lockedUntil?: number;
}

/** Singleton used for WS JTI single-use tracking (not auth lockout). */
export const rateLimiter = new MemoryRateLimiter();

/**
 * Record an auth failure for an identity (IP or user_id).
 * Returns whether the identity is now locked out.
 * Requires DB — uses auth_lockout table (migration 004).
 */
export async function recordAuthFailure(
  db: PgDatabase,
  identity: string,
): Promise<LockoutResult> {
  const row = await db.prepare(`
    INSERT INTO auth_lockout (identity, fail_count, first_fail_at)
    VALUES (?, 1, NOW())
    ON CONFLICT (identity) DO UPDATE SET
      fail_count = CASE
        WHEN auth_lockout.first_fail_at < NOW() - INTERVAL '15 minutes' THEN 1
        ELSE auth_lockout.fail_count + 1
      END,
      first_fail_at = CASE
        WHEN auth_lockout.first_fail_at < NOW() - INTERVAL '15 minutes' THEN NOW()
        ELSE auth_lockout.first_fail_at
      END,
      locked_until = CASE
        WHEN (CASE
          WHEN auth_lockout.first_fail_at < NOW() - INTERVAL '15 minutes' THEN 1
          ELSE auth_lockout.fail_count + 1
        END) >= 5
          THEN NOW() + INTERVAL '15 minutes'
        ELSE NULL
      END
    RETURNING fail_count, locked_until
  `).bind(identity).first<{ fail_count: number; locked_until: Date | null }>();

  const isLocked = !!row?.locked_until;
  const lockedUntil = row?.locked_until ? new Date(row.locked_until).getTime() : undefined;

  if (isLocked) {
    logger.warn({ identity }, 'Auth identity locked out');
  }

  return { locked: isLocked, lockedUntil };
}

/**
 * Check if an identity is currently locked out.
 */
export async function checkAuthLockout(
  db: PgDatabase,
  identity: string,
): Promise<LockoutResult> {
  const row = await db.prepare(
    `SELECT locked_until FROM auth_lockout
     WHERE identity = ? AND locked_until > NOW()`,
  ).bind(identity).first<{ locked_until: Date }>();

  if (!row) return { locked: false };

  return {
    locked: true,
    lockedUntil: new Date(row.locked_until).getTime(),
  };
}
