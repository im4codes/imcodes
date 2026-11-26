/**
 * Sanitize a project name into a tmux-safe session name slug.
 * Output is deterministic and restricted to lowercase letters, digits, and underscores.
 * Shared between daemon and web — import from shared/.
 */
function isAsciiLetterOrDigit(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isCombiningMark(ch: string): boolean {
  return /\p{M}/u.test(ch);
}

function appendSeparator(parts: string[]): void {
  if (parts.length === 0 || parts[parts.length - 1] === '_') return;
  parts.push('_');
}

export function sanitizeProjectName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'proj';

  const parts: string[] = [];
  for (const original of trimmed.normalize('NFKD')) {
    if (isCombiningMark(original)) continue;
    const ch = original.toLowerCase();
    const code = ch.codePointAt(0)!;
    if (isAsciiLetterOrDigit(code)) {
      parts.push(ch);
      continue;
    }
    if (/[_\-\s.]/u.test(ch)) {
      appendSeparator(parts);
      continue;
    }
    if (/\p{L}|\p{N}/u.test(ch)) {
      appendSeparator(parts);
      parts.push(`u${code.toString(16)}`);
      appendSeparator(parts);
      continue;
    }
    appendSeparator(parts);
  }

  const slug = parts.join('').replace(/^_+|_+$/g, '').replace(/_+/g, '_');
  return slug || 'proj';
}

export const DEFAULT_PROJECTS_DIR_PREFIX = '~/.imcodes/projects/';

/** Build the default working directory path `~/.imcodes/projects/<slug>` matching the brain session's project slug. */
export function buildDefaultProjectDir(rawProject: string): string {
  const trimmed = rawProject.trim();
  if (!trimmed) return DEFAULT_PROJECTS_DIR_PREFIX;
  return `${DEFAULT_PROJECTS_DIR_PREFIX}${sanitizeProjectName(trimmed)}`;
}
