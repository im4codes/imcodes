import type { ContextNamespace, ProcessedContextClass } from '../../shared/context-types.js';
import type { ObservationClass, ObservationState } from '../../shared/memory-observation.js';
import { normalizeSummaryForFingerprint } from '../../shared/memory-fingerprint.js';
import { searchLocalMemory, searchLocalMemorySemantic, type MemorySearchQuery } from '../context/memory-search.js';
import { projectionOwnerCache } from './memory-projection-owner-cache.js';

export type MemoryMcpListProjectionClass = Extract<ProcessedContextClass, 'recent_summary' | 'durable_memory_candidate'>;

export interface MemoryMcpSearchHit {
  recordKind?: 'projection' | 'observation';
  projectionId: string;
  observationId?: string;
  summary: string;
  projectionClass?: ProcessedContextClass | string;
  observationClass?: ObservationClass | string;
  observationState?: ObservationState | string;
  matchKind?: 'exact' | 'semantic' | 'trigram';
  projectId?: string;
  scope?: string;
  createdAt?: number;
  updatedAt?: number;
  relevanceScore?: number;
  source?: 'cloud' | 'local';
  /**
   * The daemon that originally produced this projection. Cloud hits carry the
   * value the server attached from `shared_context_projections.server_id`;
   * local hits are tagged with the local daemon's bound serverId so MCP output
   * is uniformly identifiable. Consumers (e.g. a future cross-server
   * `get_memory_sources` orchestrator) use this to route source lookups back
   * to the daemon whose local SQLite holds the raw events.
   */
  originServerId?: string;
}

export interface MemoryMcpSearchResult {
  items: MemoryMcpSearchHit[];
}

export interface MemoryMcpListSummariesQuery {
  namespace?: MemorySearchQuery['namespace'];
  currentEnterpriseId?: string;
  repo?: string;
  userId?: string;
  includeLegacyPersonalOwner?: boolean;
  projectionClass?: MemoryMcpListProjectionClass;
  limit?: number;
}

export interface MemoryMcpSearchOptions {
  fetchImpl?: typeof fetch;
  credentials?: {
    workerUrl: string;
    serverId: string;
    token: string;
  } | null;
  loadCredentials?: () => Promise<MemoryMcpSearchOptions['credentials']>;
}

interface CloudRecallResponse {
  results?: Array<{
    id?: string;
    projectId?: string;
    class?: string;
    summary?: string;
    updatedAt?: number;
    score?: number;
    matchKind?: 'exact' | 'semantic' | 'trigram';
    source?: 'personal' | 'enterprise';
    /**
     * Added by the server in support of cross-server source resolution. The
     * field is optional in the wire schema so this client stays compatible
     * with servers that have not yet rolled out the addition.
     */
    originServerId?: string;
  }>;
}

interface CloudMemoryListResponse {
  records?: Array<{
    id?: string;
    projectId?: string;
    projectionClass?: string;
    summary?: string;
    updatedAt?: number;
    hitCount?: number;
    lastUsedAt?: number;
  }>;
}

function cleanBaseUrl(workerUrl: string): string {
  return workerUrl.replace(/\/+$/, '');
}

async function defaultLoadCredentials(): Promise<MemoryMcpSearchOptions['credentials']> {
  try {
    const { loadCredentials } = await import('../bind/bind-flow.js');
    return await loadCredentials();
  } catch {
    return null;
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 20;
  return Math.min(Math.max(1, Math.trunc(limit)), 100);
}

function clampListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 20;
  return Math.min(Math.max(1, Math.trunc(limit)), 100);
}

function cloudRecallUrl(workerUrl: string, serverId: string): string {
  return `${cleanBaseUrl(workerUrl)}/api/shared-context/${encodeURIComponent(serverId)}/shared-context/memory/recall`;
}

