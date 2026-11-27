import anyAscii from 'any-ascii';
import { DEFAULT_PROJECTS_DIR_PREFIX, sanitizeProjectName } from '@shared/sanitize-project-name.js';

const MAX_PROJECT_DIR_SLUG_LENGTH = 64;
const DISAMBIGUATION_SEPARATOR = '--';
const DISAMBIGUATION_HASH_LENGTH = 8;
const MAX_DISAMBIGUATED_PREFIX_LENGTH =
  MAX_PROJECT_DIR_SLUG_LENGTH - DISAMBIGUATION_SEPARATOR.length - DISAMBIGUATION_HASH_LENGTH;
const WINDOWS_RESERVED_NAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// Separate CJK/Hangul script runs from ASCII & Latin-script runs so CJK TitleCase syllables
// (`WoDeXiangMu`) gain `_` separators without splitting Latin words with diacritics (`diseño` -> `diseno`).
const CJK_SCRIPT_RUN_RE = /\p{Script=Han}+|\p{Script=Hiragana}+|\p{Script=Katakana}+|\p{Script=Hangul}+/gu;

/** Deterministic 8-char base36 digest using two independent 32-bit mixers so distinct canonical IDs do not collide. */
function hashCanonicalSlug(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code + ((i + 1) & 0xff);
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  const part1 = (h1 >>> 0).toString(36).padStart(6, '0').slice(-4);
  const part2 = (h2 >>> 0).toString(36).padStart(6, '0').slice(-4);
  return `${part1}${part2}`;
}

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
 * Any lossy transliteration, truncation past 64 chars, or Windows reserved name retains
 * a deterministic `--<hash>` disambiguation suffix derived from `sanitizeProjectName`
 * so distinct projects never silently merge onto the same working directory.
 */
export function transliterateProjectDirSlug(rawProject: string): string {
  const trimmed = rawProject.trim();
  if (!trimmed) return 'proj';

  const canonicalId = sanitizeProjectName(trimmed);
  let slug = transliterateWithBoundaries(trimmed)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/-+/g, '-')
    .replace(/_+/g, '_')
    .replace(/(?:_-|-_)+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');

  if (!slug) {
    slug = canonicalId || 'proj';
  }

  const lossyTransliteration = slug.replace(/-/g, '_') !== canonicalId;
  const truncated = slug.length > MAX_PROJECT_DIR_SLUG_LENGTH;
  const windowsReserved = WINDOWS_RESERVED_NAME_RE.test(slug);

  if (lossyTransliteration || truncated || windowsReserved) {
    const prefix = slug.slice(0, MAX_DISAMBIGUATED_PREFIX_LENGTH).replace(/[_-]+$/g, '') || 'proj';
    return `${prefix}${DISAMBIGUATION_SEPARATOR}${hashCanonicalSlug(canonicalId)}`;
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
