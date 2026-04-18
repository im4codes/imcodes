import logger from '../util/logger.js';

const CACHE_TTL_MS = 60_000;

export interface CopilotModelInfo {
  id: string;
  name?: string;
  supportsReasoningEffort?: boolean;
}

export interface CopilotRuntimeConfig {
  /** Ordered list of model ids reported by the Copilot SDK's `listModels()`. */
  availableModels: string[];
  /** Full metadata for each model, useful when the UI wants labels or capability hints. */
  models: CopilotModelInfo[];
  /** True when `getAuthStatus()` reported authenticated. */
  isAuthenticated: boolean;
  /** Resolved Copilot CLI version string, if the probe succeeded. */
  cliVersion?: string;
  /** Probe error message when the SDK couldn't start — surfaced for diagnostics. */
  probeError?: string;
}

let cached: { expiresAt: number; value: CopilotRuntimeConfig } | null = null;

/** Best-known Copilot model IDs used as a fallback when the SDK probe fails.
 *  Keep in sync with the official Copilot CLI docs — these are only used when
 *  we truly can't reach the SDK, so offline devs still have a working list. */
const FALLBACK_COPILOT_MODEL_IDS = [
  'gpt-5',
  'gpt-5-mini',
  'claude-sonnet-4.5',
  'claude-opus-4.5',
];

async function probeCopilotSdk(): Promise<CopilotRuntimeConfig> {
  let client: any = null;
  try {
    const sdk = await import('@github/copilot-sdk');
    // Intentionally do NOT pass cliPath — let the SDK use its bundled CLI.
    client = new sdk.CopilotClient({ autoStart: false });
    await client.start();
    let cliVersion: string | undefined;
    try {
      const status = await client.getStatus();
      if (status && typeof status.version === 'string') cliVersion = status.version;
    } catch (err) {
      logger.debug({ err }, 'Copilot getStatus probe failed');
    }
    let isAuthenticated = false;
    try {
      const auth = await client.getAuthStatus();
      isAuthenticated = !!auth?.isAuthenticated;
    } catch (err) {
      logger.debug({ err }, 'Copilot getAuthStatus probe failed');
    }
    const models: CopilotModelInfo[] = [];
    try {
      const raw = await client.listModels();
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          if (!entry || typeof entry.id !== 'string') continue;
          models.push({
            id: entry.id,
            ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
            ...(entry.capabilities?.supports?.reasoningEffort === true
              ? { supportsReasoningEffort: true }
              : {}),
          });
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Copilot listModels probe failed — falling back to defaults');
    }
    const availableModels = models.length > 0
      ? [...new Set(models.map((m) => m.id))]
      : [...FALLBACK_COPILOT_MODEL_IDS];
    return {
      availableModels,
      models: models.length > 0 ? models : availableModels.map((id) => ({ id })),
      isAuthenticated,
      ...(cliVersion ? { cliVersion } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, 'Copilot SDK probe failed — returning fallback config');
    return {
      availableModels: [...FALLBACK_COPILOT_MODEL_IDS],
      models: FALLBACK_COPILOT_MODEL_IDS.map((id) => ({ id })),
      isAuthenticated: false,
      probeError: message,
    };
  } finally {
    if (client) {
      try { await client.stop(); } catch { /* best-effort */ }
    }
  }
}

/** Fetch the current Copilot runtime config (available models + auth state).
 *  Cached for {@link CACHE_TTL_MS} unless `force` is true. Never throws. */
export async function getCopilotRuntimeConfig(force = false): Promise<CopilotRuntimeConfig> {
  const now = Date.now();
  if (!force && cached && cached.expiresAt > now) return cached.value;
  const value = await probeCopilotSdk();
  cached = { expiresAt: now + CACHE_TTL_MS, value };
  return value;
}

export const COPILOT_FALLBACK_MODEL_IDS = FALLBACK_COPILOT_MODEL_IDS;

/** Exposed for tests. */
export const __copilotRuntimeConfigInternals = {
  clearCache: () => {
    cached = null;
  },
};
