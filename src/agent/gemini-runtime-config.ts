/**
 * gemini-runtime-config — thin shim that forwards to GeminiSdkProvider.listModels().
 * Kept as a separate file so command-handler.ts can import it lazily via
 * dynamic import (same pattern as other runtime-config files).
 */
import type { ProviderModelList } from '../agent/transport-provider.js';

export type { ProviderModelList as GeminiRuntimeConfig };

export async function getGeminiRuntimeConfig(force = false): Promise<ProviderModelList> {
  const { getProvider } = await import('./provider-registry.js');
  const provider = getProvider('gemini-sdk');
  if (!provider || typeof (provider as unknown as { listModels?: unknown }).listModels !== 'function') {
    return { models: [], isAuthenticated: false };
  }
  return (provider as unknown as { listModels: (f: boolean) => Promise<ProviderModelList> }).listModels(force);
}
