import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CODEX_MODEL_IDS } from '../shared/models/options.js';
import { killProcessTree } from '../util/kill-process-tree.js';
import type { ProviderQuotaMeta } from '../../shared/provider-quota.js';
import { formatProviderQuotaLabel } from '../../shared/provider-quota.js';

const CACHE_TTL_MS = 30_000;
const APP_SERVER_TIMEOUT_MS = 5_000;
const MODELS_CACHE_FILE_TTL_MS = 30_000;

export interface CodexModelInfo {
  id: string;
  name?: string;
  supportsReasoningEffort?: boolean;
  isDefault?: boolean;
}

export interface CodexRuntimeConfig {
  planLabel?: string;
  quotaLabel?: string;
  quotaUsageLabel?: string;
  quotaMeta?: ProviderQuotaMeta;
  availableModels?: string[];
  models?: CodexModelInfo[];
  defaultModel?: string;
  isAuthenticated?: boolean;
  probeError?: string;
}

interface RateLimitWindow {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

interface RateLimitSnapshot {
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  planType?: string | null;
}

function capitalize(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function fallbackCodexModels(): CodexModelInfo[] {
  return CODEX_MODEL_IDS.map((id, index) => ({
    id,
    ...(index === 0 ? { isDefault: true } : {}),
  }));
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    const decoded = Buffer.from(normalized + padding, 'base64').toString('utf8');
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readCodexPlanTypeFromAuthFile(): Promise<string | undefined> {
  try {
    const raw = await readFile(join(homedir(), '.codex', 'auth.json'), 'utf8');
    const parsed = JSON.parse(raw) as { access_token?: string; id_token?: string };
    const candidates = [parsed.access_token, parsed.id_token];
    for (const token of candidates) {
      const payload = decodeJwtPayload(token);
      const auth = payload?.['https://api.openai.com/auth'];
      if (!auth || typeof auth !== 'object') continue;
      const planType = (auth as { chatgpt_plan_type?: unknown }).chatgpt_plan_type;
      if (typeof planType === 'string' && planType.trim()) return planType.trim();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function buildQuotaDisplay(snapshot: RateLimitSnapshot | null | undefined): Pick<CodexRuntimeConfig, 'quotaLabel' | 'quotaMeta'> {
  const quotaLabel = formatProviderQuotaLabel(snapshot);
  return {
    ...(quotaLabel ? { quotaLabel } : {}),
    ...(snapshot ? { quotaMeta: { primary: snapshot.primary ?? undefined, secondary: snapshot.secondary ?? undefined } } : {}),
  };
}

async function readCodexRateLimitsViaAppServer(): Promise<RateLimitSnapshot | undefined> {
  return await new Promise<RateLimitSnapshot | undefined>((resolve) => {
    const child = spawn('codex', ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let settled = false;
    let stdoutBuffer = '';
    let initialized = false;
    const requestId = 2;

    const killTree = () => {
      void killProcessTree(child);
    };

    const finish = (value: RateLimitSnapshot | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      killTree();
      resolve(value);
    };

    const timeout = setTimeout(() => finish(undefined), APP_SERVER_TIMEOUT_MS);

    const safeWriteStdin = (payload: string) => {
      try {
        child.stdin.write(payload);
      } catch {
        finish(undefined);
      }
    };

    child.stdin.on('error', () => finish(undefined));
    child.on('error', () => finish(undefined));
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
      while (true) {
        const nl = stdoutBuffer.indexOf('\n');
        if (nl < 0) break;
        const line = stdoutBuffer.slice(0, nl).trim();
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as Record<string, any>;
          if (msg.id === 1 && msg.result && !initialized) {
            initialized = true;
            safeWriteStdin(JSON.stringify({ method: 'initialized' }) + '\n');
            safeWriteStdin(JSON.stringify({ method: 'account/rateLimits/read', id: requestId }) + '\n');
            continue;
          }
          if (msg.id === requestId && msg.result?.rateLimits) {
            finish(msg.result.rateLimits as RateLimitSnapshot);
            return;
          }
        } catch {
          // ignore malformed lines
        }
      }
    });

    child.on('close', () => {
      if (!settled) finish(undefined);
    });

    safeWriteStdin(JSON.stringify({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: {
          name: 'imcodes',
          title: 'IM Codes',
          version: '0.1.0',
        },
        capabilities: {
          experimentalApi: true,
        },
      },
    }) + '\n');
  });
}

async function readCodexModelsViaAppServer(): Promise<CodexModelInfo[] | undefined> {
  return await new Promise<CodexModelInfo[] | undefined>((resolve) => {
    const child = spawn('codex', ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let settled = false;
    let stdoutBuffer = '';
    let initialized = false;
    let nextRequestId = 2;
    let activeRequestId = nextRequestId;
    let nextCursor: string | null = null;
    const discovered: CodexModelInfo[] = [];
    const seen = new Set<string>();

    const killTree = () => {
      void killProcessTree(child);
    };

    const finish = (value: CodexModelInfo[] | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      killTree();
      resolve(value);
    };

    const timeout = setTimeout(() => finish(undefined), APP_SERVER_TIMEOUT_MS);

    const safeWriteStdin = (payload: string) => {
      try {
        child.stdin.write(payload);
      } catch {
        finish(undefined);
      }
    };

    const writeModelList = () => {
      activeRequestId = nextRequestId++;
      safeWriteStdin(JSON.stringify({
        method: 'model/list',
        id: activeRequestId,
        params: {
          includeHidden: false,
          limit: 100,
          ...(nextCursor ? { cursor: nextCursor } : {}),
        },
      }) + '\n');
    };

    child.stdin.on('error', () => finish(undefined));
    child.on('error', () => finish(undefined));
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
      while (true) {
        const nl = stdoutBuffer.indexOf('\n');
        if (nl < 0) break;
        const line = stdoutBuffer.slice(0, nl).trim();
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as Record<string, any>;
          if (msg.id === 1 && msg.result && !initialized) {
            initialized = true;
            safeWriteStdin(JSON.stringify({ method: 'initialized' }) + '\n');
            writeModelList();
            continue;
          }
          if (msg.id === activeRequestId && Array.isArray(msg.result?.data)) {
            for (const entry of msg.result.data as Array<Record<string, unknown>>) {
              const modelId = typeof entry.model === 'string' && entry.model.trim()
                ? entry.model.trim()
                : typeof entry.id === 'string' && entry.id.trim()
                  ? entry.id.trim()
                  : '';
              if (!modelId || seen.has(modelId)) continue;
              seen.add(modelId);
              discovered.push({
                id: modelId,
                ...(typeof entry.displayName === 'string' && entry.displayName.trim()
                  ? { name: entry.displayName.trim() }
                  : {}),
                ...(Array.isArray(entry.supportedReasoningEfforts) && entry.supportedReasoningEfforts.length > 0
                  ? { supportsReasoningEffort: true }
                  : {}),
                ...(entry.isDefault === true ? { isDefault: true } : {}),
              });
            }
            nextCursor = typeof msg.result?.nextCursor === 'string' && msg.result.nextCursor.trim()
              ? msg.result.nextCursor.trim()
              : null;
            if (nextCursor) {
              writeModelList();
              continue;
            }
            finish(discovered);
            return;
          }
        } catch {
          // ignore malformed lines
        }
      }
    });

    child.on('close', () => {
      if (!settled) finish(undefined);
    });

    safeWriteStdin(JSON.stringify({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: {
          name: 'imcodes',
          title: 'IM Codes',
          version: '0.1.0',
        },
        capabilities: {
          experimentalApi: true,
        },
      },
    }) + '\n');
  });
}

