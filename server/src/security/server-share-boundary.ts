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

/**
 * Authorize whether `userId` may view or edit their own `blockPrivateDevices` self-protection
 * setting for `serverId`. Allowed only for an active user who is the server's real owner, a team
 * member via `machine_groups`, or an active collaborator (`server_shares`/`session_shares`/`sub_session_shares`).
 */
export async function canManageOwnPrivateDevicePolicy(
  db: Database,
  serverId: string,
  userId: string,
  now = Date.now(),
): Promise<boolean> {
  if (!serverId || !userId || typeof (db as { query?: unknown })?.query !== 'function') {
    return false;
  }
  const result = await db.query<{ allowed?: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM servers s
         JOIN users u ON u.id = $2 AND u.status = 'active'
         JOIN users o ON o.id = s.user_id AND o.status = 'active'
        WHERE s.id = $1
          AND s.revoked_at IS NULL
          AND (
            s.user_id = $2
            OR EXISTS (
              SELECT 1
                FROM machine_groups mg
                JOIN team_members tm ON tm.team_id = mg.team_id
               WHERE mg.server_id = s.id
                 AND tm.user_id = $2
            )
            OR EXISTS (
              SELECT 1
                FROM server_shares ss
               WHERE ss.server_id = s.id
                 AND ss.target_user_id = $2
                 AND ss.revoked_at IS NULL
                 AND (ss.expires_at IS NULL OR ss.expires_at > $3)
            )
            OR EXISTS (
              SELECT 1
                FROM session_shares sh
               WHERE sh.server_id = s.id
                 AND sh.target_user_id = $2
                 AND sh.revoked_at IS NULL
                 AND (sh.expires_at IS NULL OR sh.expires_at > $3)
            )
            OR EXISTS (
              SELECT 1
                FROM sub_session_shares sb
               WHERE sb.server_id = s.id
                 AND sb.target_user_id = $2
                 AND sb.revoked_at IS NULL
                 AND (sb.expires_at IS NULL OR sb.expires_at > $3)
            )
          )
     ) AS allowed`,
    [serverId, userId, now],
  ) as unknown;
  const rows = Array.isArray(result) ? result : (result as { rows?: Array<{ allowed?: boolean }> })?.rows;
  return Boolean(rows?.[0]?.allowed);
}

/** Read one user's self-protection toggle for `serverId`; defaults to `false` when unset. */
export async function getServerPrivateDeviceBlock(
  db: Database,
  serverId: string,
  userId: string,
): Promise<boolean> {
  if (!serverId || !userId || typeof (db as { queryOne?: unknown })?.queryOne !== 'function') {
    return false;
  }
  const row = await db.queryOne<{ block_private_devices?: boolean }>(
    `SELECT block_private_devices
       FROM server_private_device_blocks
      WHERE server_id = $1 AND user_id = $2
      LIMIT 1`,
    [serverId, userId],
  );
  return row?.block_private_devices === true;
}

/** Batch-read which `serverIds` have `block_private_devices = true` for `userId`. */
export async function listServerPrivateDeviceBlocksForUser(
  db: Database,
  userId: string,
  serverIds: readonly string[],
): Promise<Set<string>> {
  const unique = [...new Set(serverIds.filter((id) => typeof id === 'string' && id.length > 0))];
  if (!userId || unique.length === 0 || typeof (db as { query?: unknown })?.query !== 'function') {
    return new Set();
  }
  const rows = await db.query<{ server_id: string }>(
    `SELECT server_id
       FROM server_private_device_blocks
      WHERE user_id = $1
        AND server_id = ANY($2::text[])
        AND block_private_devices = TRUE`,
    [userId, unique],
  );
  const rowList = Array.isArray(rows) ? rows : ((rows as { rows?: Array<{ server_id: string }> })?.rows ?? []);
  return new Set(rowList.map((r) => r.server_id));
}

/** Upsert ONLY the authenticated user's own self-protection toggle on `serverId`. */
export async function setServerPrivateDeviceBlock(
  db: Database,
  serverId: string,
  userId: string,
  blockPrivateDevices: boolean,
  now = Date.now(),
): Promise<void> {
  await db.execute(
    `INSERT INTO server_private_device_blocks (server_id, user_id, block_private_devices, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (server_id, user_id)
     DO UPDATE SET block_private_devices = excluded.block_private_devices, updated_at = excluded.updated_at`,
    [serverId, userId, blockPrivateDevices, now],
  );
}

/** Batch lookup of active shared/group-contributed server IDs among `serverIds`. */
export async function findSharedOrContributedServerIds(
  db: Database,
  serverIds: readonly string[],
  now = Date.now(),
): Promise<Set<string>> {
  const unique = [...new Set(serverIds.filter((id) => typeof id === 'string' && id.length > 0))];
  if (unique.length === 0 || typeof (db as { query?: unknown })?.query !== 'function') {
    return new Set();
  }
  const rows = await db.query<{ id: string }>(
    `SELECT s.id
       FROM servers s
      WHERE s.id = ANY($1::text[])
        AND (
          EXISTS (
            SELECT 1 FROM server_shares ss
             WHERE ss.server_id = s.id AND ss.revoked_at IS NULL
               AND (ss.expires_at IS NULL OR ss.expires_at > $2)
          )
          OR EXISTS (
            SELECT 1 FROM session_shares sh
             WHERE sh.server_id = s.id AND sh.revoked_at IS NULL
               AND (sh.expires_at IS NULL OR sh.expires_at > $2)
          )
          OR EXISTS (
            SELECT 1 FROM sub_session_shares sb
             WHERE sb.server_id = s.id AND sb.revoked_at IS NULL
               AND (sb.expires_at IS NULL OR sb.expires_at > $2)
          )
          OR EXISTS (
            SELECT 1
              FROM machine_groups mg
              JOIN team_members tm ON tm.team_id = mg.team_id
             WHERE mg.server_id = s.id
               AND tm.user_id <> s.user_id
          )
        )`,
    [unique, now],
  );
  const rowList = Array.isArray(rows) ? rows : ((rows as { rows?: Array<{ id: string }> })?.rows ?? []);
  return new Set(rowList.map((r) => r.id));
}

/**
 * Symmetric daemon-originated self-protection guard ("各自保护自己"):
 * When `(sourceServerId, actingUserId)` has `block_private_devices = true`, `sourceServerId`'s
 * daemon may NEVER enumerate or control `actingUserId`'s own unshared private devices — even on turns
 * initiated by `actingUserId` themselves. Shared devices, other users on `sourceServerId`, browser/mobile UI,
 * and other hosts with the toggle off remain completely unaffected.
 */
export async function isPrivateDeviceBlockedForActorOnSource(
  db: Database,
  input: {
    sourceServerId?: string | null;
    actingUserId: string;
    targetServerId: string;
    targetOwnerUserId?: string | null;
    now?: number;
  },
): Promise<boolean> {
  const sourceServerId = input.sourceServerId?.trim();
  if (!sourceServerId || !input.actingUserId || !input.targetServerId || input.targetServerId === sourceServerId) {
    return false;
  }
  if (!await getServerPrivateDeviceBlock(db, sourceServerId, input.actingUserId)) {
    return false;
  }
  let targetOwnerUserId = input.targetOwnerUserId ?? null;
  if (!targetOwnerUserId && typeof (db as { queryOne?: unknown })?.queryOne === 'function') {
    const row = await db.queryOne<{ user_id: string }>('SELECT user_id FROM servers WHERE id = $1 LIMIT 1', [input.targetServerId]);
    targetOwnerUserId = row?.user_id ?? null;
  }
  if (targetOwnerUserId !== input.actingUserId) {
    return false;
  }
  const now = input.now ?? Date.now();
  return !(await isSharedOrContributedServer(db, input.targetServerId, now));
}
