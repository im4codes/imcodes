import {
  ATTACHMENT_FALLBACK_MIME,
  ATTACHMENT_INLINE_MIME_ALLOWLIST,
  normalizeAttachmentMime,
} from '@shared/attachment-delivery.js';
import { saveBlobViaDownloadAnchor } from './browser-download.js';

/**
 * Opening a downloaded attachment WITHOUT ever rendering it as a document on the app origin.
 *
 * The server marks risky types `Content-Disposition: attachment` + `nosniff` + a sandboxing CSP, but those are properties of the HTTP
 * response: turning the body into a `blob:` URL and opening it makes a top-level document that belongs to THIS origin, and a blob typed
 * text/html or image/svg+xml runs its script here. So the response type decides what the browser may be handed:
 *  - a raster image (shared allowlist) is re-wrapped with exactly its bare type and opened, so a raster label cannot carry a document type;
 *  - everything else (SVG, HTML, XML, JS, PDF, unknown, malformed) is saved as a file, as octet-stream, and never opened.
 */
export type AttachmentOpenOutcome = 'opened' | 'saved';

/** `filename*=UTF-8''...` first, then `filename="..."`; null when the header names none. */
export function filenameFromContentDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star?.[1]) {
    try { return decodeURIComponent(star[1].trim()); } catch { /* fall through to the plain form */ }
  }
  const plain = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(header) ?? /filename\s*=\s*([^;]+)/.exec(header);
  return plain?.[1] ? plain[1].replace(/\\(.)/g, '$1').trim() || null : null;
}

function safeSaveName(name: string): string {
  // The anchor's download name is a base name: no separators, no control characters.
  return name.replace(/[\\/\0-\x1f]/g, '_').trim() || 'download';
}

export function openFetchedAttachment(
  blob: Blob,
  response: { contentType: string | null; contentDisposition: string | null },
  fallbackName: string,
  deps: { open?: (url: string) => void; save?: (blob: Blob, name: string) => void; revokeAfterMs?: number } = {},
): AttachmentOpenOutcome {
  const bare = normalizeAttachmentMime(response.contentType ?? blob.type);
  if (ATTACHMENT_INLINE_MIME_ALLOWLIST.includes(bare)) {
    const safe = new Blob([blob], { type: bare });
    const url = URL.createObjectURL(safe);
    (deps.open ?? ((target: string) => { window.open(target, '_blank'); }))(url);
    setTimeout(() => URL.revokeObjectURL(url), deps.revokeAfterMs ?? 60_000);
    return 'opened';
  }
  const name = safeSaveName(filenameFromContentDisposition(response.contentDisposition) ?? fallbackName);
  (deps.save ?? saveBlobViaDownloadAnchor)(new Blob([blob], { type: ATTACHMENT_FALLBACK_MIME }), name);
  return 'saved';
}
