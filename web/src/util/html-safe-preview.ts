import { HTML_RENDER_MAX_BYTES } from '@shared/html-preview.js';

export const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  'img-src data:',
  "style-src 'unsafe-inline'",
  'font-src data:',
  'media-src data:',
].join('; ');

export const HTML_PREVIEW_VIEWPORT_CONTENT = 'width=device-width, initial-scale=1';

export const HTML_PREVIEW_FIT_CSS = [
  'html, body {',
  '  width: 100% !important;',
  '  max-width: 100vw !important;',
  '  min-width: 0 !important;',
  '  overflow-x: hidden !important;',
  '  box-sizing: border-box;',
  '}',
  'body {',
  '  margin: 0;',
  '  overflow-wrap: anywhere;',
  '}',
  '*, *::before, *::after {',
  '  box-sizing: border-box;',
  '  min-width: 0 !important;',
  '}',
  'body * {',
  '  max-width: 100% !important;',
  '}',
  'img, video, canvas, table, pre {',
  '  max-width: 100% !important;',
  '}',
  'img, video, canvas {',
  '  height: auto;',
  '}',
  'pre, code, samp {',
  '  white-space: pre-wrap;',
  '  overflow-wrap: anywhere;',
  '}',
].join('\n');

export type HtmlPreviewDocumentResult =
  | { status: 'ok'; srcDoc: string }
  | { status: 'too-large'; maxBytes: number }
  | { status: 'unavailable' };

const REMOVED_SELECTOR = [
  'script',
  'base',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'link',
  'svg',
  'math',
  'template',
].join(',');

const URL_ATTRS = new Set([
  'action',
  'archive',
  'background',
  'cite',
  'classid',
  'codebase',
  'data',
  'formaction',
  'href',
  'imagesrcset',
  'longdesc',
  'manifest',
  'ping',
  'poster',
  'profile',
  'src',
  'srcdoc',
  'srcset',
  'usemap',
  'xlink:href',
]);

function hasJavascriptScheme(value: string): boolean {
  const compact = value.replace(/[\u0000-\u001F\u007F\s]+/g, '').toLowerCase();
  return compact.startsWith('javascript:');
}

function isUnsafeStyle(value: string): boolean {
  return /(?:@import|url\s*\(|expression\s*\(|javascript:)/i.test(value);
}

function shouldRemoveUrlAttr(name: string, value: string): boolean {
  if (name === 'srcdoc') return true;
  if (hasJavascriptScheme(value)) return true;
  if (name === 'src' && /^\s*data:image\//i.test(value)) return false;
  if (name === 'href' && /^\s*#/.test(value)) return false;
  return true;
}

function sanitizeStyleText(value: string): string {
  return value
    .replace(/@import[^;]+;?/gi, '')
    .replace(/url\s*\([^)]*\)/gi, '')
    .replace(/expression\s*\([^)]*\)/gi, '')
    .replace(/javascript\s*:/gi, '');
}

function sanitizeDocument(doc: Document): void {
  doc.querySelectorAll(REMOVED_SELECTOR).forEach((node) => node.remove());
  doc.querySelectorAll('meta[http-equiv]').forEach((node) => {
    const httpEquiv = node.getAttribute('http-equiv') ?? '';
    if (/^(?:refresh|content-security-policy|content-security-policy-report-only)$/i.test(httpEquiv.trim())) node.remove();
  });
  doc.querySelectorAll('style').forEach((node) => {
    node.textContent = sanitizeStyleText(node.textContent ?? '');
  });

  const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_ELEMENT);
  for (let node = walker.currentNode as Element | null; node; node = walker.nextNode() as Element | null) {
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      if (name.startsWith('on')) {
        node.removeAttribute(attr.name);
        continue;
      }
      if (name === 'style' && isUnsafeStyle(value)) {
        node.removeAttribute(attr.name);
        continue;
      }
      if (URL_ATTRS.has(name) && shouldRemoveUrlAttr(name, value)) {
        node.removeAttribute(attr.name);
      }
    }
  }
}

function injectPolicy(doc: Document): void {
  const head = doc.head ?? doc.documentElement.insertBefore(doc.createElement('head'), doc.body ?? null);
  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', HTML_PREVIEW_CSP);
  head.insertBefore(csp, head.firstChild);

  const base = doc.createElement('base');
  base.setAttribute('href', 'about:blank');
  head.insertBefore(base, csp.nextSibling);

  const existingViewport = Array.from(head.querySelectorAll('meta')).find((node) => (
    (node.getAttribute('name') ?? '').trim().toLowerCase() === 'viewport'
  ));
  const viewport = existingViewport ?? doc.createElement('meta');
  viewport.setAttribute('name', 'viewport');
  viewport.setAttribute('content', HTML_PREVIEW_VIEWPORT_CONTENT);
  head.insertBefore(viewport, base.nextSibling);

  const fitStyle = doc.createElement('style');
  fitStyle.setAttribute('data-imcodes-preview-fit', 'true');
  fitStyle.textContent = HTML_PREVIEW_FIT_CSS;
  head.appendChild(fitStyle);
}

export function createSafeHtmlPreviewDocument(content: string | null | undefined): HtmlPreviewDocumentResult {
  if (typeof content !== 'string') return { status: 'unavailable' };
  if (content.length > HTML_RENDER_MAX_BYTES) return { status: 'too-large', maxBytes: HTML_RENDER_MAX_BYTES };
  if (typeof DOMParser === 'undefined') return { status: 'unavailable' };

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(content, 'text/html');
    sanitizeDocument(doc);
    injectPolicy(doc);
    return { status: 'ok', srcDoc: `<!doctype html>\n${doc.documentElement.outerHTML}` };
  } catch {
    return { status: 'unavailable' };
  }
}
