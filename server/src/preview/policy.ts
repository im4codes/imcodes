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

function rewriteAbsoluteLocalhostValue(value: string, prefix: string, port: number): string {
  return value.replace(
    new RegExp(`https?:\\/\\/(?:127\\.0\\.0\\.1|localhost|\\[::1\\]|::1)(?::${port})?(\\/[^\\s,"']*)?`, 'gi'),
    (match, path = '/') => {
      try {
        const parsed = new URL(match);
        const parsedPort = Number(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'));
        if (parsedPort !== port) return match;
        return `${prefix}${parsed.pathname}${parsed.search}${parsed.hash}`;
      } catch {
        return match;
      }
    },
  );
}

function buildPreviewRuntimePatch(prefix: string, port: number, accessToken?: string): string {
  const prefixJson = JSON.stringify(prefix);
  const portJson = JSON.stringify(port);
  const tokenJson = accessToken ? JSON.stringify(accessToken) : 'null';
  return `<script data-imcodes-preview-runtime>(function(){var PREFIX=${prefixJson};var PREVIEW_PORT=${portJson};var ACCESS_TOKEN=${tokenJson};var TOKEN_PARAM='preview_access_token';if(window.__IMCODES_PREVIEW_PATCHED__)return;window.__IMCODES_PREVIEW_PATCHED__=true;function isLoopbackHost(host){return host==='127.0.0.1'||host==='localhost'||host==='[::1]'||host==='::1';}function appendToken(rewrittenUrl){if(!ACCESS_TOKEN)return rewrittenUrl;try{var u=new URL(rewrittenUrl,window.location.href);if(!u.searchParams.has(TOKEN_PARAM))u.searchParams.set(TOKEN_PARAM,ACCESS_TOKEN);return u.pathname+u.search+u.hash;}catch(_){return rewrittenUrl;}}function rewrite(url){if(typeof url!=='string')return url;if(url.startsWith(PREFIX)||url.startsWith('//'))return url;try{var absolute=new URL(url,window.location.href);var port=Number(absolute.port||(absolute.protocol==='https:'?'443':absolute.protocol==='wss:'?'443':absolute.protocol==='ws:'?'80':'80'));if((absolute.protocol==='http:'||absolute.protocol==='https:')&&isLoopbackHost(absolute.hostname)&&port===PREVIEW_PORT){return appendToken(PREFIX+absolute.pathname+absolute.search+absolute.hash);}if(absolute.origin===window.location.origin&&absolute.pathname.startsWith('/')&&!absolute.pathname.startsWith(PREFIX+'/')&&absolute.pathname!==PREFIX){return appendToken(PREFIX+absolute.pathname+absolute.search+absolute.hash);}}catch(_e){}if(url.startsWith('/'))return appendToken(PREFIX+url);return url;}var originalFetch=window.fetch;if(typeof originalFetch==='function'){window.fetch=function(input,init){if(typeof input==='string')return originalFetch.call(this,rewrite(input),init);if(input&&typeof input.url==='string'){try{var rewritten=rewrite(input.url);if(rewritten!==input.url)return originalFetch.call(this,new Request(rewritten,input),init);}catch(_e){}}return originalFetch.call(this,input,init);};}var originalOpen=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url){var args=Array.prototype.slice.call(arguments);if(typeof args[1]==='string')args[1]=rewrite(args[1]);return originalOpen.apply(this,args);};function wrapHistory(name){var original=history[name];if(typeof original!=='function')return;history[name]=function(state,title,url){if(typeof url==='string')url=rewrite(url);return original.call(this,state,title,url);};}wrapHistory('pushState');wrapHistory('replaceState');if(window.Location&&window.Location.prototype){var originalAssign=window.Location.prototype.assign;if(typeof originalAssign==='function'){window.Location.prototype.assign=function(url){return originalAssign.call(this,rewrite(url));};}var originalReplace=window.Location.prototype.replace;if(typeof originalReplace==='function'){window.Location.prototype.replace=function(url){return originalReplace.call(this,rewrite(url));};}}var originalOpenWindow=window.open;if(typeof originalOpenWindow==='function'){window.open=function(url,target,features){return originalOpenWindow.call(window,typeof url==='string'?rewrite(url):url,target,features);};}document.addEventListener('click',function(event){var anchor=event.target&&event.target.closest?event.target.closest('a[href]'):null;if(!anchor)return;var raw=anchor.getAttribute('href');if(typeof raw==='string')anchor.setAttribute('href',rewrite(raw));},true);document.addEventListener('submit',function(event){var form=event.target;if(!(form instanceof HTMLFormElement))return;var raw=form.getAttribute('action');if(typeof raw==='string')form.setAttribute('action',rewrite(raw));},true);})();</script>`;
}

export function shouldRewritePreviewHtml(headers: Headers): boolean {
  const contentType = headers.get('content-type')?.toLowerCase() ?? '';
  return contentType.includes('text/html');
}

export function rewritePreviewHtmlDocument(html: string, serverId: string, previewId: string, port: number, accessToken?: string): string {
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
    new RegExp(`\\b(href|src|action|formaction|poster)\\s*=\\s*(["'])https?:\\/\\/(?:127\\.0\\.0\\.1|localhost|\\[::1\\]|::1)(?::${port})?([^"']*)\\2`, 'gi'),
    (_match, attr, quote, suffix) => `${attr}=${quote}${prefix}${suffix || '/'}${quote}`,
  );

  rewritten = rewritten.replace(
    /\bsrcset\s*=\s*(["'])([^"']*)\1/gi,
    (_match, quote, value) => `srcset=${quote}${rewriteAbsoluteLocalhostValue(rewriteSrcsetValue(value, prefix), prefix, port)}${quote}`,
  );

  rewritten = rewritten.replace(
    /\bcontent\s*=\s*(["'])([^"']*;\s*url=)\/(?!\/)([^"']*)\1/gi,
    (_match, quote, head, path) => `content=${quote}${head}${prefix}/${path}${quote}`,
  );

  rewritten = rewritten.replace(
    /url\(\s*(["']?)\/(?!\/)([^)"']*)\1\s*\)/gi,
    (_match, quote, path) => `url(${quote}${prefix}/${path}${quote})`,
  );

  rewritten = rewriteAbsoluteLocalhostValue(rewritten, prefix, port);

  if (!rewritten.includes('data-imcodes-preview-runtime')) {
    const runtimePatch = buildPreviewRuntimePatch(prefix, port, accessToken);
    if (/<head\b[^>]*>/i.test(rewritten)) {
      rewritten = rewritten.replace(/<head\b([^>]*)>/i, `<head$1>${runtimePatch}`);
    } else {
      rewritten = `${runtimePatch}${rewritten}`;
    }
  }

  return rewritten;
}
