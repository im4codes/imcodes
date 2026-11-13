/**
 * Per-server push notification opt-in integration tests — real PostgreSQL via testcontainers.
 *
 * Verifies migration 106_push_enabled_servers.sql, GET/POST /api/push/preferences
 * persistence across browser (no token) and native device registration, partial
 * update isolation, and dispatchPush enforcement alongside activeUserExistsSql.
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
let serverA: string;
let serverB: string;

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
  authUserId = userId;
  serverA = randomHex(16);
  serverB = randomHex(16);

  await createUser(db, userId, 'push-server-filter-test');
  await createServer(db, serverA, userId, 'Server A', sha256Hex(randomHex(32)));
  await createServer(db, serverB, userId, 'Server B', sha256Hex(randomHex(32)));
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.execute('DELETE FROM push_tokens WHERE user_id = $1', [userId]);
  await db.execute("UPDATE users SET push_enabled_server_ids = '{}', badge_count = 0, status = 'active' WHERE id = $1", [userId]);
});

describe('per-server push notification allowlist (PostgreSQL)', () => {
  it('defaults enabledServerIds to [] and preserves browser selection before and after mobile registration', async () => {
    // 1. Initial GET with no push_tokens row -> enabledServerIds: []
    const get1 = await app.request('/api/push/preferences');
    expect(get1.status).toBe(200);
    expect(await get1.json()).toEqual({
      ok: true,
      types: DEFAULT_PUSH_NOTIFICATION_TYPES,
      defaultTypes: DEFAULT_PUSH_NOTIFICATION_TYPES,
      enabledServerIds: [],
    });

    // 2. Browser saves enabledServerIds before any mobile device token exists
    const postServers = await app.request('/api/push/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabledServerIds: [serverA] }),
    });
    expect(postServers.status).toBe(200);
    expect(await postServers.json()).toEqual({ ok: true, enabledServerIds: [serverA] });

    // 3. Mobile device registers token later -> must NOT wipe users.push_enabled_server_ids
    const reg = await app.request('/api/push/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'mobile-reg-1', platform: PUSH_PLATFORM_ANDROID_JPUSH }),
    });
    expect(reg.status).toBe(200);

    // 4. Updating types alone preserves enabledServerIds
    const postTypes = await app.request('/api/push/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ types: [PUSH_NOTIFICATION_TYPE_TASK_COMPLETE] }),
    });
    expect(postTypes.status).toBe(200);

    const get2 = await app.request('/api/push/preferences?token=mobile-reg-1');
    expect(get2.status).toBe(200);
    expect(await get2.json()).toEqual({
      ok: true,
      types: [PUSH_NOTIFICATION_TYPE_TASK_COMPLETE],
      defaultTypes: DEFAULT_PUSH_NOTIFICATION_TYPES,
      enabledServerIds: [serverA],
    });
  });

  it('dispatchPush suppresses all servers by default, delivers only checked servers, and enforces activeUserExistsSql', async () => {
    await db.execute(
      'INSERT INTO push_tokens (user_id, token, platform, notification_types, created_at) VALUES ($1, $2, $3, $4, $5)',
      [userId, 'jpush-token-1', PUSH_PLATFORM_ANDROID_JPUSH, [PUSH_NOTIFICATION_TYPE_TASK_COMPLETE, PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE], Date.now()],
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ sendno: '1', msg_id: '123' }), { status: 200 }),
    );
    const env = { DB: db, JPUSH_APP_KEY: 'k', JPUSH_MASTER_SECRET: 's' } as never;

    try {
      // Default [] suppresses serverA
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
