import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
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

export function setClaudeUsageQuotaOptIn(enabled: boolean): void {
  if (optedIn === enabled) return;
  optedIn = enabled;
  // Re-evaluate under the new state on the next call rather than serving a
  // stale (or stale-null) snapshot from before the toggle.
  cache = null;
  inflight = null;
}

let cache: { at: number; value: ClaudeUsageQuota | null } | null = null;
let inflight: Promise<ClaudeUsageQuota | null> | null = null;

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
  const now = Date.now();
  if (!force && cache && now - cache.at < CACHE_TTL_MS) return cache.value;
  if (inflight) return inflight;
  inflight = (async () => {
    const value = await fetchUsageQuota();
    cache = { at: Date.now(), value };
    return value;
  })().finally(() => { inflight = null; });
  return inflight;
}

/** Test seam — clear the throttle cache. */
export function __resetClaudeUsageQuotaCache(): void {
  cache = null;
  inflight = null;
}
