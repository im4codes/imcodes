/**
 * Enrollment routes — real PostgreSQL (testcontainers via integration-global).
 * Covers redeem success (creates a CONTROLLED server), single-use, and expiry.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/queries.js';
import { enrollRoutes } from '../src/routes/enroll.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';

let db: Database;

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

afterAll(async () => {
  await db.close();
});

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as unknown as { env: { DB: Database } }).env = { DB: db };
    await next();
  });
  app.route('/api/enroll', enrollRoutes);
  return app;
}

async function seedCode(code: string, userId: string, expiresAt: number): Promise<void> {
  await db.execute(
    'INSERT INTO enrollment_codes (code, user_id, expires_at, created_at) VALUES ($1, $2, $3, $4)',
    [code, userId, expiresAt, Date.now()],
  );
}

describe('POST /api/enroll/redeem', () => {
  it('redeems a valid code into a CONTROLLED server credential', async () => {
    const app = buildApp();
    const userId = `u_${Math.floor(Date.now()).toString(36)}_ok`;
    await createUser(db, userId);
    const code = `enrolltoken_ok_${userId}`;
    await seedCode(code, userId, Date.now() + 60_000);

    const res = await app.request('/api/enroll/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enrollToken: code, hostname: 'win桌面', os: 'win32-x64' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { serverId: string; token: string; nodeRole: string };
    expect(body.serverId).toBeTruthy();
    expect(body.token).toBeTruthy();
    expect(body.nodeRole).toBe(NODE_ROLE.CONTROLLED);

    // Server row persisted with the controlled role, under the code's account.
    const row = await db.queryOne<{ node_role: string; user_id: string }>(
      'SELECT node_role, user_id FROM servers WHERE id = $1',
      [body.serverId],
    );
    expect(row?.node_role).toBe(NODE_ROLE.CONTROLLED);
    expect(row?.user_id).toBe(userId);

    // Code is burned.
    const used = await db.queryOne<{ used_at: string | null; redeemed_server_id: string | null }>(
      'SELECT used_at, redeemed_server_id FROM enrollment_codes WHERE code = $1',
      [code],
    );
    expect(used?.used_at).not.toBeNull();
    expect(used?.redeemed_server_id).toBe(body.serverId);
  });

  it('rejects a second redeem of the same code (single-use)', async () => {
    const app = buildApp();
    const userId = `u_${Math.floor(Date.now()).toString(36)}_once`;
    await createUser(db, userId);
    const code = `enrolltoken_once_${userId}`;
    await seedCode(code, userId, Date.now() + 60_000);

    const first = await app.request('/api/enroll/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enrollToken: code, hostname: 'h', os: 'linux' }),
    });
    expect(first.status).toBe(200);

    const second = await app.request('/api/enroll/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enrollToken: code, hostname: 'h', os: 'linux' }),
    });
    expect(second.status).toBe(404);
  });

  it('rejects an expired code', async () => {
    const app = buildApp();
    const userId = `u_${Math.floor(Date.now()).toString(36)}_exp`;
    await createUser(db, userId);
    const code = `enrolltoken_exp_${userId}`;
    await seedCode(code, userId, Date.now() - 1_000); // already expired

    const res = await app.request('/api/enroll/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enrollToken: code, hostname: 'h', os: 'darwin' }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects an unknown code', async () => {
    const app = buildApp();
    const res = await app.request('/api/enroll/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enrollToken: 'does-not-exist', hostname: 'h', os: 'linux' }),
    });
    expect(res.status).toBe(404);
  });
});
