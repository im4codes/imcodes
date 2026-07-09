export const USAGE_ANALYTICS_SCHEMA_VERSION = 1 as const;

export const USAGE_INGEST_PATH_HEADER = 'x-server-id';
export const USAGE_INGEST_ROUTE_SUFFIX = 'token-usage/ingest';
export const USAGE_SUMMARY_API_PATH = '/api/token-usage/summary';

export const USAGE_SESSION_KINDS = ['main', 'sub'] as const;
export type UsageSessionKind = (typeof USAGE_SESSION_KINDS)[number];

export const USAGE_METADATA_COMPLETENESS_VALUES = ['complete', 'partial'] as const;
export type UsageMetadataCompleteness = (typeof USAGE_METADATA_COMPLETENESS_VALUES)[number];

export const USAGE_SYNC_STATUSES = [
  'pending',
  'retryable_failed',
  'in_flight',
  'accepted',
  'duplicate',
  'conflict_terminal',
  'invalid_terminal',
  'too_old_terminal',
  'clock_skew_terminal',
  'local_pruned_unsynced',
] as const;
export type UsageSyncStatus = (typeof USAGE_SYNC_STATUSES)[number];

export const USAGE_REQUEST_ERROR_REASONS = [
  'auth_failed',
  'schema_invalid',
  'path_header_mismatch',
  'body_too_large',
  'rate_limited',
  'server_unavailable',
] as const;
export type UsageRequestErrorReason = (typeof USAGE_REQUEST_ERROR_REASONS)[number];

export const USAGE_FACT_STATUSES = [
  'accepted',
  'duplicate',
  'conflict',
  'invalid',
  'too_old',
  'clock_skew_too_far',
] as const;
export type UsageFactStatus = (typeof USAGE_FACT_STATUSES)[number];

export const USAGE_COST_COMPLETENESS_VALUES = ['known', 'unknown', 'partial'] as const;
export type UsageCostCompleteness = (typeof USAGE_COST_COMPLETENESS_VALUES)[number];

export const USAGE_SUMMARY_GROUP_BY_VALUES = [
  'date',
  'server',
  'providerModel',
  'mainSession',
  'subSession',
  'parentSession',
  'sessionModelDate',
] as const;
export type UsageSummaryGroupBy = (typeof USAGE_SUMMARY_GROUP_BY_VALUES)[number];

export const USAGE_SUMMARY_ORDER_VALUES = ['asc', 'desc'] as const;
export type UsageSummaryOrder = (typeof USAGE_SUMMARY_ORDER_VALUES)[number];

export const USAGE_SUMMARY_BUCKET_VALUES = [
  'byDate',
  'byServer',
  'byProviderModel',
  'byMainSession',
  'bySubSession',
  'byParentSession',
  'bySessionModelDate',
] as const;
export type UsageSummaryBucket = (typeof USAGE_SUMMARY_BUCKET_VALUES)[number];

export const USAGE_SUMMARY_GROUP_BY_BUCKETS = {
  date: 'byDate',
  server: 'byServer',
  providerModel: 'byProviderModel',
  mainSession: 'byMainSession',
  subSession: 'bySubSession',
  parentSession: 'byParentSession',
  sessionModelDate: 'bySessionModelDate',
} as const satisfies Record<UsageSummaryGroupBy, UsageSummaryBucket>;

export const USAGE_SUMMARY_DEFAULT_GROUP_BY = 'server' as const satisfies UsageSummaryGroupBy;
export const USAGE_SUMMARY_DEFAULT_SESSION_MODEL_DATE_LIMIT = 100 as const;

export const USAGE_UNSAFE_FIELD_NAMES = [
  'prompt',
  'promptText',
  'assistantText',
  'assistantResponse',
  'rawTimelineEvent',
  'timelineEvent',
  'rawSessionHistory',
  'sessionHistory',
  'rawProviderPayload',
  'providerPayload',
  'toolInput',
  'toolOutput',
  'localPath',
  'filePath',
  'attachmentContent',
  'env',
  'environment',
  'credential',
  'credentials',
  'apiKey',
  'authToken',
  'token',
  'secret',
  'rawSharedActorEnvelope',
  'sharedActorEnvelope',
  'childTranscript',
  'internalRuntimeFlags',
] as const;

export const USAGE_ATTRIBUTION_FIELD_NAMES = [
  'serverId',
  'userId',
  'account',
  'accountId',
] as const;

