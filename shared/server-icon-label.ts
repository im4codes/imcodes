/**
 * Short, readable labels for the narrow server icon rail.
 *
 * The rail is ~48 px wide, so a label is at most two short lines. Names are abbreviated so that every server in the CURRENT list
 * gets a different label: a label starts as the most readable abbreviation and a colliding one moves to a longer form, and names
 * that stay identical through every form get an index suffix ("#2"). The full name always remains in the tooltip / aria-label.
 *
 * Pure and deterministic (no Intl.Segmenter, no locale), so the web UI and any other surface share one rule.
 */

/** Display width of one label line, in units: an ordinary letter is 1, a broad capital (W, M, Ж, Щ ...) 1.5, a CJK character or an emoji 2. */
export const SERVER_ICON_LABEL_LINE_UNITS = 5;
export const SERVER_ICON_LABEL_MAX_LINES = 2;
/** Index of the longest abbreviation form (see candidatesOf). */
const SERVER_ICON_LABEL_MAX_LEVEL = 3;
/** Shown when a server has no name at all. */
export const SERVER_ICON_LABEL_EMPTY = '?';
/** Prefix of the index suffix that tells apart servers whose names are identical in every abbreviation. */
export const SERVER_ICON_LABEL_INDEX_PREFIX = '#';

export const SERVER_ICON_LABEL_SIZES = Object.freeze({ LARGE: 'lg', MEDIUM: 'md', SMALL: 'sm' } as const);
export type ServerIconLabelSize = (typeof SERVER_ICON_LABEL_SIZES)[keyof typeof SERVER_ICON_LABEL_SIZES];

export interface ServerIconLabel {
  /** One or two lines, each at most SERVER_ICON_LABEL_LINE_UNITS wide (an index suffix may exceed it only past 9999 duplicates). */
  lines: readonly string[];
  /** Font size class for the rail: one short line is large, long or two-line labels are small. */
  size: ServerIconLabelSize;
}

const SEPARATORS = /[\s\-_./:@,;|()[\]{}\\]+/u;
// One user-perceived character: an emoji (with variation selectors, skin tones and ZWJ joins), a flag, or a base plus its combining marks.
const GRAPHEME = /\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic})*|\p{Regional_Indicator}{2}|\P{M}\p{M}*/gu;
const WIDE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF00-\uFF60\uFFE0-\uFFE6])/u;
const BROAD = /^[WM\u00C6\u0152\u03A6\u03A8\u03A9\u0416\u0428\u0429\u042B\u042E\u0424]/u;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u200B-\u200C\u200E-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/gu;

/** Splits text into user-perceived characters without ever cutting a surrogate pair, a ZWJ sequence, a flag or a combining mark apart. */
/** How many units of a rail line the text takes. */
export function serverIconLabelUnits(text: string): number {
  return unitsOf(splitServerIconGraphemes(text));
}

export function splitServerIconGraphemes(text: string): string[] {
  return text.match(GRAPHEME) ?? [];
}

function graphemeUnits(grapheme: string): number {
  if (WIDE.test(grapheme)) return 2;
  return BROAD.test(grapheme) ? 1.5 : 1;
}

function unitsOf(graphemes: readonly string[]): number {
  let total = 0;
  for (const grapheme of graphemes) total += graphemeUnits(grapheme);
  return total;
}

function clipHead(graphemes: readonly string[], maxUnits: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const grapheme of graphemes) {
    const width = graphemeUnits(grapheme);
    if (used + width > maxUnits) break;
    out.push(grapheme);
    used += width;
  }
  return out;
}

function clipTail(graphemes: readonly string[], maxUnits: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (let index = graphemes.length - 1; index >= 0; index -= 1) {
    const width = graphemeUnits(graphemes[index]!);
    if (used + width > maxUnits) break;
    out.unshift(graphemes[index]!);
    used += width;
  }
  return out;
}

/** Fills up to `maxLines` lines of `lineUnits` from the start of the text; what does not fit is dropped. */
function wrap(graphemes: readonly string[], lineUnits: number, maxLines: number): string[][] {
  const lines: string[][] = [];
  let rest = graphemes;
  while (rest.length > 0 && lines.length < maxLines) {
    const line = clipHead(rest, lineUnits);
    // A wide grapheme can never exceed the line width here, but guard against a zero-length clip anyway.
    const taken = line.length > 0 ? line : [rest[0]!];
    lines.push(taken);
    rest = rest.slice(taken.length);
  }
  return lines;
}

interface Parts {
  /** The name, uppercased, split into separator-delimited words (each word split into graphemes). */
  words: string[][];
  /** All words joined without separators. */
  flat: string[];
}

function partsOf(name: string): Parts {
  const cleaned = name.normalize('NFC').replace(CONTROL, '').trim().toUpperCase();
  const words = cleaned.split(SEPARATORS).map(splitServerIconGraphemes).filter((word) => word.length > 0);
  if (words.length === 0) words.push(splitServerIconGraphemes(SERVER_ICON_LABEL_EMPTY));
  return { words, flat: words.flat() };
}

