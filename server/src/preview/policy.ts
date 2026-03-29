export {
  PREVIEW_COOKIE_PREFIX,
  PREVIEW_EMBED_STRIP_RESPONSE_HEADERS,
  PREVIEW_HOP_BY_HOP_HEADERS,
  PREVIEW_SENSITIVE_HEADERS,
  buildPreviewCookieName,
  buildUpstreamCookieHeader,
  filterPreviewResponseHeaders,
  isReservedPreviewCookieName,
  normalizePreviewUpstreamPath,
  parsePreviewCookieName,
  previewRoutePrefix,
  redactPreviewHeaders,
  rewritePreviewRedirectLocation,
  rewriteSetCookieHeader,
  sanitizePreviewRequestHeaders,
  shouldRewritePreviewRedirect,
} from '../../../shared/preview-policy.js';

import { previewRoutePrefix } from '../../../shared/preview-policy.js';

function escapeReplacement(text: string): string {
  return text.replace(/\$/g, '$$$$');
}

function rewriteSrcsetValue(value: string, prefix: string): string {
  return value
    .split(',')
    .map((candidate) => {
      const trimmed = candidate.trim();
      if (!trimmed) return candidate;
      const parts = trimmed.split(/\s+/);
      const [url, ...rest] = parts;
      if (!url || !url.startsWith('/') || url.startsWith('//')) return candidate;
      const rewrittenUrl = `${prefix}${url}`;
      return [rewrittenUrl, ...rest].join(' ');
    })
    .join(', ');
}

export function shouldRewritePreviewHtml(headers: Headers): boolean {
  const contentType = headers.get('content-type')?.toLowerCase() ?? '';
  return contentType.includes('text/html');
}

export function rewritePreviewHtmlDocument(html: string, serverId: string, previewId: string): string {
  const prefix = previewRoutePrefix(serverId, previewId);
  const escapedPrefix = escapeReplacement(prefix);

  let rewritten = html.replace(
    /(<base\b[^>]*\bhref\s*=\s*["'])\/(?!\/)/gi,
    `$1${escapedPrefix}/`,
  );

  rewritten = rewritten.replace(
    /\b(href|src|action|formaction|poster)\s*=\s*(["'])\/(?!\/)([^"']*)\2/gi,
    (_match, attr, quote, path) => {
      const normalizedPath = `/${path}`;
      if (normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)) {
        return `${attr}=${quote}${normalizedPath}${quote}`;
      }
      return `${attr}=${quote}${prefix}/${path}${quote}`;
    },
  );

  rewritten = rewritten.replace(
    /\bsrcset\s*=\s*(["'])([^"']*)\1/gi,
    (_match, quote, value) => `srcset=${quote}${rewriteSrcsetValue(value, prefix)}${quote}`,
  );

  rewritten = rewritten.replace(
    /\bcontent\s*=\s*(["'])([^"']*;\s*url=)\/(?!\/)([^"']*)\1/gi,
    (_match, quote, head, path) => `content=${quote}${head}${prefix}/${path}${quote}`,
  );

  rewritten = rewritten.replace(
    /url\(\s*(["']?)\/(?!\/)([^)"']*)\1\s*\)/gi,
    (_match, quote, path) => `url(${quote}${prefix}/${path}${quote})`,
  );

  return rewritten;
}
