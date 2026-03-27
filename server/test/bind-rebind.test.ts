/**
 * Integration tests: bind/direct and bind/rebind flows
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildApp } from '../src/index.js';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';

vi.mock('../src/security/crypto.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/security/crypto.js')>();
  let callCount = 0;
  return {
    ...real,
    randomHex: (n: number) => {
      // Return distinct values per call so serverId ≠ token
      callCount++;
      return (callCount % 2 === 0 ? 'a' : 'b').repeat(n * 2);
    },
  };
});

// ── In-memory mock DB ─────────────────────────────────────────────────────────

function makeMemDb(): Database {
  const users = new Map<string, { id: string; created_at: number }>();
  const apiKeys = new Map<string, { id: string; user_id: string; key_hash: string; created_at: number }>();
  const servers = new Map<string, { id: string; user_id: string; name: string; token_hash: string; status: string; last_heartbeat_at: number | null; created_at: number }>();
  const idempotency = new Map<string, { body: string; status: number }>();
  const auditLog: unknown[] = [];

  function normalize(sql: string): string {
    return sql.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  return {
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> => {
      const s = normalize(sql);

      if (s.includes('from users where id')) {
        return (users.get(params[0] as string) ?? null) as T | null;
      }
      if (s.includes('from api_keys where key_hash')) {
        for (const k of apiKeys.values()) {
          if (k.key_hash === params[0]) return { id: k.id, user_id: k.user_id } as T;
        }
        return null;
      }
      if (s.includes('from servers where id')) {
        return (servers.get(params[0] as string) ?? null) as T | null;
      }
      if (s.includes('from servers where token_hash')) {
        for (const sv of servers.values()) {
          if (sv.token_hash === params[0] && sv.id === params[1]) {
            return { id: sv.id, user_id: sv.user_id } as T;
          }
        }
        return null;
      }
      if (s.includes('from idempotency_cache')) {
        return (idempotency.get(params[0] as string) ?? null) as T | null;
      }
      return null;
    },
    query: async <T = unknown>(): Promise<T[]> => {
      return [] as T[];
    },
    execute: async (sql: string, params: unknown[] = []): Promise<{ changes: number }> => {
      const s = normalize(sql);

      if (s.includes('insert into users')) {
        users.set(params[0] as string, { id: params[0] as string, created_at: params[1] as number });
      }
      if (s.includes('insert into api_keys')) {
        apiKeys.set(params[0] as string, {
          id: params[0] as string,
          user_id: params[1] as string,
          key_hash: params[2] as string,
          created_at: params[3] as number,
        });
      }
      if (s.includes('insert into servers')) {
        servers.set(params[0] as string, {
          id: params[0] as string,
          user_id: params[1] as string,
          name: params[2] as string,
          token_hash: params[3] as string,
          status: 'offline',
          last_heartbeat_at: null,
          created_at: params[5] as number,
        });
        return { changes: 1 };
      }
      if (s.includes('update servers set token_hash')) {
        // params: tokenHash, name, bound_with_key_id, id, userId
        const [tokenHash, name, , id, userId] = params as string[];
        const sv = servers.get(id);
        if (sv && sv.user_id === userId) {
          sv.token_hash = tokenHash;
          sv.name = name;
          return { changes: 1 };
        }
        return { changes: 0 };
      }
      if (s.includes('insert into idempotency_cache')) {
        idempotency.set(params[0] as string, { body: params[3] as string, status: params[2] as number });
      }
      if (s.includes('insert into audit_log')) {
        auditLog.push(params);
      }
      return { changes: 1 };
    },
    exec: async () => {},
    close: async () => {},
  } as unknown as Database;
}

function makeEnv(): Env {
  return {
    DB: makeMemDb(),
    JWT_SIGNING_KEY: 'test-signing-key-32chars-padding!!',
    BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
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

// ── Helpers ───────────────────────────────────────────────────────────────────

async function registerAndGetKey(app: ReturnType<typeof buildApp>): Promise<string> {
  const res = await app.request('/api/auth/register', { method: 'POST' });
  const { apiKey } = await res.json() as { apiKey: string };
  return apiKey;
}

async function directBind(app: ReturnType<typeof buildApp>, apiKey: string, serverName = 'my-server') {
  const res = await app.request('/api/bind/direct', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverName }),
  });
  return res;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('bind/direct', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp(makeEnv());
  });

  it('creates a server and returns serverId + token', async () => {
    const apiKey = await registerAndGetKey(app);
    const res = await directBind(app, apiKey);
    expect(res.status).toBe(201);
    const body = await res.json() as { serverId: string; token: string; serverName: string };
    expect(body.serverId).toBeTruthy();
    expect(body.token).toBeTruthy();
    expect(body.serverName).toBe('my-server');
  });

  it('rejects without auth', async () => {
    const res = await app.request('/api/bind/direct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverName: 'x' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects empty serverName', async () => {
    const apiKey = await registerAndGetKey(app);
    const res = await app.request('/api/bind/direct', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverName: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects serverName over 64 chars', async () => {
    const apiKey = await registerAndGetKey(app);
    const res = await directBind(app, apiKey, 'a'.repeat(65));
    expect(res.status).toBe(400);
  });
});

describe('bind/rebind', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp(makeEnv());
  });

  it('rotates the token for an existing server', async () => {
    const apiKey = await registerAndGetKey(app);

    // First bind
    const bindRes = await directBind(app, apiKey);
    const { serverId, token: oldToken } = await bindRes.json() as { serverId: string; token: string };

    // Rebind
    const rebindRes = await app.request('/api/bind/rebind', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId, serverName: 'renamed-server' }),
    });
    expect(rebindRes.status).toBe(200);
    const { token: newToken } = await rebindRes.json() as { token: string };
    expect(newToken).toBeTruthy();
    expect(newToken).not.toBe(oldToken);
  });

  it('returns 404 for unknown serverId', async () => {
    const apiKey = await registerAndGetKey(app);
    const res = await app.request('/api/bind/rebind', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: 'nonexistent', serverName: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 when serverId belongs to a different user', async () => {
    // User A binds a server
    const keyA = await registerAndGetKey(app);
    const bindRes = await directBind(app, keyA);
    const { serverId } = await bindRes.json() as { serverId: string };

    // User B tries to rebind it
    const keyB = await registerAndGetKey(app);
    const res = await app.request('/api/bind/rebind', {
      method: 'POST',
      headers: { Authorization: `Bearer ${keyB}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId, serverName: 'stolen' }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects without auth', async () => {
    const res = await app.request('/api/bind/rebind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: 'x', serverName: 'y' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects missing serverId', async () => {
    const apiKey = await registerAndGetKey(app);
    const res = await app.request('/api/bind/rebind', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverName: 'x' }),
    });
    expect(res.status).toBe(400);
  });
});
