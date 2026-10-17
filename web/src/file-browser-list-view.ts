import {
  DEFAULT_FILE_BROWSER_SORT,
  FILE_BROWSER_SORT_DIRECTIONS,
  FILE_BROWSER_SORT_KEYS,
  normalizeFileBrowserSortState,
  type FileBrowserSortKey,
  type FileBrowserSortState,
} from '@shared/file-browser-sort.js';
import { FILE_KIND_IDS, type FileKind } from '@shared/file-kind.js';
import { safeLocalStorageSetItem } from './local-storage-quota.js';

/** Where the list view's sort choice is kept: one entry per machine (the server id), `local` when there is none. */
export const FILE_BROWSER_SORT_STORAGE_PREFIX = 'rcc_fb_sort_v1';
/** Where the hidden-column choice is kept: also one entry per machine. */
export const FILE_BROWSER_COLUMNS_STORAGE_PREFIX = 'rcc_fb_cols_v1';

/**
 * The table's columns, left to right. The list is ALWAYS a table: when the container is narrower than the columns need it scrolls
 * sideways (header pinned on top), it never folds the cells into a line under the name.
 */
export const FILE_BROWSER_COLUMN_KEYS: readonly FileBrowserSortKey[] = [
  FILE_BROWSER_SORT_KEYS.NAME,
  FILE_BROWSER_SORT_KEYS.SIZE,
  FILE_BROWSER_SORT_KEYS.KIND,
  FILE_BROWSER_SORT_KEYS.MODIFIED,
  FILE_BROWSER_SORT_KEYS.CREATED,
];
/** The columns a person may hide (the name column never goes). */
export const FILE_BROWSER_HIDEABLE_COLUMNS: readonly FileBrowserSortKey[] = FILE_BROWSER_COLUMN_KEYS.slice(1);
/** Width of each fixed column (CSS px), including its padding. The name column takes what is left, and never less than the minimum. */
export const FILE_BROWSER_COLUMN_WIDTH_PX: Readonly<Record<string, number>> = Object.freeze({
  [FILE_BROWSER_SORT_KEYS.SIZE]: 76,
  [FILE_BROWSER_SORT_KEYS.KIND]: 124,
  [FILE_BROWSER_SORT_KEYS.MODIFIED]: 140,
  [FILE_BROWSER_SORT_KEYS.CREATED]: 140,
});
export const FILE_BROWSER_NAME_MIN_WIDTH_PX = 200;
/** Left and right padding of a row plus the gaps between its cells. */
const FILE_BROWSER_ROW_CHROME_PX = 16;
const FILE_BROWSER_CELL_GAP_PX = 4;

/** Indent per nesting level of a row (CSS px); the row component pads by this too. */
export const FILE_BROWSER_INDENT_PX = 16;
/** Depth up to which the name column's minimum already absorbs the indent (expander + icon + a readable name still fit). */
const FILE_BROWSER_ABSORBED_DEPTH = 2;

/** Depth of the deepest row on screen (the root is 0, its children 1). `children` and `expanded` are the tree's own accessors. */
export function fileBrowserMaxVisibleDepth<T>(
  roots: readonly T[],
  children: (node: T) => readonly T[] | undefined,
  expanded: (node: T) => boolean,
  isShown: (node: T) => boolean = () => true,
): number {
  let deepest = 0;
  const walk = (nodes: readonly T[], depth: number) => {
    for (const node of nodes) {
      if (!isShown(node)) continue;
      if (depth > deepest) deepest = depth;
      const kids = children(node);
      if (kids && kids.length > 0 && expanded(node)) walk(kids, depth + 1);
    }
  };
  walk(roots, 0);
  return deepest;
}

/**
 * The narrowest the table can be without squeezing the name below its minimum: below this the container scrolls sideways.
 * Header and rows share this width, so deeper nesting widens both and the columns stay aligned.
 */
export function fileBrowserTableMinWidth(visible: ReadonlySet<FileBrowserSortKey>, maxDepth = 0): number {
  let width = FILE_BROWSER_ROW_CHROME_PX + FILE_BROWSER_NAME_MIN_WIDTH_PX
    + FILE_BROWSER_INDENT_PX * Math.max(0, maxDepth - FILE_BROWSER_ABSORBED_DEPTH);
  for (const key of FILE_BROWSER_HIDEABLE_COLUMNS) {
    if (visible.has(key)) width += (FILE_BROWSER_COLUMN_WIDTH_PX[key] ?? 0) + FILE_BROWSER_CELL_GAP_PX;
  }
  return width;
}

export function fileBrowserColumnsStorageKey(serverId?: string): string {
  return `${FILE_BROWSER_COLUMNS_STORAGE_PREFIX}:${serverId || 'local'}`;
}

