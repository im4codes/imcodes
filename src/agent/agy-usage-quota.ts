import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { ProviderQuotaGroup, ProviderQuotaMeta, ProviderQuotaWindow } from '../../shared/provider-quota.js';
import { formatProviderQuotaLabel } from '../../shared/provider-quota.js';
import {
  AGY_USAGE_CACHE_FILE_NAME,
  AGY_USAGE_CACHE_TTL_MS,
  AGY_USAGE_CLI_ARGS,
  AGY_USAGE_FAILURE_BACKOFF_MS,
  AGY_USAGE_IDLE_SUPPRESS_MS,
  AGY_USAGE_KNOWN_GROUP_ORDER,
  AGY_USAGE_MAX_PERSISTED_AGE_MS,
  AGY_USAGE_TIMEOUT_MS,
  AGY_USAGE_TIER_TO_GROUP_ID,
  AGY_USAGE_TIER_TO_GROUP_LABEL,
  AGY_USAGE_WINDOW_LABEL,
  AGY_USAGE_WINDOW_MINS,
} from '../../shared/agy-usage.js';
import { resolveAgyBinary } from './providers/agy-sdk.js';
import { execFileOffMain } from '../util/exec-helper.js';
import { imcodesStateDir, imcodesStatePath } from '../util/imcodes-state-dir.js';
import logger from '../util/logger.js';

export interface AgyUsageQuota {
  quotaLabel?: string;
  quotaMeta: ProviderQuotaMeta;
}

export type AgyUsageExecFn = (
  file: string,
  args: string[],
  options: { timeout: number; cwd: string },
) => Promise<{ stdout: string; stderr: string }>;

export type FetchAgyUsageQuotaOptions = {
  forceRefresh?: boolean;
  execFn?: AgyUsageExecFn;
};

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'tier';
}

export function parseResetTimestamp(raw: string): number | undefined {
  const str = raw.trim();
  if (!str) return undefined;
  if (/Z|[+-]\d{2}:?\d{2}$/i.test(str)) {
    const ms = Date.parse(str);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
  }
  const match = str.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\s+[A-Za-z]+)?$/);
  if (match) {
    const localIso = `${match[1]}T${match[2].length === 5 ? match[2] + ':00' : match[2]}`;
    const d = new Date(localIso);
    const ms = d.getTime();
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  const parsedMs = Date.parse(str);
  return Number.isFinite(parsedMs) ? Math.floor(parsedMs / 1000) : undefined;
}

/**
 * Pure parser for `agy --print /usage` output (TSV or multi-space aligned columns).
 * Formats: 4 columns per line:
 *   `<Tier Label>\t<Window Label>\t<Remaining%>\t<Reset Time>`
 *
 * Rules:
 * - Lines not having exactly 4 tab- or multi-space-delimited columns are ignored.
 * - Known tiers mapped via PROVIDER_QUOTA_GROUP_ID; known order is Gemini first, then Claude/GPT.
 * - Unknown tiers get id = slug(rawLabel), label = rawLabel, appended after known groups in encounter order.
 * - Unknown window labels are ignored.
 * - Tiers with no valid windows are omitted.
 * - Used percent = clamp(0, 100, 100 - remainingPercent).
 * - Reset timestamp converted to epoch seconds (supporting ISO UTC and local time like "YYYY-MM-DD HH:mm CST").
 * - Returns undefined if no valid groups exist.
 * - Does NOT set legacy primary/secondary on the returned ProviderQuotaMeta.
 */
