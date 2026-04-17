import type {
  ContextFreshness,
  ContextNamespace,
  SharedScopePolicyOverride,
  TransportMemoryRecallArtifact,
  TransportMemoryRecallItem,
} from '../../shared/context-types.js';
import { GitOriginRepositoryIdentityService } from './repository-identity-service.js';
import { detectRepo } from '../repo/detector.js';
import { fetchBackendSharedContextNamespace } from '../context/backend-context-namespace.js';
import { getSharedContextRuntimeCredentials } from '../context/shared-context-runtime.js';
import type { MemorySearchResultItem } from '../context/memory-search.js';
import { STARTUP_MEMORY_TOTAL_LIMIT, selectStartupMemoryItems } from '../context/startup-memory.js';
import { getLocalProcessedFreshness } from '../store/context-store.js';
import { buildStartupProjectMemoryText } from '../../shared/memory-recall-format.js';

export interface TransportContextBootstrapInput {
  projectDir?: string;
  transportConfig?: Record<string, unknown> | null;
}

export interface TransportContextBootstrap {
  namespace: ContextNamespace;
  diagnostics: string[];
  remoteProcessedFreshness?: ContextFreshness;
  localProcessedFreshness?: ContextFreshness;
  retryExhausted?: boolean;
  sharedPolicyOverride?: SharedScopePolicyOverride;
  startupMemory?: TransportMemoryRecallArtifact;
}

const repositoryIdentityService = new GitOriginRepositoryIdentityService();

export async function resolveTransportContextBootstrap(
  input: TransportContextBootstrapInput,
): Promise<TransportContextBootstrap> {
  const explicitNamespace = parseExplicitContextNamespace(input.transportConfig);
  if (explicitNamespace) {
    return {
      namespace: explicitNamespace,
      diagnostics: ['namespace:explicit'],
      localProcessedFreshness: getLocalProcessedFreshness(explicitNamespace),
    };
  }

  const projectDir = input.projectDir?.trim();
  let originUrl: string | null | undefined;
  if (projectDir) {
    try {
      const repo = await detectRepo(projectDir);
      originUrl = repo.info?.remoteUrl ?? null;
    } catch {
      originUrl = null;
    }
  }
  const canonical = repositoryIdentityService.resolve({
    cwd: projectDir,
    originUrl,
  });
  if (canonical.kind === 'git-origin') {
    const credentials = getSharedContextRuntimeCredentials();
    if (credentials) {
      try {
        const resolved = await fetchBackendSharedContextNamespace(credentials, canonical.key);
        if (resolved?.namespace) {
          const namespace = resolved.namespace;
          return {
            namespace,
            diagnostics: ['namespace:server-control-plane', ...resolved.diagnostics],
            remoteProcessedFreshness: resolved.remoteProcessedFreshness,
            localProcessedFreshness: getLocalProcessedFreshness(namespace),
            retryExhausted: resolved.retryExhausted,
            sharedPolicyOverride: resolved.sharedPolicyOverride,
          };
        }
        const personalNamespace: ContextNamespace = {
          scope: 'personal',
          projectId: canonical.key,
        };
        return {
          namespace: personalNamespace,
          diagnostics: ['namespace:server-personal-fallback', ...(resolved?.diagnostics ?? [])],
          remoteProcessedFreshness: resolved?.remoteProcessedFreshness,
          localProcessedFreshness: getLocalProcessedFreshness(personalNamespace),
          retryExhausted: resolved?.retryExhausted,
        };
      } catch {
        const personalNamespace: ContextNamespace = {
          scope: 'personal',
          projectId: canonical.key,
        };
        return {
          namespace: personalNamespace,
          diagnostics: ['namespace:server-resolution-failed', 'namespace:git-origin'],
          localProcessedFreshness: getLocalProcessedFreshness(personalNamespace),
        };
      }
    }
  }

  const fallbackNamespace: ContextNamespace = {
    scope: 'personal',
    projectId: canonical.key,
  };
  return {
    namespace: fallbackNamespace,
    diagnostics: [`namespace:${canonical.kind}`],
    localProcessedFreshness: getLocalProcessedFreshness(fallbackNamespace),
  };
}

