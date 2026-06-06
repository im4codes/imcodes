import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../env.js';
import { requireAuth, resolveAuth } from '../security/authorization.js';
import { LocalWebPreviewRegistry, normalizeLocalPreviewPath } from '../preview/registry.js';
import { commitAuthorizedAccess, resolveLocalPreviewAccess } from '../preview/access.js';
import { resolveServerMemberAccessOrShareDeny } from './share-http-auth.js';
import { rewritePreviewHtmlDocument, shouldRewritePreviewHtml } from '../preview/policy.js';
import {
  appendPreviewAccessTokenIfMissing,
  filterPreviewResponseHeaders,
  normalizePreviewUpstreamPath,
  redactPreviewHeaders,
  rewritePreviewRedirectLocation,
  rewriteSetCookieHeader,
  sanitizePreviewRequestHeaders,
  stripPreviewAccessTokenFromUpstreamPath,
} from '../../../shared/preview-policy.js';
import {
  PREVIEW_ACCESS_TOKEN_QUERY_PARAM,
  PREVIEW_ERROR,
  PREVIEW_INFLIGHT_REJECT_HTTP_STATUS,
  PREVIEW_LIMITS,
  PREVIEW_MSG,
  type CreatePreviewRequest,
} from '../../../shared/preview-types.js';
import { WsBridge } from '../ws/bridge.js';
import { randomHex } from '../security/crypto.js';
import logger from '../util/logger.js';
import { z } from 'zod';
import { COOKIE_PREVIEW_ACCESS } from '../../../shared/cookie-names.js';

export const localWebPreviewRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

const createSchema = z.object({
  port: z.number().int().min(1).max(65535),
  path: z.string().max(1024).optional(),
});

/**
 * Build the path?query forwarded to the local upstream. The preview access
 * token is stripped via the shared `stripPreviewAccessTokenFromUpstreamPath`
 * (run 8a975732-23a P0.3) — the same single entry point the WS upgrade uses —
 * so the untrusted upstream never sees this replayable credential.
 */
function getUpstreamPath(url: URL, serverId: string, previewId: string): string {
  const prefix = `/api/server/${serverId}/local-web/${previewId}`;
  const pathname = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) || '/' : '/';
  const stripped = stripPreviewAccessTokenFromUpstreamPath(`${pathname}${url.search}`);
  return normalizePreviewUpstreamPath(stripped);
}

function getSetCookieValues(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetSetCookie.getSetCookie === 'function') {
    return withGetSetCookie.getSetCookie();
  }
  if (headers.has('set-cookie')) {
    logger.warn({}, 'Preview response Set-Cookie stripping fallback triggered; getSetCookie() unavailable');
  }
  return [];
}

function buildPreviewAccessCookiePath(serverId: string, previewId: string): string {
  return `/api/server/${serverId}/local-web/${previewId}`;
}

function buildPreviewInitialUrl(serverId: string, previewId: string, path: string, accessToken: string): string {
  const initialPath = path === '/' ? '/' : path;
  const url = new URL(`http://preview.invalid/api/server/${serverId}/local-web/${previewId}${initialPath}`);
  url.searchParams.set(PREVIEW_ACCESS_TOKEN_QUERY_PARAM, accessToken);
  return `${url.pathname}${url.search}`;
}

function setPreviewAccessCookie(c: Parameters<typeof setCookie>[0], serverId: string, previewId: string, accessToken: string): void {
  const isSecure = new URL(c.req.url).protocol === 'https:';
  setCookie(c, COOKIE_PREVIEW_ACCESS, accessToken, {
    path: buildPreviewAccessCookiePath(serverId, previewId),
    httpOnly: true,
    secure: isSecure,
    sameSite: 'Strict',
    maxAge: Math.floor(PREVIEW_LIMITS.DEFAULT_TTL_MS / 1000),
  });
}

localWebPreviewRoutes.post('/:id/local-web-preview', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const access = await resolveServerMemberAccessOrShareDeny(c.env.DB, { serverId, userId });
  if (!access.ok) return c.json({ error: PREVIEW_ERROR.FORBIDDEN, reason: access.reason }, 403);

  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body satisfies CreatePreviewRequest | null);
  if (!parsed.success) return c.json({ error: PREVIEW_ERROR.INVALID_PORT }, 400);

  try {
    const registry = LocalWebPreviewRegistry.get(serverId);
    const { preview, accessToken } = registry.create(userId, parsed.data.port, normalizeLocalPreviewPath(parsed.data.path));
    return c.json({
      ok: true,
      preview: {
        id: preview.id,
        serverId: preview.serverId,
        port: preview.port,
        path: preview.path,
        expiresAt: preview.expiresAt,
        accessToken,
        url: buildPreviewInitialUrl(serverId, preview.id, preview.path, accessToken),
      },
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'preview_limit_exceeded') {
      return c.json({ error: PREVIEW_ERROR.LIMIT_EXCEEDED, maxActive: PREVIEW_LIMITS.MAX_ACTIVE_PREVIEWS_PER_USER_PER_SERVER }, 429);
    }
    throw err;
  }
});