function cloudPersonalMemoryUrl(workerUrl: string, query: {
  projectId: string;
  projectionClass?: MemoryMcpListProjectionClass;
  limit: number;
}): string {
  const params = new URLSearchParams();
  params.set('projectId', query.projectId);
  if (query.projectionClass) params.set('projectionClass', query.projectionClass);
  params.set('limit', String(query.limit));
  return `${cleanBaseUrl(workerUrl)}/api/shared-context/personal-memory?${params.toString()}`;
}

function currentProjectId(query: { repo?: string; namespace?: Pick<ContextNamespace, 'projectId'> }): string | undefined {
  const repo = query.repo?.trim();
  if (repo) return repo;
  const namespaceProjectId = query.namespace?.projectId?.trim();
  return namespaceProjectId || undefined;
}

async function resolveCredentialsOnce(options: MemoryMcpSearchOptions): Promise<MemoryMcpSearchOptions['credentials']> {
  if (options.credentials !== undefined) return options.credentials;
  return (options.loadCredentials ?? defaultLoadCredentials)();
}

async function searchCloudMemoryRecall(
  query: MemorySearchQuery,
  options: MemoryMcpSearchOptions,
  credentials: NonNullable<MemoryMcpSearchOptions['credentials']>,
): Promise<MemoryMcpSearchHit[]> {
  if (!credentials?.workerUrl || !credentials.serverId || !credentials.token || !query.query?.trim()) return [];
  const requestedProjectId = query.repo ?? query.namespace?.projectId;

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(cloudRecallUrl(credentials.workerUrl, credentials.serverId), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credentials.token}`,
      'X-Server-Id': credentials.serverId,
    },
    body: JSON.stringify({
      query: query.query,
      projectId: requestedProjectId,
      limit: clampLimit(query.limit),
      mode: 'search',
    }),
  });
  if (!response.ok) return [];
  const body = await response.json().catch(() => null) as CloudRecallResponse | null;
  if (!Array.isArray(body?.results)) return [];
  return body.results
    .filter((item): item is Required<Pick<NonNullable<CloudRecallResponse['results']>[number], 'id' | 'summary'>> & NonNullable<CloudRecallResponse['results']>[number] => (
      typeof item?.id === 'string'
      && item.id.trim().length > 0
      && typeof item.summary === 'string'
      && item.summary.trim().length > 0
    ))
    .filter((item) => !requestedProjectId || item.projectId === requestedProjectId)
    .map((item) => ({
      projectionId: item.id,
      summary: item.summary,
      projectionClass: item.class,
      matchKind: item.matchKind,
      projectId: item.projectId,
      updatedAt: item.updatedAt,
      relevanceScore: item.score,
      scope: item.source === 'enterprise' ? 'project_shared' : 'personal',
      source: 'cloud' as const,
      ...(typeof item.originServerId === 'string' && item.originServerId.trim()
        ? { originServerId: item.originServerId.trim() }
        : {}),
    }));
}

async function listCloudMemorySummaries(
  query: MemoryMcpListSummariesQuery,
  options: MemoryMcpSearchOptions,
  credentials: NonNullable<MemoryMcpSearchOptions['credentials']>,
  limit: number,
): Promise<MemoryMcpSearchHit[]> {
  if (!credentials?.workerUrl || !credentials.serverId || !credentials.token) return [];
  const requestedProjectId = currentProjectId(query);
  if (!requestedProjectId) return [];
  const projectionClass = query.projectionClass ?? 'recent_summary';
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(cloudPersonalMemoryUrl(credentials.workerUrl, {
    projectId: requestedProjectId,
    projectionClass,
    limit,
  }), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${credentials.token}`,
      'X-Server-Id': credentials.serverId,
    },
  });
  if (!response.ok) return [];
  const body = await response.json().catch(() => null) as CloudMemoryListResponse | null;
  if (!Array.isArray(body?.records)) return [];
  return body.records
    .filter((item): item is Required<Pick<NonNullable<CloudMemoryListResponse['records']>[number], 'id' | 'summary'>> & NonNullable<CloudMemoryListResponse['records']>[number] => (
      typeof item?.id === 'string'
      && item.id.trim().length > 0
      && typeof item.summary === 'string'
      && item.summary.trim().length > 0
    ))
    .filter((item) => !requestedProjectId || item.projectId === requestedProjectId)
    .filter((item) => !item.projectionClass || item.projectionClass === projectionClass)
    .map((item) => ({
      recordKind: 'projection' as const,
      projectionId: item.id,
      summary: item.summary,
      projectionClass: item.projectionClass ?? projectionClass,
      matchKind: 'exact' as const,
      projectId: item.projectId,
      updatedAt: item.updatedAt,
      scope: 'personal',
      source: 'cloud' as const,
    }));
}

