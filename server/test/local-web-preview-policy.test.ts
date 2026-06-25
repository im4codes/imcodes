import { describe, expect, it } from 'vitest';
import {
  LOOPBACK_HOSTS,
  appendPreviewAccessTokenIfMissing,
  defaultPortForProtocol,
  filterPreviewResponseHeaders,
  isWebSocketUpgrade,
  rewritePreviewRedirectLocation,
  rewriteSetCookieHeader,
  sanitizePreviewRequestHeaders,
  shouldRewritePreviewRedirect,
  stripPreviewAccessTokenFromUpstreamPath,
} from '../../shared/preview-policy.js';
import { isStreamingResponse } from '../../shared/preview-stream-policy.js';
import { buildPreviewRuntimePatch, rewritePreviewHtmlDocument } from '../src/preview/policy.js';
import { COOKIE_CSRF, COOKIE_SESSION } from '../../shared/cookie-names.js';
import { PREVIEW_ACCESS_TOKEN_QUERY_PARAM } from '../../shared/preview-types.js';

describe('local web preview policy', () => {
  it('rewrites upstream cookies into preview-scoped cookies', () => {
    const rewritten = rewriteSetCookieHeader({
      previewId: 'preview123',
      serverId: 'server123',
      header: 'sid=abc; Path=/; Domain=localhost; HttpOnly; Secure; SameSite=None',
    });

    expect(rewritten).toContain('__imc_preview_preview123_sid=abc');
    expect(rewritten).toContain('Path=/api/server/server123/local-web/preview123/');
    expect(rewritten).not.toContain('Domain=');
    expect(rewritten).toContain('HttpOnly');
    expect(rewritten).toContain('Secure');
    expect(rewritten).toContain('SameSite=Strict');
  });

  it('drops reserved session and csrf cookie names', () => {
    expect(rewriteSetCookieHeader({ previewId: 'p', serverId: 's', header: `${COOKIE_SESSION}=x; Path=/` })).toBeNull();
    expect(rewriteSetCookieHeader({ previewId: 'p', serverId: 's', header: `${COOKIE_CSRF}=x; Path=/` })).toBeNull();
  });

  it('rewrites loopback redirects and passes through non-loopback', () => {
    // Same-port loopback → rewritten
    expect(rewritePreviewRedirectLocation({
      location: 'http://127.0.0.1:3000/docs?q=1',
      serverId: 'server123',
      previewId: 'preview123',
      port: 3000,
    })).toBe('/api/server/server123/local-web/preview123/docs?q=1');

    // Different port → passed through unchanged (not loopback match)
    expect(rewritePreviewRedirectLocation({
      location: 'http://127.0.0.1:3001/docs',
      serverId: 'server123',
      previewId: 'preview123',
      port: 3000,
    })).toBe('http://127.0.0.1:3001/docs');

    // External URL → passed through unchanged
    expect(rewritePreviewRedirectLocation({
      location: 'https://example.com/docs',
      serverId: 'server123',
      previewId: 'preview123',
      port: 3000,
    })).toBe('https://example.com/docs');
  });

  it('strips embedding-hostile headers on all preview responses', () => {
    const headers = new Headers({
      'content-security-policy': "frame-ancestors 'none'",
      'x-frame-options': 'DENY',
      'cache-control': 'no-cache',
    });

    const filtered = filterPreviewResponseHeaders(headers);
    expect(filtered.get('content-security-policy')).toBeNull();
    expect(filtered.get('x-frame-options')).toBeNull();
    expect(filtered.get('cache-control')).toBe('no-cache');
  });

  it('rewrites localhost and 0.0.0.0 redirects as loopback', () => {
    expect(rewritePreviewRedirectLocation({
      location: 'http://localhost:3000/docs',
      serverId: 'server123',
      previewId: 'preview123',
      port: 3000,
    })).toBe('/api/server/server123/local-web/preview123/docs');

    expect(rewritePreviewRedirectLocation({
      location: 'http://0.0.0.0:3000/app',
      serverId: 'server123',
      previewId: 'preview123',
      port: 3000,
    })).toBe('/api/server/server123/local-web/preview123/app');
  });

  it('forwards only preview-scoped cookies upstream and strips host header', () => {
    const headers = new Headers({
      host: 'im.codes',
      cookie: '__imc_preview_preview123_sid=abc; session=bad; __imc_preview_preview123_theme=dark',
      origin: 'https://public.example',
    });

    const sanitized = sanitizePreviewRequestHeaders(headers, 'preview123');
    expect(sanitized.host).toBeUndefined();
    expect(sanitized.origin).toBe('https://public.example');
    expect(sanitized.cookie).toBe('sid=abc; theme=dark');
  });

  it('rewrites root-relative html links and assets into the preview namespace', () => {
    const html = `
      <html>
        <head>
          <base href="/" />
          <link rel="stylesheet" href="/assets/app.css" />
        </head>
        <body style="background-image:url('/bg.png')">
          <a href="/docs">Docs</a>
          <form action="/submit"></form>
          <img src="/logo.png" srcset="/logo.png 1x, /logo@2x.png 2x" />
          <meta http-equiv="refresh" content="0; url=/login">
        </body>
      </html>
    `;

    const rewritten = rewritePreviewHtmlDocument(html, 'server123', 'preview123', 3000);
    const prefix = '/api/server/server123/local-web/preview123';

    expect(rewritten).toContain(`<base href="${prefix}/"`);
    expect(rewritten).toContain(`href="${prefix}/assets/app.css"`);
    expect(rewritten).toContain(`href="${prefix}/docs"`);
    expect(rewritten).toContain(`action="${prefix}/submit"`);
    expect(rewritten).toContain(`src="${prefix}/logo.png"`);
    expect(rewritten).toContain(`srcset="${prefix}/logo.png 1x, ${prefix}/logo@2x.png 2x"`);
    expect(rewritten).toContain(`url('${prefix}/bg.png')`);
    expect(rewritten).toContain(`content="0; url=${prefix}/login"`);
    expect(rewritten).toContain('data-imcodes-preview-runtime');
    expect(rewritten).toContain(`var PREFIX=${JSON.stringify(prefix)}`);
    expect(rewritten).toContain('Location.prototype.assign');
    expect(rewritten).toContain('Location.prototype.replace');
  });

  it('rewrites absolute localhost urls that target the current preview port', () => {
    const html = `
      <html><head></head><body>
        <a href="http://localhost:3000/docs?q=1">Docs</a>
        <img src="http://127.0.0.1:3000/logo.png" />
        <script>fetch("http://localhost:3000/api/data");location.assign("http://127.0.0.1:3000/next");</script>
      </body></html>
    `;

    const rewritten = rewritePreviewHtmlDocument(html, 'server123', 'preview123', 3000);
    const prefix = '/api/server/server123/local-web/preview123';

    expect(rewritten).toContain(`href="${prefix}/docs?q=1"`);
    expect(rewritten).toContain(`src="${prefix}/logo.png"`);
    expect(rewritten).toContain(`var PREVIEW_PORT=3000`);
  });

  // T-R-CC1-1 regex-derivation coverage: the absolute-loopback HTML rewriter
  // (`rewriteAbsoluteLocalhostValue`) builds its host alternation by REGEX-ESCAPING
  // each LOOPBACK_HOST. The bracketed IPv6 host `[::1]` carries the regex
  // metacharacters `[` and `]`, and `0.0.0.0` (the dev-server wildcard bind) carries
  // `.` — if the escaping were wrong the alternation would be malformed / mismatch.
  // This exercises those branches end-to-end through the HTML document rewrite.
  it('rewrites absolute [::1] and 0.0.0.0 loopback urls in HTML (derived-regex metachar escaping)', () => {
    const html = `
      <html><head></head><body>
        <img src="http://[::1]:3000/v6.png" />
        <a href="http://0.0.0.0:3000/wild?x=1">Wild</a>
      </body></html>
    `;
    const rewritten = rewritePreviewHtmlDocument(html, 'server123', 'preview123', 3000);
    const prefix = '/api/server/server123/local-web/preview123';
    // The derived alternation correctly matches the bracketed-IPv6 and wildcard
    // hosts for the current preview port (proves `[`/`]`/`.` were regex-escaped).
    expect(rewritten).toContain(`src="${prefix}/v6.png"`);
    expect(rewritten).toContain(`href="${prefix}/wild?x=1"`);
  });

  it('runtime patch script includes WebSocket constructor patch', () => {
    const html = '<html><head></head><body></body></html>';
    const rewritten = rewritePreviewHtmlDocument(html, 'server123', 'preview123', 3000, 'tok123');
    expect(rewritten).toContain('window.WebSocket');
    expect(rewritten).toContain('OriginalWebSocket');
    expect(rewritten).toContain('PatchedWebSocket');
    expect(rewritten).toContain('rewriteWsUrl');
  });
});

