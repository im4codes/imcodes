/**
 * Parameterized query helpers for the user-level alias store (`user_aliases`).
 *
 * Every statement is scoped to a single owner via `WHERE user_id = $1` — there is
 * no cross-user read/write path. Rows are projected to the canonical wire shape
 * {@link AliasEntry} (ISO-string timestamps; `id`/`user_id` never exposed).
 *
 * The alias `value` is the user's own exact text and is treated as sensitive: it
 * is only ever bound as a parameter and returned to the owner — it is never
 * interpolated into log lines here.
 */

import type { Database } from './client.js';
import {
  type AliasEntry,
  type AliasSource,
  normalizeAliasValueForStorage,
  nfc,
} from '../../../shared/alias-types.js';

/** Default upper bound on rows returned by {@link listAliases}. */
export const ALIAS_LIST_LIMIT = 500;

interface DbAliasRow {
  name: string;
  value: string;
  description: string | null;
  tags: string[] | string | null;
  source: string;
  created_at: number;
  updated_at: number;
}

/** Coerce the `tags` JSONB column (parsed array OR raw JSON string) into string[]. */
function coerceTags(raw: string[] | string | null | undefined): string[] {
  if (raw == null) return [];
  let parsed: unknown = raw;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((t): t is string => typeof t === 'string');
}

/** Narrow an arbitrary stored source string to the {@link AliasSource} union. */
function coerceSource(raw: string): AliasSource {
  return raw === 'mcp' ? 'mcp' : 'web';
}

/** Project a raw DB row into the canonical {@link AliasEntry} wire shape. */
function projectAliasRow(row: DbAliasRow): AliasEntry {
  const entry: AliasEntry = {
    name: row.name,
    value: row.value,
    tags: coerceTags(row.tags),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    source: coerceSource(row.source),
  };
  if (row.description != null) entry.description = row.description;
  return entry;
}

const SELECT_COLUMNS = 'name, value, description, tags, source, created_at, updated_at';

/**
 * Escape LIKE/ILIKE metacharacters so a stored literal `%`, `_`, or `\` in the
 * user's query is matched literally (not as a wildcard). Pairs with an explicit
 * `ESCAPE '\'` clause. Order matters: escape the escape char first.
 */
function escapeLikeLiteral(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export interface UpsertAliasParams {
  id: string;
  userId: string;
  /** Already NFC-validated name. */
  name: string;
  /** Raw value; stored after {@link normalizeAliasValueForStorage}. */
  value: string;
  /** Optional description; stored NFC-normalized. */
  description?: string | null;
  tags?: string[];
  source: AliasSource;
}

/**
 * Insert or update an alias keyed on `(user_id, name)`. On conflict, the value,
 * description, tags, source, and `updated_at` are refreshed; `created_at` and the
 * row `id` are preserved. Returns the resulting canonical entry.
 */
export async function upsertAlias(db: Database, params: UpsertAliasParams): Promise<AliasEntry> {
  const now = Date.now();
  const storedValue = normalizeAliasValueForStorage(params.value);
  const storedDescription = params.description != null ? nfc(params.description) : null;
  const tags = params.tags ?? [];
  await db.execute(
    `INSERT INTO user_aliases (id, user_id, name, value, description, tags, source, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
     ON CONFLICT (user_id, name) DO UPDATE SET
       value = EXCLUDED.value,
       description = EXCLUDED.description,
       tags = EXCLUDED.tags,
       source = EXCLUDED.source,
       updated_at = EXCLUDED.updated_at`,
    [
      params.id,
      params.userId,
      params.name,
      storedValue,
      storedDescription,
      JSON.stringify(tags),
      params.source,
      now,
      now,
    ],
  );
  const row = await db.queryOne<DbAliasRow>(
    `SELECT ${SELECT_COLUMNS} FROM user_aliases WHERE user_id = $1 AND name = $2`,
    [params.userId, params.name],
  );
  if (!row) throw new Error('alias_upsert_failed');
  return projectAliasRow(row);
}

/** Fetch a single alias by exact (NFC) name for the given owner, or null. */
export async function getAliasByName(db: Database, userId: string, name: string): Promise<AliasEntry | null> {
  const row = await db.queryOne<DbAliasRow>(
    `SELECT ${SELECT_COLUMNS} FROM user_aliases WHERE user_id = $1 AND name = $2`,
    [userId, name],
  );
  return row ? projectAliasRow(row) : null;
}

/** Delete an alias by name for the given owner. Returns true when a row was removed. */
export async function deleteAlias(db: Database, userId: string, name: string): Promise<boolean> {
  const result = await db.execute(
    'DELETE FROM user_aliases WHERE user_id = $1 AND name = $2',
    [userId, name],
  );
  return (result.changes ?? 0) > 0;
}

export interface ListAliasesOptions {
  /** Optional NFC literal substring filter over name + description. */
  q?: string;
  /** Row cap (defaults to {@link ALIAS_LIST_LIMIT}). */
  limit?: number;
}

/**
 * List a user's aliases ordered by name. When `q` is provided, it is matched as a
 * literal (LIKE-escaped) case-insensitive substring against name OR description.
 */
export async function listAliases(db: Database, userId: string, opts?: ListAliasesOptions): Promise<AliasEntry[]> {
  const limit = Math.max(1, Math.min(opts?.limit ?? ALIAS_LIST_LIMIT, ALIAS_LIST_LIMIT));
  const rawQ = opts?.q != null ? nfc(opts.q).trim() : '';
  if (rawQ) {
    const pattern = `%${escapeLikeLiteral(rawQ)}%`;
    const rows = await db.query<DbAliasRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM user_aliases
        WHERE user_id = $1
          AND (name ILIKE $2 ESCAPE '\\' OR description ILIKE $2 ESCAPE '\\')
        ORDER BY name ASC
        LIMIT $3`,
      [userId, pattern, limit],
    );
    return rows.map(projectAliasRow);
  }
  const rows = await db.query<DbAliasRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM user_aliases
      WHERE user_id = $1
      ORDER BY name ASC
      LIMIT $2`,
    [userId, limit],
  );
  return rows.map(projectAliasRow);
}
