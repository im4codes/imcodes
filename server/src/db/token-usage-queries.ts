import { randomUUID } from 'node:crypto';
import type { Database } from './client.js';
import {
  createCanonicalUsagePayloadHash,
  createEmptyUsageSummaryResponse,
  USAGE_SUMMARY_DEFAULT_GROUP_BY,
  USAGE_SUMMARY_DEFAULT_SESSION_MODEL_DATE_LIMIT,
  USAGE_SUMMARY_GROUP_BY_BUCKETS,
  usageDateUtcFromCreatedAtMs,
  type UsageFact,
  type UsageFactResult,
  type UsageSummaryBucket,
  type UsageSummaryQuery,
  type UsageSummaryResponse,
  type UsageSummaryRow,
} from '../../../shared/usage-analytics.js';

export interface IngestServerTokenUsageFactsParams {
  serverId: string;
  userId: string;
  facts: UsageFact[];
  now?: number;
  importWindowMs?: number;
  futureToleranceMs?: number;
}

interface ExistingUsageFactRow {
  payload_hash: string;
}

interface InsertedUsageFactRow {
  payload_hash: string;
}

interface UsageAggregateRow {
  key: string;
  label: string | null;
  usage_date_utc?: string | Date | null;
  server_id?: string | null;
  session_name?: string | null;
  session_kind?: 'main' | 'sub' | null;
  parent_session_name?: string | null;
  provider?: string | null;
  agent_type?: string | null;
  model?: string | null;
  metadata_completeness?: 'complete' | 'partial' | null;
  fact_count: number;
  input_tokens: number;
  cache_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd_micros: number | null;
  known_cost_count: number;
}

const DEFAULT_IMPORT_WINDOW_MS = 180 * 86_400_000;
const DEFAULT_FUTURE_TOLERANCE_MS = 10 * 60_000;

export async function ingestServerTokenUsageFacts(
  db: Database,
  params: IngestServerTokenUsageFactsParams,
): Promise<UsageFactResult[]> {
  const now = params.now ?? Date.now();
  const importWindowMs = params.importWindowMs ?? DEFAULT_IMPORT_WINDOW_MS;
  const futureToleranceMs = params.futureToleranceMs ?? DEFAULT_FUTURE_TOLERANCE_MS;
  return db.transaction(async (tx) => {
    const results: UsageFactResult[] = [];
    for (const fact of params.facts) {
      const payloadHash = createCanonicalUsagePayloadHash(fact);
      const existing = await findExistingUsageFact(tx, params.serverId, fact.usageFactId);
      if (existing) {
        results.push(classifyExistingUsageFact(fact.usageFactId, payloadHash, existing.payload_hash));
        continue;
      }
      if (fact.createdAtMs < now - importWindowMs) {
        results.push({ usageFactId: fact.usageFactId, status: 'too_old' });
        continue;
      }
      if (fact.createdAtMs > now + futureToleranceMs) {
        results.push({ usageFactId: fact.usageFactId, status: 'clock_skew_too_far' });
        continue;
      }
      results.push(await insertServerTokenUsageFactIdempotent(tx, {
        serverId: params.serverId,
        userId: params.userId,
        fact,
        payloadHash,
        receivedAtMs: now,
      }));
    }
    return results;
  });
}

