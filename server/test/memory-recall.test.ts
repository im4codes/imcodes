/**
 * I.5/J.13: Server recall endpoint returns vector/pg_trgm ranked results.
 *
 * Tests the POST /:id/shared-context/memory/recall route in shared-context.ts.
 * Mocks the DB layer (no real PostgreSQL needed) — follows the same pattern
 * as shared-context-processed-remote.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';

// ── Hoisted mock state ─────────────────────────────────────────────────────

const mockResolveServerRole = vi.fn<() => Promise<string>>();
const generateEmbeddingMock = vi.hoisted(() => vi.fn());
const embeddingToSqlMock = vi.hoisted(() => vi.fn());

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'user-1');
    c.set('role', 'member');
    await next();
  },
  resolveServerRole: (...args: unknown[]) => mockResolveServerRole(...args as []),
}));

vi.mock('../src/security/audit.js', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

// Mock embedding module — return null to trigger pg_trgm fallback path
vi.mock('../src/util/embedding.js', () => ({
  generateEmbedding: generateEmbeddingMock,
  embeddingToSql: embeddingToSqlMock,
  isEmbeddingAvailable: vi.fn().mockResolvedValue(false),
}));

vi.mock('../src/security/crypto.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/security/crypto.js')>();
  return { ...real, randomHex: () => 'mock-id' };
});

// ── Helpers ────────────────────────────────────────────────────────────────

interface MockRow {
  id: string;
  project_id: string;
  projection_class: string;
  summary: string;
  updated_at: number;
  score: number;
  hit_count?: number;
  last_used_at?: number;
  status?: 'active' | 'archived';
  enterprise_id?: string;
}

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

function makeMockDb(opts: {
  personalRows?: MockRow[];
  enterpriseRows?: (MockRow & { enterprise_id: string })[];
  runtimeConfig?: Record<string, unknown> | null;
} = {}) {
  const executeLog: Array<{ sql: string; params: unknown[] }> = [];

  const db: Database = {
    queryOne: async <T = unknown>(sql: string) => {
      const normalized = sql.toLowerCase().replace(/\s+/g, ' ').trim();
      if (normalized.includes('select shared_context_runtime_config from servers where id =')) {
        return { shared_context_runtime_config: opts.runtimeConfig ?? null } as T;
      }
      return null;
    },
    query: async <T = unknown>(sql: string, _params: unknown[] = []) => {
      const normalized = sql.toLowerCase().replace(/\s+/g, ' ').trim();
      // Personal memory query
      if (normalized.includes("where scope = 'personal' and user_id =") || normalized.includes("where p.scope = 'personal' and p.user_id =")) {
        return (opts.personalRows ?? []) as T[];
      }
      // Enterprise memory query (joined with team_members)
      if (normalized.includes('join team_members tm on')) {
        return (opts.enterpriseRows ?? []) as T[];
      }
      return [] as T[];
    },
    execute: async (sql: string, params: unknown[] = []) => {
      executeLog.push({ sql, params });
      return { changes: 0 };
    },
    exec: async () => {},
    close: async () => {},
  } as unknown as Database;

  return { db, executeLog };
}

async function buildTestApp(db: Database) {
  const { sharedContextRoutes } = await import('../src/routes/shared-context.js');
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    if (!c.env) (c as unknown as { env: Env }).env = {} as Env;
    Object.assign(c.env, makeEnv(db));
    await next();
  });
  app.route('/api/shared-context', sharedContextRoutes);
  return app;
}

async function postRecall(
  app: Hono<{ Bindings: Env }>,
  body: { query: string; projectId?: string; limit?: number },
) {
  return app.request('/api/shared-context/srv-1/shared-context/memory/recall', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('memory recall endpoint — I.5', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveServerRole.mockResolvedValue('owner');
    generateEmbeddingMock.mockResolvedValue(null);
    embeddingToSqlMock.mockImplementation((value: unknown) => String(value));
  });

  it('returns 403 when user has no server role', async () => {
    mockResolveServerRole.mockResolvedValue('none');
    const { db } = makeMockDb();
    const app = await buildTestApp(db);

    const res = await postRecall(app, { query: 'websocket bug' });
    expect(res.status).toBe(403);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('forbidden');
  });

  it('returns 400 when query is missing', async () => {
    const { db } = makeMockDb();
    const app = await buildTestApp(db);

    const res = await postRecall(app, { query: '' });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('query_required');
  });

  it('returns 400 for invalid JSON body', async () => {
    const { db } = makeMockDb();
    const app = await buildTestApp(db);

    const res = await app.request('/api/shared-context/srv-1/shared-context/memory/recall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{',
    });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('invalid_json');
  });

  it('returns empty with skipped:template_prompt when the query is a built-in template', async () => {
    // Query-side filter: OpenSpec workflow prompts never hit the DB — the
    // endpoint short-circuits with `skipped: 'template_prompt'`.
    const { db, executeLog } = makeMockDb({
      personalRows: [
        { id: 'p1', project_id: 'proj', projection_class: 'recent_summary', summary: 'Irrelevant', updated_at: 1, score: 0.9 },
      ],
    });
    const app = await buildTestApp(db);

    const res = await postRecall(app, {
      query: 'Drive the implementation of openspec/changes/my-feature aggressively.',
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { results: unknown[]; skipped?: string };
    expect(json.results).toEqual([]);
    expect(json.skipped).toBe('template_prompt');
    // No query-side DB work and no hit_count update for skipped queries
    const hit = executeLog.find((e) => e.sql.toLowerCase().includes('hit_count'));
    expect(hit).toBeUndefined();
  });

  it('short-circuits for localized template queries across supported languages', async () => {
    const { db } = makeMockDb({ personalRows: [] });
    const app = await buildTestApp(db);

    const templates = [
      '强力推进 openspec/changes/foo 的实施。',
      'P2P 讨论已经完成。请直接落实原始请求。',
      'Проведи строгий аудит реализации.',
      '厳格な実装監査を実施してください。',
      '엄격한 구현 감사를 수행하세요.',
    ];
    for (const q of templates) {
      const res = await postRecall(app, { query: q });
      expect(res.status).toBe(200);
      const json = await res.json() as { results: unknown[]; skipped?: string };
      expect(json.skipped).toBe('template_prompt');
      expect(json.results).toEqual([]);
    }
  });

  it('drops template-origin rows from merged results even for a normal query', async () => {
    const now = Date.now();
    const { db, executeLog } = makeMockDb({
      personalRows: [
        { id: 'ok-1', project_id: 'proj-a', projection_class: 'recent_summary', summary: '## Problem → Resolution: fixed retry', updated_at: now, score: 0.9 },
        { id: 'bad-1', project_id: 'proj-a', projection_class: 'recent_summary', summary: 'User orchestrated openspec/changes/feature-x via subagents.', updated_at: now, score: 0.85 },
      ],
      enterpriseRows: [
        { id: 'bad-2', project_id: 'proj-b', projection_class: 'recent_summary', summary: 'Drive the implementation of change Y.', updated_at: now, score: 0.8, enterprise_id: 'ent-1' },
      ],
    });
    const app = await buildTestApp(db);

    const res = await postRecall(app, { query: 'retry behavior', projectId: 'proj-a' });
    expect(res.status).toBe(200);
    const json = await res.json() as { results: Array<{ id: string; summary: string }> };
    const ids = json.results.map((r) => r.id);
    expect(ids).toContain('ok-1');
    expect(ids).not.toContain('bad-1');
    expect(ids).not.toContain('bad-2');
    // Hit-count update should reference only the surviving row
    await new Promise((r) => setTimeout(r, 50));
    const hit = executeLog.find((e) => e.sql.toLowerCase().includes('hit_count = hit_count + 1'));
    expect(hit).toBeDefined();
    expect(hit!.params).toContain('ok-1');
    expect(hit!.params).not.toContain('bad-1');
    expect(hit!.params).not.toContain('bad-2');
  });

  it('merges personal and enterprise results into a single response', async () => {
    const now = Date.now();
    const { db } = makeMockDb({
      personalRows: [
        { id: 'p1', project_id: 'proj-a', projection_class: 'recent_summary', summary: 'Personal memory A', updated_at: now, score: 0.95 },
        { id: 'p2', project_id: 'proj-a', projection_class: 'durable_memory_candidate', summary: 'Personal memory B', updated_at: now, score: 0.85 },
      ],
      enterpriseRows: [
        { id: 'e1', project_id: 'proj-a', projection_class: 'recent_summary', summary: 'Enterprise memory C', updated_at: now, score: 0.9, enterprise_id: 'ent-1' },
      ],
    });
    const app = await buildTestApp(db);

    const res = await postRecall(app, { query: 'memory test', projectId: 'proj-a' });
    expect(res.status).toBe(200);
    const json = await res.json() as { results: Array<{ id: string; source: string }> };
    // All 3 survive floor + cap (top 3, all well above 0.6 extend bar)
    expect(json.results).toHaveLength(3);
    const sources = json.results.map((r) => r.source);
    expect(sources).toContain('personal');
    expect(sources).toContain('enterprise');
  });

  it('deduplicates results by id (personal wins over enterprise for same id)', async () => {
    const now = Date.now();
    const { db } = makeMockDb({
      personalRows: [
        { id: 'shared-1', project_id: 'proj-a', projection_class: 'recent_summary', summary: 'Personal version', updated_at: now, score: 0.85 },
      ],
      enterpriseRows: [
        { id: 'shared-1', project_id: 'proj-a', projection_class: 'recent_summary', summary: 'Enterprise version', updated_at: now, score: 0.9, enterprise_id: 'ent-1' },
      ],
    });
    const app = await buildTestApp(db);

    const res = await postRecall(app, { query: 'test', projectId: 'proj-a' });
    expect(res.status).toBe(200);
    const json = await res.json() as { results: Array<{ id: string; source: string; summary: string }> };
    expect(json.results).toHaveLength(1);
    // Personal is processed first, so it wins dedup
    expect(json.results[0].source).toBe('personal');
    expect(json.results[0].summary).toBe('Personal version');
  });

  it('sorts merged results by score descending', async () => {
    const now = Date.now();
    const { db } = makeMockDb({
      personalRows: [
        { id: 'low', project_id: 'proj-a', projection_class: 'recent_summary', summary: 'Low score', updated_at: now, score: 0.75 },
        { id: 'high', project_id: 'proj-a', projection_class: 'recent_summary', summary: 'High score', updated_at: now, score: 0.98 },
      ],
      enterpriseRows: [
        { id: 'mid', project_id: 'proj-a', projection_class: 'recent_summary', summary: 'Mid score', updated_at: now, score: 0.85, enterprise_id: 'ent-1' },
      ],
    });
    const app = await buildTestApp(db);

    const res = await postRecall(app, { query: 'test', projectId: 'proj-a' });
    const json = await res.json() as { results: Array<{ id: string; score: number }> };
    expect(json.results).toHaveLength(3);
    expect(json.results[0].id).toBe('high');
    expect(json.results[1].id).toBe('mid');
    expect(json.results[2].id).toBe('low');
    // Scores descending
    expect(json.results[0].score).toBeGreaterThanOrEqual(json.results[1].score);
    expect(json.results[1].score).toBeGreaterThanOrEqual(json.results[2].score);
  });

  it('shrinks the default cap when client requests fewer than 3', async () => {
    const now = Date.now();
    const { db } = makeMockDb({
      personalRows: [
        { id: 'p1', project_id: 'proj', projection_class: 'recent_summary', summary: 'A', updated_at: now, score: 0.95 },
        { id: 'p2', project_id: 'proj', projection_class: 'recent_summary', summary: 'B', updated_at: now, score: 0.9 },
        { id: 'p3', project_id: 'proj', projection_class: 'recent_summary', summary: 'C', updated_at: now, score: 0.85 },
      ],
    });
    const app = await buildTestApp(db);

    const res = await postRecall(app, { query: 'test', limit: 2, projectId: 'proj' });
    const json = await res.json() as { results: Array<{ id: string }> };
    // Client-supplied limit 2 shrinks defaultCap+extendCap to 2.
    expect(json.results).toHaveLength(2);
    expect(json.results[0].id).toBe('p1');
    expect(json.results[1].id).toBe('p2');
  });

  it('defaults to top 3 when no limit is specified', async () => {
    // Under the recall cap rule, default behavior is 3 unless every top-3
    // item is above the extend bar (0.6 composite).
    const now = Date.now();
    const rows: MockRow[] = [];
    for (let i = 0; i < 10; i++) {
      rows.push({
        id: `p${i}`,
        project_id: 'proj',
        projection_class: 'recent_summary',
        summary: `Memory ${i}`,
        updated_at: now,
        score: 1 - i * 0.05, // 1.0, 0.95, 0.9, 0.85, 0.8, ...
      });
    }
    const { db } = makeMockDb({ personalRows: rows });
    const app = await buildTestApp(db);

    const res = await postRecall(app, { query: 'test', projectId: 'proj' });
    const json = await res.json() as { results: Array<{ id: string }> };
    // All items are well above the extend bar → extend kicks in up to 5.
    expect(json.results).toHaveLength(5);
    expect(json.results.map((r) => r.id)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
  });

  it('extends up to 5 only when every top-3 item is above the extend bar', async () => {
    // Build a set where the top 3 include one at exactly 0.59 composite
    // (below 0.6 extend bar) — extension must NOT kick in.
    const now = Date.now();
    const rows: MockRow[] = [
      { id: 'strong-1', project_id: 'proj', projection_class: 'recent_summary', summary: 'A', updated_at: now, score: 0.98 },
      { id: 'strong-2', project_id: 'proj', projection_class: 'recent_summary', summary: 'B', updated_at: now, score: 0.95 },
      // similarity 0.5 + project-boost 0.2 + recency ~0.225 → ~0.625 (borderline; we pick 0.35 to stay under)
      { id: 'borderline', project_id: 'proj', projection_class: 'recent_summary', summary: 'C', updated_at: now, score: 0.35 },
      { id: 'extra-1', project_id: 'proj', projection_class: 'recent_summary', summary: 'D', updated_at: now, score: 0.9 },
      { id: 'extra-2', project_id: 'proj', projection_class: 'recent_summary', summary: 'E', updated_at: now, score: 0.88 },
    ];
    const { db } = makeMockDb({ personalRows: rows });
    const app = await buildTestApp(db);

    const res = await postRecall(app, { query: 'test', projectId: 'proj' });
    const json = await res.json() as { results: Array<{ id: string; score: number }> };
    // Top 3 by composite: strong-1, strong-2, extra-1 (all >= 0.6) → extend,
    // then extra-2 (>= 0.6) → 4th, then borderline (< 0.6) → stop.
    // So we get 4 results: strong-1, strong-2, extra-1, extra-2.
    const ids = json.results.map((r) => r.id);
    expect(ids).not.toContain('borderline');
    expect(ids).toContain('strong-1');
    expect(ids).toContain('strong-2');
    expect(ids).toContain('extra-1');
  });

  it('drops rows that fail the configured composite floor even for a normal query', async () => {
    // Ancient timestamps + no project match → composite scores collapse
    // below floor regardless of raw similarity.
    const { db } = makeMockDb({
      personalRows: [
        { id: 'old-1', project_id: 'unrelated', projection_class: 'recent_summary', summary: 'Old memory', updated_at: 1000, score: 0.9 },
        { id: 'old-2', project_id: 'unrelated', projection_class: 'recent_summary', summary: 'Another old memory', updated_at: 1000, score: 0.85 },
      ],
    });
    const app = await buildTestApp(db);

    // No matching projectId → projectBoost = 0.1, old updated_at → recency ≈ 0
    const res = await postRecall(app, { query: 'test' });
    const json = await res.json() as { results: unknown[] };
    expect(json.results).toEqual([]);
  });

  it('uses the saved memory recall threshold from server runtime config', async () => {
    const now = Date.now();
    const { db } = makeMockDb({
      runtimeConfig: {
        primaryContextBackend: 'claude-code-sdk',
        primaryContextModel: 'sonnet',
        memoryRecallMinScore: 0.44,
      },
      personalRows: [
        {
          id: 'p-threshold',
          project_id: 'proj-1',
          projection_class: 'recent_summary',
          summary: 'Mid-threshold multilingual semantic match',
          updated_at: now,
          score: 0.4446,
          hit_count: 0,
          last_used_at: now,
        },
      ],
    });
    const app = await buildTestApp(db);

    const res = await postRecall(app, { query: '相关历史 recall threshold test' });
    expect(res.status).toBe(200);
    const json = await res.json() as { results: Array<{ id: string }> };
    expect(json.results.map((row) => row.id)).toEqual(['p-threshold']);
  });

  it('fires hit_count UPDATE for recalled projection ids', async () => {
    const now = Date.now();
    const { db, executeLog } = makeMockDb({
      personalRows: [
        { id: 'hit-a', project_id: 'proj', projection_class: 'recent_summary', summary: 'A', updated_at: now, score: 0.9 },
        { id: 'hit-b', project_id: 'proj', projection_class: 'recent_summary', summary: 'B', updated_at: now, score: 0.85 },
      ],
    });
    const app = await buildTestApp(db);

    const res = await postRecall(app, { query: 'test', projectId: 'proj' });
    expect(res.status).toBe(200);

    // The hit_count UPDATE is fire-and-forget (catch-ignored), but it should
    // still be called synchronously before the response is sent.
    // Give the microtask a chance to settle.
    await new Promise((r) => setTimeout(r, 50));

    const hitUpdate = executeLog.find((e) =>
      e.sql.toLowerCase().includes('hit_count = hit_count + 1'),
    );
    expect(hitUpdate).toBeDefined();
    // Should include both recalled ids
    expect(hitUpdate!.params).toContain('hit-a');
    expect(hitUpdate!.params).toContain('hit-b');
  });

  it('does not fire hit_count UPDATE when no results are returned', async () => {
    const { db, executeLog } = makeMockDb({ personalRows: [], enterpriseRows: [] });
    const app = await buildTestApp(db);

    const res = await postRecall(app, { query: 'test' });
    expect(res.status).toBe(200);
    const json = await res.json() as { results: unknown[] };
    expect(json.results).toHaveLength(0);

    await new Promise((r) => setTimeout(r, 50));

    const hitUpdate = executeLog.find((e) =>
      e.sql.toLowerCase().includes('hit_count'),
    );
    expect(hitUpdate).toBeUndefined();
  });

  it('returns correct shape for each result item', async () => {
    const now = Date.now();
    const { db } = makeMockDb({
      personalRows: [
        { id: 'shape-1', project_id: 'my-proj', projection_class: 'durable_memory_candidate', summary: 'A durable memory', updated_at: now, score: 0.9 },
      ],
    });
    const app = await buildTestApp(db);

    const res = await postRecall(app, { query: 'test', projectId: 'my-proj' });
    const json = await res.json() as { results: Array<Record<string, unknown>> };
    expect(json.results).toHaveLength(1);
    const item = json.results[0];
    expect(item).toHaveProperty('id', 'shape-1');
    expect(item).toHaveProperty('projectId', 'my-proj');
    expect(item).toHaveProperty('class', 'durable_memory_candidate');
    expect(item).toHaveProperty('summary', 'A durable memory');
    expect(item).toHaveProperty('updatedAt', now);
    expect(typeof item.score).toBe('number');
    expect(item).toHaveProperty('source', 'personal');
  });

  it('returns empty results when both queries return nothing', async () => {
    const { db } = makeMockDb();
    const app = await buildTestApp(db);

    const res = await postRecall(app, { query: 'nonexistent topic' });
    expect(res.status).toBe(200);
    const json = await res.json() as { results: unknown[] };
    expect(json.results).toHaveLength(0);
  });

  it('reranks by composite relevance so same-project high-hit memories can beat slightly higher raw similarity', async () => {
    const now = Date.now();
    const { db } = makeMockDb({
      personalRows: [
        {
          id: 'same-project',
          project_id: 'proj-a',
          projection_class: 'recent_summary',
          summary: 'Same project memory',
          updated_at: now - 20 * 24 * 60 * 60 * 1000,
          last_used_at: now - 1 * 24 * 60 * 60 * 1000,
          hit_count: 12,
          score: 0.78,
        },
        {
          id: 'other-project',
          project_id: 'proj-b',
          projection_class: 'recent_summary',
          summary: 'Cross project memory',
          updated_at: now - 1 * 24 * 60 * 60 * 1000,
          last_used_at: now - 1 * 24 * 60 * 60 * 1000,
          hit_count: 0,
          score: 0.82,
        },
      ],
    });
    const app = await buildTestApp(db);

    const res = await postRecall(app, { query: 'test', projectId: 'proj-a' });
    expect(res.status).toBe(200);
    const json = await res.json() as { results: Array<{ id: string }> };
    expect(json.results[0].id).toBe('same-project');
  });

  it('uses vector search for English query returning Chinese memory', async () => {
    generateEmbeddingMock.mockResolvedValueOnce(new Float32Array([0.1, 0.2, 0.3]));
    embeddingToSqlMock.mockReturnValue('[0.1,0.2,0.3]');

    const { db } = makeMockDb({
      personalRows: [
        {
          id: 'zh-result',
          project_id: 'proj-a',
          projection_class: 'recent_summary',
          summary: '修复文件浏览器下载文件名乱码问题',
          updated_at: Date.now(),
          score: 0.91,
        },
      ],
    });
    const app = await buildTestApp(db);

    const res = await postRecall(app, { query: 'fix garbled download filename', projectId: 'proj-a' });
    expect(res.status).toBe(200);
    const json = await res.json() as { vectorSearch: boolean; results: Array<{ id: string; summary: string }> };
    expect(json.vectorSearch).toBe(true);
    expect(json.results[0].id).toBe('zh-result');
    expect(json.results[0].summary).toContain('修复文件浏览器下载文件名乱码问题');
  });

  it('uses vector search for Chinese query returning English memory', async () => {
    generateEmbeddingMock.mockResolvedValueOnce(new Float32Array([0.3, 0.2, 0.1]));
    embeddingToSqlMock.mockReturnValue('[0.3,0.2,0.1]');

    const { db } = makeMockDb({
      personalRows: [
        {
          id: 'en-result',
          project_id: 'proj-a',
          projection_class: 'recent_summary',
          summary: 'Resolved WebSocket reconnect race during session restore',
          updated_at: Date.now(),
          score: 0.89,
        },
      ],
    });
    const app = await buildTestApp(db);

    const res = await postRecall(app, { query: '修复会话恢复时的 websocket 重连竞争', projectId: 'proj-a' });
    expect(res.status).toBe(200);
    const json = await res.json() as { vectorSearch: boolean; results: Array<{ id: string; summary: string }> };
    expect(json.vectorSearch).toBe(true);
    expect(json.results[0].id).toBe('en-result');
    expect(json.results[0].summary).toContain('Resolved WebSocket reconnect race');
  });
});
