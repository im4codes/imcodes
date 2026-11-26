/**
 * Inline `^` (and Chinese IME Shift+6 ellipsis `……`) machine-reference trigger
 * for the composer, mirroring the alias `;` trigger (`matchInlineAliasTrigger`).
 * A lone `^` or `……` (`\u2026\u2026`) at start-of-line or after whitespace
 * opens the machine picker; the captured query filters it. Independent of `;`
 * (alias) and `@` (mention).
 */
import { MACHINE_REF_NAME_MAX } from '@shared/machine-reference.js';

// Name class mirrors MACHINE_NAME_PATTERN; the length bound is built from the
// shared constant so the cap stays single-source (a regex quantifier cannot
// interpolate a constant literal, so the pattern is composed at module load).
const NAME_CLASS = '[\\p{L}\\p{N}._-]';
// Match either ASCII `^` or the two-character Chinese IME Shift+6 ellipsis `……` (\u2026\u2026).
const MACHINE_INLINE_PREFIX = '(?:\\^|\u2026\u2026)';
// Trigger prefix at start-or-after-whitespace, then 0..MAX ref_name chars to EOL.
const MACHINE_INLINE_TRIGGER_RE = new RegExp(`(?:^|\\s)${MACHINE_INLINE_PREFIX}(${NAME_CLASS}{0,${MACHINE_REF_NAME_MAX}})$`, 'u');
// Same shape, for stripping the trailing trigger + query fragment on insert.
const MACHINE_INLINE_STRIP_RE = new RegExp(`(^|\\s)${MACHINE_INLINE_PREFIX}${NAME_CLASS}{0,${MACHINE_REF_NAME_MAX}}$`, 'u');

/**
 * Return the query after a trailing inline `^` or `……` trigger (possibly empty),
 * or null. Word-boundary `(?:^|\s)` and `\u2026` exclusion from `NAME_CLASS`
 * prevent false triggers on mid-word carets, prose ellipses (`等等……`),
 * single backspaced ellipsis (`…`), `^^(...)` markers, and repeated ellipses
 * (`…………` / `………`).
 */
export function matchInlineMachineTrigger(text: string): string | null {
  return MACHINE_INLINE_TRIGGER_RE.exec(text)?.[1] ?? null;
}

/** Strip a trailing inline `^query` or `……query` fragment, keeping the boundary whitespace. */
export function stripInlineMachineTrigger(text: string): string {
  return text.replace(MACHINE_INLINE_STRIP_RE, (_m, lead: string) => lead);
}
