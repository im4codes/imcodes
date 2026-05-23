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
