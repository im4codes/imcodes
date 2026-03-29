import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';
import { sha256Hex, signJwt } from '../src/security/crypto.js';
import { COOKIE_CSRF, COOKIE_SESSION, HEADER_CSRF } from '../../shared/cookie-names.js';

type ServerRow = { id: string; user_id: string; team_id: string | null; token_hash: string };
type ApiKeyRow = { id: string; user_id: string; key_hash: string; revoked_at: number | null; grace_expires_at: number | null };

function makeMemDb() {
  const servers = new Map<string, ServerRow>();
  const apiKeys = new Map<string, ApiKeyRow>();

  const db: Database & {
    seedServer: (row: ServerRow) => void;
    seedApiKey: (row: ApiKeyRow) => void;
    setServerOwner: (serverId: string, userId: string) => void;
  } = {
    seedServer: (row) => servers.set(row.id, row),
    seedApiKey: (row) => apiKeys.set(row.id, row),
    setServerOwner: (serverId, userId) => {
      const row = servers.get(serverId);
      if (row) row.user_id = userId;
    },
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []) => {
      const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
      if (s.includes('select team_id, user_id from servers where id = $1')) {
        const row = servers.get(params[0] as string);
        return (row ? { team_id: row.team_id, user_id: row.user_id } : null) as T | null;
      }
      if (s.includes('select id, user_id from api_keys')) {
        const keyHash = params[0] as string;
        const now = params[1] as number;
        for (const row of apiKeys.values()) {
          if (row.key_hash === keyHash && row.revoked_at === null && (row.grace_expires_at === null || row.grace_expires_at > now)) {
            return ({ id: row.id, user_id: row.user_id } as T);
          }
        }
        return null;
      }
      if (s.includes('select role from team_members')) {
        return null;
      }
      return null;
    },
    query: async <T = unknown>() => [] as T[],
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    close: async () => {},
  } as any;

  return db;
}

function makeEnv(db: Database): Env {
  return {
    DB: db,
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

describe('local web preview routes', () => {
  const serverId = 'srv-preview-routes';
  const userId = 'user-preview';
  let db: ReturnType<typeof makeMemDb>;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    db = makeMemDb();
    db.seedServer({ id: serverId, user_id: userId, team_id: null, token_hash: sha256Hex('daemon-token') });
    db.seedApiKey({ id: 'key1', user_id: userId, key_hash: sha256Hex('deck_test_key'), revoked_at: null, grace_expires_at: null });
    app = buildApp(makeEnv(db));
  });

  function sessionCookie(csrf = 'csrf-token') {
    const token = signJwt({ sub: userId, role: 'member' }, 'test-signing-key-32chars-padding!!', 3600);
    return `${COOKIE_SESSION}=${token}; ${COOKIE_CSRF}=${csrf}`;
  }

  it('requires csrf for create and close under session-cookie auth', async () => {
    const createNoCsrf = await app.request(`/api/server/${serverId}/local-web-preview`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie(),
      },
      body: JSON.stringify({ port: 3000, path: '/' }),
    });
    expect(createNoCsrf.status).toBe(403);

    const createOk = await app.request(`/api/server/${serverId}/local-web-preview`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie(),
        [HEADER_CSRF]: 'csrf-token',
      },
      body: JSON.stringify({ port: 3000, path: '/' }),
    });
    expect(createOk.status).toBe(200);
    const created = await createOk.json() as { preview: { id: string } };

    const closeNoCsrf = await app.request(`/api/server/${serverId}/local-web-preview/${created.preview.id}`, {
      method: 'DELETE',
      headers: {
        Cookie: sessionCookie(),
      },
    });
    expect(closeNoCsrf.status).toBe(403);

    const closeOk = await app.request(`/api/server/${serverId}/local-web-preview/${created.preview.id}`, {
      method: 'DELETE',
      headers: {
        Cookie: sessionCookie(),
        [HEADER_CSRF]: 'csrf-token',
      },
    });
    expect(closeOk.status).toBe(200);
  });

  it('revalidates access on every proxied request after preview creation', async () => {
    const createRes = await app.request(`/api/server/${serverId}/local-web-preview`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer deck_test_key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ port: 3000, path: '/' }),
    });
    expect(createRes.status).toBe(200);
    const created = await createRes.json() as { preview: { id: string } };

    db.setServerOwner(serverId, 'other-user');

    const proxyRes = await app.request(`/api/server/${serverId}/local-web/${created.preview.id}/`, {
      method: 'GET',
      headers: {
        Authorization: 'Bearer deck_test_key',
      },
    });
    expect(proxyRes.status).toBe(403);
  });

  it('rate limits preview proxy requests per user/server', async () => {
    const createRes = await app.request(`/api/server/${serverId}/local-web-preview`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer deck_test_key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ port: 3000, path: '/' }),
    });
    const created = await createRes.json() as { preview: { id: string } };

    for (let i = 0; i < 120; i++) {
      const res = await app.request(`/api/server/${serverId}/local-web/${created.preview.id}/`, {
        method: 'GET',
        headers: { Authorization: 'Bearer deck_test_key' },
      });
      expect([503, 502]).toContain(res.status);
    }

    const limited = await app.request(`/api/server/${serverId}/local-web/${created.preview.id}/`, {
      method: 'GET',
      headers: { Authorization: 'Bearer deck_test_key' },
    });
    expect(limited.status).toBe(429);
  });
});