/** The columns this machine's person chose to hide (none by default); a corrupt or blocked store reads as "none hidden". */
export function loadFileBrowserHiddenColumns(serverId?: string): ReadonlySet<FileBrowserSortKey> {
  try {
    const raw = window.localStorage.getItem(fileBrowserColumnsStorageKey(serverId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? FILE_BROWSER_HIDEABLE_COLUMNS.filter((key) => parsed.includes(key)) : []);
  } catch {
    return new Set();
  }
}

export function saveFileBrowserHiddenColumns(serverId: string | undefined, hidden: ReadonlySet<FileBrowserSortKey>): void {
  try {
    const key = fileBrowserColumnsStorageKey(serverId);
    if (hidden.size === 0) window.localStorage.removeItem(key);
    else safeLocalStorageSetItem(key, JSON.stringify(FILE_BROWSER_HIDEABLE_COLUMNS.filter((column) => hidden.has(column))));
  } catch { /* storage unavailable */ }
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function fileBrowserSortStorageKey(serverId?: string): string {
  return `${FILE_BROWSER_SORT_STORAGE_PREFIX}:${serverId || 'local'}`;
}

/** The saved choice for this machine, or the default; storage that is blocked or holds junk never throws. */
export function loadFileBrowserSortPreference(serverId?: string): FileBrowserSortState {
  try {
    const raw = window.localStorage.getItem(fileBrowserSortStorageKey(serverId));
    return raw ? normalizeFileBrowserSortState(JSON.parse(raw)) : { ...DEFAULT_FILE_BROWSER_SORT };
  } catch {
    return { ...DEFAULT_FILE_BROWSER_SORT };
  }
}

/** Best effort: a full or disabled storage (quota, private mode) just means the choice is not remembered. */
export function saveFileBrowserSortPreference(serverId: string | undefined, state: FileBrowserSortState): void {
  try {
    safeLocalStorageSetItem(fileBrowserSortStorageKey(serverId), JSON.stringify(state));
  } catch { /* storage unavailable */ }
}

/**
 * What a click on a column header does: the column already sorted by flips
 * direction; another column starts in the direction people expect of it
 * (names and kinds A to Z, sizes and times biggest/newest first).
 */
export function sortStateAfterHeaderClick(current: FileBrowserSortState, key: FileBrowserSortKey): FileBrowserSortState {
  if (current.key === key) {
    return {
      ...current,
      direction: current.direction === FILE_BROWSER_SORT_DIRECTIONS.ASC
        ? FILE_BROWSER_SORT_DIRECTIONS.DESC
        : FILE_BROWSER_SORT_DIRECTIONS.ASC,
    };
  }
  const startsAscending = key === FILE_BROWSER_SORT_KEYS.NAME || key === FILE_BROWSER_SORT_KEYS.KIND;
  return {
    ...current,
    key,
    direction: startsAscending ? FILE_BROWSER_SORT_DIRECTIONS.ASC : FILE_BROWSER_SORT_DIRECTIONS.DESC,
  };
}

/** i18n key of a kind's label (`file_browser.kind.<id>`); an unknown extension reads "<EXT> file". */
export function fileKindLabel(kind: FileKind, t: Translate): string {
  return kind.id === FILE_KIND_IDS.EXT
    ? t('file_browser.kind.ext', { ext: kind.ext })
    : t(`file_browser.kind.${kind.id}`);
}

export interface FormattedFileDate {
  /** What the cell shows: "Yesterday at 6:22 PM", or the full date and time. */
  text: string;
  /** The exact time, for the hover title. */
  title: string;
}

const MS_PER_DAY = 86_400_000;

// One Intl formatter per locale and style, built on first use: a listing
// formats two dates per row, and constructing a formatter is the expensive part.
interface DateFormatters {
  time: Intl.DateTimeFormat;
  title: Intl.DateTimeFormat;
  full: Intl.DateTimeFormat;
  relativeDay: Intl.RelativeTimeFormat;
}
const formatterCache = new Map<string, DateFormatters>();

function formattersFor(locale: string): { formatters: DateFormatters; locale: string } {
  const cached = formatterCache.get(locale);
  if (cached) return { formatters: cached, locale };
  let usable = locale;
  try { Intl.DateTimeFormat.supportedLocalesOf(locale); } catch { usable = 'en'; }
  const formatters: DateFormatters = {
    time: new Intl.DateTimeFormat(usable, { timeStyle: 'short' }),
    title: new Intl.DateTimeFormat(usable, { dateStyle: 'full', timeStyle: 'medium' }),
    // Compact on purpose (a narrow column): 6/14/26, 3:21 PM; the hover title carries the full date and seconds.
    full: new Intl.DateTimeFormat(usable, { dateStyle: 'short', timeStyle: 'short' }),
    relativeDay: new Intl.RelativeTimeFormat(usable, { numeric: 'auto' }),
  };
  formatterCache.set(locale, formatters);
  return { formatters, locale: usable };
}

function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function capitalizeFirst(text: string, locale: string): string {
  return text ? text.charAt(0).toLocaleUpperCase(locale) + text.slice(1) : text;
}

/**
 * A modified/created time as a person reads it: today and yesterday in words
 * plus the time, anything older as a full local date and time. All of it from
 * Intl in the UI language; the wording around the time comes from the locale
 * file (`file_browser.date_relative`).
 */
export function formatFileBrowserDate(ms: number, nowMs: number, locale: string, t: Translate): FormattedFileDate {
  const when = new Date(ms);
  const { formatters, locale: intlLocale } = formattersFor(locale);
  const title = formatters.title.format(when);
  const daysAgo = Math.round((startOfLocalDay(nowMs) - startOfLocalDay(ms)) / MS_PER_DAY);
  if (daysAgo === 0 || daysAgo === 1) {
    const day = formatters.relativeDay.format(-daysAgo, 'day');
    return { text: t('file_browser.date_relative', { day: capitalizeFirst(day, intlLocale), time: formatters.time.format(when) }), title };
  }
  return { text: formatters.full.format(when), title };
}
