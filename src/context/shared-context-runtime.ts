import type { ContextNamespace, RuntimeAuthoredContextBinding } from '../../shared/context-types.js';
import {
  fetchBackendManagedAuthoredContext,
  type BackendAuthoredContextCredentials,
} from './backend-authored-context.js';

let runtimeCredentials: BackendAuthoredContextCredentials | null = null;

export function configureSharedContextRuntime(
  credentials: BackendAuthoredContextCredentials | null,
): void {
  runtimeCredentials = credentials;
}

export function getSharedContextRuntimeCredentials(): BackendAuthoredContextCredentials | null {
  return runtimeCredentials;
}

export async function resolveRuntimeAuthoredContext(
  namespace: ContextNamespace,
  options?: {
    language?: string;
    filePath?: string;
  },
): Promise<RuntimeAuthoredContextBinding[]> {
  const credentials = runtimeCredentials;
  if (!credentials) return [];
  return fetchBackendManagedAuthoredContext(credentials, {
    namespace,
    language: options?.language,
    filePath: options?.filePath,
  });
}
