import { fileKindSortKey } from './file-kind.js';

/**
 * Sorting and quick name filtering for the file browser's directory listings.
 *
 * Pure functions only: the browser, the tests and any future consumer share one
 * definition of "sorted" and "matches". Nothing here talks to a daemon or to
 * storage.
 */

export const FILE_BROWSER_SORT_KEYS = {
  NAME: 'name',
  MODIFIED: 'modified',
  CREATED: 'created',
  SIZE: 'size',
  /** By the kind's identity (see fileKindSortKey), so files of one kind are grouped. */
  KIND: 'kind',
} as const;
export type FileBrowserSortKey = (typeof FILE_BROWSER_SORT_KEYS)[keyof typeof FILE_BROWSER_SORT_KEYS];
export const FILE_BROWSER_SORT_KEY_LIST: readonly FileBrowserSortKey[] = Object.values(FILE_BROWSER_SORT_KEYS);

export const FILE_BROWSER_SORT_DIRECTIONS = {
  ASC: 'asc',
  DESC: 'desc',
} as const;
export type FileBrowserSortDirection = (typeof FILE_BROWSER_SORT_DIRECTIONS)[keyof typeof FILE_BROWSER_SORT_DIRECTIONS];

export interface FileBrowserSortState {
  key: FileBrowserSortKey;
  direction: FileBrowserSortDirection;
  /** Directories are listed before files, each group ordered by `key`. */
  dirsFirst: boolean;
}

export const DEFAULT_FILE_BROWSER_SORT: FileBrowserSortState = {
  key: FILE_BROWSER_SORT_KEYS.NAME,
  direction: FILE_BROWSER_SORT_DIRECTIONS.ASC,
  dirsFirst: true,
};

/** Debounce for the filter input; short enough to feel immediate, long enough to skip mid-word recomputation. */
export const FILE_BROWSER_FILTER_DEBOUNCE_MS = 120;
/** A filter query longer than this is truncated: no real file name needs more. */
export const FILE_BROWSER_FILTER_MAX_QUERY_CHARS = 256;

/** What the comparator and the filter read from a listing entry. Every metadata field may be absent. */
export interface FileBrowserSortable {
  name: string;
  isDir: boolean;
  /** Bytes. Absent for directories and for listings that carry no metadata. */
  size?: number;
  /** Last-modified time, epoch milliseconds. */
  mtimeMs?: number;
  /** Creation time, epoch milliseconds. Absent where the platform cannot report it. */
  birthtimeMs?: number;
}

/** A listing entry that may have loaded children (the file browser's tree node). */
export interface FileBrowserTreeLike extends FileBrowserSortable {
  children?: readonly FileBrowserTreeLike[];
}

/** Stored or wire values are untrusted: anything that is not a known value falls back to the default. */
export function normalizeFileBrowserSortState(raw: unknown): FileBrowserSortState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_FILE_BROWSER_SORT };
  const candidate = raw as Partial<Record<keyof FileBrowserSortState, unknown>>;
  const key = FILE_BROWSER_SORT_KEY_LIST.find((known) => known === candidate.key) ?? DEFAULT_FILE_BROWSER_SORT.key;
  const direction = candidate.direction === FILE_BROWSER_SORT_DIRECTIONS.DESC
    ? FILE_BROWSER_SORT_DIRECTIONS.DESC
    : FILE_BROWSER_SORT_DIRECTIONS.ASC;
  const dirsFirst = typeof candidate.dirsFirst === 'boolean' ? candidate.dirsFirst : DEFAULT_FILE_BROWSER_SORT.dirsFirst;
  return { key, direction, dirsFirst };
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The value an entry is ordered by under `key`, or undefined when the entry has none. */
export function fileBrowserSortValue(entry: FileBrowserSortable, key: Exclude<FileBrowserSortKey, 'name' | 'kind'>): number | undefined {
  switch (key) {
    case FILE_BROWSER_SORT_KEYS.MODIFIED: return finiteOrUndefined(entry.mtimeMs);
    case FILE_BROWSER_SORT_KEYS.CREATED: return finiteOrUndefined(entry.birthtimeMs);
    case FILE_BROWSER_SORT_KEYS.SIZE: return entry.isDir ? undefined : finiteOrUndefined(entry.size);
  }
}

