/**
 * The requests the web "Memory" tab (and the panel it lives in) fires, against the real
 * app + PostgreSQL. A 404 `not_found` here is the SAME body whichever request it came from,
 * which is why the web used to show a bare "API 404: not_found": this pins which requests
 * answer 200 for the account's own data and which answer 404 for data that is not theirs
 * (permissions are not relaxed - the web explains the 404 instead).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildApp } from '../src/index.js';
import { hashPassword, signJwt, randomHex, sha256Hex } from '../src/security/crypto.js';
import type { Env } from '../src/env.js';

let db: Database;
const JWT_KEY = 'test-jwt-key-for-memory-tab-requests-0000';

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});
afterAll(async () => { await db.close(); });

const makeApp = () => buildApp({
  DATABASE_URL: process.env.TEST_DATABASE_URL!,
  JWT_SIGNING_KEY: JWT_KEY,
  BOT_ENCRYPTION_KEY: randomHex(32),
  DB: db,
  NODE_ENV: 'test',
  ALLOWED_ORIGINS: 'http://localhost',
} as Env);

async function createUser(username: string): Promise<string> {
  const id = randomHex(16);
  await db.execute(
    'INSERT INTO users (id, username, password_hash, display_name, password_must_change, is_admin, status, created_at) VALUES ($1, $2, $3, $4, false, false, $5, $6)',
    [id, username, await hashPassword('testpass'), username, 'active', Date.now()],
  );
  return id;
}

async function createServer(userId: string): Promise<string> {
  const serverId = randomHex(16);
  await db.execute(
    'INSERT INTO servers (id, name, user_id, token_hash, created_at) VALUES ($1, $2, $3, $4, $5)',
    [serverId, 'srv', userId, sha256Hex('daemon-token'), Date.now()],
  );
  return serverId;
}

const headers = (userId: string, withBody = false): Record<string, string> => {
  const csrf = randomHex(16);
  return {
    Cookie: `rcc_session=${signJwt({ sub: userId, type: 'web' }, JWT_KEY, 3600)}; rcc_csrf=${csrf}`,
    'X-CSRF-Token': csrf,
    Origin: 'http://localhost',
    ...(withBody ? { 'Content-Type': 'application/json' } : {}),
  };
};

describe('memory tab requests', () => {
  let owner: string;
  let stranger: string;
  let serverId: string;

  beforeEach(async () => {
    await db.exec('TRUNCATE users CASCADE');
    await db.exec('TRUNCATE servers CASCADE');
    await db.exec('TRUNCATE shared_context_projections CASCADE');
    owner = await createUser('owner');
    stranger = await createUser('stranger');
    serverId = await createServer(owner);
  });

  it('answers 200 for the account\'s own server runtime config, personal memory and own enterprise memory', async () => {
    const app = makeApp();
    const created = await app.request('/api/team', { method: 'POST', headers: headers(owner, true), body: JSON.stringify({ name: 'Acme' }) });
    expect(created.status).toBe(201);
    const { id: teamId } = await created.json() as { id: string };

    expect((await app.request(`/api/server/${serverId}/shared-context/runtime-config`, { headers: headers(owner) })).status).toBe(200);
    expect((await app.request('/api/shared-context/personal-memory?limit=25', { headers: headers(owner) })).status).toBe(200);
    expect((await app.request(`/api/shared-context/enterprises/${teamId}/memory?limit=25`, { headers: headers(owner) })).status).toBe(200);
  });

  it('answers 404 not_found - never 200 - for another account\'s server and for an enterprise the account is not in', async () => {
    const app = makeApp();
    const created = await app.request('/api/team', { method: 'POST', headers: headers(owner, true), body: JSON.stringify({ name: 'Acme' }) });
    const { id: teamId } = await created.json() as { id: string };

    // The panel's own `serverId` is the selected server; one the account does not own is 404.
    const runtime = await app.request(`/api/server/${serverId}/shared-context/runtime-config`, { headers: headers(stranger) });
    expect(runtime.status).toBe(404);
    expect(await runtime.json()).toMatchObject({ error: 'not_found' });

    // An enterprise id remembered by a pinned panel after the account left (or never joined).
    const enterprise = await app.request(`/api/shared-context/enterprises/${teamId}/memory?limit=25`, { headers: headers(stranger) });
    expect(enterprise.status).toBe(404);
    expect(await enterprise.json()).toMatchObject({ error: 'not_found' });
    const unknown = await app.request('/api/shared-context/enterprises/does-not-exist/memory?limit=25', { headers: headers(owner) });
    expect(unknown.status).toBe(404);

    // The stranger's own personal memory is unaffected (no cross-user leak, no 404).
    const personal = await app.request('/api/shared-context/personal-memory?limit=25', { headers: headers(stranger) });
    expect(personal.status).toBe(200);
  });
});
