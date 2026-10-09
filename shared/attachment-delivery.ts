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
 * The claimed type is client-supplied for uploads, so it is only ever used to LABEL the download; it never widens what runs inline.
 */

/** Raster image types a browser may render inline. SVG is deliberately absent (it is a document that can carry script). */
export const ATTACHMENT_INLINE_MIME_ALLOWLIST: readonly string[] = Object.freeze([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
]);

export const ATTACHMENT_DISPOSITION = { INLINE: 'inline', ATTACHMENT: 'attachment' } as const;
export type AttachmentDisposition = typeof ATTACHMENT_DISPOSITION[keyof typeof ATTACHMENT_DISPOSITION];

export const ATTACHMENT_FALLBACK_MIME = 'application/octet-stream';

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