/**
 * Whether a listing carries what `key` needs: the name is always there, and a
 * metadata key is usable once at least one entry has its value. An older node
 * or daemon sends none, and the creation time is absent on platforms that
 * cannot report it, so those keys stay unavailable rather than sorting by 0.
 */
export function isFileBrowserSortKeyAvailable(entries: readonly FileBrowserSortable[], key: FileBrowserSortKey): boolean {
  // The kind comes from the name, so it is never missing.
  if (key === FILE_BROWSER_SORT_KEYS.NAME || key === FILE_BROWSER_SORT_KEYS.KIND) return true;
  return entries.some((entry) => fileBrowserSortValue(entry, key) !== undefined);
}

// One collator, one locale. `numeric` gives natural order (file2 < file10);
// `base` sensitivity ignores case and accents. The locale is fixed rather than
// the browser's: a controlled node orders a truncated listing with this very
// function, and the browser orders a complete one, so both must produce the
// same order or the list would reshuffle when it stops being truncated.
let collator: Intl.Collator | null = null;
function nameCollator(): Intl.Collator {
  collator ??= new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  return collator;
}

function compareNames(a: string, b: string): number {
  const natural = nameCollator().compare(a, b);
  if (natural !== 0) return natural;
  // Names the collator treats as equal (case/accent variants) still need one
  // fixed order, or the result would depend on the input order.
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareEntries(
  a: FileBrowserSortable,
  b: FileBrowserSortable,
  sort: FileBrowserSortState,
  kindKeys?: readonly [string, string],
): number {
  if (sort.dirsFirst && a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  const sign = sort.direction === FILE_BROWSER_SORT_DIRECTIONS.DESC ? -1 : 1;
  if (sort.key === FILE_BROWSER_SORT_KEYS.KIND) {
    const byKind = kindKeys
      ? compareNames(kindKeys[0], kindKeys[1])
      : compareNames(fileKindSortKey(a.name, a.isDir), fileKindSortKey(b.name, b.isDir));
    // Equal kinds fall back to the name, ascending, as with the other keys.
    return byKind !== 0 ? sign * byKind : compareNames(a.name, b.name);
  }
  if (sort.key !== FILE_BROWSER_SORT_KEYS.NAME) {
    const left = fileBrowserSortValue(a, sort.key);
    const right = fileBrowserSortValue(b, sort.key);
    // An entry without the value goes last in either direction: a missing
    // timestamp must not read as "oldest" or "smallest".
    if (left === undefined && right !== undefined) return 1;
    if (left !== undefined && right === undefined) return -1;
    if (left !== undefined && right !== undefined && left !== right) return left < right ? -sign : sign;
    // Equal (or both missing): the name decides, always ascending, so a
    // descending size sort does not also reverse the order of equal sizes.
    return compareNames(a.name, b.name);
  }
  return sign * compareNames(a.name, b.name);
}

export function compareFileBrowserEntries(a: FileBrowserSortable, b: FileBrowserSortable, sort: FileBrowserSortState): number {
  return compareEntries(a, b, sort);
}

/** A new array in the requested order. Stable: entries that compare equal keep their input order. */
export function sortFileBrowserEntries<T extends FileBrowserSortable>(entries: readonly T[], sort: FileBrowserSortState): T[] {
  // The kind is worked out once per entry, not once per comparison.
  const byKind = sort.key === FILE_BROWSER_SORT_KEYS.KIND;
  return entries
    .map((entry, index) => ({ entry, index, kind: byKind ? fileKindSortKey(entry.name, entry.isDir) : '' }))
    .sort((a, b) => compareEntries(a.entry, b.entry, sort, [a.kind, b.kind]) || a.index - b.index)
    .map(({ entry }) => entry);
}

/** Entries sorted per slice before the next yield; ~10 ms of comparisons on a slow host. */
export const FILE_BROWSER_ASYNC_SORT_SLICE = 4096;

/**
 * The same order as `sortFileBrowserEntries`, built without holding the thread:
 * sorted slices, then merged pairwise, awaiting `yieldToLoop` between slices and
 * every few thousand merged entries. For a host that must keep serving other
 * traffic while it orders a very large listing (a controlled node ordering
 * 50,000 entries). A single sort of that size blocks for hundreds of ms.
 */
export async function sortFileBrowserEntriesAsync<T extends FileBrowserSortable>(
  entries: readonly T[],
  sort: FileBrowserSortState,
  yieldToLoop: () => Promise<void>,
  sliceSize: number = FILE_BROWSER_ASYNC_SORT_SLICE,
): Promise<T[]> {
  if (entries.length <= sliceSize) return sortFileBrowserEntries(entries, sort);
  const byKind = sort.key === FILE_BROWSER_SORT_KEYS.KIND;
  type Item = { entry: T; index: number; kind: string };
  const compare = (a: Item, b: Item): number => compareEntries(a.entry, b.entry, sort, [a.kind, b.kind]) || a.index - b.index;
  let runs: Item[][] = [];
  for (let start = 0; start < entries.length; start += sliceSize) {
    const slice: Item[] = [];
    for (let index = start; index < Math.min(start + sliceSize, entries.length); index += 1) {
      const entry = entries[index]!;
      slice.push({ entry, index, kind: byKind ? fileKindSortKey(entry.name, entry.isDir) : '' });
    }
    runs.push(slice.sort(compare));
    await yieldToLoop();
  }
  while (runs.length > 1) {
    const merged: Item[][] = [];
    for (let i = 0; i < runs.length; i += 2) {
      const left = runs[i]!;
      const right = runs[i + 1];
      if (!right) { merged.push(left); continue; }
      const out: Item[] = new Array<Item>(left.length + right.length);
      let l = 0;
      let r = 0;
      let o = 0;
      while (l < left.length && r < right.length) {
        out[o++] = compare(left[l]!, right[r]!) <= 0 ? left[l++]! : right[r++]!;
        if ((o & (sliceSize * 2 - 1)) === 0) await yieldToLoop();
      }
      while (l < left.length) out[o++] = left[l++]!;
      while (r < right.length) out[o++] = right[r++]!;
      merged.push(out);
      await yieldToLoop();
    }
    runs = merged;
  }
  return (runs[0] ?? []).map((item) => item.entry);
}

/** The terms of a quick-filter query: NFC-normalized, lower-cased, split on whitespace. Empty means "no filter". */
export function parseFileBrowserFilter(query: string): string[] {
  return query
    .slice(0, FILE_BROWSER_FILTER_MAX_QUERY_CHARS)
    .normalize('NFC')
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
}

/** True when every term is a substring of the name (case-insensitive). */
export function fileBrowserNameMatches(name: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = name.normalize('NFC').toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export interface FileBrowserViewResult<T extends FileBrowserTreeLike> {
  nodes: T[];
  /** Directories that are shown only because something below them matched; the view shows them open. */
  forceExpanded: Set<string>;
}

/**
 * The tree as the filter and the sort show it: filtered first, then ordered,
 * at every loaded level.
 *
 * - A node stays if its name matches or any loaded descendant does.
 * - A directory that matches itself keeps all of its loaded children: someone
 *   who typed a folder's name wants to see what is in it.
 * - A directory kept only for a descendant is reported in `forceExpanded`, so
 *   the match is visible without the user opening every parent.
 * - With no terms nothing is dropped, and nodes are returned as they are
 *   (re-ordered only).
 * `idOf` names a node for `forceExpanded`.
 */
export function applyFileBrowserView<T extends FileBrowserTreeLike>(
  nodes: readonly T[],
  terms: readonly string[],
  sort: FileBrowserSortState,
  idOf: (node: T) => string,
): FileBrowserViewResult<T> {
  const forceExpanded = new Set<string>();
  const visit = (level: readonly T[], filterThisLevel: boolean): T[] => {
    const kept: T[] = [];
    for (const node of level) {
      const selfMatches = !filterThisLevel || fileBrowserNameMatches(node.name, terms);
      const children = node.children as readonly T[] | undefined;
      if (!children || children.length === 0) {
        if (selfMatches) kept.push(node);
        continue;
      }
      // A matching directory shows everything below it; otherwise only matches.
      const shownChildren = visit(children, filterThisLevel && !selfMatches);
      if (!selfMatches && shownChildren.length === 0) continue;
      if (filterThisLevel && !selfMatches) forceExpanded.add(idOf(node));
      kept.push(shownChildren === children || sameOrder(shownChildren, children) ? node : { ...node, children: shownChildren });
    }
    return sortFileBrowserEntries(kept, sort);
  };
  return { nodes: visit(nodes, terms.length > 0), forceExpanded };
}

function sameOrder<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
