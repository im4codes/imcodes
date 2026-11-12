import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createUser, getUserPref, setUserPref } from '../src/db/queries.js';
import { preferencesRoutes } from '../src/routes/preferences.js';
import { signJwt } from '../src/security/crypto.js';

const secret = 'pinned-preferences-isolated-test-secret';
let db: Database;
const app = new Hono().route('/api/preferences', preferencesRoutes);
beforeAll(async () => { db = createDatabase(process.env.TEST_DATABASE_URL!); await runMigrations(db); });
afterAll(async () => { await db?.close(); });
const envelope = (v: unknown, t: number) => JSON.stringify({ v, t });
async function user() { const id = randomUUID(); await createUser(db, id); return id; }
async function request(userId: string, key: string, value?: unknown) {
  return app.request(`/api/preferences/${key}`, {
    method: value === undefined ? 'GET' : 'PUT',
    headers: { Authorization: `Bearer ${signJwt({ sub: userId, type: 'web' }, secret, 3600)}`, 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify({ value }),
  }, { DB: db, JWT_SIGNING_KEY: secret });
}
async function read(userId: string, key = 'server_pinned') {
  const response = await request(userId, key);
  expect(response.status).toBe(200);
  const result = await response.json() as { value: unknown };
  return typeof result.value === 'string' ? JSON.parse(result.value) : result.value;
}

describe('durable pinned-server preferences through authenticated HTTP and PostgreSQL', () => {
  it('does not overwrite a newer pin with a late old PUT', async () => {
    const id = await user();
    expect((await request(id, 'server_pinned', envelope(['pinned'], 200))).status).toBe(200);
    expect((await request(id, 'server_pinned', envelope([], 100))).status).toBe(200);
    expect(await read(id)).toEqual({ v: ['pinned'], t: 200 });
  });

  it('serializes competing first-insert writers and permits a later explicit unpin', async () => {
    const id = await user();
    await Promise.all(Array.from({ length: 12 }, (_, i) => request(id, 'server_pinned', envelope([`pin-${i}`], 100 + i))));
    expect(await read(id)).toEqual({ v: ['pin-11'], t: 111 });
    await request(id, 'server_pinned', envelope([], 200));
    await request(id, 'server_pinned', envelope(['old-device'], 150));
    expect(await read(id)).toEqual({ v: [], t: 200 });
  });

  it('keeps the server value on ties and accepts both string and object envelopes', async () => {
    const id = await user();
    await request(id, 'server_pinned', { v: ['first'], t: 50 });
    await request(id, 'server_pinned', envelope([], 50));
    expect(await read(id)).toEqual({ v: ['first'], t: 50 });
    await request(id, 'server_pinned', envelope(['new'], 51));
    expect(await read(id)).toEqual({ v: ['new'], t: 51 });
  });

  it('isolates owners and preference keys while retaining legacy scalar writes', async () => {
    const a = await user(); const b = await user();
    await request(a, 'server_pinned', envelope(['a'], 200));
    await request(b, 'server_pinned', envelope(['b'], 10));
    await request(a, 'server_order', envelope(['b', 'a'], 1));
    expect(await read(a)).toEqual({ v: ['a'], t: 200 });
    expect(await read(b)).toEqual({ v: ['b'], t: 10 });
    expect(await read(a, 'server_order')).toEqual({ v: ['b', 'a'], t: 1 });
    await request(a, 'theme', 'dark'); await request(a, 'theme', 'light');
    expect(await getUserPref(db, a, 'theme')).toBe(JSON.stringify('light'));
    await setUserPref(db, a, 'legacy', '/bin/zsh');
    await request(a, 'legacy', envelope(['upgraded'], 1));
    expect(await read(a, 'legacy')).toEqual({ v: ['upgraded'], t: 1 });
  });
});
