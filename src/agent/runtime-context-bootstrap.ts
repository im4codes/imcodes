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
import {
  STARTUP_MEMORY_TOTAL_LIMIT,
  selectStartupMemoryByPolicy,
  selectStartupMemoryItems,
  type StartupMemoryCandidate,
} from '../context/startup-memory.js';
import { collectSkillStartupCandidates } from '../context/skill-startup-context.js';
import { getLocalProcessedFreshness } from '../store/context-store.js';
import {
  STARTUP_PROJECT_MEMORY_HEADER,
  STARTUP_SKILL_INDEX_HEADER,
  buildStartupProjectMemoryText,
  formatRelatedPastWorkSummary,
} from '../../shared/memory-recall-format.js';
import { isMemoryScope } from '../../shared/memory-scope.js';

export interface TransportContextBootstrapInput {
  projectDir?: string;
  transportConfig?: Record<string, unknown> | null;
  /** When true, skip the expensive startup-memory build step entirely. */
  startupMemoryAlreadyInjected?: boolean;
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
  const projectDir = input.projectDir?.trim();
  const explicitNamespace = parseExplicitContextNamespace(input.transportConfig);
  if (explicitNamespace) {
    return buildBootstrapResult(explicitNamespace, {
      diagnostics: ['namespace:explicit'],
    }, input.startupMemoryAlreadyInjected, projectDir);
  }

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
          return buildBootstrapResult(namespace, {
            diagnostics: ['namespace:server-control-plane', ...resolved.diagnostics],
            remoteProcessedFreshness: resolved.remoteProcessedFreshness,
            retryExhausted: resolved.retryExhausted,
            sharedPolicyOverride: resolved.sharedPolicyOverride,
          }, input.startupMemoryAlreadyInjected, projectDir);
        }
        const personalNamespace: ContextNamespace = {
          scope: 'personal',
          projectId: canonical.key,
        };
        return buildBootstrapResult(personalNamespace, {
          diagnostics: ['namespace:server-personal-fallback', ...(resolved?.diagnostics ?? [])],
          remoteProcessedFreshness: resolved?.remoteProcessedFreshness,
          retryExhausted: resolved?.retryExhausted,
        }, input.startupMemoryAlreadyInjected, projectDir);
      } catch {
        const personalNamespace: ContextNamespace = {
          scope: 'personal',
          projectId: canonical.key,
        };
        return buildBootstrapResult(personalNamespace, {
          diagnostics: ['namespace:server-resolution-failed', 'namespace:git-origin'],
        }, input.startupMemoryAlreadyInjected, projectDir);
      }
    }
  }

  const fallbackNamespace: ContextNamespace = {
    scope: 'personal',
    projectId: canonical.key,
  };
  return buildBootstrapResult(fallbackNamespace, {
    diagnostics: [`namespace:${canonical.kind}`],
  }, input.startupMemoryAlreadyInjected, projectDir);
}

function buildBootstrapResult(
  namespace: ContextNamespace,
  extras: Omit<TransportContextBootstrap, 'namespace' | 'localProcessedFreshness' | 'startupMemory'>,
  skipStartupMemory = false,
  projectDir?: string,
): TransportContextBootstrap {
  return {
    namespace,
    ...extras,
    localProcessedFreshness: getLocalProcessedFreshness(namespace),
    startupMemory: skipStartupMemory ? undefined : buildTransportStartupMemory(namespace, {
      projectDir,
    }),
  };
}

export function buildTransportStartupMemory(
  namespace: ContextNamespace,
  limitOrOptions: number | { limit?: number; projectDir?: string; homeDir?: string } = STARTUP_MEMORY_TOTAL_LIMIT,
): TransportMemoryRecallArtifact | undefined {
  try {
    const options = typeof limitOrOptions === 'number'
      ? { limit: limitOrOptions }
      : limitOrOptions;
    const limit = options.limit ?? STARTUP_MEMORY_TOTAL_LIMIT;
    const processedItems = selectStartupMemoryItems(namespace, { totalLimit: limit });
    const processedById = new Map(processedItems.map((item) => [item.id, item]));
    const skillCandidates = collectSkillStartupCandidates({
      namespace,
      projectDir: options.projectDir,
      homeDir: options.homeDir,
    });
    const selected = selectStartupMemoryByPolicy([
      ...processedItems.map(memorySearchItemToStartupCandidate),
      ...skillCandidates,
    ]);
    const items = selected.selected.map((candidate) => {
      const processed = processedById.get(candidate.id);
      return processed
        ? toTransportMemoryRecallItem(processed)
        : startupCandidateToTransportMemoryRecallItem(candidate, namespace);
    });
    if (items.length === 0 || selected.selected.length === 0) return undefined;
    return {
      reason: 'startup',
      runtimeFamily: 'transport',
      authoritySource: 'processed_local',
      sourceKind: 'local_processed',
      injectionSurface: 'system-text',
      items,
      injectedText: renderStartupMemoryText(selected.selected, processedById),
    };
  } catch {
    return undefined;
  }
}

function memorySearchItemToStartupCandidate(item: MemorySearchResultItem): StartupMemoryCandidate {
  return {
    id: item.id,
    source: item.projectionClass === 'durable_memory_candidate' ? 'durable' : 'recent',
    text: item.summary,
    updatedAt: item.updatedAt ?? item.createdAt,
    fingerprint: `${item.projectionClass ?? 'recent_summary'}\u0000${item.summary}`,
  };
}

function startupCandidateToTransportMemoryRecallItem(
  candidate: StartupMemoryCandidate,
  namespace: ContextNamespace,
): TransportMemoryRecallItem {
  return {
    id: candidate.id,
    type: 'processed',
    projectId: namespace.projectId ?? namespace.userId ?? namespace.enterpriseId ?? 'memory',
    scope: namespace.scope,
    ...(namespace.enterpriseId ? { enterpriseId: namespace.enterpriseId } : {}),
    ...(namespace.workspaceId ? { workspaceId: namespace.workspaceId } : {}),
    ...(namespace.userId ? { userId: namespace.userId } : {}),
    summary: candidate.text,
    ...(typeof candidate.updatedAt === 'number' ? { updatedAt: candidate.updatedAt } : {}),
  };
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

function renderStartupMemoryText(
  selected: readonly StartupMemoryCandidate[],
  processedById: ReadonlyMap<string, MemorySearchResultItem>,
): string {
  const memoryItems = selected
    .map((candidate) => processedById.get(candidate.id))
    .filter((item): item is MemorySearchResultItem => !!item)
    .map(toTransportMemoryRecallItem);
  const sections: string[] = [];
  if (memoryItems.length > 0) {
    sections.push(buildStartupProjectMemoryText(memoryItems));
  }
  const skillBlocks = selected.filter((candidate) => candidate.source === 'skill');
  if (skillBlocks.length > 0) {
    sections.push([
      STARTUP_SKILL_INDEX_HEADER,
      '<startup-skills-index advisory="true">',
      'Read a listed skill file only when it is relevant to the current task; do not treat this index as the skill body.',
      ...skillBlocks.map((candidate) => [
        `- [skill] ${formatRelatedPastWorkSummary(candidate.id, 120)}`,
        candidate.text,
      ].join('\n')),
      '</startup-skills-index>',
    ].join('\n'));
  }
  return sections.join('\n\n');
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
  return isMemoryScope(value);
}
