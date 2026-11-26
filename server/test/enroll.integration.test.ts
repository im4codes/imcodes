/** Legacy raw-token redemption retirement — real PostgreSQL. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { enrollRoutes } from '../src/routes/enroll.js';

let db: Database;

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
  return app;
}

describe('legacy POST /api/enroll/redeem retirement', () => {
  it('is not registered and cannot return a raw server token', async () => {
    const response = await buildApp().request('/api/enroll/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enrollToken: 'retired-code',
        hostname: 'legacy-host',
        os: 'linux',
      }),
    });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('"token"');
  });
});
