import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderQuotaMeta } from '../../shared/provider-quota.js';
import { formatProviderQuotaLabel } from '../../shared/provider-quota.js';

const CACHE_TTL_MS = 30_000;
const APP_SERVER_TIMEOUT_MS = 5_000;

export interface CodexRuntimeConfig {
  planLabel?: string;
  quotaLabel?: string;
  quotaUsageLabel?: string;
  quotaMeta?: ProviderQuotaMeta;
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

    const finish = (value: RateLimitSnapshot | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { child.kill(); } catch { /* ignore */ }
      resolve(value);
    };

    const timeout = setTimeout(() => finish(undefined), APP_SERVER_TIMEOUT_MS);

    // Safely write to child stdin — swallow EPIPE/ECONNRESET when the
    // codex subprocess exits before we finish sending the init sequence.
    const safeWriteStdin = (payload: string) => {
      try {
        child.stdin.write(payload);
      } catch {
        finish(undefined);
      }
    };

    // Explicitly handle stdin errors so write-after-close doesn't become
    // an uncaught 'error' event bubbling up to the daemon.
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

let cache: { expiresAt: number; value: CodexRuntimeConfig } | null = null;

export async function getCodexRuntimeConfig(force = false): Promise<CodexRuntimeConfig> {
  const now = Date.now();
  if (!force && cache && cache.expiresAt > now) return cache.value;

  const authPlanType = await readCodexPlanTypeFromAuthFile().catch(() => undefined);
  const rateLimits = await readCodexRateLimitsViaAppServer().catch(() => undefined);
  const planLabel = capitalize((rateLimits?.planType ?? authPlanType ?? undefined) || undefined);
  const quotaDisplay = buildQuotaDisplay(rateLimits);
  const value: CodexRuntimeConfig = {
    ...(planLabel ? { planLabel } : {}),
    ...quotaDisplay,
  };
  cache = { expiresAt: now + CACHE_TTL_MS, value };
  return value;
}
