import anyAscii from 'any-ascii';
import { DEFAULT_PROJECTS_DIR_PREFIX, sanitizeProjectName } from '@shared/sanitize-project-name.js';

const MAX_PROJECT_DIR_SLUG_LENGTH = 64;
const WINDOWS_RESERVED_NAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// Separate CJK/Hangul script runs from ASCII & Latin-script runs so CJK TitleCase syllables
// (`WoDeXiangMu`) gain `_` separators without splitting Latin words with diacritics (`diseño` -> `diseno`).
const CJK_SCRIPT_RUN_RE = /\p{Script=Han}+|\p{Script=Hiragana}+|\p{Script=Katakana}+|\p{Script=Hangul}+/gu;

function transliterateWithBoundaries(raw: string): string {
  const tokens: string[] = [];
  let cursor = 0;
  CJK_SCRIPT_RUN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CJK_SCRIPT_RUN_RE.exec(raw)) !== null) {
    if (match.index > cursor) {
      tokens.push(anyAscii(raw.slice(cursor, match.index)));
    }
    const ascii = anyAscii(match[0]);
    if (ascii) {
      const splitSyllables = ascii
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');
      tokens.push(splitSyllables);
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < raw.length) {
    tokens.push(anyAscii(raw.slice(cursor)));
  }
  return tokens.filter(Boolean).join('_');
}

/**
 * Convert a human project name (across all supported Unicode scripts) into a clean,
 * readable, cross-platform ASCII folder slug safe across POSIX, macOS, and Windows.
 */
export function transliterateProjectDirSlug(rawProject: string): string {
  const trimmed = rawProject.trim();
  if (!trimmed) return 'proj';

  let slug = transliterateWithBoundaries(trimmed)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/-+/g, '-')
    .replace(/_+/g, '_')
    .replace(/(?:_-|-_)+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');

  if (!slug) {
    slug = sanitizeProjectName(trimmed) || 'proj';
  }

  if (slug.length > MAX_PROJECT_DIR_SLUG_LENGTH) {
    slug = slug.slice(0, MAX_PROJECT_DIR_SLUG_LENGTH).replace(/[_-]+$/g, '') || 'proj';
  }

  if (WINDOWS_RESERVED_NAME_RE.test(slug)) {
    slug = `${slug}_proj`;
  }

  return slug;
}

/**
 * Build the default New Session working directory path `~/.imcodes/projects/<readable-slug>`
 * without altering `sanitizeProjectName` used for internal session IDs.
 */
export function buildReadableProjectDir(rawProject: string): string {
  const trimmed = rawProject.trim();
  if (!trimmed) return DEFAULT_PROJECTS_DIR_PREFIX;
  return `${DEFAULT_PROJECTS_DIR_PREFIX}${transliterateProjectDirSlug(trimmed)}`;
}
