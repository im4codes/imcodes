import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';
import {
  USAGE_ANALYTICS_SCHEMA_VERSION,
  createEmptyUsageSummaryResponse,
  type UsageFact,
} from '../../shared/usage-analytics.js';
import { resetMetricsForTests, snapshotCounters } from '../src/util/metrics.js';

const mockIngestFacts = vi.fn();
const mockGetSummary = vi.fn();

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'user-1');
    c.set('role', 'owner');
    await next();
  },
}));

vi.mock('../src/security/crypto.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/security/crypto.js')>();
  return {
    ...real,
    sha256Hex: (value: string) => `hash:${value}`,
  };
});

vi.mock('../src/db/token-usage-queries.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/db/token-usage-queries.js')>();
  return {
    ...real,
    ingestServerTokenUsageFacts: (...args: unknown[]) => mockIngestFacts(...args),
    getTokenUsageSummary: (...args: unknown[]) => mockGetSummary(...args),
  };
});

const baseFact: UsageFact = {
  usageFactId: 'usage-1',
  createdAtMs: Date.UTC(2026, 6, 9, 12),
  sessionName: 'deck_alpha_brain',
  sessionKind: 'main',
  parentSessionName: null,
  metadataCompleteness: 'complete',
  provider: 'openai',
  agentType: 'codex-sdk',
  model: 'gpt-5',
  inputTokens: 10,
  cacheTokens: 2,
  outputTokens: 8,
  totalTokens: 20,
  contextWindow: 200000,
  costUsdMicros: 1234,
  sourceEventId: 'evt-1',
};

function makeDb(): Database {
  return {
    queryOne: async <T>(sql: string, params: unknown[] = []) => {
      if (sql.toLowerCase().includes('from servers')) {
        if (params.length === 1) {
          if (params[0] === 'srv-1' || params[0] === 'empty-srv') {
            return { id: params[0], user_id: 'user-1' } as T;
          }
          if (params[0] === 'foreign-srv') {
            return { id: 'foreign-srv', user_id: 'user-2' } as T;
          }
          return null as T;
        }
        return params[0] === 'srv-1' && params[1] === 'hash:daemon-token'
          ? { id: 'srv-1', user_id: 'user-owner' } as T
          : null as T;
      }
      return null as T;
    },
    query: async () => [],
    execute: async () => ({ changes: 0 }),
    exec: async () => {},
    close: async () => {},
    transaction: async (fn: (tx: Database) => Promise<unknown>) => fn(makeDb()),
  } as unknown as Database;
}

async function buildTestApp() {
  const { tokenUsageRoutes } = await import('../src/routes/token-usage.js');
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c as unknown as { env: Env }).env = {
      DB: makeDb(),
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
    };
    await next();
  });
  app.route('/api', tokenUsageRoutes);
  return app;
}

