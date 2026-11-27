/**
 * Integration tests for the `user_aliases` store — real PostgreSQL via
 * testcontainers (managed by test/setup/integration-global.ts).
 *
 * Covers the storage contract:
 *   - migration 048 + 119 apply idempotently; UNIQUE(user_id, name); FK -> users ON DELETE CASCADE
 *   - upsert / get-by-name / delete / list (ORDER BY name ASC, bounded limit)
 *   - AES-256-GCM at-rest encryption of `value` and `description` (encryption_version = 1)
 *   - server-side value normalization (CRLF->LF, NFC) via the shared helpers
 *   - list `q` filter matches name + decrypted description as a LITERAL substring
 *   - idempotent startup migration `migratePlaintextAliasesToEncrypted` + concurrency guard
 *   - strict per-user scoping and AAD tampering fail-closed behavior
 *
 * The alias `value` is never asserted into a log line.
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdir } from 'node:fs/promises';
import { createDatabase, type Database } from '../src/db/client.js';
import { isMigrationFile, runMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/queries.js';
import { randomHex } from '../src/security/crypto.js';
import {
  upsertAlias,
  getAliasById,
  getAliasByName,
  deleteAlias,
  listAliases,
  migratePlaintextAliasesToEncrypted,
  ALIAS_LIST_LIMIT,
  ALIAS_ENCRYPTION_VERSION_PLAINTEXT,
  ALIAS_ENCRYPTION_VERSION_AES_GCM,
} from '../src/db/alias-queries.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ENC_KEY = 'integration-test-bot-encryption-key-32bytes';

let db: Database;

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

afterAll(async () => {
  await db.close();
});

async function freshUser(): Promise<string> {
  const id = 'alias-user-' + randomHex(6);
  await createUser(db, id);
  return id;
}

describe('user_aliases migration', () => {
  it('creates the table with expected columns, encryption_version, and partial index', async () => {
    const rows = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'user_aliases'`,
    );
    const cols = new Set(rows.map((r) => r.column_name));
    for (const col of [
      'id', 'user_id', 'name', 'value', 'description', 'tags', 'source',
      'encryption_version', 'created_at', 'updated_at',
    ]) {
      expect(cols.has(col)).toBe(true);
    }

    const indexes = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'user_aliases'`,
    );
    expect(indexes.some((r) => r.indexname === 'idx_user_aliases_unencrypted')).toBe(true);

    // Re-running 119 DDL is idempotent (safe on retry after partial DDL).
    const ddl = await readFile(join(__dirname, '../src/db/migrations/119_user_aliases_encryption.sql'), 'utf8');
    await expect(db.exec(ddl)).resolves.toBeUndefined();
  });

  it('serializes concurrent runMigrations across two connections from partial 119 DDL with no tracking row', async () => {
    const dbName = `imcodes_alias_conc_${randomHex(6)}`;
    await db.exec(`CREATE DATABASE "${dbName}"`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.pathname = `/${dbName}`;
    const connA = createDatabase(url.toString());
    const connB = createDatabase(url.toString());
    try {
      await connA.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)');
      const migrationsDir = join(__dirname, '../src/db/migrations');
      const files = (await readdir(migrationsDir))
        .filter(isMigrationFile)
        .filter((f) => parseInt(f, 10) < 119)
        .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
      for (const file of files) {
        await connA.exec(await readFile(join(migrationsDir, file), 'utf8'));
        await connA.execute('INSERT INTO _migrations (name, applied_at) VALUES ($1, $2)', [file, Date.now()]);
      }
      // Simulate partial 119 DDL (column exists, partial index absent, no _migrations row for 119).
      await connA.exec('ALTER TABLE user_aliases ADD COLUMN IF NOT EXISTS encryption_version SMALLINT NOT NULL DEFAULT 0');

      await Promise.all([runMigrations(connA), runMigrations(connB)]);

      const recorded = await connA.query<{ name: string }>(
        `SELECT name FROM _migrations WHERE name = '119_user_aliases_encryption.sql'`,
      );
      expect(recorded).toHaveLength(1);
      const indexes = await connA.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'user_aliases' AND indexname = 'idx_user_aliases_unencrypted'`,
      );
      expect(indexes).toHaveLength(1);
    } finally {
      await connA.close();
      await connB.close();
      await db.exec(`DROP DATABASE "${dbName}"`);
    }
  });

  it('enforces UNIQUE(user_id, name)', async () => {
    const userId = await freshUser();
    const now = Date.now();
    await db.execute(
      `INSERT INTO user_aliases (id, user_id, name, value, tags, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, '[]'::jsonb, 'web', $5, $5)`,
      [randomHex(16), userId, 'dup', 'v', now],
    );
    await expect(
      db.execute(
        `INSERT INTO user_aliases (id, user_id, name, value, tags, source, created_at, updated_at)
         VALUES ($1, $2, $3, $4, '[]'::jsonb, 'web', $5, $5)`,
        [randomHex(16), userId, 'dup', 'v2', now],
      ),
    ).rejects.toThrow();
  });

  it('cascades on user delete (FK ON DELETE CASCADE)', async () => {
    const userId = await freshUser();
    await upsertAlias(db, { id: randomHex(16), userId, name: 'gone', value: 'v', source: 'web' }, TEST_ENC_KEY);
    await db.execute('DELETE FROM users WHERE id = $1', [userId]);
    const remaining = await db.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM user_aliases WHERE user_id = $1',
      [userId],
    );
    expect(Number(remaining[0]!.cnt)).toBe(0);
  });
});

describe('alias-queries roundtrip & at-rest encryption', () => {
  it('stores ciphertext at rest (encryption_version = 1) and decrypts transparently', async () => {
    const userId = await freshUser();
    const created = await upsertAlias(db, {
      id: randomHex(16),
      userId,
      name: 'server',
      value: 'pron.koca.win',
      description: 'prod host',
      tags: ['infra', 'prod'],
      source: 'web',
    }, TEST_ENC_KEY);
    expect(created.name).toBe('server');
    expect(created.value).toBe('pron.koca.win');
    expect(created.description).toBe('prod host');
    expect(created.tags).toEqual(['infra', 'prod']);
    expect(created.source).toBe('web');
    expect(new Date(created.createdAt).toISOString()).toBe(created.createdAt);
    expect(created.id).toMatch(/^[a-f0-9]{32}$/u);
    expect(created).not.toHaveProperty('user_id');
    expect(created).not.toHaveProperty('encryption_version');

    const raw = await db.queryOne<{ value: string; description: string | null; encryption_version: number }>(
      'SELECT value, description, encryption_version FROM user_aliases WHERE user_id = $1 AND name = $2',
      [userId, 'server'],
    );
    expect(raw?.encryption_version).toBe(ALIAS_ENCRYPTION_VERSION_AES_GCM);
    expect(raw?.value).not.toBe('pron.koca.win');
    expect(raw?.value).not.toContain('pron.koca.win');
    expect(raw?.description).not.toBe('prod host');
    expect(raw?.description).not.toContain('prod host');

    const got = await getAliasByName(db, userId, 'server', TEST_ENC_KEY);
    expect(got?.value).toBe('pron.koca.win');
    expect(got?.description).toBe('prod host');
    expect(got?.tags).toEqual(['infra', 'prod']);
  });

  it('upsert on (user_id, name) updates value/description/tags and preserves created_at', async () => {
    const userId = await freshUser();
    const first = await upsertAlias(db, { id: randomHex(16), userId, name: 'db', value: 'v1', source: 'web' }, TEST_ENC_KEY);
    await new Promise((r) => setTimeout(r, 3));
    const second = await upsertAlias(db, {
      id: randomHex(16),
      userId,
      name: 'db',
      value: 'v2',
      description: 'updated',
      tags: ['x'],
      source: 'mcp',
    }, TEST_ENC_KEY);
    expect(second.value).toBe('v2');
    expect(second.description).toBe('updated');
    expect(second.tags).toEqual(['x']);
    expect(second.source).toBe('mcp');
    expect(second.createdAt).toBe(first.createdAt);
    expect(new Date(second.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(first.updatedAt).getTime());

    const all = await listAliases(db, userId, undefined, TEST_ENC_KEY);
    expect(all).toHaveLength(1); // upsert, not a duplicate row
  });

  it('normalizes value for storage (CRLF -> LF)', async () => {
    const userId = await freshUser();
    const created = await upsertAlias(db, {
      id: randomHex(16),
      userId,
      name: 'multiline',
      value: 'line1\r\nline2\rline3',
      source: 'web',
    }, TEST_ENC_KEY);
    expect(created.value).toBe('line1\nline2\nline3');
  });

  it('delete removes the row and reports whether one was removed', async () => {
    const userId = await freshUser();
    await upsertAlias(db, { id: randomHex(16), userId, name: 'temp', value: 'v', source: 'web' }, TEST_ENC_KEY);
    expect(await deleteAlias(db, userId, 'temp')).toBe(true);
    expect(await getAliasByName(db, userId, 'temp', TEST_ENC_KEY)).toBeNull();
    expect(await deleteAlias(db, userId, 'temp')).toBe(false);
  });

  it('list orders by name ASC and honors the bounded limit', async () => {
    const userId = await freshUser();
    for (const name of ['charlie', 'alpha', 'bravo']) {
      await upsertAlias(db, { id: randomHex(16), userId, name, value: 'v', source: 'web' }, TEST_ENC_KEY);
    }
    const all = await listAliases(db, userId, undefined, TEST_ENC_KEY);
    expect(all.map((a) => a.name)).toEqual(['alpha', 'bravo', 'charlie']);

    const limited = await listAliases(db, userId, { limit: 2 }, TEST_ENC_KEY);
    expect(limited.map((a) => a.name)).toEqual(['alpha', 'bravo']);

    // Limit is clamped to ALIAS_LIST_LIMIT (over-large request does not error).
    const clamped = await listAliases(db, userId, { limit: ALIAS_LIST_LIMIT + 10_000 }, TEST_ENC_KEY);
    expect(clamped).toHaveLength(3);
  });

  it('fails closed on missing key, wrong key, cross-user replay, and field swap', async () => {
    const userA = await freshUser();
    const userB = await freshUser();

    await expect(
      upsertAlias(db, { id: randomHex(16), userId: userA, name: 'fail', value: 'secret', source: 'web' }, ''),
    ).rejects.toThrow('alias_encryption_unavailable');

    await upsertAlias(db, {
      id: randomHex(16),
      userId: userA,
      name: 'secret',
      value: 'secret-val',
      description: 'secret-desc',
      source: 'web',
    }, TEST_ENC_KEY);

    await expect(getAliasByName(db, userA, 'secret', '')).rejects.toThrow('alias_encryption_unavailable');
    await expect(getAliasByName(db, userA, 'secret', 'wrong-key')).rejects.toThrow('alias_decryption_failed');

    const rawA = await db.queryOne<{ value: string; description: string }>(
      'SELECT value, description FROM user_aliases WHERE user_id = $1 AND name = $2',
      [userA, 'secret'],
    );
    const now = Date.now();
    // Cross-user replay: insert userA's ciphertext into userB's row -> AAD mismatch fails closed.
    await db.execute(
      `INSERT INTO user_aliases (id, user_id, name, value, description, tags, source, encryption_version, created_at, updated_at)
       VALUES ($1, $2, 'replayed', $3, $4, '[]'::jsonb, 'web', 1, $5, $5)`,
      [randomHex(16), userB, rawA!.value, rawA!.description, now],
    );
    await expect(getAliasByName(db, userB, 'replayed', TEST_ENC_KEY)).rejects.toThrow('alias_decryption_failed');

    // Field-swap tampering: swap value and description within same user -> AAD mismatch fails closed.
    await db.execute(
      'UPDATE user_aliases SET value = $3, description = $4 WHERE user_id = $1 AND name = $2',
      [userA, 'secret', rawA!.description, rawA!.value],
    );
    await expect(getAliasByName(db, userA, 'secret', TEST_ENC_KEY)).rejects.toThrow('alias_decryption_failed');
  });
});

describe('migratePlaintextAliasesToEncrypted', () => {
  it('migrates legacy plaintext rows in batches, preserves metadata, and is idempotent', async () => {
    const userId = await freshUser();
    const t1 = 1_700_000_001_000;
    const t2 = 1_700_000_002_000;
    const t3 = 1_700_000_003_000;
    const id1 = `0001-${randomHex(12)}`;
    const id2 = `0002-${randomHex(12)}`;
    const id3 = `0003-${randomHex(12)}`;

    // Seed legacy plaintext rows (encryption_version = 0), including NULL description and literal "enc:v1:test".
    await db.execute(
      `INSERT INTO user_aliases (id, user_id, name, value, description, tags, source, encryption_version, created_at, updated_at)
       VALUES ($1, $2, 'legacy1', 'plain-v1', 'plain-d1', '["t1"]'::jsonb, 'web', 0, $3, $4),
              ($5, $2, 'legacy2', 'enc:v1:test', NULL, '["t2"]'::jsonb, 'mcp', 0, $3, $4),
              ($6, $2, 'legacy3', 'plain-v3', 'plain-d3', '[]'::jsonb, 'web', 0, $3, $4)`,
      [id1, userId, t1, t2, id2, id3],
    );

    // Also seed an already-encrypted row.
    const already = await upsertAlias(db, {
      id: randomHex(16),
      userId,
      name: 'already_enc',
      value: 'already-secret',
      source: 'web',
    }, TEST_ENC_KEY);

    // Legacy rows are readable even before migration.
    const preRead = await getAliasByName(db, userId, 'legacy2', TEST_ENC_KEY);
    expect(preRead?.value).toBe('enc:v1:test');

    // Run migration with small batchSize = 2.
    const res1 = await migratePlaintextAliasesToEncrypted(db, TEST_ENC_KEY, 2);
    expect(res1.migrated).toBeGreaterThanOrEqual(3);

    // Second run is a no-op (idempotent).
    const res2 = await migratePlaintextAliasesToEncrypted(db, TEST_ENC_KEY, 2);
    expect(res2).toEqual({ migrated: 0, skipped: 0 });

    const rawRows = await db.query<{
      id: string;
      name: string;
      value: string;
      description: string | null;
      encryption_version: number;
      created_at: number;
      updated_at: number;
    }>(
      `SELECT id, name, value, description, encryption_version, created_at, updated_at
         FROM user_aliases WHERE user_id = $1 ORDER BY name ASC`,
      [userId],
    );
    for (const r of rawRows) {
      expect(r.encryption_version).toBe(ALIAS_ENCRYPTION_VERSION_AES_GCM);
      expect(r.value).not.toContain('plain-');
      expect(r.value).not.toBe('enc:v1:test');
    }
    const raw1 = rawRows.find((r) => r.id === id1)!;
    expect(Number(raw1.created_at)).toBe(t1);
    expect(Number(raw1.updated_at)).toBe(t2);
    const raw2 = rawRows.find((r) => r.id === id2)!;
    expect(raw2.description).toBeNull();

    const decrypted = await listAliases(db, userId, undefined, TEST_ENC_KEY);
    expect(decrypted.find((a) => a.name === 'legacy1')).toMatchObject({
      id: id1,
      value: 'plain-v1',
      description: 'plain-d1',
      tags: ['t1'],
      source: 'web',
      createdAt: new Date(t1).toISOString(),
      updatedAt: new Date(t2).toISOString(),
    });
    expect(decrypted.find((a) => a.name === 'legacy2')).toMatchObject({
      id: id2,
      value: 'enc:v1:test',
      tags: ['t2'],
      source: 'mcp',
    });
    expect(decrypted.find((a) => a.name === 'legacy2')?.description).toBeUndefined();
    expect(decrypted.find((a) => a.name === 'already_enc')?.value).toBe(already.value);
    expect(t3).toBeGreaterThan(t2);
  });

  it('respects CAS on value+description and retries rows modified while still encryption_version = 0', async () => {
    const userId = await freshUser();
    const id = randomHex(16);
    const now = Date.now();
    await db.execute(
      `INSERT INTO user_aliases (id, user_id, name, value, description, tags, source, encryption_version, created_at, updated_at)
       VALUES ($1, $2, 'race_v0', 'old-plaintext', NULL, '[]'::jsonb, 'web', $3, $4, $4)`,
      [id, userId, ALIAS_ENCRYPTION_VERSION_PLAINTEXT, now],
    );

    // Simulate a baseline v0 writer mutating value/description (still encryption_version = 0)
    // between SELECT and UPDATE: CAS must reject the stale encrypt, re-read, and encrypt latest.
    let racedV0 = false;
    const casTestingDb = {
      query: db.query.bind(db),
      queryOne: db.queryOne.bind(db),
      exec: db.exec.bind(db),
      close: db.close.bind(db),
      transaction: async <T>(fn: (tx: Database) => Promise<T>) => fn(casTestingDb as unknown as Database),
      execute: async (sql: string, params?: unknown[]) => {
        if (!racedV0 && sql.includes('UPDATE user_aliases') && params?.[0] === id) {
          racedV0 = true;
          // Exact baseline SQL (by id): writes new plaintext and leaves encryption_version = 0.
          await db.execute(
            `UPDATE user_aliases
                SET name = $3, value = $4, description = $5, tags = $6::jsonb,
                    source = $7, updated_at = $8
              WHERE user_id = $1 AND id = $2`,
            [userId, id, 'race_v0', 'newer-v0-plaintext', 'newer-v0-desc', '[]', 'web', Date.now()],
          );
        }
        return db.execute(sql, params);
      },
    } as unknown as Database;

    const result = await migratePlaintextAliasesToEncrypted(casTestingDb, TEST_ENC_KEY, 10);
    expect(racedV0).toBe(true);
    expect(result.migrated).toBeGreaterThanOrEqual(1);

    const latest = await getAliasByName(db, userId, 'race_v0', TEST_ENC_KEY);
    expect(latest?.value).toBe('newer-v0-plaintext');
    expect(latest?.description).toBe('newer-v0-desc');
  });

  it('skips without clobbering when a concurrent v1 writer upgrades the row mid-migration', async () => {
    const userId = await freshUser();
    const id = randomHex(16);
    const now = Date.now();
    await db.execute(
      `INSERT INTO user_aliases (id, user_id, name, value, description, tags, source, encryption_version, created_at, updated_at)
       VALUES ($1, $2, 'race_v1', 'old-plaintext', 'old-desc', '[]'::jsonb, 'web', $3, $4, $4)`,
      [id, userId, ALIAS_ENCRYPTION_VERSION_PLAINTEXT, now],
    );

    let racedV1 = false;
    const racingDb = {
      query: db.query.bind(db),
      queryOne: db.queryOne.bind(db),
      exec: db.exec.bind(db),
      close: db.close.bind(db),
      transaction: async <T>(fn: (tx: Database) => Promise<T>) => fn(racingDb as unknown as Database),
      execute: async (sql: string, params?: unknown[]) => {
        if (!racedV1 && sql.includes('UPDATE user_aliases') && params?.[0] === id) {
          racedV1 = true;
          await upsertAlias(db, {
            id,
            existingId: id,
            userId,
            name: 'race_v1',
            value: 'newer-concurrent-value',
            description: 'newer-desc',
            source: 'web',
          }, TEST_ENC_KEY);
        }
        return db.execute(sql, params);
      },
    } as unknown as Database;

    const result = await migratePlaintextAliasesToEncrypted(racingDb, TEST_ENC_KEY, 10);
    expect(racedV1).toBe(true);
    expect(result.skipped).toBeGreaterThanOrEqual(1);

    const latest = await getAliasByName(db, userId, 'race_v1', TEST_ENC_KEY);
    expect(latest?.value).toBe('newer-concurrent-value');
    expect(latest?.description).toBe('newer-desc');
  });

  it('covers baseline 68e2ac6b73 SQL write entrypoints, pre/post backfill interleaving, and old-read vs new-read on the same PK', async () => {
    const userId = await freshUser();
    const pkA = randomHex(16);
    const pkB = randomHex(16);
    const t0 = Date.now();

    // 1. Pre-cutover baseline writes (both SQL entrypoints from 68e2ac6b73):
    //    Entry #1: INSERT ... ON CONFLICT (user_id, name) DO UPDATE
    await db.execute(
      `INSERT INTO user_aliases (id, user_id, name, value, description, tags, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
       ON CONFLICT (user_id, name) DO UPDATE SET
         value = EXCLUDED.value,
         description = EXCLUDED.description,
         tags = EXCLUDED.tags,
         source = EXCLUDED.source,
         updated_at = EXCLUDED.updated_at`,
      [pkA, userId, 'entry_upsert', 'v0-initial', 'desc-initial', '["old"]', 'web', t0, t0],
    );
    await db.execute(
      `INSERT INTO user_aliases (id, user_id, name, value, description, tags, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
       ON CONFLICT (user_id, name) DO UPDATE SET
         value = EXCLUDED.value,
         description = EXCLUDED.description,
         tags = EXCLUDED.tags,
         source = EXCLUDED.source,
         updated_at = EXCLUDED.updated_at`,
      [pkB, userId, 'entry_id', 'v0-id-initial', 'desc-id-initial', '[]', 'web', t0, t0],
    );
    //    Entry #2: UPDATE by id (baseline SQL)
    await db.execute(
      `UPDATE user_aliases
          SET name = $3, value = $4, description = $5, tags = $6::jsonb,
              source = $7, updated_at = $8
        WHERE user_id = $1 AND id = $2`,
      [userId, pkB, 'entry_id_renamed', 'v0-id-updated', null, '["renamed"]', 'mcp', t0 + 1],
    );

    // 2. Old baseline SELECT on the same PKs before cutover/backfill reads plaintext cleanly.
    const oldReadA = await db.queryOne<{ id: string; name: string; value: string; description: string | null }>(
      `SELECT id, name, value, description, tags, source, created_at, updated_at
         FROM user_aliases WHERE user_id = $1 AND id = $2`,
      [userId, pkA],
    );
    const oldReadB = await db.queryOne<{ id: string; name: string; value: string; description: string | null }>(
      `SELECT id, name, value, description, tags, source, created_at, updated_at
         FROM user_aliases WHERE user_id = $1 AND id = $2`,
      [userId, pkB],
    );
    expect(oldReadA).toMatchObject({ id: pkA, name: 'entry_upsert', value: 'v0-initial', description: 'desc-initial' });
    expect(oldReadB).toMatchObject({ id: pkB, name: 'entry_id_renamed', value: 'v0-id-updated', description: null });

    // 3. Interleave baseline ON CONFLICT DO UPDATE (changing non-null description -> NULL) and
    //    baseline UPDATE-by-id (changing NULL description -> non-null) right before backfill's CAS UPDATE.
    let racedA = false;
    let racedB = false;
    const interleavedDb = {
      query: db.query.bind(db),
      queryOne: db.queryOne.bind(db),
      exec: db.exec.bind(db),
      close: db.close.bind(db),
      transaction: async <T>(fn: (tx: Database) => Promise<T>) => fn(interleavedDb as unknown as Database),
      execute: async (sql: string, params?: unknown[]) => {
        if (!racedA && sql.includes('UPDATE user_aliases') && params?.[0] === pkA) {
          racedA = true;
          await db.execute(
            `INSERT INTO user_aliases (id, user_id, name, value, description, tags, source, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
             ON CONFLICT (user_id, name) DO UPDATE SET
               value = EXCLUDED.value,
               description = EXCLUDED.description,
               tags = EXCLUDED.tags,
               source = EXCLUDED.source,
               updated_at = EXCLUDED.updated_at`,
            [randomHex(16), userId, 'entry_upsert', 'v0-upsert-raced', null, '["raced"]', 'web', t0, t0 + 2],
          );
        }
        if (!racedB && sql.includes('UPDATE user_aliases') && params?.[0] === pkB) {
          racedB = true;
          await db.execute(
            `UPDATE user_aliases
                SET name = $3, value = $4, description = $5, tags = $6::jsonb,
                    source = $7, updated_at = $8
              WHERE user_id = $1 AND id = $2`,
            [userId, pkB, 'entry_id_renamed', 'v0-id-raced', 'desc-now-non-null', '["raced-b"]', 'web', t0 + 3],
          );
        }
        return db.execute(sql, params);
      },
    } as unknown as Database;

    const migRes = await migratePlaintextAliasesToEncrypted(interleavedDb, TEST_ENC_KEY, 10);
    expect(racedA).toBe(true);
    expect(racedB).toBe(true);
    expect(migRes.migrated).toBeGreaterThanOrEqual(2);

    // 4. Post-cutover new reads on the SAME PKs decrypt the latest values with encryption_version = 1.
    const newReadA = await getAliasById(db, userId, pkA, TEST_ENC_KEY);
    const newReadB = await getAliasById(db, userId, pkB, TEST_ENC_KEY);
    expect(newReadA).toMatchObject({ id: pkA, name: 'entry_upsert', value: 'v0-upsert-raced' });
    expect(newReadA?.description).toBeUndefined();
    expect(newReadB).toMatchObject({
      id: pkB,
      name: 'entry_id_renamed',
      value: 'v0-id-raced',
      description: 'desc-now-non-null',
    });

    // 5. Post-cutover new writes on the same PKs keep encryption_version = 1 and ciphertext at rest.
    const postWriteA = await upsertAlias(db, {
      id: randomHex(16),
      userId,
      name: 'entry_upsert',
      value: 'v1-after-cutover',
      description: 'v1-desc',
      source: 'web',
    }, TEST_ENC_KEY);
    expect(postWriteA.id).toBe(pkA);
    expect(postWriteA.value).toBe('v1-after-cutover');

    const postWriteB = await upsertAlias(db, {
      id: randomHex(16),
      existingId: pkB,
      userId,
      name: 'entry_id_v1',
      value: 'v1-id-after-cutover',
      description: null,
      source: 'mcp',
    }, TEST_ENC_KEY);
    expect(postWriteB.id).toBe(pkB);
    expect((await getAliasById(db, userId, pkB, TEST_ENC_KEY))?.value).toBe('v1-id-after-cutover');
  });
});

describe('list q filter — literal substring over decrypted descriptions', () => {
  it('matches over both name and description (case-insensitive, literal)', async () => {
    const userId = await freshUser();
    await upsertAlias(db, { id: randomHex(16), userId, name: 'prod', value: 'v', description: 'the Live server', source: 'web' }, TEST_ENC_KEY);
    await upsertAlias(db, { id: randomHex(16), userId, name: 'stage', value: 'v', description: 'preprod', source: 'web' }, TEST_ENC_KEY);

    expect((await listAliases(db, userId, { q: 'PROD' }, TEST_ENC_KEY)).map((a) => a.name).sort()).toEqual(['prod', 'stage']);
    expect((await listAliases(db, userId, { q: 'live' }, TEST_ENC_KEY)).map((a) => a.name)).toEqual(['prod']);
  });

  it('treats a stored literal % as a character, not a wildcard', async () => {
    const userId = await freshUser();
    await upsertAlias(db, { id: randomHex(16), userId, name: 'disc50', value: 'v', description: '50% off', source: 'web' }, TEST_ENC_KEY);
    await upsertAlias(db, { id: randomHex(16), userId, name: 'other', value: 'v', description: 'plain text', source: 'web' }, TEST_ENC_KEY);

    const pct = await listAliases(db, userId, { q: '%' }, TEST_ENC_KEY);
    expect(pct.map((a) => a.name)).toEqual(['disc50']);
    expect((await listAliases(db, userId, { q: '50%' }, TEST_ENC_KEY)).map((a) => a.name)).toEqual(['disc50']);
  });

  it('treats a stored literal _ as a character, not a single-char wildcard', async () => {
    const userId = await freshUser();
    await upsertAlias(db, { id: randomHex(16), userId, name: 'a_b', value: 'v', source: 'web' }, TEST_ENC_KEY);
    await upsertAlias(db, { id: randomHex(16), userId, name: 'axb', value: 'v', source: 'web' }, TEST_ENC_KEY);

    const res = await listAliases(db, userId, { q: 'a_b' }, TEST_ENC_KEY);
    expect(res.map((a) => a.name)).toEqual(['a_b']);
  });

  it('treats a stored literal backslash as a character', async () => {
    const userId = await freshUser();
    await upsertAlias(db, { id: randomHex(16), userId, name: 'winpath', value: 'v', description: 'C:\\Users', source: 'web' }, TEST_ENC_KEY);
    await upsertAlias(db, { id: randomHex(16), userId, name: 'nopath', value: 'v', description: 'C:/Users', source: 'web' }, TEST_ENC_KEY);

    const res = await listAliases(db, userId, { q: '\\Users' }, TEST_ENC_KEY);
    expect(res.map((a) => a.name)).toEqual(['winpath']);
  });
});

describe('strict per-user scoping', () => {
  it('user A cannot read, list, or delete user B aliases', async () => {
    const userA = await freshUser();
    const userB = await freshUser();
    await upsertAlias(db, { id: randomHex(16), userId: userA, name: 'shared', value: 'A-only', source: 'web' }, TEST_ENC_KEY);

    expect(await listAliases(db, userB, undefined, TEST_ENC_KEY)).toHaveLength(0);
    expect(await getAliasByName(db, userB, 'shared', TEST_ENC_KEY)).toBeNull();
    expect(await deleteAlias(db, userB, 'shared')).toBe(false);
    expect((await getAliasByName(db, userA, 'shared', TEST_ENC_KEY))?.value).toBe('A-only');
  });

  it('same name is independent across users (UNIQUE is per-user)', async () => {
    const userA = await freshUser();
    const userB = await freshUser();
    await upsertAlias(db, { id: randomHex(16), userId: userA, name: 'host', value: 'A-host', source: 'web' }, TEST_ENC_KEY);
    await upsertAlias(db, { id: randomHex(16), userId: userB, name: 'host', value: 'B-host', source: 'web' }, TEST_ENC_KEY);
    expect((await getAliasByName(db, userA, 'host', TEST_ENC_KEY))?.value).toBe('A-host');
    expect((await getAliasByName(db, userB, 'host', TEST_ENC_KEY))?.value).toBe('B-host');
  });
});
