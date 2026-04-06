import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CACHE_TTL_MS = 30_000;
const APP_SERVER_TIMEOUT_MS = 5_000;

export interface CodexRuntimeConfig {
  planLabel?: string;
  quotaLabel?: string;
  quotaUsageLabel?: string;
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

function formatPercent(value: number | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return `${Math.max(0, Math.min(100, Math.round(value)))}%`;
}

function formatRemainingTime(epochSeconds: number | undefined, nowMs = Date.now()): string | undefined {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) return undefined;
  const diffMs = Math.max(0, epochSeconds * 1000 - nowMs);
  const totalMinutes = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d${String(hours).padStart(2, '0')}h`;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m`;
}

function formatResetDateTime(epochSeconds: number | undefined): string | undefined {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) return undefined;
  const date = new Date(epochSeconds * 1000);
  if (Number.isNaN(date.getTime())) return undefined;
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hh}:${mm}`;
}

function buildQuotaDisplay(snapshot: RateLimitSnapshot | null | undefined): Pick<CodexRuntimeConfig, 'quotaLabel'> {
  const primary = snapshot?.primary ?? undefined;
  const secondary = snapshot?.secondary ?? undefined;
  const quotaParts = [
    primary ? `5h ${formatPercent(primary.usedPercent) ?? '—'}${primary?.resetsAt ? ` ${formatRemainingTime(primary.resetsAt)} ${formatResetDateTime(primary.resetsAt)}` : ''}` : null,
    secondary ? `7d ${formatPercent(secondary.usedPercent) ?? '—'}${secondary?.resetsAt ? ` ${formatRemainingTime(secondary.resetsAt)} ${formatResetDateTime(secondary.resetsAt)}` : ''}` : null,
  ].filter((value): value is string => !!value);
  return {
    ...(quotaParts.length ? { quotaLabel: quotaParts.join(' · ') } : {}),
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
    let stderrBuffer = '';
    let initialized = false;
    const requestId = 2;

    const finish = (value: RateLimitSnapshot | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      resolve(value);
    };

    const timeout = setTimeout(() => finish(undefined), APP_SERVER_TIMEOUT_MS);

    child.on('error', () => finish(undefined));
    child.stderr.on('data', (chunk) => { stderrBuffer += chunk.toString('utf8'); });
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
            child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
            child.stdin.write(JSON.stringify({ method: 'account/rateLimits/read', id: requestId }) + '\n');
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

    child.stdin.write(JSON.stringify({
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
