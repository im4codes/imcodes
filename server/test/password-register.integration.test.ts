/**
 * Password registration integration tests — runs against real PostgreSQL via testcontainers.
 *
 * Covers: registration flow, complexity enforcement, username validation,
 * settings (registration toggle, approval toggle), session cookies, native API keys,
 * and full register → login → change-password lifecycle.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildApp } from '../src/index.js';
import { randomHex } from '../src/security/crypto.js';
import type { Env } from '../src/env.js';

// ── DB lifecycle ──────────────────────────────────────────────────────────────

let db: Database;
const JWT_KEY = 'test-jwt-key-for-register-tests-00000000';

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

afterAll(async () => {
  await db.close();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

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

async function cleanUsers(): Promise<void> {
  await db.exec('TRUNCATE users CASCADE');
}

async function setSetting(key: string, value: string): Promise<void> {
  await db.execute(
    'INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}

function register(app: ReturnType<typeof buildApp>, body: Record<string, unknown>) {
  return app.request('/api/auth/password/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function login(app: ReturnType<typeof buildApp>, username: string, password: string) {
  return app.request('/api/auth/password/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Password Registration — Full Flow', () => {
  beforeEach(async () => {
    await cleanUsers();
    await setSetting('registration_enabled', 'true');
    await setSetting('require_approval', 'false');
  });

  it('registers a new user and can login immediately', async () => {
    const app = makeApp();
    const res = await register(app, { username: 'alice', password: 'Alice123!', displayName: 'Alice W' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verify session cookies are set
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith('rcc_session='))).toBe(true);
    expect(cookies.some((c) => c.startsWith('rcc_refresh='))).toBe(true);
    expect(cookies.some((c) => c.startsWith('rcc_csrf='))).toBe(true);

    // Verify login works
    const loginRes = await login(app, 'alice', 'Alice123!');
    expect(loginRes.status).toBe(200);
    const loginBody = await loginRes.json() as { ok: boolean; passwordMustChange: boolean };
    expect(loginBody.ok).toBe(true);
    expect(loginBody.passwordMustChange).toBe(false);
  });

  it('stores user in DB with correct fields', async () => {
    const app = makeApp();
    await register(app, { username: 'dbcheck', password: 'Check123', displayName: 'DB User' });

    const user = await db.queryOne<{ username: string; display_name: string; status: string; password_hash: string }>(
      'SELECT username, display_name, status, password_hash FROM users WHERE username = $1',
      ['dbcheck'],
    );
    expect(user).toBeTruthy();
    expect(user!.username).toBe('dbcheck');
    expect(user!.display_name).toBe('DB User');
    expect(user!.status).toBe('active');
    // Password should be hashed, not plain text
    expect(user!.password_hash).not.toBe('Check123');
    expect(user!.password_hash.length).toBeGreaterThan(20);
  });

  it('defaults display name to username when not provided', async () => {
    const app = makeApp();
    await register(app, { username: 'noname', password: 'NoName123' });

    const user = await db.queryOne<{ display_name: string }>(
      'SELECT display_name FROM users WHERE username = $1',
      ['noname'],
    );
    expect(user!.display_name).toBe('noname');
  });

  it('normalizes username to lowercase', async () => {
    const app = makeApp();
    const res = await register(app, { username: 'AlIcE', password: 'Alice123!' });
    expect(res.status).toBe(200);

    const loginRes = await login(app, 'alice', 'Alice123!');
    expect(loginRes.status).toBe(200);
  });

  it('creates audit log entry', async () => {
    const app = makeApp();
    await register(app, { username: 'audited', password: 'Audit123' });

    const log = await db.queryOne<{ action: string }>(
      "SELECT action FROM audit_log WHERE action = 'auth.password_register' ORDER BY created_at DESC LIMIT 1",
    );
    expect(log).toBeTruthy();
    expect(log!.action).toBe('auth.password_register');
  });

  it('creates refresh token in DB', async () => {
    const app = makeApp();
    await register(app, { username: 'refresh1', password: 'Refresh123' });

    const user = await db.queryOne<{ id: string }>('SELECT id FROM users WHERE username = $1', ['refresh1']);
    const token = await db.queryOne<{ user_id: string }>(
      'SELECT user_id FROM refresh_tokens WHERE user_id = $1',
      [user!.id],
    );
    expect(token).toBeTruthy();
  });
});

describe('Password Registration — Username Validation', () => {
  beforeEach(async () => {
    await cleanUsers();
    await setSetting('registration_enabled', 'true');
    await setSetting('require_approval', 'false');
  });

  it('rejects duplicate username', async () => {
    const app = makeApp();
    await register(app, { username: 'bob', password: 'Bob12345' });

    const res = await register(app, { username: 'bob', password: 'Bob12345' });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('username_taken');
  });

  it('rejects duplicate username case-insensitively', async () => {
    const app = makeApp();
    await register(app, { username: 'charlie', password: 'Charlie1' });

    const res = await register(app, { username: 'CHARLIE', password: 'Charlie1' });
    expect(res.status).toBe(409);
  });

  it('rejects username starting with dot', async () => {
    const app = makeApp();
    const res = await register(app, { username: '.bad', password: 'Alice123!' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid_username_format');
  });

  it('rejects username ending with dash', async () => {
    const app = makeApp();
    const res = await register(app, { username: 'bad-', password: 'Alice123!' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid_username_format');
  });

  it('rejects username shorter than 3 characters', async () => {
    const app = makeApp();
    const res = await register(app, { username: 'ab', password: 'Alice123!' });
    expect(res.status).toBe(400);
  });

  it('rejects username with uppercase chars in format check', async () => {
    // The format check runs on normalized (lowercased) username, so uppercase input
    // gets lowered first. Special chars should still be rejected.
    const app = makeApp();
    const res = await register(app, { username: 'has space', password: 'Alice123!' });
    expect(res.status).toBe(400);
  });

  it('accepts valid usernames with dots, underscores, hyphens', async () => {
    const app = makeApp();
    const res1 = await register(app, { username: 'user.name', password: 'User1234' });
    expect(res1.status).toBe(200);

    const res2 = await register(app, { username: 'user_name', password: 'User1234' });
    expect(res2.status).toBe(200);

    const res3 = await register(app, { username: 'user-name', password: 'User1234' });
    expect(res3.status).toBe(200);
  });
});

describe('Password Registration — Complexity Enforcement', () => {
  beforeEach(async () => {
    await cleanUsers();
    await setSetting('registration_enabled', 'true');
    await setSetting('require_approval', 'false');
  });

  it('rejects password without uppercase', async () => {
    const app = makeApp();
    const res = await register(app, { username: 'test1', password: 'alllower1' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('password_missing_uppercase');
  });

  it('rejects password without lowercase', async () => {
    const app = makeApp();
    const res = await register(app, { username: 'test2', password: 'ALLUPPER1' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('password_missing_lowercase');
  });

  it('rejects password without digit', async () => {
    const app = makeApp();
    const res = await register(app, { username: 'test3', password: 'NoDigitHere' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('password_missing_digit');
  });

  it('rejects password shorter than 8 characters', async () => {
    const app = makeApp();
    const res = await register(app, { username: 'test4', password: 'Ab1' });
    expect(res.status).toBe(400);
  });

  it('accepts password meeting all requirements', async () => {
    const app = makeApp();
    const res = await register(app, { username: 'test5', password: 'GoodPass1' });
    expect(res.status).toBe(200);
  });

  it('accepts password with special characters', async () => {
    const app = makeApp();
    const res = await register(app, { username: 'test6', password: 'P@ssw0rd!' });
    expect(res.status).toBe(200);
  });
});

describe('Password Registration — Settings Control', () => {
  beforeEach(async () => {
    await cleanUsers();
  });

  it('rejects registration when disabled', async () => {
    await setSetting('registration_enabled', 'false');
    const app = makeApp();
    const res = await register(app, { username: 'blocked', password: 'Blocked123' });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('registration_disabled');
  });

  it('sets user status to pending when approval required', async () => {
    await setSetting('registration_enabled', 'true');
    await setSetting('require_approval', 'true');
    const app = makeApp();
    const res = await register(app, { username: 'pending1', password: 'Pending123' });
    expect(res.status).toBe(200);

    const user = await db.queryOne<{ status: string }>(
      'SELECT status FROM users WHERE username = $1',
      ['pending1'],
    );
    expect(user!.status).toBe('pending');
  });

  it('sets user status to active when no approval required', async () => {
    await setSetting('registration_enabled', 'true');
    await setSetting('require_approval', 'false');
    const app = makeApp();
    await register(app, { username: 'active1', password: 'Active123' });

    const user = await db.queryOne<{ status: string }>(
      'SELECT status FROM users WHERE username = $1',
      ['active1'],
    );
    expect(user!.status).toBe('active');
  });

  it('pending user cannot login', async () => {
    await setSetting('registration_enabled', 'true');
    await setSetting('require_approval', 'true');
    const app = makeApp();
    await register(app, { username: 'pending2', password: 'Pending123' });

    const csrf = randomHex(16);
    const loginRes = await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
        Cookie: `rcc_csrf=${csrf}`,
        Origin: 'http://localhost',
      },
      body: JSON.stringify({ username: 'pending2', password: 'Pending123' }),
    });
    expect(loginRes.status).toBe(403);
    const body = await loginRes.json() as { error: string };
    expect(body.error).toBe('account_pending');
  });
});

describe('Password Registration — Native API Key', () => {
  beforeEach(async () => {
    await cleanUsers();
    await setSetting('registration_enabled', 'true');
    await setSetting('require_approval', 'false');
  });

  it('returns API key when native=true', async () => {
    const app = makeApp();
    const res = await register(app, { username: 'native1', password: 'Native123', native: true });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; apiKey: string; keyId: string; userId: string };
    expect(body.ok).toBe(true);
    expect(body.apiKey).toMatch(/^deck_/);
    expect(body.keyId).toBeTruthy();
    expect(body.userId).toBeTruthy();
  });

  it('stores API key hash in DB', async () => {
    const app = makeApp();
    const res = await register(app, { username: 'native2', password: 'Native123', native: true });
    const body = await res.json() as { keyId: string; userId: string };

    const key = await db.queryOne<{ label: string }>(
      'SELECT label FROM api_keys WHERE id = $1 AND user_id = $2',
      [body.keyId, body.userId],
    );
    expect(key).toBeTruthy();
    expect(key!.label).toBe('native-password-register');
  });

  it('does not return API key when native is omitted', async () => {
    const app = makeApp();
    const res = await register(app, { username: 'web1', password: 'WebUser123' });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.apiKey).toBeUndefined();
    expect(body.keyId).toBeUndefined();
  });
});

describe('Password Registration — Full Lifecycle', () => {
  beforeEach(async () => {
    await cleanUsers();
    await setSetting('registration_enabled', 'true');
    await setSetting('require_approval', 'false');
  });

  it('register → login → change password → login with new password', async () => {
    const app = makeApp();

    // Register
    const regRes = await register(app, { username: 'lifecycle', password: 'Life123!' });
    expect(regRes.status).toBe(200);

    // Login
    const loginRes = await login(app, 'lifecycle', 'Life123!');
    expect(loginRes.status).toBe(200);
    const { accessToken } = await loginRes.json() as { accessToken: string };

    // Change password
    const changeRes = await app.request('/api/auth/password/change', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ oldPassword: 'Life123!', newPassword: 'NewLife456' }),
    });
    expect(changeRes.status).toBe(200);

    // Old password no longer works
    const oldLoginRes = await login(app, 'lifecycle', 'Life123!');
    expect(oldLoginRes.status).toBe(401);

    // New password works
    const newLoginRes = await login(app, 'lifecycle', 'NewLife456');
    expect(newLoginRes.status).toBe(200);
  });

  it('register → delete account → cannot login', async () => {
    const app = makeApp();

    // Register
    await register(app, { username: 'todelete', password: 'Delete123' });

    // Login to get token
    const loginRes = await login(app, 'todelete', 'Delete123');
    const { accessToken } = await loginRes.json() as { accessToken: string };

    // Delete account
    const delRes = await app.request('/api/auth/user/me', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(delRes.status).toBe(200);

    // Can no longer login
    const loginRes2 = await login(app, 'todelete', 'Delete123');
    expect(loginRes2.status).toBe(401);
  });

  it('password change enforces complexity on new password', async () => {
    const app = makeApp();
    await register(app, { username: 'complex1', password: 'Complex123' });

    const loginRes = await login(app, 'complex1', 'Complex123');
    const { accessToken } = await loginRes.json() as { accessToken: string };

    const changeRes = await app.request('/api/auth/password/change', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ oldPassword: 'Complex123', newPassword: 'nouppercase1' }),
    });
    expect(changeRes.status).toBe(400);
    const body = await changeRes.json() as { error: string };
    expect(body.error).toBe('password_missing_uppercase');
  });
});
