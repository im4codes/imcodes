/**
 * Inline `^` machine-reference trigger for the composer, mirroring the alias `;`
 * trigger (`matchInlineAliasTrigger`). A lone `^` at a word boundary opens the
 * machine picker; the captured query filters it. Independent of `;` (alias) and
 * `@` (mention).
 */
import { MACHINE_REF_NAME_MAX } from '@shared/machine-reference.js';

// Name class mirrors MACHINE_NAME_PATTERN; the length bound is built from the
// shared constant so the cap stays single-source (a regex quantifier cannot
// interpolate a constant literal, so the pattern is composed at module load).
const NAME_CLASS = '[\\p{L}\\p{N}._-]';
// A single `^` at start-or-after-whitespace, then 0..MAX ref_name chars to EOL.
const MACHINE_INLINE_TRIGGER_RE = new RegExp(`(?:^|\\s)\\^(${NAME_CLASS}{0,${MACHINE_REF_NAME_MAX}})$`, 'u');
// Same shape, for stripping the trailing `^query` fragment on insert.
const MACHINE_INLINE_STRIP_RE = new RegExp(`(^|\\s)\\^${NAME_CLASS}{0,${MACHINE_REF_NAME_MAX}}$`, 'u');

/**
 * Return the query after a lone trailing `^` trigger (possibly empty), or null.
 * Rejects a `^^` marker prefix so typing `^^(name)` never opens the picker.
 */
export function matchInlineMachineTrigger(text: string): string | null {
  const m = MACHINE_INLINE_TRIGGER_RE.exec(text);
  if (!m) return null;
  const caretIdx = text.length - 1 - m[1].length; // index of the matched `^`
  if (caretIdx > 0 && text[caretIdx - 1] === '^') return null; // inside a `^^(...)` marker
  return m[1];
}

/** Strip a trailing inline `^query` fragment, keeping the boundary whitespace. */
export function stripInlineMachineTrigger(text: string): string {
  return text.replace(MACHINE_INLINE_STRIP_RE, (_m, lead: string) => lead);
}