const USAGE_FACT_FIELD_NAMES = [
  'usageFactId',
  'createdAtMs',
  'sessionName',
  'sessionKind',
  'parentSessionName',
  'metadataCompleteness',
  'provider',
  'agentType',
  'model',
  'inputTokens',
  'cacheTokens',
  'outputTokens',
  'totalTokens',
  'contextWindow',
  'costUsdMicros',
  'sourceEventId',
] as const;

const USAGE_ENVELOPE_FIELD_NAMES = [
  'schemaVersion',
  'clientBatchId',
  'facts',
] as const;

const USAGE_CANONICAL_HASH_FIELD_NAMES = [
  'usageFactId',
  'createdAtMs',
  'sessionName',
  'sessionKind',
  'parentSessionName',
  'metadataCompleteness',
  'provider',
  'agentType',
  'model',
  'inputTokens',
  'cacheTokens',
  'outputTokens',
  'contextWindow',
  'costUsdMicros',
  'sourceEventId',
] as const satisfies readonly (keyof UsageFact)[];

export interface UsageFact {
  usageFactId: string;
  createdAtMs: number;
  sessionName: string;
  sessionKind: UsageSessionKind;
  parentSessionName: string | null;
  metadataCompleteness: UsageMetadataCompleteness;
  provider: string | null;
  agentType: string | null;
  model: string | null;
  inputTokens: number;
  cacheTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextWindow: number | null;
  costUsdMicros: number | null;
  sourceEventId: string | null;
}

export interface UsageIngestEnvelope {
  schemaVersion: typeof USAGE_ANALYTICS_SCHEMA_VERSION;
  clientBatchId?: string;
  facts: UsageFact[];
}

export interface UsageFactResult {
  usageFactId: string;
  status: UsageFactStatus;
  reason?: string;
}

export interface UsageIngestResult {
  schemaVersion: typeof USAGE_ANALYTICS_SCHEMA_VERSION;
  results: UsageFactResult[];
  diagnostics?: UsagePrivacySafeDiagnostics;
}

export interface UsageSummaryQuery {
  from?: string;
  to?: string;
  serverId?: string;
  sessionName?: string;
  sessionKind?: UsageSessionKind;
  parentSessionName?: string;
  provider?: string;
  agentType?: string;
  model?: string;
  groupBy?: UsageSummaryGroupBy;
  limit?: number;
  order?: UsageSummaryOrder;
}

export interface UsageSummaryRow {
  key: string;
  label?: string;
  date?: string;
  serverId?: string;
  sessionName?: string;
  sessionKind?: UsageSessionKind;
  parentSessionName?: string | null;
  provider?: string | null;
  agentType?: string | null;
  model?: string | null;
  metadataCompleteness?: UsageMetadataCompleteness;
  factCount: number;
  inputTokens: number;
  cacheTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsdMicros: number | null;
  costCompleteness: UsageCostCompleteness;
}

export interface UsageSummaryResponse {
  accountTotal: UsageSummaryRow;
  byDate: UsageSummaryRow[];
  byServer: UsageSummaryRow[];
  byProviderModel: UsageSummaryRow[];
  byMainSession: UsageSummaryRow[];
  bySubSession: UsageSummaryRow[];
  byParentSession: UsageSummaryRow[];
  bySessionModelDate: UsageSummaryRow[];
  meta: {
    from: string | null;
    to: string | null;
    generatedAtMs: number;
    filters: UsageSummaryQuery;
    primaryBucket: UsageSummaryBucket;
    partialBuckets: UsageSummaryBucket[];
    appliedLimits: Partial<Record<UsageSummaryBucket, number>>;
  };
}

export interface UsagePrivacySafeDiagnostics {
  pendingCount?: number;
  retryCount?: number;
  syncLagMs?: number;
  lastSuccessAtMs?: number;
  acceptedCount?: number;
  duplicateCount?: number;
  conflictCount?: number;
  invalidCount?: number;
  tooOldCount?: number;
  clockSkewCount?: number;
  lastErrorReason?: string;
}

export interface UsageValidationIssue {
  field: string;
  reason: 'missing' | 'invalid' | 'unknown' | 'unsafe' | 'attribution_forbidden';
}

export type UsageValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: UsageValidationIssue[] };

const usageFactFieldNameSet = new Set<string>(USAGE_FACT_FIELD_NAMES);
const usageEnvelopeFieldNameSet = new Set<string>(USAGE_ENVELOPE_FIELD_NAMES);
const unsafeFieldNameSet = new Set<string>(USAGE_UNSAFE_FIELD_NAMES);
const attributionFieldNameSet = new Set<string>(USAGE_ATTRIBUTION_FIELD_NAMES);

