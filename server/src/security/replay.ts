/**
 * Replay protection for internal API calls.
 *
 * Platform webhooks use native signature verification:
 * - Discord: Ed25519 + timestamp in signature envelope
 * - Feishu: SHA-256 includes timestamp + nonce
 * - Telegram: secret token (no timestamp — relies on HTTPS + secret)
 *
 * Internal daemon↔server API calls use X-Deck-Timestamp (5-minute window).
 * WebSocket messages include monotonic seq numbers.
 * State-changing ops use Idempotency-Key stored in idempotency_records (24h TTL).
 */

import type { PgDatabase } from '../db/client.js';

const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Verify X-Deck-Timestamp header for internal API calls.
 * Rejects if timestamp is outside the 5-minute window.
 */
export function verifyTimestamp(req: Request): boolean {
  const ts = req.headers.get('X-Deck-Timestamp');
  if (!ts) return false;

  const tsMs = parseInt(ts, 10);
  if (isNaN(tsMs)) return false;

  const now = Date.now();
  return Math.abs(now - tsMs) <= TIMESTAMP_TOLERANCE_MS;
}

/**
 * Handle idempotency: check if this key was already processed.
 * Returns cached response if found, null if new request.
 *
 * Records expire after 24 hours (cleaned up by scheduled cron).
 */
export async function checkIdempotency(
  key: string,
  userId: string,
  db: PgDatabase,
): Promise<{ status: number; body: string } | null> {
  const row = await db
    .prepare('SELECT response_status, response_body FROM idempotency_records WHERE key = ? AND user_id = ?')
    .bind(key, userId)
    .first<{ response_status: number; response_body: string }>();

  if (!row) return null;
  return { status: row.response_status, body: row.response_body };
}

/**
 * Store an idempotency record for a completed request.
 */
export async function recordIdempotency(
  key: string,
  userId: string,
  status: number,
  body: string,
  db: PgDatabase,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO idempotency_records (key, user_id, response_status, response_body, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
    )
    .bind(key, userId, status, body, Date.now())
    .run();
}

/**
 * Clean up idempotency records older than 24 hours.
 * Called by scheduled cron.
 */
export async function cleanupIdempotencyRecords(db: PgDatabase): Promise<number> {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const result = await db
    .prepare('DELETE FROM idempotency_records WHERE created_at < ?')
    .bind(cutoff)
    .run();
  return result.changes ?? 0;
}