export function buildTransportStartupMemory(
  namespace: ContextNamespace,
  limit = STARTUP_MEMORY_TOTAL_LIMIT,
): TransportMemoryRecallArtifact | undefined {
  try {
    const items = selectStartupMemoryItems(namespace, { totalLimit: limit })
      .map(toTransportMemoryRecallItem);
    if (items.length === 0) return undefined;
    return {
      reason: 'startup',
      runtimeFamily: 'transport',
      authoritySource: 'processed_local',
      sourceKind: 'local_processed',
      injectionSurface: 'system-text',
      items,
      injectedText: renderStartupMemoryText(items),
    };
  } catch {
    return undefined;
  }
}

function toTransportMemoryRecallItem(item: MemorySearchResultItem): TransportMemoryRecallItem {
  return {
    id: item.id,
    type: 'processed',
    projectId: item.projectId,
    scope: item.scope,
    ...(item.enterpriseId ? { enterpriseId: item.enterpriseId } : {}),
    ...(item.workspaceId ? { workspaceId: item.workspaceId } : {}),
    ...(item.userId ? { userId: item.userId } : {}),
    summary: item.summary,
    ...(item.projectionClass ? { projectionClass: item.projectionClass } : {}),
    ...(typeof item.hitCount === 'number' ? { hitCount: item.hitCount } : {}),
    ...(typeof item.lastUsedAt === 'number' ? { lastUsedAt: item.lastUsedAt } : {}),
    ...(item.status ? { status: item.status } : {}),
    ...(typeof item.relevanceScore === 'number' ? { relevanceScore: item.relevanceScore } : {}),
    ...(typeof item.createdAt === 'number' ? { createdAt: item.createdAt } : {}),
    ...(typeof item.updatedAt === 'number' ? { updatedAt: item.updatedAt } : {}),
  };
}

function renderStartupMemoryText(items: TransportMemoryRecallItem[]): string {
  return buildStartupProjectMemoryText(items);
}

function parseExplicitContextNamespace(
  transportConfig?: Record<string, unknown> | null,
): ContextNamespace | undefined {
  const candidate = extractNamespaceCandidate(transportConfig);
  if (!candidate || typeof candidate !== 'object') return undefined;
  const scope = typeof candidate.scope === 'string' ? candidate.scope : undefined;
  const projectId = typeof candidate.projectId === 'string' ? candidate.projectId.trim() : '';
  if (!isContextScope(scope) || !projectId) return undefined;
  return {
    scope,
    projectId,
    ...(typeof candidate.userId === 'string' && candidate.userId.trim() ? { userId: candidate.userId.trim() } : {}),
    ...(typeof candidate.workspaceId === 'string' && candidate.workspaceId.trim() ? { workspaceId: candidate.workspaceId.trim() } : {}),
    ...(typeof candidate.enterpriseId === 'string' && candidate.enterpriseId.trim() ? { enterpriseId: candidate.enterpriseId.trim() } : {}),
  };
}

function extractNamespaceCandidate(
  transportConfig?: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  if (!transportConfig) return undefined;
  const direct = transportConfig.sharedContextNamespace;
  if (direct && typeof direct === 'object') return direct as Record<string, unknown>;
  const sharedContext = transportConfig.sharedContext;
  if (sharedContext && typeof sharedContext === 'object') {
    const nested = (sharedContext as Record<string, unknown>).namespace;
    if (nested && typeof nested === 'object') return nested as Record<string, unknown>;
  }
  return undefined;
}

function isContextScope(value: string | undefined): value is ContextNamespace['scope'] {
  return value === 'personal'
    || value === 'project_shared'
    || value === 'workspace_shared'
    || value === 'org_shared';
}
