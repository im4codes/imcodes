/**
 * DB integration tests — runs against a real PostgreSQL via testcontainers.
 *
 * Tests:
 *  1. convertPlaceholders()  — pure function, no DB
 *  2. Migration              — DDL runs cleanly, all tables created
 *  3. PgDatabase wrapper     — .first() / .all() / .run() roundtrip
 *  4. ON CONFLICT            — DO NOTHING and DO UPDATE actually work
 *  5. queries.ts helpers     — createUser, createServer, upsert, heartbeat
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase, convertPlaceholders, type PgDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  createUser,
  getUserById,
  createServer,
  getServerById,
  updateServerHeartbeat,
  upsertPlatformIdentity,
  getUserByPlatformId,
  getServersByUserId,
} from '../src/db/queries.js';

// ── DB lifecycle — container is managed by globalSetup ────────────────────────

let db: PgDatabase;

beforeAll(async () => {
  // TEST_DATABASE_URL is set by test/setup/integration-global.ts
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

afterAll(async () => {
  await db.close();
});

// ── 1. convertPlaceholders ────────────────────────────────────────────────────

describe('convertPlaceholders', () => {
  it('converts ? to $1, $2, ...', () => {
    expect(convertPlaceholders('SELECT * FROM t WHERE id = ?')).toBe('SELECT * FROM t WHERE id = $1');
    expect(convertPlaceholders('INSERT INTO t (a, b) VALUES (?, ?)')).toBe('INSERT INTO t (a, b) VALUES ($1, $2)');
  });

  it('does not convert ? inside single-quoted strings', () => {
    expect(convertPlaceholders("SELECT '?' FROM t WHERE id = ?")).toBe("SELECT '?' FROM t WHERE id = $1");
  });

  it('does not convert ? inside double-quoted identifiers', () => {
    expect(convertPlaceholders('SELECT "col?" FROM t WHERE id = ?')).toBe('SELECT "col?" FROM t WHERE id = $1');
  });

  it('handles escaped single quotes (\'\')', () => {
    expect(convertPlaceholders("SELECT 'it''s' WHERE id = ?")).toBe("SELECT 'it''s' WHERE id = $1");
  });
});

// ── 2. Migration ──────────────────────────────────────────────────────────────

describe('runMigrations', () => {
  it('creates all expected tables', async () => {
    const tables = [
      'users', 'platform_identities', 'servers', 'channel_bindings',
      'platform_bots', 'api_keys', 'refresh_tokens', 'idempotency_records',
      'audit_log', 'pending_binds', 'sessions', 'cron_jobs',
      'teams', 'team_members', 'push_subscriptions',
    ];

    for (const table of tables) {
      const row = await db
        .prepare("SELECT to_regclass($1) AS oid")
        .bind(`public.${table}`)
        .first<{ oid: string | null }>();
      expect(row?.oid, `table ${table} should exist`).not.toBeNull();
    }
  });

  it('is idempotent — second run does not throw', async () => {
    await expect(runMigrations(db)).resolves.not.toThrow();
  });
});

// ── 3. PgDatabase wrapper ─────────────────────────────────────────────────────

describe('PgDatabase wrapper', () => {
  it('.first() returns null for missing row', async () => {
    const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind('no-such-id').first();
    expect(row).toBeNull();
  });

  it('.run() returns changes count', async () => {
    const result = await db
      .prepare('INSERT INTO users (id, created_at) VALUES (?, ?)')
      .bind('wrapper-test-user', Date.now())
      .run();
    expect(result.changes).toBe(1);
  });

  it('.all() returns all matching rows', async () => {
    const userId = 'alltest-' + Math.random().toString(36).slice(2);
    await db.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').bind(userId, Date.now()).run();

    const result = await db
      .prepare('SELECT * FROM users WHERE id = ?')
      .bind(userId)
      .all<{ id: string }>();
    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe(userId);
  });
});

// ── 4. ON CONFLICT ────────────────────────────────────────────────────────────

describe('ON CONFLICT', () => {
  it('DO NOTHING silently ignores duplicate', async () => {
    const id = 'conflict-test-' + Math.random().toString(36).slice(2);
    await db.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').bind(id, Date.now()).run();

    // Second insert should not throw
    const result = await db
      .prepare('INSERT INTO users (id, created_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING')
      .bind(id, Date.now())
      .run();
    expect(result.changes).toBe(0); // nothing inserted
  });

  it('DO UPDATE upserts correctly', async () => {
    const userId = 'upsert-user-' + Math.random().toString(36).slice(2);
    await createUser(db, userId);

    const data1 = JSON.stringify({ history: ['a'], commands: [], phrases: [] });
    const data2 = JSON.stringify({ history: ['b'], commands: [], phrases: [] });
    const now = Date.now();

    await db.prepare(
      'INSERT INTO user_quick_data (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at',
    ).bind(userId, data1, now).run();

    // Upsert again — should update
    await db.prepare(
      'INSERT INTO user_quick_data (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at',
    ).bind(userId, data2, now + 1).run();

    const row = await db
      .prepare('SELECT data FROM user_quick_data WHERE user_id = ?')
      .bind(userId)
      .first<{ data: string }>();
    expect(JSON.parse(row!.data).history).toEqual(['b']);
  });
});

// ── 5. queries.ts helpers ─────────────────────────────────────────────────────

describe('queries.ts', () => {
  let userId: string;
  let serverId: string;

  beforeAll(async () => {
    userId = 'qtest-user-' + Math.random().toString(36).slice(2);
    serverId = 'qtest-server-' + Math.random().toString(36).slice(2);
    await createUser(db, userId);
    await createServer(db, serverId, userId, 'test-server', 'hash-abc');
  });

  it('createUser / getUserById roundtrip', async () => {
    const u2 = 'qtest2-' + Math.random().toString(36).slice(2);
    await createUser(db, u2);
    const fetched = await getUserById(db, u2);
    expect(fetched?.id).toBe(u2);
    expect(fetched?.created_at).toBeGreaterThan(0);
  });

  it('getUserById returns null for unknown id', async () => {
    expect(await getUserById(db, 'does-not-exist')).toBeNull();
  });

  it('createServer / getServerById roundtrip', async () => {
    const s = await getServerById(db, serverId);
    expect(s?.id).toBe(serverId);
    expect(s?.user_id).toBe(userId);
    expect(s?.token_hash).toBe('hash-abc');
    expect(s?.status).toBe('offline');
  });

  it('updateServerHeartbeat changes status to online', async () => {
    await updateServerHeartbeat(db, serverId);
    const s = await getServerById(db, serverId);
    expect(s?.status).toBe('online');
    expect(s?.last_heartbeat_at).toBeGreaterThan(0);
  });

  it('getServersByUserId returns owned servers', async () => {
    const servers = await getServersByUserId(db, userId);
    expect(servers.some((s) => s.id === serverId)).toBe(true);
  });

  it('upsertPlatformIdentity DO NOTHING on duplicate', async () => {
    const pid = 'plat-' + Math.random().toString(36).slice(2);
    await upsertPlatformIdentity(db, pid, userId, 'discord', 'disc-user-1');
    // Second call with different id but same (platform, platform_user_id) — should not throw
    await expect(
      upsertPlatformIdentity(db, 'other-id', userId, 'discord', 'disc-user-1'),
    ).resolves.not.toThrow();

    // Only one row for that platform_user_id
    const u = await getUserByPlatformId(db, 'discord', 'disc-user-1');
    expect(u?.id).toBe(userId);
  });
});
