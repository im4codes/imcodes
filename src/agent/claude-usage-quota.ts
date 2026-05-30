import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProviderQuotaMeta, ProviderQuotaWindow } from '../../shared/provider-quota.js';
import { formatProviderQuotaLabel } from '../../shared/provider-quota.js';
import { getAgentVersion } from './agent-version.js';
import logger from '../util/logger.js';

const execFileAsync = promisify(execFile);

// Private endpoint the Claude Code CLI's /usage uses; only `Authorization:
// Bearer <oauth access token>` is required (verified). Returns the full
// claude.ai subscription picture (5h + weekly windows) proactively — unlike the
// SDK `rate_limit_event`, which only surfaces the weekly window near a limit.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// Account-wide quota — throttle the call to AT MOST once per 30 minutes
// regardless of how many sessions or how often buildSessionList runs.
const CACHE_TTL_MS = 30 * 60 * 1000;
// When no claude-code-sdk session has been used for this long, stop hitting the
// network: serve the last cached snapshot (incl. the disk-persisted one) instead
// of calling /api/oauth/usage. A send to a claude-code-sdk session resumes it.
const IDLE_FETCH_SUPPRESS_MS = 15 * 60 * 1000;
const IS_TEST_ENV = !!process.env.VITEST || process.env.NODE_ENV === 'test';
// Persist the snapshot so a daemon restart (it auto-upgrades often) doesn't lose
// the quota or trigger an immediate re-fetch. Mirrors src/agent/provider-quota.ts.
const CACHE_DIR = join(IS_TEST_ENV ? tmpdir() : homedir(), '.imcodes');
const CACHE_PATH = join(CACHE_DIR, 'claude-usage-quota.json');
const FIVE_HOUR_MINS = 5 * 60;
const SEVEN_DAY_MINS = 7 * 24 * 60;
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

interface UsageWindow { utilization?: number; resets_at?: string }
interface UsageResponse {
  five_hour?: UsageWindow | null;
  seven_day?: UsageWindow | null;
  seven_day_opus?: UsageWindow | null;
  seven_day_sonnet?: UsageWindow | null;
}

export interface ClaudeUsageQuota { quotaLabel?: string; quotaMeta: ProviderQuotaMeta }

function isoToEpochSeconds(iso: string | undefined): number | undefined {
  if (typeof iso !== 'string' || !iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

/**
 * Map the `/api/oauth/usage` payload → shared `ProviderQuotaMeta`.
 *   - `utilization` is already a 0–100 PERCENT (e.g. 26.0) — used as-is.
 *   - `resets_at` is an ISO-8601 string → converted to epoch SECONDS.
 *   - `five_hour` → primary, aggregate `seven_day` (falling back to the
 *     per-model weekly buckets) → secondary.
 * NOTE: this is a DIFFERENT shape from the SDK `rate_limit_event`
 * (epoch-seconds + fraction), so it has its own mapper rather than reusing
 * `claude-rate-limit.ts`.
 */
export function usageEndpointToQuotaMeta(json: UsageResponse | null | undefined): ProviderQuotaMeta | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const toWindow = (w: UsageWindow | null | undefined, windowDurationMins: number): ProviderQuotaWindow | undefined => {
    if (!w || typeof w !== 'object') return undefined;
    const out: ProviderQuotaWindow = { windowDurationMins };
    if (typeof w.utilization === 'number' && Number.isFinite(w.utilization)) out.usedPercent = w.utilization;
    const resetsAt = isoToEpochSeconds(w.resets_at);
    if (resetsAt !== undefined) out.resetsAt = resetsAt;
    return out;
  };
  const primary = toWindow(json.five_hour, FIVE_HOUR_MINS);
  const weekly = json.seven_day ?? json.seven_day_sonnet ?? json.seven_day_opus;
  const secondary = toWindow(weekly, SEVEN_DAY_MINS);
  if (!primary && !secondary) return undefined;
  return { ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}) };
}

