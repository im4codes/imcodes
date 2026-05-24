import type { ProcessedContextClass } from '../../shared/context-types.js';
import { normalizeSummaryForFingerprint } from '../../shared/memory-fingerprint.js';
import { searchLocalMemorySemantic, type MemorySearchQuery } from '../context/memory-search.js';
import { projectionOwnerCache } from './memory-projection-owner-cache.js';

export interface MemoryMcpSearchHit {
  projectionId: string;
  summary: string;
  projectionClass?: ProcessedContextClass | string;
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

function cloudRecallUrl(workerUrl: string, serverId: string): string {
  return `${cleanBaseUrl(workerUrl)}/api/shared-context/${encodeURIComponent(serverId)}/shared-context/memory/recall`;
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

async function searchLocalRecall(
  query: MemorySearchQuery,
  localServerId: string | undefined,
): Promise<MemoryMcpSearchHit[]> {
  const result = await searchLocalMemorySemantic(query);
  return result.items
    .filter((item) => item.type === 'processed')
    .map((item) => ({
      projectionId: item.id,
      summary: item.summary,
      projectionClass: item.projectionClass,
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

function dedupeAndLimit(items: MemoryMcpSearchHit[], limit: number): MemoryMcpSearchHit[] {
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
    if (item.projectionId && item.originServerId) {
      projectionOwnerCache.set(item.projectionId, item.originServerId);
    }
  }
  return { items };
}
