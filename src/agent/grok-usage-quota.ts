import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderQuotaMeta, ProviderQuotaWindow } from '../../shared/provider-quota.js';
import { formatProviderQuotaLabel } from '../../shared/provider-quota.js';
import logger from '../util/logger.js';
import { imcodesStateDir } from '../util/imcodes-state-dir.js';

const BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing';
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_PERSISTED_AGE_MS = 24 * 60 * 60 * 1000;
const IDLE_FETCH_SUPPRESS_MS = 15 * 60 * 1000;
const IS_TEST_ENV = !!process.env.VITEST || process.env.NODE_ENV === 'test';
const CACHE_DIR = IS_TEST_ENV ? join(tmpdir(), '.imcodes') : imcodesStateDir();
const CACHE_PATH = join(CACHE_DIR, 'grok-usage-quota.json');

export interface GrokBillingResponse {
  config?: {
    monthlyLimit?: { val?: number };
    used?: { val?: number };
    onDemandCap?: { val?: number };
    billingPeriodStart?: string;
    billingPeriodEnd?: string;
    history?: Array<{
      billingCycle?: { year?: number; month?: number };
      includedUsed?: { val?: number };
      onDemandUsed?: { val?: number };
      totalUsed?: { val?: number };
    }>;
  };
}

export interface GrokUsageQuota {
  quotaLabel?: string;
  quotaMeta: ProviderQuotaMeta;
}

export interface FetchGrokUsageQuotaOptions {
  forceRefresh?: boolean;
  lastActivityAt?: number;
}

