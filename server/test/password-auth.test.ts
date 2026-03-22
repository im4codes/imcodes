/**
 * Tests for password authentication (Task 10) and account deletion (Task 13).
 * Uses the real crypto module (scrypt hashing), no mocks.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from '../src/index.js';
import type { Env } from '../src/env.js';
import type { PgDatabase } from '../src/db/client.js';
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

function makeMemDb(): PgDatabase {
  const users = new Map<string, MemUser>();
  const apiKeys = new Map<string, { id: string; user_id: string; key_hash: string; label: string | null; created_at: number; revoked_at: number | null; grace_expires_at: number | null }>();
  const refreshTokens = new Map<string, { id: string; user_id: string; token_hash: string; family_id: string; used_at: number | null; expires_at: number; created_at: number }>();
  const servers = new Map<string, { id: string; user_id: string; name: string }>();
  const auditLog: unknown[] = [];
  const lockouts = new Map<string, { identity: string; failed_attempts: number; locked_until: number | null; last_attempt_at: number }>();

  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async <T = unknown>(): Promise<T | null> => {
          const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();

          if (s.includes('from users where id')) {
            return (users.get(args[0] as string) ?? null) as T | null;
          }
          if (s.includes('from users where username')) {
            for (const u of users.values()) {
              if (u.username === args[0]) return u as T;
            }
            return null;
          }
          if (s.includes('from api_keys where key_hash') && s.includes('revoked_at is null')) {
            for (const k of apiKeys.values()) {
              if (k.key_hash === args[0] && !k.revoked_at) return { user_id: k.user_id } as T;
            }
            return null;
          }
          if (s.includes('from api_keys where id')) {
            for (const k of apiKeys.values()) {
              if (k.id === args[0] && k.user_id === args[1]) return { id: k.id } as T;
            }
            return null;
          }
          if (s.includes('from auth_lockout')) {
            return (lockouts.get(args[0] as string) ?? null) as T | null;
          }
          if (s.includes('count(*) as cnt from users')) {
            return { cnt: users.size } as T;
          }
          return null;
        },
        all: async <T = unknown>() => {
          const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
          if (s.includes('from servers where user_id')) {
            const results: unknown[] = [];
            for (const sv of servers.values()) {
              if (sv.user_id === args[0]) results.push(sv);
            }
            return { results: results as T[] };
          }
          if (s.includes('from api_keys') && s.includes('where user_id')) {
            const results: unknown[] = [];
            for (const k of apiKeys.values()) {
              if (k.user_id === args[0]) results.push(k);
            }
            return { results: results as T[] };
          }
          return { results: [] as T[] };
        },
        run: async () => {
          const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();

          if (s.includes('insert into users')) {
            users.set(args[0] as string, {
              id: args[0] as string,
              created_at: args[1] as number,
              username: null,
              password_hash: null,
              display_name: null,
              password_must_change: null,
              is_admin: false,
              status: 'active',
            });
          }
          if (s.includes('insert into api_keys')) {
            apiKeys.set(args[0] as string, {
              id: args[0] as string,
              user_id: args[1] as string,
              key_hash: args[2] as string,
              label: args.length > 4 ? args[3] as string : null,
              created_at: args[args.length - 1] as number,
              revoked_at: null,
              grace_expires_at: null,
            });
          }
          if (s.includes('insert into refresh_tokens')) {
            refreshTokens.set(args[0] as string, {
              id: args[0] as string,
              user_id: args[1] as string,
              token_hash: args[2] as string,
              family_id: args[3] as string,
              used_at: null,
              expires_at: args[4] as number,
              created_at: args[5] as number,
            });
          }
          if (s.includes('update users set password_hash') && s.includes('password_must_change')) {
            const user = users.get(args[1] as string);
            if (user) {
              user.password_hash = args[0] as string;
              user.password_must_change = false;
            }
          }
          if (s.includes('delete from users where id')) {
            users.delete(args[0] as string);
          }
          if (s.includes('delete from api_keys where user_id')) {
            for (const [k, v] of apiKeys) {
              if (v.user_id === args[0]) apiKeys.delete(k);
            }
          }
          if (s.includes('delete from refresh_tokens where user_id')) {
            for (const [k, v] of refreshTokens) {
              if (v.user_id === args[0]) refreshTokens.delete(k);
            }
          }
          if (s.includes('insert into audit_log')) {
            auditLog.push(args);
          }
          if (s.includes('insert into auth_lockout') || s.includes('update auth_lockout')) {
            // simplified lockout handling
          }
          return { changes: 1 };
        },
      }),
    }),
    exec: async () => ({ rows: [] }),
  } as unknown as PgDatabase;
}

// Helper to seed a user with password in the mock DB
async function seedPasswordUser(db: PgDatabase, id: string, username: string, password: string, mustChange = false) {
  const hash = await hashPassword(password);
  const now = Date.now();
  await db.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').bind(id, now).run();
  // Manually patch the user record
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<MemUser>();
  if (user) {
    user.username = username;
    user.password_hash = hash;
    user.password_must_change = mustChange;
  }
}

function makeEnv(db?: PgDatabase): Env {
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
  let db: PgDatabase;
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
      body: JSON.stringify({ oldPassword: 'imcodes', newPassword: 'newpassword123' }),
    });
    expect(changeRes.status).toBe(200);
    const body = await changeRes.json() as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verify new password works
    const res2 = await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'newpassword123' }),
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
      body: JSON.stringify({ oldPassword: 'wrongold', newPassword: 'newpassword123' }),
    });
    expect(changeRes.status).toBe(401);
  });

  it('rejects password change without auth', async () => {
    const res = await app.request('/api/auth/password/change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword: 'imcodes', newPassword: 'newpassword123' }),
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
  let db: PgDatabase;
  let app: ReturnType<typeof buildApp>;
  let env: Env;

  beforeEach(async () => {
    db = makeMemDb();
    env = makeEnv(db);
    app = buildApp(env);
    await seedPasswordUser(db, 'user-del', 'delme', 'password123');
  });

  it('deletes account with valid auth', async () => {
    // Login
    const loginRes = await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'delme', password: 'password123' }),
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
      body: JSON.stringify({ username: 'delme', password: 'password123' }),
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
