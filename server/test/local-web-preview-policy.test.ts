import { describe, expect, it } from 'vitest';
import {
  filterPreviewResponseHeaders,
  isWebSocketUpgrade,
  rewritePreviewRedirectLocation,
  rewriteSetCookieHeader,
  sanitizePreviewRequestHeaders,
} from '../../shared/preview-policy.js';
import { rewritePreviewHtmlDocument } from '../src/preview/policy.js';
import { COOKIE_CSRF, COOKIE_SESSION } from '../../shared/cookie-names.js';

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

  it('rewrites only same-loopback same-port redirects', () => {
    expect(rewritePreviewRedirectLocation({
      location: 'http://127.0.0.1:3000/docs?q=1',
      serverId: 'server123',
      previewId: 'preview123',
      port: 3000,
    })).toBe('/api/server/server123/local-web/preview123/docs?q=1');

    expect(rewritePreviewRedirectLocation({
      location: 'http://127.0.0.1:3001/docs',
      serverId: 'server123',
      previewId: 'preview123',
      port: 3000,
    })).toBeNull();

    expect(rewritePreviewRedirectLocation({
      location: 'https://example.com/docs',
      serverId: 'server123',
      previewId: 'preview123',
      port: 3000,
    })).toBeNull();
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

  it('does not rewrite localhost redirects outside literal loopback hosts', () => {
    expect(rewritePreviewRedirectLocation({
      location: 'http://localhost:3000/docs',
      serverId: 'server123',
      previewId: 'preview123',
      port: 3000,
    })).toBeNull();
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
