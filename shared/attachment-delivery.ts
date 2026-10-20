/**
 * How a downloaded file / attachment is handed to a BROWSER.
 *
 * The download routes answer on the application's own origin. A response the browser renders as a document there (an SVG with
 * `<script>`/`foreignObject`, an HTML or XML file, anything the browser sniffs into one) runs in that origin: stored XSS against
 * whoever opens the link -- the owner or a share participant. So delivery is decided here, in one place, from the claimed type:
 *
 *  - only a short allowlist of RASTER image types is shown inline (previews, lightbox, `<img src>`);
 *  - everything else, SVG included, is `Content-Disposition: attachment`. An `<img src>` ignores the disposition and an SVG loaded as
 *    an image never runs script, so the composer and lightbox previews keep working while navigating to the URL downloads the file;
 *  - every response carries `nosniff` and a CSP that sandboxes the document and allows nothing, so even a type the browser decides to
 *    render has no scripting context.
 *
 * Upload labels come from a bounded byte sniff, never the client MIME. Local-file handles may still report an extension-based label;
 * disposition + nosniff + sandbox remain mandatory for those too.
 */

export const ATTACHMENT_MIME = {
  PNG: 'image/png', JPEG: 'image/jpeg', GIF: 'image/gif', WEBP: 'image/webp', AVIF: 'image/avif', BMP: 'image/bmp',
  SVG: 'image/svg+xml', HTML: 'text/html', XML: 'application/xml', PDF: 'application/pdf', ZIP: 'application/zip',
  TEXT: 'text/plain', BINARY: 'application/octet-stream',
} as const;

/** Raster image types a browser may render inline. SVG is deliberately absent (it is a document that can carry script). */
export const ATTACHMENT_INLINE_MIME_ALLOWLIST: readonly string[] = Object.freeze([
  ATTACHMENT_MIME.PNG, ATTACHMENT_MIME.JPEG, ATTACHMENT_MIME.GIF, ATTACHMENT_MIME.WEBP, ATTACHMENT_MIME.AVIF, ATTACHMENT_MIME.BMP,
]);

export const ATTACHMENT_DISPOSITION = { INLINE: 'inline', ATTACHMENT: 'attachment' } as const;
export type AttachmentDisposition = typeof ATTACHMENT_DISPOSITION[keyof typeof ATTACHMENT_DISPOSITION];

export const ATTACHMENT_FALLBACK_MIME = ATTACHMENT_MIME.BINARY;

/** A bounded prefix, not a whole-file decode: upload memory/work stays constant at the transfer size limit. */
export const ATTACHMENT_SNIFF_BYTES = 4096;

/**
 * Uploaded bytes, never the client MIME or extension, select the stored type. Unknown/short/invalid content is a download.
 * These signatures label images for browser decoders; they do not claim the entire file is a valid image. The delivery policy still
 * sends nosniff + sandbox CSP, and only raster decoders are inline. Textual SVG keeps its image label for safe <img> previews.
 */
