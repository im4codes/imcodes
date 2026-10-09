import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_DISPOSITION,
  ATTACHMENT_FALLBACK_MIME,
  ATTACHMENT_INLINE_MIME_ALLOWLIST,
  ATTACHMENT_RESPONSE_CSP,
  attachmentContentDisposition,
  normalizeAttachmentMime,
  resolveAttachmentDelivery,
} from '../../shared/attachment-delivery.js';

describe('attachment delivery policy', () => {
  it('shows only the raster allowlist inline; SVG and every other type is a download', () => {
    for (const mime of ATTACHMENT_INLINE_MIME_ALLOWLIST) expect(resolveAttachmentDelivery(mime).disposition, mime).toBe(ATTACHMENT_DISPOSITION.INLINE);
    expect(ATTACHMENT_INLINE_MIME_ALLOWLIST.some((mime) => /svg|html|xml|javascript|pdf/.test(mime))).toBe(false);
    for (const mime of ['image/svg+xml', 'image/svg', 'text/html', 'application/xhtml+xml', 'text/xml', 'application/xml', 'application/pdf',
      'text/javascript', 'image/x-icon', 'image/heic', 'application/octet-stream', 'text/plain']) {
      expect(resolveAttachmentDelivery(mime).disposition, mime).toBe(ATTACHMENT_DISPOSITION.ATTACHMENT);
    }
  });

  it('compares the bare type: case and parameters never turn a document into an image, or an image into a document', () => {
    expect(normalizeAttachmentMime('IMAGE/PNG ; q=1')).toBe('image/png');
    expect(resolveAttachmentDelivery('Image/Png; charset=binary').disposition).toBe(ATTACHMENT_DISPOSITION.INLINE);
    expect(resolveAttachmentDelivery('image/png/../svg+xml').disposition).toBe(ATTACHMENT_DISPOSITION.ATTACHMENT);
    expect(resolveAttachmentDelivery('image/png, text/html').disposition).toBe(ATTACHMENT_DISPOSITION.ATTACHMENT);
  });

  it('never echoes a malformed claimed type into a header: it becomes octet-stream, as does a missing one', () => {
    for (const bad of [undefined, null, '', '   ', 'png', 'image/', '/png', 'image/png\r\nSet-Cookie: a=b', 'text/html; x="\r\n"', 'a b/c']) {
      const delivery = resolveAttachmentDelivery(bad as string | undefined);
      expect(delivery.contentType, String(bad)).toBe(ATTACHMENT_FALLBACK_MIME);
      expect(delivery.disposition).toBe(ATTACHMENT_DISPOSITION.ATTACHMENT);
    }
    expect(resolveAttachmentDelivery('image/svg+xml').contentType).toBe('image/svg+xml'); // still labelled, so an <img> renders it
  });

  it('every delivery carries nosniff and the sandboxing CSP', () => {
    for (const mime of ['image/png', 'image/svg+xml', 'text/html', undefined]) {
      expect(resolveAttachmentDelivery(mime).securityHeaders).toEqual({ 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': ATTACHMENT_RESPONSE_CSP });
    }
    expect(ATTACHMENT_RESPONSE_CSP).toMatch(/^sandbox;/);
    expect(ATTACHMENT_RESPONSE_CSP).toContain("default-src 'none'");
  });

  it('builds the Content-Disposition with an ASCII fallback and the UTF-8 form, quoting-safe', () => {
    expect(attachmentContentDisposition('attachment', 'a "b".txt')).toBe('attachment; filename="a \\"b\\".txt"; filename*=UTF-8\'\'a%20%22b%22.txt');
    expect(attachmentContentDisposition('inline', '说明.png')).toContain("filename*=UTF-8''%E8%AF%B4%E6%98%8E.png");
    expect(attachmentContentDisposition('inline', "it's.png")).toContain("%27");
  });
});