async function searchLocalRecall(
  query: MemorySearchQuery,
  localServerId: string | undefined,
): Promise<MemoryMcpSearchHit[]> {
  const result = await searchLocalMemorySemantic(query);
  return result.items
    .map((item) => ({
      recordKind: item.type === 'observation' ? 'observation' as const : 'projection' as const,
      projectionId: item.id,
      ...(item.type === 'observation' ? { observationId: item.id } : {}),
      summary: item.summary,
      projectionClass: item.projectionClass,
      observationClass: item.observationClass,
      observationState: item.observationState,
      matchKind: item.matchKind,
      projectId: item.projectId,
      scope: item.scope,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      relevanceScore: item.relevanceScore,
      source: 'local' as const,
      // Local-source hits live in this daemon's own SQLite file, so they are
      // implicitly owned by this server. Stamping the local daemon's bound
      // serverId here keeps the hit shape uniform with cloud results — every
      // hit a consumer sees can be routed (eventually) to the right daemon
      // without per-source-type branching downstream.
      ...(localServerId ? { originServerId: localServerId } : {}),
    }));
}

function listLocalMemorySummaries(
  query: MemoryMcpListSummariesQuery,
  localServerId: string | undefined,
  limit: number,
): MemoryMcpSearchHit[] {
  const requestedProjectId = currentProjectId(query);
  if (!requestedProjectId) return [];
  const namespace = query.namespace
    ? { ...query.namespace, projectId: requestedProjectId }
    : undefined;
  const local = searchLocalMemory({
    namespace,
    currentEnterpriseId: query.currentEnterpriseId,
    repo: requestedProjectId,
    userId: namespace?.userId ?? query.userId,
    includeLegacyPersonalOwner: query.includeLegacyPersonalOwner,
    projectionClass: query.projectionClass ?? 'recent_summary',
    includeObservations: false,
    limit: Math.max(limit * 2, limit),
  });
  return local.items
    .filter((item) => item.type === 'processed')
    .map((item) => ({
      recordKind: 'projection' as const,
      projectionId: item.id,
      summary: item.summary,
      projectionClass: item.projectionClass,
      matchKind: 'exact' as const,
      projectId: item.projectId,
      scope: item.scope,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      relevanceScore: item.relevanceScore,
      source: 'local' as const,
      ...(localServerId ? { originServerId: localServerId } : {}),
    }));
}

