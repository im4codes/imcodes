/**
 * @vitest-environment jsdom
 */
import { cleanup, render } from '@testing-library/preact';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HTML_RENDER_MAX_BYTES } from '../../../shared/html-preview.js';
import { HtmlSafePreview } from '../../src/components/HtmlSafePreview.js';
import {
  createSafeHtmlPreviewDocument,
  HTML_PREVIEW_CSP,
  type HtmlPreviewDocumentResult,
} from '../../src/util/html-safe-preview.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (typeof opts?.maxBytes === 'number') return `${key}:${opts.maxBytes}`;
      if (typeof opts?.path === 'string') return `${key}:${opts.path}`;
      return key;
    },
  }),
}));

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function okSrcDoc(result: HtmlPreviewDocumentResult): string {
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error('expected ok preview document');
  return result.srcDoc;
}

function parsePreviewDocument(srcDoc: string): Document {
  return new DOMParser().parseFromString(srcDoc, 'text/html');
}

describe('createSafeHtmlPreviewDocument', () => {
  it('removes script, frame, plugin, refresh, event, srcdoc, form, SVG, and unsafe URL vectors', () => {
    const srcDoc = okSrcDoc(createSafeHtmlPreviewDocument(`
      <!doctype html>
      <html>
        <head>
          <base href="https://example.invalid/">
          <meta http-equiv="refresh" content="0; url=https://example.invalid/next">
          <meta http-equiv="Content-Security-Policy" content="default-src *">
          <link rel="stylesheet" href="https://example.invalid/style.css">
          <style>
            @import url("https://example.invalid/import.css");
            .x { background-image: url("https://example.invalid/pixel.png"); color: red; }
          </style>
          <script>window.parent.__pwned = true</script>
        </head>
        <body onload="window.parent.__pwned = true">
          <a id="bad-link" href="java
script:window.parent.__pwned = true">bad</a>
          <a id="local-link" href="#section">local</a>
          <img id="remote-image" src="https://example.invalid/pixel.png" srcset="https://example.invalid/2x.png 2x">
          <img id="data-image" src="data:image/png;base64,AA==" onerror="window.parent.__pwned = true">
          <form id="bad-form" action="https://example.invalid/post">
            <button id="bad-button" formaction="javascript:window.parent.__pwned = true">send</button>
          </form>
          <section id="bad-srcdoc" srcdoc="<p>bad</p>">srcdoc</section>
          <iframe srcdoc="<script>window.parent.__pwned = true</script>"></iframe>
          <object data="https://example.invalid/object"></object>
          <embed src="https://example.invalid/embed">
          <svg onload="window.parent.__pwned = true"><script>bad()</script><use href="javascript:bad()"></use></svg>
          <div id="bad-style" style="background: url(https://example.invalid/bg.png); color: red">style</div>
        </body>
      </html>
    `));
    const doc = parsePreviewDocument(srcDoc);

    expect(doc.querySelector('script, iframe, object, embed, svg, link')).toBeNull();
    expect(doc.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    expect(doc.body.getAttribute('onload')).toBeNull();
    expect(doc.querySelector('#bad-link')?.hasAttribute('href')).toBe(false);
    expect(doc.querySelector('#local-link')?.getAttribute('href')).toBe('#section');
    expect(doc.querySelector('#remote-image')?.hasAttribute('src')).toBe(false);
    expect(doc.querySelector('#remote-image')?.hasAttribute('srcset')).toBe(false);
    expect(doc.querySelector('#data-image')?.getAttribute('src')).toBe('data:image/png;base64,AA==');
    expect(doc.querySelector('#data-image')?.hasAttribute('onerror')).toBe(false);
    expect(doc.querySelector('#bad-form')?.hasAttribute('action')).toBe(false);
    expect(doc.querySelector('#bad-button')?.hasAttribute('formaction')).toBe(false);
    expect(doc.querySelector('#bad-srcdoc')?.hasAttribute('srcdoc')).toBe(false);
    expect(doc.querySelector('#bad-style')?.hasAttribute('style')).toBe(false);
    expect(srcDoc).not.toContain('example.invalid');
    expect(srcDoc).not.toContain('window.parent.__pwned');
  });

  it('inserts the restrictive CSP as the first head element and base href after it', () => {
    const srcDoc = okSrcDoc(createSafeHtmlPreviewDocument('<html><head><title>x</title></head><body>ok</body></html>'));
    const doc = parsePreviewDocument(srcDoc);
    const first = doc.head.firstElementChild;
    const second = first?.nextElementSibling;

    expect(first?.tagName).toBe('META');
    expect(first?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(first?.getAttribute('content')).toBe(HTML_PREVIEW_CSP);
    expect(second?.tagName).toBe('BASE');
    expect(second?.getAttribute('href')).toBe('about:blank');
  });

  it('returns oversize before constructing DOMParser', () => {
    const originalDomParser = globalThis.DOMParser;
    const domParserSpy = vi.fn();
    Object.defineProperty(globalThis, 'DOMParser', {
      value: domParserSpy,
      configurable: true,
    });

    try {
      expect(createSafeHtmlPreviewDocument('x'.repeat(HTML_RENDER_MAX_BYTES + 1))).toEqual({
        status: 'too-large',
        maxBytes: HTML_RENDER_MAX_BYTES,
      });
      expect(domParserSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, 'DOMParser', {
        value: originalDomParser,
        configurable: true,
      });
    }
  });
});

describe('HtmlSafePreview', () => {
  it('renders a scriptless srcDoc iframe with strict sandbox and referrer policy', () => {
    const { container } = render(<HtmlSafePreview path="/tmp/page.html" content="<h1>Hello</h1>" />);
    const iframe = container.querySelector('iframe');

    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('sandbox')).toBe('');
    expect(iframe?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(iframe?.getAttribute('title')).toBe('chat.html_preview_frame:/tmp/page.html');
    expect(iframe?.getAttribute('srcdoc')).toContain(HTML_PREVIEW_CSP);
  });

  it('rebinds the iframe when path or full content identity changes', () => {
    const prefix = 'a'.repeat(40);
    const suffix = 'z'.repeat(40);
    const firstContent = `<p>${prefix}middle-one${suffix}</p>`;
    const secondContent = `<p>${prefix}middle-two${suffix}</p>`;
    const view = render(<HtmlSafePreview path="/tmp/page.html" content={firstContent} />);
    const firstIframe = view.container.querySelector('iframe');
    const firstIdentity = firstIframe?.getAttribute('data-preview-identity');

    view.rerender(<HtmlSafePreview path="/tmp/page.html" content={secondContent} />);
    const secondIframe = view.container.querySelector('iframe');
    const secondIdentity = secondIframe?.getAttribute('data-preview-identity');

    expect(secondIframe).not.toBe(firstIframe);
    expect(secondIdentity).not.toBe(firstIdentity);

    view.rerender(<HtmlSafePreview path="/tmp/other.html" content={secondContent} />);
    expect(view.container.querySelector('iframe')?.getAttribute('data-preview-identity')).not.toBe(secondIdentity);
  });

  it('renders localized fallback states without an iframe', () => {
    const oversize = render(<HtmlSafePreview path="/tmp/huge.html" content={'x'.repeat(HTML_RENDER_MAX_BYTES + 1)} />);
    expect(oversize.container.querySelector('iframe')).toBeNull();
    expect(oversize.container.textContent).toBe(`chat.html_preview_too_large:${HTML_RENDER_MAX_BYTES}`);
    cleanup();

    const unavailable = render(<HtmlSafePreview path="/tmp/missing.html" content={null} />);
    expect(unavailable.container.querySelector('iframe')).toBeNull();
    expect(unavailable.container.textContent).toBe('chat.html_preview_unavailable');
  });

  it('keeps the safe render path free of forbidden preview primitives', () => {
    const files = [
      resolve(TEST_DIR, '../../src/components/HtmlSafePreview.tsx'),
      resolve(TEST_DIR, '../../src/util/html-safe-preview.ts'),
    ];
    const forbidden = [
      'allow-scripts',
      'allow-same-origin',
      'window.open',
      'URL.createObjectURL',
      'LocalWebPreviewPanel',
      'previewAttachment()',
      'dangerouslySetInnerHTML',
    ];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const token of forbidden) {
        expect(source.includes(token), `${file} contains ${token}`).toBe(false);
      }
    }
  });
});
