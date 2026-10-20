/**
 * Auth lockout integration tests — runs against real PostgreSQL via testcontainers.
 *
 * Owner decision: lockouts only ever target a single account (username + user
 * id dimensions), never a shared IP/proxy bucket. Covers: a locked user is
 * blocked while a different user's login and refresh both keep working, a
 * fresh (never-attempted) username is unaffected, and a locked user unlocks
 * once the lockout window has passed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildApp } from '../src/index.js';
import { randomHex } from '../src/security/crypto.js';
import type { Env } from '../src/env.js';

let db: Database;
const JWT_KEY = 'test-jwt-key-for-lockout-tests-000000000';

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

async function cleanState(): Promise<void> {
  await db.exec('TRUNCATE users CASCADE');
  await db.exec('TRUNCATE auth_lockout');
}

async function setSetting(key: string, value: string): Promise<void> {
  await db.execute(
    'INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}

function register(app: ReturnType<typeof buildApp>, username: string, password: string) {
  return app.request('/api/auth/password/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

function login(app: ReturnType<typeof buildApp>, username: string, password: string) {
  return app.request('/api/auth/password/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

function refresh(app: ReturnType<typeof buildApp>, refreshToken: string) {
  return app.request('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
}

describe('Auth lockout — account-only dimensions (real PostgreSQL)', () => {
  beforeEach(async () => {
    await cleanState();
    await setSetting('registration_enabled', 'true');
    await setSetting('require_approval', 'false');
  });

  it('locks only the failed account: a different user logs in and refreshes, and a fresh username is unaffected', async () => {
    const app = makeApp();
    await register(app, 'alice', 'Alice123!');
    await register(app, 'bob', 'Bob12345!');

    // 5 failed attempts trip the lockout for alice specifically.
    for (let i = 0; i < 5; i += 1) {
      const res = await login(app, 'alice', 'WrongPass1');
      expect(res.status).toBe(401);
    }
    const lockedRes = await login(app, 'alice', 'Alice123!');
    expect(lockedRes.status).toBe(429);
    const lockedBody = await lockedRes.json() as { error: string; retryAfterMs: number };
    expect(lockedBody.error).toBe('too_many_attempts');
    expect(lockedBody.retryAfterMs).toBeGreaterThan(0);

    // A different user is completely unaffected: login and refresh both work.
    const bobLogin = await login(app, 'bob', 'Bob12345!');
    expect(bobLogin.status).toBe(200);
    const bobBody = await bobLogin.json() as { refreshToken: string };
    const bobRefresh = await refresh(app, bobBody.refreshToken);
    expect(bobRefresh.status).toBe(200);

    // A fresh username's own single failure is recorded (so repeated guessing
    // against it can still lock later) but it is not locked by alice's state,
    // and one failure alone never locks it.
    const freshRes = await login(app, 'never-seen', 'anything');
    expect(freshRes.status).toBe(401);
    const freshRow = await db.queryOne<{ fail_count: number; locked_until: Date | null }>(
      'SELECT fail_count, locked_until FROM auth_lockout WHERE identity = $1',
      ['username:never-seen'],
    );
    expect(freshRow?.fail_count).toBe(1);
    expect(freshRow?.locked_until).toBeNull();

    // The locked account's rows exist under account-only dimensions, never an IP.
    const rows = await db.query<{ identity: string }>('SELECT identity FROM auth_lockout ORDER BY identity');
    for (const row of rows) {
      expect(row.identity.startsWith('username:') || row.identity.startsWith('user:')).toBe(true);
      expect(row.identity.startsWith('ip:')).toBe(false);
    }
  });

  it('unlocks the account once the lockout window has passed', async () => {
    const app = makeApp();
    await register(app, 'carol', 'Carol1234!');
    const user = await db.queryOne<{ id: string }>('SELECT id FROM users WHERE username = $1', ['carol']);

    for (let i = 0; i < 5; i += 1) {
      await login(app, 'carol', 'WrongPass1');
    }
    const stillLocked = await login(app, 'carol', 'Carol1234!');
    expect(stillLocked.status).toBe(429);

    // Simulate the 15-minute window having already elapsed for both
    // dimensions this identity locks under.
    await db.execute(
      "UPDATE auth_lockout SET first_fail_at = NOW() - INTERVAL '20 minutes', locked_until = NOW() - INTERVAL '5 minutes' WHERE identity = $1",
      ['username:carol'],
    );
    await db.execute(
      "UPDATE auth_lockout SET first_fail_at = NOW() - INTERVAL '20 minutes', locked_until = NOW() - INTERVAL '5 minutes' WHERE identity = $1",
      [`user:${user!.id}`],
    );

    const unlockedRes = await login(app, 'carol', 'Carol1234!');
    expect(unlockedRes.status).toBe(200);
  });
});