async function insertServerTokenUsageFactIdempotent(
  db: Database,
  params: { serverId: string; userId: string; fact: UsageFact; payloadHash: string; receivedAtMs: number },
): Promise<UsageFactResult> {
  const inserted = await db.queryOne<InsertedUsageFactRow>(
    `INSERT INTO server_token_usage_facts (
      id,
      server_id,
      user_id,
      usage_fact_id,
      payload_hash,
      created_at_ms,
      usage_date_utc,
      received_at_ms,
      session_name,
      session_kind,
      parent_session_name,
      metadata_completeness,
      provider,
      agent_type,
      model,
      input_tokens,
      cache_tokens,
      output_tokens,
      total_tokens,
      context_window,
      cost_usd_micros,
      source_event_id
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10, $11, $12, $13, $14, $15, $16,
      $17, $18, $19, $20, $21, $22
    )
    ON CONFLICT (server_id, usage_fact_id) DO NOTHING
    RETURNING payload_hash`,
    [
      randomUUID(),
      params.serverId,
      params.userId,
      params.fact.usageFactId,
      params.payloadHash,
      params.fact.createdAtMs,
      usageDateUtcFromCreatedAtMs(params.fact.createdAtMs),
      params.receivedAtMs,
      params.fact.sessionName,
      params.fact.sessionKind,
      params.fact.parentSessionName,
      params.fact.metadataCompleteness,
      params.fact.provider,
      params.fact.agentType,
      params.fact.model,
      params.fact.inputTokens,
      params.fact.cacheTokens,
      params.fact.outputTokens,
      params.fact.totalTokens,
      params.fact.contextWindow,
      params.fact.costUsdMicros,
      params.fact.sourceEventId,
    ],
  );
  if (inserted) {
    return { usageFactId: params.fact.usageFactId, status: 'accepted' };
  }

  const existing = await findExistingUsageFact(db, params.serverId, params.fact.usageFactId);
  if (existing) {
    return classifyExistingUsageFact(params.fact.usageFactId, params.payloadHash, existing.payload_hash);
  }
  throw new Error('usage_fact_conflict_without_existing_row');
}

async function findExistingUsageFact(
  db: Database,
  serverId: string,
  usageFactId: string,
): Promise<ExistingUsageFactRow | null> {
  return db.queryOne<ExistingUsageFactRow>(
    'SELECT payload_hash FROM server_token_usage_facts WHERE server_id = $1 AND usage_fact_id = $2',
    [serverId, usageFactId],
  );
}

function classifyExistingUsageFact(
  usageFactId: string,
  incomingPayloadHash: string,
  existingPayloadHash: string,
): UsageFactResult {
  return {
    usageFactId,
    status: existingPayloadHash === incomingPayloadHash ? 'duplicate' : 'conflict',
  };
}

export async function getTokenUsageSummary(
  db: Database,
  userId: string,
  query: UsageSummaryQuery = {},
): Promise<UsageSummaryResponse> {
  const { whereSql, params } = buildSummaryWhere(userId, query);
  const response = createEmptyUsageSummaryResponse(query);
  const accountRows = await queryAggregate(db, whereSql, params, {
    keySql: '$$account$$',
    labelSql: '$$Account$$',
  });
  response.accountTotal = accountRows[0] ?? response.accountTotal;
  response.byDate = await queryAggregate(db, whereSql, params, {
    keySql: 'usage_date_utc::text',
    labelSql: 'usage_date_utc::text',
    extraSql: 'usage_date_utc::text AS usage_date_utc',
    groupSql: 'usage_date_utc',
    orderSql: 'usage_date_utc ASC',
  });
  response.byServer = await queryAggregate(db, whereSql, params, {
    keySql: 'server_id',
    labelSql: 'server_id',
    extraSql: 'server_id',
    groupSql: 'server_id',
  });
  response.byProviderModel = await queryAggregate(db, whereSql, params, {
    keySql: "coalesce(provider, agent_type, 'unknown') || ':' || coalesce(model, 'unknown')",
    labelSql: "coalesce(provider, agent_type, 'unknown') || ' / ' || coalesce(model, 'unknown')",
    extraSql: 'CASE WHEN provider IS NOT NULL THEN provider ELSE NULL END AS provider, CASE WHEN provider IS NULL THEN agent_type ELSE NULL END AS agent_type, model',
    groupSql: 'CASE WHEN provider IS NOT NULL THEN provider ELSE NULL END, CASE WHEN provider IS NULL THEN agent_type ELSE NULL END, coalesce(provider, agent_type, $$unknown$$), model',
  });
  response.byMainSession = await queryAggregate(db, `${whereSql} AND session_kind = 'main'`, params, {
    keySql: "server_id || ':' || session_name || ':main'",
    labelSql: 'session_name',
    extraSql: 'server_id, session_name, session_kind',
    aggregateExtraSql: "CASE WHEN bool_or(metadata_completeness = 'partial') THEN 'partial' ELSE 'complete' END AS metadata_completeness",
    groupSql: 'server_id, session_name, session_kind',
  });
  response.bySubSession = await queryAggregate(db, `${whereSql} AND session_kind = 'sub'`, params, {
    keySql: "server_id || ':' || session_name || ':sub'",
    labelSql: 'session_name',
    extraSql: 'server_id, session_name, session_kind',
    aggregateExtraSql: "min(parent_session_name) AS parent_session_name, CASE WHEN bool_or(metadata_completeness = 'partial') THEN 'partial' ELSE 'complete' END AS metadata_completeness",
    groupSql: 'server_id, session_name, session_kind',
  });
  response.byParentSession = await queryAggregate(db, `${whereSql} AND parent_session_name IS NOT NULL`, params, {
    keySql: 'parent_session_name',
    labelSql: 'parent_session_name',
    extraSql: 'parent_session_name',
    groupSql: 'parent_session_name',
  });
  response.bySessionModelDate = await queryAggregate(db, whereSql, params, {
    keySql: "server_id || ':' || session_name || ':' || session_kind || ':' || coalesce(model, 'unknown') || ':' || usage_date_utc::text",
    labelSql: "session_name || ' / ' || coalesce(model, 'unknown') || ' / ' || usage_date_utc::text",
    extraSql: 'usage_date_utc::text AS usage_date_utc, server_id, session_name, session_kind, model',
    aggregateExtraSql: "min(parent_session_name) AS parent_session_name, CASE WHEN bool_or(metadata_completeness = 'partial') THEN 'partial' ELSE 'complete' END AS metadata_completeness",
    groupSql: 'usage_date_utc, server_id, session_name, session_kind, model',
    orderSql: 'usage_date_utc ASC, session_name ASC',
  });
  applySummaryWindow(response, query);
  return response;
}

