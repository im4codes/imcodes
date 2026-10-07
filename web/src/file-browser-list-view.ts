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
/** Container width below which the columns fold into a second line under the name. */
export const FILE_BROWSER_NARROW_MAX_WIDTH_PX = 860;

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
    full: new Intl.DateTimeFormat(usable, { dateStyle: 'medium', timeStyle: 'short' }),
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