function jsonReq(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer daemon-token',
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

describe('token usage routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMetricsForTests();
    mockIngestFacts.mockResolvedValue([{ usageFactId: 'usage-1', status: 'accepted' }]);
    mockGetSummary.mockResolvedValue(createEmptyUsageSummaryResponse({ serverId: 'srv-1' }, 123));
  });

  it('authenticates ingest by path server token and ignores body authority', async () => {
    const app = await buildTestApp();
    const res = await app.request('/api/server/srv-1/token-usage/ingest', jsonReq({
      schemaVersion: USAGE_ANALYTICS_SCHEMA_VERSION,
      facts: [baseFact],
    }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      schemaVersion: USAGE_ANALYTICS_SCHEMA_VERSION,
      results: [{ usageFactId: 'usage-1', status: 'accepted' }],
    });
    expect(mockIngestFacts).toHaveBeenCalledWith(expect.anything(), {
      serverId: 'srv-1',
      userId: 'user-owner',
      facts: [baseFact],
    });
  });

  it('rejects path/header mismatch and top-level attribution', async () => {
    const app = await buildTestApp();
    const mismatch = await app.request('/api/server/srv-1/token-usage/ingest', jsonReq({
      schemaVersion: USAGE_ANALYTICS_SCHEMA_VERSION,
      facts: [baseFact],
    }, { 'x-server-id': 'srv-2' }));
    expect(mismatch.status).toBe(400);
    await expect(mismatch.json()).resolves.toEqual({ error: 'path_header_mismatch' });

    const attribution = await app.request('/api/server/srv-1/token-usage/ingest', jsonReq({
      schemaVersion: USAGE_ANALYTICS_SCHEMA_VERSION,
      userId: 'attacker',
      facts: [baseFact],
    }));
    expect(attribution.status).toBe(400);
    await expect(attribution.json()).resolves.toEqual({ error: 'body_attribution_forbidden' });
  });

  it('returns fact-level invalid status without echoing unsafe values', async () => {
    const app = await buildTestApp();
    const res = await app.request('/api/server/srv-1/token-usage/ingest', jsonReq({
      schemaVersion: USAGE_ANALYTICS_SCHEMA_VERSION,
      facts: [{
        ...baseFact,
        usageFactId: 'bad-1',
        userId: 'attacker',
        promptText: 'never echo this prompt',
      }],
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([{
      usageFactId: 'bad-1',
      status: 'invalid',
      reason: expect.stringContaining('userId:attribution_forbidden'),
    }]);
    expect(JSON.stringify(body)).not.toContain('never echo this prompt');
    expect(mockIngestFacts).not.toHaveBeenCalled();
  });

  it('parses summary filters and rejects invalid summary filters', async () => {
    const app = await buildTestApp();
    const res = await app.request('/api/token-usage/summary?serverId=srv-1&sessionKind=sub&provider=openai&model=gpt-5&limit=2&order=desc&from=2026-07-09&to=2026-07-10');

    expect(res.status).toBe(200);
    expect(mockGetSummary).toHaveBeenCalledWith(expect.anything(), 'user-1', {
      from: '2026-07-09',
      to: '2026-07-10',
      serverId: 'srv-1',
      sessionKind: 'sub',
      provider: 'openai',
      model: 'gpt-5',
      limit: 2,
      order: 'desc',
    });

    const invalid = await app.request('/api/token-usage/summary?sessionKind=child');
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: 'invalid_session_kind' });

    const timestampDate = await app.request('/api/token-usage/summary?from=2026-07-09T00:00:00Z');
    expect(timestampDate.status).toBe(400);
    await expect(timestampDate.json()).resolves.toEqual({ error: 'invalid_from' });

    const nonexistentDate = await app.request('/api/token-usage/summary?to=2026-02-31');
    expect(nonexistentDate.status).toBe(400);
    await expect(nonexistentDate.json()).resolves.toEqual({ error: 'invalid_to' });

    mockGetSummary.mockClear();
    const invalidRange = await app.request('/api/token-usage/summary?from=2026-07-10&to=2026-07-09');
    expect(invalidRange.status).toBe(400);
    await expect(invalidRange.json()).resolves.toEqual({ error: 'invalid_date_range' });
    expect(mockGetSummary).not.toHaveBeenCalled();
  });

  it('separates request-level auth and batch failures from per-fact outcomes', async () => {
    const app = await buildTestApp();

    const missingAuth = await app.request('/api/server/srv-1/token-usage/ingest', jsonReq({
      schemaVersion: USAGE_ANALYTICS_SCHEMA_VERSION,
      facts: [baseFact],
    }, { authorization: '' }));
    expect(missingAuth.status).toBe(401);
    await expect(missingAuth.json()).resolves.toEqual({ error: 'unauthorized' });

    const rebound = await app.request('/api/server/srv-1/token-usage/ingest', jsonReq({
      schemaVersion: USAGE_ANALYTICS_SCHEMA_VERSION,
      facts: [baseFact],
    }, { authorization: 'Bearer old-token' }));
    expect(rebound.status).toBe(401);

    const tooLarge = await app.request('/api/server/srv-1/token-usage/ingest', jsonReq({
      schemaVersion: USAGE_ANALYTICS_SCHEMA_VERSION,
      facts: Array.from({ length: 501 }, (_, index) => ({ ...baseFact, usageFactId: `usage-${index}` })),
    }));
    expect(tooLarge.status).toBe(413);
    await expect(tooLarge.json()).resolves.toEqual({ error: 'batch_too_large' });

    mockIngestFacts.mockResolvedValueOnce([
      { usageFactId: 'usage-1', status: 'duplicate' },
      { usageFactId: 'usage-2', status: 'conflict' },
    ]);
    const partial = await app.request('/api/server/srv-1/token-usage/ingest', jsonReq({
      schemaVersion: USAGE_ANALYTICS_SCHEMA_VERSION,
      facts: [
        baseFact,
        { ...baseFact, usageFactId: 'usage-2', sourceEventId: 'evt-2' },
      ],
    }));
    expect(partial.status).toBe(200);
    await expect(partial.json()).resolves.toMatchObject({
      results: [
        { usageFactId: 'usage-1', status: 'duplicate' },
        { usageFactId: 'usage-2', status: 'conflict' },
      ],
    });
  });

  it('rejects invalid ingest envelopes and oversized bodies before fact ingest', async () => {
    const app = await buildTestApp();

    const badBatchId = await app.request('/api/server/srv-1/token-usage/ingest', jsonReq({
      schemaVersion: USAGE_ANALYTICS_SCHEMA_VERSION,
      clientBatchId: 123,
      facts: [baseFact],
    }));
    expect(badBatchId.status).toBe(400);
    await expect(badBatchId.json()).resolves.toEqual({ error: 'invalid_envelope' });

    const huge = await app.request('/api/server/srv-1/token-usage/ingest', jsonReq({
      schemaVersion: USAGE_ANALYTICS_SCHEMA_VERSION,
      facts: [baseFact],
    }, { 'content-length': String(6 * 1024 * 1024) }));
    expect(huge.status).toBe(413);
    await expect(huge.json()).resolves.toEqual({ error: 'batch_too_large' });
    expect(mockIngestFacts).not.toHaveBeenCalled();
  });

  it('returns request-level server_unavailable when valid fact ingest fails', async () => {
    const app = await buildTestApp();
    mockIngestFacts.mockRejectedValueOnce(new Error('do not echo database details'));

    const res = await app.request('/api/server/srv-1/token-usage/ingest', jsonReq({
      schemaVersion: USAGE_ANALYTICS_SCHEMA_VERSION,
      facts: [
        baseFact,
        { ...baseFact, usageFactId: 'bad-route', promptText: 'private prompt' },
      ],
    }));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'server_unavailable' });
    expect(JSON.stringify(body)).not.toContain('database details');
    expect(JSON.stringify(body)).not.toContain('private prompt');
  });

  it('denies summary filters for foreign servers without calling the summary helper', async () => {
    const app = await buildTestApp();

    const res = await app.request('/api/token-usage/summary?serverId=foreign-srv');

    expect(res.status).toBe(404);
    expect(mockGetSummary).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({ error: 'not_found' });
  });

  it('returns the stable empty summary shape for an owned empty server', async () => {
    const app = await buildTestApp();
    mockGetSummary.mockResolvedValueOnce(createEmptyUsageSummaryResponse({ serverId: 'empty-srv' }, 456));

    const res = await app.request('/api/token-usage/summary?serverId=empty-srv');

    expect(res.status).toBe(200);
    expect(mockGetSummary).toHaveBeenCalledWith(expect.anything(), 'user-1', { serverId: 'empty-srv' });
    await expect(res.json()).resolves.toMatchObject({
      accountTotal: { factCount: 0, totalTokens: 0, costUsdMicros: null, costCompleteness: 'unknown' },
      byDate: [],
      byServer: [],
      byProviderModel: [],
      byMainSession: [],
      bySubSession: [],
      byParentSession: [],
      bySessionModelDate: [],
      meta: { filters: { serverId: 'empty-srv' } },
    });
  });

  it('records privacy-safe ingest and summary diagnostics without unsafe labels', async () => {
    const app = await buildTestApp();
    await app.request('/api/server/srv-1/token-usage/ingest', jsonReq({
      schemaVersion: USAGE_ANALYTICS_SCHEMA_VERSION,
      facts: [{
        ...baseFact,
        usageFactId: 'bad-metric',
        rawProviderPayload: { secret: 'metric-secret-value' },
      }],
    }));
    await app.request('/api/token-usage/summary?sessionKind=bad-kind');

    const counters = snapshotCounters();
    expect(counters['token_usage_ingest_requests_total{outcome=ok}']).toBe(1);
    expect(counters['token_usage_ingest_facts_total{status=invalid}']).toBe(1);
    expect(counters['token_usage_summary_requests_total{outcome=request_error,reason=invalid_session_kind}']).toBe(1);
    expect(Object.keys(counters).some((key) => key.includes('metric-secret-value'))).toBe(false);
    expect(Object.keys(counters).some((key) => key.includes('rawProviderPayload'))).toBe(false);
    expect(Object.keys(counters).some((key) => key.includes('openai') || key.includes('gpt-5'))).toBe(false);
  });
});
