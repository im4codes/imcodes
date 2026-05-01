import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sha256Hex } from '../src/security/crypto.js';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';
import { serverRoutes } from '../src/routes/server.js';
import { computeProjectionContentHash } from '../src/memory/citation.js';

function makeEnv(db: Database): Env {
  return {
    DB: db,
    JWT_SIGNING_KEY: 'test-signing-key-32chars-padding!!',
    BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
    SERVER_URL: 'https://app.im.codes',
    ALLOWED_ORIGINS: '',
    TRUSTED_PROXIES: '',
    BIND_HOST: '127.0.0.1',
    PORT: '3000',
    NODE_ENV: 'test',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
    DATABASE_URL: '',
  } as Env;
}

function normalize(sql: string): string {
  return sql.toLowerCase().replace(/\s+/g, ' ').trim();
}

function makeMockDb() {
  const executeLog: Array<{ sql: string; params: unknown[] }> = [];
  const tokenHash = sha256Hex('daemon-token');
  const db: Database = {
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []) => {
      const s = normalize(sql);
      if (s.includes('select id, user_id from servers where token_hash = $1 and id = $2')) {
        return params[0] === tokenHash && params[1] === 'srv-1'
          ? ({ id: 'srv-1', user_id: 'owner-1' } as T)
          : null;
      }
      if (s.includes('select id, team_id, user_id from servers where token_hash = $1 and id = $2')) {
        return params[0] === tokenHash && params[1] === 'srv-1'
          ? ({ id: 'srv-1', team_id: 'ent-1', user_id: 'owner-1' } as T)
          : null;
      }
      return null;
    },
    query: async <T = unknown>(sql: string, params: unknown[] = []) => {
      const s = normalize(sql);
      if (s.includes('from owner_private_memories')) {
        return params[0] === 'owner-1'
          ? ([{ id: 'mem-1', kind: 'preference', origin: 'user_note', text: 'Use pnpm', updated_at: 123 }] as T[])
          : [] as T[];
      }
      return [] as T[];
    },
    execute: async (sql: string, params: unknown[] = []) => {
      executeLog.push({ sql, params });
      return { changes: 1 };
    },
    exec: async () => {},
    close: async () => {},
  } as Database;
  return { db, executeLog };
}

describe('user_private owner-only server replication', () => {
  beforeEach(() => {
    process.env.IMCODES_MEM_FEATURE_USER_PRIVATE_SYNC = 'true';
  });

  afterEach(() => {
    delete process.env.IMCODES_MEM_FEATURE_USER_PRIVATE_SYNC;
  });

  it('stores user_private records in the dedicated owner table, not shared projections', async () => {
    const { db, executeLog } = makeMockDb();
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/server', serverRoutes);

    const res = await app.request('/api/server/srv-1/shared-context/owner-private', {
      method: 'POST',
      headers: { authorization: 'Bearer daemon-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        namespace: { scope: 'user_private', userId: 'owner-1' },
        records: [{ kind: 'preference', origin: 'user_note', fingerprint: 'fp-1', text: 'Use pnpm', content: { source: 'test' } }],
      }),
    }, makeEnv(db));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, memoryCount: 1 });
    expect(executeLog.some((entry) => normalize(entry.sql).includes('insert into owner_private_memories'))).toBe(true);
    expect(executeLog.some((entry) => normalize(entry.sql).includes('shared_context_projections'))).toBe(false);
  });

  it('rejects missing or reserved origins on owner-private writes', async () => {
    const { db, executeLog } = makeMockDb();
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/server', serverRoutes);

    for (const record of [
      { kind: 'note', fingerprint: 'fp-missing', text: 'missing origin' },
      { kind: 'note', origin: 'quick_search_cache', fingerprint: 'fp-reserved', text: 'reserved origin' },
    ]) {
      const res = await app.request('/api/server/srv-1/shared-context/owner-private', {
        method: 'POST',
        headers: { authorization: 'Bearer daemon-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          namespace: { scope: 'user_private', userId: 'owner-1' },
          records: [record],
        }),
      }, makeEnv(db));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_body' });
    }
    expect(executeLog).toEqual([]);
  });

  it('bounds owner-private kind, text, content, and batch inputs before DB writes', async () => {
    const { db, executeLog } = makeMockDb();
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/server', serverRoutes);

    for (const records of [
      [{ kind: 'unknown', origin: 'user_note', fingerprint: 'fp-kind', text: 'bad kind' }],
      [{ kind: 'note', origin: 'user_note', fingerprint: 'fp-text', text: 'x'.repeat(32 * 1024 + 1) }],
      [{ kind: 'note', origin: 'user_note', fingerprint: 'fp-content', text: 'content', content: { blob: 'x'.repeat(128 * 1024 + 1) } }],
      Array.from({ length: 101 }, (_, index) => ({ kind: 'note', origin: 'user_note', fingerprint: `fp-${index}`, text: `note ${index}` })),
    ]) {
      const res = await app.request('/api/server/srv-1/shared-context/owner-private', {
        method: 'POST',
        headers: { authorization: 'Bearer daemon-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          namespace: { scope: 'user_private', userId: 'owner-1' },
          records,
        }),
      }, makeEnv(db));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_body' });
    }
    expect(executeLog).toEqual([]);
  });

  it('rejects namespace user mismatch with the same not-found lookup envelope', async () => {
    const { db, executeLog } = makeMockDb();
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/server', serverRoutes);

    const res = await app.request('/api/server/srv-1/shared-context/owner-private', {
      method: 'POST',
      headers: { authorization: 'Bearer daemon-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        namespace: { scope: 'user_private', userId: 'other-user' },
        records: [{ kind: 'note', origin: 'user_note', fingerprint: 'fp-2', text: 'private' }],
      }),
    }, makeEnv(db));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, result: null, citation: null, error: 'not_found' });
    expect(executeLog).toEqual([]);
  });

  it('searches owner-private memory only for the daemon-authenticated owner', async () => {
    const { db } = makeMockDb();
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/server', serverRoutes);

    const res = await app.request('/api/server/srv-1/shared-context/owner-private/search', {
      method: 'POST',
      headers: { authorization: 'Bearer daemon-token', 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'pnpm', scope: 'owner_private' }),
    }, makeEnv(db));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [{ id: 'mem-1', scope: 'user_private', kind: 'preference', origin: 'user_note', preview: 'Use pnpm', updatedAt: 123 }],
      nextCursor: null,
    });
  });

  it('persists canonical content_hash on processed projection replication', async () => {
    const { db, executeLog } = makeMockDb();
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/server', serverRoutes);
    const projection = {
      id: 'projection-1',
      namespace: { scope: 'personal', projectId: 'github.com/acme/repo', userId: 'owner-1' },
      class: 'recent_summary',
      origin: 'chat_compacted',
      sourceEventIds: ['evt-1'],
      summary: 'Stable summary',
      content: { b: 2, a: 1 },
      createdAt: 100,
      updatedAt: 200,
    };

    const res = await app.request('/api/server/srv-1/shared-context/processed', {
      method: 'POST',
      headers: { authorization: 'Bearer daemon-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        namespace: projection.namespace,
        projections: [projection],
      }),
    }, makeEnv(db));

    expect(res.status).toBe(200);
    const insert = executeLog.find((entry) => normalize(entry.sql).includes('insert into shared_context_projections'));
    expect(normalize(insert?.sql ?? '')).toContain('content_hash');
    expect(insert?.params[11]).toBe(computeProjectionContentHash({
      summary: projection.summary,
      content: projection.content,
    }));
  });
});