describe('isWebSocketUpgrade', () => {
  it('returns true for Upgrade: websocket (lowercase)', () => {
    const headers = new Headers({ upgrade: 'websocket' });
    expect(isWebSocketUpgrade(headers)).toBe(true);
  });

  it('returns true for Upgrade: WebSocket (mixed case)', () => {
    const headers = new Headers({ upgrade: 'WebSocket' });
    expect(isWebSocketUpgrade(headers)).toBe(true);
  });

  it('returns true for Upgrade: WEBSOCKET (uppercase)', () => {
    const headers = new Headers({ upgrade: 'WEBSOCKET' });
    expect(isWebSocketUpgrade(headers)).toBe(true);
  });

  it('returns false when upgrade header is absent', () => {
    const headers = new Headers({ 'content-type': 'text/html' });
    expect(isWebSocketUpgrade(headers)).toBe(false);
  });

  it('returns false when upgrade header is a different value', () => {
    const headers = new Headers({ upgrade: 'h2c' });
    expect(isWebSocketUpgrade(headers)).toBe(false);
  });
});

describe('sanitizePreviewRequestHeaders — WebSocket upgrade', () => {
  it('preserves connection, upgrade, sec-websocket-key, sec-websocket-version, sec-websocket-protocol on WS upgrade', () => {
    const headers = new Headers({
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      'sec-websocket-protocol': 'chat, superchat',
      'sec-websocket-extensions': 'permessage-deflate',
      host: 'im.codes',
      'content-type': 'text/plain',
    });

    const sanitized = sanitizePreviewRequestHeaders(headers, 'preview123');

    expect(sanitized['connection']).toBe('Upgrade');
    expect(sanitized['upgrade']).toBe('websocket');
    expect(sanitized['sec-websocket-key']).toBe('dGhlIHNhbXBsZSBub25jZQ==');
    expect(sanitized['sec-websocket-version']).toBe('13');
    expect(sanitized['sec-websocket-protocol']).toBe('chat, superchat');
    expect(sanitized['host']).toBeUndefined();
  });

  it('strips sec-websocket-extensions on WS upgrade', () => {
    const headers = new Headers({
      upgrade: 'websocket',
      'sec-websocket-extensions': 'permessage-deflate; client_max_window_bits',
    });

    const sanitized = sanitizePreviewRequestHeaders(headers, 'preview123');

    expect(sanitized['sec-websocket-extensions']).toBeUndefined();
  });

  it('still strips hop-by-hop headers that are not WS-specific (e.g. keep-alive, te)', () => {
    const headers = new Headers({
      upgrade: 'websocket',
      'keep-alive': 'timeout=5',
      te: 'trailers',
      'x-custom': 'value',
    });

    const sanitized = sanitizePreviewRequestHeaders(headers, 'preview123');

    expect(sanitized['keep-alive']).toBeUndefined();
    expect(sanitized['te']).toBeUndefined();
    expect(sanitized['x-custom']).toBe('value');
  });
});

