import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildDesktopSetupLoginUrl,
  DESKTOP_SETUP_CALLBACK_PATH,
  DESKTOP_SETUP_DEFAULT_RELAY_URL,
  DESKTOP_SETUP_LOCAL_ACTION,
  DESKTOP_SETUP_TOKEN_EXCHANGE_PATH,
  sanitizeRemoteDesktopLocalSetupStatus,
  type DesktopSetupStep,
  type RemoteDesktopLocalSetupStatus,
} from '../../shared/desktop-setup-auth.js';
import { LOCAL_PANEL_EXTERNAL_PATH, LOCAL_PANEL_OPEN_ANSWER_BUDGET_MS } from '../../shared/local-panel-window.js';
import {
  REMOTE_DESKTOP_LOCAL_ACTION,
  REMOTE_DESKTOP_LOCAL_DAEMON_ACTION,
  REMOTE_DESKTOP_LOCAL_DAEMON_REASON,
  REMOTE_DESKTOP_LOCAL_MANAGEMENT,
  REMOTE_DESKTOP_LOCAL_WEB_ACTION,
  type RemoteDesktopLocalAction,
  type RemoteDesktopLocalDaemonAction,
  type RemoteDesktopLocalDaemonLogs,
  type RemoteDesktopLocalDaemonStatus,
  type RemoteDesktopLocalExtras,
  type RemoteDesktopLocalPermissionTarget,
  isRemoteDesktopLocalPermissionTarget,
  redactRemoteDesktopLocalSecrets,
  type RemoteDesktopLocalStatus,
  sanitizeRemoteDesktopLocalDaemonStatus,
  sanitizeRemoteDesktopLocalExtras,
  type RemoteDesktopLocalWebAction,
} from '../../shared/remote-desktop-local-management.js';
import { renderLocalPanelPage } from './local-panel-page.js';
import { localPanelText, type LocalPanelStringKey } from '../../shared/local-panel-strings.js';
import { isUiLocale, resolveUiLocale, type UiLocale } from '../../shared/ui-locale.js';
import {
  allowedEnrollmentServerOrigin,
  EnrollDirectUnsupportedError,
  type ControlledNodeCredential,
} from './enrollment.js';
import { validateBindUrl } from './local-daemon-control.js';

const MAX_BODY_BYTES = 4096;
const MAX_PANEL_SESSIONS = 8;
const PANEL_SESSION_TTL_MS = 8 * 60 * 60_000;
const SETUP_BROWSER_STATE_TTL_MS = 10 * 60_000;

export interface RemoteDesktopLocalPanelSetupOptions {
  prefilledRelayUrl?: string;
  existingDaemonBound?: boolean;
  existingDaemonRelayUrl?: string | null;
  openBrowser: (url: string) => Promise<boolean> | boolean;
  bindRelayAndEnroll: (
    relayOrigin: string,
    apiKey: string,
    onStep: (step: DesktopSetupStep) => void,
  ) => Promise<ControlledNodeCredential>;
  onSetupComplete: (credential: ControlledNodeCredential) => Promise<void> | void;
  fetchFn?: typeof fetch;
  now?: () => number;
  stateTtlMs?: number;
}

