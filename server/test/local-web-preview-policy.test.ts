import { describe, expect, it } from 'vitest';
import {
  filterPreviewResponseHeaders,
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

    const rewritten = rewritePreviewHtmlDocument(html, 'server123', 'preview123');
    const prefix = '/api/server/server123/local-web/preview123';

    expect(rewritten).toContain(`<base href="${prefix}/"`);
    expect(rewritten).toContain(`href="${prefix}/assets/app.css"`);
    expect(rewritten).toContain(`href="${prefix}/docs"`);
    expect(rewritten).toContain(`action="${prefix}/submit"`);
    expect(rewritten).toContain(`src="${prefix}/logo.png"`);
    expect(rewritten).toContain(`srcset="${prefix}/logo.png 1x, ${prefix}/logo@2x.png 2x"`);
    expect(rewritten).toContain(`url('${prefix}/bg.png')`);
    expect(rewritten).toContain(`content="0; url=${prefix}/login"`);
  });
});