export async function deleteTokenUsageFactsForServer(db: Database, serverId: string): Promise<number> {
  const result = await db.execute('DELETE FROM server_token_usage_facts WHERE server_id = $1', [serverId]);
  return result.changes;
}

export async function deleteTokenUsageFactsForUser(db: Database, userId: string): Promise<number> {
  const result = await db.execute('DELETE FROM server_token_usage_facts WHERE user_id = $1', [userId]);
  return result.changes;
}

function buildSummaryWhere(userId: string, query: UsageSummaryQuery): { whereSql: string; params: unknown[] } {
  const clauses = ['user_id = $1'];
  const params: unknown[] = [userId];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    clauses.push(sql.replace('?', `$${params.length}`));
  };
  if (query.from) add('usage_date_utc >= ?::date', query.from);
  if (query.to) add('usage_date_utc <= ?::date', query.to);
  if (query.serverId) add('server_id = ?', query.serverId);
  if (query.sessionName) add('session_name = ?', query.sessionName);
  if (query.sessionKind) add('session_kind = ?', query.sessionKind);
  if (query.parentSessionName) add('parent_session_name = ?', query.parentSessionName);
  if (query.provider) add('provider = ?', query.provider);
  if (query.agentType) add('agent_type = ?', query.agentType);
  if (query.model) add('model = ?', query.model);
  return { whereSql: clauses.join(' AND '), params };
}