function dedupeAndLimit(items: MemoryMcpSearchHit[], limit: number): MemoryMcpSearchHit[] {
  const matchKindRank = { exact: 0, semantic: 1, trigram: 2 } satisfies Record<'exact' | 'semantic' | 'trigram', number>;
  const itemRank = (item: MemoryMcpSearchHit): number => {
    if (item.observationId || item.recordKind === 'observation') return item.observationClass === 'preference' ? 0 : 1;
    if (item.projectionClass === 'durable_memory_candidate') return 2;
    return 3;
  };
  items.sort((a, b) => {
    const aMatch = a.matchKind ? matchKindRank[a.matchKind] : 3;
    const bMatch = b.matchKind ? matchKindRank[b.matchKind] : 3;
    if (aMatch !== bMatch) return aMatch - bMatch;
    const itemDiff = itemRank(a) - itemRank(b);
    if (itemDiff !== 0) return itemDiff;
    if ((b.relevanceScore ?? 0) !== (a.relevanceScore ?? 0)) return (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0);
    return (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0);
  });
  const seen = new Set<string>();
  const out: MemoryMcpSearchHit[] = [];
  for (const item of items) {
    const key = item.projectionId
      ? `id:${item.projectionId}`
      : item.observationId
        ? `observation:${item.observationId}`
      : `summary:${item.projectionClass ?? ''}:${normalizeSummaryForFingerprint(item.summary)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function dedupeSummaryListAndLimit(items: MemoryMcpSearchHit[], limit: number): MemoryMcpSearchHit[] {
  items.sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));
  const seen = new Set<string>();
  const out: MemoryMcpSearchHit[] = [];
  for (const item of items) {
    const key = item.projectionId
      ? `id:${item.projectionId}`
      : `summary:${item.projectionClass ?? ''}:${normalizeSummaryForFingerprint(item.summary)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

export async function searchMcpMemoryRecall(query: MemorySearchQuery, options: MemoryMcpSearchOptions = {}): Promise<MemoryMcpSearchResult> {
  const limit = clampLimit(query.limit);
  // Resolve credentials once so cloud and local paths share the same
  // serverId view of the world. The cloud path consumes workerUrl + token;
  // the local path only needs `serverId` to stamp `originServerId` on hits.
  // If credentials are unavailable (offline / unbound daemon), local hits
  // simply omit `originServerId` — backward-compatible with older clients.
  const credentials = await resolveCredentialsOnce(options).catch(() => null);
  const localServerId = credentials?.serverId && credentials.serverId.trim()
    ? credentials.serverId.trim()
    : undefined;
  const [cloud, local] = await Promise.all([
    credentials
      ? searchCloudMemoryRecall(query, options, credentials).catch(() => [])
      : Promise.resolve([] as MemoryMcpSearchHit[]),
    searchLocalRecall(query, localServerId).catch(() => []),
  ]);
  const items = dedupeAndLimit([...cloud, ...local], limit);
  // Populate the projection-owner LRU. This is what makes
  // `get_memory_sources` skip the cloud projection-owner round trip for
  // any projectionId the agent just received from search_memory. Local
  // hits stamp the local serverId so cache lookups are uniformly
  // populated — keeps the orchestrator's branch decision purely on the
  // map without needing a "did this come from cloud or local" check.
  for (const item of items) {
    if (item.recordKind !== 'observation' && item.projectionId && item.originServerId) {
      projectionOwnerCache.set(item.projectionId, item.originServerId);
    }
  }
  return { items };
}

export async function listMcpMemorySummaries(query: MemoryMcpListSummariesQuery, options: MemoryMcpSearchOptions = {}): Promise<MemoryMcpSearchResult> {
  const limit = clampListLimit(query.limit);
  const credentials = await resolveCredentialsOnce(options).catch(() => null);
  const localServerId = credentials?.serverId && credentials.serverId.trim()
    ? credentials.serverId.trim()
    : undefined;
  const [cloud, local] = await Promise.all([
    credentials
      ? listCloudMemorySummaries(query, options, credentials, limit).catch(() => [])
      : Promise.resolve([] as MemoryMcpSearchHit[]),
    Promise.resolve().then(() => listLocalMemorySummaries(query, localServerId, limit)).catch(() => []),
  ]);
  const items = dedupeSummaryListAndLimit([...cloud, ...local], limit);
  for (const item of items) {
    if (item.recordKind !== 'observation' && item.projectionId && item.originServerId) {
      projectionOwnerCache.set(item.projectionId, item.originServerId);
    }
  }
  return { items };
}
