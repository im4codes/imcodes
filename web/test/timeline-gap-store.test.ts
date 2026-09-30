import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TIMELINE_GAP_MAX_AGE_MS,
  TIMELINE_GAP_MAX_ENTRIES,
  __resetTimelineGapsForTests,
  foldPageIntoGap,
  getTimelineGap,
  setTimelineGap,
  subscribeTimelineGap,
} from '../src/timeline/catchup/gap-store.js';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

describe('foldPageIntoGap', () => {
  const full = (pageMinTs: number, pageMaxTs: number, extra: Partial<Parameters<typeof foldPageIntoGap>[1]> = {}) => (
    { lowerTs: 1000, pageMinTs, pageMaxTs, fullPage: true, ...extra }
  );


  it('a payload-incomplete page can neither close a hole nor lower its stitched top past the page', () => {
    const gap = { lowerTs: 1000, upperTs: 9000, createdAt: 1 };
    // short (150 of 200) and trimmed: a normal short page would close the hole
    expect(foldPageIntoGap(gap, full(6000, 9000, { descending: true, fullPage: false, incomplete: true })))
      .toEqual({ lowerTs: 1000, upperTs: 9000 });
    // it reaches the floor by its oldest RETAINED event: still cannot close
    expect(foldPageIntoGap(gap, full(900, 9000, { descending: true, fullPage: false, incomplete: true })))
      .toEqual({ lowerTs: 1000, upperTs: 9000 });
    // the stitched top never rises either (page newest below it)
    expect(foldPageIntoGap(gap, full(6000, 8000, { descending: true, fullPage: false, incomplete: true })))
      .toEqual({ lowerTs: 1000, upperTs: 8000 });
    // an unstitched hole stays unstitched
    expect(foldPageIntoGap({ lowerTs: 1000, upperTs: null, createdAt: 1 }, full(6000, 9000, { fullPage: false, incomplete: true })))
      .toEqual({ lowerTs: 1000, upperTs: null });
  });

  it('an incomplete page that keeps failing (skipIncomplete) is folded as a normal page so the fill still descends', () => {
    const gap = { lowerTs: 1000, upperTs: 9000, createdAt: 1 };
    expect(foldPageIntoGap(gap, full(6000, 9000, { descending: true, fullPage: true, incomplete: true, skipIncomplete: true })))
      .toEqual({ lowerTs: 1000, upperTs: 6000 });
  });

  it('an incomplete short first page still proves a hole (it counts as a full window)', () => {
    expect(foldPageIntoGap(null, full(5000, 9000, { fullPage: false, incomplete: true }))).toEqual({ lowerTs: 1000, upperTs: 5000 });
    expect(foldPageIntoGap(null, full(900, 9000, { fullPage: false, incomplete: true }))).toBeNull();
  });
  it('a full newest-window page whose oldest event is above the floor proves a hole (floor, oldest]', () => {
    expect(foldPageIntoGap(null, full(5000, 9000))).toEqual({ lowerTs: 1000, upperTs: 5000 });
  });

  it('a short page, or one that reaches the floor, proves there is no hole', () => {
    expect(foldPageIntoGap(null, full(5000, 9000, { fullPage: false }))).toBeNull();
    expect(foldPageIntoGap(null, full(900, 9000))).toBeNull();
    expect(foldPageIntoGap(null, full(1000, 9000))).toBeNull();
  });

  it('an empty answer changes nothing', () => {
    expect(foldPageIntoGap(null, { lowerTs: 1000, pageMinTs: null, pageMaxTs: null, fullPage: false })).toBeNull();
    const gap = { lowerTs: 1000, upperTs: 5000, createdAt: 1 };
    expect(foldPageIntoGap(gap, { lowerTs: 1000, pageMinTs: null, pageMaxTs: null, fullPage: false })).toEqual({ lowerTs: 1000, upperTs: 5000 });
  });

  it('descending pages lower the stitched top until they reach the floor, then close the hole', () => {
    let gap: ReturnType<typeof foldPageIntoGap> = { lowerTs: 1000, upperTs: 9000 };
    gap = foldPageIntoGap({ ...gap!, createdAt: 1 }, full(7000, 9000, { descending: true }));
    expect(gap).toEqual({ lowerTs: 1000, upperTs: 7000 });
    gap = foldPageIntoGap({ ...gap!, createdAt: 1 }, full(4000, 7000, { descending: true }));
    expect(gap).toEqual({ lowerTs: 1000, upperTs: 4000 });
    expect(foldPageIntoGap({ ...gap!, createdAt: 1 }, full(900, 4000, { descending: true }))).toBeNull();
    // A short page down the hole means the window down to the floor is exhausted.
    expect(foldPageIntoGap({ lowerTs: 1000, upperTs: 4000, createdAt: 1 }, full(2000, 4000, { descending: true, fullPage: false }))).toBeNull();
  });

  it('a page that is not contiguous with the stitched top cannot move it, unless it was fetched for the hole', () => {
    const gap = { lowerTs: 1000, upperTs: 8000, createdAt: 1 };
    expect(foldPageIntoGap(gap, full(2000, 5000))).toEqual({ lowerTs: 1000, upperTs: 8000 });
    expect(foldPageIntoGap(gap, full(2000, 5000, { descending: true }))).toEqual({ lowerTs: 1000, upperTs: 2000 });
  });

  it('a page above the stitched top that reaches down through it lowers the top to its own oldest event', () => {
    expect(foldPageIntoGap({ lowerTs: 1000, upperTs: 8000, createdAt: 1 }, full(6000, 9500))).toEqual({ lowerTs: 1000, upperTs: 6000 });
  });

  it('an unknown top adopts the first page as the top', () => {
    expect(foldPageIntoGap({ lowerTs: 1000, upperTs: null, createdAt: 1 }, full(5000, 9000))).toEqual({ lowerTs: 1000, upperTs: 5000 });
  });
});

