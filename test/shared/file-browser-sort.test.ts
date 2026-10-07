import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILE_BROWSER_SORT,
  FILE_BROWSER_FILTER_MAX_QUERY_CHARS,
  FILE_BROWSER_SORT_DIRECTIONS,
  FILE_BROWSER_SORT_KEYS,
  applyFileBrowserView,
  compareFileBrowserEntries,
  fileBrowserNameMatches,
  isFileBrowserSortKeyAvailable,
  normalizeFileBrowserSortState,
  parseFileBrowserFilter,
  sortFileBrowserEntries,
  type FileBrowserSortState,
  type FileBrowserTreeLike,
} from '../../shared/file-browser-sort.js';

const file = (name: string, extra: Partial<FileBrowserTreeLike> = {}): FileBrowserTreeLike => ({ name, isDir: false, ...extra });
const dir = (name: string, extra: Partial<FileBrowserTreeLike> = {}): FileBrowserTreeLike => ({ name, isDir: true, ...extra });
const names = (list: readonly { name: string }[]) => list.map((e) => e.name);
const sortBy = (key: FileBrowserSortState['key'], direction: FileBrowserSortState['direction'] = 'asc', dirsFirst = true): FileBrowserSortState => ({ key, direction, dirsFirst });

describe('file browser sort: names', () => {
  it('orders naturally and ignores case', () => {
    const sorted = sortFileBrowserEntries([file('file10.txt'), file('File2.txt'), file('file1.txt'), file('Zeta'), file('alpha')], DEFAULT_FILE_BROWSER_SORT);
    expect(names(sorted)).toEqual(['alpha', 'file1.txt', 'File2.txt', 'file10.txt', 'Zeta']);
  });

  it('does not crash on CJK, emoji, empty-ish and very long names, and orders them consistently', () => {
    const entries = [file('日本語.txt'), file('中文文件.md'), file('😀 smile'), file('한국어'), file('a'.repeat(5000)), file('文件10'), file('文件2'), file(' leading'), file('.hidden'), file('no-extension')];
    const once = sortFileBrowserEntries(entries, DEFAULT_FILE_BROWSER_SORT);
    const twice = sortFileBrowserEntries([...entries].reverse(), DEFAULT_FILE_BROWSER_SORT);
    expect(names(once)).toEqual(names(twice));
    expect(names(once).indexOf('文件2')).toBeLessThan(names(once).indexOf('文件10'));
  });

  it('gives names the collator calls equal one fixed order, whatever the input order', () => {
    const a = [file('Report'), file('report'), file('REPORT')];
    expect(names(sortFileBrowserEntries(a, DEFAULT_FILE_BROWSER_SORT))).toEqual(names(sortFileBrowserEntries([...a].reverse(), DEFAULT_FILE_BROWSER_SORT)));
  });

  it('reverses with a descending direction', () => {
    expect(names(sortFileBrowserEntries([file('a'), file('c'), file('b')], sortBy('name', 'desc')))).toEqual(['c', 'b', 'a']);
  });
});

describe('file browser sort: directories first', () => {
  const mixed = [file('a-file'), dir('z-dir'), file('b-file'), dir('m-dir')];
  it('lists directories first by default, each group by the key', () => {
    expect(names(sortFileBrowserEntries(mixed, DEFAULT_FILE_BROWSER_SORT))).toEqual(['m-dir', 'z-dir', 'a-file', 'b-file']);
  });
  it('keeps directories first when the direction is descending', () => {
    expect(names(sortFileBrowserEntries(mixed, sortBy('name', 'desc')))).toEqual(['z-dir', 'm-dir', 'b-file', 'a-file']);
  });
  it('mixes them when the option is off', () => {
    expect(names(sortFileBrowserEntries(mixed, sortBy('name', 'asc', false)))).toEqual(['a-file', 'b-file', 'm-dir', 'z-dir']);
  });
});

