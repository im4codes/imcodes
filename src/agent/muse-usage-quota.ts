import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderQuotaMeta, ProviderQuotaWindow } from '../../shared/provider-quota.js';
import { formatProviderQuotaLabel, providerQuotaMetaEquals } from '../../shared/provider-quota.js';
import logger from '../util/logger.js';
import { imcodesStateDir } from '../util/imcodes-state-dir.js';

const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_PERSISTED_AGE_MS = 24 * 60 * 60 * 1000;
const IDLE_FETCH_SUPPRESS_MS = 15 * 60 * 1000;
const IS_TEST_ENV = !!process.env.VITEST || process.env.NODE_ENV === 'test';
const CACHE_DIR = IS_TEST_ENV ? join(tmpdir(), '.imcodes') : imcodesStateDir();
const CACHE_PATH = join(CACHE_DIR, 'muse-usage-quota.json');

const FIVE_HOUR_MINS = 5 * 60;
const SEVEN_DAY_MINS = 7 * 24 * 60;

export interface MuseSubscriptionUsageWeekly {
  resetsAtMs: number;
  usedPercent: number;
}

export interface MuseSubscriptionUsageWindow {
  resetsAtMs: number;
  usedPercent: number;
  windowDurationMins: number;
}

export interface MuseSubscriptionUsage {
  observedAtMs?: number;
  tier?: string;
  weekly?: MuseSubscriptionUsageWeekly | null;
  window?: MuseSubscriptionUsageWindow | null;
}

export interface MuseUsageQuota {
  quotaLabel?: string;
  quotaMeta: ProviderQuotaMeta;
  tier?: string;
}

export interface FetchMuseUsageQuotaOptions {
  forceRefresh?: boolean;
  lastActivityAt?: number;
}

export type MuseUsageReader = () => Promise<MuseSubscriptionUsage | null>;

/**
 * Pure mapper from Muse SubscriptionUsage payload (from MSP usage/read or usage/changed)
 * to standard ProviderQuotaMeta.
 */
export function museUsageToQuotaMeta(
  usage: MuseSubscriptionUsage | null | undefined,
): ProviderQuotaMeta | undefined {
  if (!usage || typeof usage !== 'object') return undefined;

  let primary: ProviderQuotaWindow | undefined;
  if (usage.window && typeof usage.window === 'object') {
    const w = usage.window;
    const windowDurationMins = typeof w.windowDurationMins === 'number' && w.windowDurationMins > 0
      ? w.windowDurationMins
      : FIVE_HOUR_MINS;
    const usedPercent = typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent)
      ? Math.max(0, w.usedPercent)
      : 0;
    const resetsAt = typeof w.resetsAtMs === 'number' && w.resetsAtMs > 0
      ? Math.floor(w.resetsAtMs / 1000)
      : undefined;

    primary = {
      windowDurationMins,
      usedPercent,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      percentPrecision: 0,
    };
  }

  let secondary: ProviderQuotaWindow | undefined;
  if (usage.weekly && typeof usage.weekly === 'object') {
    const w = usage.weekly;
    const usedPercent = typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent)
      ? Math.max(0, w.usedPercent)
      : 0;
    const resetsAt = typeof w.resetsAtMs === 'number' && w.resetsAtMs > 0
      ? Math.floor(w.resetsAtMs / 1000)
      : undefined;

    secondary = {
      windowDurationMins: SEVEN_DAY_MINS,
      usedPercent,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      percentPrecision: 0,
    };
  }

  if (!primary && !secondary) return undefined;
  return {
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  };
}

export interface MuseAuthCreds {
  apiKey?: string;
  accessToken?: string;
  subsActive?: boolean;
  userEmail?: string;
  userFullName?: string;
}

export function defaultMuseConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg.trim() : join(homedir(), '.config');
  return join(base, 'muse');
}

