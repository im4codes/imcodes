/**
 * Per-server push notification opt-in integration tests — real PostgreSQL via testcontainers.
 *
 * Verifies migration 106_push_enabled_servers.sql (TEXT[] DEFAULT NULL),
 * GET/POST /api/push/preferences persistence across browser (no token) and native
 * device registration, partial update isolation, 1-server auto-enable vs >1-server
 * auto-disable rules, 1->2 untouched transition, explicit [] manual mute override,
 * team-shared server count alignment, deleted/unknown IDs, and activeUserExistsSql.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createUser, createServer } from '../src/db/queries.js';
import { sha256Hex, randomHex } from '../src/security/crypto.js';
import {
  DEFAULT_PUSH_NOTIFICATION_TYPES,
  PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
  PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE,
  PUSH_PLATFORM_ANDROID_JPUSH,
} from '../../shared/push-notifications.js';

let authUserId = '';

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: any, next: any) => {
    c.set('userId', authUserId);
    c.set('role', 'user');
    return next();
  },
}));

import { pushRoutes, dispatchPush } from '../src/routes/push.js';

let db: Database;
let userId: string;
let singleUserId: string;
let peerOwnerId: string;
let serverA: string;
let serverB: string;
let serverSingle: string;
let sharedServer: string;

const app = new Hono();
app.use('/*', async (c, next) => {
  (c as any).env = {
    DB: db,
    JPUSH_APP_KEY: 'mock-key',
    JPUSH_MASTER_SECRET: 'mock-secret',
  };
  return next();
});
app.route('/api/push', pushRoutes);

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);

  userId = randomHex(16);
  singleUserId = randomHex(16);
  peerOwnerId = randomHex(16);
  serverA = randomHex(16);
  serverB = randomHex(16);
  serverSingle = randomHex(16);
  sharedServer = randomHex(16);

  await createUser(db, userId, 'push-multi-server-user');
  await createServer(db, serverA, userId, 'Server A', sha256Hex(randomHex(32)));
  await createServer(db, serverB, userId, 'Server B', sha256Hex(randomHex(32)));

  await createUser(db, singleUserId, 'push-single-server-user');
  await createServer(db, serverSingle, singleUserId, 'Single Server', sha256Hex(randomHex(32)));

  await createUser(db, peerOwnerId, 'push-peer-owner');
  await createServer(db, sharedServer, peerOwnerId, 'Peer Shared Server', sha256Hex(randomHex(32)));
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  authUserId = userId;
  await db.execute('DELETE FROM push_tokens WHERE user_id IN ($1, $2)', [userId, singleUserId]);
  await db.execute('DELETE FROM servers WHERE user_id = $1 AND id != $2', [singleUserId, serverSingle]);
  await db.execute('DELETE FROM team_members WHERE user_id = $1', [singleUserId]);
  await db.execute('DELETE FROM machine_groups WHERE server_id = $1', [sharedServer]);
  await db.execute(
    "UPDATE users SET push_enabled_server_ids = NULL, badge_count = 0, status = 'active' WHERE id IN ($1, $2)",
    [userId, singleUserId],
  );
});

describe('per-server push notification allowlist (PostgreSQL)', () => {
  it('defaults push_enabled_server_ids to NULL, preserves NULL/[]/array across mobile register, and isolates partial updates', async () => {
    const rawCol = await db.queryOne<{ push_enabled_server_ids: string[] | null }>(
      'SELECT push_enabled_server_ids FROM users WHERE id = $1',
      [userId],
    );
    expect(rawCol?.push_enabled_server_ids).toBeNull();

    // 1. Initial GET with no push_tokens row -> enabledServerIds: null
    const get1 = await app.request('/api/push/preferences');
    expect(get1.status).toBe(200);
    expect(await get1.json()).toEqual({
      ok: true,
      types: DEFAULT_PUSH_NOTIFICATION_TYPES,
      defaultTypes: DEFAULT_PUSH_NOTIFICATION_TYPES,
      enabledServerIds: null,
    });

    // 2. Registering device token must keep NULL untouched
    const regNull = await app.request('/api/push/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'mobile-reg-null', platform: PUSH_PLATFORM_ANDROID_JPUSH }),
    });
    expect(regNull.status).toBe(200);
    const afterRegNull = await db.queryOne<{ push_enabled_server_ids: string[] | null }>(
      'SELECT push_enabled_server_ids FROM users WHERE id = $1',
      [userId],
    );
    expect(afterRegNull?.push_enabled_server_ids).toBeNull();

    // 3. Updating types alone preserves NULL
    await app.request('/api/push/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ types: [PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE] }),
    });
    const getAfterTypes = await app.request('/api/push/preferences');
    expect(await getAfterTypes.json()).toEqual({
      ok: true,
      types: [PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE],
      defaultTypes: DEFAULT_PUSH_NOTIFICATION_TYPES,
      enabledServerIds: null,
    });

    // 4. Browser saves explicit [] -> register later must NOT overwrite []
    const postEmpty = await app.request('/api/push/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabledServerIds: [] }),
    });
    expect(postEmpty.status).toBe(200);
    expect(await postEmpty.json()).toEqual({ ok: true, enabledServerIds: [] });

    await app.request('/api/push/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'mobile-reg-1', platform: PUSH_PLATFORM_ANDROID_JPUSH }),
    });

    // 5. Save [serverA] then update types alone -> preserves [serverA]
    await app.request('/api/push/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabledServerIds: [serverA] }),
    });
    await app.request('/api/push/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ types: [PUSH_NOTIFICATION_TYPE_TASK_COMPLETE] }),
    });

    const get2 = await app.request('/api/push/preferences?token=mobile-reg-1');
    expect(get2.status).toBe(200);
    expect(await get2.json()).toEqual({
      ok: true,
      types: [PUSH_NOTIFICATION_TYPE_TASK_COMPLETE],
      defaultTypes: DEFAULT_PUSH_NOTIFICATION_TYPES,
      enabledServerIds: [serverA],
    });
  });

  it('auto-enables 1 server when NULL, auto-disables on 1->2 own/shared transition, and respects explicit [] mute', async () => {
    authUserId = singleUserId;
    await db.execute(
      'INSERT INTO push_tokens (user_id, token, platform, notification_types, created_at) VALUES ($1, $2, $3, $4, $5)',
      [singleUserId, 'single-user-jpush', PUSH_PLATFORM_ANDROID_JPUSH, DEFAULT_PUSH_NOTIFICATION_TYPES, Date.now()],
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ sendno: '1', msg_id: '123' }), { status: 200 }),
    );
    const env = { DB: db, JPUSH_APP_KEY: 'k', JPUSH_MASTER_SECRET: 's' } as never;

    try {
      // 1 server + NULL -> auto-enabled!
      await dispatchPush({
        userId: singleUserId,
        serverId: serverSingle,
        title: 'Single Server',
        body: 'Auto enabled for single server',
        type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
      }, env);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Unknown/deleted server is still rejected even when 1 server is auto-enabled
      await dispatchPush({
        userId: singleUserId,
        serverId: 'nonexistent-server',
        title: 'Unknown Server',
        body: 'Rejected',
        type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
      }, env);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Share a 2nd server via team/machine_groups -> accessible count becomes 2 while NULL -> auto-disabled!
      const teamId = randomHex(12);
      await db.execute(
        "INSERT INTO teams (id, name, owner_id, plan, created_at) VALUES ($1, 'Shared Team', $2, 'free', $3)",
        [teamId, peerOwnerId, Date.now()],
      );
      await db.execute(
        "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'member', $3)",
        [teamId, singleUserId, Date.now()],
      );
      await db.execute(
        'INSERT INTO machine_groups (server_id, team_id, added_at) VALUES ($1, $2, $3)',
        [sharedServer, teamId, Date.now()],
      );

      await dispatchPush({
        userId: singleUserId,
        serverId: serverSingle,
        title: 'Single Server after share',
        body: 'Auto suppressed because accessible > 1',
        type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
      }, env);
      await dispatchPush({
        userId: singleUserId,
        serverId: sharedServer,
        title: 'Shared Server',
        body: 'Auto suppressed because accessible > 1',
        type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
      }, env);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Remove team access -> accessible drops back to 1 -> auto-enabled again while NULL
      await db.execute('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, singleUserId]);
      await dispatchPush({
        userId: singleUserId,
        serverId: serverSingle,
        title: 'Single Server restored',
        body: 'Auto enabled again',
        type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
      }, env);
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      // User manually unchecks single server -> explicit [] -> stays suppressed even with 1 server
      await app.request('/api/push/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledServerIds: [] }),
      });
      await dispatchPush({
        userId: singleUserId,
        serverId: serverSingle,
        title: 'Single Server muted',
        body: 'Explicit [] must suppress',
        type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
      }, env);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('dispatchPush suppresses >1 servers when NULL, delivers only checked servers, and enforces activeUserExistsSql', async () => {
    await db.execute(
      'INSERT INTO push_tokens (user_id, token, platform, notification_types, created_at) VALUES ($1, $2, $3, $4, $5)',
      [userId, 'jpush-token-1', PUSH_PLATFORM_ANDROID_JPUSH, [PUSH_NOTIFICATION_TYPE_TASK_COMPLETE, PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE], Date.now()],
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ sendno: '1', msg_id: '123' }), { status: 200 }),
    );
    const env = { DB: db, JPUSH_APP_KEY: 'k', JPUSH_MASTER_SECRET: 's' } as never;

    try {
      // NULL with 2 servers suppresses both serverA and serverB
      await dispatchPush({
        userId,
        serverId: serverA,
        title: 'Server A',
        body: 'Should be suppressed',
        type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
        data: { serverId: serverA },
      }, env);
      expect(fetchSpy).not.toHaveBeenCalled();

      // Enable serverA (plus a deleted/unknown server ID)
      await app.request('/api/push/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledServerIds: ['deleted-server-id', serverA] }),
      });

      // serverA dispatches
      await dispatchPush({
        userId,
        serverId: serverA,
        title: 'Server A',
        body: 'Allowed',
        type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
        data: { serverId: serverA },
      }, env);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // serverB stays suppressed
      await dispatchPush({
        userId,
        serverId: serverB,
        title: 'Server B',
        body: 'Suppressed',
        type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
        data: { serverId: serverB },
      }, env);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Disabled user receives nothing even for enabled serverA
      await db.execute("UPDATE users SET status = 'disabled' WHERE id = $1", [userId]);
      await dispatchPush({
        userId,
        serverId: serverA,
        title: 'Server A',
        body: 'Disabled user',
        type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
        data: { serverId: serverA },
      }, env);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
