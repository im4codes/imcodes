/**
 * POST /api/enroll/new (mint) → redeem round trip — real PostgreSQL (6.7).
 * Completes the enroll new/redeem/single-use/expiry coverage together with
 * enroll.integration.test.ts (redeem/single-use/expiry/unknown).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { randomBytes, createHash } from 'node:crypto';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createUser, createServer } from '../src/db/queries.js';
import { enrollRoutes } from '../src/routes/enroll.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';

let db: Database;
const hex = (n: number) => randomBytes(n).toString('hex');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

beforeAll(async () => { db = createDatabase(process.env.TEST_DATABASE_URL!); await runMigrations(db); });
afterAll(async () => { await db.close(); });

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => { (c as unknown as { env: { DB: Database } }).env = { DB: db }; await next(); });
  app.route('/api/enroll', enrollRoutes);
  return app;
}
async function owner(userId: string) {
  const token = hex(16); const serverId = hex(8);
  await createServer(db, serverId, userId, 'full', sha256(token));
  return { serverId, token };
}

describe('POST /api/enroll/new → redeem', () => {
  it('an authenticated owner mints a one-time code that redeems into a controlled node', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u); const o = await owner(u);

    const mint = await app.request('/api/enroll/new', { method: 'POST', headers: { 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}`, 'content-type': 'application/json' }, body: '{}' });
    expect(mint.status).toBe(200);
    const { enrollToken, expiresAt } = await mint.json() as { enrollToken: string; expiresAt: number };
    expect(enrollToken).toBeTruthy();
    expect(expiresAt).toBeGreaterThan(Date.now());
    // Stored hashed at rest (not raw-only).
    const row = await db.queryOne<{ code_hash: string | null; user_id: string }>('SELECT code_hash, user_id FROM enrollment_codes WHERE code = $1', [enrollToken]);
    expect(row?.code_hash).toBe(sha256(enrollToken));
    expect(row?.user_id).toBe(u);

    const redeem = await app.request('/api/enroll/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enrollToken, installId: 'i1', nodeTokenHash: sha256(hex(16)), hostname: 'h', os: 'linux' }) });
    expect(redeem.status).toBe(200);
    expect((await redeem.json() as { nodeRole: string }).nodeRole).toBe(NODE_ROLE.CONTROLLED);
  });

  it('requires authentication to mint', async () => {
    const app = buildApp();
    const res = await app.request('/api/enroll/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });
});
