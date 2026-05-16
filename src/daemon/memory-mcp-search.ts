import type { ProcessedContextClass } from '../../shared/context-types.js';
import { normalizeSummaryForFingerprint } from '../../shared/memory-fingerprint.js';
import { searchLocalMemorySemantic, type MemorySearchQuery } from '../context/memory-search.js';

export interface MemoryMcpSearchHit {
  projectionId: string;
  summary: string;
  projectionClass?: ProcessedContextClass | string;
  projectId?: string;
  scope?: string;
  createdAt?: number;
  updatedAt?: number;
  relevanceScore?: number;
  source?: 'cloud' | 'local';
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
    source?: 'personal' | 'enterprise';
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

async function searchCloudMemoryRecall(query: MemorySearchQuery, options: MemoryMcpSearchOptions): Promise<MemoryMcpSearchHit[]> {
  const credentials = options.credentials !== undefined
    ? options.credentials
    : await (options.loadCredentials ?? defaultLoadCredentials)();
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
      projectId: item.projectId,
      updatedAt: item.updatedAt,
      relevanceScore: item.score,
      scope: item.source === 'enterprise' ? 'project_shared' : 'personal',
      source: 'cloud' as const,
    }));
}

async function searchLocalRecall(query: MemorySearchQuery): Promise<MemoryMcpSearchHit[]> {
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
  const [cloud, local] = await Promise.all([
    searchCloudMemoryRecall(query, options).catch(() => []),
    searchLocalRecall(query).catch(() => []),
  ]);
  return {
    items: dedupeAndLimit([...cloud, ...local], limit),
  };
}
