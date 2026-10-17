/**
 * Attachment identifiers are opaque daemon handles, not filesystem paths.
 * Older chat events accidentally persisted the daemon path as `id`; for the
 * upload layout we can recover the stable handle from its parent directory
 * without ever sending that host path to a browser route.
 */
const ATTACHMENT_ID_RE = /^[a-f0-9]+(?:\.[a-z0-9]+)?$/i;

export function isAttachmentId(value: string | undefined | null): value is string {
  return typeof value === 'string' && ATTACHMENT_ID_RE.test(value.trim());
}

export function attachmentDownloadId(id?: string, daemonPath?: string): string | null {
  const candidate = id?.trim();
  if (candidate && !candidate.includes('/') && !candidate.includes('\\') && (!daemonPath || isAttachmentId(candidate))) {
    // Keep legacy/test identifiers intact; the server remains the authority
    // for rejecting malformed handles.  A filesystem path is never accepted.
    return candidate;
  }
  if (!daemonPath?.trim()) return null;
  const segments = daemonPath.split('\\').join('/').split('/').filter(Boolean);
  // Uploaded files live at .../<opaque-id>/<original-name>.  Require the
  // recovered parent to use the daemon's opaque-id grammar.
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const parent = segments[index];
    if (isAttachmentId(parent)) return parent;
  }
  return null;
}

export function attachmentDisplayName(id?: string, originalName?: string, daemonPath?: string): string {
  if (originalName?.trim()) return originalName.trim();
  const path = daemonPath?.split('\\').join('/').split('/').filter(Boolean).pop();
  if (path) return path;
  const candidate = id?.trim();
  if (candidate && !candidate.includes('/') && !candidate.includes('\\')) return candidate;
  return 'attachment';
}

export function isAbsoluteAttachmentPath(path?: string): boolean {
  const value = path?.trim();
  return !!value && (/^\//.test(value) || /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value));
}
