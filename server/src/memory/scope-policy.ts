import type { Context } from 'hono';
import type { Env } from '../env.js';
import type { RuntimeAuthoredContextBinding } from '../../../shared/context-types.js';
import {
  AUTHORED_CONTEXT_SCOPES,
  expandSearchRequestScope as expandSharedSearchRequestScope,
  isAuthoredContextScope as isSharedAuthoredContextScope,
  isMemoryScope,
  isSharedContextProjectionScope,
  SYNCED_PROJECTION_MEMORY_SCOPES,
  type AuthoredContextScope,
  type MemoryScope,
  type SearchRequestScope,
  type SharedContextProjectionScope,
} from '../../../shared/memory-scope.js';
import {
  getMemoryFeatureFlagDefinition,
  MEMORY_FEATURE_FLAGS_BY_NAME,
  type MemoryFeatureFlag,
} from '../../../shared/feature-flags.js';
export type { AuthoredContextScope, MemoryScope, SearchRequestScope } from '../../../shared/memory-scope.js';

export type OwnerPrivateMemoryScope = 'user_private';
export type SharedProjectionScope = SharedContextProjectionScope;

export const MEMORY_FEATURES = {
  quickSearch: MEMORY_FEATURE_FLAGS_BY_NAME.quickSearch,
  citation: MEMORY_FEATURE_FLAGS_BY_NAME.citation,
  citeCount: MEMORY_FEATURE_FLAGS_BY_NAME.citeCount,
  citeDriftBadge: MEMORY_FEATURE_FLAGS_BY_NAME.citeDriftBadge,
  userPrivateSync: MEMORY_FEATURE_FLAGS_BY_NAME.userPrivateSync,
  orgSharedAuthoredStandards: MEMORY_FEATURE_FLAGS_BY_NAME.orgSharedAuthoredStandards,
} as const;

export const SHARED_PROJECTION_SCOPES: readonly SharedProjectionScope[] = SYNCED_PROJECTION_MEMORY_SCOPES;
export { AUTHORED_CONTEXT_SCOPES };

export function isSearchRequestScope(value: unknown): value is SearchRequestScope {
  return value === 'owner_private' || value === 'shared' || value === 'all_authorized' || isMemoryScope(value);
}

export function isSharedProjectionScope(value: unknown): value is SharedProjectionScope {
  return isSharedContextProjectionScope(value);
}

export function isAuthoredContextScope(value: unknown): value is AuthoredContextScope {
  return isSharedAuthoredContextScope(value);
}

export function authoredContextScopeForBinding(input: {
  workspaceId?: string | null;
  enrollmentId?: string | null;
}): AuthoredContextScope {
  if (input.enrollmentId) return 'project_shared';
  if (input.workspaceId) return 'workspace_shared';
  return 'org_shared';
}

export function expandSearchRequestScope(
  requested: SearchRequestScope | undefined,
  options: { includeOwnerPrivate: boolean },
): MemoryScope[] {
  const scopes = expandSharedSearchRequestScope(requested ?? 'all_authorized');
  return scopes.filter((scope) => scope !== 'user_private' || options.includeOwnerPrivate);
}

export function sameShapeMemoryLookupEnvelope(): {
  ok: false;
  result: null;
  citation: null;
  error: 'not_found';
} {
  return { ok: false, result: null, citation: null, error: 'not_found' };
}

export function sameShapeSearchEnvelope(): { results: []; nextCursor: null } {
  return { results: [], nextCursor: null };
}

type Feature = MemoryFeatureFlag;

function envKeyForFeature(feature: Feature): string {
  return `IMCODES_${feature.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

export function isMemoryFeatureEnabled(env: Env | undefined, feature: Feature): boolean {
  const key = envKeyForFeature(feature);
  const raw = (env as unknown as Record<string, string | undefined> | undefined)?.[key] ?? process.env[key];
  if (raw != null) return raw === 'true' || raw === '1';
  return getMemoryFeatureFlagDefinition(feature).defaultValue;
}

export async function jsonSameShapeNotFound(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  return c.json(sameShapeMemoryLookupEnvelope(), 404);
}

export function matchesAuthoredContextPathPattern(pattern: string, filePath: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, '/');
  const normalizedPath = filePath.replace(/\\/g, '/');
  if (normalizedPattern.endsWith('/**')) {
    return normalizedPath.startsWith(normalizedPattern.slice(0, -3));
  }
  if (normalizedPattern.includes('*')) {
    const escaped = normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(normalizedPath);
  }
  return normalizedPattern === normalizedPath;
}

export function compareRuntimeAuthoredContextBindings(
  a: Pick<RuntimeAuthoredContextBinding, 'scope' | 'mode' | 'bindingId'>,
  b: Pick<RuntimeAuthoredContextBinding, 'scope' | 'mode' | 'bindingId'>,
): number {
  const rank: Record<RuntimeAuthoredContextBinding['scope'], number> = {
    project_shared: 1,
    workspace_shared: 2,
    org_shared: 3,
  };
  if (rank[a.scope] !== rank[b.scope]) return rank[a.scope] - rank[b.scope];
  if (a.mode !== b.mode) return a.mode === 'required' ? -1 : 1;
  return a.bindingId.localeCompare(b.bindingId);
}
