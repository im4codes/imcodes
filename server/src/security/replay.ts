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

import type { Database } from '../db/client.js';

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
  db: Database,
): Promise<{ status: number; body: string } | null> {
  const row = await db.queryOne<{ response_status: number; response_body: string }>(
    'SELECT response_status, response_body FROM idempotency_records WHERE key = $1 AND user_id = $2',
    [key, userId],
  );

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
  db: Database,
): Promise<void> {
  await db.execute(
    'INSERT INTO idempotency_records (key, user_id, response_status, response_body, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
    [key, userId, status, body, Date.now()],
  );
}

/**
 * Clean up idempotency records older than 24 hours.
 * Called by scheduled cron.
 */
export async function cleanupIdempotencyRecords(db: Database): Promise<number> {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const result = await db.execute('DELETE FROM idempotency_records WHERE created_at < $1', [cutoff]);
  return result.changes ?? 0;
}
