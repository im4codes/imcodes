export {
  PREVIEW_COOKIE_PREFIX,
  PREVIEW_EMBED_STRIP_RESPONSE_HEADERS,
  PREVIEW_HOP_BY_HOP_HEADERS,
  PREVIEW_SENSITIVE_HEADERS,
  buildPreviewCookieName,
  buildUpstreamCookieHeader,
  filterPreviewResponseHeaders,
  isLoopbackHost,
  isReservedPreviewCookieName,
  isWebSocketUpgrade,
  normalizePreviewUpstreamPath,
  parsePreviewCookieName,
  previewRoutePrefix,
  redactPreviewHeaders,
  rewritePreviewRedirectLocation,
  rewriteSetCookieHeader,
  sanitizePreviewRequestHeaders,
  shouldRewritePreviewRedirect,
} from '../../../shared/preview-policy.js';

import { LOOPBACK_HOSTS, previewRoutePrefix } from '../../../shared/preview-policy.js';

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

/**
 * Regex-escaped alternation of every loopback host, DERIVED from the single source
 * of truth `LOOPBACK_HOSTS` (never a hand-typed `(?:127\.0\.0\.1|localhost|…)`
 * literal). `[::1]` carries the regex metacharacters `[` and `]`, so each host is
 * escaped before being joined. Used by the absolute-loopback URL rewriters below;
 * staying derived means adding a host to `LOOPBACK_HOSTS` updates these rewrites
 * automatically (guarded by the anti-drift test).
 */