describe('timeline gap store', () => {
  beforeEach(() => { __resetTimelineGapsForTests(memoryStorage()); });

  it('records, reads back, notifies subscribers and clears', () => {
    const seen: Array<unknown> = [];
    const unsubscribe = subscribeTimelineGap('srv:a', (gap) => seen.push(gap));
    expect(getTimelineGap('srv:a')).toBeNull();
    setTimelineGap('srv:a', { lowerTs: 10, upperTs: 50 });
    expect(getTimelineGap('srv:a')).toMatchObject({ lowerTs: 10, upperTs: 50 });
    setTimelineGap('srv:a', { lowerTs: 10, upperTs: 50 }); // unchanged: no notification
    setTimelineGap('srv:a', { lowerTs: 10, upperTs: 30 });
    setTimelineGap('srv:a', null);
    expect(getTimelineGap('srv:a')).toBeNull();
    expect(seen).toEqual([
      expect.objectContaining({ lowerTs: 10, upperTs: 50 }),
      expect.objectContaining({ lowerTs: 10, upperTs: 30 }),
      null,
    ]);
    unsubscribe();
    setTimelineGap('srv:a', { lowerTs: 1, upperTs: 5 });
    expect(seen).toHaveLength(3);
  });

  it('survives a reload: the persisted record is read back by a fresh module state', () => {
    const storage = memoryStorage();
    __resetTimelineGapsForTests(storage);
    setTimelineGap('srv:a', { lowerTs: 10, upperTs: 50 });
    __resetTimelineGapsForTests(storage);
    // reset wipes what a test left behind; put the record back to model "the page was closed and reopened"
    storage.setItem('imcodes.timelineGaps.v1', JSON.stringify({ 'srv:a': { lowerTs: 10, upperTs: 50, createdAt: Date.now() } }));
    __resetTimelineGapsForTests(undefined);
    __resetTimelineGapsForTests(storage);
    storage.setItem('imcodes.timelineGaps.v1', JSON.stringify({ 'srv:a': { lowerTs: 10, upperTs: 50, createdAt: Date.now() } }));
    expect(getTimelineGap('srv:a')).toMatchObject({ lowerTs: 10, upperTs: 50 });
  });

  it('drops records that are expired, malformed, or already closed', () => {
    const now = Date.now();
    const storage = memoryStorage();
    __resetTimelineGapsForTests(storage);
    storage.setItem('imcodes.timelineGaps.v1', JSON.stringify({
      old: { lowerTs: 1, upperTs: 5, createdAt: now - TIMELINE_GAP_MAX_AGE_MS - 1 },
      bad: { lowerTs: 'x', upperTs: 5 },
      closed: { lowerTs: 10, upperTs: 10, createdAt: now },
      ok: { lowerTs: 10, upperTs: 20, createdAt: now },
    }));
    expect(getTimelineGap('old')).toBeNull();
    expect(getTimelineGap('bad')).toBeNull();
    expect(getTimelineGap('closed')).toBeNull();
    expect(getTimelineGap('ok')).toMatchObject({ lowerTs: 10, upperTs: 20 });
  });

  it('an unreadable record is treated as no holes known', () => {
    const storage = memoryStorage();
    __resetTimelineGapsForTests(storage);
    storage.setItem('imcodes.timelineGaps.v1', '{not json');
    expect(getTimelineGap('anything')).toBeNull();
  });

  it('is bounded: the oldest records are evicted past the entry limit', () => {
    const storage = memoryStorage();
    __resetTimelineGapsForTests(storage);
    const base = Date.now();
    for (let i = 0; i < TIMELINE_GAP_MAX_ENTRIES + 5; i += 1) {
      setTimelineGap(`srv:s${i}`, { lowerTs: 1, upperTs: 10, createdAt: base + i });
    }
    const persisted = JSON.parse(storage.getItem('imcodes.timelineGaps.v1')!) as Record<string, unknown>;
    expect(Object.keys(persisted)).toHaveLength(TIMELINE_GAP_MAX_ENTRIES);
    expect(persisted['srv:s0']).toBeUndefined();
    expect(persisted[`srv:s${TIMELINE_GAP_MAX_ENTRIES + 4}`]).toBeDefined();
  });

  it('keeps working in memory when storage throws (quota / private mode)', () => {
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
    __resetTimelineGapsForTests(throwing);
    expect(() => setTimelineGap('srv:a', { lowerTs: 1, upperTs: 5 })).not.toThrow();
    expect(getTimelineGap('srv:a')).toMatchObject({ lowerTs: 1, upperTs: 5 });
    vi.restoreAllMocks();
  });
});
