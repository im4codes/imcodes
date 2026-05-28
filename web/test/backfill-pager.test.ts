import { describe, it, expect, vi } from 'vitest';
import {
  runTailBackfill,
  CATCHUP_TAIL_MAX_PAGES,
  type BackfillPage,
} from '../src/timeline/catchup/backfill-pager.js';

/**
 * Tier-0 tail-backlog pager contract (run 6f883b36).
 * Pure function: inject fetch + merge, assert terminal/page/cursor behavior.
 */
describe('runTailBackfill (Tier-0 tail continuation)', () => {
  // Helper: a merge that counts events and reports max ts (events are {ts}).
  const countingMerge = (events: unknown[]) => {
    const evs = events as Array<{ ts: number }>;
    let maxTs = -Infinity;
    for (const e of evs) if (e.ts > maxTs) maxTs = e.ts;
    return { newCount: evs.length, maxTs: Number.isFinite(maxTs) ? maxTs : null };
  };

  it('V-A1: continues paging while hasMore=true and merges every page, ending caught_up', async () => {
    const pages: BackfillPage[] = [
      { events: [{ ts: 10 }, { ts: 20 }], hasMore: true },
      { events: [{ ts: 30 }, { ts: 40 }], hasMore: true },
      { events: [{ ts: 50 }], hasMore: false },
    ];
    const seenAfterTs: number[] = [];
    let i = 0;
    const merged: number[] = [];
    const outcome = await runTailBackfill(0, {
      fetchPage: async (afterTs) => { seenAfterTs.push(afterTs); return pages[i++] ?? null; },
      mergePage: (events) => { for (const e of events as Array<{ ts: number }>) merged.push(e.ts); return countingMerge(events); },
    });
    expect(outcome.terminal).toBe('caught_up');
    expect(outcome.pageCount).toBe(3);
    expect(outcome.totalNew).toBe(5);
    // afterTs advanced by each page's max ts (forward continuation).
    expect(seenAfterTs).toEqual([0, 20, 40]);
    expect(merged).toEqual([10, 20, 30, 40, 50]);
  });

  it('V-A1b: single page with hasMore=false (incl. empty idle) ends caught_up', async () => {
    const empty = await runTailBackfill(100, {
      fetchPage: async () => ({ events: [], hasMore: false }),
      mergePage: countingMerge,
    });
    expect(empty.terminal).toBe('caught_up');
    expect(empty.pageCount).toBe(1);
    expect(empty.totalNew).toBe(0);
  });

  it('V-A3: stops at cap_hit (bounded) when hasMore stays true — no unbounded loop', async () => {
    let fetches = 0;
    let ts = 0;
    const outcome = await runTailBackfill(0, {
      fetchPage: async () => { fetches++; ts += 10; return { events: [{ ts }], hasMore: true }; },
      mergePage: countingMerge,
    });
    expect(outcome.terminal).toBe('cap_hit');
    expect(outcome.pageCount).toBe(CATCHUP_TAIL_MAX_PAGES);
    expect(fetches).toBe(CATCHUP_TAIL_MAX_PAGES);
  });

  it('V-A3b: stops cap_hit when hasMore=true but no forward progress (avoids same-afterTs loop)', async () => {
    let fetches = 0;
    const outcome = await runTailBackfill(50, {
      // hasMore=true but events do not advance past afterTs → must stop, not loop.
      fetchPage: async () => { fetches++; return { events: [{ ts: 50 }], hasMore: true }; },
      mergePage: () => ({ newCount: 0, maxTs: 50 }),
    });
    expect(outcome.terminal).toBe('cap_hit');
    expect(fetches).toBe(1);
  });

  it('truncated page → terminal truncated, not caught_up (must not cool down)', async () => {
    const outcome = await runTailBackfill(0, {
      fetchPage: async () => ({ events: [{ ts: 10 }], hasMore: false, payloadTruncated: true }),
      mergePage: countingMerge,
    });
    expect(outcome.terminal).toBe('truncated');
  });

  it('dropped/recoverable page → terminal truncated', async () => {
    const dropped = await runTailBackfill(0, {
      fetchPage: async () => ({ events: [{ ts: 1 }], hasMore: false, droppedEvents: 3 }),
      mergePage: countingMerge,
    });
    expect(dropped.terminal).toBe('truncated');
    const recoverable = await runTailBackfill(0, {
      fetchPage: async () => ({ events: [], hasMore: false, recoverable: true }),
      mergePage: countingMerge,
    });
    expect(recoverable.terminal).toBe('truncated');
  });

  it('transient null on first page → transient_null with pageCount 0 (hook retries)', async () => {
    const outcome = await runTailBackfill(0, {
      fetchPage: async () => null,
      mergePage: countingMerge,
    });
    expect(outcome.terminal).toBe('transient_null');
    expect(outcome.pageCount).toBe(0);
  });

  it('null on a later page → transient_null after merging earlier pages (no restart)', async () => {
    const seq: (BackfillPage | null)[] = [{ events: [{ ts: 10 }], hasMore: true }, null];
    let i = 0;
    const outcome = await runTailBackfill(0, {
      fetchPage: async () => seq[i++] ?? null,
      mergePage: countingMerge,
    });
    expect(outcome.terminal).toBe('transient_null');
    expect(outcome.pageCount).toBe(1);
    expect(outcome.totalNew).toBe(1);
  });

  it('respects an explicit maxPages override', async () => {
    const fetchPage = vi.fn(async () => ({ events: [{ ts: Math.random() }], hasMore: true } as BackfillPage));
    const outcome = await runTailBackfill(0, { fetchPage, mergePage: countingMerge, maxPages: 2 });
    expect(outcome.terminal).toBe('cap_hit');
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});