export interface RemoteDesktopLocalPanelRuntimeOptions {
  publicNodeId: string;
  serverUrl: string;
  status(): Omit<RemoteDesktopLocalStatus, 'publicNodeId'>;
  /** Optional host name and permission state for the panel; absent or malformed values are simply not shown. */
  extras?(): RemoteDesktopLocalExtras;
  /**
   * Opens the macOS System Settings pane for one permission, in the signed-in user's session. Absent (not macOS): the endpoint
   * answers 501 and the page shows no button. The target is a key from a fixed table, never a URL from the page.
   */
  openSettings?(target: RemoteDesktopLocalPermissionTarget): Promise<boolean>;
  setPaused(paused: boolean): Promise<void>;
  stopAll(): Promise<void>;
  disconnect(publicId: string): Promise<boolean>;
  /**
   * Opens one of the two fixed web-management destinations (manage or share) in the user's DEFAULT browser. The panel window itself
   * never navigates away; its two external links come here. Absent: the endpoint answers 501 and the links open as plain links.
   */
  openExternal?(target: RemoteDesktopLocalWebAction): Promise<boolean>;
  /**
   * Opens (or focuses) the panel as an independent window for the active user: what a native click (indicator, app) asks for. The
   * answer is the decision layer's reason code; `ok:false` means nothing could be opened, so the caller keeps its own fallback.
   */
  openWindow?(): Promise<{ ok: boolean; reason: string }>;
  /** Test seam: how long /open-window waits for the open before answering `in_progress` (default LOCAL_PANEL_OPEN_ANSWER_BUDGET_MS). */
  openWindowAnswerBudgetMs?: number;
  /** Optional Coding Daemon state provider, action dispatcher, and sanitized log reader. Absent: omitted from state and endpoints answer 501. */
  daemon?(): Promise<RemoteDesktopLocalDaemonStatus> | RemoteDesktopLocalDaemonStatus;
  daemonAction?(
    action: RemoteDesktopLocalDaemonAction,
    payload?: { bindUrl?: unknown; serverName?: unknown },
  ): Promise<{ ok: boolean; statusCode?: number; error?: string }>;
  daemonLogs?(): Promise<RemoteDesktopLocalDaemonLogs> | RemoteDesktopLocalDaemonLogs;
}

export interface RemoteDesktopLocalPanelOptions extends RemoteDesktopLocalPanelRuntimeOptions {
  host?: string;
  port?: number;
  setup?: RemoteDesktopLocalPanelSetupOptions;
}

