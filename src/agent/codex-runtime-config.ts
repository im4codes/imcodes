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
