/**
 * Fetch wrapper with cookie-based auth for the IM.codes API.
 * Credentials are sent automatically via HttpOnly cookie.
 * CSRF token is read from cookie and sent as X-CSRF-Token.
 */

import { COOKIE_SESSION, COOKIE_CSRF, HEADER_CSRF } from '@shared/cookie-names.js';
import { CLIENT_TIMEZONE_HEADER } from '@shared/http-header-names.js';
import { normalizeClientTimezone } from '@shared/client-timezone.js';
import { PREVIEW_ACCESS_TOKEN_QUERY_PARAM } from '@shared/preview-types.js';
import { getSessionRuntimeType } from '@shared/agent-types.js';
import type {
  TimelineCursor,
  TimelineDetailRef,
  TimelinePayloadMetadata,
} from '@shared/timeline-protocol.js';
import type { ContextMemoryView, ContextModelConfig } from '@shared/context-types.js';
import type { AuthoredContextScope } from '@shared/memory-scope.js';
import type { SharedContextRuntimeConfigSnapshot } from '@shared/shared-context-runtime-config.js';
import { isNative } from './native.js';
import {
  SUPERVISION_USER_DEFAULT_PREF_KEY,
  normalizeSupervisorDefaultConfig,
  parseSupervisorDefaultConfig,
  type SupervisorDefaultConfig,
} from '@shared/supervision-config.js';
import type { ShareGrantSummary, ShareRole, ShareTarget } from './tab-sharing-ui.js';

let _baseUrl = '';
let _onAuthExpired: ((reason?: string) => void) | null = null;
let _apiKey: string | null = null;
type AuthTelemetryHeaders = {
  'X-Platform': string;
  'X-App-Version': string;
  'X-Bundle-Version': string;
};
let _authTelemetryHeadersCache: AuthTelemetryHeaders | null = null;
let _authTelemetryHeadersPromise: Promise<AuthTelemetryHeaders> | null = null;

// Hydrate API key from localStorage on module load so it's available before
// any async Capacitor Preferences read completes. This prevents race conditions
// where apiFetch is called before configureApiKey() in the native init effect.
try {
  const stored = localStorage.getItem('rcc_api_key');
  if (stored && isNative()) {
    _apiKey = stored;
  } else if (stored) {
    localStorage.removeItem('rcc_api_key');
  }
} catch { /* SSR or restricted storage */ }

/** Set a Bearer API key for native app auth (replaces cookie+CSRF). */
export function configureApiKey(key: string): void {
  _apiKey = key;
  try { localStorage.setItem('rcc_api_key', key); } catch { /* ignore */ }
}
/** Temporarily use a Bearer API key without persisting it to storage. */
export async function withTemporaryApiKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = _apiKey;
  _apiKey = key;
  try {
    return await fn();
  } finally {
    _apiKey = previous;
  }
}
/** Clear the Bearer API key (reverts to cookie auth). */
export function clearApiKey(): void {
  _apiKey = null;
  try { localStorage.removeItem('rcc_api_key'); } catch { /* ignore */ }
}

/** Return the currently configured Bearer API key, if any. */
export function getApiKey(): string | null {
  return _apiKey;
}

const TELEMETRY_FALLBACK: AuthTelemetryHeaders = { 'X-Platform': 'unknown', 'X-App-Version': 'unknown', 'X-Bundle-Version': 'none' };

async function getAuthTelemetryHeaders(): Promise<AuthTelemetryHeaders> {
  if (_authTelemetryHeadersCache) return _authTelemetryHeadersCache;
  if (!_authTelemetryHeadersPromise) {
    // Race against a 2s timeout — telemetry must never block auth requests
    const collect = (async () => {
      const platform = typeof (globalThis as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform === 'function'
        ? (globalThis as { Capacitor?: { getPlatform?: () => string } }).Capacitor!.getPlatform!()
        : 'web';

      let appVersion = 'web';
      try {
        const { App } = await import('@capacitor/app');
        const info = await App.getInfo();
        appVersion = String((info as { version?: string; build?: string }).version ?? (info as { version?: string; build?: string }).build ?? 'unknown');
      } catch {
        appVersion = 'web';
      }

      let bundleVersion = 'none';
      try {
        const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
        const current = await CapacitorUpdater.current();
        const bundle = current?.bundle;
        if (bundle?.id && bundle.id !== 'builtin') {
          bundleVersion = String(bundle.version ?? bundle.id);
        }
      } catch {
        bundleVersion = 'none';
      }

      const headers: AuthTelemetryHeaders = { 'X-Platform': platform, 'X-App-Version': appVersion, 'X-Bundle-Version': bundleVersion };
      _authTelemetryHeadersCache = headers;
      return headers;
    })();
    const timeout = new Promise<AuthTelemetryHeaders>((resolve) => setTimeout(() => resolve(TELEMETRY_FALLBACK), 2000));
    _authTelemetryHeadersPromise = Promise.race([collect, timeout]).finally(() => {
      _authTelemetryHeadersPromise = null;
    });
  }
  return _authTelemetryHeadersPromise;
}

export function configure(baseUrl: string): void {
  _baseUrl = baseUrl.replace(/\/$/, '');
}

/** Return the configured API base URL, or the current origin when same-origin. */
export function getApiBaseUrl(): string {
  return _baseUrl || window.location.origin;
}

export async function buildAttachmentDownloadUrl(serverId: string, attachmentId: string): Promise<string> {
  const encodedServerId = encodeURIComponent(serverId);
  const encodedAttachmentId = encodeURIComponent(attachmentId);
  const baseUrl = _baseUrl || window.location.origin;
  if (!isNative()) {
    return `${baseUrl}/api/server/${encodedServerId}/uploads/${encodedAttachmentId}/download`;
  }
  const tokenRes = await apiFetch(`/api/server/${encodedServerId}/uploads/${encodedAttachmentId}/download-token`, { method: 'POST' });
  const downloadToken = (tokenRes as { token?: string }).token;
  if (!downloadToken || typeof downloadToken !== 'string' || downloadToken.length < 32) {
    throw new Error('Failed to acquire download token');
  }
  return `${baseUrl}/api/server/${encodedServerId}/uploads/${encodedAttachmentId}/download?token=${encodeURIComponent(downloadToken)}`;
}

/** Normalize the initial preview document path so it always starts with `/` and preserves query/hash. */
export function normalizeLocalWebPreviewPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return '/';
  try {
    const url = new URL(trimmed, 'http://localhost.invalid/');
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  }
}

/** Build the same-origin or absolute proxy URL for a local web preview. */
export function buildLocalWebPreviewProxyUrl(serverId: string, previewId: string, path = '/', accessToken?: string): string {
  return buildLocalWebPreviewProxyUrlWithToken(serverId, previewId, path, accessToken);
}

export function buildLocalWebPreviewProxyUrlWithToken(serverId: string, previewId: string, path = '/', accessToken?: string): string {
  const base = getApiBaseUrl();
  const normalizedPath = normalizeLocalWebPreviewPath(path);
  const url = new URL(`${base}/api/server/${encodeURIComponent(serverId)}/local-web/${encodeURIComponent(previewId)}${normalizedPath}`);
  if (accessToken) {
    url.searchParams.set(PREVIEW_ACCESS_TOKEN_QUERY_PARAM, accessToken);
  }
  return url.toString();
}

/** Register a callback invoked when the session expires and refresh fails. */
export function onAuthExpired(cb: (reason?: string) => void): void {
  _onAuthExpired = cb;
}

function getCsrfToken(): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_CSRF}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

// Single-flight lock: at most one refresh in progress at a time (per tab).
let refreshPromise: Promise<boolean> | null = null;

// Cross-tab mutex: prevent multiple tabs from refreshing simultaneously.
// Uses BroadcastChannel to coordinate — only one tab refreshes at a time.
const _refreshChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('imcodes-auth-refresh') : null;
let _crossTabRefreshLocked = false;
_refreshChannel?.addEventListener('message', (e) => {
  if (e.data === 'refresh-start') _crossTabRefreshLocked = true;
  if (e.data === 'refresh-done') {
    _crossTabRefreshLocked = false;
    _lastRefreshAt = Date.now(); // other tab refreshed successfully
  }
});

// Track the last successful refresh timestamp to rate-limit proactive refreshes.
let _lastRefreshAt = 0;

