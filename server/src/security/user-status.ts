/**
 * Can this user act right now? The server-side half of shared/user-status.ts, and the ONLY place that answers it.
 *
 * Every credential the server accepts (login cookie / bearer JWT, API key, daemon server-token, tickets, share and guest authority, scheduled
 * jobs) names a user, and none of them may outlive the account being switched off. Each caller asks one of three things here:
 *   - {@link loadUserAccess} / {@link evaluateUserAccess}: a login token's user, by primary key (status + the sessions epoch);
 *   - {@link ACTIVE_USER_SQL} / {@link activeUserExistsSql}: the same rule as a SQL predicate, so a lookup that already reads the credential
 *     row asks about the user in the SAME statement instead of paying a second round trip;
 *   - {@link isUserActive} / {@link filterActiveUsers}: a user id that arrived some other way (a ticket's `sub`, a grantee, a job owner).
 *
 * Nothing is cached: the state is read from PostgreSQL every time. The server runs several replicas and an in-memory cache is per pod, so
 * a cached "active" would keep a disabled user alive on every other pod until its TTL; a primary-key read costs well under a millisecond
 * and, for API keys and daemon tokens, no extra round trip at all (a scalar subquery in the credential's own statement). Measured on
 * 20k users / 100k keys / 5k servers: +0.04-0.06 ms p50 for keys and daemon tokens, +0.15 ms for a stateless login token (which used to
 * touch no database at all).
 */
import type { Database } from '../db/client.js';
import { USER_STATUS, isUserStatusActive, userStatusDenialCode } from '../../../shared/user-status.js';
import type { AuthErrorCode } from '../../../shared/auth-error-codes.js';

/** `u` must be the alias of the users table in the statement this is spliced into. The constant is ours, never user input. */
export const ACTIVE_USER_SQL = `u.status = '${USER_STATUS.ACTIVE}'`;

/** `EXISTS (...)` form for a column that holds a user id: `activeUserExistsSql('t.user_id')`. */
export function activeUserExistsSql(column: string): string {
  return `EXISTS (SELECT 1 FROM users u WHERE u.id = ${column} AND ${ACTIVE_USER_SQL})`;
}

export interface UserAccess {
  status: string;
  /** Login tokens issued before this instant (ms) were ended by an admin; 0 = none. */
  sessionsValidAfter: number;
}

export type UserAccessDecision =
  | { ok: true }
  | { ok: false; code: AuthErrorCode };

export async function loadUserAccess(db: Database, userId: string): Promise<UserAccess | null> {
  const row = await db.queryOne<{ status: string; sessions_valid_after: string | number }>(
    'SELECT status, sessions_valid_after FROM users WHERE id = $1',
    [userId],
  );
  return row ? { status: row.status, sessionsValidAfter: Number(row.sessions_valid_after) } : null;
}

/**
 * The decision for a LOGIN token of this user. `issuedAtSeconds` is the token's `iat`; a token minted before an admin ended the user's
 * sessions is refused even if the account was enabled again since (enabling never resurrects what disabling ended).
 */
export function evaluateUserAccess(access: UserAccess | null, issuedAtSeconds?: number): UserAccessDecision {
  if (!access) return { ok: false, code: userStatusDenialCode(USER_STATUS.DISABLED) };
  if (!isUserStatusActive(access.status)) return { ok: false, code: userStatusDenialCode(access.status) };
  if (access.sessionsValidAfter > 0 && typeof issuedAtSeconds === 'number' && issuedAtSeconds * 1000 < access.sessionsValidAfter) {
    return { ok: false, code: userStatusDenialCode(USER_STATUS.DISABLED) };
  }
  return { ok: true };
}

export async function isUserActive(db: Database, userId: string): Promise<boolean> {
  const row = await db.queryOne<{ status: string }>('SELECT status FROM users WHERE id = $1', [userId]);
  return isUserStatusActive(row?.status);
}

/** The subset of `userIds` that may act (one statement for any number of ids). */
export async function filterActiveUsers(db: Database, userIds: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Set();
  const rows = await db.query<{ id: string }>(
    `SELECT u.id FROM users u WHERE u.id = ANY($1::text[]) AND ${ACTIVE_USER_SQL}`,
    [unique],
  );
  return new Set(rows.map((row) => row.id));
}

/** The subset of `userIds` that must NOT act (disabled, pending, or gone). The watcher's input. */
export async function findInactiveUsers(db: Database, userIds: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Set();
  const active = await filterActiveUsers(db, unique);
  return new Set(unique.filter((id) => !active.has(id)));
}

/**
 * A user acting on a server: BOTH the actor and the server's owner must be active. The actor because a disabled user operates nothing;
 * the owner because a server acts as its owner (its daemon is refused when the owner is disabled), so anything shared out of it stops
 * with it. One round trip for both.
 */
export async function isActorAndServerOwnerActive(db: Database, userId: string, serverId: string): Promise<boolean> {
  const row = await db.queryOne<{ actor_status: string | null; owner_status: string | null }>(
    `SELECT (SELECT u.status FROM users u WHERE u.id = $1) AS actor_status,
            (SELECT o.status FROM servers s JOIN users o ON o.id = s.user_id WHERE s.id = $2) AS owner_status`,
    [userId, serverId],
  );
  return isUserStatusActive(row?.actor_status) && isUserStatusActive(row?.owner_status);
}