let cache: { expiresAt: number; value: CodexRuntimeConfig } | null = null;

// ──────────────────────────────────────────────────────────────────────────
// Per-model `base_instructions` lookup
//
// codex CLI persists the upstream model catalog (including the full
// per-model `base_instructions` system prompt) to `~/.codex/models_cache.json`
// after the first successful auth. Each prompt is 12–22 KB of carefully
// tuned content that codex normally injects on its end when talking to
// the OpenAI Responses API.
//
// Starting with codex CLI 0.125 + the OpenAI Responses API protocol change
// of April 2026, the daemon-side JSON-RPC `thread/start` path (and the
// `session_startup_prewarm` it triggers) no longer auto-fills `instructions`
// from the embedded catalog. Sending a thread/start without an explicit
// `baseInstructions` field results in:
//
//   {"type":"error","status":400,"error":{"type":"invalid_request_error",
//     "message":"Instructions are required"}}
//
// Reading the prompt from this cache lets us forward the exact per-model
// prompt codex itself would have used, with no quality regression for
// catalog models. For unknown / third-party providers (e.g. minimax via
// `wire_api = "responses"`) the cache won't have a matching slug — the
// caller falls back to its provider-neutral default.
// ──────────────────────────────────────────────────────────────────────────

interface ModelsCacheData {
  /** slug → base_instructions */
  map: Map<string, string>;
  /** Slugs in the order codex CLI listed them (newest first by convention). */
  order: string[];
}

let modelsFileCache: { expiresAt: number; data: ModelsCacheData } | null = null;