async function doRefresh(): Promise<boolean> {
  // If another tab is refreshing, wait briefly for it to finish
  if (_crossTabRefreshLocked) {
    await new Promise((r) => setTimeout(r, 1500));
    if (_crossTabRefreshLocked) return true; // still locked, assume other tab handled it
    return true; // other tab finished
  }
  _refreshChannel?.postMessage('refresh-start');
  const hasCsrf = !!getCsrfToken();
  const hasSession = document.cookie.includes(COOKIE_SESSION);
  const hasRefresh = document.cookie.includes('rcc_refresh');
  console.warn(`[auth] doRefresh: cookies present: session=${hasSession} refresh=${hasRefresh} csrf=${hasCsrf}`);

  // Use rawFetch so the CSRF token is automatically attached
  const res = await rawFetch('/api/auth/refresh', { method: 'POST' });
  // 5xx means server is temporarily unavailable, not that the session expired.
  // Throw so callers can distinguish "no session" (false) from "server down" (throws).
  if (res.status >= 500) {
    const body = await res.text().catch(() => '');
    console.warn(`[auth] doRefresh: server error ${res.status}: ${body}`);
    throw new ApiError(res.status, body);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn(`[auth] doRefresh FAILED: ${res.status}: ${body}`);
    _refreshChannel?.postMessage('refresh-done');
  } else {
    _lastRefreshAt = Date.now();
    console.warn(`[auth] doRefresh OK — token refreshed`);
    _refreshChannel?.postMessage('refresh-done');
  }
  return res.ok;
}

