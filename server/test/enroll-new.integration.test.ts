/** Legacy enrollment mint retirement — real PostgreSQL. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { randomBytes, createHash } from 'node:crypto';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createUser, createServer } from '../src/db/queries.js';
import { enrollRoutes } from '../src/routes/enroll.js';

let db: Database;
const hex = (n: number) => randomBytes(n).toString('hex');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

beforeAll(async () => { db = createDatabase(process.env.TEST_DATABASE_URL!); await runMigrations(db); });
afterAll(async () => { await db.close(); });

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as unknown as { env: { DB: Database } }).env = { DB: db };
    await next();
  });
  app.route('/api/enroll', enrollRoutes);
  return app;
}

describe('legacy POST /api/enroll/new retirement', () => {
  it('is not registered, even for an authenticated owner', async () => {
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const token = hex(16);
    const serverId = hex(8);
    await createServer(db, serverId, userId, 'full', sha256(token));

    const response = await buildApp().request('/api/enroll/new', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Server-Id': serverId,
        authorization: `Bearer ${token}`,
      },
      body: '{}',
    });
    expect(response.status).toBe(404);
  });

  it('migration 054 removes the plaintext enrollment_codes table', async () => {
    const row = await db.queryOne<{ table_name: string | null }>(
      "SELECT to_regclass('public.enrollment_codes')::text AS table_name",
    );
    expect(row?.table_name).toBeNull();
  });
});