async function loadCodexModelsCache(): Promise<ModelsCacheData> {
  const now = Date.now();
  if (modelsFileCache && modelsFileCache.expiresAt > now) {
    return modelsFileCache.data;
  }
  const map = new Map<string, string>();
  const order: string[] = [];
  try {
    const raw = await readFile(join(homedir(), '.codex', 'models_cache.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      models?: Array<{ slug?: unknown; base_instructions?: unknown }>;
    };
    for (const entry of parsed.models ?? []) {
      const slug = typeof entry.slug === 'string' ? entry.slug.trim().toLowerCase() : '';
      const instructions = typeof entry.base_instructions === 'string' ? entry.base_instructions : '';
      if (slug && instructions.length > 0 && !map.has(slug)) {
        map.set(slug, instructions);
        order.push(slug);
      }
    }
  } catch {
    // Missing file / parse error → empty map; caller falls back.
  }
  const data: ModelsCacheData = { map, order };
  modelsFileCache = { expiresAt: now + MODELS_CACHE_FILE_TTL_MS, data };
  return data;
}

/**
 * Returns the `base_instructions` codex CLI itself would inject for `model`,
 * sourced from `~/.codex/models_cache.json`.
 *
 * Resolution order, designed to stay safe across model bumps:
 *
 *   1. Exact slug match (case-insensitive). Best case — full per-model prompt.
 *   2. If the model isn't in the cache (e.g. user picked a brand-new
 *      `gpt-5.6` that codex CLI hasn't yet refreshed catalog for, or local
 *      cache is stale), fall through to **the newest known prompt** in the
 *      cache (`models[0]` — codex orders newest first). Better to use last
 *      version's prompt than a 200-char generic fallback that loses 21 KB
 *      of carefully tuned content.
 *   3. Returns `undefined` only when the cache file itself is missing or
 *      contains no usable entries — at which point the caller will use a
 *      provider-neutral default.
 */
export async function getCodexBaseInstructions(model: string | undefined): Promise<string | undefined> {
  const { map, order } = await loadCodexModelsCache();
  if (model) {
    const exact = map.get(model.trim().toLowerCase());
    if (exact) return exact;
  }
  // Unknown model OR no model selected → use the most recently published
  // prompt we have on disk. codex's models_cache.json lists the active /
  // primary model first, so order[0] is the safest known prompt.
  if (order.length > 0) {
    const newest = map.get(order[0]!);
    if (newest) return newest;
  }
  return undefined;
}

async function readCodexRateLimitsViaSingleton(): Promise<RateLimitSnapshot | undefined> {
  try {
    const { getProvider } = await import('./provider-registry.js');
    const provider = getProvider('codex-sdk');
    if (!provider) return undefined;
    const asCodex = provider as unknown as { readRateLimits?: () => Promise<Record<string, unknown> | undefined> };
    if (typeof asCodex.readRateLimits !== 'function') return undefined;
    const payload = await asCodex.readRateLimits();
    return payload as RateLimitSnapshot | undefined;
  } catch {
    return undefined;
  }
}

async function readCodexModelsViaSingleton(): Promise<CodexModelInfo[] | undefined> {
  try {
    const { getProvider } = await import('./provider-registry.js');
    const provider = getProvider('codex-sdk');
    if (!provider) return undefined;
    const asCodex = provider as unknown as { readModelList?: () => Promise<CodexModelInfo[] | undefined> };
    if (typeof asCodex.readModelList !== 'function') return undefined;
    return await asCodex.readModelList();
  } catch {
    return undefined;
  }
}

export async function getCodexRuntimeConfig(force = false): Promise<CodexRuntimeConfig> {
  const now = Date.now();
  if (!force && cache && cache.expiresAt > now) return cache.value;

  const authPlanType = await readCodexPlanTypeFromAuthFile().catch(() => undefined);
  let discoveredModels: CodexModelInfo[] | undefined;
  let modelProbeError: string | undefined;
  try {
    discoveredModels = (await readCodexModelsViaSingleton())
      ?? await readCodexModelsViaAppServer();
  } catch (err) {
    modelProbeError = err instanceof Error ? err.message : String(err);
  }
  const rateLimits = (await readCodexRateLimitsViaSingleton())
    ?? await readCodexRateLimitsViaAppServer().catch(() => undefined);
  const planLabel = capitalize((rateLimits?.planType ?? authPlanType ?? undefined) || undefined);
  const quotaDisplay = buildQuotaDisplay(rateLimits);
  const models = discoveredModels && discoveredModels.length > 0 ? discoveredModels : fallbackCodexModels();
  const defaultModel = models.find((model) => model.isDefault)?.id ?? models[0]?.id;
  const value: CodexRuntimeConfig = {
    ...(planLabel ? { planLabel } : {}),
    ...quotaDisplay,
    availableModels: models.map((model) => model.id),
    models,
    ...(defaultModel ? { defaultModel } : {}),
    ...(discoveredModels && discoveredModels.length > 0 ? { isAuthenticated: true } : {}),
    ...(modelProbeError ? { probeError: modelProbeError } : {}),
  };
  cache = { expiresAt: now + CACHE_TTL_MS, value };
  return value;
}
