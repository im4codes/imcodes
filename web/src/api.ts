/**
 * Fetch wrapper with cookie-based auth for the IM.codes API.
 * Credentials (rcc_session) are sent automatically via HttpOnly cookie.
 * CSRF token is read from the rcc_csrf cookie and sent as X-CSRF-Token.
 */

let _baseUrl = '';
let _onAuthExpired: ((reason?: string) => void) | null = null;
let _apiKey: string | null = null;

// Hydrate API key from localStorage on module load so it's available before
// any async Capacitor Preferences read completes. This prevents race conditions
// where apiFetch is called before configureApiKey() in the native init effect.
try {
  const stored = localStorage.getItem('rcc_api_key');
  if (stored) _apiKey = stored;
} catch { /* SSR or restricted storage */ }

/** Set a Bearer API key for native app auth (replaces cookie+CSRF). */
export function configureApiKey(key: string): void {
  _apiKey = key;
  try { localStorage.setItem('rcc_api_key', key); } catch { /* ignore */ }
}
/** Clear the Bearer API key (reverts to cookie auth). */
export function clearApiKey(): void {
  _apiKey = null;
  try { localStorage.removeItem('rcc_api_key'); } catch { /* ignore */ }
}

export function configure(baseUrl: string): void {
  _baseUrl = baseUrl.replace(/\/$/, '');
}

/** Register a callback invoked when the session expires and refresh fails. */
export function onAuthExpired(cb: (reason?: string) => void): void {
  _onAuthExpired = cb;
}

function getCsrfToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)rcc_csrf=([^;]+)/);
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
  const hasSession = document.cookie.includes('rcc_session');
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

async function rawFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const headers = new Headers(opts.headers);
  if (!headers.has('Content-Type') && opts.body && !(opts.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (_apiKey) {
    // Native: Bearer token auth (CSRF middleware skips Bearer auth requests)
    headers.set('Authorization', `Bearer ${_apiKey}`);
  } else {
    // Web: cookie auth + CSRF token
    const method = (opts.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const csrf = getCsrfToken();
      if (csrf) headers.set('X-CSRF-Token', csrf);
    }
  }
  // Native (Bearer auth): omit credentials — no cookies needed, and 'include' would
  // require Access-Control-Allow-Credentials from the server (cross-origin from capacitor://).
  // Web (cookie auth): include credentials so HttpOnly cookies are sent.
  return fetch(`${_baseUrl}${path}`, { ...opts, headers, credentials: _apiKey ? 'omit' : 'include' });
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

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApiError(res.status, body);
  }

  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`API ${status}: ${body}`);
    this.name = 'ApiError';
  }
}

// ── Sub-session API ───────────────────────────────────────────────────────

export interface SubSessionData {
  id: string;
  serverId: string;
  type: string;
  shellBin?: string | null;
  cwd?: string | null;
  label?: string | null;
  closedAt?: number | null;
  createdAt: number;
  updatedAt: number;
  ccSessionId?: string | null;
  geminiSessionId?: string | null;
  parentSession?: string | null;
}

export async function listSubSessions(serverId: string): Promise<SubSessionData[]> {
  const res = await apiFetch<{ subSessions: Array<{
    id: string; server_id: string; type: string; shell_bin: string | null;
    cwd: string | null; label: string | null; closed_at: number | null;
    created_at: number; updated_at: number; cc_session_id: string | null;
    gemini_session_id: string | null; parent_session: string | null;
  }> }>(`/api/server/${serverId}/sub-sessions`);
  return res.subSessions.map((s) => ({
    id: s.id, serverId: s.server_id, type: s.type,
    shellBin: s.shell_bin, cwd: s.cwd, label: s.label,
    closedAt: s.closed_at, createdAt: s.created_at, updatedAt: s.updated_at,
    ccSessionId: s.cc_session_id,
    geminiSessionId: s.gemini_session_id,
    parentSession: s.parent_session,
  }));
}

export async function createSubSession(
  serverId: string,
  body: { type: string; shellBin?: string; cwd?: string; label?: string; ccSessionId?: string; parentSession?: string | null },
): Promise<{ id: string; sessionName: string; subSession: SubSessionData }> {
  const res = await apiFetch<{ id: string; sessionName: string; subSession: {
    id: string; server_id: string; type: string; shell_bin: string | null;
    cwd: string | null; label: string | null; closed_at: number | null;
    created_at: number; updated_at: number; cc_session_id: string | null;
    parent_session: string | null;
  } }>(`/api/server/${serverId}/sub-sessions`, {
    method: 'POST',
    body: JSON.stringify({ ...body, cc_session_id: body.ccSessionId ?? null, parent_session: body.parentSession ?? null }),
  });
  const s = res.subSession;
  return {
    id: res.id,
    sessionName: res.sessionName,
    subSession: {
      id: s.id, serverId: s.server_id, type: s.type,
      shellBin: s.shell_bin, cwd: s.cwd, label: s.label,
      closedAt: s.closed_at, createdAt: s.created_at, updatedAt: s.updated_at,
      ccSessionId: s.cc_session_id,
      parentSession: s.parent_session,
    },
  };
}

export async function patchSubSession(
  serverId: string,
  subId: string,
  body: { label?: string | null; closedAt?: number | null },
): Promise<void> {
  await apiFetch(`/api/server/${serverId}/sub-sessions/${subId}`, {
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

export async function saveUserPref(key: string, value: unknown): Promise<void> {
  await apiFetch(`/api/preferences/${key}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  });
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

export async function passkeyLoginComplete(challengeId: string, response: unknown): Promise<void> {
  await apiFetch('/api/auth/passkey/login/complete', {
    method: 'POST',
    body: JSON.stringify({ challengeId, response }),
  });
}

/** Native-only: exchange passkey credential for an API key (does not set cookie). */
export async function passkeyLoginCompleteNative(
  challengeId: string,
  response: unknown,
): Promise<{ apiKey: string; keyId: string; userId: string }> {
  return apiFetch('/api/auth/passkey/login/complete?native=1', {
    method: 'POST',
    body: JSON.stringify({ challengeId, response }),
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

  // Use XHR for upload progress reporting
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${_baseUrl}/api/server/${serverId}/upload`);

    // Auth headers (same as rawFetch)
    if (_apiKey) {
      xhr.setRequestHeader('Authorization', `Bearer ${_apiKey}`);
    } else {
      xhr.withCredentials = true;
      const csrf = document.cookie.match(/rcc_csrf=([^;]+)/)?.[1];
      if (csrf) xhr.setRequestHeader('X-CSRF-Token', csrf);
    }

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
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
  const res = await rawFetch(`/api/server/${serverId}/uploads/${attachmentId}/download`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApiError(res.status, body);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition');
  let filename = attachmentId;
  if (disposition) {
    const match = disposition.match(/filename="?(.+?)"?$/);
    if (match) filename = match[1];
  }
  // Trigger browser download
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
