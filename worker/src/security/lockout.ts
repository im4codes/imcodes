/**
 * Auth lockout: 5 failed attempts → 15 min lockout per user/IP.
 * Uses the RateLimiter Durable Object for distributed tracking.
 */
import type { Env } from '../types.js';
import logger from '../util/logger.js';

/**
 * Record an auth failure for an identity (user_id or IP).
 * Returns whether the identity is now locked out.
 */
export async function recordAuthFailure(
  identity: string,
  env: Env,
): Promise<{ locked: boolean; lockedUntil?: number }> {
  const id = env.RATE_LIMITER.idFromName(`auth:${identity}`);
  const stub = env.RATE_LIMITER.get(id);
  const res = await stub.fetch(
    new Request(`https://dummy/?key=${encodeURIComponent(identity)}&type=auth_fail`),
  );
  const data = await res.json<{ locked: boolean; lockedUntil?: number }>();

  if (data.locked) {
    logger.warn({ identity }, 'Auth identity locked out');
  }

  return data;
}

/**
 * Check if an identity is currently locked out.
 */
export async function checkAuthLockout(
  identity: string,
  env: Env,
): Promise<{ locked: boolean; lockedUntil?: number }> {
  const id = env.RATE_LIMITER.idFromName(`auth:${identity}`);
  const stub = env.RATE_LIMITER.get(id);
  const res = await stub.fetch(
    new Request(`https://dummy/?key=${encodeURIComponent(identity)}&type=auth_check`),
  );
  return res.json<{ locked: boolean; lockedUntil?: number }>();
}

/**
 * Get client IP from request headers.
 * CF Workers provide CF-Connecting-IP.
 */
export function getClientIp(req: Request): string {
  return req.headers.get('CF-Connecting-IP')
    ?? req.headers.get('X-Forwarded-For')?.split(',')[0].trim()
    ?? 'unknown';
}
