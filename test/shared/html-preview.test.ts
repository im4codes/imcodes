import { describe, expect, it } from 'vitest';
import {
  HTML_PREVIEW_SANDBOX,
  HTML_RENDER_MAX_BYTES,
  isHtmlPreviewPath,
} from '../../shared/html-preview.js';

describe('html preview shared policy', () => {
  it('exports a scriptless iframe sandbox policy and a positive render byte cap', () => {
    expect(HTML_PREVIEW_SANDBOX).toBe('');
    expect(HTML_RENDER_MAX_BYTES).toBeGreaterThan(0);
  });

  it.each([
    '/tmp/page.html',
    '/tmp/page.HTML',
    'docs/report.htm',
    'docs/report.HTM',
    'C:\\repo\\dist\\index.HTML',
  ])('accepts local HTML paths by basename suffix: %s', (path) => {
    expect(isHtmlPreviewPath(path)).toBe(true);
  });

  it.each([
    '/tmp/page.xhtml',
    '/tmp/page.svg',
    '/tmp/archive.html.bak',
    '/tmp/README',
    '/tmp/.html',
    '/tmp/page.html/',
    '/tmp/page.html/index',
  ])('rejects non-HTML or ambiguous local paths: %s', (path) => {
    expect(isHtmlPreviewPath(path)).toBe(false);
  });

  it.each([
    'https://example.invalid/page.html',
    'http://example.invalid/page.htm',
    'file:///tmp/page.html',
    'javascript:alert(1).html',
    'data:text/html,page.html',
    '//example.invalid/page.html',
  ])('rejects URLs and schemes: %s', (path) => {
    expect(isHtmlPreviewPath(path)).toBe(false);
  });
});
