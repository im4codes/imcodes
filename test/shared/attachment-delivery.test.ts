import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_DISPOSITION,
  ATTACHMENT_FALLBACK_MIME,
  ATTACHMENT_INLINE_MIME_ALLOWLIST,
  ATTACHMENT_RESPONSE_CSP,
  ATTACHMENT_SNIFF_BYTES,
  attachmentContentDisposition,
  normalizeAttachmentMime,
  resolveAttachmentDelivery,
  sniffAttachmentMime,
} from '../../shared/attachment-delivery.js';

describe('attachment delivery policy', () => {
  it.each([
    [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/png'],
    [[0xff, 0xd8, 0xff, 0xe0], 'image/jpeg'],
    ['GIF89a', 'image/gif'], ['GIF87a', 'image/gif'], ['RIFF\0\0\0\0WEBP', 'image/webp'],
    ['BM\0\0\0\0\0\0\0\0\0\0\0\0', 'image/bmp'], ['%PDF-1.4', 'application/pdf'],
    [[0x50, 0x4b, 0x03, 0x04], 'application/zip'],
    ['\ufeff<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'image/svg+xml'],
    ['<svg/>', 'image/svg+xml'], ['<!doctype html><script>alert(1)</script>', 'text/html'],
    ['<?xml version="1.0"?><document/>', 'application/xml'], ['ordinary text', 'text/plain'],
    [[], 'application/octet-stream'], [[0xff], 'application/octet-stream'], ['\0binary', 'application/octet-stream'],
  ] as const)('sniffs %j from bytes as %s without accepting a client MIME', (bytes, expected) => {
    const prefix = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
    expect(sniffAttachmentMime(prefix)).toBe(expected);
  });

  it('recognizes only aligned AVIF brands inside the declared ftyp box, and respects the sniff bound', () => {
    const avif = new Uint8Array(24);
    new DataView(avif.buffer).setUint32(0, 24);
    avif.set(new TextEncoder().encode('ftypmif1\0\0\0\0avif'), 4);
    expect(sniffAttachmentMime(avif)).toBe('image/avif');
    new DataView(avif.buffer).setUint32(0, 16);
    expect(sniffAttachmentMime(avif)).not.toBe('image/avif'); // compatible brand outside the box
    const large = new Uint8Array(ATTACHMENT_SNIFF_BYTES * 4).fill(32);
    large.set(new TextEncoder().encode('<svg/>'), ATTACHMENT_SNIFF_BYTES);
    expect(sniffAttachmentMime(large)).toBe('text/plain');
    expect(sniffAttachmentMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).not.toBe('image/png'); // truncated signature
  });
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
