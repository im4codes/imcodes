import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CopilotClientOptions, Model } from '@microsoft/copilot-sdk';
import { normalizeSupportedEffortLevels, type TransportEffortLevel } from '../../shared/effort-levels.js';
import logger from '../util/logger.js';

export const COPILOT_CLI_PATH_ENV = 'COPILOT_CLI_PATH';

const CACHE_TTL_MS = 60_000;

function pathModuleFor(platform: NodeJS.Platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function selectExplicitCandidate(
  configBinaryPath: unknown,
  env: NodeJS.ProcessEnv,
): { source: 'binaryPath' | 'env'; candidate: string } | null {
  const fromConfig = typeof configBinaryPath === 'string' ? configBinaryPath.trim() : '';
  if (fromConfig) return { source: 'binaryPath', candidate: fromConfig };
  const fromEnv = typeof env[COPILOT_CLI_PATH_ENV] === 'string' ? env[COPILOT_CLI_PATH_ENV]!.trim() : '';
  if (fromEnv) return { source: 'env', candidate: fromEnv };
  return null;
}

function isValidCopilotCliFileSync(filePath: string, platform: NodeJS.Platform): boolean {
  try {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return false;
    if (platform === 'win32' || filePath.toLowerCase().endsWith('.js')) return true;
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isValidCopilotCliFileAsync(filePath: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;
    if (platform === 'win32' || filePath.toLowerCase().endsWith('.js')) return true;
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve an explicit Copilot CLI override for spawned-stdio mode.
 *
 * Shared by `CopilotSdkProvider`, `copilot-runtime-config`, and `agent-availability`:
 * only an explicit `binaryPath` or `COPILOT_CLI_PATH` that is an existing
 * executable (or `.js` entrypoint) absolute path routes to `forSpawnedStdio`;
 * otherwise returns `undefined` so v2 uses its bundled in-process FFI runtime
 * without searching `PATH` (preventing legacy PATH `copilot` binaries from
 * hijacking startup).
 */
export function resolveCopilotExplicitBinaryPathSync(options: {
  binaryPath?: unknown;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  isValidFile?: (filePath: string) => boolean;
} = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const picked = selectExplicitCandidate(options.binaryPath, env);
  if (!picked) return undefined;
  const p = pathModuleFor(platform);
  const check = options.isValidFile ?? ((filePath: string) => isValidCopilotCliFileSync(filePath, platform));
  if (p.isAbsolute(picked.candidate) && check(picked.candidate)) {
    return picked.candidate;
  }
  logger.warn(
    { source: picked.source, candidate: picked.candidate },
    'Ignoring Copilot CLI override (not an existing executable absolute file path) — falling back to bundled runtime',
  );
  return undefined;
}

/** Async counterpart to {@link resolveCopilotExplicitBinaryPathSync} for availability probes. */
export async function resolveCopilotExplicitBinaryPath(options: {
  binaryPath?: unknown;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  isValidFile?: (filePath: string) => Promise<boolean>;
} = {}): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const picked = selectExplicitCandidate(options.binaryPath, env);
  if (!picked) return undefined;
  const p = pathModuleFor(platform);
  const check = options.isValidFile ?? ((filePath: string) => isValidCopilotCliFileAsync(filePath, platform));
  if (p.isAbsolute(picked.candidate) && (await check(picked.candidate))) {
    return picked.candidate;
  }
  return undefined;
}

/**
 * Matches `@microsoft/copilot-sdk/dist/runtimeArtifacts.js#getRuntimePlatform`
 * (`linux-<arch>` vs `linuxmusl-<arch>` on Linux, `<darwin|win32>-<arch>` otherwise; x64/arm64 only).
 */
export function resolveCopilotRuntimePlatform(
  platform: NodeJS.Platform,
  arch: string,
  musl = false,
): string | null {
  if (arch !== 'x64' && arch !== 'arm64') return null;
  if (platform === 'linux') return `${musl ? 'linuxmusl' : 'linux'}-${arch}`;
  if (platform === 'darwin' || platform === 'win32') return `${platform}-${arch}`;
  return null;
}

export function buildCopilotClientOptions(
  sdk: { RuntimeConnection?: { forSpawnedStdio?: (opts: { path?: string }) => unknown } },
  explicitBinaryPath?: string,
): CopilotClientOptions {
  if (!explicitBinaryPath) return { mode: 'coding-agent' };
  return {
    mode: 'coding-agent',
    runtime: (sdk.RuntimeConnection?.forSpawnedStdio
      ? sdk.RuntimeConnection.forSpawnedStdio({ path: explicitBinaryPath })
      : { kind: 'spawned-stdio', path: explicitBinaryPath }) as CopilotClientOptions['runtime'],
  };
}

export interface CopilotModelInfo {
  id: string;
  name?: string;
  supportsReasoningEffort?: boolean;
  supportedEffortLevels?: readonly TransportEffortLevel[];
}

/** Map Copilot reasoning effort labels (`xhigh` -> IM.codes `max`) and filter to valid transport levels. */
export function normalizeCopilotSupportedEfforts(value: unknown): TransportEffortLevel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const mapped = value.map((entry) => (entry === 'xhigh' ? 'max' : entry));
  return normalizeSupportedEffortLevels(mapped);
}

export interface CopilotRuntimeConfig {
  /** Ordered list of model ids reported by the Copilot SDK's `listModels()`. */
  availableModels: string[];
  /** Full metadata for each model, useful when the UI wants labels or capability hints. */
  models: CopilotModelInfo[];
  /** True when `getAuthStatus()` reported authenticated. */
  isAuthenticated: boolean;
  /** True only when returning an unprobed cold fallback instead of a real auth probe result. */
  isColdFallback?: boolean;
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
  'gpt-5.4',
  'gpt-5.4-mini',
  'claude-sonnet-4.6',
  'claude-opus-4.6',
];

// ── Singleton CopilotClient ──────────────────────────────────────────────────
//
// The `@microsoft/copilot-sdk` CopilotClient hosts the native Copilot runtime
// (in-process via FFI by default in v2, or a headless subprocess). Earlier
// revisions called `new CopilotClient() → start() → stop()` on every probe,
// leaking runtimes across repeated probes. So we maintain ONE client for the
// daemon's lifetime and re-invoke `getStatus`/`listModels`/`getAuthStatus` against it.
//
// `clientPromise` also doubles as a concurrent-call dedupe: multiple probes
// racing through the cache-miss branch await the same init, instead of each
// starting its own runtime.

let clientPromise: Promise<unknown> | null = null;
let inFlightProbe: Promise<CopilotRuntimeConfig> | null = null;

export type CopilotRuntimeConfigOptions = boolean | {
  force?: boolean;
  /**
   * When false, never start/probe the Copilot SDK. This is used by passive
   * session-list refreshes so a UI repaint cannot spawn a headless Copilot
   * subprocess during daemon startup.
   */
  probe?: boolean;
};

function normalizeOptions(options: CopilotRuntimeConfigOptions): { force: boolean; probe: boolean } {
  if (typeof options === 'boolean') return { force: options, probe: true };
  return {
    force: options.force === true,
    probe: options.probe !== false,
  };
}

function fallbackRuntimeConfig(): CopilotRuntimeConfig {
  return {
    availableModels: [...FALLBACK_COPILOT_MODEL_IDS],
    models: FALLBACK_COPILOT_MODEL_IDS.map((id) => ({ id })),
    isAuthenticated: false,
    isColdFallback: true,
  };
}

async function getCopilotClient(): Promise<unknown> {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const sdk = await import('@microsoft/copilot-sdk');
    const explicitBinary = await resolveCopilotExplicitBinaryPath();
    const client = new sdk.CopilotClient(buildCopilotClientOptions(sdk, explicitBinary));
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
      const raw = await client.listModels() as Model[] | unknown;
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          if (!entry || typeof entry.id !== 'string') continue;
          const supportedEffortLevels = normalizeCopilotSupportedEfforts(entry.supportedReasoningEfforts);
          const supportsReasoningEffort = entry.capabilities?.supports?.reasoningEffort === true
            || Boolean(supportedEffortLevels?.length);
          models.push({
            id: entry.id,
            ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
            ...(supportsReasoningEffort ? { supportsReasoningEffort: true } : {}),
            ...(supportedEffortLevels ? { supportedEffortLevels } : {}),
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
export async function getCopilotRuntimeConfig(optionsArg: CopilotRuntimeConfigOptions = false): Promise<CopilotRuntimeConfig> {
  const options = normalizeOptions(optionsArg);
  const now = Date.now();
  if (!options.force && cached && cached.expiresAt > now) return cached.value;
  if (!options.probe) return cached?.value ?? fallbackRuntimeConfig();
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
