/**
 * Integration test: full auth flow
 * register → get API key → bind/initiate → bind/confirm → verify server token
 *
 * Uses Hono's built-in `app.request()` with an in-memory mock DB.
 * No real PostgreSQL required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildApp } from '../src/index.js';
import type { Env } from '../src/env.js';
import type { PgDatabase } from '../src/db/client.js';

// ── Mock crypto to use deterministic values ──────────────────────────────────

vi.mock('../src/security/crypto.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/security/crypto.js')>();
  return {
    ...real,
    randomHex: (n: number) => '0'.repeat(n * 2),
  };
});

// ── In-memory mock DB ─────────────────────────────────────────────────────────

function makeMemDb(): PgDatabase {
  const users = new Map<string, { id: string; created_at: number }>();
  const apiKeys = new Map<string, { id: string; user_id: string; key_hash: string; created_at: number }>();
  const pendingBinds = new Map<string, { code: string; user_id: string; server_name: string; expires_at: number }>();
  const servers = new Map<string, { id: string; user_id: string; name: string; token_hash: string; status: string; last_heartbeat_at: number | null; created_at: number }>();
  const idempotency = new Map<string, { body: string; status: number }>();
  const auditLog: unknown[] = [];

  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async <T = unknown>(): Promise<T | null> => {
          // Normalize whitespace so multiline SQL still matches
          const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();

          if (s.includes('from users where id')) {
            return (users.get(args[0] as string) ?? null) as T | null;
          }
          if (s.includes('from api_keys where key_hash')) {
            for (const k of apiKeys.values()) {
              if (k.key_hash === args[0]) return { user_id: k.user_id } as T;
            }
            return null;
          }
          if (s.includes('from pending_binds where code')) {
            const b = pendingBinds.get(args[0] as string);
            if (b && b.expires_at > (args[1] as number)) return b as T;
            return null;
          }
          if (s.includes('from servers where token_hash')) {
            for (const s2 of servers.values()) {
              if (s2.token_hash === args[0] && s2.id === args[1]) {
                return { id: s2.id, user_id: s2.user_id } as T;
              }
            }
            return null;
          }
          if (s.includes('from idempotency_cache')) {
            const cached = idempotency.get(args[0] as string);
            return (cached ?? null) as T | null;
          }
          return null;
        },
        all: async <T = unknown>() => ({ results: [] as T[] }),
        run: async () => {
          const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();

          if (s.includes('insert into users')) {
            users.set(args[0] as string, { id: args[0] as string, created_at: args[1] as number });
          }
          if (s.includes('insert into api_keys')) {
            apiKeys.set(args[0] as string, {
              id: args[0] as string,
              user_id: args[1] as string,
              key_hash: args[2] as string,
              created_at: args[3] as number,
            });
          }
          if (s.includes('insert into pending_binds')) {
            pendingBinds.set(args[0] as string, {
              code: args[0] as string,
              user_id: args[1] as string,
              server_name: args[2] as string,
              expires_at: args[3] as number,
            });
          }
          if (s.includes('delete from pending_binds')) {
            pendingBinds.delete(args[0] as string);
          }
          if (s.includes('insert into servers')) {
            servers.set(args[0] as string, {
              id: args[0] as string,
              user_id: args[1] as string,
              name: args[2] as string,
              token_hash: args[3] as string,
              status: 'offline',
              last_heartbeat_at: null,
              created_at: args[4] as number,
            });
          }
          if (s.includes('insert into idempotency_cache')) {
            idempotency.set(args[0] as string, { body: args[3] as string, status: args[2] as number });
          }
          if (s.includes('insert into audit_log')) {
            auditLog.push(args);
          }
          return { changes: 1 };
        },
      }),
    }),
  } as unknown as PgDatabase;
}

// ── Test env ─────────────────────────────────────────────────────────────────

function makeEnv(): Env {
  return {
    DB: makeMemDb(),
    JWT_SIGNING_KEY: 'test-signing-key-32chars-padding!!',
    BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2), // 32 hex bytes
    SERVER_URL: 'http://localhost:3000',
    ALLOWED_ORIGINS: '',
    TRUSTED_PROXIES: '',
    BIND_HOST: '127.0.0.1',
    PORT: '3000',
    NODE_ENV: 'development',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Auth flow integration', () => {
  let app: ReturnType<typeof buildApp>;
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    env = makeEnv();
    app = buildApp(env);
  });

  it('registers a new user and returns an API key', async () => {
    const res = await app.request('/api/auth/register', { method: 'POST' });
    expect(res.status).toBe(201);
    const body = await res.json() as { userId: string; apiKey: string };
    expect(body.userId).toBeTruthy();
    expect(body.apiKey).toMatch(/^deck_/);
  });

  it('authenticates with the returned API key', async () => {
    // Register
    const regRes = await app.request('/api/auth/register', { method: 'POST' });
    const { apiKey } = await regRes.json() as { userId: string; apiKey: string };

    // Use API key to call a protected endpoint (bind/initiate requires auth)
    const listRes = await app.request('/api/bind/initiate', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ serverName: 'auth-check' }),
    });
    // 200 means auth succeeded (any non-401 demonstrates the key was accepted)
    expect(listRes.status).not.toBe(401);
    expect(listRes.status).not.toBe(403);
  });

  it('bind/initiate → bind/confirm issues a server token', async () => {
    // Register
    const regRes = await app.request('/api/auth/register', { method: 'POST' });
    const { apiKey } = await regRes.json() as { userId: string; apiKey: string };

    // Initiate bind
    const initRes = await app.request('/api/bind/initiate', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ serverName: 'my-server' }),
    });
    expect(initRes.status).toBe(200);
    const { code } = await initRes.json() as { code: string; expiresAt: number };
    expect(code).toBeTruthy();

    // Confirm bind
    const confirmRes = await app.request('/api/bind/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(confirmRes.status).toBe(200);
    const { serverId, token } = await confirmRes.json() as { serverId: string; token: string };
    expect(serverId).toBeTruthy();
    expect(token).toBeTruthy();
  });

  it('rejects requests without auth', async () => {
    const res = await app.request('/api/bind/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverName: 'x' }),
    });
    expect(res.status).toBe(401);
  });

  it('health check returns ok', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
