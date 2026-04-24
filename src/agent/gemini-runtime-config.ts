/**
 * gemini-runtime-config — discover available Gemini models via the
 * already-connected GeminiSdkProvider (ACP `newSession` response).
 *
 * Called by command-handler.ts for `transport.list_models { agentType: 'gemini-sdk' }`.
 */

const CACHE_TTL_MS = 30_000;

export interface GeminiModelInfo {
  id: string;
  name?: string;
}

export interface GeminiRuntimeConfig {
  models: GeminiModelInfo[];
  defaultModel?: string;
  isAuthenticated?: boolean;
  probeError?: string;
}

let cache: { expiresAt: number; value: GeminiRuntimeConfig } | null = null;

export async function getGeminiRuntimeConfig(force = false): Promise<GeminiRuntimeConfig> {
  const now = Date.now();
  if (!force && cache && cache.expiresAt > now) return cache.value;

  try {
    const { getProvider } = await import('./provider-registry.js');
    const provider = getProvider('gemini-sdk');
    if (!provider) {
      const value: GeminiRuntimeConfig = { models: [], isAuthenticated: false };
      cache = { expiresAt: now + CACHE_TTL_MS, value };
      return value;
    }
    const asGemini = provider as unknown as {
      readModelList?: () => Promise<{ models: Array<{ id: string; name?: string }>; defaultModel?: string }>;
    };
    if (typeof asGemini.readModelList !== 'function') {
      const value: GeminiRuntimeConfig = { models: [], isAuthenticated: false };
      cache = { expiresAt: now + CACHE_TTL_MS, value };
      return value;
    }
    const { models, defaultModel } = await asGemini.readModelList();
    const value: GeminiRuntimeConfig = {
      models,
      ...(defaultModel ? { defaultModel } : {}),
      isAuthenticated: models.length > 0,
    };
    cache = { expiresAt: now + CACHE_TTL_MS, value };
    return value;
  } catch (err) {
    const probeError = err instanceof Error ? err.message : String(err);
    const value: GeminiRuntimeConfig = { models: [], probeError };
    cache = { expiresAt: now + CACHE_TTL_MS, value };
    return value;
  }
}
