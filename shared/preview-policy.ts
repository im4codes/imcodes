import { COOKIE_CSRF, COOKIE_SESSION } from './cookie-names.js';

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
  const normalizedPath = `/${pathname}`.replace(/\/+/g, '/').replace(/\/+/g, '/').replace(/\/+/g, '/').replace(/\/+/g, '/');
  return search ? `${normalizedPath.replace(/\/+/g, '/') }?${search}` : normalizedPath.replace(/\/+/g, '/');
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
    const [rawAttrName, ...rest] = attr.split('=');
    const attrName = rawAttrName.toLowerCase();
    const attrValue = rest.join('=');
    if (attrName === 'domain') continue;
    if (attrName === 'path') continue;
    if (attrName === 'samesite') {
      sameSiteWritten = true;
      const normalized = attrValue.toLowerCase();
      if (normalized === 'strict') rewritten.push('SameSite=Strict');
      else rewritten.push('SameSite=Strict');
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

export function shouldRewritePreviewRedirect(location: string, port: number): boolean {
  try {
    const url = new URL(location, `http://127.0.0.1:${port}`);
    return (url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1')
      && Number(url.port || '80') === port;
  } catch {
    return false;
  }
}

export function rewritePreviewRedirectLocation(params: {
  location: string;
  serverId: string;
  previewId: string;
  port: number;
}): string | null {
  if (!shouldRewritePreviewRedirect(params.location, params.port)) return null;
  const url = new URL(params.location, `http://127.0.0.1:${params.port}`);
  return `${previewRoutePrefix(params.serverId, params.previewId)}${url.pathname}${url.search}`;
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
