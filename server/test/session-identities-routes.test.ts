import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';
import { WsBridge } from '../src/ws/bridge.js';
import type { Database } from '../src/db/client.js';
import type { Env } from '../src/env.js';
import { signJwt } from '../src/security/crypto.js';

const JWT_KEY = 'test-signing-key-32chars-padding!!';

interface Row {
  user_id: string;
  scope: 'user' | 'project' | 'session';
  scope_key: string;
  content: string;
  content_hash: string;
  revision: number;
  updated_at: number;
  source: 'web' | 'mcp';
}

function makeMemDb(): Database {
  const rows = new Map<string, Row>();
  const key = (userId: string, scope: string, scopeKey: string) => `${userId}\0${scope}\0${scopeKey}`;
  return {
    query: async <T = unknown>(sql: string, params: unknown[] = []) => {
      if (!sql.toLowerCase().includes('from session_identity_profiles')) return [] as T[];
      return [...rows.values()].filter((row) => row.user_id === params[0]) as T[];
    },
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []) => {
      const normalized = sql.toLowerCase().replace(/\s+/g, ' ');
      if (normalized.includes('insert into session_identity_profiles')) {
        const [userId, scope, scopeKey, content, contentHash, source, updatedAt, expected] = params as [
          string, Row['scope'], string, string, string, Row['source'], number, number | null,
        ];
        const rowKey = key(userId, scope, scopeKey);
        const existing = rows.get(rowKey);
        if ((!existing && expected !== null && expected !== 0)
          || (existing && expected !== null && existing.revision !== expected)) return null;
        const next: Row = {
          user_id: userId,
          scope,
          scope_key: scopeKey,
          content,
          content_hash: contentHash,
          source,
          revision: existing ? existing.revision + 1 : 1,
          updated_at: updatedAt,
        };
        rows.set(rowKey, next);
        return next as T;
      }
      if (normalized.includes('from session_identity_profiles')) {
        return (rows.get(key(params[0] as string, params[1] as string, params[2] as string)) ?? null) as T | null;
      }
      return null;
    },
    execute: async (sql: string, params: unknown[] = []) => {
      if (!sql.toLowerCase().includes('delete from session_identity_profiles')) return { changes: 0 };
      const rowKey = key(params[0] as string, params[1] as string, params[2] as string);
      const existing = rows.get(rowKey);
      const expected = params[3] as number | null;
      if (!existing || (expected !== null && expected !== existing.revision)) return { changes: 0 };
      rows.delete(rowKey);
      return { changes: 1 };
    },
    exec: async () => undefined,
    close: async () => undefined,
  } as unknown as Database;
}

function makeEnv(db: Database): Env {
  return {
    DB: db,
    JWT_SIGNING_KEY: JWT_KEY,
    BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
    SERVER_URL: 'http://localhost:3000',
    ALLOWED_ORIGINS: '',
    TRUSTED_PROXIES: '',
    BIND_HOST: '127.0.0.1',
    PORT: '3000',
    NODE_ENV: 'development',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
  } as Env;
}

describe('/api/session-identities', () => {
  let app: ReturnType<typeof buildApp>;
  const bearer = (userId = 'user-1') => `Bearer ${signJwt({ sub: userId, role: 'member' }, JWT_KEY, 3600)}`;

  beforeEach(() => { app = buildApp(makeEnv(makeMemDb())); });
  afterEach(() => { WsBridge.getAll().clear(); });

  it('stores online profiles with strict user isolation and returns one sync snapshot', async () => {
    const put = await app.request('/api/session-identities', {
      method: 'PUT',
      headers: { Authorization: bearer(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'user', scopeKey: '', content: 'Global identity' }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ profile: { scope: 'user', revision: 1, content: 'Global identity' } });

    const own = await app.request('/api/session-identities/all', { headers: { Authorization: bearer() } });
    expect(await own.json()).toMatchObject({ profiles: [{ scope: 'user', content: 'Global identity' }] });
    const other = await app.request('/api/session-identities/all', { headers: { Authorization: bearer('user-2') } });
    expect(await other.json()).toEqual({ profiles: [] });
  });

  it('uses explicit last-write-wins semantics for update and delete', async () => {
    const body = { scope: 'project', scopeKey: 'repo-1', content: 'Project identity' };
    await app.request('/api/session-identities', {
      method: 'PUT', headers: { Authorization: bearer(), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const overwritten = await app.request('/api/session-identities', {
      method: 'PUT', headers: { Authorization: bearer(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, content: 'stale', expectedRevision: 0 }),
    });
    expect(overwritten.status).toBe(200);
    expect(await overwritten.json()).toMatchObject({ profile: { revision: 2, content: 'stale' } });
    const updated = await app.request('/api/session-identities', {
      method: 'PUT', headers: { Authorization: bearer(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, content: 'v2', expectedRevision: 1 }),
    });
    expect(await updated.json()).toMatchObject({ profile: { revision: 3, content: 'v2' } });

    const deleted = await app.request('/api/session-identities?scope=project&scopeKey=repo-1&expectedRevision=1', {
      method: 'DELETE', headers: { Authorization: bearer() },
    });
    expect(await deleted.json()).toEqual({ deleted: true });
  });

  it('rejects unauthenticated, invalid scope keys, and oversized identity content', async () => {
    expect((await app.request('/api/session-identities/all')).status).toBe(401);
    const badKey = await app.request('/api/session-identities', {
      method: 'PUT', headers: { Authorization: bearer(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'session', scopeKey: '', content: 'x' }),
    });
    expect(badKey.status).toBe(400);
    const oversized = await app.request('/api/session-identities', {
      method: 'PUT', headers: { Authorization: bearer(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'user', content: 'x'.repeat(10_001) }),
    });
    expect(oversized.status).toBe(400);
  });
});
