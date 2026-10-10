import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { LOCAL_PANEL_EXTERNAL_PATH, LOCAL_PANEL_OPEN_ANSWER_BUDGET_MS } from '../../shared/local-panel-window.js';
import {
  REMOTE_DESKTOP_LOCAL_ACTION,
  REMOTE_DESKTOP_LOCAL_MANAGEMENT,
  REMOTE_DESKTOP_LOCAL_WEB_ACTION,
  type RemoteDesktopLocalAction,
  type RemoteDesktopLocalExtras,
  type RemoteDesktopLocalPermissionTarget,
  isRemoteDesktopLocalPermissionTarget,
  type RemoteDesktopLocalStatus,
  sanitizeRemoteDesktopLocalExtras,
  type RemoteDesktopLocalWebAction,
} from '../../shared/remote-desktop-local-management.js';
import { renderLocalPanelPage } from './local-panel-page.js';

const MAX_BODY_BYTES = 4096;
const MAX_PANEL_SESSIONS = 8;
const PANEL_SESSION_TTL_MS = 8 * 60 * 60_000;

export interface RemoteDesktopLocalPanelOptions {
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
  host?: string;
  port?: number;
}

export interface RemoteDesktopLocalPanel {
  readonly url: string;
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
  const url = new URL(serverUrl);
  url.searchParams.set(REMOTE_DESKTOP_LOCAL_MANAGEMENT.WEB_NODE_QUERY, publicNodeId);
  url.searchParams.set(REMOTE_DESKTOP_LOCAL_MANAGEMENT.WEB_ACTION_QUERY, action);
  return url.toString();
}

export async function startRemoteDesktopLocalPanel(
  options: RemoteDesktopLocalPanelOptions,
): Promise<RemoteDesktopLocalPanel> {
  const host = options.host ?? REMOTE_DESKTOP_LOCAL_MANAGEMENT.HOST;
  const port = options.port ?? REMOTE_DESKTOP_LOCAL_MANAGEMENT.PORT;
  const sessions = new Map<string, { csrf: string; expiresAt: number }>();
  let expectedHost = `${host}:${port}`;
  let origin = `http://${expectedHost}`;
  let mutation: Promise<void> = Promise.resolve();
  let openWindowInFlight: Promise<{ ok: boolean; reason: string }> | undefined;
  const mutate = async (action: () => Promise<void>): Promise<void> => {
    const current = mutation.then(action, action);
    mutation = current.catch(() => {});
    await current;
  };
  const server: Server = createServer(async (request, response) => {
    if (request.headers.host !== expectedHost) return reply(response, 421, 'misdirected');
    const url = new URL(request.url ?? '/', origin);
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
        publicNodeId: options.publicNodeId,
        manageUrl: remoteDesktopManagementUrl(options.serverUrl, options.publicNodeId, REMOTE_DESKTOP_LOCAL_WEB_ACTION.MANAGE),
        shareUrl: remoteDesktopManagementUrl(options.serverUrl, options.publicNodeId, REMOTE_DESKTOP_LOCAL_WEB_ACTION.SHARE),
        csrf,
      }), 'text/html; charset=utf-8');
    }
    if (request.method === 'POST' && url.pathname === REMOTE_DESKTOP_LOCAL_MANAGEMENT.OPEN_WINDOW_PATH) {
      // A native client, not a page: it sends this custom header and NO Origin. A web page cannot do either (a custom header forces a
      // preflight this server never answers, and every cross-site POST carries an Origin), so no site can make the node open windows.
      if (request.headers.origin !== undefined || request.headers[REMOTE_DESKTOP_LOCAL_MANAGEMENT.OPEN_WINDOW_HEADER] !== '1') {
        return reply(response, 403, 'forbidden');
      }
      if (!options.openWindow) return reply(response, 501, 'not_implemented');
      openWindowInFlight ??= options.openWindow().catch(() => ({ ok: false, reason: 'launch_failed' })).finally(() => { openWindowInFlight = undefined; });
      // A slow machine may take longer than the client is willing to wait; the open keeps going and the client is told so (200), not left
      // to time out and open the browser as well.
      const budget = options.openWindowAnswerBudgetMs ?? LOCAL_PANEL_OPEN_ANSWER_BUDGET_MS;
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
      try { extras = sanitizeRemoteDesktopLocalExtras(options.extras?.()); } catch { /* the panel works without them */ }
      return reply(response, 200, JSON.stringify({ publicNodeId: options.publicNodeId, ...options.status(), ...extras }), 'application/json; charset=utf-8');
    }
    if (request.method === 'POST' && url.pathname === REMOTE_DESKTOP_LOCAL_MANAGEMENT.ACTION_PATH) {
      const csrfHeader = request.headers[REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER];
      if (request.headers.origin !== origin
        || typeof csrfHeader !== 'string'
        || !secureEqual(csrfHeader, session.csrf)) {
        return reply(response, 403, 'forbidden');
      }
      const body = await readJson(request);
      const action = body?.action as RemoteDesktopLocalAction | undefined;
      let found = true;
      try {
        if (action === REMOTE_DESKTOP_LOCAL_ACTION.PAUSE) {
          await mutate(() => options.setPaused(true));
        } else if (action === REMOTE_DESKTOP_LOCAL_ACTION.RESUME) {
          await mutate(() => options.setPaused(false));
        } else if (action === REMOTE_DESKTOP_LOCAL_ACTION.STOP_ALL) {
          await mutate(options.stopAll);
        } else if (action === REMOTE_DESKTOP_LOCAL_ACTION.DISCONNECT && typeof body?.id === 'string') {
          await mutate(async () => { found = await options.disconnect(body.id as string); });
          if (!found) return reply(response, 404, 'not_found');
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
      if (!options.openSettings) return reply(response, 501, 'not_implemented');
      const body = await readJson(request);
      const target = body?.target;
      if (!isRemoteDesktopLocalPermissionTarget(target)) return reply(response, 400, 'invalid_target');
      let opened = false;
      try { opened = await options.openSettings(target); } catch { opened = false; }
      return reply(response, opened ? 200 : 502, opened ? '{"ok":true}' : 'open_failed', opened ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
    }
    if (request.method === 'POST' && url.pathname === LOCAL_PANEL_EXTERNAL_PATH) {
      // Same gate as every mutation (exact Host above, this session's cookie, the panel's own Origin, the CSRF token), and the target
      // is one of two fixed words: the destination URL is built by the node, never taken from the request, so this is not a redirect.
      const csrfHeader = request.headers[REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER];
      if (request.headers.origin !== origin || typeof csrfHeader !== 'string' || !secureEqual(csrfHeader, session.csrf)) {
        return reply(response, 403, 'forbidden');
      }
      if (!options.openExternal) return reply(response, 501, 'not_implemented');
      const body = await readJson(request);
      const target = body?.target;
      if (target !== REMOTE_DESKTOP_LOCAL_WEB_ACTION.MANAGE && target !== REMOTE_DESKTOP_LOCAL_WEB_ACTION.SHARE) return reply(response, 400, 'invalid_target');
      let opened = false;
      try { opened = await options.openExternal(target); } catch { opened = false; }
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
  expectedHost = `${host}:${address.port}`;
  origin = `http://${expectedHost}`;
  return {
    url: `${origin}/`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
