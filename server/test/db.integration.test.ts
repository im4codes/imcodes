/**
 * DB integration tests — runs against a real PostgreSQL via testcontainers.
 *
 * Tests:
 *  1. convertPlaceholders()  — pure function, no DB
 *  2. Migration              — DDL runs cleanly, all tables created
 *  3. PgDatabase wrapper     — .first() / .all() / .run() roundtrip
 *  4. ON CONFLICT            — DO NOTHING and DO UPDATE actually work
 *  5. queries.ts helpers     — createUser, createServer, upsert, heartbeat
 *  6. Composite PK isolation — multi-server id collision safety
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
  createSubSession,
  getSubSessionsByServer,
  getSubSessionById,
  deleteSubSession,
  upsertDiscussion,
  getDiscussionById,
  getDiscussionsByServer,
  insertDiscussionRound,
  getDiscussionRounds,
  upsertOrchestrationRun,
  getOrchestrationRunById,
  getActiveOrchestrationRuns,
  getOrchestrationRunsByDiscussion,
  type DbOrchestrationRun,
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

// ── 6. Composite PK multi-server isolation ────────────────────────────────────

describe('composite PK multi-server isolation', () => {
  let userId: string;
  let serverA: string;
  let serverB: string;

  beforeAll(async () => {
    userId = 'cpk-user-' + Math.random().toString(36).slice(2);
    serverA = 'cpk-srv-a-' + Math.random().toString(36).slice(2);
    serverB = 'cpk-srv-b-' + Math.random().toString(36).slice(2);
    await createUser(db, userId);
    await createServer(db, serverA, userId, 'server-a', 'hash-a');
    await createServer(db, serverB, userId, 'server-b', 'hash-b');
  });

  describe('sub_sessions', () => {
    const subId = 'same-sub-id'; // deliberately same id for both servers

    it('allows same id on different servers', async () => {
      await createSubSession(db, subId, serverA, 'claude-code', null, '/a', null, null);
      await createSubSession(db, subId, serverB, 'codex', null, '/b', null, null);

      const a = await getSubSessionById(db, subId, serverA);
      const b = await getSubSessionById(db, subId, serverB);
      expect(a?.type).toBe('claude-code');
      expect(a?.cwd).toBe('/a');
      expect(b?.type).toBe('codex');
      expect(b?.cwd).toBe('/b');
    });

    it('upsert on reconnect updates existing without creating duplicate', async () => {
      // Simulate daemon reconnect sync — same id, same server, updated cwd
      await createSubSession(db, subId, serverA, 'claude-code', null, '/a-updated', null, null);
      const a = await getSubSessionById(db, subId, serverA);
      expect(a?.cwd).toBe('/a-updated');
      expect(a?.closed_at).toBeNull(); // closed_at reset to NULL on upsert
    });

    it('getSubSessionsByServer returns only that server', async () => {
      const listA = await getSubSessionsByServer(db, serverA);
      const listB = await getSubSessionsByServer(db, serverB);
      expect(listA.every(s => s.server_id === serverA)).toBe(true);
      expect(listB.every(s => s.server_id === serverB)).toBe(true);
    });

    it('deleteSubSession only deletes from correct server', async () => {
      await deleteSubSession(db, subId, serverA);
      expect(await getSubSessionById(db, subId, serverA)).toBeNull();
      // serverB's copy still exists
      expect(await getSubSessionById(db, subId, serverB)).not.toBeNull();
    });
  });

  describe('discussions', () => {
    const discId = 'same-disc-id';

    it('allows same id on different servers', async () => {
      await upsertDiscussion(db, {
        id: discId, serverId: serverA, topic: 'Topic A', state: 'running',
        maxRounds: 3, startedAt: Date.now(),
      });
      await upsertDiscussion(db, {
        id: discId, serverId: serverB, topic: 'Topic B', state: 'done',
        maxRounds: 5, startedAt: Date.now(),
      });

      const a = await getDiscussionById(db, discId, serverA);
      const b = await getDiscussionById(db, discId, serverB);
      expect(a?.topic).toBe('Topic A');
      expect(a?.state).toBe('running');
      expect(b?.topic).toBe('Topic B');
      expect(b?.state).toBe('done');
    });

    it('getDiscussionsByServer returns only that server', async () => {
      const listA = await getDiscussionsByServer(db, serverA);
      const listB = await getDiscussionsByServer(db, serverB);
      expect(listA.every(d => d.server_id === serverA)).toBe(true);
      expect(listB.every(d => d.server_id === serverB)).toBe(true);
    });

    it('getDiscussionById returns null for wrong server', async () => {
      const wrongServer = 'cpk-srv-x-nonexistent';
      expect(await getDiscussionById(db, discId, wrongServer)).toBeNull();
    });
  });

  describe('discussion_rounds with server_id', () => {
    const discId = 'round-disc-id';

    beforeAll(async () => {
      await upsertDiscussion(db, {
        id: discId, serverId: serverA, topic: 'Rounds A', state: 'running',
        maxRounds: 3, startedAt: Date.now(),
      });
      await upsertDiscussion(db, {
        id: discId, serverId: serverB, topic: 'Rounds B', state: 'running',
        maxRounds: 3, startedAt: Date.now(),
      });
    });

    it('rounds are isolated by server_id', async () => {
      await insertDiscussionRound(db, {
        id: 'r1-a', discussionId: discId, serverId: serverA,
        round: 1, speakerRole: 'brain', speakerAgent: 'claude-code', response: 'Hello from A',
      });
      await insertDiscussionRound(db, {
        id: 'r1-b', discussionId: discId, serverId: serverB,
        round: 1, speakerRole: 'brain', speakerAgent: 'gemini', response: 'Hello from B',
      });

      const roundsA = await getDiscussionRounds(db, discId, serverA);
      const roundsB = await getDiscussionRounds(db, discId, serverB);
      expect(roundsA).toHaveLength(1);
      expect(roundsA[0].response).toBe('Hello from A');
      expect(roundsB).toHaveLength(1);
      expect(roundsB[0].response).toBe('Hello from B');
    });
  });

  describe('discussion_orchestration_runs', () => {
    const runId = 'same-run-id';
    const discId = 'orch-disc-id';

    beforeAll(async () => {
      await upsertDiscussion(db, {
        id: discId, serverId: serverA, topic: 'Orch A', state: 'running',
        maxRounds: 3, startedAt: Date.now(),
      });
      await upsertDiscussion(db, {
        id: discId, serverId: serverB, topic: 'Orch B', state: 'running',
        maxRounds: 3, startedAt: Date.now(),
      });
    });

    it('allows same run id on different servers', async () => {
      const now = new Date().toISOString();
      const base: DbOrchestrationRun = {
        id: runId, discussion_id: discId, server_id: serverA,
        main_session: 'brain', initiator_session: 'brain',
        current_target_session: 'w1', final_return_session: 'brain',
        remaining_targets: '[]', mode_key: 'round-robin',
        status: 'running', request_message_id: null,
        callback_message_id: null, context_ref: '{}',
        timeout_ms: 300000, result_summary: null, error: null,
        created_at: now, updated_at: now, completed_at: null,
      };
      await upsertOrchestrationRun(db, base);
      await upsertOrchestrationRun(db, { ...base, server_id: serverB, status: 'completed' });

      const a = await getOrchestrationRunById(db, runId, serverA);
      const b = await getOrchestrationRunById(db, runId, serverB);
      expect(a?.status).toBe('running');
      expect(b?.status).toBe('completed');
    });

    it('getActiveOrchestrationRuns returns only that server', async () => {
      const activeA = await getActiveOrchestrationRuns(db, serverA);
      const activeB = await getActiveOrchestrationRuns(db, serverB);
      expect(activeA.some(r => r.id === runId)).toBe(true);
      expect(activeB.some(r => r.id === runId)).toBe(false); // completed, not active
    });

    it('getOrchestrationRunById returns null for wrong server', async () => {
      expect(await getOrchestrationRunById(db, runId, 'nonexistent-srv')).toBeNull();
    });

    it('getOrchestrationRunsByDiscussion is scoped by server_id', async () => {
      const runsA = await getOrchestrationRunsByDiscussion(db, discId, serverA);
      const runsB = await getOrchestrationRunsByDiscussion(db, discId, serverB);
      expect(runsA).toHaveLength(1);
      expect(runsA[0].status).toBe('running');
      expect(runsB).toHaveLength(1);
      expect(runsB[0].status).toBe('completed');
      // Wrong server returns empty
      expect(await getOrchestrationRunsByDiscussion(db, discId, 'nonexistent-srv')).toHaveLength(0);
    });
  });

  describe('sub_session parentSession persistence', () => {
    const subId = 'parent-test-sub';

    it('createSubSession persists parentSession', async () => {
      await createSubSession(db, subId, serverA, 'claude-code', null, '/test', null, null, null, 'deck_proj_brain');
      const row = await getSubSessionById(db, subId, serverA);
      expect(row?.parent_session).toBe('deck_proj_brain');
    });

    it('upsert preserves parentSession on reconnect sync', async () => {
      // Simulate reconnect sync — same id, same server, parentSession included
      await createSubSession(db, subId, serverA, 'claude-code', null, '/test-updated', null, null, null, 'deck_proj_brain');
      const row = await getSubSessionById(db, subId, serverA);
      expect(row?.parent_session).toBe('deck_proj_brain');
      expect(row?.cwd).toBe('/test-updated');
    });
  });

  describe('sub_session geminiSessionId persistence', () => {
    const subId = 'gemini-test-sub';

    it('createSubSession persists geminiSessionId', async () => {
      await createSubSession(db, subId, serverA, 'gemini', null, '/gemini', null, null, 'gemini-uuid-123');
      const row = await getSubSessionById(db, subId, serverA);
      expect(row?.gemini_session_id).toBe('gemini-uuid-123');
    });

    it('upsert preserves geminiSessionId on reconnect sync', async () => {
      await createSubSession(db, subId, serverA, 'gemini', null, '/gemini', null, null, 'gemini-uuid-123');
      const row = await getSubSessionById(db, subId, serverA);
      expect(row?.gemini_session_id).toBe('gemini-uuid-123');
    });
  });
});
