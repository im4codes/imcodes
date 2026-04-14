import type { ContextNamespace, RuntimeAuthoredContextBinding } from '../../shared/context-types.js';

export interface BackendAuthoredContextCredentials {
  workerUrl: string;
  serverId: string;
  token: string;
}

export interface BackendAuthoredContextQuery {
  namespace: ContextNamespace;
  language?: string;
  filePath?: string;
}

interface BackendAuthoredContextResponse {
  bindings: RuntimeAuthoredContextBinding[];
}

export async function fetchBackendManagedAuthoredContext(
  credentials: BackendAuthoredContextCredentials,
  query: BackendAuthoredContextQuery,
): Promise<RuntimeAuthoredContextBinding[]> {
  if (query.namespace.scope === 'personal' || !query.namespace.enterpriseId) return [];

  const response = await fetch(`${credentials.workerUrl}/api/server/${credentials.serverId}/shared-context/authored-bindings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credentials.token}`,
    },
    body: JSON.stringify({
      namespace: query.namespace,
      language: query.language,
      filePath: query.filePath,
    }),
  });
  if (!response.ok) {
    throw new Error(`backend_authored_context_fetch_failed:${response.status}`);
  }
  const body = await response.json() as BackendAuthoredContextResponse;
  return Array.isArray(body.bindings) ? body.bindings : [];
}