describe('sanitizePreviewRequestHeaders — non-WebSocket (existing behavior)', () => {
  it('strips all hop-by-hop headers including connection and upgrade for normal HTTP', () => {
    const headers = new Headers({
      connection: 'keep-alive',
      upgrade: 'h2c',
      'keep-alive': 'timeout=5',
      'transfer-encoding': 'chunked',
      te: 'trailers',
      trailer: 'Expires',
      'proxy-authenticate': 'Basic',
      'proxy-authorization': 'Basic abc',
      'content-type': 'application/json',
      host: 'im.codes',
    });

    const sanitized = sanitizePreviewRequestHeaders(headers, 'preview123');

    expect(sanitized['connection']).toBeUndefined();
    expect(sanitized['upgrade']).toBeUndefined();
    expect(sanitized['keep-alive']).toBeUndefined();
    expect(sanitized['transfer-encoding']).toBeUndefined();
    expect(sanitized['te']).toBeUndefined();
    expect(sanitized['trailer']).toBeUndefined();
    expect(sanitized['proxy-authenticate']).toBeUndefined();
    expect(sanitized['proxy-authorization']).toBeUndefined();
    expect(sanitized['host']).toBeUndefined();
    expect(sanitized['content-type']).toBe('application/json');
  });

  it('strips sec-websocket-extensions even on non-WS requests', () => {
    const headers = new Headers({
      'sec-websocket-extensions': 'permessage-deflate',
      'x-custom': 'value',
    });

    const sanitized = sanitizePreviewRequestHeaders(headers, 'preview123');

    expect(sanitized['sec-websocket-extensions']).toBeUndefined();
    expect(sanitized['x-custom']).toBe('value');
  });
});

