/**
 * Controlled-node hardening — real PostgreSQL (testcontainers via integration-global).
 * Covers D-A transactional/idempotent redeem, global node_role default-deny,
 * revocation kill-switch, and the owner-scoped DB-backed machine listing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { randomBytes, createHash } from 'node:crypto';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createUser, createServer } from '../src/db/queries.js';
import { enrollRoutes } from '../src/routes/enroll.js';
import { machinesRoutes } from '../src/routes/machines.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';

let db: Database;
const hex = (n: number) => randomBytes(n).toString('hex');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});
afterAll(async () => { await db.close(); });

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as unknown as { env: { DB: Database } }).env = { DB: db };
    await next();
  });
  app.route('/api/enroll', enrollRoutes);
  app.route('/api/machines', machinesRoutes);
  return app;
}

async function seedCode(code: string, userId: string): Promise<void> {
  await db.execute(
    'INSERT INTO enrollment_codes (code, code_hash, user_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)',
    [code, sha256(code), userId, Date.now() + 60_000, Date.now()],
  );
}

/** A FULL server credential for `userId`, usable as X-Server-Id + Bearer. */
async function fullCredential(userId: string): Promise<{ serverId: string; token: string }> {
  const token = hex(16);
  const serverId = hex(8);
  await createServer(db, serverId, userId, 'full-box', sha256(token)); // node_role defaults to full
  return { serverId, token };
}

describe('D-A transactional / idempotent redeem', () => {
  it('returns the same server for a repeated installId and creates no second machine', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const code = `tok_${hex(6)}`;
    await seedCode(code, userId);
    const nodeToken = hex(16);
    const payload = { enrollToken: code, installId: 'install-1', nodeTokenHash: sha256(nodeToken), hostname: 'win桌面 (x64)', os: 'win32-x64' };

    const r1 = await app.request('/api/enroll/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    expect(r1.status).toBe(200);
    const b1 = await r1.json() as { serverId: string; token?: string; refName: string; nodeRole: string };
    expect(b1.nodeRole).toBe(NODE_ROLE.CONTROLLED);
    expect(b1.token).toBeUndefined(); // D-A: server does not return an unrecoverable raw token
    expect(b1.refName).toMatch(/^[\p{L}\p{N}._-]{1,40}$/u);

    const r2 = await app.request('/api/enroll/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    expect(r2.status).toBe(200);
    const b2 = await r2.json() as { serverId: string };
    expect(b2.serverId).toBe(b1.serverId); // idempotent

    const count = await db.queryOne<{ n: string }>('SELECT COUNT(*)::text AS n FROM servers WHERE user_id = $1 AND node_role = $2', [userId, NODE_ROLE.CONTROLLED]);
    expect(count?.n).toBe('1');
  });
});

describe('global node_role default-deny', () => {
  it('denies a controlled credential on a normal REST API (GET /api/machines)', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const code = `tok_${hex(6)}`;
    await seedCode(code, userId);
    const nodeToken = hex(16);
    const r = await app.request('/api/enroll/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enrollToken: code, installId: 'i1', nodeTokenHash: sha256(nodeToken), hostname: 'h', os: 'linux' }),
    });
    const { serverId } = await r.json() as { serverId: string };

    // The controlled node's own credential must NOT reach a normal REST API.
    const denied = await app.request('/api/machines', {
      headers: { 'X-Server-Id': serverId, authorization: `Bearer ${nodeToken}` },
    });
    expect(denied.status).toBe(403);
  });
});

describe('revocation kill-switch', () => {
  it('rejects a revoked controlled credential', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const owner = await fullCredential(userId);
    const code = `tok_${hex(6)}`;
    await seedCode(code, userId);
    const nodeToken = hex(16);
    const r = await app.request('/api/enroll/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enrollToken: code, installId: 'i1', nodeTokenHash: sha256(nodeToken), hostname: 'h', os: 'linux' }),
    });
    const { serverId } = await r.json() as { serverId: string };

    const revoke = await app.request(`/api/machines/${serverId}/revoke`, {
      method: 'POST', headers: { 'X-Server-Id': owner.serverId, authorization: `Bearer ${owner.token}` },
    });
    expect(revoke.status).toBe(200);

    // After revoke the controlled credential is rejected outright (resolveAuth → null → 401).
    const after = await app.request('/api/machines', {
      headers: { 'X-Server-Id': serverId, authorization: `Bearer ${nodeToken}` },
    });
    expect(after.status).toBe(401);
  });
});

describe('owner-scoped machine listing (DB presence)', () => {
  it('lists the owner controlled machines (offline by default) and hides other accounts', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    const otherId = `u_${hex(4)}`;
    await createUser(db, userId);
    await createUser(db, otherId);
    const owner = await fullCredential(userId);
    const other = await fullCredential(otherId);
    const code = `tok_${hex(6)}`;
    await seedCode(code, userId);
    await app.request('/api/enroll/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enrollToken: code, installId: 'i1', nodeTokenHash: sha256(hex(16)), hostname: 'mybox', os: 'linux' }),
    });

    const mine = await app.request('/api/machines', { headers: { 'X-Server-Id': owner.serverId, authorization: `Bearer ${owner.token}` } });
    expect(mine.status).toBe(200);
    const list = (await mine.json() as { machines: { serverId: string; online: boolean; execEnabled: boolean }[] }).machines;
    expect(list.length).toBe(1);
    expect(list[0].online).toBe(false); // no heartbeat yet
    expect(list[0].execEnabled).toBe(false); // D-E default off

    const theirs = await app.request('/api/machines', { headers: { 'X-Server-Id': other.serverId, authorization: `Bearer ${other.token}` } });
    expect(((await theirs.json() as { machines: unknown[] }).machines).length).toBe(0);
  });
});