const isDigits = (graphemes: readonly string[]): boolean => graphemes.every((grapheme) => /^\p{Nd}$/u.test(grapheme));

/**
 * The abbreviations of one name, most readable first (the list is as long as MAX_LEVEL + 1):
 * 0. first and last word ("vm-124" -> VM / 124, "pro.koca.win" -> PRO / WIN);
 * 1. first and second word, for names of three or more words ("mac-studio-pro" -> MAC / STUDI);
 * 2. the start of the whole name, wrapped over the lines;
 * 3. the start and the end of the whole name.
 * A form that does not apply to a name repeats the previous one, so a collision just moves on to the next.
 */
function candidatesOf(name: string): string[][][] {
  const { words, flat } = partsOf(name);
  const unitsPerLine = SERVER_ICON_LABEL_LINE_UNITS;
  const fitsInLines = unitsOf(flat) <= unitsPerLine * SERVER_ICON_LABEL_MAX_LINES;
  const level0 = words.length >= 2
    ? [
      clipHead(words[0]!, unitsPerLine),
      // A trailing number is what tells machines apart, so keep its END.
      isDigits(words[words.length - 1]!) ? clipTail(words[words.length - 1]!, unitsPerLine) : clipHead(words[words.length - 1]!, unitsPerLine),
    ]
    : wrap(flat, unitsPerLine, SERVER_ICON_LABEL_MAX_LINES);
  const level1 = words.length >= 3 ? [clipHead(words[0]!, unitsPerLine), clipHead(words[1]!, unitsPerLine)] : level0;
  const level2 = wrap(flat, unitsPerLine, SERVER_ICON_LABEL_MAX_LINES);
  const level3 = fitsInLines ? level2 : [clipHead(flat, unitsPerLine), clipTail(flat, unitsPerLine)];
  return [level0, level1, level2, level3];
}

const keyOf = (lines: readonly (readonly string[])[]): string => lines.map((line) => line.join('')).join('\n');

function sizeOf(lines: readonly string[]): ServerIconLabelSize {
  if (lines.length > 1) return SERVER_ICON_LABEL_SIZES.SMALL;
  const units = unitsOf(splitServerIconGraphemes(lines[0] ?? ''));
  if (units <= 2) return SERVER_ICON_LABEL_SIZES.LARGE;
  return units <= 3 ? SERVER_ICON_LABEL_SIZES.MEDIUM : SERVER_ICON_LABEL_SIZES.SMALL;
}

function withIndexSuffix(lines: readonly string[], index: number): string[] {
  const suffix = `${SERVER_ICON_LABEL_INDEX_PREFIX}${index}`;
  if (lines.length < 2) return [lines[0] ?? '', suffix];
  const room = Math.max(0, SERVER_ICON_LABEL_LINE_UNITS - unitsOf(splitServerIconGraphemes(suffix)));
  return [lines[0]!, clipHead(splitServerIconGraphemes(lines[1]!), room).join('') + suffix];
}

/**
 * One label per name, in the same order. Labels are unique across the list; a label can change when another server is added or
 * renamed (that is what keeps the rest unique).
 */
export function buildServerIconLabels(names: readonly string[]): ServerIconLabel[] {
  const all = names.map((name) => candidatesOf(typeof name === 'string' ? name : ''));
  const maxLevel = SERVER_ICON_LABEL_MAX_LEVEL;
  const level = names.map(() => 0);
  // A label that collides moves to its next, longer form; repeat until nothing collides or nothing can grow.
  for (let guard = 0; guard <= maxLevel + 1; guard += 1) {
    const owners = new Map<string, number[]>();
    all.forEach((candidates, index) => {
      const key = keyOf(candidates[level[index]!]!);
      owners.set(key, [...(owners.get(key) ?? []), index]);
    });
    let changed = false;
    for (const indexes of owners.values()) {
      if (indexes.length < 2) continue;
      for (const index of indexes) {
        if (level[index]! < maxLevel) { level[index] = level[index]! + 1; changed = true; }
      }
    }
    if (!changed) break;
  }
  const lines = all.map((candidates, index) => candidates[level[index]!]!.map((line) => line.join('')));
  // What still collides is identical in every form (the same name, or names that differ only in separators / case): index them.
  const owners = new Map<string, number[]>();
  lines.forEach((entry, index) => {
    const key = entry.join('\n');
    owners.set(key, [...(owners.get(key) ?? []), index]);
  });
  const used = new Set(lines.map((entry) => entry.join('\n')));
  for (const indexes of owners.values()) {
    if (indexes.length < 2) continue;
    let counter = 0;
    for (const index of indexes) {
      let candidate: string[];
      do {
        counter += 1;
        candidate = withIndexSuffix(lines[index]!, counter);
      } while (used.has(candidate.join('\n')));
      used.add(candidate.join('\n'));
      lines[index] = candidate;
    }
  }
  return lines.map((entry) => ({ lines: entry, size: sizeOf(entry) }));
}