// ── V-strip (run 8a975732-23a P0.5.5) ──────────────────────────────────────────
// The upstream path/query MUST NOT carry the preview access token. The same
// shared function backs both the HTTP getUpstreamPath and the WS upstream path.
describe('V-strip: stripPreviewAccessTokenFromUpstreamPath', () => {
  const KEY = PREVIEW_ACCESS_TOKEN_QUERY_PARAM;

  it('removes the token but keeps other query keys AND their order', () => {
    expect(stripPreviewAccessTokenFromUpstreamPath(`/app?a=1&${KEY}=secret&b=2`)).toBe('/app?a=1&b=2');
    // order preserved when token is first / middle / last
    expect(stripPreviewAccessTokenFromUpstreamPath(`/x?${KEY}=s&a=1&b=2`)).toBe('/x?a=1&b=2');
    expect(stripPreviewAccessTokenFromUpstreamPath(`/x?a=1&b=2&${KEY}=s`)).toBe('/x?a=1&b=2');
  });

  it('removes EVERY occurrence including repeated / empty-value / value-less forms', () => {
    const out = stripPreviewAccessTokenFromUpstreamPath(`/p?${KEY}=x&${KEY}=&${KEY}&keep=1`);
    expect(out).toBe('/p?keep=1');
    expect(out).not.toContain(KEY);
  });

  it('drops the query separator entirely when only the token was present', () => {
    expect(stripPreviewAccessTokenFromUpstreamPath(`/only?${KEY}=x`)).toBe('/only');
    expect(stripPreviewAccessTokenFromUpstreamPath(`/only?${KEY}`)).toBe('/only');
  });

  it('leaves the pathname and a token-free query untouched', () => {
    expect(stripPreviewAccessTokenFromUpstreamPath('/app/page?a=1&b=2')).toBe('/app/page?a=1&b=2');
    expect(stripPreviewAccessTokenFromUpstreamPath('/app/page')).toBe('/app/page');
  });

  it('is case-SENSITIVE on the key (matches how auth reads it)', () => {
    // An uppercase variant is NOT the auth key, so it is preserved.
    expect(stripPreviewAccessTokenFromUpstreamPath('/p?Preview_Access_Token=x&a=1')).toBe('/p?Preview_Access_Token=x&a=1');
  });
});

