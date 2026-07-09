/**
 * Shared alias insert + compose-time resolution helpers (web).
 *
 * Two responsibilities, both value-secrecy-preserving:
 *  1. {@link insertAliasMarkerAtCaret} — place a `;;(name)` *marker* at the
 *     current composer caret using the same `document.execCommand('insertText')`
 *     path SessionControls uses for pasted text (see SessionControls.tsx:3569),
 *     so undo/redo and surrounding text are preserved. It inserts the marker
 *     only — never the alias value — and never sends.
 *  2. {@link buildResolvedAliases} — a pure function that scans send text for
 *     `;;(name)` markers via `parseAliasMarkers` and produces the out-of-band
 *     name→value map (A′) for markers whose name exists in the alias list.
 *     Unknown markers are skipped and left literal in the text.
 */

import {
  buildAliasMarker,
  parseAliasMarkers,
  type AliasEntry,
  type SendAliasResolution,
} from '@shared/alias-types.js';

/**
 * Insert a `;;(name)` marker at the caret of a focused contenteditable/textarea
 * composer via `execCommand('insertText', ...)`, mirroring SessionControls'
 * caret-preserving paste path. This inserts the marker text only (never the
 * resolved value) and does not send the message.
 *
 * @param name Alias name to reference. The caller is responsible for passing a
 *   valid name; a malformed marker simply won't resolve later (left literal).
 * @returns `true` if the insert command was issued, `false` when unavailable
 *   (e.g. SSR / no `document`), so callers can fall back if needed.
 */
export function insertAliasMarkerAtCaret(name: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
    return false;
  }
  const marker = buildAliasMarker(name);
  return document.execCommand('insertText', false, marker);
}

/**
 * Compute the compose-time alias resolution for `text` against `aliasList`.
 *
 * Pure and side-effect free. Distinct valid marker names (first-occurrence
 * order, per `parseAliasMarkers`) are looked up in `aliasList`; each present
 * name maps to its stored value in the returned `resolvedAliases`. Names not
 * in the list are skipped (their `;;(name)` marker stays literal in `text`).
 *
 * @returns `{ text, resolvedAliases }` — `text` is returned unchanged (markers
 *   are transported alongside the out-of-band map, not expanded here).
 */
export function buildResolvedAliases(
  text: string,
  aliasList: readonly AliasEntry[],
): { text: string; resolvedAliases: SendAliasResolution } {
  const resolvedAliases: SendAliasResolution = {};
  const names = parseAliasMarkers(text);
  if (names.length === 0) return { text, resolvedAliases };

  const byName = new Map<string, string>();
  for (const entry of aliasList) byName.set(entry.name, entry.value);

  for (const name of names) {
    const value = byName.get(name);
    if (value !== undefined) resolvedAliases[name] = value;
  }
  return { text, resolvedAliases };
}
