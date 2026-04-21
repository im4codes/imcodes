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

// ── Singleton CopilotClient ──────────────────────────────────────────────────
//
// The `@github/copilot-sdk` CopilotClient owns a `copilot --headless` node
// subprocess (~160MB RSS). Earlier revisions called `new CopilotClient() →
// start() → stop()` on every probe, but `stop()` does not reliably reap the
// headless child — the daemon observed 13+ leaked copilot procs in 2 minutes,
// burning ~2GB. So we maintain ONE client for the daemon's lifetime and
// simply re-invoke `getStatus`/`listModels`/`getAuthStatus` against it.
//
// `clientPromise` also doubles as a concurrent-call dedupe: multiple probes
// racing through the cache-miss branch await the same init, instead of each
// spawning its own subprocess.

let clientPromise: Promise<unknown> | null = null;
let inFlightProbe: Promise<CopilotRuntimeConfig> | null = null;

async function getCopilotClient(): Promise<unknown> {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const sdk = await import('@github/copilot-sdk');
    const client = new sdk.CopilotClient({ autoStart: false });
    await client.start();
    return client;
  })().catch((err) => {
    // On start failure, tear down the promise so the next call retries —
    // otherwise every future call would resolve to the same failed promise.
    clientPromise = null;
    throw err;
  });
  return clientPromise;
}

async function probeCopilotSdk(): Promise<CopilotRuntimeConfig> {
  try {
    const client = await getCopilotClient() as any;
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
  }
}

/** Fetch the current Copilot runtime config (available models + auth state).
 *  Cached for {@link CACHE_TTL_MS} unless `force` is true. Never throws.
 *  Concurrent callers share a single in-flight probe so we never spawn more
 *  than one CopilotClient (see `clientPromise` comment). */
export async function getCopilotRuntimeConfig(force = false): Promise<CopilotRuntimeConfig> {
  const now = Date.now();
  if (!force && cached && cached.expiresAt > now) return cached.value;
  if (inFlightProbe) return inFlightProbe;
  inFlightProbe = (async () => {
    try {
      const value = await probeCopilotSdk();
      cached = { expiresAt: Date.now() + CACHE_TTL_MS, value };
      return value;
    } finally {
      inFlightProbe = null;
    }
  })();
  return inFlightProbe;
}

export const COPILOT_FALLBACK_MODEL_IDS = FALLBACK_COPILOT_MODEL_IDS;

/** Exposed for tests. */
export const __copilotRuntimeConfigInternals = {
  clearCache: () => {
    cached = null;
    inFlightProbe = null;
    clientPromise = null;
  },
};