// ── V-redirect-append (run 8a975732-23a A14 / access spec "redirect token append") ─
// The browser→proxy token is appended to a rewritten loopback redirect Location
// ONLY when missing, decided via URLSearchParams.has — NOT a `.includes` substring
// match. (The upstream segment is stripped separately — see V-strip above.)
describe('V-redirect-append: appendPreviewAccessTokenIfMissing', () => {
  const KEY = PREVIEW_ACCESS_TOKEN_QUERY_PARAM;
  const BASE = 'https://imcodes.example/api/server/s1/local-web/p1/page';

  it('does not duplicate the token when the Location already carries it', () => {
    const out = appendPreviewAccessTokenIfMissing(`/api/server/s1/local-web/p1/next?${KEY}=existing`, BASE, 'NEWTOKEN');
    expect(new URL(out, BASE).searchParams.get(KEY)).toBe('existing');
    expect(out).not.toContain('NEWTOKEN');
    expect(out.split(`${KEY}=`).length - 1).toBe(1); // exactly one occurrence
  });

  it('appends the token when only a same-named substring is in the PATHNAME (no query key)', () => {
    const out = appendPreviewAccessTokenIfMissing(`/api/server/s1/local-web/p1/${KEY}_help`, BASE, 'TOK');
    const url = new URL(out, BASE);
    expect(url.pathname.endsWith(`/${KEY}_help`)).toBe(true);
    expect(url.searchParams.get(KEY)).toBe('TOK'); // substring in path not misjudged as "present"
  });

  it('appends the token when a same-named substring is only in another param VALUE', () => {
    const out = appendPreviewAccessTokenIfMissing(`/x?note=${KEY}`, BASE, 'TOK');
    const params = new URL(out, BASE).searchParams;
    expect(params.get('note')).toBe(KEY);
    expect(params.get(KEY)).toBe('TOK'); // a `.includes` check would have WRONGLY skipped here
  });

  it('preserves other query params and the fragment when appending', () => {
    const out = appendPreviewAccessTokenIfMissing('/x?a=1&b=2#frag', BASE, 'TOK');
    const url = new URL(out, BASE);
    expect(url.searchParams.get('a')).toBe('1');
    expect(url.searchParams.get('b')).toBe('2');
    expect(url.searchParams.get(KEY)).toBe('TOK');
    expect(url.hash).toBe('#frag');
  });

  it('returns the Location unchanged when no token is configured', () => {
    expect(appendPreviewAccessTokenIfMissing('/x?a=1', BASE, null)).toBe('/x?a=1');
    expect(appendPreviewAccessTokenIfMissing('/x?a=1', BASE, undefined)).toBe('/x?a=1');
    expect(appendPreviewAccessTokenIfMissing('/x?a=1', BASE, '')).toBe('/x?a=1');
  });
});

