/** Multi-account `gh` CLI token resolution keyed by GitHub repository owner. */
import { repoExecFile } from './repo-exec.js';

const AUTH_CACHE_TTL_MS = 5 * 60_000;
const AUTH_CMD_TIMEOUT_MS = 3000;
const GH_TOKEN_PATTERN = /(?:gh[opurs]_[A-Za-z0-9_]{6,}|github_pat_[A-Za-z0-9_]{6,})/g;

interface CachedGhToken {
  token: string;
  login: string;
  expiresAt: number;
}

const ownerTokenCache = new Map<string, CachedGhToken>();
const inflightOwnerToken = new Map<string, Promise<CachedGhToken | null>>();

/** Reset cached owner-to-token mappings (intended for unit tests). */
export function resetGhAuthCacheForTests(): void {
  ownerTokenCache.clear();
  inflightOwnerToken.clear();
}

/** Whether callers/environment already provide an explicit GitHub token. */
export function hasExplicitGhTokenEnv(): boolean {
  return Boolean(process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim());
}

/** Redact GitHub CLI tokens and an optional resolved secret from diagnostic text. */
export function redactGhTokens(text: string, extraToken?: string): string {
  if (!text) return text;
  let sanitized = text.replace(GH_TOKEN_PATTERN, '[REDACTED]');
  if (extraToken && extraToken.trim().length > 0) {
    sanitized = sanitized.split(extraToken).join('[REDACTED]');
  }
  return sanitized;
}

function getCacheKey(owner: string): string {
  return owner.trim().toLowerCase();
}

function getCachedEntry(key: string): CachedGhToken | null {
  const entry = ownerTokenCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    ownerTokenCache.delete(key);
    return null;
  }
  return entry;
}

function setCachedEntry(key: string, token: string, login: string): CachedGhToken {
  const entry: CachedGhToken = {
    token,
    login,
    expiresAt: Date.now() + AUTH_CACHE_TTL_MS,
  };
  ownerTokenCache.set(key, entry);
  return entry;
}

function isAuthOrNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: number; exitCode?: number; stderr?: string; message?: string };
  const exitCode = e.exitCode ?? e.code;
  if (exitCode === 4) return true;
  const combined = `${e.stderr ?? ''}\n${e.message ?? ''}`;
  return /\b(?:401|404)\b|not found|bad credentials|unauthorized|\bauth\b/i.test(combined);
}

async function fetchGhTokenForUser(login: string, projectDir: string): Promise<string | null> {
  const trimmedLogin = login.trim();
  if (!trimmedLogin) return null;
  try {
    const { stdout } = await repoExecFile(
      'gh',
      ['auth', 'token', '--hostname', 'github.com', '--user', trimmedLogin],
      { cwd: projectDir, timeout: AUTH_CMD_TIMEOUT_MS },
    );
    const token = stdout.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

async function fetchOwnerDirectToken(owner: string, projectDir: string): Promise<CachedGhToken | null> {
  const key = getCacheKey(owner);
  if (!key) return null;

  const existing = inflightOwnerToken.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const token = await fetchGhTokenForUser(owner, projectDir);
    if (!token) return null;
    return setCachedEntry(key, token, owner.trim());
  })();

  inflightOwnerToken.set(key, promise);
  try {
    return await promise;
  } finally {
    if (inflightOwnerToken.get(key) === promise) {
      inflightOwnerToken.delete(key);
    }
  }
}

interface GhHostAccount {
  login?: string;
  state?: string;
  active?: boolean;
}

async function listNonActiveGithubAccounts(projectDir: string, excludeLogin: string): Promise<string[]> {
  try {
    const { stdout } = await repoExecFile(
      'gh',
      ['auth', 'status', '--json', 'hosts'],
      { cwd: projectDir, timeout: AUTH_CMD_TIMEOUT_MS },
    );
    const parsed = JSON.parse(stdout) as { hosts?: Record<string, GhHostAccount[]> };
    const githubEntries = parsed?.hosts?.['github.com'];
    if (!Array.isArray(githubEntries)) return [];

    const excludeLower = excludeLogin.trim().toLowerCase();
    const seen = new Set<string>();
    const logins: string[] = [];

    for (const entry of githubEntries) {
      if (!entry || entry.state !== 'success' || entry.active === true) continue;
      const login = typeof entry.login === 'string' ? entry.login.trim() : '';
      if (!login) continue;
      const lower = login.toLowerCase();
      if (lower === excludeLower || seen.has(lower)) continue;
      seen.add(lower);
      logins.push(login);
    }
    return logins;
  } catch {
    return [];
  }
}