export function sniffAttachmentMime(input: Uint8Array): string {
  const bytes = input.subarray(0, ATTACHMENT_SNIFF_BYTES);
  const starts = (signature: readonly number[], offset = 0) => bytes.length >= offset + signature.length
    && signature.every((value, i) => bytes[offset + i] === value);
  const ascii = (value: string, offset = 0) => starts(Array.from(value, (char) => char.charCodeAt(0)), offset);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return ATTACHMENT_MIME.PNG;
  if (starts([0xff, 0xd8, 0xff])) return ATTACHMENT_MIME.JPEG;
  if (ascii('GIF87a') || ascii('GIF89a')) return ATTACHMENT_MIME.GIF;
  if (ascii('RIFF') && ascii('WEBP', 8)) return ATTACHMENT_MIME.WEBP;
  // ISO BMFF: avif/avis must be a major or compatible brand in the bounded ftyp box (not an arbitrary substring in the file).
  if (bytes.length >= 16 && ascii('ftyp', 4)) {
    const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (boxSize >= 16 && boxSize <= bytes.length) {
      for (let offset = 8; offset + 4 <= boxSize; offset += 4) {
        if (offset !== 12 && (ascii('avif', offset) || ascii('avis', offset))) return ATTACHMENT_MIME.AVIF;
      }
    }
  }
  if (ascii('BM') && bytes.length >= 14) return ATTACHMENT_MIME.BMP;
  if (ascii('%PDF-')) return ATTACHMENT_MIME.PDF;
  if (starts([0x50, 0x4b, 0x03, 0x04]) || starts([0x50, 0x4b, 0x05, 0x06]) || starts([0x50, 0x4b, 0x07, 0x08])) return ATTACHMENT_MIME.ZIP;
  // Fatal decoding rejects binary. A prefix may split a UTF-8 character, so streaming decode omits that partial final character.
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true }); } catch { return ATTACHMENT_FALLBACK_MIME; }
  if (!text || /[\x00-\x08\x0b\x0e-\x1f]/.test(text)) return ATTACHMENT_FALLBACK_MIME;
  const root = text.trimStart().replace(/^(?:<\?xml\b[^?]*\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE\b[^>]*>\s*)+/i, '');
  if (/^<svg(?:\s|\/?>)/i.test(root)) return ATTACHMENT_MIME.SVG;
  if (/^\s*<!doctype\s+html\b/i.test(text) || /^<(?:html|head|body|script|iframe)\b/i.test(root)) return ATTACHMENT_MIME.HTML;
  if (/^\s*<\?xml\b/i.test(text)) return ATTACHMENT_MIME.XML;
  return ATTACHMENT_MIME.TEXT;
}

/** Sandboxes the response as a document and permits nothing; `img-src` only matters for a type rendered as a page. */
export const ATTACHMENT_RESPONSE_CSP = "sandbox; default-src 'none'; img-src 'self' data:";

export const ATTACHMENT_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': ATTACHMENT_RESPONSE_CSP,
});

const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\s*;\s*[a-z0-9!#$&^_.+-]+=(?:[a-z0-9!#$&^_.+-]+|"[^"\r\n]*"))*$/i;

/** The bare lower-case `type/subtype` of a claimed type ('IMAGE/PNG; x=y' -> 'image/png'); '' when it is not a valid media type. */
export function normalizeAttachmentMime(mime: string | undefined | null): string {
  const value = typeof mime === 'string' ? mime.trim() : '';
  if (!value || !MIME_PATTERN.test(value)) return '';
  return value.split(';')[0]!.trim().toLowerCase();
}

export interface AttachmentDelivery {
  /** The Content-Type to send: the claimed type when it is a valid media type, else octet-stream (no header injection, no garbage). */
  contentType: string;
  disposition: AttachmentDisposition;
  /** Headers every attachment response carries, whatever its type. */
  securityHeaders: Readonly<Record<string, string>>;
}

export function resolveAttachmentDelivery(claimedMime: string | undefined | null): AttachmentDelivery {
  const bare = normalizeAttachmentMime(claimedMime);
  return {
    contentType: bare ? String(claimedMime).trim() : ATTACHMENT_FALLBACK_MIME,
    disposition: ATTACHMENT_INLINE_MIME_ALLOWLIST.includes(bare) ? ATTACHMENT_DISPOSITION.INLINE : ATTACHMENT_DISPOSITION.ATTACHMENT,
    securityHeaders: ATTACHMENT_SECURITY_HEADERS,
  };
}

/** RFC 6266 value: an ASCII fallback plus the RFC 5987 UTF-8 form, for any file name. */
export function attachmentContentDisposition(disposition: AttachmentDisposition, filename: string): string {
  const safeFilename = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '\\"');
  const encodedFilename = encodeURIComponent(filename).replace(/'/g, '%27');
  return `${disposition}; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`;
}