const LOOPBACK_HOST_REGEX_ALTERNATION = [...LOOPBACK_HOSTS]
  .map((host) => host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

function rewriteAbsoluteLocalhostValue(value: string, prefix: string, port: number): string {
  return value.replace(
    new RegExp(`https?:\\/\\/(?:${LOOPBACK_HOST_REGEX_ALTERNATION})(?::${port})?(\\/[^\\s,"']*)?`, 'gi'),
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

function serializeInlineScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function buildPreviewRuntimePatch(prefix: string, port: number, accessToken?: string): string {
  const prefixJson = serializeInlineScriptJson(prefix);
  const portJson = JSON.stringify(port);
  const tokenJson = accessToken ? serializeInlineScriptJson(accessToken) : 'null';
  // Serialize the SINGLE SOURCE OF TRUTH loopback host set into the inline script
  // at inject time. The injected script runs in the previewed page's global scope
  // and cannot `import` at runtime, so the set is derived from the exported
  // `LOOPBACK_HOSTS` constant here (never a hand-typed literal) and guarded by an
  // anti-drift test.
  const loopbackHostsJson = serializeInlineScriptJson([...LOOPBACK_HOSTS]);
  return `<script data-imcodes-preview-runtime>(function(){var PREFIX=${prefixJson};var PREVIEW_PORT=${portJson};var ACCESS_TOKEN=${tokenJson};var LOOPBACK_HOSTS=${loopbackHostsJson};var TOKEN_PARAM='preview_access_token';if(window.__IMCODES_PREVIEW_PATCHED__)return;window.__IMCODES_PREVIEW_PATCHED__=true;function isLoopbackHost(host){return LOOPBACK_HOSTS.indexOf(host)!==-1;}function getRawUrl(u){if(typeof u==='string')return u;if(u&&typeof u==='object'&&typeof u.href==='string'&&typeof u.protocol==='string')return u.href;return null;}function getLocHref(){var proto=(window.location&&window.location.protocol)||'https:';var host=(window.location&&window.location.host)||'';return (window.location&&window.location.href)||(proto+'//'+host+PREFIX+'/');}function getLocOrigin(){var proto=(window.location&&window.location.protocol)||'https:';var host=(window.location&&window.location.host)||'';return (window.location&&window.location.origin)||(proto+'//'+host);}function appendToken(rewrittenUrl){if(!ACCESS_TOKEN)return rewrittenUrl;try{var u=new URL(rewrittenUrl,getLocHref());if(!u.searchParams.has(TOKEN_PARAM))u.searchParams.set(TOKEN_PARAM,ACCESS_TOKEN);return u.pathname+u.search+u.hash;}catch(_){return rewrittenUrl;}}function appendWsToken(absWsUrl){if(!ACCESS_TOKEN)return absWsUrl;try{var u=new URL(absWsUrl);if(!u.searchParams.has(TOKEN_PARAM))u.searchParams.set(TOKEN_PARAM,ACCESS_TOKEN);return u.toString();}catch(_){var hIdx=absWsUrl.indexOf('#');var noHash=hIdx===-1?absWsUrl:absWsUrl.slice(0,hIdx);var hash=hIdx===-1?'':absWsUrl.slice(hIdx);var sep=noHash.indexOf('?')===-1?'?':'&';return noHash+sep+TOKEN_PARAM+'='+encodeURIComponent(ACCESS_TOKEN)+hash;}}function rewrite(input){var url=getRawUrl(input);if(url===null)return input;if(url.startsWith('//'))return input;if(url===PREFIX||url.startsWith(PREFIX+'/')||url.startsWith(PREFIX+'?')||url.startsWith(PREFIX+'#'))return appendToken(url);try{var locOrigin=getLocOrigin();var absolute=new URL(url,getLocHref());var port=Number(absolute.port||(absolute.protocol==='https:'?'443':absolute.protocol==='wss:'?'443':'80'));if((absolute.protocol==='http:'||absolute.protocol==='https:')&&isLoopbackHost(absolute.hostname)&&port===PREVIEW_PORT){return appendToken(PREFIX+absolute.pathname+absolute.search+absolute.hash);}if(absolute.origin===locOrigin&&absolute.pathname.startsWith('/')){if(absolute.pathname===PREFIX||absolute.pathname.startsWith(PREFIX+'/')){if(url.startsWith('/')||/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)){return appendToken(absolute.pathname+absolute.search+absolute.hash);}return ACCESS_TOKEN?appendToken(absolute.pathname+absolute.search+absolute.hash):input;}return appendToken(PREFIX+absolute.pathname+absolute.search+absolute.hash);}}catch(_e){}if(url.startsWith('/'))return appendToken(PREFIX+url);return input;}var originalFetch=window.fetch;if(typeof originalFetch==='function'){window.fetch=function(input,init){var raw=getRawUrl(input);if(raw!==null)return originalFetch.call(this,rewrite(raw),init);if(input&&typeof input.url==='string'){try{var rewritten=rewrite(input.url);if(rewritten!==input.url)return originalFetch.call(this,new Request(rewritten,input),init);}catch(_e){}}return originalFetch.call(this,input,init);};}var originalOpen=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url){var args=Array.prototype.slice.call(arguments);var raw=getRawUrl(args[1]);if(raw!==null)args[1]=rewrite(raw);return originalOpen.apply(this,args);};function wrapHistory(name){var original=history[name];if(typeof original!=='function')return;history[name]=function(state,title,url){if(getRawUrl(url)!==null)url=rewrite(url);return original.call(this,state,title,url);};}wrapHistory('pushState');wrapHistory('replaceState');if(window.Location&&window.Location.prototype){var originalAssign=window.Location.prototype.assign;if(typeof originalAssign==='function'){window.Location.prototype.assign=function(url){return originalAssign.call(this,rewrite(url));};}var originalReplace=window.Location.prototype.replace;if(typeof originalReplace==='function'){window.Location.prototype.replace=function(url){return originalReplace.call(this,rewrite(url));};}}var originalOpenWindow=window.open;if(typeof originalOpenWindow==='function'){window.open=function(url,target,features){return originalOpenWindow.call(window,getRawUrl(url)!==null?rewrite(url):url,target,features);};}document.addEventListener('click',function(event){var anchor=event.target&&event.target.closest?event.target.closest('a[href]'):null;if(!anchor)return;var raw=anchor.getAttribute('href');if(typeof raw==='string')anchor.setAttribute('href',rewrite(raw));},true);document.addEventListener('submit',function(event){var form=event.target;if(!(form instanceof HTMLFormElement))return;var raw=form.getAttribute('action');if(typeof raw==='string')form.setAttribute('action',rewrite(raw));},true);if(typeof window.WebSocket==='function'){var OriginalWebSocket=window.WebSocket;function rewriteWsUrl(input){var url=getRawUrl(input);if(url===null)return input;if(url.startsWith('//'))return input;var locProto=(window.location&&window.location.protocol)||'https:';var locHost=(window.location&&window.location.host)||'';var wsScheme=locProto==='http:'?'ws://':'wss://';var base=wsScheme+locHost;if(url===PREFIX||url.startsWith(PREFIX+'/')||url.startsWith(PREFIX+'?')||url.startsWith(PREFIX+'#')){return appendWsToken(base+url);}if(url.startsWith('/')){return appendWsToken(base+PREFIX+url);}try{var hasScheme=/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url);var parsed=new URL(url,getLocHref());var proto=parsed.protocol;var isWsProto=proto==='ws:'||proto==='wss:';var isHttpProto=proto==='http:'||proto==='https:';if(hasScheme&&!isWsProto&&!isHttpProto)return input;var alreadyPrefixed=parsed.pathname===PREFIX||parsed.pathname.startsWith(PREFIX+'/');var parsedPort=Number(parsed.port||(proto==='wss:'||proto==='https:'?'443':'80'));if((isWsProto||isHttpProto)&&isLoopbackHost(parsed.hostname)&&parsedPort===PREVIEW_PORT){return appendWsToken(base+(alreadyPrefixed?parsed.pathname:PREFIX+parsed.pathname)+parsed.search);}if((isWsProto||isHttpProto)&&((locHost&&parsed.host===locHost)||!hasScheme)){return appendWsToken(base+(alreadyPrefixed?parsed.pathname:PREFIX+parsed.pathname)+parsed.search);}}catch(_e){}return input;}function PatchedWebSocket(url,protocols){var rewrittenUrl=rewriteWsUrl(url);if(protocols!==undefined){return new OriginalWebSocket(rewrittenUrl,protocols);}return new OriginalWebSocket(rewrittenUrl);}PatchedWebSocket.prototype=OriginalWebSocket.prototype;PatchedWebSocket.CONNECTING=OriginalWebSocket.CONNECTING;PatchedWebSocket.OPEN=OriginalWebSocket.OPEN;PatchedWebSocket.CLOSING=OriginalWebSocket.CLOSING;PatchedWebSocket.CLOSED=OriginalWebSocket.CLOSED;window.WebSocket=PatchedWebSocket;}if(typeof window.EventSource==='function'){var OriginalEventSource=window.EventSource;function PatchedEventSource(url,eventSourceInitDict){var rewrittenUrl=rewrite(url);if(eventSourceInitDict!==undefined){return new OriginalEventSource(rewrittenUrl,eventSourceInitDict);}return new OriginalEventSource(rewrittenUrl);}PatchedEventSource.prototype=OriginalEventSource.prototype;PatchedEventSource.CONNECTING=OriginalEventSource.CONNECTING;PatchedEventSource.OPEN=OriginalEventSource.OPEN;PatchedEventSource.CLOSED=OriginalEventSource.CLOSED;window.EventSource=PatchedEventSource;}})();</script>`;
}

/** Max HTML size for rewriting — larger documents are proxied without modification to avoid CPU spikes. */
const MAX_HTML_REWRITE_BYTES = 5 * 1024 * 1024; // 5MB

export function shouldRewritePreviewHtml(headers: Headers): boolean {
  const contentType = headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('text/html')) return false;
  const contentLength = headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_HTML_REWRITE_BYTES) return false;
  return true;
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
    new RegExp(`\\b(href|src|action|formaction|poster)\\s*=\\s*(["'])https?:\\/\\/(?:${LOOPBACK_HOST_REGEX_ALTERNATION})(?::${port})?([^"']*)\\2`, 'gi'),
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