export async function readMuseAuth(): Promise<MuseAuthCreds | null> {
  try {
    const authPath = join(defaultMuseConfigDir(), 'auth.json');
    if (!existsSync(authPath)) return null;
    const raw = await readFile(authPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const providers = parsed?.providers as Record<string, unknown> | undefined;
    const meta = providers?.meta as Record<string, unknown> | undefined;
    if (!meta || typeof meta !== 'object') return null;

    const apiKey = typeof meta.api_key === 'string' && meta.api_key.trim() ? meta.api_key.trim() : undefined;
    const accessToken = typeof meta.access_token === 'string' && meta.access_token.trim() ? meta.access_token.trim() : undefined;
    const subsActive = meta.subs_active === true;
    const userEmail = typeof meta.user_email === 'string' ? meta.user_email.trim() : undefined;
    const userFullName = typeof meta.user_full_name === 'string' ? meta.user_full_name.trim() : undefined;

    if (apiKey || accessToken || subsActive) {
      return { apiKey, accessToken, subsActive, userEmail, userFullName };
    }
  } catch {
    // Missing or invalid auth.json
  }
  return null;
}

let cache: { at: number; value: MuseUsageQuota | null } | null = null;
let inflight: Promise<MuseUsageQuota | null> | null = null;
let lastActivityAt = 0;
let diskLoaded = false;
let activeReader: MuseUsageReader | null = null;

export function registerMuseUsageReader(reader: MuseUsageReader): () => void {
  activeReader = reader;
  return () => {
    if (activeReader === reader) activeReader = null;
  };
}

export function recordMuseQuotaActivity(now = Date.now()): void {
  lastActivityAt = now;
}

export function getLastMuseQuotaActivityAt(): number {
  return lastActivityAt;
}

function loadPersistedCacheOnce(): void {
  if (diskLoaded) return;
  diskLoaded = true;
  if (cache) return;
  try {
    if (!existsSync(CACHE_PATH)) return;
    const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as { at?: number; value?: MuseUsageQuota | null };
    if (parsed && typeof parsed.at === 'number' && parsed.value && Date.now() - parsed.at < MAX_PERSISTED_AGE_MS) {
      cache = { at: parsed.at, value: parsed.value };
    }
  } catch {
    // missing or unreadable
  }
}

function persistCache(entry: { at: number; value: MuseUsageQuota | null }): void {
  if (!entry.value) return;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(entry), 'utf8');
  } catch (err) {
    logger.debug({ err }, 'muse usage quota cache persist failed');
  }
}

export function synthesizeFallbackQuotaMeta(): ProviderQuotaMeta {
  const now = Date.now();
  const fiveHourSec = Math.floor(now / 1000) + FIVE_HOUR_MINS * 60;
  const sevenDaySec = Math.floor(now / 1000) + SEVEN_DAY_MINS * 60;
  return {
    primary: {
      windowDurationMins: FIVE_HOUR_MINS,
      usedPercent: 0,
      resetsAt: fiveHourSec,
      percentPrecision: 0,
    },
    secondary: {
      windowDurationMins: SEVEN_DAY_MINS,
      usedPercent: 0,
      resetsAt: sevenDaySec,
      percentPrecision: 0,
    },
  };
}

/**
 * Updates the cached Muse usage quota from an observed SubscriptionUsage object.
 * Returns the formatted MuseUsageQuota or null if invalid.
 */
export function updateMuseUsageQuota(
  usage: MuseSubscriptionUsage | null | undefined,
): MuseUsageQuota | null {
  const quotaMeta = museUsageToQuotaMeta(usage);
  if (!quotaMeta) return null;

  const quotaLabel = formatProviderQuotaLabel(quotaMeta);
  const result: MuseUsageQuota = {
    quotaMeta,
    quotaLabel,
    ...(usage?.tier ? { tier: usage.tier } : {}),
  };

  cache = { at: Date.now(), value: result };
  persistCache(cache);
  return result;
}

export async function fetchMuseUsageQuota(opts?: FetchMuseUsageQuotaOptions): Promise<MuseUsageQuota | null> {
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
      // 1. If an active reader (connected Muse MSP host) is registered, query it.
      if (activeReader) {
        try {
          const usage = await activeReader();
          if (usage) {
            const updated = updateMuseUsageQuota(usage);
            if (updated) return updated;
          }
        } catch (err) {
          logger.debug({ err }, 'active muse usage reader query failed');
        }
      }

      // 2. If a cached value exists (even if stale), prefer it over fallback.
      if (cache?.value) {
        return cache.value;
      }

      // 3. Fallback: if valid local Muse auth credentials exist, synthesize standard 5h + 7d windows.
      const auth = await readMuseAuth();
      if (auth) {
        const quotaMeta = synthesizeFallbackQuotaMeta();
        const result: MuseUsageQuota = {
          quotaMeta,
          quotaLabel: formatProviderQuotaLabel(quotaMeta),
        };
        cache = { at: now, value: result };
        persistCache(cache);
        return result;
      }

      return null;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

export function getMuseUsageQuota(force = false): Promise<MuseUsageQuota | null> {
  return fetchMuseUsageQuota({ forceRefresh: force });
}

export function peekMuseUsageQuotaCached(): MuseUsageQuota | null {
  loadPersistedCacheOnce();
  return cache?.value ?? null;
}

export async function refreshMuseQuotaMetadata(
  optsOrForce?: boolean | FetchMuseUsageQuotaOptions,
): Promise<MuseUsageQuota | null> {
  const opts = typeof optsOrForce === 'boolean' ? { forceRefresh: optsOrForce } : optsOrForce;
  const quota = await fetchMuseUsageQuota(opts).catch(() => null);
  if (!quota) return null;

  const { listSessions, upsertSession } = await import('../store/session-store.js');
  const { persistSessionRecord } = await import('./session-manager.js');
  for (const session of listSessions()) {
    if (session.agentType !== 'muse-code-sdk') continue;
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

export function __resetMuseUsageQuotaCache(): void {
  cache = null;
  inflight = null;
  lastActivityAt = 0;
  diskLoaded = false;
  activeReader = null;
  try {
    rmSync(CACHE_PATH, { force: true });
  } catch {
    // ignore
  }
}
