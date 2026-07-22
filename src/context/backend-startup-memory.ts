import type { ContextNamespace, ProcessedContextClass } from '../../shared/context-types.js';
import type { MemorySearchResultItem } from './memory-search.js';
import type { BackendAuthoredContextCredentials } from './backend-authored-context.js';

interface BackendStartupMemorySearchResponse {
  sourceSessionExclusionApplied?: boolean;
  results?: Array<{
    id?: string;
    scope?: string;
    class?: string;
    preview?: string;
    projectId?: string;
    updatedAt?: number;
  }>;
}

function cleanBaseUrl(workerUrl: string): string {
  return workerUrl.replace(/\/+$/, '');
}

function isStartupProjectionClass(value: unknown): value is ProcessedContextClass {
  return value === 'durable_memory_candidate' || value === 'recent_summary';
}

export async function fetchBackendStartupMemoryItems(
  credentials: BackendAuthoredContextCredentials,
  namespace: ContextNamespace,
  limit: number,
  options: {
    fetchImpl?: typeof fetch;
    excludeSourceSessionName?: string;
  } = {},
): Promise<MemorySearchResultItem[]> {
  if (!credentials.workerUrl || !credentials.serverId || !credentials.token) return [];
  const projectId = namespace.projectId?.trim();
  if (!projectId) return [];
  const excludeSourceSessionName = options.excludeSourceSessionName?.trim();
  const response = await (options.fetchImpl ?? fetch)(`${cleanBaseUrl(credentials.workerUrl)}/api/shared-context/memory/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credentials.token}`,
      'X-Server-Id': credentials.serverId,
    },
    body: JSON.stringify({
      query: '',
      scope: namespace.scope,
      projectId,
      limit,
      ...(excludeSourceSessionName ? { excludeSourceSessionName } : {}),
    }),
  });
  if (!response.ok) return [];
  const body = await response.json().catch(() => null) as BackendStartupMemorySearchResponse | null;
  if (!Array.isArray(body?.results)) return [];
  // During a rolling daemon/server upgrade an older server may ignore the new
  // exclusion field. Fail closed instead of re-injecting this conversation's
  // own summaries as if they came from another session.
  if (excludeSourceSessionName && body.sourceSessionExclusionApplied !== true) return [];
  return body.results
    .filter((item): item is Required<Pick<NonNullable<BackendStartupMemorySearchResponse['results']>[number], 'id' | 'preview' | 'class'>> & NonNullable<BackendStartupMemorySearchResponse['results']>[number] => (
      typeof item?.id === 'string'
      && item.id.trim().length > 0
      && typeof item.preview === 'string'
      && item.preview.trim().length > 0
      && isStartupProjectionClass(item.class)
    ))
    .filter((item) => item.projectId === projectId)
    .filter((item) => item.scope === namespace.scope)
    .map((item) => {
      const projectionClass = item.class as ProcessedContextClass;
      return {
        type: 'processed' as const,
        id: item.id,
        projectId: item.projectId ?? projectId,
        scope: item.scope ?? namespace.scope,
        ...(namespace.enterpriseId ? { enterpriseId: namespace.enterpriseId } : {}),
        ...(namespace.workspaceId ? { workspaceId: namespace.workspaceId } : {}),
        ...(namespace.userId ? { userId: namespace.userId } : {}),
        projectionClass,
        summary: item.preview,
        createdAt: item.updatedAt ?? 0,
        ...(typeof item.updatedAt === 'number' ? { updatedAt: item.updatedAt } : {}),
      };
    });
}
