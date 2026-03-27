/**
 * E2E integration tests for P2P config per-session storage + legacy migration.
 *
 * Uses real PostgreSQL (testcontainers) + Hono app to verify:
 *   - Per-session config stored via /api/preferences/:key
 *   - Legacy global key migrated to per-session key
 *   - Config isolated between sessions
 *   - Config shared across devices (same user, same API)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildApp } from '../src/index.js';
import { hashPassword, signJwt, randomHex } from '../src/security/crypto.js';
import type { Env } from '../src/env.js';

let db: Database;
const JWT_KEY = 'test-jwt-key-p2p-config-integration-000';

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

afterAll(async () => {
  await db.close();
});

function makeApp() {
  const env: Env = {
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    JWT_SIGNING_KEY: JWT_KEY,
    BOT_ENCRYPTION_KEY: randomHex(32),
    DB: db,
    NODE_ENV: 'test',
    ALLOWED_ORIGINS: 'http://localhost',
  } as Env;
  return buildApp(env);
}

function csrfHeaders(token: string): Record<string, string> {
  const csrf = randomHex(16);
  return {
    Cookie: `rcc_session=${token}; rcc_csrf=${csrf}`,
    'X-CSRF-Token': csrf,
    'Content-Type': 'application/json',
    Origin: 'http://localhost',
  };
}

async function createUser(username: string): Promise<string> {
  const id = randomHex(16);
  const hash = await hashPassword('test');
  await db.execute(
    'INSERT INTO users (id, username, password_hash, display_name, is_admin, status, created_at) VALUES ($1, $2, $3, $4, true, $5, $6)',
    [id, username, hash, username, 'active', Date.now()],
  );
  return id;
}

function makeToken(userId: string): string {
  return signJwt({ sub: userId, type: 'web' }, JWT_KEY, 3600);
}

describe('P2P config per-session storage', () => {
  let app: ReturnType<typeof makeApp>;
  let userId: string;
  let token: string;

  beforeAll(async () => {
    userId = await createUser(`p2p_test_${randomHex(4)}`);
    token = makeToken(userId);
    app = makeApp();
  });

  beforeEach(async () => {
    // Clean preferences for this user
    await db.execute('DELETE FROM user_preferences WHERE user_id = $1', [userId]);
  });

  it('saves and retrieves per-session P2P config', async () => {
    const key = 'p2p_session_config:deck_proj_brain';
    const config = { sessions: { 'deck_sub_abc': { enabled: true, mode: 'audit' } }, rounds: 3 };

    // Save
    const putRes = await app.request(`/api/preferences/${key}`, {
      method: 'PUT',
      headers: csrfHeaders(token),
      body: JSON.stringify({ value: JSON.stringify(config) }),
    });
    expect(putRes.status).toBe(200);

    // Retrieve
    const getRes = await app.request(`/api/preferences/${key}`, {
      headers: csrfHeaders(token),
    });
    expect(getRes.status).toBe(200);
    const data = await getRes.json() as { value: string };
    const parsed = JSON.parse(data.value);
    expect(parsed.sessions['deck_sub_abc'].mode).toBe('audit');
    expect(parsed.rounds).toBe(3);
  });

  it('isolates config between different sessions', async () => {
    const key1 = 'p2p_session_config:deck_proj_brain';
    const key2 = 'p2p_session_config:deck_other_brain';
    const config1 = { sessions: {}, rounds: 2 };
    const config2 = { sessions: {}, rounds: 5 };

    await app.request(`/api/preferences/${key1}`, {
      method: 'PUT',
      headers: csrfHeaders(token),
      body: JSON.stringify({ value: JSON.stringify(config1) }),
    });
    await app.request(`/api/preferences/${key2}`, {
      method: 'PUT',
      headers: csrfHeaders(token),
      body: JSON.stringify({ value: JSON.stringify(config2) }),
    });

    const res1 = await app.request(`/api/preferences/${key1}`, { headers: csrfHeaders(token) });
    const res2 = await app.request(`/api/preferences/${key2}`, { headers: csrfHeaders(token) });

    const d1 = JSON.parse((await res1.json() as { value: string }).value);
    const d2 = JSON.parse((await res2.json() as { value: string }).value);

    expect(d1.rounds).toBe(2);
    expect(d2.rounds).toBe(5);
  });

  it('legacy global key readable alongside per-session key', async () => {
    const legacyKey = 'p2p_session_config';
    const sessionKey = 'p2p_session_config:deck_proj_brain';
    const legacyConfig = { sessions: { 'deck_sub_old': { enabled: true, mode: 'review' } }, rounds: 1 };

    // Save under legacy key (simulates old client)
    await app.request(`/api/preferences/${legacyKey}`, {
      method: 'PUT',
      headers: csrfHeaders(token),
      body: JSON.stringify({ value: JSON.stringify(legacyConfig) }),
    });

    // Per-session key returns nothing
    const sessionRes = await app.request(`/api/preferences/${sessionKey}`, { headers: csrfHeaders(token) });
    const sessionData = await sessionRes.json() as { value: unknown };
    expect(sessionData.value).toBeNull();

    // Legacy key still returns data
    const legacyRes = await app.request(`/api/preferences/${legacyKey}`, { headers: csrfHeaders(token) });
    const legacyData = await legacyRes.json() as { value: string };
    const parsed = JSON.parse(legacyData.value);
    expect(parsed.rounds).toBe(1);
    expect(parsed.sessions['deck_sub_old'].mode).toBe('review');
  });

  it('migration: writing per-session key after reading legacy key', async () => {
    const legacyKey = 'p2p_session_config';
    const sessionKey = 'p2p_session_config:deck_proj_brain';
    const config = { sessions: {}, rounds: 3, extraPrompt: 'be thorough' };

    // Legacy save
    await app.request(`/api/preferences/${legacyKey}`, {
      method: 'PUT',
      headers: csrfHeaders(token),
      body: JSON.stringify({ value: JSON.stringify(config) }),
    });

    // Read legacy, then migrate to per-session (simulates frontend behavior)
    const legacyRes = await app.request(`/api/preferences/${legacyKey}`, { headers: csrfHeaders(token) });
    const legacyData = await legacyRes.json() as { value: string };

    await app.request(`/api/preferences/${sessionKey}`, {
      method: 'PUT',
      headers: csrfHeaders(token),
      body: JSON.stringify({ value: legacyData.value }),
    });

    // Now per-session key has the data
    const sessionRes = await app.request(`/api/preferences/${sessionKey}`, { headers: csrfHeaders(token) });
    const sessionData = await sessionRes.json() as { value: string };
    const parsed = JSON.parse(sessionData.value);
    expect(parsed.rounds).toBe(3);
    expect(parsed.extraPrompt).toBe('be thorough');
  });

  it('config accessible from different "devices" (same user token)', async () => {
    const key = 'p2p_session_config:deck_proj_brain';
    const config = { sessions: { 's1': { enabled: true, mode: 'brainstorm' } }, rounds: 2 };

    // "Device 1" saves
    await app.request(`/api/preferences/${key}`, {
      method: 'PUT',
      headers: csrfHeaders(token),
      body: JSON.stringify({ value: JSON.stringify(config) }),
    });

    // "Device 2" reads (same user, fresh token)
    const token2 = makeToken(userId);
    const res = await app.request(`/api/preferences/${key}`, { headers: csrfHeaders(token2) });
    const data = await res.json() as { value: string };
    const parsed = JSON.parse(data.value);
    expect(parsed.sessions['s1'].mode).toBe('brainstorm');
    expect(parsed.rounds).toBe(2);
  });
});