/** Attempt a token refresh. Returns true if successful. Exported for use by WsClient. */
export async function refreshSession(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = doRefresh().finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

/**
 * Refresh the session only if the last refresh was more than minAgeMs ago.
 * Returns true if the session is (or was already) fresh.
 * Use this for proactive/voluntary refreshes (startup, visibility-change) to avoid
 * unnecessary token rotation. For forced refreshes (401 responses) use refreshSession().
 */
export async function refreshSessionIfStale(minAgeMs = 2 * 60 * 1000): Promise<boolean> {
  if (Date.now() - _lastRefreshAt < minAgeMs) return true; // recently refreshed, skip
  return refreshSession();
}

// ── Proactive refresh ─────────────────────────────────────────────────────

let _refreshTimerId: ReturnType<typeof setInterval> | null = null;
let _retryTimerId: ReturnType<typeof setTimeout> | null = null;
const PROACTIVE_REFRESH_MS = 15 * 60 * 1000; // refresh every 15 min (well before 4-hour expiry)
const RETRY_REFRESH_MS = 30 * 1000; // retry failed refresh after 30s

/** Start proactive token refresh timer. Call when user logs in. */
export function startProactiveRefresh(): void {
  // Native app uses Bearer API key — no cookie session to refresh.
  if (_apiKey) return;
  stopProactiveRefresh();
  // Don't refresh immediately on startup — /me endpoint validates the session.
  // First proactive refresh happens after PROACTIVE_REFRESH_MS (15 min).
  // Immediate refresh on startup caused race conditions with /me and other
  // concurrent requests, especially in multi-tab scenarios.
  _refreshTimerId = setInterval(() => {
    void refreshSession().then((ok) => {
      if (!ok) scheduleRetry();
    });
  }, PROACTIVE_REFRESH_MS);
}

/** Schedule a quick retry when proactive refresh fails (not from 401 handler). */
function scheduleRetry(): void {
  if (_retryTimerId !== null) return; // already scheduled
  _retryTimerId = setTimeout(() => {
    _retryTimerId = null;
    void refreshSession(); // single retry, no cascade
  }, RETRY_REFRESH_MS);
}

/** Stop proactive token refresh timer. Call when user logs out. */
export function stopProactiveRefresh(): void {
  if (_refreshTimerId !== null) {
    clearInterval(_refreshTimerId);
    _refreshTimerId = null;
  }
  if (_retryTimerId !== null) {
    clearTimeout(_retryTimerId);
    _retryTimerId = null;
  }
}

async function rawFetch(path: string, opts: RequestInit = {}, baseUrl = _baseUrl): Promise<Response> {
  const headers = new Headers(opts.headers);
  if (!headers.has('Content-Type') && opts.body && !(opts.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (!headers.has(CLIENT_TIMEZONE_HEADER)) {
    try {
      const timezone = normalizeClientTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
      if (timezone) headers.set(CLIENT_TIMEZONE_HEADER, timezone);
    } catch { /* restricted or incomplete Intl runtime — cron writes still carry their explicit body value */ }
  }
  if (path.startsWith('/api/auth/') && !path.includes('ws-ticket')) {
    try {
      const telemetry = await getAuthTelemetryHeaders();
      for (const [key, value] of Object.entries(telemetry)) {
        if (!headers.has(key)) headers.set(key, value);
      }
    } catch { /* telemetry headers are best-effort — don't block auth requests */ }
  }
  if (_apiKey) {
    // Native: Bearer token auth (CSRF middleware skips Bearer auth requests)
    headers.set('Authorization', `Bearer ${_apiKey}`);
  } else {
    // Web: cookie auth + CSRF token
    const method = (opts.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const csrf = getCsrfToken();
      if (csrf) headers.set(HEADER_CSRF, csrf);
    }
  }
  // Native (Bearer auth): omit credentials — no cookies needed, and 'include' would
  // require Access-Control-Allow-Credentials from the server (cross-origin from capacitor://).
  // Web (cookie auth): include credentials so HttpOnly cookies are sent.
  return fetch(`${baseUrl}${path}`, { ...opts, headers, credentials: _apiKey ? 'omit' : 'include' });
}

export interface LocalWebPreviewCreateResponse {
  previewId: string;
  previewUrl?: string;
  previewAccessToken?: string;
  serverId?: string;
  port: number;
  path: string;
  expiresAt?: string | number | null;
}

interface RawLocalWebPreviewCreateResponse {
  ok?: boolean;
  preview?: {
    id: string;
    url?: string;
    accessToken?: string;
    serverId?: string;
    port: number;
    path: string;
    expiresAt?: string | number | null;
  };
  previewId?: string;
  previewUrl?: string;
  previewAccessToken?: string;
  serverId?: string;
  port?: number;
  path?: string;
  expiresAt?: string | number | null;
}

export interface LocalWebPreviewCloseResponse {
  ok: true;
}

export interface NativeAuthExchangeResponse {
  apiKey: string;
  userId: string;
  keyId: string;
}

export async function createLocalWebPreview(
  serverId: string,
  port: number,
  path = '/',
): Promise<LocalWebPreviewCreateResponse> {
  const response = await apiFetch<RawLocalWebPreviewCreateResponse>(`/api/server/${encodeURIComponent(serverId)}/local-web-preview`, {
    method: 'POST',
    body: JSON.stringify({ port, path: normalizeLocalWebPreviewPath(path) }),
  });

  if (response.preview) {
    return {
      previewId: response.preview.id,
      previewUrl: response.preview.url,
      previewAccessToken: response.preview.accessToken,
      serverId: response.preview.serverId,
      port: response.preview.port,
      path: response.preview.path,
      expiresAt: response.preview.expiresAt,
    };
  }

  if (response.previewId && typeof response.port === 'number' && typeof response.path === 'string') {
    return {
      previewId: response.previewId,
      previewUrl: response.previewUrl,
      previewAccessToken: response.previewAccessToken,
      serverId: response.serverId,
      port: response.port,
      path: response.path,
      expiresAt: response.expiresAt,
    };
  }

  throw new Error('Invalid preview create response');
}

export async function closeLocalWebPreview(serverId: string, previewId: string): Promise<LocalWebPreviewCloseResponse> {
  return apiFetch(`/api/server/${encodeURIComponent(serverId)}/local-web-preview/${encodeURIComponent(previewId)}`, {
    method: 'DELETE',
  });
}

export async function apiFetch<T = unknown>(
  path: string,
  opts: RequestInit = {},
): Promise<T> {
  const res = await rawFetch(path, opts);

  if (res.status === 401 && path !== '/api/auth/refresh') {
    console.warn(`[auth] 401 on ${path} — attempting refresh`);
    // Try to refresh the token (with one retry on failure).
    // A single failure might be transient (e.g., CSRF mismatch after cookie rotation).
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!refreshPromise) {
        refreshPromise = doRefresh().finally(() => { refreshPromise = null; });
      }
      let ok: boolean;
      try {
        ok = await refreshPromise;
      } catch {
        // Refresh threw (5xx or network error) — server unavailable, not session expired.
        throw new ApiError(503, 'server_unavailable');
      }
      if (ok) {
        const retryRes = await rawFetch(path, opts);
        if (!retryRes.ok) {
          const body = await retryRes.text().catch(() => '');
          throw new ApiError(retryRes.status, body);
        }
        return retryRes.json() as Promise<T>;
      }
      // First attempt failed — wait briefly and retry once (cookies may have been updated)
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    // Both refresh attempts failed — but verify session is truly expired before logout.
    // Another tab may have refreshed successfully and our cookies are now valid.
    try {
      const verifyRes = await rawFetch('/api/auth/user/me');
      if (verifyRes.ok) {
        console.warn(`[auth] refresh failed but /me succeeded — session still valid, retrying original request`);
        _lastRefreshAt = Date.now();
        const retryRes = await rawFetch(path, opts);
        if (!retryRes.ok) throw new ApiError(retryRes.status, await retryRes.text().catch(() => ''));
        return retryRes.json() as Promise<T>;
      }
    } catch { /* /me also failed — truly expired */ }
    console.warn(`[auth] LOGOUT: refresh failed twice + /me failed for ${path}, triggering onAuthExpired`);
    _onAuthExpired?.(`401 on ${path} — refresh failed twice`);
    throw new ApiError(401, 'session_expired');
  }

  // CSRF token mismatch (cookie expired) — refresh session to get new CSRF cookie, then retry
  if (res.status === 403) {
    const body = await res.text().catch(() => '');
    if (body.includes('csrf_rejected')) {
      console.warn(`[auth] CSRF rejected on ${path} — refreshing session for new CSRF cookie`);
      if (!refreshPromise) {
        refreshPromise = doRefresh().finally(() => { refreshPromise = null; });
      }
      try {
        const ok = await refreshPromise;
        if (ok) {
          const retryRes = await rawFetch(path, opts);
          if (!retryRes.ok) throw new ApiError(retryRes.status, await retryRes.text().catch(() => ''));
          return retryRes.json() as Promise<T>;
        }
      } catch { /* refresh failed */ }
      throw new ApiError(403, body);
    }
    throw new ApiError(403, body);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApiError(res.status, body);
  }

  return res.json() as Promise<T>;
}

export async function sendSessionViaHttp(
  serverId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await apiFetch(`/api/server/${encodeURIComponent(serverId)}/session/send`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function cancelSessionViaHttp(
  serverId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await apiFetch(`/api/server/${encodeURIComponent(serverId)}/session/cancel`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export interface CreateShareRequest {
  target: ShareTarget;
  targetUserId: string;
  /** Backward-compatible alias for older callers; createShare sends targetUserId on the wire. */
  targetUser?: string;
  role: ShareRole;
}

export interface CreateShareResponse {
  share: ShareGrantSummary;
}

export interface ListSharesResponse {
  shares: ShareGrantSummary[];
}

export interface UpdateShareRequest {
  role?: ShareRole;
  expiresAt?: number | null;
}

function normalizeShareGrantSummary(value: unknown): ShareGrantSummary {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const targetUser = raw.targetUser && typeof raw.targetUser === 'object'
    ? raw.targetUser as Record<string, unknown>
    : {};
  const targetUserId = typeof raw.targetUserId === 'string'
    ? raw.targetUserId
    : typeof targetUser.id === 'string'
      ? targetUser.id
      : '';
  const targetUserDisplayName = typeof raw.targetUserDisplayName === 'string'
    ? raw.targetUserDisplayName
    : typeof targetUser.displayName === 'string'
      ? targetUser.displayName
      : targetUserId;
  return {
    ...(raw as Partial<ShareGrantSummary>),
    id: typeof raw.id === 'string' ? raw.id : '',
    targetUserId,
    targetUserDisplayName,
    role: raw.role === 'participant' ? 'participant' : 'viewer',
    status: typeof raw.status === 'string' ? raw.status as ShareGrantSummary['status'] : 'active',
  };
}

function buildShareTargetParams(target: ShareTarget): URLSearchParams {
  const params = new URLSearchParams();
  params.set('targetKind', target.kind);
  if (target.kind === 'main') params.set('sessionName', target.sessionName);
  if (target.kind === 'subsession') params.set('subSessionId', target.subSessionId);
  return params;
}

export async function listSharesForTarget(serverId: string, target: ShareTarget): Promise<ShareGrantSummary[]> {
  const params = buildShareTargetParams(target);
  const res = await apiFetch<ListSharesResponse>(
    `/api/server/${encodeURIComponent(serverId)}/shares?${params.toString()}`,
  );
  return Array.isArray(res.shares) ? res.shares.map(normalizeShareGrantSummary) : [];
}

export async function listManagedSharesForServer(serverId: string): Promise<ShareGrantSummary[]> {
  const res = await apiFetch<ListSharesResponse>(`/api/server/${encodeURIComponent(serverId)}/shares`);
  return Array.isArray(res.shares) ? res.shares.map(normalizeShareGrantSummary) : [];
}

export async function createShare(serverId: string, request: CreateShareRequest): Promise<ShareGrantSummary> {
  const targetUserId = request.targetUserId || request.targetUser || '';
  const res = await apiFetch<CreateShareResponse>(`/api/server/${encodeURIComponent(serverId)}/shares`, {
    method: 'POST',
    body: JSON.stringify({
      target: request.target,
      targetUserId,
      role: request.role,
    }),
  });
  return normalizeShareGrantSummary(res.share);
}

export async function updateShare(serverId: string, shareId: string, request: UpdateShareRequest): Promise<ShareGrantSummary> {
  const res = await apiFetch<CreateShareResponse>(
    `/api/server/${encodeURIComponent(serverId)}/shares/${encodeURIComponent(shareId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(request),
    },
  );
  return normalizeShareGrantSummary(res.share);
}

export async function revokeShare(serverId: string, shareId: string): Promise<ShareGrantSummary> {
  const res = await apiFetch<CreateShareResponse>(
    `/api/server/${encodeURIComponent(serverId)}/shares/${encodeURIComponent(shareId)}`,
    { method: 'DELETE' },
  );
  return normalizeShareGrantSummary(res.share);
}

export interface SharedEntrySummary {
  id: string;
  serverId: string;
  serverName: string;
  role: ShareRole;
  status: 'active' | 'revoked' | 'expired' | 'target-unavailable';
  target: ShareTarget;
  targetLabel: string;
}

function shareTargetFallbackLabel(target: ShareTarget): string {
  if (target.kind === 'server') return target.serverId;
  if (target.kind === 'main') return target.sessionName;
  return target.subSessionDisplayName || `deck_sub_${target.subSessionId}`;
}

function normalizeSharedEntrySummary(value: unknown): SharedEntrySummary {
  const raw = value && typeof value === 'object' ? value as Partial<SharedEntrySummary> & Record<string, unknown> : {};
  const fallbackTarget: ShareTarget = { kind: 'server', serverId: typeof raw.serverId === 'string' ? raw.serverId : '' };
  const target: ShareTarget = raw.target && typeof raw.target === 'object'
    ? raw.target as ShareTarget
    : fallbackTarget;
  const serverId = typeof raw.serverId === 'string'
    ? raw.serverId
    : target.serverId;
  const targetLabel = typeof raw.targetLabel === 'string' && raw.targetLabel.trim()
    ? raw.targetLabel
    : shareTargetFallbackLabel(target);
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    serverId,
    serverName: typeof raw.serverName === 'string' && raw.serverName.trim() ? raw.serverName : serverId,
    role: raw.role === 'participant' ? 'participant' : 'viewer',
    status: typeof raw.status === 'string' ? raw.status as SharedEntrySummary['status'] : 'active',
    target,
    targetLabel,
  };
}

export async function discoverSharedEntries(): Promise<SharedEntrySummary[]> {
  const res = await apiFetch<{ shares?: SharedEntrySummary[]; entries?: SharedEntrySummary[] }>('/api/shares');
  const entries = res.shares ?? res.entries;
  return Array.isArray(entries) ? entries.map(normalizeSharedEntrySummary) : [];
}

export interface OpenSharedEntryResponse {
  server: {
    id: string;
    name: string;
    status: string | null;
    lastHeartbeatAt: number | null;
  };
  target: ShareTarget;
  coverage: {
    effectiveRole: ShareRole;
    historyCutoffAt: number;
    nextCoverageRecheckAt: number | null;
    coveringShareIds: string[];
    primaryShareId: string | null;
    authorizedAt: number;
  };
  sessions: Array<{
    sessionName: string;
    title: string;
    state: string;
    agentType: string;
  }>;
  subSessions: Array<{
    subSessionId: string;
    sessionName: string;
    title: string;
    type: string;
    parentSessionName: string | null;
  }>;
}

export async function openSharedEntry(target: ShareTarget): Promise<OpenSharedEntryResponse> {
  return apiFetch<OpenSharedEntryResponse>('/api/shares/open', {
    method: 'POST',
    body: JSON.stringify({ target }),
  });
}

function isRetryableNonceExchangeError(error: unknown): boolean {
  if (error instanceof ApiError) {
    if (error.code === 'invalid_or_expired_nonce') return false;
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return true;
}

function createTimeoutSignal(timeoutMs: number): { signal: AbortSignal; clear?: () => void } {
  const timeoutFactory = (AbortSignal as typeof AbortSignal & { timeout?: (ms: number) => AbortSignal }).timeout;
  if (typeof timeoutFactory === 'function') {
    return { signal: timeoutFactory(timeoutMs) };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

async function postNonceExchange(serverUrl: string, nonce: string, timeoutMs: number): Promise<NativeAuthExchangeResponse> {
  const baseUrl = serverUrl.replace(/\/$/, '');
  const { signal, clear } = createTimeoutSignal(timeoutMs);
  try {
    const res = await rawFetch('/api/auth/token-exchange', {
      method: 'POST',
      body: JSON.stringify({ nonce }),
      signal,
    }, baseUrl);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ApiError(res.status, body);
    }
    return res.json() as Promise<NativeAuthExchangeResponse>;
  } finally {
    clear?.();
  }
}

export async function exchangeNonce(serverUrl: string, nonce: string): Promise<NativeAuthExchangeResponse> {
  if (!nonce.trim()) {
    throw new ApiError(400, '{"error":"missing_nonce"}');
  }
  return postNonceExchange(serverUrl, nonce, 10_000);
}

export async function exchangeNonceWithRetry(serverUrl: string, nonce: string, maxRetries = 3): Promise<NativeAuthExchangeResponse> {
  const deadlineAt = Date.now() + 30_000;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const now = Date.now();
    const remaining = deadlineAt - now;
    if (remaining <= 0) break;

    const timeoutMs = Math.min(10_000, remaining);
    try {
      return await postNonceExchange(serverUrl, nonce, timeoutMs);
    } catch (error) {
      lastError = error;
      if (!isRetryableNonceExchangeError(error) || attempt >= maxRetries) break;

      const backoffMs = [1000, 2000, 4000][attempt] ?? 4000;
      const nextAttemptAt = Date.now() + backoffMs;
      if (nextAttemptAt >= deadlineAt) break;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  if (lastError) throw lastError;
  throw new ApiError(503, 'token_exchange_failed');
}

export class ApiError extends Error {
  public code: string | null;

  constructor(public status: number, public body: string) {
    const code = parseApiErrorCode(body);
    super(`API ${status}: ${code ?? body}`);
    this.name = 'ApiError';
    this.code = code;
  }
}

function parseApiErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === 'string' ? parsed.error : null;
  } catch {
    return null;
  }
}

// ── Sub-session API ───────────────────────────────────────────────────────

export interface SubSessionData {
  id: string;
  sessionInstanceId?: string | null;
  runtimeEpoch?: string | null;
  serverId: string;
  type: string;
  runtimeType?: 'process' | 'transport' | null;
  providerId?: string | null;
  providerSessionId?: string | null;
  shellBin?: string | null;
  cwd?: string | null;
  label?: string | null;
  closedAt?: number | null;
  createdAt: number;
  updatedAt: number;
  ccSessionId?: string | null;
  geminiSessionId?: string | null;
  parentSession?: string | null;
  description?: string | null;
  ccPresetId?: string | null;
  // Provider display metadata (populated via WS subsession.created / subsession.sync)
  qwenModel?: string | null;
  qwenAuthType?: string | null;
  qwenAvailableModels?: string[] | null;
  codexAvailableModels?: string[] | null;
  requestedModel?: string | null;
  activeModel?: string | null;
  modelDisplay?: string | null;
  planLabel?: string | null;
  quotaLabel?: string | null;
  quotaUsageLabel?: string | null;
  quotaMeta?: import('../../shared/provider-quota.js').ProviderQuotaMeta | null;
  effort?: import('../../shared/effort-levels.js').TransportEffortLevel | null;
  contextNamespace?: import('../../shared/session-context-bootstrap.js').SessionContextBootstrapState['contextNamespace'] | null;
  contextNamespaceDiagnostics?: string[] | null;
  transportConfig?: Record<string, unknown> | null;
  transportPendingMessages?: string[] | null;
  transportPendingMessageEntries?: Array<{ clientMessageId: string; text: string }> | null;
  queueEpoch?: string | null;
  queueAuthorityId?: string | null;
  failedMessageEntries?: Array<{ clientMessageId: string; text: string }> | null;
  transportPendingMessageVersion?: number | null;
  /** Execution-clone discriminant projection (the canonical
   *  `EXECUTION_CLONE_KIND` value) when this sub-session is an ephemeral
   *  execution clone. Absent for ordinary sub-sessions. Drives grouped
   *  execution-detail rendering — clones never render as flat top-level peers. */
  executionCloneKind?: string | null;
  /** The owning parent execution run id for an execution clone. Clones sharing a
   *  `parentRunId` are grouped together in the execution-detail view. */
  parentRunId?: string | null;
}

export async function listSubSessions(serverId: string): Promise<SubSessionData[]> {
  const res = await apiFetch<{ subSessions: Array<{
    id: string; server_id: string; type: string; shell_bin: string | null;
    runtime_type: 'process' | 'transport' | null; provider_id: string | null; provider_session_id: string | null;
    cwd: string | null; label: string | null; closed_at: number | null;
    created_at: number; updated_at: number; cc_session_id: string | null;
    gemini_session_id: string | null; parent_session: string | null;
    description: string | null; cc_preset_id: string | null;
    requested_model: string | null; active_model: string | null; effort: import('../../shared/effort-levels.js').TransportEffortLevel | null;
    transport_config: Record<string, unknown> | string | null;
  }> }>(`/api/server/${serverId}/sub-sessions`);
  return res.subSessions.map((s) => ({
    id: s.id, serverId: s.server_id, type: s.type,
    runtimeType: s.runtime_type ?? getSessionRuntimeType(s.type),
    providerId: s.provider_id, providerSessionId: s.provider_session_id,
    shellBin: s.shell_bin, cwd: s.cwd, label: s.label,
    closedAt: s.closed_at, createdAt: s.created_at, updatedAt: s.updated_at,
    ccSessionId: s.cc_session_id,
    geminiSessionId: s.gemini_session_id,
    parentSession: s.parent_session,
    description: s.description,
    ccPresetId: s.cc_preset_id,
    requestedModel: s.requested_model,
    activeModel: s.active_model,
    modelDisplay: s.active_model,
    effort: s.effort,
    transportConfig: (typeof s.transport_config === 'string'
      ? JSON.parse(s.transport_config)
      : (s.transport_config ?? null)) as Record<string, unknown> | null,
  }));
}

export async function createSubSession(
  serverId: string,
  body: {
    type: string;
    shellBin?: string;
    cwd?: string;
    label?: string;
    ccSessionId?: string;
    parentSession?: string | null;
    description?: string;
    ccPresetId?: string;
    requestedModel?: string | null;
    activeModel?: string | null;
    effort?: import('../../shared/effort-levels.js').TransportEffortLevel | null;
    transportConfig?: Record<string, unknown> | null;
  },
): Promise<{ id: string; sessionName: string; subSession: SubSessionData }> {
  const res = await apiFetch<{ id: string; sessionName: string; subSession: {
    id: string; server_id: string; type: string; shell_bin: string | null;
    runtime_type: 'process' | 'transport' | null; provider_id: string | null; provider_session_id: string | null;
    cwd: string | null; label: string | null; closed_at: number | null;
    created_at: number; updated_at: number; cc_session_id: string | null;
    gemini_session_id: string | null; parent_session: string | null; description: string | null; cc_preset_id: string | null;
    requested_model: string | null; active_model: string | null; effort: import('../../shared/effort-levels.js').TransportEffortLevel | null;
    transport_config: Record<string, unknown> | string | null;
  } }>(`/api/server/${serverId}/sub-sessions`, {
    method: 'POST',
    body: JSON.stringify({
      ...body,
      cc_session_id: body.ccSessionId ?? null,
      parent_session: body.parentSession ?? null,
      cc_preset_id: body.ccPresetId ?? null,
      requested_model: body.requestedModel ?? null,
      active_model: body.activeModel ?? null,
      effort: body.effort ?? null,
      transport_config: body.transportConfig ?? null,
    }),
  });
  const s = res.subSession;
  return {
    id: res.id,
    sessionName: res.sessionName,
    subSession: {
      id: s.id, serverId: s.server_id, type: s.type,
      runtimeType: s.runtime_type, providerId: s.provider_id, providerSessionId: s.provider_session_id,
      shellBin: s.shell_bin, cwd: s.cwd, label: s.label,
      closedAt: s.closed_at, createdAt: s.created_at, updatedAt: s.updated_at,
      ccSessionId: s.cc_session_id,
      geminiSessionId: s.gemini_session_id,
      parentSession: s.parent_session,
      description: s.description,
      ccPresetId: s.cc_preset_id,
      requestedModel: s.requested_model,
      activeModel: s.active_model,
      modelDisplay: s.active_model,
      effort: s.effort,
      transportConfig: (typeof s.transport_config === 'string'
        ? JSON.parse(s.transport_config)
        : (s.transport_config ?? null)) as Record<string, unknown> | null,
    },
  };
}

export async function patchSubSession(
  serverId: string,
  subId: string,
  body: {
    type?: string | null;
    label?: string | null;
    closedAt?: number | null;
    description?: string | null;
    cwd?: string | null;
    ccPresetId?: string | null;
    requestedModel?: string | null;
    activeModel?: string | null;
    effort?: import('../../shared/effort-levels.js').TransportEffortLevel | null;
    transportConfig?: Record<string, unknown> | null;
  },
): Promise<void> {
  await apiFetch(`/api/server/${serverId}/sub-sessions/${subId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function patchSession(
  serverId: string,
  sessionName: string,
  body: {
    label?: string | null;
    description?: string | null;
    cwd?: string | null;
    agentType?: string | null;
    requestedModel?: string | null;
    activeModel?: string | null;
    effort?: import('../../shared/effort-levels.js').TransportEffortLevel | null;
    transportConfig?: Record<string, unknown> | null;
  },
): Promise<void> {
  await apiFetch(`/api/server/${serverId}/sessions/${sessionName}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function reorderSubSessions(serverId: string, ids: string[]): Promise<void> {
  await apiFetch(`/api/server/${serverId}/sub-sessions/reorder`, {
    method: 'PATCH',
    body: JSON.stringify({ ids }),
  });
}

/**
 * Fetch timeline history via HTTP (full-fidelity variant of the Watch
 * endpoint). Used as a defense-in-depth backfill on WS reconnect so live
 * `timeline.event` messages dropped during the bridge's async subscription
 * resolve window can still be recovered. Pod-sticky via `:serverId`.
 *
 * Returns full TimelineEvent objects (not the Watch-sanitized simplified
 * shape), so callers can merge them with `mergeTimelineEvents` exactly as
 * they would a WS `timeline.history` response. Dedup by eventId makes it
 * safe to call alongside the WS history request.
 *
 * Returns null (not throw) on expected transient failures — daemon offline,
 * pod routing miss, timeout — so callers can treat HTTP backfill as purely
 * opportunistic. Auth failures still throw via `apiFetch`.
 */
export async function fetchTimelineHistoryHttp(
  serverId: string,
  sessionName: string,
  opts: { afterTs?: number; beforeTs?: number; limit?: number; timeoutMs?: number } = {},
): Promise<(
  Omit<TimelinePayloadMetadata, 'nextCursor' | 'detailRefs'>
  & {
    events: unknown[];
    epoch: number | null;
    hasMore: boolean;
    nextCursor: TimelineCursor | null;
    legacyBeforeTs?: number;
    detailRefs?: TimelineDetailRef[];
  }
) | null> {
  const params = new URLSearchParams();
  params.set('sessionName', sessionName);
  if (typeof opts.afterTs === 'number' && Number.isFinite(opts.afterTs)) params.set('afterTs', String(opts.afterTs));
  if (typeof opts.beforeTs === 'number' && Number.isFinite(opts.beforeTs)) params.set('beforeTs', String(opts.beforeTs));
  if (typeof opts.limit === 'number' && Number.isFinite(opts.limit)) params.set('limit', String(opts.limit));
  const timeout = createTimeoutSignal(opts.timeoutMs ?? 2_500);
  try {
    const result = await apiFetch<{
      sessionName: string;
      epoch: number | null;
      events: unknown[];
      hasMore?: boolean;
      nextCursor?: TimelineCursor | number | null;
      legacyBeforeTs?: number;
      earliestTs?: number;
      status?: TimelinePayloadMetadata['status'];
      errorReason?: string;
      source?: TimelinePayloadMetadata['source'];
      payloadBytes?: number;
      actualPayloadBytes?: number;
      payloadTruncated?: boolean;
      cursorReset?: boolean;
      droppedEvents?: number;
      truncatedEvents?: number;
      detailRefs?: TimelineDetailRef[];
      recoverable?: boolean;
    }>(`/api/server/${encodeURIComponent(serverId)}/timeline/history/full?${params.toString()}`, {
      method: 'GET',
      signal: timeout.signal,
    });
    return {
      events: Array.isArray(result.events) ? result.events : [],
      epoch: result.epoch ?? null,
      hasMore: !!result.hasMore,
      nextCursor: result.nextCursor && typeof result.nextCursor === 'object' ? result.nextCursor : null,
      legacyBeforeTs: typeof result.nextCursor === 'number'
        ? result.nextCursor
        : typeof result.legacyBeforeTs === 'number'
          ? result.legacyBeforeTs
          : typeof result.earliestTs === 'number'
            ? result.earliestTs
            : undefined,
      status: result.status,
      errorReason: result.errorReason,
      source: result.source,
      payloadBytes: result.payloadBytes,
      actualPayloadBytes: result.actualPayloadBytes,
      payloadTruncated: result.payloadTruncated,
      cursorReset: result.cursorReset,
      droppedEvents: result.droppedEvents,
      truncatedEvents: result.truncatedEvents,
      detailRefs: Array.isArray(result.detailRefs) ? result.detailRefs : undefined,
      recoverable: result.recoverable,
    };
  } catch (err) {
    // 401/403 → let it propagate (auth handler already runs in apiFetch).
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) throw err;
    // 503 daemon_offline / 504 timeout / network errors are transient — caller
    // should fall back to the WS path. Returning null lets the caller decide.
    return null;
  } finally {
    timeout.clear?.();
  }
}

export interface TimelineTextTailItem {
  eventId: string;
  ts: number;
  type: 'user.message' | 'assistant.text';
  text: string;
  source?: string;
  confidence?: string;
}

/**
 * Fetch the PostgreSQL-backed recent text-tail cache for one session.
 *
 * This is a non-authoritative bootstrap path intended to surface the latest
 * completed text messages quickly while the existing WS/full-history flow
 * continues to reconcile authoritative state.
 *
 * Returns null (not throw) on expected transient failures so callers can fail
 * open and continue with the normal timeline bootstrap.
 */
export async function fetchTimelineTextTailHttp(
  serverId: string,
  sessionName: string,
): Promise<{ events: TimelineTextTailItem[] } | null> {
  const params = new URLSearchParams();
  params.set('sessionName', sessionName);
  try {
    const result = await apiFetch<{ sessionName: string; events: TimelineTextTailItem[] }>(
      `/api/server/${encodeURIComponent(serverId)}/timeline/text-tail?${params.toString()}`,
      { method: 'GET' },
    );
    return {
      events: Array.isArray(result.events) ? result.events : [],
    };
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) throw err;
    return null;
  }
}

export async function deleteSubSession(serverId: string, subId: string): Promise<void> {
  await apiFetch(`/api/server/${serverId}/sub-sessions/${subId}`, { method: 'DELETE' });
}

export interface P2pRunData {
  id: string;
  status: string;
  mode_key: string;
  initiator_session: string;
  current_target_session: string | null;
  remaining_targets: string;
  total_count?: number;
  remaining_count?: number;
  current_target_label?: string | null;
  initiator_label?: string | null;
  progress_snapshot?: Record<string, unknown> | string | null;
  result_summary: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export async function listP2pRuns(serverId: string): Promise<P2pRunData[]> {
  const res = await apiFetch<{ runs: P2pRunData[] }>(`/api/server/${serverId}/p2p/runs`);
  return res.runs ?? [];
}

// ── Current user (me) ──────────────────────────────────────────────────────

export interface MeResponse {
  id: string;
  username: string | null;
  display_name: string | null;
  is_admin: boolean;
  status: string;
  has_password: boolean;
}

export async function fetchMe(): Promise<MeResponse> {
  return apiFetch<MeResponse>('/api/auth/user/me');
}

export async function updateDisplayName(displayName: string): Promise<MeResponse> {
  return apiFetch<MeResponse>('/api/auth/user/me', {
    method: 'PATCH',
    body: JSON.stringify({ displayName }),
  });
}

// ── Admin API ─────────────────────────────────────────────────────────────

export interface AdminUser {
  id: string;
  username: string | null;
  displayName: string | null;
  isAdmin: boolean;
  status: string;
  createdAt: number;
}

export async function fetchAdminUsers(): Promise<AdminUser[]> {
  const res = await apiFetch<{ users: AdminUser[] }>('/api/admin/users');
  return res.users;
}

export async function approveUser(id: string): Promise<void> {
  await apiFetch(`/api/admin/users/${id}/approve`, { method: 'POST' });
}

export async function disableUser(id: string): Promise<void> {
  await apiFetch(`/api/admin/users/${id}/disable`, { method: 'POST' });
}

export async function deleteAdminUser(id: string): Promise<void> {
  await apiFetch(`/api/admin/users/${id}`, { method: 'DELETE' });
}

export interface AdminSettings {
  [key: string]: string;
}

export async function fetchAdminSettings(): Promise<AdminSettings> {
  const res = await apiFetch<{ settings: AdminSettings }>('/api/admin/settings');
  return res.settings;
}

export async function updateAdminSettings(settings: AdminSettings): Promise<void> {
  await apiFetch('/api/admin/settings', {
    method: 'PUT',
    body: JSON.stringify(settings),
  });
}

// ── User preferences ───────────────────────────────────────────────────────

export async function getUserPref(key: string): Promise<unknown | null> {
  try {
    const res = await apiFetch<{ value: unknown }>(`/api/preferences/${key}`);
    return res.value ?? null;
  } catch {
    return null;
  }
}

export async function fetchSupervisorDefaults(): Promise<SupervisorDefaultConfig | null> {
  const raw = await getUserPref(SUPERVISION_USER_DEFAULT_PREF_KEY);
  return parseSupervisorDefaultConfig(raw);
}

export async function saveSupervisorDefaults(config: Partial<SupervisorDefaultConfig> | null | undefined): Promise<SupervisorDefaultConfig> {
  const normalized = normalizeSupervisorDefaultConfig(config);
  await saveUserPref(SUPERVISION_USER_DEFAULT_PREF_KEY, normalized);
  return normalized;
}

const USER_PREF_CHANGED_EVENT = 'imcodes:user-pref-changed';
const userPrefChannel = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('imcodes-user-pref-sync')
  : null;

export interface UserPrefChangedMeta {
  source: 'local' | 'broadcast';
}

function emitUserPrefChanged(key: string, value: unknown): void {
  try {
    window.dispatchEvent(new CustomEvent(USER_PREF_CHANGED_EVENT, {
      detail: { key, value },
    }));
  } catch { /* window may be unavailable */ }
  try {
    userPrefChannel?.postMessage({ key, value });
  } catch { /* ignore */ }
}

export function onUserPrefChanged(cb: (key: string, value: unknown, meta: UserPrefChangedMeta) => void): () => void {
  const handleWindowEvent = (event: Event) => {
    const detail = (event as CustomEvent<{ key?: unknown; value?: unknown }>).detail;
    if (!detail || typeof detail.key !== 'string') return;
    cb(detail.key, detail.value, { source: 'local' });
  };
  const handleChannelEvent = (event: MessageEvent<unknown>) => {
    const data = event.data as { key?: unknown; value?: unknown } | null;
    if (!data || typeof data.key !== 'string') return;
    cb(data.key, data.value, { source: 'broadcast' });
  };
  try { window.addEventListener(USER_PREF_CHANGED_EVENT, handleWindowEvent as EventListener); } catch { /* */ }
  try { userPrefChannel?.addEventListener('message', handleChannelEvent); } catch { /* */ }
  return () => {
    try { window.removeEventListener(USER_PREF_CHANGED_EVENT, handleWindowEvent as EventListener); } catch { /* */ }
    try { userPrefChannel?.removeEventListener('message', handleChannelEvent); } catch { /* */ }
  };
}

export async function saveUserPref(key: string, value: unknown): Promise<void> {
  await apiFetch(`/api/preferences/${key}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  });
  emitUserPrefChanged(key, value);
}

// ── Passkey (WebAuthn) API ─────────────────────────────────────────────────

export interface PasskeyCredential {
  id: string;
  deviceName: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export async function passkeyRegisterBegin(displayName?: string): Promise<Record<string, unknown> & { challengeId: string }> {
  return apiFetch('/api/auth/passkey/register/begin', {
    method: 'POST',
    body: JSON.stringify({ displayName }),
  });
}

export async function passkeyRegisterComplete(challengeId: string, response: unknown, deviceName?: string): Promise<void> {
  await apiFetch('/api/auth/passkey/register/complete', {
    method: 'POST',
    body: JSON.stringify({ challengeId, response, deviceName }),
  });
}

export async function passkeyLoginBegin(): Promise<Record<string, unknown> & { challengeId: string }> {
  return apiFetch('/api/auth/passkey/login/begin', { method: 'POST', body: '{}' });
}

export async function passkeyVerifyBegin(): Promise<Record<string, unknown> & { challengeId: string }> {
  return apiFetch('/api/auth/passkey/verify/begin', { method: 'POST', body: '{}' });
}

export async function passkeyLoginComplete(challengeId: string, response: unknown): Promise<void> {
  await apiFetch('/api/auth/passkey/login/complete', {
    method: 'POST',
    body: JSON.stringify({ challengeId, response }),
  });
}

/** Native-only: exchange passkey credential for a nonce (does not set cookie). */
export async function passkeyLoginCompleteNative(
  challengeId: string,
  response: unknown,
): Promise<{ nonce: string; userId: string }> {
  return apiFetch('/api/auth/passkey/login/complete?native=1', {
    method: 'POST',
    body: JSON.stringify({ challengeId, response }),
  });
}

export async function passwordRegister(username: string, password: string, displayName?: string, native?: boolean): Promise<{ ok: boolean; pending?: boolean; apiKey?: string; keyId?: string; userId?: string }> {
  return apiFetch('/api/auth/password/register', {
    method: 'POST',
    body: JSON.stringify({ username, password, ...(displayName ? { displayName } : {}), ...(native ? { native: true } : {}) }),
  });
}

export async function passwordLogin(username: string, password: string, native?: boolean): Promise<{ ok: boolean; passwordMustChange?: boolean; apiKey?: string; keyId?: string; userId?: string }> {
  return apiFetch('/api/auth/password/login', {
    method: 'POST',
    body: JSON.stringify({ username, password, ...(native ? { native: true } : {}) }),
  });
}

export async function passwordChange(oldPassword: string, newPassword: string): Promise<void> {
  await apiFetch('/api/auth/password/change', {
    method: 'POST',
    body: JSON.stringify({ oldPassword, newPassword }),
  });
}

export async function passwordSetupWithPasskey(
  username: string,
  newPassword: string,
  challengeId: string,
  response: unknown,
): Promise<{ ok: boolean; user: MeResponse }> {
  return apiFetch('/api/auth/passkey/password/setup', {
    method: 'POST',
    body: JSON.stringify({ username, newPassword, challengeId, response }),
  });
}

export async function listPasskeys(): Promise<{ credentials: PasskeyCredential[] }> {
  return apiFetch('/api/auth/passkey/credentials');
}

export async function deletePasskey(credentialId: string): Promise<void> {
  await apiFetch(`/api/auth/passkey/credentials/${credentialId}`, { method: 'DELETE' });
}

// ── File transfer API ─────────────────────────────────────────────────────

export interface AttachmentRefResponse {
  id: string;
  source: string;
  serverId: string;
  daemonPath: string;
  originalName?: string;
  mime?: string;
  size?: number;
  createdAt: string;
  expiresAt?: string;
  downloadable: boolean;
}

export async function uploadFile(
  serverId: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<{ ok: boolean; attachment: AttachmentRefResponse }> {
  const form = new FormData();
  form.append('file', file);
  const browserUploadWeight = 50;
  const daemonDownloadWeight = 50;

  // Use XHR for upload progress reporting
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${_baseUrl}/api/server/${serverId}/upload`);
    xhr.setRequestHeader('Accept', 'application/x-ndjson, application/json');

    // Auth headers (same as rawFetch)
    if (_apiKey) {
      xhr.setRequestHeader('Authorization', `Bearer ${_apiKey}`);
    } else {
      xhr.withCredentials = true;
      const csrf = document.cookie.match(new RegExp(`${COOKIE_CSRF}=([^;]+)`))?.[1];
      if (csrf) xhr.setRequestHeader(HEADER_CSRF, csrf);
    }

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        const transportPct = Math.round((e.loaded / e.total) * 100);
        onProgress(Math.min(Math.round((transportPct / 100) * browserUploadWeight), browserUploadWeight));
      }
    };

    let processedResponseLength = 0;
    let finalPayload: { ok: boolean; attachment: AttachmentRefResponse } | null = null;
    let streamError: ApiError | null = null;
    let highestProgress = 0;

    const emitProgress = (pct: number) => {
      const next = Math.max(highestProgress, Math.min(100, Math.round(pct)));
      highestProgress = next;
      onProgress?.(next);
    };

    const consumeProgressLines = (flush = false) => {
      const response = xhr.responseText ?? '';
      let chunk = response.slice(processedResponseLength);
      if (!chunk) return;
      if (!flush) {
        const lastNewline = chunk.lastIndexOf('\n');
        if (lastNewline < 0) return;
        chunk = chunk.slice(0, lastNewline + 1);
      }
      processedResponseLength += chunk.length;

      for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (msg.type === 'file.upload_progress') {
          const loaded = typeof msg.loaded === 'number' ? msg.loaded : 0;
          const total = typeof msg.total === 'number' && msg.total > 0 ? msg.total : file.size;
          const daemonPct = total > 0 ? Math.min(1, loaded / total) : 0;
          emitProgress(browserUploadWeight + daemonPct * daemonDownloadWeight);
          continue;
        }
        if (msg.type === 'file.upload_done' && msg.attachment) {
          finalPayload = { ok: true, attachment: msg.attachment as AttachmentRefResponse };
          emitProgress(100);
          continue;
        }
        if (msg.type === 'file.upload_error') {
          const message = typeof msg.error === 'string'
            ? msg.error
            : typeof msg.message === 'string'
              ? msg.message
              : 'upload_failed';
          streamError = new ApiError(xhr.status >= 400 ? xhr.status : 500, message);
        }
      }
    };

    xhr.onprogress = () => consumeProgressLines(false);

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          consumeProgressLines(true);
          if (streamError) {
            reject(streamError);
            return;
          }
          if (finalPayload) {
            resolve(finalPayload);
            return;
          }
          const parsed = JSON.parse(xhr.responseText);
          onProgress?.(100);
          resolve(parsed);
        }
        catch { reject(new ApiError(xhr.status, 'Invalid JSON response')); }
      } else {
        reject(new ApiError(xhr.status, xhr.responseText));
      }
    };

    xhr.onerror = () => reject(new ApiError(0, 'Network error'));
    xhr.send(form);
  });
}

export async function downloadAttachment(serverId: string, attachmentId: string): Promise<void> {
  // Native: skip blob fetch — WebViews can't reliably trigger downloads from blob URLs.
  // Get a one-time token and open in system browser which handles save natively.
  if (isNative()) {
    const downloadUrl = await buildAttachmentDownloadUrl(serverId, attachmentId);
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url: downloadUrl });
    return;
  }

  // Desktop: fetch blob and trigger <a download>
  const res = await rawFetch(`/api/server/${encodeURIComponent(serverId)}/uploads/${encodeURIComponent(attachmentId)}/download`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApiError(res.status, body);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition');
  let filename = attachmentId;
  if (disposition) {
    const starMatch = disposition.match(/filename\*\s*=\s*UTF-8''([^\s;]+)/i);
    if (starMatch) {
      try { filename = decodeURIComponent(starMatch[1]); } catch { /* keep default */ }
    } else {
      const plainMatch = disposition.match(/filename="([^"]+)"/);
      if (plainMatch) filename = plainMatch[1];
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Synchronously pre-open an isolated desktop download window while the user
 * gesture is still active. Call this at click entry before any await.
 */
export function beginControlledNodeDesktopDownload(): Window {
  // Including `noopener` in windowFeatures makes some browsers deliberately
  // return null even when the tab opens, which is indistinguishable from a
  // blocked popup. Open first while the gesture is active, then sever opener.
  const opened = window.open('about:blank', '_blank');
  if (!opened) throw new Error('popup_blocked');
  opened.opener = null;
  return opened;
}

export interface ControlledNodeDownloadOptions {
  /** Desktop window opened synchronously at click time via {@link beginControlledNodeDesktopDownload}. */
  desktopWindow?: Window | null;
}

/**
 * Start a controlled-node executable download for the selected (os, arch).
 * Desktop: navigate a pre-opened window after mint (caller must pre-open).
 * Native: mint first, then open the system browser. No blob buffering.
 */
/** Map mint/download failures to controlled_nodes i18n keys. */
export function controlledNodeDownloadErrorKey(err: unknown): string {
  if (err instanceof Error && err.message === 'popup_blocked') {
    return 'controlled_nodes.download_popup_blocked';
  }
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'executable_not_built':
        return 'controlled_nodes.mint_executable_not_built';
      case 'canonical_server_url_required':
        return 'controlled_nodes.mint_canonical_server_url_required';
      case 'invalid_or_expired_ticket':
        return 'controlled_nodes.ticket_expired';
      default:
        break;
    }
    if (err.body.includes('executable_not_built')) return 'controlled_nodes.mint_executable_not_built';
    if (err.body.includes('canonical_server_url_required')) return 'controlled_nodes.mint_canonical_server_url_required';
    if (err.body.includes('invalid_or_expired_ticket')) return 'controlled_nodes.ticket_expired';
  }
  return 'controlled_nodes.download_error';
}

export async function downloadControlledNodeExecutable(
  selection: import('./api/machines.js').ControlledNodeArtifactSelection,
  opts: ControlledNodeDownloadOptions = {},
): Promise<import('./api/machines.js').ControlledNodeExecutableTicket> {
  const { mintControlledNodeExecutableTicket, buildControlledNodeBootstrapUrl } = await import('./api/machines.js');
  const nativeRuntime = isNative();
  const desktopWindow = !nativeRuntime ? (opts.desktopWindow ?? null) : null;
  if (!nativeRuntime && !desktopWindow) throw new Error('desktop_window_required');

  try {
    const ticket = await mintControlledNodeExecutableTicket(selection);
    const url = buildControlledNodeBootstrapUrl(ticket.ticket);
    if (nativeRuntime) {
      const { Browser } = await import('@capacitor/browser');
      await Browser.open({ url });
      return ticket;
    }
    desktopWindow!.location.href = url;
    return ticket;
  } catch (err) {
    if (desktopWindow && !desktopWindow.closed) desktopWindow.close();
    throw err;
  }
}

export async function previewAttachment(serverId: string, attachmentId: string): Promise<void> {
  const res = await rawFetch(`/api/server/${encodeURIComponent(serverId)}/uploads/${encodeURIComponent(attachmentId)}/download`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApiError(res.status, body);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export interface TeamSummary {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
}

export interface TeamMember {
  user_id: string;
  username?: string | null;
  display_name?: string | null;
  role: 'owner' | 'admin' | 'member';
  joined_at: number;
}

export interface TeamDetail {
  id: string;
  name: string;
  myRole: 'owner' | 'admin' | 'member';
  members: TeamMember[];
}

export interface SharedWorkspace {
  id: string;
  enterpriseId: string;
  name: string;
}

export interface SharedProject {
  id: string;
  workspaceId: string | null;
  canonicalRepoId: string;
  displayName: string | null;
  scope: AuthoredContextScope;
  status: 'unenrolled' | 'active' | 'pending_removal' | 'removed';
}

export interface SharedProjectPolicy {
  enrollmentId: string;
  enterpriseId: string;
  allowDegradedProviderSupport: boolean;
  allowLocalFallback: boolean;
  requireFullProviderSupport: boolean;
}

export interface SharedDocumentVersion {
  id: string;
  versionNumber: number;
  status: string;
  createdByUserId?: string;
}

export interface SharedDocument {
  id: string;
  enterpriseId: string;
  kind: 'coding_standard' | 'architecture_guideline' | 'repo_playbook' | 'knowledge_doc';
  title: string;
  createdByUserId?: string;
  versions: SharedDocumentVersion[];
}

export interface SharedDocumentBinding {
  id: string;
  workspaceId: string | null;
  enrollmentId: string | null;
  documentId: string;
  versionId: string;
  mode: 'required' | 'advisory';
  applicabilityRepoId: string | null;
  applicabilityLanguage: string | null;
  applicabilityPathPattern: string | null;
  status: string;
  createdByUserId?: string;
}

export interface RuntimeAuthoredContextBindingView {
  bindingId: string;
  documentVersionId: string;
  mode: 'required' | 'advisory';
  scope: AuthoredContextScope;
  repository?: string;
  language?: string;
  pathPattern?: string;
  content: string;
  active: boolean;
  superseded: boolean;
}

export interface SharedContextDiagnosticsView {
  enterpriseId: string;
  canonicalRepoId: string;
  enrollmentId: string | null;
  remoteProcessedFreshness: 'fresh' | 'stale' | 'missing';
  visibilityState: 'unenrolled' | 'active' | 'pending_removal' | 'removed';
  retrievalMode: 'personal_only' | 'shared_active' | 'policy_bound_default_deny' | 'cleanup_only';
  policy: {
    allowDegradedProviderSupport: boolean;
    allowLocalFallback: boolean;
    requireFullProviderSupport: boolean;
  };
  diagnostics: {
    derivedOnDemand: boolean;
    persistedSnapshotAvailable: boolean;
    activeBindingCount: number;
    appliedDocumentVersionIds: string[];
  };
}

export interface SharedContextRuntimeConfigView {
  snapshot: SharedContextRuntimeConfigSnapshot;
}

export async function listTeams(): Promise<TeamSummary[]> {
  const response = await apiFetch<{ teams: TeamSummary[] }>('/api/team', { method: 'GET' });
  return response.teams;
}

export async function fetchSharedContextRuntimeConfig(serverId: string): Promise<SharedContextRuntimeConfigView> {
  return apiFetch(`/api/server/${encodeURIComponent(serverId)}/shared-context/runtime-config`, {
    method: 'GET',
  });
}

export async function updateSharedContextRuntimeConfig(serverId: string, config: ContextModelConfig): Promise<SharedContextRuntimeConfigView> {
  return apiFetch(`/api/server/${encodeURIComponent(serverId)}/shared-context/runtime-config`, {
    method: 'PUT',
    body: JSON.stringify(config),
  });
}

export async function createTeam(name: string): Promise<{ id: string; name: string; role: string }> {
  return apiFetch('/api/team', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export async function getTeam(teamId: string): Promise<TeamDetail> {
  return apiFetch(`/api/team/${encodeURIComponent(teamId)}`, { method: 'GET' });
}

export async function createTeamInvite(teamId: string, role: 'admin' | 'member', email?: string): Promise<{ token: string; expiresAt: number }> {
  return apiFetch(`/api/team/${encodeURIComponent(teamId)}/invite`, {
    method: 'POST',
    body: JSON.stringify({ role, ...(email?.trim() ? { email: email.trim() } : {}) }),
  });
}

export async function joinTeamByToken(token: string): Promise<{ ok: true; teamId: string; role: string }> {
  return apiFetch(`/api/team/join/${encodeURIComponent(token)}`, { method: 'POST' });
}

export async function updateTeamMemberRole(teamId: string, memberId: string, role: 'admin' | 'member'): Promise<{ ok: true }> {
  return apiFetch(`/api/team/${encodeURIComponent(teamId)}/member/${encodeURIComponent(memberId)}/role`, {
    method: 'PUT',
    body: JSON.stringify({ role }),
  });
}

export async function removeTeamMember(teamId: string, memberId: string): Promise<{ ok: true }> {
  return apiFetch(`/api/team/${encodeURIComponent(teamId)}/member/${encodeURIComponent(memberId)}`, {
    method: 'DELETE',
  });
}

export async function listSharedWorkspaces(enterpriseId: string): Promise<SharedWorkspace[]> {
  const response = await apiFetch<{ workspaces: Array<{ id: string; enterpriseId: string; name: string }> }>(
    `/api/shared-context/enterprises/${encodeURIComponent(enterpriseId)}/workspaces`,
    { method: 'GET' },
  );
  return response.workspaces;
}

export async function createSharedWorkspace(enterpriseId: string, name: string): Promise<{ id: string; enterpriseId: string; name: string }> {
  return apiFetch(`/api/shared-context/enterprises/${encodeURIComponent(enterpriseId)}/workspaces`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export async function listSharedProjects(enterpriseId: string): Promise<SharedProject[]> {
  const response = await apiFetch<{ projects: SharedProject[] }>(
    `/api/shared-context/enterprises/${encodeURIComponent(enterpriseId)}/projects`,
    { method: 'GET' },
  );
  return response.projects;
}

export async function enrollSharedProject(
  enterpriseId: string,
  input: {
    canonicalRepoId: string;
    displayName?: string;
    workspaceId?: string | null;
    scope: AuthoredContextScope;
  },
): Promise<{ id: string }> {
  return apiFetch(`/api/shared-context/enterprises/${encodeURIComponent(enterpriseId)}/projects/enroll`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateSharedProjectPolicy(
  enrollmentId: string,
  input: {
    allowDegradedProviderSupport: boolean;
    allowLocalFallback: boolean;
    requireFullProviderSupport: boolean;
  },
): Promise<{ ok: true }> {
  return apiFetch(`/api/shared-context/projects/${encodeURIComponent(enrollmentId)}/policy`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export async function getSharedProjectPolicy(enrollmentId: string): Promise<SharedProjectPolicy> {
  return apiFetch(`/api/shared-context/projects/${encodeURIComponent(enrollmentId)}/policy`, {
    method: 'GET',
  });
}

export async function markSharedProjectPendingRemoval(enrollmentId: string): Promise<{ ok: true }> {
  return apiFetch(`/api/shared-context/projects/${encodeURIComponent(enrollmentId)}/pending-removal`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function removeSharedProject(enrollmentId: string): Promise<{ ok: true }> {
  return apiFetch(`/api/shared-context/projects/${encodeURIComponent(enrollmentId)}/remove`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function listSharedDocuments(enterpriseId: string): Promise<SharedDocument[]> {
  const response = await apiFetch<{ documents: SharedDocument[] }>(
    `/api/shared-context/enterprises/${encodeURIComponent(enterpriseId)}/documents`,
    { method: 'GET' },
  );
  return response.documents;
}

export async function createSharedDocument(
  enterpriseId: string,
  input: { kind: SharedDocument['kind']; title: string },
): Promise<{ id: string }> {
  return apiFetch(`/api/shared-context/enterprises/${encodeURIComponent(enterpriseId)}/documents`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function createSharedDocumentVersion(
  documentId: string,
  input: { contentMd: string; label?: string },
): Promise<{ id: string; documentId: string; versionNumber: number; status: string }> {
  return apiFetch(`/api/shared-context/documents/${encodeURIComponent(documentId)}/versions`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function activateSharedDocumentVersion(versionId: string): Promise<{ ok: true; versionId: string; status: string }> {
  return apiFetch(`/api/shared-context/document-versions/${encodeURIComponent(versionId)}/activate`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function listSharedDocumentBindings(enterpriseId: string): Promise<SharedDocumentBinding[]> {
  const response = await apiFetch<{ bindings: SharedDocumentBinding[] }>(
    `/api/shared-context/enterprises/${encodeURIComponent(enterpriseId)}/document-bindings`,
    { method: 'GET' },
  );
  return response.bindings;
}

export async function createSharedDocumentBinding(
  enterpriseId: string,
  input: {
    documentId: string;
    versionId: string;
    workspaceId?: string | null;
    enrollmentId?: string | null;
    mode: 'required' | 'advisory';
    applicabilityRepoId?: string | null;
    applicabilityLanguage?: string | null;
    applicabilityPathPattern?: string | null;
  },
): Promise<{ id: string }> {
  return apiFetch(`/api/shared-context/enterprises/${encodeURIComponent(enterpriseId)}/document-bindings`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function getRuntimeAuthoredContext(
  enterpriseId: string,
  input: {
    canonicalRepoId?: string;
    workspaceId?: string;
    enrollmentId?: string;
    language?: string;
    filePath?: string;
  },
): Promise<RuntimeAuthoredContextBindingView[]> {
  const params = new URLSearchParams();
  if (input.canonicalRepoId) params.set('canonicalRepoId', input.canonicalRepoId);
  if (input.workspaceId) params.set('workspaceId', input.workspaceId);
  if (input.enrollmentId) params.set('enrollmentId', input.enrollmentId);
  if (input.language) params.set('language', input.language);
  if (input.filePath) params.set('filePath', input.filePath);
  const response = await apiFetch<{ bindings: RuntimeAuthoredContextBindingView[] }>(
    `/api/shared-context/enterprises/${encodeURIComponent(enterpriseId)}/runtime-authored-context?${params.toString()}`,
    { method: 'GET' },
  );
  return response.bindings;
}

export async function getSharedContextDiagnostics(
  enterpriseId: string,
  canonicalRepoId: string,
  input?: {
    workspaceId?: string;
    enrollmentId?: string;
    language?: string;
    filePath?: string;
  },
): Promise<SharedContextDiagnosticsView> {
  const params = new URLSearchParams();
  params.set('canonicalRepoId', canonicalRepoId);
  if (input?.workspaceId) params.set('workspaceId', input.workspaceId);
  if (input?.enrollmentId) params.set('enrollmentId', input.enrollmentId);
  if (input?.language) params.set('language', input.language);
  if (input?.filePath) params.set('filePath', input.filePath);
  return apiFetch(
    `/api/shared-context/enterprises/${encodeURIComponent(enterpriseId)}/diagnostics?${params.toString()}`,
    { method: 'GET' },
  );
}

export async function getPersonalCloudMemory(
  input?: {
    projectId?: string;
    projectionClass?: 'recent_summary' | 'durable_memory_candidate';
    query?: string;
    limit?: number;
  },
): Promise<ContextMemoryView> {
  const params = new URLSearchParams();
  if (input?.projectId) params.set('projectId', input.projectId);
  if (input?.projectionClass) params.set('projectionClass', input.projectionClass);
  if (input?.query) params.set('query', input.query);
  if (typeof input?.limit === 'number') params.set('limit', String(input.limit));
  return apiFetch(`/api/shared-context/personal-memory?${params.toString()}`, {
    method: 'GET',
  });
}

export async function getEnterpriseSharedMemory(
  enterpriseId: string,
  input?: {
    canonicalRepoId?: string;
    projectionClass?: 'recent_summary' | 'durable_memory_candidate';
    query?: string;
    limit?: number;
  },
): Promise<ContextMemoryView> {
  const params = new URLSearchParams();
  if (input?.canonicalRepoId) params.set('canonicalRepoId', input.canonicalRepoId);
  if (input?.projectionClass) params.set('projectionClass', input.projectionClass);
  if (input?.query) params.set('query', input.query);
  if (typeof input?.limit === 'number') params.set('limit', String(input.limit));
  return apiFetch(`/api/shared-context/enterprises/${encodeURIComponent(enterpriseId)}/memory?${params.toString()}`, {
    method: 'GET',
  });
}


export async function deletePersonalCloudMemory(memoryId: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/shared-context/personal-memory/${encodeURIComponent(memoryId)}`, {
    method: 'DELETE',
  });
}

export async function deleteEnterpriseSharedMemory(enterpriseId: string, memoryId: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/shared-context/enterprises/${encodeURIComponent(enterpriseId)}/memory/${encodeURIComponent(memoryId)}`, {
    method: 'DELETE',
  });
}