interface OauthCreds { accessToken?: string; expiresAt?: number }

function parseClaudeOauthCreds(blob: string): OauthCreds | null {
  try {
    const parsed = JSON.parse(blob) as { claudeAiOauth?: OauthCreds };
    const creds = parsed.claudeAiOauth;
    if (creds && typeof creds.accessToken === 'string' && creds.accessToken) return creds;
  } catch { /* not JSON */ }
  return null;
}

function isExpired(creds: OauthCreds): boolean {
  return typeof creds.expiresAt === 'number' && Number.isFinite(creds.expiresAt) && Date.now() >= creds.expiresAt;
}

/**
 * Best-effort OAuth access-token lookup:
 *   1. `~/.claude/.credentials.json` (Linux + anywhere the file exists).
 *   2. macOS Keychain (`Claude Code-credentials`) — but headless/SSH sessions
 *      usually can't read it (locked login keychain / no GUI for the ACL
 *      prompt), so it's wrapped with a short timeout and failures are silent.
 * Returns undefined when no usable, unexpired token is found → caller falls
 * back to the SDK rate_limit_event quota (option A).
 */
async function readClaudeAccessToken(): Promise<string | undefined> {
  try {
    const raw = await readFile(join(homedir(), '.claude', '.credentials.json'), 'utf8');
    const creds = parseClaudeOauthCreds(raw);
    if (creds?.accessToken && !isExpired(creds)) return creds.accessToken;
  } catch { /* no file (e.g. macOS, which uses the Keychain) */ }

  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync(
        'security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
        { timeout: 3000 },
      );
      const creds = parseClaudeOauthCreds(stdout);
      if (creds?.accessToken && !isExpired(creds)) return creds.accessToken;
    } catch { /* locked / not found / timed out — best effort */ }
  }
  return undefined;
}

// Mimic the Claude Code CLI's request headers as closely as practical (the
// values were read from the CLI binary): `claude-cli/<ver> (external, cli)`
// UA, `x-app: cli`, the OAuth beta gate, and the API version. Only the bearer
// token is strictly required, but matching the CLI keeps us robust if the
// endpoint later tightens header checks.
async function claudeCliHeaders(token: string): Promise<Record<string, string>> {
  const rawVersion = await getAgentVersion('claude-code').catch(() => undefined);
  const version = rawVersion?.match(/\d+\.\d+\.\d+/)?.[0];
  return {
    Authorization: `Bearer ${token}`,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20',
    'user-agent': version ? `claude-cli/${version} (external, cli)` : 'claude-cli (external, cli)',
    'x-app': 'cli',
  };
}

// Opt-in gate (default OFF). The weekly quota reads the local Claude OAuth
// token, so we touch NOTHING until the user explicitly authorizes it. The web
// sets this (driven by the per-user `claude_weekly_quota` preference) on every
// (re)connect and on toggle.
let optedIn = false;

let cache: { at: number; value: ClaudeUsageQuota | null } | null = null;
let inflight: Promise<ClaudeUsageQuota | null> | null = null;
// Idle until the first claude-code-sdk session activity (a send to one). While
// idle we never hit /api/oauth/usage — we serve the last cached/persisted snapshot.
let lastActivityAt = 0;
let diskLoaded = false;

/**
 * Mark that a claude-code-sdk session was just used (called from the daemon's
 * session.send path, gated to claude-code-sdk only). Resumes proactive quota
 * fetching after an idle window.
 */
export function recordClaudeQuotaActivity(now = Date.now()): void {
  lastActivityAt = now;
}

/** Lazily seed the in-memory cache from the persisted snapshot (once). */
function loadPersistedCacheOnce(): void {
  if (diskLoaded) return;
  diskLoaded = true;
  if (cache) return;
  try {
    if (!existsSync(CACHE_PATH)) return;
    const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as { at?: number; value?: ClaudeUsageQuota | null };
    if (parsed && typeof parsed.at === 'number' && parsed.value && Date.now() - parsed.at < CACHE_TTL_MS) {
      cache = { at: parsed.at, value: parsed.value };
    }
  } catch { /* missing / unreadable / bad json — treat as no cache */ }
}

