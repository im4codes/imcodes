import { Hono } from 'hono';
import { NODE_ROLE } from '../../../shared/remote-exec.js';
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
import { isSseResponse } from '../../../shared/preview-stream-policy.js';
import { randomHex } from '../security/crypto.js';
import logger from '../util/logger.js';
import { z } from 'zod';
import { COOKIE_PREVIEW_ACCESS } from '../../../shared/cookie-names.js';

/**
 * Wrap an upstream SSE `ReadableStream` to emit `: keepalive\n\n` comment frames
 * when no upstream chunk arrives within `keepaliveMs` while the consumer is pulling.
 * Tracks SSE empty-line event boundaries across arbitrary binary chunk/CR/LF splits
 * so comments are ONLY emitted before the first byte or after a complete blank line
 * terminating an event block — never mid-line or mid-event. Strictly pull-driven so
 * downstream backpressure and upstream abort/error/close propagation are preserved 1:1.
 */
export function wrapSseKeepaliveStream(
  body: ReadableStream<Uint8Array>,
  keepaliveMs: number = PREVIEW_LIMITS.SSE_KEEPALIVE_MS,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const keepaliveChunk = Buffer.from(': keepalive\n\n', 'utf8');
  type ReadOutcome =
    | { ok: true; res: Awaited<ReturnType<typeof reader.read>> }
    | { ok: false; err: unknown };
  let pendingRead: Promise<ReadOutcome> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let startedAnyByte = false;
  let consecutiveEols = 0;
  let lastWasCr = false;

  const isAtEventBoundary = (): boolean => {
    if (!startedAnyByte) return true;
    return consecutiveEols >= 2 && !lastWasCr;
  };

  const advanceBoundaryState = (chunk: Uint8Array): void => {
    for (let i = 0; i < chunk.byteLength; i++) {
      startedAnyByte = true;
      const b = chunk[i];
      if (b === 0x0d) {
        consecutiveEols += 1;
        lastWasCr = true;
      } else if (b === 0x0a) {
        if (lastWasCr) {
          lastWasCr = false;
        } else {
          consecutiveEols += 1;
        }
      } else {
        consecutiveEols = 0;
        lastWasCr = false;
      }
    }
  };

  const clearKeepaliveTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const ensureRead = (): Promise<ReadOutcome> => {
    if (!pendingRead) {
      pendingRead = reader.read().then(
        (res) => ({ ok: true as const, res }),
        (err) => ({ ok: false as const, err }),
      );
    }
    return pendingRead;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      const readPromise = ensureRead();
      const winner = isAtEventBoundary()
        ? await new Promise<'keepalive' | ReadOutcome>((resolve) => {
            clearKeepaliveTimer();
            timer = setTimeout(() => resolve('keepalive'), keepaliveMs);
            timer.unref?.();
            void readPromise.then(resolve);
          })
        : await readPromise;
      clearKeepaliveTimer();
      if (closed) return;
      if (winner === 'keepalive') {
        // Leave pendingRead intact so the next pull awaits the same in-flight read without losing data.
        controller.enqueue(keepaliveChunk);
        return;
      }
      pendingRead = null;
      if (!winner.ok) {
        closed = true;
        controller.error(winner.err);
        return;
      }
      if (winner.res.done) {
        closed = true;
        controller.close();
        return;
      }
      advanceBoundaryState(winner.res.value);
      controller.enqueue(winner.res.value);
    },
    cancel(reason) {
      closed = true;
      clearKeepaliveTimer();
      return reader.cancel(reason);
    },
  });
}

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
  // A controlled node's credential resolves to the userId of the account that
  // owns it, and `resolveLocalPreviewAccess` lets a session stand in for the
  // preview token. Without this it could read the owner's local previews by
  // presenting its own token. A controlled node may be controlled; it may not
  // act as its owner.
  const previewSession = auth && auth.nodeRole !== NODE_ROLE.CONTROLLED
    ? { userId: auth.userId }
    : null;

  // Pure peek/verify — NO side effects (no touch / no Set-Cookie / no TTL
  // renewal) until owner + current role + token/session ALL pass. HTTP and WS
  // upgrade share this exact function (run 8a975732-23a P0.1).
  const access = await resolveLocalPreviewAccess({
    db: c.env.DB,
    serverId,
    previewId,
    previewAccessToken,
    session: previewSession,
  });
  if (!access.ok) {
    return c.json({ error: access.error }, access.status);
  }
  const { preview, previewAccessToken: validatedPreviewAccessToken } = access;

  // Authorization passed (owner + current role + token/session) → re-set the
  // preview scoped cookie so post-initial-load same-origin requests carry it
  // (SameSite=Strict default defense). The cookie is (re)set HERE, BEFORE the
  // daemon / in-flight gates, so a transient daemon outage doesn't strip a
  // legitimately authorized session's credential (it stays cached for retry).
  // The TTL slide (`commitAuthorizedAccess`) is deliberately NOT done here — it
  // is deferred past the daemon-online gate below so a long-offline daemon can
  // no longer keep a preview alive (occupying a per-user slot) just because the
  // owner keeps polling/refreshing it (S1/N3, audit run 394c114e-11f).
  if (validatedPreviewAccessToken) {
    setPreviewAccessCookie(c, serverId, previewId, validatedPreviewAccessToken);
  }

  const bridge = WsBridge.get(serverId);
  if (!bridge.isDaemonConnected()) {
    // Daemon offline → 503, with NO TTL touch (commit not yet called). This is
    // an availability outcome, not an authorization failure; the cached cookie
    // above keeps the credential warm for when the daemon returns.
    return c.json({ error: PREVIEW_ERROR.DAEMON_OFFLINE }, 503);
  }

  // Daemon is online → commit the authorization side effect: slide the TTL
  // (commit, NOT peek). Mirrors the WS upgrade in index.ts, which likewise
  // commits only AFTER its daemon-online gate. The in-flight floor below is
  // transient load shedding, so a legitimately-forwarded request still slides
  // the TTL even when it is subsequently rejected for in-flight pressure.
  commitAuthorizedAccess(serverId, previewId);

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
        ? appendPreviewAccessTokenIfMissing(rewritten, c.req.url, validatedPreviewAccessToken)
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
      const rewrittenHtml = rewritePreviewHtmlDocument(html, serverId, previewId, preview.port, validatedPreviewAccessToken ?? undefined);
      responseHeaders.delete('content-length');
      return new Response(rewrittenHtml, {
        status: started.status,
        statusText: started.statusText,
        headers: responseHeaders,
      });
    }

    const sse = isSseResponse(responseHeaders);
    if (sse) {
      if (!responseHeaders.has('x-accel-buffering')) {
        responseHeaders.set('x-accel-buffering', 'no');
      }
      if (!responseHeaders.has('cache-control')) {
        responseHeaders.set('cache-control', 'no-cache, no-transform');
      }
      // Keepalive comments are inserted into the SSE stream; remove fixed Content-Length.
      responseHeaders.delete('content-length');
    }

    const responseBody = sse ? wrapSseKeepaliveStream(started.body) : started.body;
    return new Response(responseBody, {
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