function isoToEpochSeconds(iso: string | undefined): number | undefined {
  if (typeof iso !== 'string' || !iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

/**
 * Pure mapper from Grok CLI chat proxy `/v1/billing` payload to ProviderQuotaMeta.
 */
export function grokBillingToQuotaMeta(
  billing: GrokBillingResponse | null | undefined,
): ProviderQuotaMeta | undefined {
  if (!billing?.config) return undefined;
  const cfg = billing.config;
  const resetsAt = isoToEpochSeconds(cfg.billingPeriodEnd);
  const start = isoToEpochSeconds(cfg.billingPeriodStart);
  const windowDurationMins = (resetsAt && start && resetsAt > start)
    ? Math.round((resetsAt - start) / 60)
    : 30 * 24 * 60;

  let usedPercent: number | undefined;
  if (typeof cfg.monthlyLimit?.val === 'number' && cfg.monthlyLimit.val > 0) {
    usedPercent = Math.min(100, Math.round(((cfg.used?.val ?? 0) / cfg.monthlyLimit.val) * 1000) / 10);
  } else if (typeof cfg.onDemandCap?.val === 'number' && cfg.onDemandCap.val > 0) {
    usedPercent = Math.min(100, Math.round(((cfg.used?.val ?? 0) / cfg.onDemandCap.val) * 1000) / 10);
  } else {
    usedPercent = 0;
  }

  const primary: ProviderQuotaWindow = {
    windowDurationMins,
    usedPercent,
    ...(resetsAt ? { resetsAt } : {}),
    percentPrecision: 1,
  };

  return { primary };
}

interface GrokAuthCreds {
  key?: string;
  team_id?: string;
  expires_at?: string;
}

async function readGrokAuth(): Promise<GrokAuthCreds | null> {
  try {
    const raw = await readFile(join(homedir(), '.grok', 'auth.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const entry of Object.values(parsed)) {
      if (entry && typeof entry === 'object') {
        const e = entry as Record<string, unknown>;
        const key = typeof e.key === 'string' && e.key.trim() ? e.key.trim() : undefined;
        if (key) {
          const team_id = typeof e.team_id === 'string' && e.team_id.trim() ? e.team_id.trim() : undefined;
          const expires_at = typeof e.expires_at === 'string' && e.expires_at.trim() ? e.expires_at.trim() : undefined;
          return { key, team_id, expires_at };
        }
      }
    }
  } catch {
    // Missing or invalid ~/.grok/auth.json
  }
  return null;
}

let cache: { at: number; value: GrokUsageQuota | null } | null = null;
let inflight: Promise<GrokUsageQuota | null> | null = null;
let lastActivityAt = 0;
let diskLoaded = false;

export function recordGrokQuotaActivity(now = Date.now()): void {
  lastActivityAt = now;
}

export function getLastGrokQuotaActivityAt(): number {
  return lastActivityAt;
}

function loadPersistedCacheOnce(): void {
  if (diskLoaded) return;
  diskLoaded = true;
  if (cache) return;
  try {
    if (!existsSync(CACHE_PATH)) return;
    const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as { at?: number; value?: GrokUsageQuota | null };
    if (parsed && typeof parsed.at === 'number' && parsed.value && Date.now() - parsed.at < MAX_PERSISTED_AGE_MS) {
      cache = { at: parsed.at, value: parsed.value };
    }
  } catch {
    // missing or unreadable
  }
}

function persistCache(entry: { at: number; value: GrokUsageQuota | null }): void {
  if (!entry.value) return;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(entry), 'utf8');
  } catch (err) {
    logger.debug({ err }, 'grok usage quota cache persist failed');
  }
}

function synthesizeFallbackQuotaMeta(): ProviderQuotaMeta {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const startEpoch = Math.floor(start.getTime() / 1000);
  const endEpoch = Math.floor(end.getTime() / 1000);
  const windowDurationMins = Math.round((endEpoch - startEpoch) / 60);
  return {
    primary: {
      windowDurationMins,
      usedPercent: 0,
      resetsAt: endEpoch,
      percentPrecision: 1,
    },
  };
}

async function fetchFromBillingEndpoint(token: string): Promise<GrokUsageQuota | null> {
  try {
    const res = await fetch(BILLING_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'grok-cli/1.0.52',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as GrokBillingResponse;
    const quotaMeta = grokBillingToQuotaMeta(json);
    if (!quotaMeta) return null;
    return { quotaMeta, quotaLabel: formatProviderQuotaLabel(quotaMeta) };
  } catch (err) {
    logger.debug({ err }, 'grok billing fetch failed');
    return null;
  }
}

export async function fetchGrokUsageQuota(opts?: FetchGrokUsageQuotaOptions): Promise<GrokUsageQuota | null> {
  loadPersistedCacheOnce();
  const now = Date.now();
  const effectiveActivity = Math.max(lastActivityAt, opts?.lastActivityAt ?? 0);
  const isIdle = effectiveActivity > 0 && (now - effectiveActivity > IDLE_FETCH_SUPPRESS_MS);

  if (!opts?.forceRefresh && cache) {
    if (now - cache.at < CACHE_TTL_MS || isIdle) {
      return cache.value;
    }
  }

  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const auth = await readGrokAuth();
      if (!auth?.key) {
        return cache?.value ?? null;
      }

      let result = await fetchFromBillingEndpoint(auth.key);
      if (!result) {
        // Fallback: If network fetch fails but valid local Grok auth exists, synthesize the monthly period
        // so the session quota doesn't flicker away.
        const quotaMeta = synthesizeFallbackQuotaMeta();
        result = { quotaMeta, quotaLabel: formatProviderQuotaLabel(quotaMeta) };
      }

      cache = { at: now, value: result };
      persistCache(cache);
      return result;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

export function getGrokUsageQuota(force = false): Promise<GrokUsageQuota | null> {
  return fetchGrokUsageQuota({ forceRefresh: force });
}

export function peekGrokUsageQuotaCached(): GrokUsageQuota | null {
  loadPersistedCacheOnce();
  return cache?.value ?? null;
}

export async function refreshGrokQuotaMetadata(
  optsOrForce?: boolean | FetchGrokUsageQuotaOptions,
): Promise<GrokUsageQuota | null> {
  const opts = typeof optsOrForce === 'boolean' ? { forceRefresh: optsOrForce } : optsOrForce;
  const quota = await fetchGrokUsageQuota(opts).catch(() => null);
  if (!quota) return null;
  const { listSessions, upsertSession } = await import('../store/session-store.js');
  const { persistSessionRecord } = await import('./session-manager.js');
  const { providerQuotaMetaEquals } = await import('../../shared/provider-quota.js');
  for (const session of listSessions()) {
    if (session.agentType !== 'grok-sdk') continue;
    if (
      session.quotaLabel !== quota.quotaLabel
      || !providerQuotaMetaEquals(session.quotaMeta, quota.quotaMeta)
    ) {
      const next = {
        ...session,
        quotaLabel: quota.quotaLabel,
        quotaMeta: quota.quotaMeta,
        updatedAt: Date.now(),
      };
      upsertSession(next);
      persistSessionRecord(next, next.name);
    }
  }
  return quota;
}

export function __resetGrokUsageQuotaCache(): void {
  cache = null;
  inflight = null;
  lastActivityAt = 0;
  diskLoaded = false;
  try {
    rmSync(CACHE_PATH, { force: true });
  } catch {
    // ignore
  }
}
