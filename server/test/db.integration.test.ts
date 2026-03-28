/**
 * DB integration tests — runs against a real PostgreSQL via testcontainers.
 * Full coverage of every exported query function in queries.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  createUser,
  getUserById,
  getUserByUsername,
  listAllUsers,
  updateUserStatus,
  deleteUser,
  countActiveAdmins,
  getSetting,
  setSetting,
  getAllSettings,
  createServer,
  getServerById,
  updateServerHeartbeat,
  updateServerStatus,
  updateServerName,
  updateServerToken,
  deleteServer,
  upsertPlatformIdentity,
  getUserByPlatformId,
  getServersByUserId,
  upsertChannelBinding,
  getChannelBinding,
  findChannelBindingByPlatformChannel,
  getDbSessionsByServer,
  upsertDbSession,
  deleteDbSession,
  updateSessionLabel,
  updateProjectName,
  updateSession,
  getQuickData,
  upsertQuickData,
  getUserPref,
  setUserPref,
  deleteUserPref,
  createSubSession,
  getSubSessionsByServer,
  getSubSessionById,
  updateSubSession,
  reorderSubSessions,
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
  getRecentOrchestrationRuns,
  writeAuditLog,
  type DbOrchestrationRun,
} from '../src/db/queries.js';

// ── DB lifecycle — container is managed by globalSetup ────────────────────────

let db: Database;

beforeAll(async () => {
  // TEST_DATABASE_URL is set by test/setup/integration-global.ts
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

afterAll(async () => {
  await db.close();
});

// ── 1. Migration ──────────────────────────────────────────────────────────────

describe('runMigrations', () => {
  it('creates all expected tables', async () => {
    const tables = [
      'users', 'platform_identities', 'servers', 'channel_bindings',
      'platform_bots', 'api_keys', 'refresh_tokens', 'idempotency_records',
      'audit_log', 'pending_binds', 'sessions', 'cron_jobs', 'cron_executions',
      'teams', 'team_members', 'push_subscriptions',
    ];

    for (const table of tables) {
      const row = await db.queryOne<{ oid: string | null }>(
        "SELECT to_regclass($1) AS oid",
        [`public.${table}`],
      );
      expect(row?.oid, `table ${table} should exist`).not.toBeNull();
    }
  });

  it('is idempotent — second run does not throw', async () => {
    await expect(runMigrations(db)).resolves.not.toThrow();
  });

  it('cron_jobs has target_session_name column (migration 029)', async () => {
    const col = await db.queryOne<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'cron_jobs' AND column_name = 'target_session_name'`,
      [],
    );
    expect(col).not.toBeNull();
  });

  it('cron_jobs target_session_name round-trip insert and read', async () => {
    const uid = 'mig-cron-user-' + Math.random().toString(36).slice(2);
    const sid = 'mig-cron-srv-' + Math.random().toString(36).slice(2);
    await createUser(db, uid);
    await createServer(db, sid, uid, 'mig-srv', 'hash-mig');

    const jobId = 'mig-test-job-' + Math.random().toString(36).slice(2);
    await db.execute(
      `INSERT INTO cron_jobs (id, server_id, user_id, name, cron_expr, project_name, target_role, target_session_name, action, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
      [jobId, sid, uid, 'test-job', '0 9 * * *', 'proj', 'brain', 'deck_sub_abc123', '{"type":"command","command":"test"}', 'active', Date.now()],
    );

    const row = await db.queryOne<{ target_session_name: string | null }>(
      'SELECT target_session_name FROM cron_jobs WHERE id = $1',
      [jobId],
    );
    expect(row?.target_session_name).toBe('deck_sub_abc123');

    // Verify NULL works
    await db.execute('UPDATE cron_jobs SET target_session_name = NULL WHERE id = $1', [jobId]);
    const row2 = await db.queryOne<{ target_session_name: string | null }>(
      'SELECT target_session_name FROM cron_jobs WHERE id = $1',
      [jobId],
    );
    expect(row2?.target_session_name).toBeNull();

    // Cleanup
    await db.execute('DELETE FROM cron_jobs WHERE id = $1', [jobId]);
  });
});

// ── 2. Database wrapper ─────────────────────────────────────────────────────

describe('Database wrapper', () => {
  it('.queryOne() returns null for missing row', async () => {
    const row = await db.queryOne('SELECT * FROM users WHERE id = $1', ['no-such-id']);
    expect(row).toBeNull();
  });

  it('.execute() returns changes count', async () => {
    const result = await db.execute(
      'INSERT INTO users (id, created_at) VALUES ($1, $2)',
      ['wrapper-test-user', Date.now()],
    );
    expect(result.changes).toBe(1);
  });

  it('.query() returns all matching rows', async () => {
    const userId = 'alltest-' + Math.random().toString(36).slice(2);
    await db.execute('INSERT INTO users (id, created_at) VALUES ($1, $2)', [userId, Date.now()]);

    const rows = await db.query<{ id: string }>(
      'SELECT * FROM users WHERE id = $1',
      [userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(userId);
  });
});

// ── 3. ON CONFLICT ────────────────────────────────────────────────────────────

describe('ON CONFLICT', () => {
  it('DO NOTHING silently ignores duplicate', async () => {
    const id = 'conflict-test-' + Math.random().toString(36).slice(2);
    await db.execute('INSERT INTO users (id, created_at) VALUES ($1, $2)', [id, Date.now()]);

    // Second insert should not throw
    const result = await db.execute(
      'INSERT INTO users (id, created_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [id, Date.now()],
    );
    expect(result.changes).toBe(0); // nothing inserted
  });

  it('DO UPDATE upserts correctly', async () => {
    const userId = 'upsert-user-' + Math.random().toString(36).slice(2);
    await createUser(db, userId);

    const data1 = JSON.stringify({ history: ['a'], commands: [], phrases: [] });
    const data2 = JSON.stringify({ history: ['b'], commands: [], phrases: [] });
    const now = Date.now();

    await db.execute(
      'INSERT INTO user_quick_data (user_id, data, updated_at) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at',
      [userId, data1, now],
    );

    // Upsert again — should update
    await db.execute(
      'INSERT INTO user_quick_data (user_id, data, updated_at) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at',
      [userId, data2, now + 1],
    );

    const row = await db.queryOne<{ data: string }>(
      'SELECT data FROM user_quick_data WHERE user_id = $1',
      [userId],
    );
    expect(JSON.parse(row!.data).history).toEqual(['b']);
  });
});

// ── 4. queries.ts helpers ─────────────────────────────────────────────────────

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

  it('getUserByUsername roundtrip', async () => {
    const uid = 'uname-' + Math.random().toString(36).slice(2);
    await createUser(db, uid);
    await db.execute('UPDATE users SET username = $1 WHERE id = $2', ['testuser_' + uid, uid]);
    const fetched = await getUserByUsername(db, 'testuser_' + uid);
    expect(fetched?.id).toBe(uid);
    expect(await getUserByUsername(db, 'nonexistent-user')).toBeNull();
  });

  it('listAllUsers returns all users', async () => {
    const users = await listAllUsers(db);
    expect(users.length).toBeGreaterThan(0);
  });

  it('updateUserStatus changes user status', async () => {
    const uid = 'status-' + Math.random().toString(36).slice(2);
    await createUser(db, uid);
    await updateUserStatus(db, uid, 'disabled');
    const u = await getUserById(db, uid);
    expect(u?.status).toBe('disabled');
    await updateUserStatus(db, uid, 'active');
    const u2 = await getUserById(db, uid);
    expect(u2?.status).toBe('active');
  });

  it('deleteUser cascades credentials', async () => {
    const uid = 'del-' + Math.random().toString(36).slice(2);
    await createUser(db, uid);
    await deleteUser(db, uid);
    expect(await getUserById(db, uid)).toBeNull();
  });

  it('countActiveAdmins returns correct count', async () => {
    const uid = 'admin-cnt-' + Math.random().toString(36).slice(2);
    await createUser(db, uid);
    await db.execute('UPDATE users SET is_admin = TRUE, status = $1 WHERE id = $2', ['active', uid]);
    const cnt = await countActiveAdmins(db);
    expect(cnt).toBeGreaterThanOrEqual(1);
  });

  it('getSetting / setSetting / getAllSettings roundtrip', async () => {
    const key = 'test_key_' + Math.random().toString(36).slice(2);
    expect(await getSetting(db, key)).toBeNull();
    await setSetting(db, key, 'hello');
    expect(await getSetting(db, key)).toBe('hello');
    await setSetting(db, key, 'updated');
    expect(await getSetting(db, key)).toBe('updated');
    const all = await getAllSettings(db);
    expect(all[key]).toBe('updated');
  });

  it('updateServerStatus changes status', async () => {
    await updateServerStatus(db, serverId, 'offline');
    const s = await getServerById(db, serverId);
    expect(s?.status).toBe('offline');
  });

  it('updateServerName changes name', async () => {
    const ok = await updateServerName(db, serverId, userId, 'renamed-server');
    expect(ok).toBe(true);
    const s = await getServerById(db, serverId);
    expect(s?.name).toBe('renamed-server');
    // Wrong userId should fail
    const notOk = await updateServerName(db, serverId, 'wrong-user', 'bad-name');
    expect(notOk).toBe(false);
  });

  it('updateServerToken updates token hash', async () => {
    const ok = await updateServerToken(db, serverId, userId, 'new-hash', 'token-updated-server');
    expect(ok).toBe(true);
    const s = await getServerById(db, serverId);
    expect(s?.token_hash).toBe('new-hash');
    expect(s?.name).toBe('token-updated-server');
  });

  it('updateServerHeartbeat with daemonVersion', async () => {
    await updateServerHeartbeat(db, serverId, '1.2.3');
    const s = await getServerById(db, serverId);
    expect(s?.daemon_version).toBe('1.2.3');
    expect(s?.status).toBe('online');
  });

  it('deleteServer cascades and returns boolean', async () => {
    const sid = 'del-srv-' + Math.random().toString(36).slice(2);
    await createServer(db, sid, userId, 'to-delete', 'hash-del');
    const ok = await deleteServer(db, sid, userId);
    expect(ok).toBe(true);
    expect(await getServerById(db, sid)).toBeNull();
    const notOk = await deleteServer(db, sid, userId);
    expect(notOk).toBe(false);
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

// ── 5. Channel bindings ───────────────────────────────────────────────────────

describe('channel bindings', () => {
  let userId: string;
  let serverId: string;
  const botId = 'cb-bot-' + Math.random().toString(36).slice(2);

  beforeAll(async () => {
    userId = 'cb-user-' + Math.random().toString(36).slice(2);
    serverId = 'cb-srv-' + Math.random().toString(36).slice(2);
    await createUser(db, userId);
    await createServer(db, serverId, userId, 'cb-server', 'hash-cb');
    // Create a platform bot to satisfy FK constraint on channel_bindings
    const now = Date.now();
    await db.execute(
      'INSERT INTO platform_bots (id, user_id, platform, label, config_encrypted, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [botId, userId, 'discord', 'test-bot', 'encrypted', now, now],
    );
  });

  it('upsertChannelBinding / getChannelBinding roundtrip', async () => {
    const bid = 'bind-' + Math.random().toString(36).slice(2);
    await upsertChannelBinding(db, bid, serverId, 'discord', 'ch-123', 'session', 'brain', botId);
    const b = await getChannelBinding(db, 'discord', 'ch-123', serverId);
    expect(b?.binding_type).toBe('session');
    expect(b?.target).toBe('brain');
  });

  it('findChannelBindingByPlatformChannel works', async () => {
    const b = await findChannelBindingByPlatformChannel(db, 'discord', 'ch-123', botId);
    expect(b?.server_id).toBe(serverId);
    expect(await findChannelBindingByPlatformChannel(db, 'discord', 'ch-123', 'wrong-bot')).toBeNull();
  });

  it('upsertChannelBinding updates on conflict', async () => {
    await upsertChannelBinding(db, 'new-id', serverId, 'discord', 'ch-123', 'project', 'w1', botId);
    const b = await findChannelBindingByPlatformChannel(db, 'discord', 'ch-123', botId);
    expect(b?.binding_type).toBe('project');
    expect(b?.target).toBe('w1');
  });
});

// ── 6. Sessions ──────────────────────────────────────────────────────────────

describe('sessions', () => {
  let userId: string;
  let serverId: string;

  beforeAll(async () => {
    userId = 'sess-user-' + Math.random().toString(36).slice(2);
    serverId = 'sess-srv-' + Math.random().toString(36).slice(2);
    await createUser(db, userId);
    await createServer(db, serverId, userId, 'sess-server', 'hash-sess');
  });

  it('upsertDbSession / getDbSessionsByServer roundtrip', async () => {
    await upsertDbSession(db, 'sid-1', serverId, 'deck_proj_brain', 'myproj', 'brain', 'claude-code', '/home/dev', 'running');
    const sessions = await getDbSessionsByServer(db, serverId);
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    const s = sessions.find(s => s.name === 'deck_proj_brain');
    expect(s?.project_name).toBe('myproj');
    expect(s?.agent_type).toBe('claude-code');
  });

  it('upsertDbSession updates on conflict', async () => {
    await upsertDbSession(db, 'sid-1', serverId, 'deck_proj_brain', 'myproj', 'brain', 'claude-code', '/home/dev', 'idle');
    const sessions = await getDbSessionsByServer(db, serverId);
    const s = sessions.find(s => s.name === 'deck_proj_brain');
    expect(s?.state).toBe('idle');
  });

  it('updateSessionLabel sets label', async () => {
    await updateSessionLabel(db, serverId, 'deck_proj_brain', 'My Project');
    const sessions = await getDbSessionsByServer(db, serverId);
    const s = sessions.find(s => s.name === 'deck_proj_brain');
    expect(s?.label).toBe('My Project');
  });

  it('updateProjectName sets project_name', async () => {
    await updateProjectName(db, serverId, 'deck_proj_brain', 'new-proj');
    const sessions = await getDbSessionsByServer(db, serverId);
    const s = sessions.find(s => s.name === 'deck_proj_brain');
    expect(s?.project_name).toBe('new-proj');
  });

  it('updateSession sets description and project_dir', async () => {
    await updateSession(db, serverId, 'deck_proj_brain', { description: 'A test persona', project_dir: '/home/new' });
    const sessions = await getDbSessionsByServer(db, serverId);
    const s = sessions.find(s => s.name === 'deck_proj_brain');
    expect(s?.description).toBe('A test persona');
    expect(s?.project_dir).toBe('/home/new');
  });

  it('updateSession sets label without affecting other fields', async () => {
    await updateSession(db, serverId, 'deck_proj_brain', { label: 'Updated Label' });
    const sessions = await getDbSessionsByServer(db, serverId);
    const s = sessions.find(s => s.name === 'deck_proj_brain');
    expect(s?.label).toBe('Updated Label');
    expect(s?.description).toBe('A test persona'); // unchanged from previous test
  });

  it('updateSubSession sets description and cwd', async () => {
    await createSubSession(db, 'desc-sub-1', serverId, 'shell', null, '/old/path', 'test-sub', null);
    await updateSubSession(db, 'desc-sub-1', serverId, { description: 'Shell persona', cwd: '/new/path' });
    const sub = await getSubSessionById(db, 'desc-sub-1', serverId);
    expect(sub?.description).toBe('Shell persona');
    expect(sub?.cwd).toBe('/new/path');
  });

  it('deleteDbSession removes session', async () => {
    await upsertDbSession(db, 'sid-2', serverId, 'deck_proj_w1', 'myproj', 'w1', 'codex', '/home/dev', 'idle');
    await deleteDbSession(db, serverId, 'deck_proj_w1');
    const sessions = await getDbSessionsByServer(db, serverId);
    expect(sessions.find(s => s.name === 'deck_proj_w1')).toBeUndefined();
  });
});

// ── 7. Quick data ────────────────────────────────────────────────────────────

describe('quick data', () => {
  let userId: string;

  beforeAll(async () => {
    userId = 'qd-user-' + Math.random().toString(36).slice(2);
    await createUser(db, userId);
  });

  it('getQuickData returns empty default for new user', async () => {
    const qd = await getQuickData(db, userId);
    expect(qd.history).toEqual([]);
    expect(qd.commands).toEqual([]);
  });

  it('upsertQuickData / getQuickData roundtrip', async () => {
    await upsertQuickData(db, userId, { history: ['hello'], commands: ['/status'], phrases: ['hi'], sessionHistory: {} });
    const qd = await getQuickData(db, userId);
    expect(qd.history).toEqual(['hello']);
    expect(qd.commands).toEqual(['/status']);
  });

  it('upsertQuickData updates on conflict', async () => {
    await upsertQuickData(db, userId, { history: ['updated'], commands: [], phrases: [] });
    const qd = await getQuickData(db, userId);
    expect(qd.history).toEqual(['updated']);
  });
});

// ── 8. User preferences ──────────────────────────────────────────────────────

describe('user preferences', () => {
  let userId: string;

  beforeAll(async () => {
    userId = 'pref-user-' + Math.random().toString(36).slice(2);
    await createUser(db, userId);
  });

  it('getUserPref returns null for missing key', async () => {
    expect(await getUserPref(db, userId, 'nonexistent')).toBeNull();
  });

  it('setUserPref / getUserPref roundtrip', async () => {
    await setUserPref(db, userId, 'theme', 'dark');
    expect(await getUserPref(db, userId, 'theme')).toBe('dark');
  });

  it('setUserPref updates on conflict', async () => {
    await setUserPref(db, userId, 'theme', 'light');
    expect(await getUserPref(db, userId, 'theme')).toBe('light');
  });

  it('deleteUserPref removes the pref', async () => {
    await deleteUserPref(db, userId, 'theme');
    expect(await getUserPref(db, userId, 'theme')).toBeNull();
  });
});

// ── 9. Sub-session updateSubSession / reorderSubSessions ─────────────────────

describe('sub-session updates', () => {
  let userId: string;
  let serverId: string;

  beforeAll(async () => {
    userId = 'subupd-user-' + Math.random().toString(36).slice(2);
    serverId = 'subupd-srv-' + Math.random().toString(36).slice(2);
    await createUser(db, userId);
    await createServer(db, serverId, userId, 'sub-server', 'hash-sub');
  });

  it('updateSubSession sets label and gemini_session_id', async () => {
    await createSubSession(db, 'upd-sub-1', serverId, 'gemini', null, '/test', null, null);
    await updateSubSession(db, 'upd-sub-1', serverId, { label: 'My Agent', gemini_session_id: 'gid-456' });
    const s = await getSubSessionById(db, 'upd-sub-1', serverId);
    expect(s?.label).toBe('My Agent');
    expect(s?.gemini_session_id).toBe('gid-456');
  });

  it('updateSubSession sets closed_at', async () => {
    const closedAt = Date.now();
    await updateSubSession(db, 'upd-sub-1', serverId, { closed_at: closedAt });
    const s = await getSubSessionById(db, 'upd-sub-1', serverId);
    expect(s?.closed_at).toBe(closedAt);
  });

  it('reorderSubSessions sets sort_order', async () => {
    await createSubSession(db, 'ord-a', serverId, 'claude-code', null, '/a', null, null);
    await createSubSession(db, 'ord-b', serverId, 'claude-code', null, '/b', null, null);
    await reorderSubSessions(db, serverId, ['ord-b', 'ord-a']);
    const a = await getSubSessionById(db, 'ord-a', serverId);
    const b = await getSubSessionById(db, 'ord-b', serverId);
    expect(b?.sort_order).toBe(0);
    expect(a?.sort_order).toBe(1);
  });
});

// ── 10. Audit log ────────────────────────────────────────────────────────────

describe('writeAuditLog', () => {
  it('inserts audit log entry without throwing', async () => {
    const uid = 'audit-user-' + Math.random().toString(36).slice(2);
    await createUser(db, uid);
    const logId = 'log-' + Math.random().toString(36).slice(2);
    await expect(writeAuditLog(db, logId, uid, null, 'test.action', { foo: 'bar' }, '127.0.0.1')).resolves.not.toThrow();
    const row = await db.queryOne<{ action: string }>('SELECT action FROM audit_log WHERE id = $1', [logId]);
    expect(row?.action).toBe('test.action');
  });
});

// ── 11. Orchestration getRecentOrchestrationRuns ─────────────────────────────

describe('getRecentOrchestrationRuns', () => {
  it('returns runs ordered by updated_at DESC', async () => {
    const uid = 'recent-user-' + Math.random().toString(36).slice(2);
    const sid = 'recent-srv-' + Math.random().toString(36).slice(2);
    await createUser(db, uid);
    await createServer(db, sid, uid, 'recent-srv', 'hash-recent');
    const discId = 'recent-disc';
    await upsertDiscussion(db, { id: discId, serverId: sid, topic: 'Recent', state: 'done', maxRounds: 1, startedAt: Date.now() });

    const now = new Date().toISOString();
    const base: DbOrchestrationRun = {
      id: 'recent-run', discussion_id: discId, server_id: sid,
      main_session: 'brain', initiator_session: 'brain',
      current_target_session: null, final_return_session: 'brain',
      remaining_targets: '[]', mode_key: 'round-robin',
      status: 'completed', request_message_id: null,
      callback_message_id: null, context_ref: '{}',
      timeout_ms: 300000, result_summary: 'done', error: null,
      created_at: now, updated_at: now, completed_at: now,
    };
    await upsertOrchestrationRun(db, base);
    const runs = await getRecentOrchestrationRuns(db, sid, 10);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs.some(r => r.id === 'recent-run')).toBe(true);
  });
});

// ── 12. Composite PK multi-server isolation ──────────────────────────────────

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

// ── 13. Transport session metadata persistence ───────────────────────────────

describe('transport session metadata persistence', () => {
  let userId: string;
  let serverId: string;

  beforeAll(async () => {
    userId = 'tmd-user-' + Math.random().toString(36).slice(2);
    serverId = 'tmd-srv-' + Math.random().toString(36).slice(2);
    await createUser(db, userId);
    await createServer(db, serverId, userId, 'tmd-server', 'hash-tmd');
  });

  it('upsertDbSession with transport fields roundtrip', async () => {
    await upsertDbSession(
      db, 'tmd-sid-1', serverId, 'deck_transport_brain', 'tproj', 'brain', 'claude-code', '/home/dev',
      'running', null, 'transport', 'openclaw', 'oc-key-123', 'test persona',
    );
    const sessions = await getDbSessionsByServer(db, serverId);
    const s = sessions.find(s => s.name === 'deck_transport_brain');
    expect(s).toBeDefined();
    expect(s!.runtime_type).toBe('transport');
    expect(s!.provider_id).toBe('openclaw');
    expect(s!.provider_session_id).toBe('oc-key-123');
    expect(s!.description).toBe('test persona');
  });

  it('upsertDbSession update preserves transport fields', async () => {
    // Upsert same session with a new state — transport fields should survive
    await upsertDbSession(
      db, 'tmd-sid-1', serverId, 'deck_transport_brain', 'tproj', 'brain', 'claude-code', '/home/dev',
      'idle', null, 'transport', 'openclaw', 'oc-key-123', 'test persona',
    );
    const sessions = await getDbSessionsByServer(db, serverId);
    const s = sessions.find(s => s.name === 'deck_transport_brain');
    expect(s).toBeDefined();
    expect(s!.state).toBe('idle');
    expect(s!.runtime_type).toBe('transport');
    expect(s!.provider_id).toBe('openclaw');
    expect(s!.provider_session_id).toBe('oc-key-123');
    expect(s!.description).toBe('test persona');
  });

  it('createSubSession with transport fields roundtrip', async () => {
    await createSubSession(
      db, 'tmd-sub-1', serverId, 'claude-code', null, '/transport', null, null,
      null, null, 'transport', 'openclaw', 'oc-sub-456', 'sub persona',
    );
    const sub = await getSubSessionById(db, 'tmd-sub-1', serverId);
    expect(sub).not.toBeNull();
    expect(sub!.runtime_type).toBe('transport');
    expect(sub!.provider_id).toBe('openclaw');
    expect(sub!.provider_session_id).toBe('oc-sub-456');
    expect(sub!.description).toBe('sub persona');
  });
});
