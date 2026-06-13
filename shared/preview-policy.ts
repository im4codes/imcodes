import { COOKIE_CSRF, COOKIE_SESSION } from './cookie-names.js';
import { PREVIEW_ACCESS_TOKEN_QUERY_PARAM } from './preview-types.js';

export const PREVIEW_SENSITIVE_HEADERS = new Set([
  'cookie',
  'set-cookie',
  'authorization',
  'proxy-authorization',
  'x-preview-auth',
]);

export const PREVIEW_HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export const PREVIEW_EMBED_STRIP_RESPONSE_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
]);

export const PREVIEW_COOKIE_PREFIX = '__imc_preview_';

const RESERVED_COOKIE_NAMES = new Set([COOKIE_SESSION, COOKIE_CSRF]);

export function redactPreviewHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = PREVIEW_SENSITIVE_HEADERS.has(key.toLowerCase()) ? '[REDACTED]' : value;
  }
  return out;
}

export function isReservedPreviewCookieName(name: string): boolean {
  return RESERVED_COOKIE_NAMES.has(name);
}

export function buildPreviewCookieName(previewId: string, upstreamName: string): string {
  return `${PREVIEW_COOKIE_PREFIX}${previewId}_${upstreamName}`;
}

export function parsePreviewCookieName(previewId: string, cookieName: string): string | null {
  const prefix = `${PREVIEW_COOKIE_PREFIX}${previewId}_`;
  return cookieName.startsWith(prefix) ? cookieName.slice(prefix.length) : null;
}

export function previewRoutePrefix(serverId: string, previewId: string): string {
  return `/api/server/${serverId}/local-web/${previewId}`;
}

export function normalizePreviewUpstreamPath(path: string): string {
  if (!path) return '/';
  const [pathname, search = ''] = path.split('?', 2);
  const normalizedPath = `/${pathname}`.replace(/\/+/g, '/');
  return search ? `${normalizedPath}?${search}` : normalizedPath;
}

/**
 * Remove the preview access token from a `path?query` string BEFORE it is
 * forwarded to the local upstream (run 8a975732-23a A13). The token authorizes
 * the browser→proxy hop only; the upstream is untrusted (its access logs, error
 * pages, HMR output may persist this replayable credential), so it MUST NOT
 * leave the proxy.
 *
 * Rules:
 * - Deletes EVERY occurrence of the exact key `preview_access_token` (decoded,
 *   case-SENSITIVE — matching how auth reads it), including repeated, empty-value
 *   (`?k=`) and value-less (`?k`) forms.
 * - All OTHER query parameters keep their value AND order, byte-for-byte
 *   (we keep the original `pair` substring; only the decoded key drives the
 *   delete decision, so other params are never re-encoded).
 * - Does NOT touch a fragment (`#...`): browsers never send fragments to the
 *   server, so neither HTTP nor WS upstream paths contain one.
 *
 * The single entry point for both the HTTP upstream path (`getUpstreamPath`)
 * and the WS upgrade upstream path.
 */
export function stripPreviewAccessTokenFromUpstreamPath(pathWithQuery: string): string {
  const qIndex = pathWithQuery.indexOf('?');
  if (qIndex === -1) return pathWithQuery;
  const pathname = pathWithQuery.slice(0, qIndex);
  const query = pathWithQuery.slice(qIndex + 1);
  if (query === '') return pathname; // "path?" -> "path"
  const kept: string[] = [];
  for (const pair of query.split('&')) {
    if (pair === '') continue; // collapse empty segments (e.g. from "&&")
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    let decodedKey: string;
    try { decodedKey = decodeURIComponent(rawKey); } catch { decodedKey = rawKey; }
    if (decodedKey === PREVIEW_ACCESS_TOKEN_QUERY_PARAM) continue; // drop all forms
    kept.push(pair);
  }
  return kept.length > 0 ? `${pathname}?${kept.join('&')}` : pathname;
}

