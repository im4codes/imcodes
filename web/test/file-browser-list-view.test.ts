import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FILE_BROWSER_SORT, FILE_BROWSER_SORT_KEYS } from '@shared/file-browser-sort.js';
import {
  fileBrowserSortStorageKey,
  fileKindLabel,
  formatFileBrowserDate,
  loadFileBrowserSortPreference,
  saveFileBrowserSortPreference,
  sortStateAfterHeaderClick,
} from '../src/file-browser-list-view.js';

const t = (key: string, options?: Record<string, unknown>) => {
  if (key === 'file_browser.date_relative') return `${String(options?.day)} at ${String(options?.time)}`;
  if (key === 'file_browser.kind.ext') return `${String(options?.ext)} file`;
  return key;
};

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('file browser list view: sort header clicks', () => {
  it('a second click on the sorted column flips its direction and keeps the other options', () => {
    const state = { ...DEFAULT_FILE_BROWSER_SORT, dirsFirst: false };
    const flipped = sortStateAfterHeaderClick(state, FILE_BROWSER_SORT_KEYS.NAME);
    expect(flipped).toEqual({ key: 'name', direction: 'desc', dirsFirst: false });
    expect(sortStateAfterHeaderClick(flipped, FILE_BROWSER_SORT_KEYS.NAME).direction).toBe('asc');
  });
  it('another column starts newest/biggest first for times and size, A to Z for name and kind', () => {
    expect(sortStateAfterHeaderClick(DEFAULT_FILE_BROWSER_SORT, FILE_BROWSER_SORT_KEYS.MODIFIED)).toMatchObject({ key: 'modified', direction: 'desc' });
    expect(sortStateAfterHeaderClick(DEFAULT_FILE_BROWSER_SORT, FILE_BROWSER_SORT_KEYS.CREATED)).toMatchObject({ key: 'created', direction: 'desc' });
    expect(sortStateAfterHeaderClick(DEFAULT_FILE_BROWSER_SORT, FILE_BROWSER_SORT_KEYS.SIZE)).toMatchObject({ key: 'size', direction: 'desc' });
    const fromSize = sortStateAfterHeaderClick(DEFAULT_FILE_BROWSER_SORT, FILE_BROWSER_SORT_KEYS.SIZE);
    expect(sortStateAfterHeaderClick(fromSize, FILE_BROWSER_SORT_KEYS.KIND)).toMatchObject({ key: 'kind', direction: 'asc' });
    expect(sortStateAfterHeaderClick(fromSize, FILE_BROWSER_SORT_KEYS.NAME)).toMatchObject({ key: 'name', direction: 'asc' });
  });
});

describe('file browser list view: remembered sort per machine', () => {
  it('round-trips a choice and keeps machines apart', () => {
    saveFileBrowserSortPreference('srv-a', { key: 'size', direction: 'desc', dirsFirst: false });
    saveFileBrowserSortPreference('srv-b', { key: 'created', direction: 'asc', dirsFirst: true });
    expect(loadFileBrowserSortPreference('srv-a')).toEqual({ key: 'size', direction: 'desc', dirsFirst: false });
    expect(loadFileBrowserSortPreference('srv-b')).toEqual({ key: 'created', direction: 'asc', dirsFirst: true });
    expect(loadFileBrowserSortPreference('srv-c')).toEqual(DEFAULT_FILE_BROWSER_SORT);
    expect(loadFileBrowserSortPreference(undefined)).toEqual(DEFAULT_FILE_BROWSER_SORT);
    expect(fileBrowserSortStorageKey('srv-a')).not.toBe(fileBrowserSortStorageKey('srv-b'));
    expect(fileBrowserSortStorageKey(undefined)).toBe(fileBrowserSortStorageKey(''));
  });
  it('ignores a corrupt stored value', () => {
    window.localStorage.setItem(fileBrowserSortStorageKey('srv-a'), '{not json');
    expect(loadFileBrowserSortPreference('srv-a')).toEqual(DEFAULT_FILE_BROWSER_SORT);
    window.localStorage.setItem(fileBrowserSortStorageKey('srv-a'), JSON.stringify({ key: 'bogus' }));
    expect(loadFileBrowserSortPreference('srv-a')).toEqual(DEFAULT_FILE_BROWSER_SORT);
  });
  it('never throws when storage is blocked or full', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    expect(loadFileBrowserSortPreference('srv-a')).toEqual(DEFAULT_FILE_BROWSER_SORT);
    expect(() => saveFileBrowserSortPreference('srv-a', DEFAULT_FILE_BROWSER_SORT)).not.toThrow();
  });
});

describe('file browser list view: dates', () => {
  // 2026-10-07 18:30 local time.
  const now = new Date(2026, 9, 7, 18, 30).getTime();
  it('says today and yesterday in words with the time', () => {
    const today = formatFileBrowserDate(new Date(2026, 9, 7, 9, 5).getTime(), now, 'en', t);
    expect(today.text).toMatch(/^Today at /);
    expect(today.text).toMatch(/9:05/);
    const yesterday = formatFileBrowserDate(new Date(2026, 9, 6, 23, 59).getTime(), now, 'en', t);
    expect(yesterday.text).toMatch(/^Yesterday at /);
  });
  it('is by calendar day, not 24 hours: 00:10 today is today even though it is 18 hours ago, and 23:50 the day before is yesterday', () => {
    expect(formatFileBrowserDate(new Date(2026, 9, 7, 0, 10).getTime(), now, 'en', t).text).toMatch(/^Today/);
    expect(formatFileBrowserDate(new Date(2026, 9, 6, 23, 50).getTime(), now, 'en', t).text).toMatch(/^Yesterday/);
  });
  it('shows a full local date and time for anything older, or in the future', () => {
    const older = formatFileBrowserDate(new Date(2026, 8, 12, 1, 4).getTime(), now, 'en', t);
    expect(older.text).toMatch(/Sep 12, 2026/);
    expect(older.text).toMatch(/1:04/);
    expect(formatFileBrowserDate(new Date(2027, 0, 5, 12, 0).getTime(), now, 'en', t).text).toMatch(/Jan 5, 2027/);
  });
  it('puts the exact time in the title', () => {
    const { title } = formatFileBrowserDate(new Date(2026, 9, 7, 9, 5, 7).getTime(), now, 'en', t);
    expect(title).toMatch(/October 7, 2026/);
    expect(title).toMatch(/9:05:07/);
  });
  it('formats in the UI language', () => {
    const zh = formatFileBrowserDate(new Date(2026, 8, 12, 1, 4).getTime(), now, 'zh-CN', t);
    expect(zh.text).toMatch(/2026/);
    expect(zh.text).toMatch(/9月/);
    const yesterdayZh = formatFileBrowserDate(new Date(2026, 9, 6, 20, 0).getTime(), now, 'zh-CN', t);
    expect(yesterdayZh.text).toContain('昨天');
  });
  it('survives a language tag the browser does not know', () => {
    expect(() => formatFileBrowserDate(now, now, 'xx-INVALID-tag', t)).not.toThrow();
  });
});

describe('file browser list view: kind labels', () => {
  it('reads a known kind from the locale and builds "<EXT> file" for an unknown extension', () => {
    expect(fileKindLabel({ id: 'pdf' }, t)).toBe('file_browser.kind.pdf');
    expect(fileKindLabel({ id: 'ext', ext: 'WEIRD' }, t)).toBe('WEIRD file');
    expect(fileKindLabel({ id: 'folder' }, t)).toBe('file_browser.kind.folder');
  });
});