// ── V-policy-parity (run 8a975732-23a P1.2.4) ──────────────────────────────────
// daemon preview-relay and server WS bridge MUST feed the SAME RESPONSE_START
// headers into the SAME shared `isStreamingResponse`. This asserts the predicate
// itself classifies the documented matrix (so both importers agree by construction).
describe('V-policy-parity: isStreamingResponse classification matrix', () => {
  it('classifies SSE / ndjson MIME as streaming (independently sufficient)', () => {
    expect(isStreamingResponse({ 'content-type': 'text/event-stream' })).toBe(true);
    expect(isStreamingResponse({ 'content-type': 'text/event-stream; charset=utf-8' })).toBe(true);
    expect(isStreamingResponse({ 'content-type': 'application/x-ndjson' })).toBe(true);
  });

  it('classifies chunked + non-JSON as streaming', () => {
    expect(isStreamingResponse({ 'content-type': 'text/plain', 'transfer-encoding': 'chunked' })).toBe(true);
  });

  it('does NOT classify chunked JSON (json / *+json) as streaming', () => {
    expect(isStreamingResponse({ 'content-type': 'application/json', 'transfer-encoding': 'chunked' })).toBe(false);
    expect(isStreamingResponse({ 'content-type': 'application/foo+json', 'transfer-encoding': 'chunked' })).toBe(false);
  });

  it('does NOT treat a missing Content-Length alone as streaming', () => {
    expect(isStreamingResponse({ 'content-type': 'application/json' })).toBe(false);
    expect(isStreamingResponse({ 'content-type': 'text/plain' })).toBe(false);
  });

  it('never treats text/html (even chunked) as streaming', () => {
    expect(isStreamingResponse({ 'content-type': 'text/html', 'transfer-encoding': 'chunked' })).toBe(false);
    expect(isStreamingResponse({ 'content-type': 'application/xhtml+xml', 'transfer-encoding': 'chunked' })).toBe(false);
  });
});

// ── T-R-CC1-1 (injection host single-source + anti-drift) ───────────────────────
// The injected browser runtime patch cannot `import` at runtime, so it serializes
// the exported `LOOPBACK_HOSTS` set into a `var LOOPBACK_HOSTS=[...]` literal at
// inject time. This guards that the injected literal is DERIVED from the constant:
// it MUST FAIL if a host is added to `LOOPBACK_HOSTS` without appearing in the
// injected script (and vice-versa).
describe('T-R-CC1-1: injected runtime patch loopback host set is derived from LOOPBACK_HOSTS', () => {
  function extractInjectedLoopbackHosts(script: string): string[] {
    // The serialized array itself contains a host with `]` (`[::1]`), so match up
    // to the literal `];` that terminates the `var LOOPBACK_HOSTS=[...]` statement.
    const match = script.match(/var LOOPBACK_HOSTS=(\[.*?\]);var TOKEN_PARAM=/);
    if (!match) throw new Error('no var LOOPBACK_HOSTS=[...] literal found in injected runtime script');
    return JSON.parse(match[1]) as string[];
  }

  it('serializes exactly [...LOOPBACK_HOSTS] into the injected script (deep-equal)', () => {
    const script = buildPreviewRuntimePatch('/api/server/s1/local-web/p1', 3000);
    expect(extractInjectedLoopbackHosts(script)).toEqual([...LOOPBACK_HOSTS]);
  });

  it('injects the same host set regardless of access token presence', () => {
    const withToken = buildPreviewRuntimePatch('/api/server/s1/local-web/p1', 3000, 'tok123');
    expect(extractInjectedLoopbackHosts(withToken)).toEqual([...LOOPBACK_HOSTS]);
  });

  it('drives the inline isLoopbackHost check off the injected LOOPBACK_HOSTS array (no hand-maintained literal)', () => {
    const script = buildPreviewRuntimePatch('/api/server/s1/local-web/p1', 3000);
    expect(script).toContain('function isLoopbackHost(host){return LOOPBACK_HOSTS.indexOf(host)!==-1;}');
  });

  it('also reaches the injected script via the full HTML rewrite path', () => {
    const html = '<html><head></head><body></body></html>';
    const rewritten = rewritePreviewHtmlDocument(html, 'server123', 'preview123', 3000);
    expect(extractInjectedLoopbackHosts(rewritten)).toEqual([...LOOPBACK_HOSTS]);
  });
});