async function queryAggregate(
  db: Database,
  whereSql: string,
  params: unknown[],
  shape: {
    keySql: string;
    labelSql: string;
    extraSql?: string;
    aggregateExtraSql?: string;
    groupSql?: string;
    orderSql?: string;
  },
): Promise<UsageSummaryRow[]> {
  const extra = shape.extraSql ? `, ${shape.extraSql}` : '';
  const aggregateExtra = shape.aggregateExtraSql ? `, ${shape.aggregateExtraSql}` : '';
  const group = shape.groupSql ? ` GROUP BY ${shape.groupSql}` : '';
  const order = shape.orderSql ? ` ORDER BY ${shape.orderSql}` : ' ORDER BY sum(total_tokens) DESC';
  const rows = await db.query<UsageAggregateRow>(
    `SELECT
       ${shape.keySql} AS key,
       ${shape.labelSql} AS label
       ${extra},
       count(*)::bigint AS fact_count,
       coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
       coalesce(sum(cache_tokens), 0)::bigint AS cache_tokens,
       coalesce(sum(output_tokens), 0)::bigint AS output_tokens,
       coalesce(sum(total_tokens), 0)::bigint AS total_tokens,
       sum(cost_usd_micros)::bigint AS cost_usd_micros,
       count(cost_usd_micros)::bigint AS known_cost_count
       ${aggregateExtra}
     FROM server_token_usage_facts
     WHERE ${whereSql}
     ${group}
     ${order}`,
    params,
  );
  return rows.map(projectSummaryRow);
}

function projectSummaryRow(row: UsageAggregateRow): UsageSummaryRow {
  const factCount = Number(row.fact_count ?? 0);
  const knownCostCount = Number(row.known_cost_count ?? 0);
  return {
    key: row.key,
    ...(row.label ? { label: row.label } : {}),
    ...(row.usage_date_utc ? { date: normalizeDate(row.usage_date_utc) } : {}),
    ...(row.server_id ? { serverId: row.server_id } : {}),
    ...(row.session_name ? { sessionName: row.session_name } : {}),
    ...(row.session_kind ? { sessionKind: row.session_kind } : {}),
    ...(row.parent_session_name !== undefined ? { parentSessionName: row.parent_session_name } : {}),
    ...(row.provider !== undefined ? { provider: row.provider } : {}),
    ...(row.agent_type !== undefined ? { agentType: row.agent_type } : {}),
    ...(row.model !== undefined ? { model: row.model } : {}),
    ...(row.metadata_completeness ? { metadataCompleteness: row.metadata_completeness } : {}),
    factCount,
    inputTokens: Number(row.input_tokens ?? 0),
    cacheTokens: Number(row.cache_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    totalTokens: Number(row.total_tokens ?? 0),
    costUsdMicros: row.cost_usd_micros == null ? null : Number(row.cost_usd_micros),
    costCompleteness: knownCostCount === 0 ? 'unknown' : knownCostCount === factCount ? 'known' : 'partial',
  };
}

function normalizeDate(input: string | Date): string {
  if (input instanceof Date) {
    return input.toISOString().slice(0, 10);
  }
  return String(input).slice(0, 10);
}

function applySummaryWindow(response: UsageSummaryResponse, query: UsageSummaryQuery): void {
  const primaryBucket = USAGE_SUMMARY_GROUP_BY_BUCKETS[query.groupBy ?? USAGE_SUMMARY_DEFAULT_GROUP_BY];
  response.meta.primaryBucket = primaryBucket;
  response.meta.partialBuckets = [];
  response.meta.appliedLimits = {};
  applyBucketWindow(response, primaryBucket, query.limit, query.order);
  if (primaryBucket !== 'bySessionModelDate') {
    applyBucketWindow(response, 'bySessionModelDate', USAGE_SUMMARY_DEFAULT_SESSION_MODEL_DATE_LIMIT);
  }
}

function applyBucketWindow(
  response: UsageSummaryResponse,
  bucket: UsageSummaryBucket,
  limit: number | undefined,
  order?: UsageSummaryQuery['order'],
): void {
  let rows = response[bucket];
  if (order) {
    const direction = order === 'asc' ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      const totalDiff = (a.totalTokens - b.totalTokens) * direction;
      if (totalDiff !== 0) return totalDiff;
      return a.key.localeCompare(b.key);
    });
  }
  if (!limit) {
    response[bucket] = rows;
    return;
  }
  if (rows.length > limit && !response.meta.partialBuckets.includes(bucket)) {
    response.meta.partialBuckets.push(bucket);
  }
  response.meta.appliedLimits[bucket] = limit;
  response[bucket] = rows.slice(0, limit);
}
