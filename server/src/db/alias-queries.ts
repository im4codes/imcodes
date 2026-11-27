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
import { encryptAliasField, decryptAliasField } from '../security/crypto.js';
import {
  type AliasEntry,
  type AliasSource,
  normalizeAliasValueForStorage,
  nfc,
} from '../../../shared/alias-types.js';

/** Default upper bound on rows returned by {@link listAliases}. */
export const ALIAS_LIST_LIMIT = 500;

export const ALIAS_ENCRYPTION_VERSION_PLAINTEXT = 0;
export const ALIAS_ENCRYPTION_VERSION_AES_GCM = 1;

interface DbAliasRow {
  id: string;
  name: string;
  value: string;
  description: string | null;
  tags: string[] | string | null;
  source: string;
  encryption_version: number;
  created_at: number;
  updated_at: number;
}

interface DbAliasMigrationRow {
  id: string;
  user_id: string;
  value: string;
  description: string | null;
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
function projectAliasRow(row: DbAliasRow, userId: string, encryptionKey: string): AliasEntry {
  const version = Number(row.encryption_version);
  let value: string;
  let description: string | null;

  if (version === ALIAS_ENCRYPTION_VERSION_AES_GCM) {
    value = decryptAliasField(row.value, encryptionKey, userId, 'value');
    description = row.description != null
      ? decryptAliasField(row.description, encryptionKey, userId, 'description')
      : null;
  } else if (version === ALIAS_ENCRYPTION_VERSION_PLAINTEXT) {
    value = row.value;
    description = row.description;
  } else {
    throw new Error('alias_unsupported_encryption_version');
  }

  const entry: AliasEntry = {
    id: row.id,
    name: row.name,
    value,
    tags: coerceTags(row.tags),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    source: coerceSource(row.source),
  };
  if (description != null) entry.description = description;
  return entry;
}

const SELECT_COLUMNS = 'id, name, value, description, tags, source, encryption_version, created_at, updated_at';

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
  /** When present, update this owned row in place so durable references survive a rename. */
  existingId?: string;
}

/**
 * Insert or update an alias keyed on `(user_id, name)`. Encrypts `value` and
 * non-null `description` with AES-256-GCM bound to `user_id` before writing.
 * Fails closed if `encryptionKey` is missing/blank.
 */
export async function upsertAlias(
  db: Database,
  params: UpsertAliasParams,
  encryptionKey: string,
): Promise<AliasEntry> {
  const now = Date.now();
  const normalizedValue = normalizeAliasValueForStorage(params.value);
  const normalizedDescription = params.description != null ? nfc(params.description) : null;
  const encryptedValue = encryptAliasField(normalizedValue, encryptionKey, params.userId, 'value');
  const encryptedDescription = normalizedDescription != null
    ? encryptAliasField(normalizedDescription, encryptionKey, params.userId, 'description')
    : null;
  const tags = params.tags ?? [];
  if (params.existingId) {
    const row = await db.queryOne<DbAliasRow>(
      `UPDATE user_aliases
          SET name = $3, value = $4, description = $5, tags = $6::jsonb,
              source = $7, encryption_version = $8, updated_at = $9
        WHERE user_id = $1 AND id = $2
        RETURNING ${SELECT_COLUMNS}`,
      [
        params.userId,
        params.existingId,
        params.name,
        encryptedValue,
        encryptedDescription,
        JSON.stringify(tags),
        params.source,
        ALIAS_ENCRYPTION_VERSION_AES_GCM,
        now,
      ],
    );
    if (!row) throw new Error('alias_not_found');
    return projectAliasRow(row, params.userId, encryptionKey);
  }
  await db.execute(
    `INSERT INTO user_aliases (id, user_id, name, value, description, tags, source, encryption_version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
     ON CONFLICT (user_id, name) DO UPDATE SET
       value = EXCLUDED.value,
       description = EXCLUDED.description,
       tags = EXCLUDED.tags,
       source = EXCLUDED.source,
       encryption_version = EXCLUDED.encryption_version,
       updated_at = EXCLUDED.updated_at`,
    [
      params.id,
      params.userId,
      params.name,
      encryptedValue,
      encryptedDescription,
      JSON.stringify(tags),
      params.source,
      ALIAS_ENCRYPTION_VERSION_AES_GCM,
      now,
      now,
    ],
  );
  const row = await db.queryOne<DbAliasRow>(
    `SELECT ${SELECT_COLUMNS} FROM user_aliases WHERE user_id = $1 AND name = $2`,
    [params.userId, params.name],
  );
  if (!row) throw new Error('alias_upsert_failed');
  return projectAliasRow(row, params.userId, encryptionKey);
}

