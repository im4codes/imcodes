import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { killProcessTree } from '../util/kill-process-tree.js';
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
    // The codex npm package is a node wrapper that internally spawns a musl
    // `codex` binary (the app-server). Group signals via `process.kill(-pid,…)`
    // do NOT always reach that grandchild — some wrapper versions detach their
    // native binary into its own session, so the group we control does not
    // include the memory-hungry grandchild. We therefore leave `detached`
    // unset and rely on `killProcessTree` to walk `ps -A -o pid,ppid` at
    // teardown time and send SIGTERM→SIGKILL to every descendant explicitly.
    // See the commit that replaced the group-kill approach for diagnostics
    // (observed 20+ orphaned pairs after ~4h of probes).
    const child = spawn('codex', ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let settled = false;
    let stdoutBuffer = '';
    let initialized = false;
    const requestId = 2;

    const killTree = () => {
      // Fire-and-forget: killProcessTree is idempotent and handles the
      // race where the child has already exited on its own. We pass the
      // ChildProcess so the utility can also invoke child.kill() directly,
      // staying compatible with mock spawns in unit tests.
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

/**
 * Ask the registry-singleton codex-sdk provider (if already connected) for a
 * rate-limit snapshot via its existing app-server JSON-RPC. Returns undefined
 * when no singleton is around, when the RPC fails, or when the response
 * doesn't include a `rateLimits` field — the caller then falls back to
 * spawning a fresh probe child.
 *
 * Reusing the singleton is what prevents ~107MB orphaned codex pairs from
 * accumulating per probe tick: under steady-state load the daemon's codex
 * app-server is already running, so we skip the spawn entirely.
 */
async function readCodexRateLimitsViaSingleton(): Promise<RateLimitSnapshot | undefined> {
  try {
    const { getProvider } = await import('./provider-registry.js');
    const provider = getProvider('codex-sdk');
    if (!provider) return undefined;
    // Narrow to CodexSdkProvider without pulling the module at top-level —
    // avoids a dependency cycle (provider-registry → codex-sdk → this file).
    const asCodex = provider as unknown as { readRateLimits?: () => Promise<Record<string, unknown> | undefined> };
    if (typeof asCodex.readRateLimits !== 'function') return undefined;
    const payload = await asCodex.readRateLimits();
    return payload as RateLimitSnapshot | undefined;
  } catch {
    return undefined;
  }
}

export async function getCodexRuntimeConfig(force = false): Promise<CodexRuntimeConfig> {
  const now = Date.now();
  if (!force && cache && cache.expiresAt > now) return cache.value;

  const authPlanType = await readCodexPlanTypeFromAuthFile().catch(() => undefined);
  // Prefer the long-lived registry singleton so we don't spawn a fresh codex
  // app-server just to read rate limits. Falls back to the one-shot probe
  // (with tree-kill teardown) when no singleton is connected yet.
  const rateLimits = (await readCodexRateLimitsViaSingleton())
    ?? await readCodexRateLimitsViaAppServer().catch(() => undefined);
  const planLabel = capitalize((rateLimits?.planType ?? authPlanType ?? undefined) || undefined);
  const quotaDisplay = buildQuotaDisplay(rateLimits);
  const value: CodexRuntimeConfig = {
    ...(planLabel ? { planLabel } : {}),
    ...quotaDisplay,
  };
  cache = { expiresAt: now + CACHE_TTL_MS, value };
  return value;
}