export function parseAgyUsageTsv(stdout: string | null | undefined): ProviderQuotaMeta | undefined {
  if (typeof stdout !== 'string' || !stdout.trim()) return undefined;

  const lines = stdout.split(/\r?\n/);
  const groupMap = new Map<string, {
    id: string;
    label: string;
    primary?: ProviderQuotaWindow;
    secondary?: ProviderQuotaWindow;
    order: number;
  }>();

  let unknownOrderCounter = AGY_USAGE_KNOWN_GROUP_ORDER.length;

  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;
    const cols = rawLine.includes('\t')
      ? rawLine.split('\t')
      : rawLine.trim().split(/\s{2,}/);
    if (cols.length !== 4) continue;

    const [rawTier, rawWindow, rawRemaining, rawResetsAt] = cols;
    const tier = rawTier.trim();
    const windowLabel = rawWindow.trim();
    const percentStr = rawRemaining.trim();
    const resetsAtStr = rawResetsAt.trim();

    // Map window label
    let windowDurationMins: number | undefined;
    let isPrimary: boolean | undefined;
    if (windowLabel === AGY_USAGE_WINDOW_LABEL.FIVE_HOUR) {
      windowDurationMins = AGY_USAGE_WINDOW_MINS.FIVE_HOUR;
      isPrimary = true;
    } else if (windowLabel === AGY_USAGE_WINDOW_LABEL.WEEKLY) {
      windowDurationMins = AGY_USAGE_WINDOW_MINS.WEEKLY;
      isPrimary = false;
    } else {
      continue;
    }

    // Remaining percent -> used percent (100 - remaining, clamp 0..100)
    const remainingNum = parseFloat(percentStr.replace('%', '').trim());
    if (!Number.isFinite(remainingNum)) continue;
    const usedPercent = Math.max(0, Math.min(100, Math.round((100 - remainingNum) * 100) / 100));

    // Resets at -> epoch seconds
    const resetsAt = parseResetTimestamp(resetsAtStr);

    const quotaWindow: ProviderQuotaWindow = {
      windowDurationMins,
      usedPercent,
      percentPrecision: 2,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    };

    const knownGroupId = AGY_USAGE_TIER_TO_GROUP_ID[tier];
    let groupId: string;
    let groupLabel: string;
    let order: number;

    if (knownGroupId) {
      groupId = knownGroupId;
      groupLabel = AGY_USAGE_TIER_TO_GROUP_LABEL[tier] ?? tier;
      order = AGY_USAGE_KNOWN_GROUP_ORDER.indexOf(knownGroupId);
      if (order < 0) order = 0;
    } else {
      groupId = slugify(tier);
      groupLabel = tier;
      const existing = groupMap.get(groupId);
      order = existing ? existing.order : unknownOrderCounter++;
    }

    let group = groupMap.get(groupId);
    if (!group) {
      group = { id: groupId, label: groupLabel, order };
      groupMap.set(groupId, group);
    }

    if (isPrimary) {
      group.primary = quotaWindow;
    } else {
      group.secondary = quotaWindow;
    }
  }

  const validGroups: ProviderQuotaGroup[] = [];
  const sortedEntries = Array.from(groupMap.values()).sort((a, b) => a.order - b.order);

  for (const entry of sortedEntries) {
    if (!entry.primary && !entry.secondary) continue;
    validGroups.push({
      id: entry.id,
      label: entry.label,
      ...(entry.primary ? { primary: entry.primary } : {}),
      ...(entry.secondary ? { secondary: entry.secondary } : {}),
    });
  }

  if (validGroups.length === 0) return undefined;
  return { groups: validGroups };
}