/** Persist a SUCCESSFUL snapshot so it survives a daemon restart. */
function persistCache(entry: { at: number; value: ClaudeUsageQuota | null }): void {
  if (!entry.value) return; // never persist a null/failed snapshot
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(entry), 'utf8');
  } catch (err) { logger.debug({ err }, 'claude usage quota cache persist failed'); }
}

function deletePersistedCache(): void {
  try { rmSync(CACHE_PATH, { force: true }); } catch { /* ignore */ }
}

export function setClaudeUsageQuotaOptIn(enabled: boolean): void {
  if (optedIn === enabled) return;
  optedIn = enabled;
  // Re-evaluate under the new state on the next call rather than serving a
  // stale (or stale-null) snapshot from before the toggle.
  cache = null;
  inflight = null;
  diskLoaded = false;
  if (enabled) {
    // The user just authorized it — treat as activity so the next call fetches
    // immediately rather than being suppressed by the idle gate.
    lastActivityAt = Date.now();
  } else {
    // Revoked — drop the persisted snapshot too (privacy: stop showing it).
    deletePersistedCache();
  }
}

async function fetchUsageQuota(): Promise<ClaudeUsageQuota | null> {
  const token = await readClaudeAccessToken();
  if (!token) return null;
  try {
    const res = await fetch(USAGE_URL, {
      headers: await claudeCliHeaders(token),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as UsageResponse;
    const quotaMeta = usageEndpointToQuotaMeta(json);
    if (!quotaMeta) return null;
    return { quotaMeta, quotaLabel: formatProviderQuotaLabel(quotaMeta) };
  } catch (err) {
    logger.debug({ err }, 'claude usage quota fetch failed');
    return null;
  }
}

/**
 * Best-effort claude.ai subscription quota (5h + weekly, proactive) for
 * claude-code-sdk, throttled to ≤1 request / 30 min (account-wide). Returns
 * null when the token is unreachable (e.g. headless macOS Keychain) or the call
 * fails — callers then fall back to the SDK rate_limit_event quota (option A).
 * The cache stores null too, so a failed attempt still counts against the
 * 30-minute throttle (no retry storms).
 */
export async function getClaudeUsageQuota(force = false): Promise<ClaudeUsageQuota | null> {
  // Off by default — no token read, no network — until the user authorizes it.
  if (!optedIn) return null;
  loadPersistedCacheOnce();
  const now = Date.now();
  // Fresh cache (incl. one seeded from disk after a restart) → serve, no network.
  if (!force && cache && now - cache.at < CACHE_TTL_MS) return cache.value;
  // Idle gate: no claude-code-sdk session activity for a while → don't hit the
  // endpoint; serve the last known snapshot (possibly stale). A send resumes it.
  if (!force && now - lastActivityAt > IDLE_FETCH_SUPPRESS_MS) return cache?.value ?? null;
  if (inflight) return inflight;
  inflight = (async () => {
    const value = await fetchUsageQuota();
    if (value) {
      cache = { at: Date.now(), value };
      persistCache(cache);
    } else {
      // Failed/empty fetch: keep the last good snapshot rather than blanking the
      // footer — just advance the timestamp so the 30-min throttle still holds.
      // A transient token / network / 429 blip must not make the quota flicker.
      cache = { at: Date.now(), value: cache?.value ?? null };
    }
    return cache.value;
  })().finally(() => { inflight = null; });
  return inflight;
}

/** Test seam — clear the throttle cache. */
export function __resetClaudeUsageQuotaCache(): void {
  cache = null;
  inflight = null;
  diskLoaded = false;
  lastActivityAt = 0;
  deletePersistedCache();
}
