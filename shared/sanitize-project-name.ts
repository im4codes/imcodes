/**
 * Sanitize a project name into a tmux-safe session name slug.
 * Only lowercase letters and underscores are allowed in the final slug.
 * Shared between daemon and web — import from shared/.
 */
export function sanitizeProjectName(raw: string): string {
  let slug = '';
  for (const ch of raw.trim()) {
    const code = ch.codePointAt(0)!;
    if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      slug += String.fromCodePoint(code);
    } else {
      if (!slug.endsWith('_')) slug += '_';
    }
  }
  slug = slug.replace(/^_+|_+$/g, '').replace(/_+/g, '_').toLowerCase();
  if (!slug) slug = `proj_${Math.random().toString(36).replace(/[^a-z]+/g, '').slice(0, 8) || 'x'}`;
  return slug;
}