describe('file browser sort: metadata keys', () => {
  const entries = [
    file('old', { mtimeMs: 1_000, birthtimeMs: 500, size: 30 }),
    file('new', { mtimeMs: 9_000, birthtimeMs: 8_000, size: 10 }),
    file('mid', { mtimeMs: 5_000, birthtimeMs: 100, size: 20 }),
  ];
  it('sorts by real timestamps and byte counts, in both directions', () => {
    expect(names(sortFileBrowserEntries(entries, sortBy('modified', 'asc')))).toEqual(['old', 'mid', 'new']);
    expect(names(sortFileBrowserEntries(entries, sortBy('modified', 'desc')))).toEqual(['new', 'mid', 'old']);
    expect(names(sortFileBrowserEntries(entries, sortBy('created', 'desc')))).toEqual(['new', 'old', 'mid']);
    expect(names(sortFileBrowserEntries(entries, sortBy('size', 'asc')))).toEqual(['new', 'mid', 'old']);
    expect(names(sortFileBrowserEntries(entries, sortBy('size', 'desc')))).toEqual(['old', 'mid', 'new']);
  });
  it('compares numbers numerically (size 9 < size 10)', () => {
    expect(names(sortFileBrowserEntries([file('b', { size: 10 }), file('a', { size: 9 })], sortBy('size', 'asc')))).toEqual(['a', 'b']);
  });
  it('puts an entry without the value last in either direction, never as 0 or NaN', () => {
    const withGaps = [file('none'), file('has', { mtimeMs: 5 }), file('nan', { mtimeMs: Number.NaN }), file('inf', { mtimeMs: Number.POSITIVE_INFINITY }), file('zero', { mtimeMs: 0 })];
    expect(names(sortFileBrowserEntries(withGaps, sortBy('modified', 'asc')))).toEqual(['zero', 'has', 'inf', 'nan', 'none']);
    expect(names(sortFileBrowserEntries(withGaps, sortBy('modified', 'desc')))).toEqual(['has', 'zero', 'inf', 'nan', 'none']);
  });
  it('is stable: equal values keep a fixed order whatever the input order or direction', () => {
    const ties = [file('b', { size: 5 }), file('a', { size: 5 }), file('c', { size: 5 })];
    expect(names(sortFileBrowserEntries(ties, sortBy('size', 'asc')))).toEqual(['a', 'b', 'c']);
    expect(names(sortFileBrowserEntries([...ties].reverse(), sortBy('size', 'desc')))).toEqual(['a', 'b', 'c']);
  });
  it('treats a directory as having no size, so it never sorts by a fake 0', () => {
    expect(names(sortFileBrowserEntries([dir('d', { size: 4096 }), file('f', { size: 1 })], sortBy('size', 'asc', false)))).toEqual(['f', 'd']);
  });
  it('does not mutate its input', () => {
    const input = [file('b'), file('a')];
    sortFileBrowserEntries(input, DEFAULT_FILE_BROWSER_SORT);
    expect(names(input)).toEqual(['b', 'a']);
  });
  it('compareFileBrowserEntries is antisymmetric', () => {
    const a = file('a', { mtimeMs: 1 });
    const b = file('b', { mtimeMs: 2 });
    const s = sortBy('modified', 'desc');
    expect(Math.sign(compareFileBrowserEntries(a, b, s))).toBe(-Math.sign(compareFileBrowserEntries(b, a, s)));
  });
});

describe('file browser sort: availability and stored state', () => {
  it('a metadata key is unavailable when no entry carries it, the name key always is', () => {
    const plain = [file('a'), file('b')];
    expect(isFileBrowserSortKeyAvailable(plain, FILE_BROWSER_SORT_KEYS.NAME)).toBe(true);
    expect(isFileBrowserSortKeyAvailable(plain, FILE_BROWSER_SORT_KEYS.MODIFIED)).toBe(false);
    expect(isFileBrowserSortKeyAvailable(plain, FILE_BROWSER_SORT_KEYS.SIZE)).toBe(false);
    expect(isFileBrowserSortKeyAvailable([file('a', { mtimeMs: 1 })], FILE_BROWSER_SORT_KEYS.MODIFIED)).toBe(true);
    expect(isFileBrowserSortKeyAvailable([file('a', { mtimeMs: 1 })], FILE_BROWSER_SORT_KEYS.CREATED)).toBe(false);
    expect(isFileBrowserSortKeyAvailable([dir('d', { size: 1 })], FILE_BROWSER_SORT_KEYS.SIZE)).toBe(false);
    expect(isFileBrowserSortKeyAvailable([], FILE_BROWSER_SORT_KEYS.CREATED)).toBe(false);
  });
  it('normalizes untrusted stored values to a valid state', () => {
    expect(normalizeFileBrowserSortState(null)).toEqual(DEFAULT_FILE_BROWSER_SORT);
    expect(normalizeFileBrowserSortState('x')).toEqual(DEFAULT_FILE_BROWSER_SORT);
    expect(normalizeFileBrowserSortState({ key: 'bogus', direction: 'sideways', dirsFirst: 'yes' })).toEqual(DEFAULT_FILE_BROWSER_SORT);
    expect(normalizeFileBrowserSortState({ key: 'size', direction: FILE_BROWSER_SORT_DIRECTIONS.DESC, dirsFirst: false })).toEqual({ key: 'size', direction: 'desc', dirsFirst: false });
  });
});

