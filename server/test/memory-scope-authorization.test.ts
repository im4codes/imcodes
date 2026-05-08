import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';
import { sameShapeMemoryLookupEnvelope } from '../src/memory/scope-policy.js';
import { computeProjectionContentHash, resetCitationCountRateLimiterForTests } from '../src/memory/citation.js';

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: { req: { header: (name: string) => string | undefined }; set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', c.req.header('x-test-user') ?? 'user-member');
    c.set('role', 'member');
    await next();
  },
  resolveServerRole: vi.fn().mockResolvedValue('owner'),
}));

vi.mock('../src/security/audit.js', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

const randomHexMock = vi.hoisted(() => vi.fn());

vi.mock('../src/security/crypto.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/security/crypto.js')>();
  return { ...real, randomHex: randomHexMock };
});

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
  const queryLog: Array<{ sql: string; params: unknown[] }> = [];
  const projections = new Map<string, {
    id: string;
    scope: 'personal' | 'project_shared' | 'workspace_shared' | 'org_shared';
    enterprise_id: string | null;
    user_id: string | null;
    project_id: string;
    summary: string;
    origin: 'chat_compacted' | 'user_note';
    content_json: Record<string, unknown>;
    content_hash?: string | null;
  }>([
    ['shared-1', {
      id: 'shared-1',
      scope: 'org_shared',
      enterprise_id: 'ent-1',
      user_id: null,
      project_id: 'github.com/acme/repo',
      summary: 'Authorized summary',
      origin: 'chat_compacted',
      content_json: { note: 'raw source must not be returned' },
      content_hash: null,
    }],
  ]);
  const citations = new Map<string, {
    id: string;
    projection_id: string;
    user_id: string;
    citing_message_id: string;
    idempotency_key: string;
    projection_content_hash: string;
    created_at: number;
  }>();
  const citeCounts = new Map<string, number>();
  const db: Database = {
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []) => {
      const s = normalize(sql);
      if (s.includes('from shared_context_projections') && s.includes('content_hash')) {
        if (params[0] === 'missing') return null;
        return (projections.get(params[0] as string) ?? null) as T | null;
      }
      if (s.includes('select role from team_members where team_id = $1 and user_id = $2')) {
        return params[0] === 'ent-1' && params[1] === 'user-member' ? ({ role: 'member' } as T) : null;
      }
      if (s.includes('select id, projection_id, projection_content_hash, created_at from shared_context_citations where idempotency_key = $1 and user_id = $2')) {
        const citation = [...citations.values()].find((entry) => entry.idempotency_key === params[0] && entry.user_id === params[1]);
        return citation ? ({
          id: citation.id,
          projection_id: citation.projection_id,
          projection_content_hash: citation.projection_content_hash,
          created_at: citation.created_at,
        } as T) : null;
      }
      if (s.includes('select id, projection_id, projection_content_hash, created_at from shared_context_citations where id = $1 and user_id = $2')) {
        const citation = citations.get(params[0] as string);
        if (!citation || citation.user_id !== params[1]) return null;
        return {
          id: citation.id,
          projection_id: citation.projection_id,
          projection_content_hash: citation.projection_content_hash,
          created_at: citation.created_at,
        } as T;
      }
      return null;
    },
    query: async <T = unknown>(sql: string, params: unknown[] = []) => {
      queryLog.push({ sql, params });
      const s = normalize(sql);
      if (s.includes('from shared_context_projections p') && s.includes('shared_context_projection_cite_counts')) {
        const userId = params[3];
        if (userId !== 'user-member') return [] as T[];
        return [...projections.values()]
          .filter((projection) => projection.scope !== 'personal' || projection.user_id === userId)
          .filter((projection) => projection.scope === 'personal' || projection.enterprise_id === 'ent-1')
          .map((projection) => ({
            id: projection.id,
            scope: projection.scope,
            project_id: projection.project_id,
            projection_class: 'durable_memory_candidate',
            summary: projection.summary,
            origin: projection.origin,
            updated_at: projection.id === 'shared-1' ? 10 : 1,
            hit_count: 0,
            cite_count: citeCounts.get(projection.id) ?? 0,
          })) as T[];
      }
      if (s.includes('from owner_private_memories')) return [] as T[];
      return [] as T[];
    },
    execute: async (sql: string, params: unknown[] = []) => {
      executeLog.push({ sql, params });
      const s = normalize(sql);
      if (s.includes('insert into shared_context_citations')) {
        const idempotencyKey = params[4] as string;
        if ([...citations.values()].some((entry) => entry.idempotency_key === idempotencyKey)) {
          return { changes: 0 };
        }
        citations.set(params[0] as string, {
          id: params[0] as string,
          projection_id: params[1] as string,
          user_id: params[2] as string,
          citing_message_id: params[3] as string,
          idempotency_key: idempotencyKey,
          projection_content_hash: params[5] as string,
          created_at: params[6] as number,
        });
        return { changes: 1 };
      }
      if (s.includes('insert into shared_context_projection_cite_counts')) {
        const projectionId = params[0] as string;
        citeCounts.set(projectionId, (citeCounts.get(projectionId) ?? 0) + 1);
        return { changes: 1 };
      }
      return { changes: 1 };
    },
    exec: async () => {},
    close: async () => {},
  } as Database;
  return { db, executeLog, queryLog, projections, citations, citeCounts };
}

