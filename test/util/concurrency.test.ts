import { describe, it, expect, vi } from 'vitest';
import { mapWithConcurrency } from '../../src/util/concurrency.js';

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

describe('mapWithConcurrency', () => {
  it('runs fn exactly once per item, with the correct index', async () => {
    const seen: Array<[string, number]> = [];
    await mapWithConcurrency(['a', 'b', 'c', 'd'], 2, async (item, i) => { seen.push([item, i]); });
    expect(seen.length).toBe(4);
    expect(seen.sort((x, y) => x[1] - y[1])).toEqual([['a', 0], ['b', 1], ['c', 2], ['d', 3]]);
  });

  it('never exceeds the concurrency limit', async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let inFlight = 0; let peak = 0;
    await mapWithConcurrency(items, 4, async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await tick(5);
      inFlight--;
    });
    expect(peak).toBe(4);
  });

  it('caps concurrency at items.length when the limit is larger', async () => {
    let inFlight = 0; let peak = 0;
    await mapWithConcurrency([1, 2, 3], 10, async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await tick(5);
      inFlight--;
    });
    expect(peak).toBe(3);
  });

  it('clamps a non-positive limit to sequential (1) and preserves order', async () => {
    let inFlight = 0; let peak = 0;
    const order: number[] = [];
    await mapWithConcurrency([1, 2, 3], 0, async (n) => {
      inFlight++; peak = Math.max(peak, inFlight);
      order.push(n);
      await tick(2);
      inFlight--;
    });
    expect(peak).toBe(1);
    expect(order).toEqual([1, 2, 3]);
  });

  it('resolves immediately for an empty list (fn never called)', async () => {
    const fn = vi.fn(async () => {});
    await mapWithConcurrency([], 4, fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it('processes every item when there are far more items than the limit', async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const done = new Set<number>();
    await mapWithConcurrency(items, 6, async (n) => { await tick(1); done.add(n); });
    expect(done.size).toBe(50);
  });

  it('rejects if fn throws (Promise.all semantics); per-item try/catch isolates failures', async () => {
    await expect(mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
    })).rejects.toThrow('boom');

    // The restore loop relies on this: fn catches its own errors, so one bad
    // session never aborts the rest of the batch.
    const ok: number[] = [];
    await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      try { if (n === 2) throw new Error('boom'); ok.push(n); } catch { /* isolated */ }
    });
    expect(ok.sort()).toEqual([1, 3]);
  });
});