// Headers that must pass through for WebSocket upgrade requests (would otherwise be stripped).
const WS_UPGRADE_PRESERVE_HEADERS = new Set([
  'connection',
  'upgrade',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-protocol',
]);

// sec-websocket-extensions is stripped even on WS upgrades: extension negotiation
// cannot be preserved end-to-end through a message-level relay.
const WS_UPGRADE_STRIP_HEADERS = new Set([
  'sec-websocket-extensions',
]);

export function isWebSocketUpgrade(headers: Headers): boolean {
  return headers.get('upgrade')?.toLowerCase() === 'websocket';
}

export function sanitizePreviewRequestHeaders(headers: Headers, previewId: string): Record<string, string> {
  const out: Record<string, string> = {};
  const isWs = isWebSocketUpgrade(headers);
  headers.forEach((value, rawName) => {
    const name = rawName.toLowerCase();
    if (name === 'host' || name === 'content-length') return;
    if (WS_UPGRADE_STRIP_HEADERS.has(name)) return;
    if (isWs && WS_UPGRADE_PRESERVE_HEADERS.has(name)) {
      out[name] = value;
      return;
    }
    if (PREVIEW_HOP_BY_HOP_HEADERS.has(name)) return;
    if (name === 'cookie') {
      const upstreamCookie = buildUpstreamCookieHeader(previewId, value);
      if (upstreamCookie) out.cookie = upstreamCookie;
      return;
    }
    out[name] = value;
  });
  return out;
}

export function buildUpstreamCookieHeader(previewId: string, cookieHeader: string): string {
  const pairs = cookieHeader.split(/;\s*/g);
  const forwarded: string[] = [];
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const upstreamName = parsePreviewCookieName(previewId, name);
    if (!upstreamName) continue;
    forwarded.push(`${upstreamName}=${value}`);
  }
  return forwarded.join('; ');
}

export function rewriteSetCookieHeader(params: {
  previewId: string;
  serverId: string;
  header: string;
}): string | null {
  const parts = params.header.split(';').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const [nameValue, ...attrs] = parts;
  const eq = nameValue.indexOf('=');
  if (eq <= 0) return null;
  const name = nameValue.slice(0, eq).trim();
  const value = nameValue.slice(eq + 1);
  if (!name || isReservedPreviewCookieName(name)) return null;

  const rewritten: string[] = [`${buildPreviewCookieName(params.previewId, name)}=${value}`];
  const path = `${previewRoutePrefix(params.serverId, params.previewId)}/`;
  rewritten.push(`Path=${path}`);

  let sameSiteWritten = false;
  for (const attr of attrs) {
    const [rawAttrName] = attr.split('=');
    const attrName = rawAttrName.toLowerCase();
    if (attrName === 'domain') continue;
    if (attrName === 'path') continue;
    if (attrName === 'samesite') {
      sameSiteWritten = true;
      // Intentional: always force Strict regardless of upstream value.
      // Preview cookies must not leak cross-site.
      rewritten.push('SameSite=Strict');
      continue;
    }
    if (attrName === 'secure' || attrName === 'httponly') {
      rewritten.push(rawAttrName);
      continue;
    }
    rewritten.push(attr);
  }

  if (!sameSiteWritten) rewritten.push('SameSite=Strict');
  return rewritten.join('; ');
}

/**
 * All hostnames treated as loopback for preview URL rewriting.
 *
 * SINGLE SOURCE OF TRUTH (run 8a975732-23a A17/A25). EXPORTED so the injected
 * browser runtime patch (`server/src/preview/policy.ts`) can serialize THIS exact
 * set into its script at build/inject time instead of hand-maintaining a literal
 * copy — the injected script runs in the previewed page's global scope and cannot
 * `import` at runtime, so divergence is prevented by serialization + an anti-drift
 * test, not by a second copy. `0.0.0.0` is the dev-server wildcard-bind host,
 * deliberately included for compatibility (not a standard loopback address).
 */
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0']);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