function buildTokenEnv(token: string): NodeJS.ProcessEnv {
  return { ...process.env, GH_TOKEN: token };
}

function sanitizeErrorTokens(err: unknown, tokens: string[]): unknown {
  if (!err || typeof err !== 'object') return err;
  const e = err as { stderr?: string; message?: string };
  if (typeof e.stderr === 'string') {
    let next = redactGhTokens(e.stderr);
    for (const t of tokens) next = redactGhTokens(next, t);
    e.stderr = next;
  }
  if (typeof e.message === 'string') {
    let next = redactGhTokens(e.message);
    for (const t of tokens) next = redactGhTokens(next, t);
    e.message = next;
  }
  return err;
}

/**
 * Execute a `gh` operation with per-owner multi-account token resolution.
 *
 * Resolution order when neither `GH_TOKEN` nor `GITHUB_TOKEN` is explicitly set:
 * 1. Valid in-memory cached token for `owner` (5m TTL).
 * 2. Direct `gh auth token --hostname github.com --user <owner>` match.
 * 3. Default `gh` environment; if it throws 404/auth error, inspect `gh auth status --json hosts`
 *    and try non-active `state === 'success'` `github.com` accounts, caching the first one that succeeds.
 * On 401/404 for a cached/direct token, invalidates the cache entry and falls through once without looping.
 */
export async function withGhOwnerAuth<T>(
  owner: string,
  projectDir: string,
  runGh: (envOverride?: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  if (hasExplicitGhTokenEnv() || !owner.trim()) {
    return runGh(undefined);
  }

  const key = getCacheKey(owner);
  const triedTokens: string[] = [];

  // 1. Try cached token or direct `--user <owner>` match first.
  const cached = getCachedEntry(key);
  let initialEntry = cached;
  let cameFromCache = Boolean(cached);

  if (!initialEntry) {
    initialEntry = await fetchOwnerDirectToken(owner, projectDir);
    cameFromCache = false;
  }

  if (initialEntry) {
    triedTokens.push(initialEntry.token);
    try {
      return await runGh(buildTokenEnv(initialEntry.token));
    } catch (err) {
      if (!isAuthOrNotFoundError(err)) {
        throw sanitizeErrorTokens(err, triedTokens);
      }
      ownerTokenCache.delete(key);

      // If failure came from a stale cached token, try re-resolving direct `--user <owner>` once.
      if (cameFromCache) {
        const refreshed = await fetchOwnerDirectToken(owner, projectDir);
        if (refreshed && refreshed.token !== initialEntry.token) {
          triedTokens.push(refreshed.token);
          try {
            return await runGh(buildTokenEnv(refreshed.token));
          } catch (refreshErr) {
            if (!isAuthOrNotFoundError(refreshErr)) {
              throw sanitizeErrorTokens(refreshErr, triedTokens);
            }
            ownerTokenCache.delete(key);
          }
        }
      }
    }
  }

  // 2. Try default `gh` environment (active account).
  let defaultErr: unknown;
  try {
    return await runGh(undefined);
  } catch (err) {
    if (!isAuthOrNotFoundError(err)) {
      throw sanitizeErrorTokens(err, triedTokens);
    }
    defaultErr = err;
  }

  // 3. Default failed with 404/auth — try non-active `github.com` accounts from `gh auth status --json hosts`.
  const candidateLogins = await listNonActiveGithubAccounts(projectDir, owner);
  for (const login of candidateLogins) {
    const token = await fetchGhTokenForUser(login, projectDir);
    if (!token || triedTokens.includes(token)) continue;
    triedTokens.push(token);
    try {
      const result = await runGh(buildTokenEnv(token));
      setCachedEntry(key, token, login);
      return result;
    } catch {
      // Treat any candidate failure (404/401/429/5xx/etc.) as a candidate miss so
      // remaining accounts are still tried; all-candidate failure throws defaultErr below.
    }
  }

  throw sanitizeErrorTokens(defaultErr, triedTokens);
}
