/**
 * Test doubles that stand in for the `users` table now that every credential is followed by an account check
 * (security/user-status.ts). A fake database that answers credential lookups must also answer "is this user active?", or the
 * request is refused -- which is the fail-closed behaviour the fix exists for.
 */
export const ACTIVE_USER_ROW = Object.freeze({ status: 'active', sessions_valid_after: 0 });

/** True for the primary-key account lookup (`SELECT status, sessions_valid_after FROM users WHERE id = $1`). */
export function isUserAccessQuery(sql: string): boolean {
  return /select status, sessions_valid_after from users where id = \$1/i.test(sql.replace(/\s+/g, ' '));
}

/** True for the actor-and-server-owner check (`SELECT (SELECT u.status ...) AS actor_status, (SELECT ...) AS owner_status`). */
export function isActorOwnerQuery(sql: string): boolean {
  return /^\s*select \(select u\.status from users u where u\.id = \$1\) as actor_status/i.test(sql.replace(/\s+/g, ' '));
}

/**
 * The answer for the account lookups a credential is followed by: `{ status: 'active', sessions_valid_after: 0 }` for the primary-key
 * lookup, both-active for the actor-and-owner check, `undefined` for every other statement (the fake handles those itself).
 */
export function activeUserAnswer(sql: string): Record<string, unknown> | undefined {
  if (isUserAccessQuery(sql)) return ACTIVE_USER_ROW;
  if (isActorOwnerQuery(sql)) return { actor_status: 'active', owner_status: 'active' };
  return undefined;
}