/** Lightweight owner-scoped existence check without decrypting payload fields. */
export async function aliasExistsById(db: Database, userId: string, id: string): Promise<boolean> {
  const row = await db.queryOne<{ id: string }>(
    `SELECT id FROM user_aliases WHERE user_id = $1 AND id = $2`,
    [userId, id],
  );
  return row !== null;
}

/** Fetch a single alias by its stable owner-scoped row identity. */
export async function getAliasById(
  db: Database,
  userId: string,
  id: string,
  encryptionKey: string,
): Promise<AliasEntry | null> {
  const row = await db.queryOne<DbAliasRow>(
    `SELECT ${SELECT_COLUMNS} FROM user_aliases WHERE user_id = $1 AND id = $2`,
    [userId, id],
  );
  return row ? projectAliasRow(row, userId, encryptionKey) : null;
}

/** Fetch a single alias by exact (NFC) name for the given owner, or null. */
export async function getAliasByName(
  db: Database,
  userId: string,
  name: string,
  encryptionKey: string,
): Promise<AliasEntry | null> {
  const row = await db.queryOne<DbAliasRow>(
    `SELECT ${SELECT_COLUMNS} FROM user_aliases WHERE user_id = $1 AND name = $2`,
    [userId, name],
  );
  return row ? projectAliasRow(row, userId, encryptionKey) : null;
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
 * List a user's aliases ordered by name. When `q` is provided, rows are decrypted
 * and matched as a literal case-insensitive substring against name OR description.
 */
export async function listAliases(
  db: Database,
  userId: string,
  opts: ListAliasesOptions | undefined,
  encryptionKey: string,
): Promise<AliasEntry[]> {
  const limit = Math.max(1, Math.min(opts?.limit ?? ALIAS_LIST_LIMIT, ALIAS_LIST_LIMIT));
  const rawQ = opts?.q != null ? nfc(opts.q).trim() : '';
  if (rawQ) {
    const rows = await db.query<DbAliasRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM user_aliases
        WHERE user_id = $1
        ORDER BY name ASC`,
      [userId],
    );
    const needle = rawQ.toLowerCase();
    const matched: AliasEntry[] = [];
    for (const row of rows) {
      const entry = projectAliasRow(row, userId, encryptionKey);
      const nameMatch = nfc(entry.name).toLowerCase().includes(needle);
      const descMatch = entry.description != null && nfc(entry.description).toLowerCase().includes(needle);
      if (nameMatch || descMatch) {
        matched.push(entry);
        if (matched.length >= limit) break;
      }
    }
    return matched;
  }
  const rows = await db.query<DbAliasRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM user_aliases
      WHERE user_id = $1
      ORDER BY name ASC
      LIMIT $2`,
    [userId, limit],
  );
  return rows.map((row) => projectAliasRow(row, userId, encryptionKey));
}

/**
 * Idempotently encrypt all legacy plaintext rows (`encryption_version = 0`) in
 * bounded batches. Uses keyset pagination and an optimistic `encryption_version = 0`
 * predicate so concurrent writes or multi-pod startups never clobber newer data.
 */
export async function migratePlaintextAliasesToEncrypted(
  db: Database,
  encryptionKey: string,
  batchSize = 100,
): Promise<{ migrated: number; skipped: number }> {
  if (!encryptionKey || !encryptionKey.trim()) {
    return { migrated: 0, skipped: 0 };
  }
  const limit = Math.max(1, Math.trunc(batchSize));
  let migrated = 0;
  let skipped = 0;
  let lastId = '';

  while (true) {
    const rows = await db.query<DbAliasMigrationRow>(
      `SELECT id, user_id, value, description
         FROM user_aliases
        WHERE encryption_version = $1
          AND id > $2
        ORDER BY id ASC
        LIMIT $3`,
      [ALIAS_ENCRYPTION_VERSION_PLAINTEXT, lastId, limit],
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      lastId = row.id;
      const encryptedValue = encryptAliasField(row.value, encryptionKey, row.user_id, 'value');
      const encryptedDescription = row.description != null
        ? encryptAliasField(row.description, encryptionKey, row.user_id, 'description')
        : null;
      const res = await db.execute(
        `UPDATE user_aliases
            SET value = $3,
                description = $4,
                encryption_version = $5
          WHERE id = $1
            AND user_id = $2
            AND encryption_version = $6`,
        [
          row.id,
          row.user_id,
          encryptedValue,
          encryptedDescription,
          ALIAS_ENCRYPTION_VERSION_AES_GCM,
          ALIAS_ENCRYPTION_VERSION_PLAINTEXT,
        ],
      );
      if ((res.changes ?? 0) > 0) {
        migrated += 1;
      } else {
        skipped += 1;
      }
    }

    if (rows.length < limit) break;
  }

  return { migrated, skipped };
}
