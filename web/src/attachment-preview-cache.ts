/**
 * Local previews for composer attachments.
 *
 * The composer only keeps `{ path, name, seq, id, serverId }` per attachment, so
 * once a file is uploaded there is nothing to show for it. While the original
 * `File` is still in hand we keep an object URL for it, which makes the preview
 * instant and independent of the network. Attachments restored from a saved
 * draft (after a reload) have no entry here and fall back to the authenticated
 * download URL.
 */

const IMAGE_NAME_PATTERN = /\.(png|jpe?g|gif|webp|bmp|avif|heic|heif|svg)$/i;
/** Enough for any realistic draft; the oldest URLs are revoked past this. */
const MAX_CACHED_PREVIEWS = 40;

const previews = new Map<string, string>();

export function isPreviewableImageName(name: string): boolean {
  return IMAGE_NAME_PATTERN.test(name.trim());
}

/** Remember a preview for an uploaded file, keyed by its daemon path. */
export function rememberAttachmentPreview(path: string, file: Blob & { name?: string; type?: string }): void {
  const looksLikeImage = (file.type ?? '').startsWith('image/') || isPreviewableImageName(file.name ?? '');
  if (!looksLikeImage || typeof URL.createObjectURL !== 'function') return;
  forgetAttachmentPreview(path);
  previews.set(path, URL.createObjectURL(file));
  while (previews.size > MAX_CACHED_PREVIEWS) {
    const oldest = previews.keys().next().value;
    if (oldest === undefined) break;
    forgetAttachmentPreview(oldest);
  }
}

export function getAttachmentPreview(path: string): string | undefined {
  return previews.get(path);
}

export function forgetAttachmentPreview(path: string): void {
  const url = previews.get(path);
  if (url === undefined) return;
  previews.delete(path);
  try { URL.revokeObjectURL(url); } catch { /* already gone */ }
}