async function buildApp(db: Database) {
  const { sharedContextRoutes } = await import('../src/routes/shared-context.js');
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/shared-context', sharedContextRoutes);
  return { app, env: makeEnv(db) };
}

describe('memory scope authorization and same-shape citation lookup', () => {
  beforeEach(() => {
    let randomCounter = 0;
    randomHexMock.mockImplementation(() => `citation-id-${++randomCounter}`);
    process.env.IMCODES_MEM_FEATURE_QUICK_SEARCH = 'true';
    process.env.IMCODES_MEM_FEATURE_CITATION = 'true';
    process.env.IMCODES_MEM_FEATURE_CITE_COUNT = 'true';
  });

  afterEach(() => {
    delete process.env.IMCODES_MEM_FEATURE_QUICK_SEARCH;
    delete process.env.IMCODES_MEM_FEATURE_CITATION;
    delete process.env.IMCODES_MEM_FEATURE_CITE_COUNT;
    delete process.env.IMCODES_MEM_FEATURE_CITE_DRIFT_BADGE;
    delete process.env.IMCODES_MEM_CITATION_COUNT_RATE_LIMIT;
    delete process.env.IMCODES_MEM_CITATION_COUNT_RATE_LIMIT_WINDOW_MS;
    resetCitationCountRateLimiterForTests();
    randomHexMock.mockReset();
  });

  it('expands quick search through authorized scopes without raw source leakage', async () => {
    const { db, queryLog } = makeMockDb();
    const { app, env } = await buildApp(db);
    const res = await app.request('/api/shared-context/memory/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'user-member' },
      body: JSON.stringify({ query: 'summary', scope: 'all_authorized', limit: 5 }),
    }, env);

    expect(res.status).toBe(200);
    const json = await res.json() as { results: Array<Record<string, unknown>> };
    expect(json.results).toEqual([
      expect.objectContaining({ id: 'shared-1', scope: 'org_shared', preview: 'Authorized summary', origin: 'chat_compacted' }),
    ]);
    expect(JSON.stringify(json)).not.toContain('raw source');
    expect(JSON.stringify(json)).not.toContain('ent-1');
    const searchSql = queryLog.map((entry) => normalize(entry.sql)).find((entry) => entry.includes('from shared_context_projections p'));
    expect(searchSql).toContain('exists ( select 1 from team_members');
    expect(searchSql).toContain("p.scope <> 'personal'");
    expect(searchSql).not.toContain("p.scope in ('project_shared', 'workspace_shared', 'org_shared')");
    expect(searchSql).toContain('order by (p.updated_at + case when $7::boolean then least(coalesce(cc.cite_count, 0), 100) else 0 end) desc');
  });

  it('does not query owner-private memories from generic search when user-private sync is disabled', async () => {
    process.env.IMCODES_MEM_FEATURE_USER_PRIVATE_SYNC = 'false';
    const { db, queryLog } = makeMockDb();
    const { app, env } = await buildApp(db);

    const res = await app.request('/api/shared-context/memory/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'user-member' },
      body: JSON.stringify({ query: 'summary', scope: 'all_authorized', limit: 5 }),
    }, env);

    expect(res.status).toBe(200);
    expect(queryLog.some((entry) => normalize(entry.sql).includes('from owner_private_memories'))).toBe(false);
    expect(queryLog.some((entry) => normalize(entry.sql).includes('from shared_context_projections p'))).toBe(true);
  });

  it('returns identical envelopes for missing, unauthorized, and disabled citation attempts', async () => {
    const { db, executeLog } = makeMockDb();
    const { app, env } = await buildApp(db);

    const missing = await app.request('/api/shared-context/memory/citations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'user-member' },
      body: JSON.stringify({ projectionId: 'missing', citingMessageId: 'msg-1' }),
    }, env);
    const unauthorized = await app.request('/api/shared-context/memory/citations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'user-other' },
      body: JSON.stringify({ projectionId: 'shared-1', citingMessageId: 'msg-1' }),
    }, env);
    process.env.IMCODES_MEM_FEATURE_CITATION = 'false';
    const disabled = await app.request('/api/shared-context/memory/citations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'user-member' },
      body: JSON.stringify({ projectionId: 'shared-1', citingMessageId: 'msg-1' }),
    }, env);

    expect(missing.status).toBe(404);
    expect(unauthorized.status).toBe(404);
    expect(disabled.status).toBe(404);
    expect(await missing.json()).toEqual(sameShapeMemoryLookupEnvelope());
    expect(await unauthorized.json()).toEqual(sameShapeMemoryLookupEnvelope());
    expect(await disabled.json()).toEqual(sameShapeMemoryLookupEnvelope());
    expect(executeLog).toEqual([]);
  });

  it('increments cite count once per authoritative idempotency key', async () => {
    const { db, executeLog, citeCounts } = makeMockDb();
    const { app, env } = await buildApp(db);
    const first = await app.request('/api/shared-context/memory/citations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'user-member' },
      body: JSON.stringify({ projectionId: 'shared-1', citingMessageId: 'msg-2' }),
    }, env);
    const replay = await app.request('/api/shared-context/memory/citations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'user-member' },
      body: JSON.stringify({ projectionId: 'shared-1', citingMessageId: 'msg-2' }),
    }, env);
    const differentMessage = await app.request('/api/shared-context/memory/citations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'user-member' },
      body: JSON.stringify({ projectionId: 'shared-1', citingMessageId: 'msg-3' }),
    }, env);

    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({
      ok: true,
      deduped: false,
      citation: { id: 'citation-id-1', projectionId: 'shared-1', drift: false },
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      ok: true,
      deduped: true,
      citation: { id: 'citation-id-1', projectionId: 'shared-1', drift: false },
    });
    expect(differentMessage.status).toBe(201);
    expect(executeLog.some((entry) => normalize(entry.sql).includes('insert into shared_context_citations'))).toBe(true);
    expect(executeLog.some((entry) => normalize(entry.sql).includes('insert into shared_context_projection_cite_counts'))).toBe(true);
    expect(citeCounts.get('shared-1')).toBe(2);
  });

  it('rate-limits cite-count pumping while still accepting authorized citations', async () => {
    process.env.IMCODES_MEM_CITATION_COUNT_RATE_LIMIT = '1';
    const { db, citeCounts } = makeMockDb();
    const { app, env } = await buildApp(db);

    const first = await app.request('/api/shared-context/memory/citations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'user-member' },
      body: JSON.stringify({ projectionId: 'shared-1', citingMessageId: 'msg-rate-1' }),
    }, env);
    const second = await app.request('/api/shared-context/memory/citations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'user-member' },
      body: JSON.stringify({ projectionId: 'shared-1', citingMessageId: 'msg-rate-2' }),
    }, env);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(citeCounts.get('shared-1')).toBe(1);
  });

  it('dedupes concurrent citation replays before the hot-row count increment', async () => {
    const { db, citeCounts } = makeMockDb();
    const { app, env } = await buildApp(db);

    const responses = await Promise.all(Array.from({ length: 8 }, () => app.request('/api/shared-context/memory/citations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'user-member' },
      body: JSON.stringify({ projectionId: 'shared-1', citingMessageId: 'msg-concurrent' }),
    }, env)));

    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    expect(citeCounts.get('shared-1')).toBe(1);
  });

  it('does not increment cite count when cite-count is disabled', async () => {
    process.env.IMCODES_MEM_FEATURE_CITE_COUNT = 'false';
    const { db, citeCounts } = makeMockDb();
    const { app, env } = await buildApp(db);

    const res = await app.request('/api/shared-context/memory/citations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'user-member' },
      body: JSON.stringify({ projectionId: 'shared-1', citingMessageId: 'msg-no-count' }),
    }, env);

    expect(res.status).toBe(201);
    expect(citeCounts.get('shared-1')).toBeUndefined();
  });

  it('reports drift only for authorized citation lookup when drift badge is enabled', async () => {
    process.env.IMCODES_MEM_FEATURE_CITE_DRIFT_BADGE = 'true';
    const { db, projections } = makeMockDb();
    const { app, env } = await buildApp(db);

    const created = await app.request('/api/shared-context/memory/citations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'user-member' },
      body: JSON.stringify({ projectionId: 'shared-1', citingMessageId: 'msg-drift' }),
    }, env);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ citation: { drift: false } });

    projections.get('shared-1')!.summary = 'Changed authorized summary';
    projections.get('shared-1')!.content_hash = computeProjectionContentHash({
      summary: 'Changed authorized summary',
      content: projections.get('shared-1')!.content_json,
    });
    const lookup = await app.request('/api/shared-context/memory/citations/citation-id-1', {
      method: 'GET',
      headers: { 'x-test-user': 'user-member' },
    }, env);
    const unauthorized = await app.request('/api/shared-context/memory/citations/citation-id-1', {
      method: 'GET',
      headers: { 'x-test-user': 'user-other' },
    }, env);

    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toMatchObject({ citation: { id: 'citation-id-1', projectionId: 'shared-1', drift: true } });
    expect(unauthorized.status).toBe(404);
    expect(await unauthorized.json()).toEqual(sameShapeMemoryLookupEnvelope());
  });

  it('keeps citation lookup envelopes identical for missing, unauthorized, and disabled states', async () => {
    const { db } = makeMockDb();
    const { app, env } = await buildApp(db);

    const created = await app.request('/api/shared-context/memory/citations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'user-member' },
      body: JSON.stringify({ projectionId: 'shared-1', citingMessageId: 'msg-envelope' }),
    }, env);
    expect(created.status).toBe(201);

    const missing = await app.request('/api/shared-context/memory/citations/missing-citation', {
      method: 'GET',
      headers: { 'x-test-user': 'user-member' },
    }, env);
    const unauthorized = await app.request('/api/shared-context/memory/citations/citation-id-1', {
      method: 'GET',
      headers: { 'x-test-user': 'user-other' },
    }, env);
    process.env.IMCODES_MEM_FEATURE_CITATION = 'false';
    const disabled = await app.request('/api/shared-context/memory/citations/citation-id-1', {
      method: 'GET',
      headers: { 'x-test-user': 'user-member' },
    }, env);

    const envelopes = [await missing.json(), await unauthorized.json(), await disabled.json()];
    expect(missing.status).toBe(404);
    expect(unauthorized.status).toBe(404);
    expect(disabled.status).toBe(404);
    expect(envelopes).toEqual([
      sameShapeMemoryLookupEnvelope(),
      sameShapeMemoryLookupEnvelope(),
      sameShapeMemoryLookupEnvelope(),
    ]);
    for (const envelope of envelopes) {
      expect(JSON.stringify(envelope)).not.toMatch(/drift|source|count|projectionId|enterprise|role/i);
    }
  });
});