// ── T-R-CC1-CSP (regression: embed-block headers are stripped) ──────────────────
// `filterPreviewResponseHeaders` strips the embed-block response headers via
// `PREVIEW_EMBED_STRIP_RESPONSE_HEADERS`. This guards the PRECONDITION that the
// injected runtime patches are not silently disabled by an upstream CSP / frame
// policy: all three must be removed while ordinary headers pass through.
describe('T-R-CC1-CSP: filterPreviewResponseHeaders strips embed-block headers', () => {
  it('removes CSP, CSP-report-only and x-frame-options while keeping ordinary headers', () => {
    const filtered = filterPreviewResponseHeaders(new Headers({
      'content-security-policy': "frame-ancestors 'none'",
      'content-security-policy-report-only': "frame-ancestors 'none'",
      'x-frame-options': 'DENY',
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
    }));

    expect(filtered.get('content-security-policy')).toBeNull();
    expect(filtered.get('content-security-policy-report-only')).toBeNull();
    expect(filtered.get('x-frame-options')).toBeNull();
    expect(filtered.get('content-type')).toBe('text/html; charset=utf-8');
    expect(filtered.get('cache-control')).toBe('no-cache');
  });
});

// ── T-R-CC1-3 (protocol-aware default port for redirect rewrite) ────────────────
// `shouldRewritePreviewRedirect` must resolve a URL's default port BY PROTOCOL
// (http/ws → 80, https/wss → 443) instead of the old `Number(url.port || '80')`,
// which mis-defaulted an https/wss loopback URL without an explicit port to 80 and
// thereby failed the preview-port comparison.
describe('T-R-CC1-3: defaultPortForProtocol', () => {
  it('maps http/ws → 80 and https/wss → 443 (with or without trailing colon, any case)', () => {
    expect(defaultPortForProtocol('http:')).toBe(80);
    expect(defaultPortForProtocol('ws:')).toBe(80);
    expect(defaultPortForProtocol('https:')).toBe(443);
    expect(defaultPortForProtocol('wss:')).toBe(443);
    expect(defaultPortForProtocol('https')).toBe(443); // no trailing colon
    expect(defaultPortForProtocol('HTTPS:')).toBe(443); // case-insensitive
    expect(defaultPortForProtocol('ftp:')).toBe(80); // unknown → 80
  });
});

describe('T-R-CC1-3: shouldRewritePreviewRedirect resolves default port by protocol', () => {
  // The bug fix: an https loopback URL WITHOUT an explicit port must resolve to 443.
  it('V-redirect-https-default-port: https loopback w/o explicit port matches preview port 443', () => {
    expect(shouldRewritePreviewRedirect('https://127.0.0.1/events', 443)).toBe(true);
    expect(shouldRewritePreviewRedirect('https://localhost/x', 443)).toBe(true);
    // old behaviour (Number(''||'80')=80) would WRONGLY return false here.
  });

  it('http loopback w/o explicit port matches preview port 80', () => {
    expect(shouldRewritePreviewRedirect('http://127.0.0.1/x', 80)).toBe(true);
  });

  it('https loopback w/o explicit port does NOT match a non-443 preview port', () => {
    expect(shouldRewritePreviewRedirect('https://127.0.0.1/x', 3000)).toBe(false);
  });

  it('matches an explicit port and all loopback host spellings', () => {
    expect(shouldRewritePreviewRedirect('http://127.0.0.1:3000/x', 3000)).toBe(true);
    expect(shouldRewritePreviewRedirect('http://localhost:3000/x', 3000)).toBe(true);
    expect(shouldRewritePreviewRedirect('http://0.0.0.0:3000/x', 3000)).toBe(true);
    expect(shouldRewritePreviewRedirect('http://[::1]:3000/x', 3000)).toBe(true);
  });

  it('resolves a relative Location against the preview-port base (still a rewrite)', () => {
    expect(shouldRewritePreviewRedirect('/dashboard', 3000)).toBe(true);
  });

  it('does NOT rewrite a non-loopback host or a different port', () => {
    expect(shouldRewritePreviewRedirect('https://example.com/x', 443)).toBe(false);
    expect(shouldRewritePreviewRedirect('http://127.0.0.1:9999/x', 3000)).toBe(false);
  });
});
