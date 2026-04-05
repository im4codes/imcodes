/**
 * Sanitize a project name into a tmux-safe session name slug.
 * Non-ASCII characters (e.g. Chinese) are converted to hex codepoints.
 * Shared between daemon and web — import from shared/.
 */
export function sanitizeProjectName(raw: string): string {
  let slug = '';
  for (const ch of raw.trim()) {
    const code = ch.codePointAt(0)!;
    if ((code >= 0x30 && code <= 0x39)   // 0-9
      || (code >= 0x41 && code <= 0x5a)  // A-Z
      || (code >= 0x61 && code <= 0x7a)  // a-z
      || code === 0x2d || code === 0x5f || code === 0x2e) { // - _ .
      slug += String.fromCodePoint(code);
    } else if (code > 0x7f) {
      // Non-ASCII → hex codepoint
      slug += (slug.length && !slug.endsWith('-') ? '-' : '') + code.toString(16);
    } else {
      // Other ASCII (spaces, punctuation) → underscore
      if (!slug.endsWith('_')) slug += '_';
    }
  }
  slug = slug.replace(/^[_-]+|[_-]+$/g, '').toLowerCase();
  if (!slug) slug = `proj_${Date.now().toString(36)}`;
  return slug;
}