async function defaultExecAgyProbe(
  file: string,
  args: string[],
  options: { timeout: number; cwd: string },
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileOffMain(file, args, {
    cwd: options.cwd,
    env: process.env,
    timeout: options.timeout,
    maxBuffer: 1024 * 1024,
  });
  return {
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

let cache: { at: number; value: AgyUsageQuota | null } | null = null;
let inflight: Promise<AgyUsageQuota | null> | null = null;
let lastActivityAt = 0;
let lastFailureAt = 0;
let diskLoaded = false;
let customExecFn: AgyUsageExecFn | null = null;

export function recordAgyQuotaActivity(now = Date.now()): void {
  lastActivityAt = now;
}

export function peekAgyUsageQuotaCached(): AgyUsageQuota | null {
  loadPersistedCacheOnce();
  return cache?.value ?? null;
}

export function setAgyUsageExecFn(fn: AgyUsageExecFn | null): void {
  customExecFn = fn;
}

function loadPersistedCacheOnce(): void {
  if (diskLoaded) return;
  diskLoaded = true;
  if (cache) return;
  try {
    const cachePath = imcodesStatePath(AGY_USAGE_CACHE_FILE_NAME);
    if (!existsSync(cachePath)) return;
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as { at?: number; value?: AgyUsageQuota | null };
    if (
      parsed
      && typeof parsed.at === 'number'
      && parsed.value
      && Date.now() - parsed.at < AGY_USAGE_MAX_PERSISTED_AGE_MS
    ) {
      cache = { at: parsed.at, value: parsed.value };
    }
  } catch {
    // Missing, unreadable, or invalid JSON — treat as no cache
  }
}

function persistCache(entry: { at: number; value: AgyUsageQuota | null }): void {
  if (!entry.value) return;
  try {
    const cacheDir = imcodesStateDir();
    const cachePath = imcodesStatePath(AGY_USAGE_CACHE_FILE_NAME);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath, JSON.stringify(entry), 'utf8');
  } catch (err) {
    logger.debug({ err }, 'agy usage quota cache persist failed');
  }
}

function deletePersistedCache(): void {
  try {
    rmSync(imcodesStatePath(AGY_USAGE_CACHE_FILE_NAME), { force: true });
  } catch {
    // ignore
  }
}

async function executeProbe(execFn?: AgyUsageExecFn): Promise<string> {
  const runner = execFn ?? customExecFn ?? defaultExecAgyProbe;
  const { executable, prependArgs } = resolveAgyBinary();
  const args = [...prependArgs, ...AGY_USAGE_CLI_ARGS];
  const stateDir = imcodesStateDir();
  const cwd = existsSync(stateDir) ? stateDir : tmpdir();
  const { stdout } = await runner(executable, args, { timeout: AGY_USAGE_TIMEOUT_MS, cwd });
  return stdout;
}

/**
 * Fetches usage quota snapshot from `agy --print /usage`.
 *
 * Guarantees:
 * - Single-flight: concurrent callers share one in-flight probe.
 * - TTL cache (15 min): serves memory/disk cache without hitting process.
 * - Persisted snapshot: survives daemon restart, dropped if older than 24h.
 * - Failure backoff (5 min): prevents retry storms on auth/network errors.
 * - Idle suppression (15 min): only probes when an agy-sdk session was active recently.
 * - On-demand forceRefresh: bypasses TTL, backoff, and idle gate.
 * - Never throws to callers; returns last good snapshot on error.
 */
export async function fetchAgyUsageQuota(
  optsOrForce?: boolean | FetchAgyUsageQuotaOptions,
): Promise<AgyUsageQuota | null> {
  const force = typeof optsOrForce === 'boolean' ? optsOrForce : !!optsOrForce?.forceRefresh;
  const execFn = typeof optsOrForce === 'object' && optsOrForce ? optsOrForce.execFn : undefined;

  loadPersistedCacheOnce();
  const now = Date.now();

  // Fresh cache (served within TTL unless forceRefresh)
  if (!force && cache && now - cache.at < AGY_USAGE_CACHE_TTL_MS) {
    return cache.value;
  }

  // Failure backoff
  if (!force && lastFailureAt > 0 && now - lastFailureAt < AGY_USAGE_FAILURE_BACKOFF_MS) {
    return cache?.value ?? null;
  }

  // Idle suppression: no agy-sdk session active within the idle window
  if (!force && (lastActivityAt === 0 || now - lastActivityAt > AGY_USAGE_IDLE_SUPPRESS_MS)) {
    return cache?.value ?? null;
  }

  // Single flight
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const stdout = await executeProbe(execFn);
      const quotaMeta = parseAgyUsageTsv(stdout);
      if (quotaMeta) {
        const quotaLabel = formatProviderQuotaLabel(quotaMeta);
        const value: AgyUsageQuota = { quotaMeta, ...(quotaLabel ? { quotaLabel } : {}) };
        cache = { at: Date.now(), value };
        persistCache(cache);
        lastFailureAt = 0;
        return cache.value;
      }
      lastFailureAt = Date.now();
      return cache?.value ?? null;
    } catch (err) {
      logger.debug({ err }, 'agy usage quota fetch failed');
      lastFailureAt = Date.now();
      return cache?.value ?? null;
    }
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

/**
 * Refresh quota metadata for all agy-sdk sessions, and persist/broadcast any change.
 * Throttled by TTL cache so calling it on turn completion is safe and non-blocking.
 */
export async function refreshAgyQuotaMetadata(force = false): Promise<AgyUsageQuota | null> {
  const quota = await fetchAgyUsageQuota(force).catch(() => null);
  if (!quota) return null;
  const { listSessions, upsertSession } = await import('../store/session-store.js');
  const { persistSessionRecord } = await import('./session-manager.js');
  const { providerQuotaMetaEquals } = await import('../../shared/provider-quota.js');
  for (const session of listSessions()) {
    if (session.agentType !== 'agy-sdk') continue;
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

/** Test seam — reset cache and activity state. */
export function __resetAgyUsageQuotaCache(): void {
  cache = null;
  inflight = null;
  diskLoaded = false;
  lastActivityAt = 0;
  lastFailureAt = 0;
  customExecFn = null;
  deletePersistedCache();
}