describe('file browser name filter', () => {
  it('splits on whitespace, lower-cases and drops empties', () => {
    expect(parseFileBrowserFilter('  Foo   BAR\tbaz ')).toEqual(['foo', 'bar', 'baz']);
    expect(parseFileBrowserFilter('   ')).toEqual([]);
    expect(parseFileBrowserFilter('')).toEqual([]);
  });
  it('requires every term, case-insensitively, as a substring', () => {
    const terms = parseFileBrowserFilter('rep 2024');
    expect(fileBrowserNameMatches('Report-2024-final.PDF', terms)).toBe(true);
    expect(fileBrowserNameMatches('Report-2023.pdf', terms)).toBe(false);
    expect(fileBrowserNameMatches('anything', [])).toBe(true);
  });
  it('is friendly to CJK and emoji and normalizes composed/decomposed forms', () => {
    expect(fileBrowserNameMatches('项目计划书.docx', parseFileBrowserFilter('计划'))).toBe(true);
    expect(fileBrowserNameMatches('😀 party 🎉.png', parseFileBrowserFilter('🎉'))).toBe(true);
    expect(fileBrowserNameMatches('Café.txt', parseFileBrowserFilter('café'))).toBe(true);
  });
  it('treats regex metacharacters as plain text (substring only)', () => {
    expect(fileBrowserNameMatches('a.b(c)[d]+e', parseFileBrowserFilter('.b(c)[d]+'))).toBe(true);
    expect(fileBrowserNameMatches('axb', parseFileBrowserFilter('a.b'))).toBe(false);
    expect(fileBrowserNameMatches('anything', parseFileBrowserFilter('(a+)+$'))).toBe(false);
  });
  it('caps the query length', () => {
    expect(parseFileBrowserFilter('x'.repeat(FILE_BROWSER_FILTER_MAX_QUERY_CHARS * 4))[0]).toHaveLength(FILE_BROWSER_FILTER_MAX_QUERY_CHARS);
  });
});

describe('file browser view (filter, then sort, over the loaded tree)', () => {
  const tree = (): FileBrowserTreeLike[] => [
    dir('docs', { children: [file('readme.md'), dir('inner', { children: [file('deep-note.txt'), file('other.txt')] })] }),
    dir('src', { children: [] }),
    file('notes.txt'),
    file('zebra.txt'),
  ];
  const id = (n: FileBrowserTreeLike) => n.name;

  it('with no terms drops nothing and only reorders', () => {
    const view = applyFileBrowserView(tree(), [], sortBy('name', 'desc'), id);
    expect(names(view.nodes)).toEqual(['src', 'docs', 'zebra.txt', 'notes.txt']);
    expect(view.forceExpanded.size).toBe(0);
  });
  it('keeps the parents of a deep match and reports them as force-expanded', () => {
    const view = applyFileBrowserView(tree(), parseFileBrowserFilter('deep'), DEFAULT_FILE_BROWSER_SORT, id);
    expect(names(view.nodes)).toEqual(['docs']);
    expect(names(view.nodes[0]!.children!)).toEqual(['inner']);
    expect(names(view.nodes[0]!.children![0]!.children!)).toEqual(['deep-note.txt']);
    expect([...view.forceExpanded].sort()).toEqual(['docs', 'inner']);
  });
  it('a directory that matches by name keeps all its loaded children', () => {
    const view = applyFileBrowserView(tree(), parseFileBrowserFilter('docs'), DEFAULT_FILE_BROWSER_SORT, id);
    expect(names(view.nodes)).toEqual(['docs']);
    expect(names(view.nodes[0]!.children!)).toEqual(['inner', 'readme.md']);
    expect(view.forceExpanded.has('docs')).toBe(false);
  });
  it('an unloaded or empty directory matches only by its own name', () => {
    expect(names(applyFileBrowserView(tree(), parseFileBrowserFilter('src'), DEFAULT_FILE_BROWSER_SORT, id).nodes)).toEqual(['src']);
    expect(applyFileBrowserView(tree(), parseFileBrowserFilter('nothing-matches'), DEFAULT_FILE_BROWSER_SORT, id).nodes).toEqual([]);
  });
  it('filters first and then sorts the survivors', () => {
    const view = applyFileBrowserView([file('b.txt', { size: 1 }), file('a.log', { size: 9 }), file('c.txt', { size: 5 })], parseFileBrowserFilter('.txt'), sortBy('size', 'desc'), id);
    expect(names(view.nodes)).toEqual(['c.txt', 'b.txt']);
  });
  it('does not mutate the tree it is given', () => {
    const original = tree();
    const snapshot = JSON.stringify(original);
    applyFileBrowserView(original, parseFileBrowserFilter('deep'), sortBy('name', 'desc'), id);
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});
