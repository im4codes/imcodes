import type { ContextModelConfig } from '../../shared/context-types.js';
import {
  normalizeSharedContextRuntimeConfig,
  SHARED_CONTEXT_RUNTIME_BACKENDS,
  SHARED_CONTEXT_RUNTIME_CAPABILITY_PROTOCOL,
} from '../../shared/shared-context-runtime-config.js';
import type { BackendAuthoredContextCredentials } from './backend-authored-context.js';

interface BackendSharedContextRuntimeConfigResponse {
  config?: Partial<ContextModelConfig> | null;
}

export async function fetchBackendSharedContextRuntimeConfig(
  credentials: BackendAuthoredContextCredentials,
): Promise<ContextModelConfig> {
  const response = await fetch(`${credentials.workerUrl}/api/server/${credentials.serverId}/shared-context/runtime-config/daemon`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${credentials.token}`,
      [SHARED_CONTEXT_RUNTIME_CAPABILITY_PROTOCOL.HTTP_BACKENDS_HEADER]: SHARED_CONTEXT_RUNTIME_BACKENDS.join(','),
    },
  });
  if (!response.ok) {
    throw new Error(`backend_shared_context_runtime_config_failed:${response.status}`);
  }
  const body = await response.json() as BackendSharedContextRuntimeConfigResponse;
  return normalizeSharedContextRuntimeConfig(body.config);
}
