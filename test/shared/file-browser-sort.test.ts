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
  sortFileBrowserEntriesAsync,
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

describe('file browser sort: kind', () => {
  it('groups files of one kind together and orders each group by name', () => {
    const entries = [file('b.pdf'), file('a.png'), file('a.pdf'), file('c.png'), file('notes.weird'), file('Makefile')];
    expect(names(sortFileBrowserEntries(entries, sortBy('kind', 'asc')))).toEqual(['notes.weird', 'Makefile', 'a.pdf', 'b.pdf', 'a.png', 'c.png']);
    expect(names(sortFileBrowserEntries(entries, sortBy('kind', 'desc')))).toEqual(['a.png', 'c.png', 'a.pdf', 'b.pdf', 'Makefile', 'notes.weird']);
  });
  it('is available for any listing, since it needs only the name', () => {
    expect(isFileBrowserSortKeyAvailable([file('a')], FILE_BROWSER_SORT_KEYS.KIND)).toBe(true);
    expect(isFileBrowserSortKeyAvailable([], FILE_BROWSER_SORT_KEYS.KIND)).toBe(true);
  });
  it('keeps directories first by default', () => {
    expect(names(sortFileBrowserEntries([file('a.pdf'), dir('zdir')], sortBy('kind', 'asc')))).toEqual(['zdir', 'a.pdf']);
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

describe('file browser sort and filter at scale', () => {
  const big = (count: number): FileBrowserTreeLike[] => Array.from({ length: count }, (_, index) => file(
    `项目-${(index * 7919) % count}-Report ${index % 13}.${['pdf', 'txt', 'zip', 'png'][index % 4]}`,
    { size: (index * 104_729) % 9_000_000, mtimeMs: 1_700_000_000_000 + ((index * 7919) % count) * 60_000, birthtimeMs: 1_600_000_000_000 + index },
  ));
  // A shared CI runner is noisy in one direction only (a run can be slowed down by a neighbour, never sped up), so the cost of an
  // operation is its FASTEST of several runs, not a mean that one stalled run can inflate.
  const best = (label: string, run: () => unknown, rounds = 7): number => {
    run();
    let fastest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < rounds; i += 1) {
      const started = performance.now();
      run();
      fastest = Math.min(fastest, performance.now() - started);
    }
    console.log(`PERF ${label}: ${fastest.toFixed(1)} ms`);
    return fastest;
  };
  it('sorts and filters 10,000 and 50,000 entries without a visible stall (ceilings with an order of magnitude to spare; growth is counted below)', () => {
    const ten = big(10_000);
    const fifty = big(50_000);
    const sortTen = best('sort 10k by name', () => sortFileBrowserEntries(ten, sortBy('name')));
    best('sort 10k by modified', () => sortFileBrowserEntries(ten, sortBy('modified', 'desc')));
    best('sort 10k by kind', () => sortFileBrowserEntries(ten, sortBy('kind')));
    const filterTen = best('filter+sort 10k (2 words)', () => applyFileBrowserView(ten, parseFileBrowserFilter('report pdf'), sortBy('modified', 'desc'), (n) => n.name));
    const sortFifty = best('sort 50k by name', () => sortFileBrowserEntries(fifty, sortBy('name')));
    best('filter+sort 50k (2 words)', () => applyFileBrowserView(fifty, parseFileBrowserFilter('report pdf'), sortBy('modified', 'desc'), (n) => n.name));
    // Generous ceilings (measured: 40 ms / 5 ms / 290 ms): they catch a per-comparison allocation or a stall of seconds, not machine speed.
    expect(sortTen).toBeLessThan(1_000);
    expect(filterTen).toBeLessThan(1_000);
    expect(sortFifty).toBeLessThan(6_000);
  });

  // Work is COUNTED, never timed. A comparison reads the ordering value of both entries, so a getter on that value counts them, and
  // the filter reads each name once, so a getter on the name counts those. The numbers depend only on the input, so they are the same on
  // every machine, and they grow as n log n for a sound algorithm and as n^2 for a quadratic one. (A wall-clock calibration of a
  // quadratic reference used to be the check here; on two different CI runners it settled near 14 where it was expected above 15.)
  interface Work { reads: number }
  /** Entries with distinct sizes in a scrambled order (7919 is prime, so `index * 7919 % count` is a permutation for these counts). */
  const counted = (count: number, work: Work, options: { countNames?: boolean } = {}): FileBrowserTreeLike[] => Array.from({ length: count }, (_, index) => {
    const name = `item-${index}.${['pdf', 'txt', 'zip', 'png'][index % 4]}`;
    const entry: FileBrowserTreeLike = {
      isDir: false,
      get name() { if (options.countNames) work.reads += 1; return name; },
      get size() { work.reads += 1; return (index * 7919) % count; },
    };
    return entry;
  });
  const opsOf = (count: number, run: (entries: FileBrowserTreeLike[]) => unknown, options: { countNames?: boolean } = {}): { n: number; ops: number } => {
    const work: Work = { reads: 0 };
    run(counted(count, work, options));
    return { n: count, ops: work.reads };
  };
  /** True when the work grew no faster than n log n (with a quarter of slack) between the two sizes: 5x the input is ~5.9x the work, n^2 would be 25x. */
  const growsAsLinearithmicOrBetter = (small: { n: number; ops: number }, large: { n: number; ops: number }): boolean => {
    const inputGrowth = large.n / small.n;
    const logFactor = Math.log(large.n) / Math.log(small.n);
    return large.ops / small.ops <= inputGrowth * logFactor * 1.25;
  };
  const linearOrBetter = (small: { n: number; ops: number }, large: { n: number; ops: number }): boolean =>
    large.ops / small.ops <= (large.n / small.n) * 1.1;

  it('the real sort does n log n work: 5x the entries cost well under the 25x of a quadratic algorithm (counted, not timed)', () => {
    const sort = (entries: FileBrowserTreeLike[]) => sortFileBrowserEntries(entries, sortBy('size'));
    const ten = opsOf(10_000, sort);
    const fifty = opsOf(50_000, sort);
    expect(ten.ops).toBeGreaterThan(10_000); // it did compare (the counting is live)
    expect(growsAsLinearithmicOrBetter(ten, fifty)).toBe(true);
    // and in absolute terms: at most ~1 comparison (2 reads) per n log2 n step
    expect(fifty.ops).toBeLessThanOrEqual(2 * 1.1 * 50_000 * Math.log2(50_000));
  });

  it('the filter reads every name once: work is linear in the entries, and a sort of the survivors on top stays n log n', () => {
    const nothingMatches = (entries: FileBrowserTreeLike[]) => applyFileBrowserView(entries, parseFileBrowserFilter('no-such-name'), sortBy('size'), (n) => n.name);
    const tenNone = opsOf(10_000, nothingMatches, { countNames: true });
    const fiftyNone = opsOf(50_000, nothingMatches, { countNames: true });
    expect(tenNone.ops).toBe(10_000); // exactly one name read per entry, nothing survives to be sorted
    expect(fiftyNone.ops).toBe(50_000);
    expect(linearOrBetter(tenNone, fiftyNone)).toBe(true);
    const aQuarterMatches = (entries: FileBrowserTreeLike[]) => applyFileBrowserView(entries, parseFileBrowserFilter('pdf'), sortBy('size'), (n) => n.name);
    const ten = opsOf(10_000, aQuarterMatches, { countNames: true });
    const fifty = opsOf(50_000, aQuarterMatches, { countNames: true });
    expect(ten.ops).toBeGreaterThan(10_000); // the survivors were compared as well
    expect(growsAsLinearithmicOrBetter(ten, fifty)).toBe(true);
  });

  it('the same check rejects a quadratic algorithm: an insertion sort over the same counted entries (and accepts a correct merge sort)', () => {
    const byInsertion = (entries: FileBrowserTreeLike[]) => {
      const out = entries.slice();
      for (let i = 1; i < out.length; i += 1) {
        const item = out[i]!;
        let j = i - 1;
        while (j >= 0 && compareFileBrowserEntries(out[j]!, item, sortBy('size')) > 0) { out[j + 1] = out[j]!; j -= 1; }
        out[j + 1] = item;
      }
      return out;
    };
    const mergeSort = (entries: FileBrowserTreeLike[]): FileBrowserTreeLike[] => {
      if (entries.length < 2) return entries;
      const middle = entries.length >> 1;
      const left = mergeSort(entries.slice(0, middle));
      const right = mergeSort(entries.slice(middle));
      const out: FileBrowserTreeLike[] = [];
      let l = 0;
      let r = 0;
      while (l < left.length && r < right.length) out.push(compareFileBrowserEntries(left[l]!, right[r]!, sortBy('size')) <= 0 ? left[l++]! : right[r++]!);
      return out.concat(left.slice(l), right.slice(r));
    };
    const insertionSmall = opsOf(800, byInsertion);
    const insertionLarge = opsOf(4_000, byInsertion);
    expect(insertionLarge.ops / insertionSmall.ops).toBeGreaterThan(20); // ~25x for 5x the input: the algorithm really is quadratic
    expect(growsAsLinearithmicOrBetter(insertionSmall, insertionLarge)).toBe(false); // ...and the check says so
    expect(growsAsLinearithmicOrBetter(opsOf(2_000, mergeSort), opsOf(10_000, mergeSort))).toBe(true);
  });
});

describe('file browser sort without holding the thread', () => {
  const entries = (count: number): FileBrowserTreeLike[] => Array.from({ length: count }, (_, index) => (index % 11 === 0
    ? dir(`dir-${index % 37}`, { mtimeMs: index % 5 })
    : file(`File-${index % 97}.${['pdf', 'txt', 'zip', 'png', 'weird'][index % 5]}`, { size: index % 13 === 0 ? undefined : index % 29, mtimeMs: index % 53, birthtimeMs: index % 7 === 0 ? undefined : index % 17 })));

  it('gives exactly the order of the synchronous sort for every key, direction and folders-first setting, ties included', async () => {
    const input = entries(1_000);
    const identities = new Map(input.map((entry, index) => [entry, index]));
    for (const key of ['name', 'modified', 'created', 'size', 'kind'] as const) {
      for (const direction of ['asc', 'desc'] as const) {
        for (const dirsFirst of [true, false]) {
          const sort = sortBy(key, direction, dirsFirst);
          const expected = sortFileBrowserEntries(input, sort).map((entry) => identities.get(entry));
          // A slice of 64 forces many slices and several merge passes.
          const actual = (await sortFileBrowserEntriesAsync(input, sort, async () => {}, 64)).map((entry) => identities.get(entry));
          expect(actual, `${key} ${direction} dirsFirst=${dirsFirst}`).toEqual(expected);
        }
      }
    }
  });

  it('yields to the event loop many times for a big listing, never for a small one, and does not mutate its input', async () => {
    let yields = 0;
    const input = entries(50_000);
    const snapshot = input.slice(0, 50);
    const sorted = await sortFileBrowserEntriesAsync(input, sortBy('modified', 'desc'), async () => { yields += 1; });
    expect(sorted).toHaveLength(50_000);
    expect(yields).toBeGreaterThan(25);
    expect(input.slice(0, 50)).toEqual(snapshot);

    let smallYields = 0;
    await sortFileBrowserEntriesAsync(entries(100), sortBy('name'), async () => { smallYields += 1; });
    expect(smallYields).toBe(0);
  });

  it('a yield between slices lets other work run: a timer scheduled during the sort fires before it ends', async () => {
    const order: string[] = [];
    setTimeout(() => order.push('timer'), 0);
    await sortFileBrowserEntriesAsync(entries(30_000), sortBy('name'), () => new Promise((resolve) => setImmediate(resolve)));
    order.push('sorted');
    expect(order).toEqual(['timer', 'sorted']);
  });
});