export function isUsageSessionKind(value: unknown): value is UsageSessionKind {
  return typeof value === 'string' && (USAGE_SESSION_KINDS as readonly string[]).includes(value);
}

export function isUsageMetadataCompleteness(value: unknown): value is UsageMetadataCompleteness {
  return typeof value === 'string' && (USAGE_METADATA_COMPLETENESS_VALUES as readonly string[]).includes(value);
}

export function normalizeUsageTokenCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a finite non-negative integer`);
  }
  return value;
}

export function normalizeUsageContextWindow(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  return normalizeUsageTokenCount(value, 'contextWindow');
}

export function normalizeCostUsdMicros(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('cost must be a finite number when present');
  }
  const micros = Math.sign(value) * Math.floor(Math.abs(value * 1_000_000) + 0.5);
  if (!Number.isSafeInteger(micros)) {
    throw new TypeError('costUsdMicros is outside safe integer range');
  }
  return Object.is(micros, -0) ? 0 : micros;
}

export function normalizeCostUsdMicrosValue(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  return normalizeUsageTokenCount(value, 'costUsdMicros');
}

export function normalizeCreatedAtMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new TypeError('createdAtMs must be a finite non-negative epoch millisecond integer');
  }
  return value;
}

export function usageDateUtcFromCreatedAtMs(createdAtMs: number): string {
  const normalized = normalizeCreatedAtMs(createdAtMs);
  const iso = new Date(normalized).toISOString();
  return iso.slice(0, 10);
}

export function computeTotalTokens(inputTokens: number, cacheTokens: number, outputTokens: number): number {
  return normalizeUsageTokenCount(inputTokens, 'inputTokens')
    + normalizeUsageTokenCount(cacheTokens, 'cacheTokens')
    + normalizeUsageTokenCount(outputTokens, 'outputTokens');
}

export function createEmptyUsageSummaryRow(key = 'total'): UsageSummaryRow {
  return {
    key,
    factCount: 0,
    inputTokens: 0,
    cacheTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsdMicros: null,
    costCompleteness: 'unknown',
  };
}

export function createEmptyUsageSummaryResponse(filters: UsageSummaryQuery = {}, generatedAtMs = Date.now()): UsageSummaryResponse {
  return {
    accountTotal: createEmptyUsageSummaryRow('account'),
    byDate: [],
    byServer: [],
    byProviderModel: [],
    byMainSession: [],
    bySubSession: [],
    byParentSession: [],
    bySessionModelDate: [],
    meta: {
      from: filters.from ?? null,
      to: filters.to ?? null,
      generatedAtMs,
      filters: { ...filters },
      primaryBucket: USAGE_SUMMARY_GROUP_BY_BUCKETS[filters.groupBy ?? USAGE_SUMMARY_DEFAULT_GROUP_BY],
      partialBuckets: [],
      appliedLimits: {},
    },
  };
}

export function detectUnsafeUsagePayloadFields(value: unknown, prefix = ''): UsageValidationIssue[] {
  if (!value || typeof value !== 'object') {
    return [];
  }
  const issues: UsageValidationIssue[] = [];
  for (const [key, childValue] of Object.entries(value as Record<string, unknown>)) {
    const field = prefix ? `${prefix}.${key}` : key;
    if (unsafeFieldNameSet.has(key)) {
      issues.push({ field, reason: 'unsafe' });
      continue;
    }
    if (childValue && typeof childValue === 'object' && !Array.isArray(childValue)) {
      issues.push(...detectUnsafeUsagePayloadFields(childValue, field));
    }
  }
  return issues;
}

export function validateUsageFactInput(input: unknown): UsageValidationResult<UsageFact> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, issues: [{ field: 'fact', reason: 'invalid' }] };
  }
  const record = input as Record<string, unknown>;
  const issues = detectUnsafeUsagePayloadFields(record);

  for (const key of Object.keys(record)) {
    if (attributionFieldNameSet.has(key)) {
      issues.push({ field: key, reason: 'attribution_forbidden' });
    } else if (!usageFactFieldNameSet.has(key)) {
      issues.push({ field: key, reason: 'unknown' });
    }
  }

  for (const required of ['usageFactId', 'createdAtMs', 'sessionName', 'sessionKind', 'metadataCompleteness'] as const) {
    if (record[required] === undefined || record[required] === null || record[required] === '') {
      issues.push({ field: required, reason: 'missing' });
    }
  }

  try {
    const inputTokens = normalizeUsageTokenCount(record.inputTokens ?? 0, 'inputTokens');
    const cacheTokens = normalizeUsageTokenCount(record.cacheTokens ?? 0, 'cacheTokens');
    const outputTokens = normalizeUsageTokenCount(record.outputTokens ?? 0, 'outputTokens');
    const totalTokens = computeTotalTokens(inputTokens, cacheTokens, outputTokens);
    const providedTotal = record.totalTokens;
    if (providedTotal !== undefined && providedTotal !== totalTokens) {
      issues.push({ field: 'totalTokens', reason: 'invalid' });
    }
    if (!isUsageSessionKind(record.sessionKind)) {
      issues.push({ field: 'sessionKind', reason: 'invalid' });
    }
    if (!isUsageMetadataCompleteness(record.metadataCompleteness)) {
      issues.push({ field: 'metadataCompleteness', reason: 'invalid' });
    }
    const fact: UsageFact = {
      usageFactId: requireString(record.usageFactId, 'usageFactId', issues),
      createdAtMs: normalizeCreatedAtMs(record.createdAtMs),
      sessionName: requireString(record.sessionName, 'sessionName', issues),
      sessionKind: isUsageSessionKind(record.sessionKind) ? record.sessionKind : 'main',
      parentSessionName: optionalString(record.parentSessionName, issues, 'parentSessionName'),
      metadataCompleteness: isUsageMetadataCompleteness(record.metadataCompleteness) ? record.metadataCompleteness : 'partial',
      provider: optionalString(record.provider, issues, 'provider'),
      agentType: optionalString(record.agentType, issues, 'agentType'),
      model: optionalString(record.model, issues, 'model'),
      inputTokens,
      cacheTokens,
      outputTokens,
      totalTokens,
      contextWindow: normalizeUsageContextWindow(record.contextWindow),
      costUsdMicros: normalizeCostUsdMicrosValue(record.costUsdMicros),
      sourceEventId: optionalString(record.sourceEventId, issues, 'sourceEventId'),
    };
    return issues.length > 0 ? { ok: false, issues: dedupeIssues(issues) } : { ok: true, value: fact };
  } catch {
    issues.push({ field: 'fact', reason: 'invalid' });
    return { ok: false, issues: dedupeIssues(issues) };
  }
}

export function validateUsageIngestEnvelopeInput(input: unknown): UsageValidationResult<UsageIngestEnvelope> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, issues: [{ field: 'envelope', reason: 'invalid' }] };
  }
  const record = input as Record<string, unknown>;
  const issues = detectUnsafeUsagePayloadFields(record);

  for (const key of Object.keys(record)) {
    if (attributionFieldNameSet.has(key)) {
      issues.push({ field: key, reason: 'attribution_forbidden' });
    } else if (!usageEnvelopeFieldNameSet.has(key)) {
      issues.push({ field: key, reason: 'unknown' });
    }
  }
  if (record.schemaVersion !== USAGE_ANALYTICS_SCHEMA_VERSION) {
    issues.push({ field: 'schemaVersion', reason: 'invalid' });
  }
  if (!Array.isArray(record.facts)) {
    issues.push({ field: 'facts', reason: 'invalid' });
  }
  const facts: UsageFact[] = [];
  if (Array.isArray(record.facts)) {
    record.facts.forEach((factInput, index) => {
      const parsed = validateUsageFactInput(factInput);
      if (parsed.ok) {
        facts.push(parsed.value);
      } else {
        for (const issue of parsed.issues) {
          issues.push({ ...issue, field: `facts.${index}.${issue.field}` });
        }
      }
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues: dedupeIssues(issues) };
  }
  return {
    ok: true,
    value: {
      schemaVersion: USAGE_ANALYTICS_SCHEMA_VERSION,
      clientBatchId: optionalString(record.clientBatchId, issues, 'clientBatchId') ?? undefined,
      facts,
    },
  };
}

export function createCanonicalUsagePayloadHash(fact: UsageFact): string {
  const canonical = USAGE_CANONICAL_HASH_FIELD_NAMES.map((field) => [field, fact[field]] as const);
  return `usage-v1-${fnv1a64(JSON.stringify(canonical))}`;
}

function requireString(value: unknown, field: string, issues: UsageValidationIssue[]): string {
  if (typeof value !== 'string' || value.length === 0) {
    issues.push({ field, reason: 'invalid' });
    return '';
  }
  return value;
}

function optionalString(value: unknown, issues: UsageValidationIssue[], field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    issues.push({ field, reason: 'invalid' });
    return null;
  }
  return value;
}

function dedupeIssues(issues: UsageValidationIssue[]): UsageValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.field}:${issue.reason}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}
