/** Legacy filename-only executable distribution retirement — real PostgreSQL. */
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

describe('legacy executable routes retirement', () => {
  it.each(['/api/enroll/executable?os=linux', '/api/enroll/available'])(
    '%s is not registered for an authenticated owner',
    async (path) => {
      const userId = `u_${hex(4)}`;
      await createUser(db, userId);
      const token = hex(16);
      const serverId = hex(8);
      await createServer(db, serverId, userId, 'full', sha256(token));
      const response = await buildApp().request(path, {
        headers: { 'X-Server-Id': serverId, authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(404);
    },
  );
});
