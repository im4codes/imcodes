/**
 * Integration tests for the `user_aliases` store — real PostgreSQL via
 * testcontainers (managed by test/setup/integration-global.ts).
 *
 * Covers the storage contract:
 *   - migration 048 applies; UNIQUE(user_id, name); FK → users ON DELETE CASCADE
 *   - upsert / get-by-name / delete / list (ORDER BY name ASC, bounded limit)
 *   - server-side value normalization (CRLF→LF, NFC) via the shared helpers
 *   - list `q` filter matches name + description as a LITERAL substring, with
 *     `%` / `_` / `\` escaped (a stored literal `%`/`_` is NOT a wildcard)
 *   - strict per-user scoping: user A cannot read/write user B's aliases
 *
 * The alias `value` is never asserted into a log line.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/queries.js';
import { randomHex } from '../src/security/crypto.js';
import {
  upsertAlias,
  getAliasByName,
  deleteAlias,
  listAliases,
  ALIAS_LIST_LIMIT,
} from '../src/db/alias-queries.js';

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
  it('creates the table with the expected columns', async () => {
    const rows = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'user_aliases'`,
    );
    const cols = new Set(rows.map((r) => r.column_name));
    for (const col of ['id', 'user_id', 'name', 'value', 'description', 'tags', 'source', 'created_at', 'updated_at']) {
      expect(cols.has(col)).toBe(true);
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
    await upsertAlias(db, { id: randomHex(16), userId, name: 'gone', value: 'v', source: 'web' });
    await db.execute('DELETE FROM users WHERE id = $1', [userId]);
    const remaining = await db.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM user_aliases WHERE user_id = $1',
      [userId],
    );
    expect(Number(remaining[0]!.cnt)).toBe(0);
  });
});

describe('alias-queries roundtrip', () => {
  it('upsert / get-by-name returns canonical fields (ISO timestamps, no id/user_id)', async () => {
    const userId = await freshUser();
    const created = await upsertAlias(db, {
      id: randomHex(16),
      userId,
      name: 'server',
      value: 'pron.koca.win',
      description: 'prod host',
      tags: ['infra', 'prod'],
      source: 'web',
    });
    expect(created.name).toBe('server');
    expect(created.value).toBe('pron.koca.win');
    expect(created.description).toBe('prod host');
    expect(created.tags).toEqual(['infra', 'prod']);
    expect(created.source).toBe('web');
    expect(new Date(created.createdAt).toISOString()).toBe(created.createdAt);
    expect(created).not.toHaveProperty('id');
    expect(created).not.toHaveProperty('user_id');

    const got = await getAliasByName(db, userId, 'server');
    expect(got?.value).toBe('pron.koca.win');
    expect(got?.tags).toEqual(['infra', 'prod']);
  });

  it('upsert on (user_id, name) updates value/description/tags and preserves created_at', async () => {
    const userId = await freshUser();
    const first = await upsertAlias(db, { id: randomHex(16), userId, name: 'db', value: 'v1', source: 'web' });
    await new Promise((r) => setTimeout(r, 3));
    const second = await upsertAlias(db, {
      id: randomHex(16),
      userId,
      name: 'db',
      value: 'v2',
      description: 'updated',
      tags: ['x'],
      source: 'mcp',
    });
    expect(second.value).toBe('v2');
    expect(second.description).toBe('updated');
    expect(second.tags).toEqual(['x']);
    expect(second.source).toBe('mcp');
    expect(second.createdAt).toBe(first.createdAt);
    expect(new Date(second.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(first.updatedAt).getTime());

    const all = await listAliases(db, userId);
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
    });
    expect(created.value).toBe('line1\nline2\nline3');
  });

  it('delete removes the row and reports whether one was removed', async () => {
    const userId = await freshUser();
    await upsertAlias(db, { id: randomHex(16), userId, name: 'temp', value: 'v', source: 'web' });
    expect(await deleteAlias(db, userId, 'temp')).toBe(true);
    expect(await getAliasByName(db, userId, 'temp')).toBeNull();
    expect(await deleteAlias(db, userId, 'temp')).toBe(false);
  });

  it('list orders by name ASC and honors the bounded limit', async () => {
    const userId = await freshUser();
    for (const name of ['charlie', 'alpha', 'bravo']) {
      await upsertAlias(db, { id: randomHex(16), userId, name, value: 'v', source: 'web' });
    }
    const all = await listAliases(db, userId);
    expect(all.map((a) => a.name)).toEqual(['alpha', 'bravo', 'charlie']);

    const limited = await listAliases(db, userId, { limit: 2 });
    expect(limited.map((a) => a.name)).toEqual(['alpha', 'bravo']);

    // Limit is clamped to ALIAS_LIST_LIMIT (over-large request does not error).
    const clamped = await listAliases(db, userId, { limit: ALIAS_LIST_LIMIT + 10_000 });
    expect(clamped).toHaveLength(3);
  });
});

describe('list q filter — literal substring with LIKE escaping', () => {
  it('matches over both name and description (case-insensitive, literal)', async () => {
    const userId = await freshUser();
    await upsertAlias(db, { id: randomHex(16), userId, name: 'prod', value: 'v', description: 'the Live server', source: 'web' });
    await upsertAlias(db, { id: randomHex(16), userId, name: 'stage', value: 'v', description: 'preprod', source: 'web' });

    // Matches by name.
    expect((await listAliases(db, userId, { q: 'PROD' })).map((a) => a.name).sort()).toEqual(['prod', 'stage']);
    // Matches by description only.
    expect((await listAliases(db, userId, { q: 'live' })).map((a) => a.name)).toEqual(['prod']);
  });

  it('treats a stored literal % as a character, not a wildcard', async () => {
    const userId = await freshUser();
    await upsertAlias(db, { id: randomHex(16), userId, name: 'disc50', value: 'v', description: '50% off', source: 'web' });
    await upsertAlias(db, { id: randomHex(16), userId, name: 'other', value: 'v', description: 'plain text', source: 'web' });

    // A bare '%' query must NOT act as "match everything" — it matches only the
    // row whose description contains a literal '%'.
    const pct = await listAliases(db, userId, { q: '%' });
    expect(pct.map((a) => a.name)).toEqual(['disc50']);

    // '50%' matches the literal, not "starts with 50 then anything".
    expect((await listAliases(db, userId, { q: '50%' })).map((a) => a.name)).toEqual(['disc50']);
  });

  it('treats a stored literal _ as a character, not a single-char wildcard', async () => {
    const userId = await freshUser();
    await upsertAlias(db, { id: randomHex(16), userId, name: 'a_b', value: 'v', source: 'web' });
    await upsertAlias(db, { id: randomHex(16), userId, name: 'axb', value: 'v', source: 'web' });

    // '_' must match only the literal-underscore row, not 'axb'.
    const res = await listAliases(db, userId, { q: 'a_b' });
    expect(res.map((a) => a.name)).toEqual(['a_b']);
  });

  it('treats a stored literal backslash as a character', async () => {
    const userId = await freshUser();
    await upsertAlias(db, { id: randomHex(16), userId, name: 'winpath', value: 'v', description: 'C:\\Users', source: 'web' });
    await upsertAlias(db, { id: randomHex(16), userId, name: 'nopath', value: 'v', description: 'C:/Users', source: 'web' });

    const res = await listAliases(db, userId, { q: '\\Users' });
    expect(res.map((a) => a.name)).toEqual(['winpath']);
  });
});

describe('strict per-user scoping', () => {
  it('user A cannot read, list, or delete user B aliases', async () => {
    const userA = await freshUser();
    const userB = await freshUser();
    await upsertAlias(db, { id: randomHex(16), userId: userA, name: 'shared', value: 'A-only', source: 'web' });

    // B's list is empty.
    expect(await listAliases(db, userB)).toHaveLength(0);
    // B cannot read A's alias by name.
    expect(await getAliasByName(db, userB, 'shared')).toBeNull();
    // B deleting the same name does not touch A's row.
    expect(await deleteAlias(db, userB, 'shared')).toBe(false);
    // A still has it.
    expect((await getAliasByName(db, userA, 'shared'))?.value).toBe('A-only');
  });

  it('same name is independent across users (UNIQUE is per-user)', async () => {
    const userA = await freshUser();
    const userB = await freshUser();
    await upsertAlias(db, { id: randomHex(16), userId: userA, name: 'host', value: 'A-host', source: 'web' });
    await upsertAlias(db, { id: randomHex(16), userId: userB, name: 'host', value: 'B-host', source: 'web' });
    expect((await getAliasByName(db, userA, 'host'))?.value).toBe('A-host');
    expect((await getAliasByName(db, userB, 'host'))?.value).toBe('B-host');
  });
});
