import type { Database } from '../db/client.js';

/**
 * Determine whether `serverId` is currently exposed to any user other than its owner:
 * active server/session/sub-session shares or membership in a machine group containing non-owner users.
 * Returns `false` safely when given a minimal unit-test mock DB without `query`.
 */
export async function isSharedOrContributedServer(
  db: Database,
  serverId: string,
  now = Date.now(),
): Promise<boolean> {
  if (!serverId || typeof (db as { query?: unknown })?.query !== 'function') {
    return false;
  }
  const result = await db.query<{ shared?: boolean }>(
    `SELECT (
       EXISTS (
         SELECT 1 FROM server_shares
          WHERE server_id = $1
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > $2)
       )
       OR EXISTS (
         SELECT 1 FROM session_shares
          WHERE server_id = $1
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > $2)
       )
       OR EXISTS (
         SELECT 1 FROM sub_session_shares
          WHERE server_id = $1
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > $2)
       )
       OR EXISTS (
         SELECT 1
           FROM machine_groups mg
           JOIN team_members tm ON tm.team_id = mg.team_id
           JOIN servers s ON s.id = mg.server_id
          WHERE mg.server_id = $1
            AND tm.user_id <> s.user_id
       )
     ) AS shared`,
    [serverId, now],
  ) as unknown;
  const rows = Array.isArray(result) ? result : (result as { rows?: Array<{ shared?: boolean }> })?.rows;
  return Boolean(rows?.[0]?.shared);
}

/**
 * Detect whether `userId` currently accesses `serverId` via an active whole-server share
 * (which `resolveServerRole` maps to `'owner'` for participant compatibility, even though
 * they do not actually own the server).
 */
export async function isWholeServerShareUser(
  db: Database,
  serverId: string,
  userId: string,
  now = Date.now(),
): Promise<boolean> {
  if (!serverId || !userId || typeof (db as { query?: unknown })?.query !== 'function') {
    return false;
  }
  const result = await db.query<{ shared?: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM server_shares ss
         JOIN servers s ON s.id = ss.server_id
        WHERE ss.server_id = $1
          AND ss.target_user_id = $2
          AND s.user_id <> $2
          AND ss.revoked_at IS NULL
          AND (ss.expires_at IS NULL OR ss.expires_at > $3)
     ) AS shared`,
    [serverId, userId, now],
  ) as unknown;
  const rows = Array.isArray(result) ? result : (result as { rows?: Array<{ shared?: boolean }> })?.rows;
  return Boolean(rows?.[0]?.shared);
}

/**
 * Immediately pause shared-provenance cron jobs when a share or team grant is revoked.
 * Dispatch also re-checks authorization as a second line of defense.
 */
export async function pauseRevokedSharedCronJobs(
  db: Database,
  input: { serverId?: string; userId?: string; teamId?: string; now?: number },
): Promise<void> {
  if (typeof (db as { execute?: unknown })?.execute !== 'function') return;
  const now = input.now ?? Date.now();
  if (input.serverId && input.userId) {
    await db.execute(
      `UPDATE cron_jobs
          SET status = 'paused',
              updated_at = $3
        WHERE status IN ('active', 'idle')
          AND id IN (
            SELECT job_id FROM cron_job_provenance
             WHERE server_id = $1
               AND creator_user_id = $2
               AND shared = TRUE
          )`,
      [input.serverId, input.userId, now],
    );
    return;
  }
  if (input.teamId && input.userId) {
    await db.execute(
      `UPDATE cron_jobs
          SET status = 'paused',
              updated_at = $3
        WHERE status IN ('active', 'idle')
          AND id IN (
            SELECT p.job_id
              FROM cron_job_provenance p
              JOIN machine_groups mg ON mg.server_id = p.server_id
             WHERE mg.team_id = $1
               AND p.creator_user_id = $2
               AND p.shared = TRUE
          )`,
      [input.teamId, input.userId, now],
    );
  }
}
