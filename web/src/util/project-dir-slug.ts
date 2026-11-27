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
 * readable, cross-platform ASCII folder slug using underscores (`_`) only.
 * Never appends a random/hash suffix; only increments Windows reserved names safely.
 */
export function transliterateProjectDirSlug(rawProject: string): string {
  const trimmed = rawProject.trim();
  if (!trimmed) return 'proj';

  let slug = transliterateWithBoundaries(trimmed)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!slug) {
    const canonicalFallback = sanitizeProjectName(trimmed)
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
    slug = canonicalFallback || 'proj';
  }

  slug = slug.slice(0, MAX_PROJECT_DIR_SLUG_LENGTH).replace(/_+$/g, '') || 'proj';

  if (WINDOWS_RESERVED_NAME_RE.test(slug)) {
    return `${slug}_1`;
  }

  return slug;
}

/**
 * Resolve a collision-free project directory slug against `existingNames` (case-insensitive).
 * Returns `baseSlug` directly when no collision exists; otherwise appends `_1`, `_2`, `_3`, ...
 * while respecting `<= 64` characters and avoiding double/trailing underscores or `con_1_1`.
 */
export function resolveUniqueProjectDirSlug(
  baseSlug: string,
  existingNames?: Iterable<string> | null,
): string {
  const cleanBase = baseSlug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_PROJECT_DIR_SLUG_LENGTH)
    .replace(/_+$/g, '') || 'proj';

  const existing = new Set<string>();
  if (existingNames) {
    for (const name of existingNames) {
      if (typeof name !== 'string') continue;
      const normalized = name.trim().toLowerCase();
      if (normalized) existing.add(normalized);
    }
  }

  const isDirectReserved = WINDOWS_RESERVED_NAME_RE.test(cleanBase);
  if (!isDirectReserved && !existing.has(cleanBase)) {
    return cleanBase;
  }

  // If `cleanBase` is already `<reserved>_1` (produced by transliterateProjectDirSlug('CON'))
  // and collides, continue numbering (`con_2`, `con_3`, ...) instead of producing `con_1_1`.
  const reservedBaseMatch = cleanBase.endsWith('_1')
    ? cleanBase.slice(0, -2)
    : null;
  const isSuffixedReserved = Boolean(reservedBaseMatch && WINDOWS_RESERVED_NAME_RE.test(reservedBaseMatch));
  const numberingRoot = isSuffixedReserved ? reservedBaseMatch! : cleanBase;
  const startIndex = isDirectReserved ? 1 : (isSuffixedReserved ? 2 : 1);

  for (let n = startIndex; ; n += 1) {
    const suffix = `_${n}`;
    const maxPrefixLen = Math.max(1, MAX_PROJECT_DIR_SLUG_LENGTH - suffix.length);
    const prefix = numberingRoot.slice(0, maxPrefixLen).replace(/_+$/g, '') || 'proj';
    const candidate = `${prefix}${suffix}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
}

/**
 * Build the default New Session working directory path `~/.imcodes/projects/<readable-slug>`
 * without altering `sanitizeProjectName` used for internal session IDs.
 */
export function buildReadableProjectDir(
  rawProject: string,
  existingNames?: Iterable<string> | null,
): string {
  const trimmed = rawProject.trim();
  if (!trimmed) return DEFAULT_PROJECTS_DIR_PREFIX;
  const baseSlug = transliterateProjectDirSlug(trimmed);
  return `${DEFAULT_PROJECTS_DIR_PREFIX}${resolveUniqueProjectDirSlug(baseSlug, existingNames)}`;
}
