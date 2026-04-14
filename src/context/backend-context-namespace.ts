import type { SharedContextNamespaceResolution } from '../../shared/context-types.js';
import type { BackendAuthoredContextCredentials } from './backend-authored-context.js';

type BackendNamespaceResolutionResponse = SharedContextNamespaceResolution;

export async function fetchBackendSharedContextNamespace(
  credentials: BackendAuthoredContextCredentials,
  canonicalRepoId: string,
): Promise<SharedContextNamespaceResolution | null> {
  const response = await fetch(`${credentials.workerUrl}/api/server/${credentials.serverId}/shared-context/resolve-namespace`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credentials.token}`,
    },
    body: JSON.stringify({ canonicalRepoId }),
  });
  if (!response.ok) {
    throw new Error(`backend_context_namespace_resolution_failed:${response.status}`);
  }
  const body = await response.json() as Partial<BackendNamespaceResolutionResponse>;
  if (!body || typeof body.canonicalRepoId !== 'string') return null;
  return {
    namespace: body.namespace ?? null,
    canonicalRepoId: body.canonicalRepoId,
    visibilityState: body.visibilityState ?? 'unenrolled',
    remoteProcessedFreshness: body.remoteProcessedFreshness ?? 'missing',
    retryExhausted: body.retryExhausted ?? true,
    sharedPolicyOverride: body.sharedPolicyOverride,
    diagnostics: Array.isArray(body.diagnostics) ? body.diagnostics : [],
  };
}
