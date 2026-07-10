import { Hono } from 'hono';
import type { Env } from '../env.js';
import { requireAuth } from '../security/authorization.js';
import { verifyDaemonServerAuth } from '../security/daemon-auth.js';
import { addCounter, incrementCounter } from '../util/metrics.js';
import { getServerById } from '../db/queries.js';
import {
  getTokenUsageSummary,
  ingestServerTokenUsageFacts,
} from '../db/token-usage-queries.js';
import {
  USAGE_ANALYTICS_SCHEMA_VERSION,
  USAGE_ATTRIBUTION_FIELD_NAMES,
  USAGE_SUMMARY_GROUP_BY_VALUES,
  USAGE_SUMMARY_ORDER_VALUES,
  USAGE_UNSAFE_FIELD_NAMES,
  USAGE_SESSION_KINDS,
  usageDateUtcFromCreatedAtMs,
  validateUsageFactInput,
  type UsageFact,
  type UsageFactResult,
  type UsageSummaryQuery,
} from '../../../shared/usage-analytics.js';

export const tokenUsageRoutes = new Hono<{ Bindings: Env }>();

const MAX_USAGE_FACTS_PER_BATCH = 500;
const MAX_USAGE_INGEST_BODY_BYTES = 5 * 1024 * 1024;

tokenUsageRoutes.post('/server/:serverId/token-usage/ingest', async (c) => {
  const startedAt = Date.now();
  const finish = (outcome: string, reason?: string) => {
    const labels: Record<string, string> = reason ? { outcome, reason } : { outcome };
    incrementCounter('token_usage_ingest_requests_total', labels);
    addCounter('token_usage_ingest_duration_ms_total', Math.max(1, Date.now() - startedAt), labels);
  };
  const serverId = c.req.param('serverId');
  const auth = await verifyDaemonServerAuth(c, serverId);
  if (!auth.ok) {
    finish('request_error', auth.error);
    return c.json({ error: auth.error }, auth.status);
  }

  const contentLength = Number(c.req.header('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_USAGE_INGEST_BODY_BYTES) {
    finish('request_error', 'body_too_large');
    return c.json({ error: 'batch_too_large' }, 413);
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    finish('request_error', 'invalid_envelope');
    return c.json({ error: 'invalid_envelope' }, 400);
  }
  const record = body as Record<string, unknown>;
  if (record.schemaVersion !== USAGE_ANALYTICS_SCHEMA_VERSION || !Array.isArray(record.facts)) {
    finish('request_error', 'invalid_envelope');
    return c.json({ error: 'invalid_envelope' }, 400);
  }
  if (record.clientBatchId !== undefined && typeof record.clientBatchId !== 'string') {
    finish('request_error', 'invalid_envelope');
    return c.json({ error: 'invalid_envelope' }, 400);
  }
  if (Object.keys(record).some((key) => (USAGE_ATTRIBUTION_FIELD_NAMES as readonly string[]).includes(key))) {
    finish('request_error', 'body_attribution_forbidden');
    return c.json({ error: 'body_attribution_forbidden' }, 400);
  }
  if (Object.keys(record).some((key) => key !== 'schemaVersion' && key !== 'clientBatchId' && key !== 'facts')) {
    finish('request_error', 'invalid_envelope');
    return c.json({ error: 'invalid_envelope' }, 400);
  }
  if (Object.keys(record).some((key) => (USAGE_UNSAFE_FIELD_NAMES as readonly string[]).includes(key))) {
    finish('request_error', 'invalid_envelope');
    return c.json({ error: 'invalid_envelope' }, 400);
  }
  if (record.facts.length > MAX_USAGE_FACTS_PER_BATCH) {
    finish('request_error', 'batch_too_large');
    return c.json({ error: 'batch_too_large' }, 413);
  }

  const validFacts: UsageFact[] = [];
  const invalidResults: UsageFactResult[] = [];
  for (const factInput of record.facts) {
    const parsed = validateUsageFactInput(factInput);
    if (parsed.ok) {
      validFacts.push(parsed.value);
      continue;
    }
    const id = factInput && typeof factInput === 'object' && typeof (factInput as { usageFactId?: unknown }).usageFactId === 'string'
      ? (factInput as { usageFactId: string }).usageFactId
      : 'unknown';
    invalidResults.push({
      usageFactId: id,
      status: 'invalid',
      reason: parsed.issues.map((issue) => `${issue.field}:${issue.reason}`).join(','),
    });
  }

  let acceptedResults: UsageFactResult[];
  try {
    acceptedResults = validFacts.length > 0
      ? await ingestServerTokenUsageFacts(c.env.DB, {
        serverId: auth.auth.serverId,
        userId: auth.auth.userId,
        facts: validFacts,
      })
      : [];
  } catch {
    finish('request_error', 'server_unavailable');
    return c.json({ error: 'server_unavailable' }, 500);
  }

  for (const result of [...acceptedResults, ...invalidResults]) {
    incrementCounter('token_usage_ingest_facts_total', { status: result.status });
  }
  finish('ok');
  return c.json({
    schemaVersion: USAGE_ANALYTICS_SCHEMA_VERSION,
    results: [...acceptedResults, ...invalidResults],
  });
});

tokenUsageRoutes.get('/token-usage/summary', requireAuth(), async (c) => {
  const startedAt = Date.now();
  const finish = (outcome: string, reason?: string) => {
    const labels: Record<string, string> = reason ? { outcome, reason } : { outcome };
    incrementCounter('token_usage_summary_requests_total', labels);
    addCounter('token_usage_summary_duration_ms_total', Math.max(1, Date.now() - startedAt), labels);
  };
  const parsed = parseSummaryQuery(c.req.query());
  if (!parsed.ok) {
    finish('request_error', parsed.error);
    return c.json({ error: parsed.error }, 400);
  }
  const userId = c.get('userId' as never) as string;
  try {
    if (parsed.query.serverId) {
      const server = await getServerById(c.env.DB, parsed.query.serverId);
      if (!server || server.user_id !== userId) {
        finish('request_error', 'not_found');
        return c.json({ error: 'not_found' }, 404);
      }
    }
    const summary = await getTokenUsageSummary(c.env.DB, userId, parsed.query);
    finish('ok');
    return c.json(summary);
  } catch {
    finish('request_error', 'server_unavailable');
    return c.json({ error: 'server_unavailable' }, 500);
  }
});

function parseSummaryQuery(raw: Record<string, string>): { ok: true; query: UsageSummaryQuery } | { ok: false; error: string } {
  const query: UsageSummaryQuery = {};
  const copyString = (key: keyof UsageSummaryQuery) => {
    const value = raw[key as string];
    if (typeof value === 'string' && value.trim()) {
      (query as Record<string, string>)[key] = value.trim();
    }
  };
  copyString('from');
  copyString('to');
  copyString('serverId');
  copyString('sessionName');
  copyString('parentSessionName');
  copyString('groupSession');
  copyString('provider');
  copyString('agentType');
  copyString('model');

  if (raw.sessionKind) {
    if (!(USAGE_SESSION_KINDS as readonly string[]).includes(raw.sessionKind)) return { ok: false, error: 'invalid_session_kind' };
    query.sessionKind = raw.sessionKind as UsageSummaryQuery['sessionKind'];
  }
  if (raw.groupBy) {
    if (!(USAGE_SUMMARY_GROUP_BY_VALUES as readonly string[]).includes(raw.groupBy)) return { ok: false, error: 'invalid_group_by' };
    query.groupBy = raw.groupBy as UsageSummaryQuery['groupBy'];
  }
  if (raw.order) {
    if (!(USAGE_SUMMARY_ORDER_VALUES as readonly string[]).includes(raw.order)) return { ok: false, error: 'invalid_order' };
    query.order = raw.order as UsageSummaryQuery['order'];
  }
  if (raw.limit) {
    const limit = Number(raw.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return { ok: false, error: 'invalid_limit' };
    query.limit = limit;
  }
  if (query.from && !isStrictDateOnly(query.from)) return { ok: false, error: 'invalid_from' };
  if (query.to && !isStrictDateOnly(query.to)) return { ok: false, error: 'invalid_to' };
  if (query.from && query.to && query.from > query.to) return { ok: false, error: 'invalid_date_range' };
  return { ok: true, query };
}

function isStrictDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && usageDateUtcFromCreatedAtMs(timestamp) === value;
}