/**
 * Default TCP port for a URL scheme when the URL carries no explicit port
 * (run 8a975732-23a A25 / T-R-CC1-3): `http`/`ws` → 80, `https`/`wss` → 443.
 *
 * Used so `shouldRewritePreviewRedirect` does NOT mis-default an `https`/`wss`
 * loopback URL without an explicit port to 80 (the old `Number(url.port || '80')`
 * bug) and thereby fail the preview-port comparison. The injected runtime patch
 * applies the identical mapping inline (it cannot import this; see policy.ts).
 * Accepts a protocol with or without the trailing `:` (`URL.protocol` includes it).
 */
export function defaultPortForProtocol(protocol: string): number {
  const scheme = (protocol.endsWith(':') ? protocol.slice(0, -1) : protocol).toLowerCase();
  return scheme === 'https' || scheme === 'wss' ? 443 : 80;
}

export function shouldRewritePreviewRedirect(location: string, port: number): boolean {
  try {
    const url = new URL(location, `http://127.0.0.1:${port}`);
    const urlPort = url.port ? Number(url.port) : defaultPortForProtocol(url.protocol);
    return isLoopbackHost(url.hostname) && urlPort === port;
  } catch {
    return false;
  }
}

/**
 * Rewrite a redirect Location header for the preview proxy.
 * - Loopback URLs → rewritten to preview route prefix
 * - Non-loopback URLs (e.g. OAuth providers) → passed through unchanged
 */
export function rewritePreviewRedirectLocation(params: {
  location: string;
  serverId: string;
  previewId: string;
  port: number;
}): string {
  if (!shouldRewritePreviewRedirect(params.location, params.port)) {
    // Non-loopback redirect (e.g. external OAuth) — pass through unchanged
    return params.location;
  }
  const url = new URL(params.location, `http://127.0.0.1:${params.port}`);
  return `${previewRoutePrefix(params.serverId, params.previewId)}${url.pathname}${url.search}`;
}

/**
 * Append the browser→proxy preview access token to an (already preview-prefixed)
 * redirect `Location`, but ONLY when it is not already present (run 8a975732-23a
 * A13/A14 — access spec "redirect token append"). Presence is decided with
 * `URLSearchParams.has` — NEVER a `.includes` substring match — so a pathname or
 * another param's VALUE that merely contains the literal `preview_access_token`
 * is never mistaken for the query key.
 *
 * The token authorizes only the browser→proxy hop; the upstream segment is
 * stripped separately by `stripPreviewAccessTokenFromUpstreamPath`, so the two
 * contracts do not conflict (append for the browser, strip for the upstream).
 *
 * `base` is any absolute URL used solely to parse a relative `location` (its
 * origin is never emitted; only `pathname + search + hash` is returned). When
 * `token` is falsy, or `location` cannot be parsed, the input is returned
 * unchanged.
 */
export function appendPreviewAccessTokenIfMissing(
  location: string,
  base: string,
  token: string | null | undefined,
): string {
  if (!token) return location;
  try {
    const url = new URL(location, base);
    if (!url.searchParams.has(PREVIEW_ACCESS_TOKEN_QUERY_PARAM)) {
      url.searchParams.set(PREVIEW_ACCESS_TOKEN_QUERY_PARAM, token);
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return location;
  }
}

export function filterPreviewResponseHeaders(headers: Headers): Headers {
  const out = new Headers();
  headers.forEach((value, rawName) => {
    const name = rawName.toLowerCase();
    if (PREVIEW_HOP_BY_HOP_HEADERS.has(name)) return;
    if (name === 'set-cookie') return;
    if (PREVIEW_EMBED_STRIP_RESPONSE_HEADERS.has(name)) return;
    out.append(rawName, value);
  });
  return out;
}
