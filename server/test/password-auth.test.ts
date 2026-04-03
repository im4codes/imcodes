/**
 * Tests for password authentication (Task 10) and account deletion (Task 13).
 * Uses the real crypto module (scrypt hashing), no mocks.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from '../src/index.js';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';
import { hashPassword } from '../src/security/crypto.js';

// ── In-memory mock DB ─────────────────────────────────────────────────────────

interface MemUser {
  id: string;
  created_at: number;
  username: string | null;
  password_hash: string | null;
  display_name: string | null;
  password_must_change: boolean | null;
  is_admin: boolean;
  status: 'active' | 'pending' | 'disabled';
}

function makeMemDb(): Database {
  const users = new Map<string, MemUser>();
  const apiKeys = new Map<string, { id: string; user_id: string; key_hash: string; label: string | null; created_at: number; revoked_at: number | null; grace_expires_at: number | null }>();
  const refreshTokens = new Map<string, { id: string; user_id: string; token_hash: string; family_id: string; used_at: number | null; expires_at: number; created_at: number }>();
  const servers = new Map<string, { id: string; user_id: string; name: string }>();
  const auditLog: unknown[] = [];
  const lockouts = new Map<string, { identity: string; failed_attempts: number; locked_until: number | null; last_attempt_at: number }>();

  function normalize(sql: string): string {
    return sql.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  return {
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> => {
      const s = normalize(sql);

      if (s.includes('from users where id')) {
        return (users.get(params[0] as string) ?? null) as T | null;
      }
      if (s.includes('from users where username')) {
        for (const u of users.values()) {
          if (u.username === params[0]) return u as T;
        }
        return null;
      }
      if (s.includes('from api_keys where key_hash') && s.includes('revoked_at is null')) {
        for (const k of apiKeys.values()) {
          if (k.key_hash === params[0] && !k.revoked_at) return { user_id: k.user_id } as T;
        }
        return null;
      }
      if (s.includes('from api_keys where id')) {
        for (const k of apiKeys.values()) {
          if (k.id === params[0] && k.user_id === params[1]) return { id: k.id } as T;
        }
        return null;
      }
      if (s.includes('from auth_lockout')) {
        return (lockouts.get(params[0] as string) ?? null) as T | null;
      }
      if (s.includes('count(*) as cnt from users')) {
        return { cnt: users.size } as T;
      }
      if (s.includes('from settings where key')) {
        // registration_enabled=true, require_approval=false by default
        const key = params[0] as string;
        if (key === 'registration_enabled') return { value: 'true' } as T;
        if (key === 'require_approval') return { value: 'false' } as T;
        return null;
      }
      return null;
    },
    query: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> => {
      const s = normalize(sql);
      if (s.includes('from servers where user_id')) {
        const results: unknown[] = [];
        for (const sv of servers.values()) {
          if (sv.user_id === params[0]) results.push(sv);
        }
        return results as T[];
      }
      if (s.includes('from api_keys') && s.includes('where user_id')) {
        const results: unknown[] = [];
        for (const k of apiKeys.values()) {
          if (k.user_id === params[0]) results.push(k);
        }
        return results as T[];
      }
      return [] as T[];
    },
    execute: async (sql: string, params: unknown[] = []): Promise<{ changes: number }> => {
      const s = normalize(sql);

      if (s.includes('insert into users')) {
        users.set(params[0] as string, {
          id: params[0] as string,
          created_at: params[1] as number,
          username: null,
          password_hash: null,
          display_name: null,
          password_must_change: null,
          is_admin: false,
          status: 'active',
        });
      }
      if (s.includes('insert into api_keys')) {
        apiKeys.set(params[0] as string, {
          id: params[0] as string,
          user_id: params[1] as string,
          key_hash: params[2] as string,
          label: params.length > 4 ? params[3] as string : null,
          created_at: params[params.length - 1] as number,
          revoked_at: null,
          grace_expires_at: null,
        });
      }
      if (s.includes('insert into refresh_tokens')) {
        refreshTokens.set(params[0] as string, {
          id: params[0] as string,
          user_id: params[1] as string,
          token_hash: params[2] as string,
          family_id: params[3] as string,
          used_at: null,
          expires_at: params[4] as number,
          created_at: params[5] as number,
        });
      }
      if (s.includes('update users set password_hash') && s.includes('password_must_change')) {
        const user = users.get(params[1] as string);
        if (user) {
          user.password_hash = params[0] as string;
          user.password_must_change = false;
        }
      }
      if (s.includes('update users set username') && s.includes('password_hash') && s.includes('display_name')) {
        const user = users.get(params[3] as string);
        if (user) {
          user.username = params[0] as string;
          user.password_hash = params[1] as string;
          user.display_name = params[2] as string;
        }
      }
      if (s.includes('update users set status')) {
        const user = users.get(params[1] as string);
        if (user) user.status = params[0] as MemUser['status'];
      }
      if (s.includes('delete from users where id')) {
        users.delete(params[0] as string);
      }
      if (s.includes('delete from api_keys where user_id')) {
        for (const [k, v] of apiKeys) {
          if (v.user_id === params[0]) apiKeys.delete(k);
        }
      }
      if (s.includes('delete from refresh_tokens where user_id')) {
        for (const [k, v] of refreshTokens) {
          if (v.user_id === params[0]) refreshTokens.delete(k);
        }
      }
      if (s.includes('insert into audit_log')) {
        auditLog.push(params);
      }
      if (s.includes('insert into auth_lockout') || s.includes('update auth_lockout')) {
        // simplified lockout handling
      }
      return { changes: 1 };
    },
    exec: async () => {},
    close: async () => {},
  } as unknown as Database;
}

// Helper to seed a user with password in the mock DB
async function seedPasswordUser(db: Database, id: string, username: string, password: string, mustChange = false) {
  const hash = await hashPassword(password);
  const now = Date.now();
  await db.execute('INSERT INTO users (id, created_at) VALUES ($1, $2)', [id, now]);
  // Manually patch the user record
  const user = await db.queryOne<MemUser>('SELECT * FROM users WHERE id = $1', [id]);
  if (user) {
    user.username = username;
    user.password_hash = hash;
    user.password_must_change = mustChange;
  }
}

function makeEnv(db?: Database): Env {
  return {
    DB: db ?? makeMemDb(),
    JWT_SIGNING_KEY: 'test-signing-key-32chars-padding!!',
    BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
    SERVER_URL: 'http://localhost:3000',
    ALLOWED_ORIGINS: '',
    TRUSTED_PROXIES: '',
    BIND_HOST: '127.0.0.1',
    PORT: '3000',
    NODE_ENV: 'development',
    DATABASE_URL: '',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Password authentication', () => {
  let db: Database;
  let app: ReturnType<typeof buildApp>;
  let env: Env;

  beforeEach(async () => {
    db = makeMemDb();
    env = makeEnv(db);
    app = buildApp(env);
    // Seed a test user with password
    await seedPasswordUser(db, 'user1', 'admin', 'imcodes', true);
  });

  it('logs in with correct username and password', async () => {
    const res = await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'imcodes' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; passwordMustChange: boolean; accessToken: string };
    expect(body.ok).toBe(true);
    expect(body.passwordMustChange).toBe(true);
    expect(body.accessToken).toBeTruthy();
  });

  it('rejects incorrect password', async () => {
    const res = await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid_credentials');
  });

  it('rejects non-existent username', async () => {
    const res = await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'test' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects empty body', async () => {
    const res = await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  it('changes password successfully', async () => {
    // Login first to get auth token
    const loginRes = await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'imcodes' }),
    });
    const { accessToken } = await loginRes.json() as { accessToken: string };

    // Change password
    const changeRes = await app.request('/api/auth/password/change', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ oldPassword: 'imcodes', newPassword: 'NewPass123' }),
    });
    expect(changeRes.status).toBe(200);
    const body = await changeRes.json() as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verify new password works
    const res2 = await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'NewPass123' }),
    });
    expect(res2.status).toBe(200);
  });

  it('rejects password change with wrong old password', async () => {
    const loginRes = await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'imcodes' }),
    });
    const { accessToken } = await loginRes.json() as { accessToken: string };

    const changeRes = await app.request('/api/auth/password/change', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ oldPassword: 'wrongold', newPassword: 'NewPass123' }),
    });
    expect(changeRes.status).toBe(401);
  });

  it('rejects password change without auth', async () => {
    const res = await app.request('/api/auth/password/change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword: 'imcodes', newPassword: 'NewPass123' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects new password shorter than 8 chars', async () => {
    const loginRes = await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'imcodes' }),
    });
    const { accessToken } = await loginRes.json() as { accessToken: string };

    const changeRes = await app.request('/api/auth/password/change', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ oldPassword: 'imcodes', newPassword: 'short' }),
    });
    expect(changeRes.status).toBe(400);
  });
});

describe('Account deletion', () => {
  let db: Database;
  let app: ReturnType<typeof buildApp>;
  let env: Env;

  beforeEach(async () => {
    db = makeMemDb();
    env = makeEnv(db);
    app = buildApp(env);
    await seedPasswordUser(db, 'user-del', 'delme', 'Password123');
  });

  it('deletes account with valid auth', async () => {
    // Login
    const loginRes = await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'delme', password: 'Password123' }),
    });
    expect(loginRes.status).toBe(200);
    const { accessToken } = await loginRes.json() as { accessToken: string };

    // Delete account
    const delRes = await app.request('/api/auth/user/me', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(delRes.status).toBe(200);
    const body = await delRes.json() as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verify user no longer exists (login should fail)
    const loginRes2 = await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'delme', password: 'Password123' }),
    });
    expect(loginRes2.status).toBe(401);
  });

  it('rejects account deletion without auth', async () => {
    const res = await app.request('/api/auth/user/me', {
      method: 'DELETE',
    });
    expect(res.status).toBe(401);
  });
});

describe('Password registration', () => {
  let db: Database;
  let app: ReturnType<typeof buildApp>;
  let env: Env;

  beforeEach(async () => {
    db = makeMemDb();
    env = makeEnv(db);
    app = buildApp(env);
  });

  it('registers a new user with username and password', async () => {
    const res = await app.request('/api/auth/password/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'Alice123!', displayName: 'Alice' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verify login works with the registered credentials
    const loginRes = await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'Alice123!' }),
    });
    expect(loginRes.status).toBe(200);
  });

  it('rejects duplicate username', async () => {
    // First registration
    await app.request('/api/auth/password/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: 'Bob12345', displayName: 'Bob' }),
    });

    // Duplicate
    const res = await app.request('/api/auth/password/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: 'Bob12345', displayName: 'Bob2' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('username_taken');
  });

  it('rejects invalid username format', async () => {
    const res = await app.request('/api/auth/password/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '.bad', password: 'Alice123!' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid_username_format');
  });

  it('returns native API key when native=true', async () => {
    const res = await app.request('/api/auth/password/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'native1', password: 'Native123', native: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; apiKey: string; keyId: string; userId: string };
    expect(body.ok).toBe(true);
    expect(body.apiKey).toBeTruthy();
    expect(body.keyId).toBeTruthy();
    expect(body.userId).toBeTruthy();
  });
});

describe('Password complexity enforcement', () => {
  let db: Database;
  let app: ReturnType<typeof buildApp>;
  let env: Env;

  beforeEach(async () => {
    db = makeMemDb();
    env = makeEnv(db);
    app = buildApp(env);
    await seedPasswordUser(db, 'user1', 'admin', 'imcodes', true);
  });

  it('rejects registration without uppercase', async () => {
    const res = await app.request('/api/auth/password/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test1', password: 'alllower1' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('password_missing_uppercase');
  });

  it('rejects registration without lowercase', async () => {
    const res = await app.request('/api/auth/password/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test2', password: 'ALLUPPER1' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('password_missing_lowercase');
  });

  it('rejects registration without digit', async () => {
    const res = await app.request('/api/auth/password/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test3', password: 'NoDigitHere' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('password_missing_digit');
  });

  it('rejects password change without uppercase', async () => {
    const loginRes = await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'imcodes' }),
    });
    const { accessToken } = await loginRes.json() as { accessToken: string };

    const changeRes = await app.request('/api/auth/password/change', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ oldPassword: 'imcodes', newPassword: 'alllower1' }),
    });
    expect(changeRes.status).toBe(400);
    const body = await changeRes.json() as { error: string };
    expect(body.error).toBe('password_missing_uppercase');
  });

  it('accepts password with all complexity requirements met', async () => {
    const res = await app.request('/api/auth/password/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'good1', password: 'GoodPass1' }),
    });
    expect(res.status).toBe(200);
  });
});