export interface RemoteDesktopLocalPanel {
  readonly url: string;
  switchToRuntime(next: RemoteDesktopLocalPanelRuntimeOptions): void;
  close(): Promise<void>;
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookies(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries((request.headers.cookie ?? '').split(';').flatMap((part) => {
    const at = part.indexOf('=');
    return at > 0 ? [[part.slice(0, at).trim(), part.slice(at + 1).trim()]] : [];
  }));
}

function reply(response: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  response.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(bytes);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function remoteDesktopManagementUrl(
  serverUrl: string,
  publicNodeId: string,
  action: 'manage' | 'share',
): string {
  if (!serverUrl || !publicNodeId) return '';
  const url = new URL(serverUrl);
  url.searchParams.set(REMOTE_DESKTOP_LOCAL_MANAGEMENT.WEB_NODE_QUERY, publicNodeId);
  url.searchParams.set(REMOTE_DESKTOP_LOCAL_MANAGEMENT.WEB_ACTION_QUERY, action);
  return url.toString();
}

function parseAcceptLanguageTags(header: string | string[] | undefined): string[] {
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  if (!raw.trim()) return [];
  return raw
    .split(',')
    .map((part, idx) => {
      const [tagPart, ...params] = part.split(';').map((s) => s.trim());
      let q = 1;
      for (const param of params) {
        const match = /^q=([0-9]+(?:\.[0-9]+)?)$/iu.exec(param);
        if (match) q = Number.parseFloat(match[1]!);
      }
      return { tag: tagPart ?? '', q: Number.isFinite(q) ? q : 0, idx };
    })
    .filter((entry) => Boolean(entry.tag) && entry.q > 0)
    .sort((a, b) => (b.q - a.q) || (a.idx - b.idx))
    .map((entry) => entry.tag);
}

function resolveSetupCallbackLocale(request: IncomingMessage, storedLocale?: UiLocale): UiLocale {
  if (storedLocale && isUiLocale(storedLocale)) return storedLocale;
  return resolveUiLocale(parseAcceptLanguageTags(request.headers['accept-language']));
}

function buildSetupCallbackHtml(
  locale: UiLocale,
  ok: boolean,
  titleKey: LocalPanelStringKey,
  detailKey: LocalPanelStringKey,
): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const accent = ok ? '#10b981' : '#ef4444';
  const title = localPanelText(locale, titleKey);
  const detail = localPanelText(locale, detailKey);
  const backLabel = localPanelText(locale, 'setupCallbackBack');
  return `<!doctype html><html lang="${esc(locale)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(title)}</title>`
    + `<style>body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;box-sizing:border-box}`
    + `.card{max-width:420px;width:100%;background:#1e293b;border:1px solid #334155;border-radius:14px;padding:24px;text-align:center}`
    + `.badge{width:12px;height:12px;border-radius:999px;background:${accent};margin:0 auto 14px}`
    + `h1{font-size:18px;margin:0 0 8px}p{font-size:14px;color:#94a3b8;line-height:1.5;margin:0 0 18px}`
    + `a{display:inline-block;padding:10px 16px;border-radius:10px;background:#3b82f6;color:#fff;text-decoration:none;font-size:14px;font-weight:600}</style>`
    + `<div class="card"><div class="badge"></div><h1>${esc(title)}</h1><p>${esc(detail)}</p><a href="/">${esc(backLabel)}</a></div></html>`;
}

function replySetupCallback(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(html);
}

function mapSetupErrorCode(error: unknown): string {
  if (error instanceof EnrollDirectUnsupportedError) return 'setup_server_unsupported';
  const msg = error instanceof Error ? error.message : '';
  if (msg === REMOTE_DESKTOP_LOCAL_DAEMON_REASON.NOT_INSTALLED) return 'daemon_not_installed';
  if (msg === REMOTE_DESKTOP_LOCAL_DAEMON_REASON.NO_ACTIVE_USER) return 'daemon_no_active_user';
  if (msg === 'setup_relay_invalid' || msg.startsWith('enrollment_server_url_')) return 'setup_relay_invalid';
  if (msg === 'setup_bind_invalid') return 'setup_bind_invalid';
  return 'setup_bind_failed';
}

async function exchangeDesktopSetupNonce(
  relayOrigin: string,
  nonce: string,
  fetchFn: typeof fetch,
): Promise<string> {
  const response = await fetchFn(`${relayOrigin}${DESKTOP_SETUP_TOKEN_EXCHANGE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce }),
    redirect: 'error',
  });
  if (response.redirected || !response.url) {
    throw new Error('setup_nonce_exchange_redirect_rejected');
  }
  let resOrigin: string;
  try {
    resOrigin = new URL(response.url).origin;
  } catch {
    throw new Error('setup_nonce_exchange_url_invalid');
  }
  if (resOrigin !== relayOrigin) {
    throw new Error('setup_nonce_exchange_origin_mismatch');
  }
  if (!response.ok) {
    throw new Error(`setup_nonce_exchange_failed:${response.status}`);
  }
  const body = await response.json().catch(() => null) as { apiKey?: unknown } | null;
  if (!body || typeof body.apiKey !== 'string' || body.apiKey.length === 0) {
    throw new Error('setup_nonce_exchange_invalid_response');
  }
  return body.apiKey;
}

export async function startRemoteDesktopLocalPanel(
  options: RemoteDesktopLocalPanelOptions,
): Promise<RemoteDesktopLocalPanel> {
  const host = options.host ?? REMOTE_DESKTOP_LOCAL_MANAGEMENT.HOST;
  const port = options.port ?? REMOTE_DESKTOP_LOCAL_MANAGEMENT.PORT;
  const sessions = new Map<string, { csrf: string; expiresAt: number }>();
  let currentRuntime: RemoteDesktopLocalPanelRuntimeOptions = { ...options };
  let activeSetup: RemoteDesktopLocalPanelSetupOptions | null = options.setup ?? null;
  let switchedFromSetup = false;
  const nowFn = () => activeSetup?.now?.() ?? Date.now();
  let setupStatus: RemoteDesktopLocalSetupStatus | null = activeSetup
    ? {
        setupRequired: true,
        step: 'idle',
        prefilledRelayUrl: activeSetup.prefilledRelayUrl || DESKTOP_SETUP_DEFAULT_RELAY_URL,
        ...(typeof activeSetup.existingDaemonBound === 'boolean'
          ? { existingDaemonBound: activeSetup.existingDaemonBound }
          : {}),
        ...(activeSetup.existingDaemonRelayUrl
          ? { existingDaemonRelayUrl: activeSetup.existingDaemonRelayUrl }
          : {}),
        browserAuthPending: false,
      }
    : null;
  let pendingBrowserAuth: { state: string; relayOrigin: string; locale: UiLocale; expiresAt: number } | null = null;
  let lastBrowserAuthLocale: UiLocale | undefined;
  let expectedHost = `${host}:${port}`;
  let origin = `http://${expectedHost}`;
  let listenPort = port;
  let mutation: Promise<void> = Promise.resolve();
  let daemonMutation: Promise<void> = Promise.resolve();
  let setupMutation: Promise<void> = Promise.resolve();
  let setupInFlight = false;
  let openWindowInFlight: Promise<{ ok: boolean; reason: string }> | undefined;
  const mutate = async (action: () => Promise<void>): Promise<void> => {
    const current = mutation.then(action, action);
    mutation = current.catch(() => {});
    await current;
  };
  const mutateDaemon = async (action: () => Promise<void>): Promise<void> => {
    const current = daemonMutation.then(action, action);
    daemonMutation = current.catch(() => {});
    await current;
  };
  const runChainedSetup = async (relayOrigin: string, apiKey: string): Promise<void> => {
    if (!activeSetup) throw new Error('setup_not_active');
    if (setupInFlight) throw new Error('setup_in_flight');
    setupInFlight = true;
    const run = setupMutation.then(async () => {
      if (!activeSetup || !setupStatus) throw new Error('setup_not_active');
      setupStatus = {
        ...setupStatus,
        relayUrl: relayOrigin,
        browserAuthPending: false,
        error: null,
      };
      const credential = await activeSetup.bindRelayAndEnroll(relayOrigin, apiKey, (step) => {
        if (setupStatus) {
          setupStatus = { ...setupStatus, step, relayUrl: relayOrigin, browserAuthPending: false, error: null };
        }
      });
      if (setupStatus) {
        setupStatus = { ...setupStatus, step: 'starting_runtime', error: null };
      }
      await activeSetup.onSetupComplete(credential);
      if (setupStatus) {
        setupStatus = { ...setupStatus, setupRequired: false, step: 'completed', browserAuthPending: false, error: null };
      }
    });
    setupMutation = run.catch(() => {});
    try {
      await run;
    } finally {
      setupInFlight = false;
    }
  };
  const server: Server = createServer(async (request, response) => {
    if (request.headers.host !== expectedHost) return reply(response, 421, 'misdirected');
    const url = new URL(request.url ?? '/', origin);
    if (request.method === 'GET' && url.pathname === DESKTOP_SETUP_CALLBACK_PATH) {
      if (!activeSetup || !setupStatus || !setupStatus.setupRequired) {
        const cbLocale = resolveSetupCallbackLocale(request, pendingBrowserAuth?.locale ?? lastBrowserAuthLocale);
        return replySetupCallback(
          response,
          404,
          buildSetupCallbackHtml(cbLocale, false, 'setupCallbackInactiveTitle', 'setupCallbackInactiveDetail'),
        );
      }
      const now = nowFn();
      if (pendingBrowserAuth && now > pendingBrowserAuth.expiresAt) {
        pendingBrowserAuth = null;
      }
      const nonce = url.searchParams.get('nonce');
      const state = url.searchParams.get('state');
      if (
        !pendingBrowserAuth
        || typeof state !== 'string'
        || !secureEqual(state, pendingBrowserAuth.state)
        || typeof nonce !== 'string'
        || nonce.length === 0
        || nonce.length > 256
      ) {
        const cbLocale = resolveSetupCallbackLocale(request, pendingBrowserAuth?.locale ?? lastBrowserAuthLocale);
        return replySetupCallback(
          response,
          400,
          buildSetupCallbackHtml(cbLocale, false, 'setupCallbackInvalidTitle', 'setupCallbackInvalidDetail'),
        );
      }
      const matched = pendingBrowserAuth;
      pendingBrowserAuth = null;
      const cbLocale = resolveSetupCallbackLocale(request, matched.locale);
      try {
        setupStatus = {
          ...setupStatus,
          step: 'exchanging_nonce',
          relayUrl: matched.relayOrigin,
          browserAuthPending: false,
          error: null,
        };
        const apiKey = await exchangeDesktopSetupNonce(
          matched.relayOrigin,
          nonce,
          activeSetup.fetchFn ?? fetch,
        );
        await runChainedSetup(matched.relayOrigin, apiKey);
        return replySetupCallback(
          response,
          200,
          buildSetupCallbackHtml(cbLocale, true, 'setupCallbackSuccessTitle', 'setupCallbackSuccessDetail'),
        );
      } catch (err) {
        const errorCode = mapSetupErrorCode(err);
        if (setupStatus) {
          setupStatus = {
            ...setupStatus,
            step: 'failed',
            browserAuthPending: false,
            error: errorCode,
          };
        }
        return replySetupCallback(
          response,
          502,
          buildSetupCallbackHtml(cbLocale, false, 'setupCallbackFailedTitle', 'setupCallbackFailedDetail'),
        );
      }
    }
    const cookie = cookies(request)[REMOTE_DESKTOP_LOCAL_MANAGEMENT.COOKIE_NAME];
    if (request.method === 'GET' && url.pathname === REMOTE_DESKTOP_LOCAL_MANAGEMENT.ROOT_PATH) {
      const now = Date.now();
      for (const [key, value] of sessions) {
        if (value.expiresAt <= now) sessions.delete(key);
      }
      while (sessions.size >= MAX_PANEL_SESSIONS) {
        const oldest = sessions.keys().next().value as string | undefined;
        if (!oldest) break;
        sessions.delete(oldest);
      }
      const session = randomBytes(32).toString('base64url');
      const csrf = randomBytes(32).toString('base64url');
      sessions.set(session, { csrf, expiresAt: now + PANEL_SESSION_TTL_MS });
      response.setHeader('set-cookie', `${REMOTE_DESKTOP_LOCAL_MANAGEMENT.COOKIE_NAME}=${session}; HttpOnly; SameSite=Strict; Path=/`);
      return reply(response, 200, renderLocalPanelPage({
        publicNodeId: currentRuntime.publicNodeId,
        manageUrl: remoteDesktopManagementUrl(currentRuntime.serverUrl, currentRuntime.publicNodeId, REMOTE_DESKTOP_LOCAL_WEB_ACTION.MANAGE),
        shareUrl: remoteDesktopManagementUrl(currentRuntime.serverUrl, currentRuntime.publicNodeId, REMOTE_DESKTOP_LOCAL_WEB_ACTION.SHARE),
        csrf,
      }), 'text/html; charset=utf-8');
    }
    if (request.method === 'POST' && url.pathname === REMOTE_DESKTOP_LOCAL_MANAGEMENT.OPEN_WINDOW_PATH) {
      // A native client, not a page: it sends this custom header and NO Origin. A web page cannot do either (a custom header forces a
      // preflight this server never answers, and every cross-site POST carries an Origin), so no site can make the node open windows.
      if (request.headers.origin !== undefined || request.headers[REMOTE_DESKTOP_LOCAL_MANAGEMENT.OPEN_WINDOW_HEADER] !== '1') {
        return reply(response, 403, 'forbidden');
      }
      if (!currentRuntime.openWindow) return reply(response, 501, 'not_implemented');
      openWindowInFlight ??= currentRuntime.openWindow().catch(() => ({ ok: false, reason: 'launch_failed' })).finally(() => { openWindowInFlight = undefined; });
      // A slow machine may take longer than the client is willing to wait; the open keeps going and the client is told so (200), not left
      // to time out and open the browser as well.
      const budget = currentRuntime.openWindowAnswerBudgetMs ?? LOCAL_PANEL_OPEN_ANSWER_BUDGET_MS;
      let budgetTimer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        openWindowInFlight,
        new Promise<{ ok: boolean; reason: string }>((resolve) => { budgetTimer = setTimeout(() => resolve({ ok: true, reason: 'in_progress' }), budget); }),
      ]);
      if (budgetTimer) clearTimeout(budgetTimer);
      return reply(response, outcome.ok ? 200 : 502, JSON.stringify(outcome), 'application/json; charset=utf-8');
    }
    const session = typeof cookie === 'string' ? sessions.get(cookie) : undefined;
    if (!session || session.expiresAt <= Date.now()) {
      if (typeof cookie === 'string') sessions.delete(cookie);
      return reply(response, 401, 'unauthorized');
    }
    if (request.method === 'GET' && url.pathname === REMOTE_DESKTOP_LOCAL_MANAGEMENT.STATE_PATH) {
      let extras: RemoteDesktopLocalExtras = {};
      try { extras = sanitizeRemoteDesktopLocalExtras(currentRuntime.extras?.()); } catch { /* the panel works without them */ }
      let daemon: RemoteDesktopLocalDaemonStatus | undefined;
      if (currentRuntime.daemon) {
        try {
          daemon = sanitizeRemoteDesktopLocalDaemonStatus(await currentRuntime.daemon());
        } catch {
          /* omit malformed or failing daemon status */
        }
      }
      const sanitizedSetup = setupStatus?.setupRequired
        ? sanitizeRemoteDesktopLocalSetupStatus(setupStatus)
        : undefined;
      const payload = {
        publicNodeId: currentRuntime.publicNodeId,
        ...currentRuntime.status(),
        ...extras,
        ...(daemon ? { daemon } : {}),
        ...(sanitizedSetup ? { setup: sanitizedSetup } : {}),
        ...(switchedFromSetup && currentRuntime.serverUrl && currentRuntime.publicNodeId
          ? {
              manageUrl: remoteDesktopManagementUrl(currentRuntime.serverUrl, currentRuntime.publicNodeId, REMOTE_DESKTOP_LOCAL_WEB_ACTION.MANAGE),
              shareUrl: remoteDesktopManagementUrl(currentRuntime.serverUrl, currentRuntime.publicNodeId, REMOTE_DESKTOP_LOCAL_WEB_ACTION.SHARE),
            }
          : {}),
      };
      return reply(response, 200, JSON.stringify(payload), 'application/json; charset=utf-8');
    }
    if (request.method === 'GET' && url.pathname === REMOTE_DESKTOP_LOCAL_MANAGEMENT.DAEMON_LOGS_PATH) {
      if (!currentRuntime.daemonLogs) return reply(response, 501, 'not_implemented');
      try {
        const raw = await currentRuntime.daemonLogs();
        const redacted = typeof raw?.text === 'string'
          ? redactRemoteDesktopLocalSecrets(raw.text, { preserveNewlines: true }).slice(-65536)
          : '';
        const logs: RemoteDesktopLocalDaemonLogs = {
          text: redacted,
          truncated: Boolean(raw?.truncated),
          ...(typeof raw?.source === 'string' && raw.source ? { source: raw.source } : {}),
        };
        return reply(response, 200, JSON.stringify(logs), 'application/json; charset=utf-8');
      } catch {
        return reply(response, 500, 'logs_failed');
      }
    }
    if (request.method === 'POST' && url.pathname === REMOTE_DESKTOP_LOCAL_MANAGEMENT.ACTION_PATH) {
      const csrfHeader = request.headers[REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER];
      if (request.headers.origin !== origin
        || typeof csrfHeader !== 'string'
        || !secureEqual(csrfHeader, session.csrf)) {
        return reply(response, 403, 'forbidden');
      }
      const body = await readJson(request);
      const action = body?.action as string | undefined;
      const isDaemonAction = typeof action === 'string'
        && (Object.values(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION) as string[]).includes(action);
      let found = true;
      try {
        if (action === REMOTE_DESKTOP_LOCAL_ACTION.PAUSE) {
          await mutate(() => currentRuntime.setPaused(true));
        } else if (action === REMOTE_DESKTOP_LOCAL_ACTION.RESUME) {
          await mutate(() => currentRuntime.setPaused(false));
        } else if (action === REMOTE_DESKTOP_LOCAL_ACTION.STOP_ALL) {
          await mutate(currentRuntime.stopAll);
        } else if (action === REMOTE_DESKTOP_LOCAL_ACTION.DISCONNECT && typeof body?.id === 'string') {
          await mutate(async () => { found = await currentRuntime.disconnect(body.id as string); });
          if (!found) return reply(response, 404, 'not_found');
        } else if (action === DESKTOP_SETUP_LOCAL_ACTION.START_BROWSER_AUTH) {
          if (!activeSetup || !setupStatus || !setupStatus.setupRequired) {
            return reply(response, 409, 'setup_not_active');
          }
          const rawRelayUrl = typeof body?.relayUrl === 'string' && body.relayUrl.trim()
            ? body.relayUrl.trim()
            : setupStatus.prefilledRelayUrl;
          let relayOrigin: string;
          try {
            relayOrigin = allowedEnrollmentServerOrigin(rawRelayUrl);
          } catch {
            setupStatus = { ...setupStatus, step: 'failed', browserAuthPending: false, error: 'setup_relay_invalid' };
            return reply(response, 400, JSON.stringify({ ok: false, error: 'setup_relay_invalid' }), 'application/json; charset=utf-8');
          }
          const state = randomBytes(24).toString('base64url');
          const callbackUrl = `http://${host}:${listenPort}${DESKTOP_SETUP_CALLBACK_PATH}?state=${state}`;
          const loginUrl = buildDesktopSetupLoginUrl(relayOrigin, callbackUrl);
          const requestedLocale = isUiLocale(body?.locale)
            ? body.locale
            : resolveSetupCallbackLocale(request, lastBrowserAuthLocale);
          lastBrowserAuthLocale = requestedLocale;
          pendingBrowserAuth = {
            state,
            relayOrigin,
            locale: requestedLocale,
            expiresAt: nowFn() + (activeSetup.stateTtlMs ?? SETUP_BROWSER_STATE_TTL_MS),
          };
          setupStatus = {
            ...setupStatus,
            step: 'awaiting_browser',
            relayUrl: relayOrigin,
            browserAuthPending: true,
            error: null,
          };
          const opened = await activeSetup.openBrowser(loginUrl);
          if (!opened) {
            pendingBrowserAuth = null;
            setupStatus = {
              ...setupStatus,
              step: 'failed',
              browserAuthPending: false,
              error: 'setup_browser_open_failed',
            };
            return reply(response, 502, JSON.stringify({ ok: false, error: 'setup_browser_open_failed' }), 'application/json; charset=utf-8');
          }
          return reply(response, 200, JSON.stringify({ ok: true, step: 'awaiting_browser' }), 'application/json; charset=utf-8');
        } else if (action === DESKTOP_SETUP_LOCAL_ACTION.CANCEL_BROWSER_AUTH) {
          pendingBrowserAuth = null;
          if (setupStatus && setupStatus.setupRequired) {
            setupStatus = { ...setupStatus, step: 'idle', browserAuthPending: false, error: null };
          }
        } else if (action === DESKTOP_SETUP_LOCAL_ACTION.BIND_MANUAL) {
          if (!activeSetup || !setupStatus || !setupStatus.setupRequired) {
            return reply(response, 409, 'setup_not_active');
          }
          const parsedBind = validateBindUrl(body?.bindUrl);
          if (!parsedBind.ok) {
            setupStatus = { ...setupStatus, step: 'failed', browserAuthPending: false, error: 'setup_bind_invalid' };
            return reply(response, 400, JSON.stringify({ ok: false, error: 'setup_bind_invalid' }), 'application/json; charset=utf-8');
          }
          let relayOrigin: string;
          try {
            relayOrigin = allowedEnrollmentServerOrigin(parsedBind.workerUrl);
          } catch {
            setupStatus = { ...setupStatus, step: 'failed', browserAuthPending: false, error: 'setup_relay_invalid' };
            return reply(response, 400, JSON.stringify({ ok: false, error: 'setup_relay_invalid' }), 'application/json; charset=utf-8');
          }
          pendingBrowserAuth = null;
          try {
            await runChainedSetup(relayOrigin, parsedBind.apiKey);
          } catch (err) {
            const errorCode = mapSetupErrorCode(err);
            setupStatus = { ...setupStatus, step: 'failed', browserAuthPending: false, error: errorCode };
            return reply(response, 502, JSON.stringify({ ok: false, error: errorCode }), 'application/json; charset=utf-8');
          }
        } else if (isDaemonAction) {
          if (!currentRuntime.daemonAction) return reply(response, 501, 'not_implemented');
          let result: { ok: boolean; statusCode?: number; error?: string } = { ok: false, statusCode: 500, error: 'action_failed' };
          await mutateDaemon(async () => {
            result = await currentRuntime.daemonAction!(action as RemoteDesktopLocalDaemonAction, {
              bindUrl: body?.bindUrl,
              serverName: body?.serverName,
            });
          });
          if (!result.ok) {
            const safeError = redactRemoteDesktopLocalSecrets(result.error ?? 'action_failed', { maxChars: 120 }) || 'action_failed';
            return reply(
              response,
              result.statusCode ?? 400,
              JSON.stringify({ ok: false, error: safeError }),
              'application/json; charset=utf-8',
            );
          }
        } else return reply(response, 400, 'invalid_action');
      } catch {
        return reply(response, 500, 'action_failed');
      }
      return reply(response, 200, '{"ok":true}', 'application/json; charset=utf-8');
    }
    if (request.method === 'POST' && url.pathname === REMOTE_DESKTOP_LOCAL_MANAGEMENT.OPEN_SETTINGS_PATH) {
      // Same gate as /open-external: exact Host (above), this session's cookie, the panel's own Origin, the CSRF token. The target is a
      // key into a fixed table of System Settings panes, so this can never be made to open a URL of the caller's choosing.
      const csrfHeader = request.headers[REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER];
      if (request.headers.origin !== origin || typeof csrfHeader !== 'string' || !secureEqual(csrfHeader, session.csrf)) {
        return reply(response, 403, 'forbidden');
      }
      if (!currentRuntime.openSettings) return reply(response, 501, 'not_implemented');
      const body = await readJson(request);
      const target = body?.target;
      if (!isRemoteDesktopLocalPermissionTarget(target)) return reply(response, 400, 'invalid_target');
      let opened = false;
      try { opened = await currentRuntime.openSettings(target); } catch { opened = false; }
      return reply(response, opened ? 200 : 502, opened ? '{"ok":true}' : 'open_failed', opened ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
    }
    if (request.method === 'POST' && url.pathname === LOCAL_PANEL_EXTERNAL_PATH) {
      // Same gate as every mutation (exact Host above, this session's cookie, the panel's own Origin, the CSRF token), and the target
      // is one of two fixed words: the destination URL is built by the node, never taken from the request, so this is not a redirect.
      const csrfHeader = request.headers[REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER];
      if (request.headers.origin !== origin || typeof csrfHeader !== 'string' || !secureEqual(csrfHeader, session.csrf)) {
        return reply(response, 403, 'forbidden');
      }
      if (!currentRuntime.openExternal) return reply(response, 501, 'not_implemented');
      const body = await readJson(request);
      const target = body?.target;
      if (target !== REMOTE_DESKTOP_LOCAL_WEB_ACTION.MANAGE && target !== REMOTE_DESKTOP_LOCAL_WEB_ACTION.SHARE) return reply(response, 400, 'invalid_target');
      let opened = false;
      try { opened = await currentRuntime.openExternal(target); } catch { opened = false; }
      return reply(response, opened ? 200 : 502, opened ? '{"ok":true}' : 'open_failed', opened ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
    }
    return reply(response, 404, 'not_found');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('remote_desktop_local_panel_address_unavailable');
  }
  listenPort = address.port;
  expectedHost = `${host}:${address.port}`;
  origin = `http://${expectedHost}`;
  return {
    url: `${origin}/`,
    switchToRuntime: (next: RemoteDesktopLocalPanelRuntimeOptions) => {
      currentRuntime = { ...next };
      activeSetup = null;
      pendingBrowserAuth = null;
      switchedFromSetup = true;
      setupStatus = null;
    },
    close: () => {
      pendingBrowserAuth = null;
      activeSetup = null;
      return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
