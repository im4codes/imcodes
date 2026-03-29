import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../env.js';
import { requireAuth, resolveAuth, resolveServerRole } from '../security/authorization.js';
import { LocalWebPreviewRegistry, normalizeLocalPreviewPath } from '../preview/registry.js';
import { MemoryRateLimiter } from '../ws/rate-limiter.js';
import { rewritePreviewHtmlDocument, shouldRewritePreviewHtml } from '../preview/policy.js';
import {
  filterPreviewResponseHeaders,
  normalizePreviewUpstreamPath,
  redactPreviewHeaders,
  rewritePreviewRedirectLocation,
  rewriteSetCookieHeader,
  sanitizePreviewRequestHeaders,
} from '../../../shared/preview-policy.js';
import {
  PREVIEW_ACCESS_TOKEN_QUERY_PARAM,
  PREVIEW_ERROR,
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

const previewRateLimiter = new MemoryRateLimiter();

function getUpstreamPath(url: URL, serverId: string, previewId: string): string {
  const prefix = `/api/server/${serverId}/local-web/${previewId}`;
  const pathname = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) || '/' : '/';
  return normalizePreviewUpstreamPath(`${pathname}${url.search}`);
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
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: PREVIEW_ERROR.FORBIDDEN }, 403);

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
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: PREVIEW_ERROR.FORBIDDEN }, 403);

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
  const registry = LocalWebPreviewRegistry.get(serverId);
  const previewAccessToken = new URL(c.req.url).searchParams.get(PREVIEW_ACCESS_TOKEN_QUERY_PARAM) ?? getCookie(c, COOKIE_PREVIEW_ACCESS) ?? null;
  const auth = await resolveAuth(c);

  let userId: string | null = auth?.userId ?? null;
  let role = auth ? await resolveServerRole(c.env.DB, serverId, auth.userId) : 'none';

  const previewFromToken = !auth && previewAccessToken
    ? registry.authorizeWithAccessToken(previewId, previewAccessToken)
    : null;

  if (!auth && !previewFromToken) return c.json({ error: 'unauthorized' }, 401);
  if (!auth && previewFromToken) {
    userId = previewFromToken.userId;
    role = await resolveServerRole(c.env.DB, serverId, previewFromToken.userId);
  }
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  if (role === 'none') return c.json({ error: PREVIEW_ERROR.FORBIDDEN }, 403);

  const rateKey = `${serverId}:${userId}`;
  if (!previewRateLimiter.check(rateKey, PREVIEW_LIMITS.MAX_REQUESTS_PER_WINDOW, PREVIEW_LIMITS.REQUEST_RATE_WINDOW_MS)) {
    return c.json({ error: PREVIEW_ERROR.LIMIT_EXCEEDED }, 429);
  }

  const preview = registry.get(previewId);
  if (!preview) return c.json({ error: PREVIEW_ERROR.PREVIEW_EXPIRED }, 404);
  if (preview.userId !== userId) return c.json({ error: PREVIEW_ERROR.FORBIDDEN }, 403);
  if (previewAccessToken) {
    setPreviewAccessCookie(c, serverId, previewId, previewAccessToken);
  }

  const bridge = WsBridge.get(serverId);
  if (!bridge.isDaemonConnected()) {
    return c.json({ error: PREVIEW_ERROR.DAEMON_OFFLINE }, 503);
  }

  const requestId = randomHex(16);
  const requestUrl = new URL(c.req.url);
  const upstreamPath = getUpstreamPath(requestUrl, serverId, previewId);
  const sanitizedHeaders = sanitizePreviewRequestHeaders(c.req.raw.headers, previewId);
  const hasBody = !['GET', 'HEAD'].includes(c.req.method) && c.req.raw.body !== null;
  const relay = bridge.createPreviewRelay(requestId, PREVIEW_LIMITS.RESPONSE_START_TIMEOUT_MS);

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
      // Only append access token for loopback redirects (rewritten to preview prefix)
      const isLoopbackRedirect = rewritten !== location;
      if (isLoopbackRedirect && previewAccessToken && !rewritten.includes(PREVIEW_ACCESS_TOKEN_QUERY_PARAM)) {
        try {
          const redirectUrl = new URL(rewritten, c.req.url);
          redirectUrl.searchParams.set(PREVIEW_ACCESS_TOKEN_QUERY_PARAM, previewAccessToken);
          upstreamHeaders.set('location', `${redirectUrl.pathname}${redirectUrl.search}${redirectUrl.hash}`);
        } catch {
          upstreamHeaders.set('location', rewritten);
        }
      } else {
        upstreamHeaders.set('location', rewritten);
      }
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
