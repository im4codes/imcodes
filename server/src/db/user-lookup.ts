import type { Database } from './client.js';

export interface ResolvedUser {
  id: string;
  display_name: string | null;
  username: string | null;
}

/**
 * Find one user by the identifier a person actually types: their username, or
 * a raw user id pasted from somewhere.
 *
 * An exact id wins over a username that happens to equal it, so a username can
 * never shadow an account. Returns null rather than throwing: every caller here
 * is answering "is there such a person", and the distinction between "no such
 * user" and "you may not see them" is deliberately not made to the caller.
 */
export async function resolveUserByIdentifier(
  db: Database,
  input: string,
): Promise<ResolvedUser | null> {
  const identifier = input.trim();
  if (!identifier) return null;
  return db.queryOne<ResolvedUser>(
    `SELECT id, display_name, username
       FROM users
      WHERE id = $1 OR lower(username) = lower($1)
      ORDER BY CASE WHEN id = $1 THEN 0 ELSE 1 END
      LIMIT 1`,
    [identifier],
  );
}