localWebPreviewRoutes.delete('/:id/local-web-preview/:previewId', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const access = await resolveServerMemberAccessOrShareDeny(c.env.DB, { serverId, userId });
  if (!access.ok) return c.json({ error: PREVIEW_ERROR.FORBIDDEN, reason: access.reason }, 403);

  const previewIdParam = c.req.param('previewId')!;
  const ok = LocalWebPreviewRegistry.get(serverId).close(previewIdParam, userId);
  if (!ok) return c.json({ error: PREVIEW_ERROR.PREVIEW_NOT_FOUND }, 404);
  // Notify daemon to clean up preview port registry
  const bridge = WsBridge.get(serverId);
  if (bridge.isDaemonConnected()) {
    bridge.sendPreviewControl({ type: PREVIEW_MSG.CLOSE, previewId: previewIdParam });
  }
  return c.json({ ok: true });
});

localWebPreviewRoutes.all('/:id/local-web/:previewId/*', async (c) => {
  const serverId = c.req.param('id')!;
  const previewId = c.req.param('previewId')!;
  const previewAccessToken = new URL(c.req.url).searchParams.get(PREVIEW_ACCESS_TOKEN_QUERY_PARAM) ?? getCookie(c, COOKIE_PREVIEW_ACCESS) ?? null;
  const auth = await resolveAuth(c);

  // Pure peek/verify — NO side effects (no touch / no Set-Cookie / no TTL
  // renewal) until owner + current role + token/session ALL pass. HTTP and WS
  // upgrade share this exact function (run 8a975732-23a P0.1).
  const access = await resolveLocalPreviewAccess({
    db: c.env.DB,
    serverId,
    previewId,
    previewAccessToken,
    session: auth ? { userId: auth.userId } : null,
  });
  if (!access.ok) {
    return c.json({ error: access.error }, access.status);
  }
  const { preview } = access;

  // Authorization passed (owner + current role + token/session) → commit the
  // side effects: slide the TTL (commit, NOT peek) and — HTTP only — re-set the
  // preview scoped cookie so post-initial-load same-origin requests carry it
  // (SameSite=Strict default defense). Committed here, BEFORE the daemon /
  // in-flight gates, so a transient daemon outage doesn't strip a legitimately
  // authorized session's credential.
  commitAuthorizedAccess(serverId, previewId);
  if (previewAccessToken) {
    setPreviewAccessCookie(c, serverId, previewId, previewAccessToken);
  }

  const bridge = WsBridge.get(serverId);
  if (!bridge.isDaemonConnected()) {
    return c.json({ error: PREVIEW_ERROR.DAEMON_OFFLINE }, 503);
  }

  // In-flight HTTP concurrency floor (run 8a975732-23a P0.4) — replaces the
  // removed per-request count rate limiter (which misfired on a real SPA first
  // paint). The check happens HERE, at the point we decide to forward upstream.
  // WS tunnels are NOT counted here (they have MAX_WS_PER_PREVIEW). Reject with
  // 503 + PREVIEW_ERROR.INFLIGHT_LIMIT (non-bare).
  if (!bridge.canAcceptPreviewInflight(previewId)) {
    return c.json({ error: PREVIEW_ERROR.INFLIGHT_LIMIT }, PREVIEW_INFLIGHT_REJECT_HTTP_STATUS);
  }

  const requestId = randomHex(16);
  const requestUrl = new URL(c.req.url);
  const upstreamPath = getUpstreamPath(requestUrl, serverId, previewId);
  const sanitizedHeaders = sanitizePreviewRequestHeaders(c.req.raw.headers, previewId);
  const hasBody = !['GET', 'HEAD'].includes(c.req.method) && c.req.raw.body !== null;
  const relay = bridge.createPreviewRelay(requestId, previewId, PREVIEW_LIMITS.RESPONSE_START_TIMEOUT_MS);

  c.req.raw.signal.addEventListener('abort', () => {
    relay.abort('browser_disconnect');
  }, { once: true });

  logger.info({
    serverId,
    previewId,
    requestId,
    method: c.req.method,
    path: upstreamPath,
    headers: redactPreviewHeaders(sanitizedHeaders),
  }, 'Preview proxy request');

  try {
    bridge.sendPreviewControl({
      type: PREVIEW_MSG.REQUEST,
      requestId,
      previewId,
      port: preview.port,
      method: c.req.method,
      path: upstreamPath,
      headers: sanitizedHeaders,
      hasBody,
    });

    let requestBytes = 0;
    if (hasBody && c.req.raw.body) {
      const reader = c.req.raw.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          requestBytes += value.byteLength;
          if (requestBytes > PREVIEW_LIMITS.MAX_REQUEST_BYTES) {
            relay.abort(PREVIEW_ERROR.LIMIT_EXCEEDED);
            return c.json({ error: PREVIEW_ERROR.LIMIT_EXCEEDED }, 413);
          }
          bridge.sendPreviewRequestBodyChunk(requestId, value);
        }
      } finally {
        reader.releaseLock();
      }
    }

    bridge.sendPreviewControl({ type: PREVIEW_MSG.REQUEST_END, requestId });

    const started = await relay.start;
    const upstreamHeaders = new Headers();
    for (const [name, value] of Object.entries(started.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) upstreamHeaders.append(name, item);
      } else {
        upstreamHeaders.append(name, value);
      }
    }

    const location = upstreamHeaders.get('location');
    if (location) {
      const rewritten = rewritePreviewRedirectLocation({
        location,
        serverId,
        previewId,
        port: preview.port,
      });
      // Only append the access token for loopback redirects (rewritten to the
      // preview prefix). Presence is decided by URLSearchParams.has — NOT a
      // `.includes` substring match (run 8a975732-23a A14): substring matching
      // would mis-fire when the pathname or another param's value happens to
      // contain the literal `preview_access_token`. The token appended here is
      // the browser→proxy segment credential; the upstream segment is stripped
      // separately by getUpstreamPath. Shared, unit-tested helper.
      const isLoopbackRedirect = rewritten !== location;
      const nextLocation = isLoopbackRedirect
        ? appendPreviewAccessTokenIfMissing(rewritten, c.req.url, previewAccessToken)
        : rewritten;
      upstreamHeaders.set('location', nextLocation);
    }

    const responseHeaders = filterPreviewResponseHeaders(upstreamHeaders);
    for (const header of getSetCookieValues(upstreamHeaders)) {
      const rewritten = rewriteSetCookieHeader({ previewId, serverId, header });
      if (rewritten) responseHeaders.append('Set-Cookie', rewritten);
    }

    logger.info({
      serverId,
      previewId,
      requestId,
      status: started.status,
      headers: (() => {
        const loggedHeaders: Record<string, string> = {};
        responseHeaders.forEach((value, name) => {
          loggedHeaders[name] = value;
        });
        return redactPreviewHeaders(loggedHeaders);
      })(),
    }, 'Preview proxy response');

    if (shouldRewritePreviewHtml(responseHeaders)) {
      const html = await new Response(started.body).text();
      const rewrittenHtml = rewritePreviewHtmlDocument(html, serverId, previewId, preview.port, previewAccessToken ?? undefined);
      responseHeaders.delete('content-length');
      return new Response(rewrittenHtml, {
        status: started.status,
        statusText: started.statusText,
        headers: responseHeaders,
      });
    }

    return new Response(started.body, {
      status: started.status,
      statusText: started.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === PREVIEW_ERROR.LIMIT_EXCEEDED) return c.json({ error: PREVIEW_ERROR.LIMIT_EXCEEDED }, 413);
    if (message === PREVIEW_ERROR.TIMEOUT) return c.json({ error: PREVIEW_ERROR.TIMEOUT }, 504);
    if (message === PREVIEW_ERROR.UPSTREAM_UNREACHABLE) return c.json({ error: PREVIEW_ERROR.UPSTREAM_UNREACHABLE }, 502);
    if (message === PREVIEW_ERROR.DAEMON_OFFLINE || message === 'daemon_disconnected' || message === 'daemon_error') {
      return c.json({ error: PREVIEW_ERROR.DAEMON_OFFLINE }, 503);
    }
    if (message === PREVIEW_ERROR.ABORTED || message === 'browser_disconnect') {
      return new Response(null, { status: 499 });
    }
    logger.warn({ serverId, previewId, requestId, err }, 'Preview proxy failed');
    return c.json({ error: PREVIEW_ERROR.UPSTREAM_ERROR }, 502);
  }
});
