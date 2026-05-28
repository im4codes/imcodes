import { describe, it, expect, vi } from 'vitest';
import {
  runNewestWindowBackfill,
  CATCHUP_TAIL_MAX_PAGES,
  type BackfillPage,
} from '../src/timeline/catchup/backfill-pager.js';

/**
 * Tier-0 newest-first WINDOW pager contract (run 1a380d8a-d04).
 *
 * The daemon serves history as the NEWEST `limit` of `(afterTs, beforeTs]`
 * (ORDER BY ts DESC). The pager therefore holds the LOWER bound (`afterTs`)
 * fixed for the whole round and walks the UPPER bound (`beforeTs`) DOWN by each
 * page's min `ts`. Continuation is driven by COUNT truncation
 * (`events.length >= limit`), NOT the wire `hasMore` (= payload drop).
 *
 * Pure function: inject fetch + merge, assert terminal/page/cursor behavior.
 */
describe('runNewestWindowBackfill (Tier-0 newest-first window)', () => {
  // Helper merge: count events, report min/max ts (events are {ts}).
  const countingMerge = (events: unknown[]) => {
    const evs = events as Array<{ ts: number }>;
    let minTs = Infinity;
    let maxTs = -Infinity;
    for (const e of evs) {
      if (e.ts < minTs) minTs = e.ts;
      if (e.ts > maxTs) maxTs = e.ts;
    }
    return {
      candidateCount: evs.length,
      minTs: Number.isFinite(minTs) ? minTs : null,
      maxTs: Number.isFinite(maxTs) ? maxTs : null,
    };
  };

  it('V-W1: walks beforeTs DOWN with a FIXED afterTs, merges every page, ends caught_up on a short page', async () => {
    const pages: BackfillPage[] = [
      { events: [{ ts: 50 }, { ts: 40 }], hasMore: false }, // full (==limit) → continue
      { events: [{ ts: 35 }, { ts: 30 }], hasMore: false }, // full → continue
      { events: [{ ts: 20 }], hasMore: false },             // short (<limit) → caught_up
    ];
    const seenArgs: Array<{ afterTs: number | undefined; beforeTs?: number }> = [];
    let i = 0;
    const merged: number[] = [];
    const outcome = await runNewestWindowBackfill(0, {
      limit: 2,
      fetchPage: async (args) => { seenArgs.push(args); return pages[i++] ?? null; },
      mergePage: (events) => { for (const e of events as Array<{ ts: number }>) merged.push(e.ts); return countingMerge(events); },
    });
    expect(outcome.terminal).toBe('caught_up');
    expect(outcome.pageCount).toBe(3);
    expect(outcome.totalNew).toBe(5);
    // CENTRAL REGRESSION GUARD vs the old forward pager: afterTs is the fixed
    // lower bound on EVERY request (never becomes a page's max ts); only the
    // beforeTs upper bound descends, by each merged page's (minTs + 1).
    expect(seenArgs.map((a) => a.afterTs)).toEqual([0, 0, 0]);
    expect(seenArgs.map((a) => a.beforeTs)).toEqual([undefined, 41, 31]);
    expect(merged).toEqual([50, 40, 35, 30, 20]);
  });

  it('V-W1b: a single short page (incl. empty idle) ends caught_up after one fetch', async () => {
    const empty = await runNewestWindowBackfill(100, {
      limit: 2,
      fetchPage: async () => ({ events: [], hasMore: false }),
      mergePage: countingMerge,
    });
    expect(empty.terminal).toBe('caught_up');
    expect(empty.pageCount).toBe(1);
    expect(empty.totalNew).toBe(0);

    const one = await runNewestWindowBackfill(100, {
      limit: 2,
      fetchPage: async () => ({ events: [{ ts: 200 }], hasMore: false }),
      mergePage: countingMerge,
    });
    expect(one.terminal).toBe('caught_up');
    expect(one.pageCount).toBe(1);
  });

  it('V-W3: COUNT truncation — not wire `hasMore` — drives continuation', async () => {
    // A SHORT page that nonetheless advertises hasMore=true (payload-drop
    // semantics, but here with no actual truncation flags) must STILL end
    // caught_up: the old forward pager would have kept going on hasMore.
    const shortHasMore = await runNewestWindowBackfill(0, {
      limit: 2,
      fetchPage: async () => ({ events: [{ ts: 10 }], hasMore: true }),
      mergePage: countingMerge,
    });
    expect(shortHasMore.terminal).toBe('caught_up');
    expect(shortHasMore.pageCount).toBe(1);

    // The inverse: a FULL page with hasMore=false must CONTINUE (count, not the
    // wire flag, says the window may hold more below).
    const pages: BackfillPage[] = [
      { events: [{ ts: 50 }, { ts: 40 }], hasMore: false }, // full → continue
      { events: [{ ts: 30 }], hasMore: false },             // short → caught_up
    ];
    let i = 0;
    const fullNoMore = await runNewestWindowBackfill(0, {
      limit: 2,
      fetchPage: async () => pages[i++] ?? null,
      mergePage: countingMerge,
    });
    expect(fullNoMore.terminal).toBe('caught_up');
    expect(fullNoMore.pageCount).toBe(2);
  });

  it('V-W2: stops at cap_hit (bounded) when full pages keep descending — no unbounded loop', async () => {
    let fetches = 0;
    let top = 100;
    const outcome = await runNewestWindowBackfill(0, {
      limit: 2,
      // Always a full, strictly-descending page → never short, so it must cap.
      fetchPage: async () => { fetches++; const p = { events: [{ ts: top }, { ts: top - 1 }], hasMore: false } as BackfillPage; top -= 10; return p; },
      mergePage: countingMerge,
    });
    expect(outcome.terminal).toBe('cap_hit');
    expect(outcome.pageCount).toBe(CATCHUP_TAIL_MAX_PAGES);
    expect(fetches).toBe(CATCHUP_TAIL_MAX_PAGES);
  });

  it('V-W2b: stops cap_hit when a full page cannot descend (same-ts cluster ≥ limit) — avoids same-beforeTs loop', async () => {
    let fetches = 0;
    const seenBeforeTs: Array<number | undefined> = [];
    const outcome = await runNewestWindowBackfill(0, {
      limit: 2,
      // Full page, all the SAME ts → minTs never descends past the boundary.
      fetchPage: async ({ beforeTs }) => { fetches++; seenBeforeTs.push(beforeTs); return { events: [{ ts: 50 }, { ts: 50 }], hasMore: false }; },
      mergePage: countingMerge,
    });
    expect(outcome.terminal).toBe('cap_hit');
    // page1 (beforeTs=undefined) descends to 50→ beforeTs=51; page2 sees minTs=50
    // again (no progress) → cap_hit. Must NOT loop against the same window.
    expect(fetches).toBe(2);
    expect(seenBeforeTs).toEqual([undefined, 51]);
  });

  it('truncated page → terminal truncated even if short (must not falsely complete / cool down)', async () => {
    const outcome = await runNewestWindowBackfill(0, {
      limit: 2,
      // length 1 < limit would be "caught_up" by count — but the incomplete
      // check runs FIRST, so payload truncation wins → truncated.
      fetchPage: async () => ({ events: [{ ts: 10 }], hasMore: false, payloadTruncated: true }),
      mergePage: countingMerge,
    });
    expect(outcome.terminal).toBe('truncated');
    expect(outcome.pageCount).toBe(1);
  });

  it('dropped / truncatedEvents / cursorReset / recoverable page → terminal truncated', async () => {
    const dropped = await runNewestWindowBackfill(0, {
      limit: 2,
      fetchPage: async () => ({ events: [{ ts: 1 }], hasMore: true, droppedEvents: 3 }),
      mergePage: countingMerge,
    });
    expect(dropped.terminal).toBe('truncated');

    const truncatedEvents = await runNewestWindowBackfill(0, {
      limit: 2,
      fetchPage: async () => ({ events: [{ ts: 1 }], hasMore: false, truncatedEvents: 2 }),
      mergePage: countingMerge,
    });
    expect(truncatedEvents.terminal).toBe('truncated');

    const reset = await runNewestWindowBackfill(0, {
      limit: 2,
      fetchPage: async () => ({ events: [], hasMore: false, cursorReset: true }),
      mergePage: countingMerge,
    });
    expect(reset.terminal).toBe('truncated');

    const recoverable = await runNewestWindowBackfill(0, {
      limit: 2,
      fetchPage: async () => ({ events: [], hasMore: false, recoverable: true }),
      mergePage: countingMerge,
    });
    expect(recoverable.terminal).toBe('truncated');
  });

  it('transient null on first page → transient_null with pageCount 0 (hook retries)', async () => {
    const outcome = await runNewestWindowBackfill(0, {
      limit: 2,
      fetchPage: async () => null,
      mergePage: countingMerge,
    });
    expect(outcome.terminal).toBe('transient_null');
    expect(outcome.pageCount).toBe(0);
  });

  it('null on a later page → transient_null after merging earlier pages (no restart)', async () => {
    const seq: (BackfillPage | null)[] = [{ events: [{ ts: 50 }, { ts: 40 }], hasMore: false }, null];
    let i = 0;
    const outcome = await runNewestWindowBackfill(0, {
      limit: 2,
      fetchPage: async () => seq[i++] ?? null,
      mergePage: countingMerge,
    });
    expect(outcome.terminal).toBe('transient_null');
    expect(outcome.pageCount).toBe(1);
    expect(outcome.totalNew).toBe(2);
  });

  it('full page but empty merge (minTs null) → cap_hit (defensive, no cursor)', async () => {
    // events.length >= limit (full) but merge yields no usable cursor.
    const outcome = await runNewestWindowBackfill(0, {
      limit: 2,
      fetchPage: async () => ({ events: [{}, {}], hasMore: false }),
      mergePage: () => ({ candidateCount: 0, minTs: null, maxTs: null }),
    });
    expect(outcome.terminal).toBe('cap_hit');
    expect(outcome.pageCount).toBe(1);
  });

  it('respects an explicit maxPages override', async () => {
    let top = 100;
    const fetchPage = vi.fn(async () => { const p = { events: [{ ts: top }, { ts: top - 1 }], hasMore: false } as BackfillPage; top -= 10; return p; });
    const outcome = await runNewestWindowBackfill(0, { limit: 2, fetchPage, mergePage: countingMerge, maxPages: 2 });
    expect(outcome.terminal).toBe('cap_hit');
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('bootstrap (undefined afterTs) pages the newest window with afterTs left undefined', async () => {
    const pages: BackfillPage[] = [
      { events: [{ ts: 90 }, { ts: 80 }], hasMore: false },
      { events: [{ ts: 70 }], hasMore: false },
    ];
    const seenArgs: Array<{ afterTs: number | undefined; beforeTs?: number }> = [];
    let i = 0;
    const outcome = await runNewestWindowBackfill(undefined, {
      limit: 2,
      fetchPage: async (args) => { seenArgs.push(args); return pages[i++] ?? null; },
      mergePage: countingMerge,
    });
    expect(outcome.terminal).toBe('caught_up');
    expect(seenArgs.map((a) => a.afterTs)).toEqual([undefined, undefined]);
    expect(seenArgs.map((a) => a.beforeTs)).toEqual([undefined, 81]);
  });
});
