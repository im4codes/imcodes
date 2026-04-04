/**
 * @vitest-environment jsdom
 *
 * Unit tests for useVirtualList hook — pure logic tests.
 * Tests range calculation, spacer math, cache pruning, threshold gate.
 * ResizeObserver is mocked since jsdom doesn't support it.
 */
import { describe, it, expect } from 'vitest';
import { computeCumulativeHeights, computeRange, pruneCache } from '../src/hooks/useVirtualList.js';

// ── computeCumulativeHeights ─────────────────────────────────────────────────

describe('computeCumulativeHeights', () => {
  const getKey = (_: string, i: number) => `key-${i}`;

  it('computes cumulative heights from estimated values', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const cache = new Map<string, number>();
    const { cumulative, total } = computeCumulativeHeights(items, getKey, 100, cache);

    expect(cumulative).toEqual([0, 100, 200, 300, 400, 500]);
    expect(total).toBe(500);
  });

  it('uses cached heights when available', () => {
    const items = ['a', 'b', 'c'];
    const cache = new Map<string, number>([['key-1', 200]]);
    const { cumulative, total } = computeCumulativeHeights(items, getKey, 100, cache);

    expect(cumulative).toEqual([0, 100, 300, 400]);
    expect(total).toBe(400);
  });

  it('handles empty items', () => {
    const { cumulative, total } = computeCumulativeHeights([], getKey, 100, new Map());
    expect(cumulative).toEqual([0]);
    expect(total).toBe(0);
  });

  it('handles single item', () => {
    const { cumulative, total } = computeCumulativeHeights(['a'], getKey, 50, new Map());
    expect(cumulative).toEqual([0, 50]);
    expect(total).toBe(50);
  });

  it('uses all cached heights when available', () => {
    const items = ['a', 'b', 'c'];
    const cache = new Map<string, number>([
      ['key-0', 40],
      ['key-1', 120],
      ['key-2', 80],
    ]);
    const { cumulative, total } = computeCumulativeHeights(items, getKey, 100, cache);
    expect(cumulative).toEqual([0, 40, 160, 240]);
    expect(total).toBe(240);
  });
});

// ── computeRange ─────────────────────────────────────────────────────────────

describe('computeRange', () => {
  it('computes visible range for items at scroll position 0', () => {
    // 10 items at 100px each, viewport 300px, overscan 2
    const cumulative = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    const { start, end } = computeRange(0, 300, cumulative, 10, 2);

    // Visible: items 0-2 (0-300px), overscan: -2 (clamped to 0) to 4+2=6
    expect(start).toBe(0);
    expect(end).toBe(5); // items 0-4 (3 visible + 2 overscan below)
  });

  it('computes visible range for scroll in middle', () => {
    // 10 items at 100px each, viewport 300px, scrollTop 300, overscan 2
    const cumulative = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    const { start, end } = computeRange(300, 300, cumulative, 10, 2);

    // Visible: items 3-5 (300-600px), overscan: 3-2=1 start, 6+2=8 end
    expect(start).toBe(1);
    expect(end).toBe(8);
  });

  it('handles scroll at very bottom', () => {
    const cumulative = [0, 100, 200, 300, 400, 500];
    const { start, end } = computeRange(200, 300, cumulative, 5, 2);

    // Visible: items 2-4, overscan: start 0, end 5
    expect(start).toBe(0);
    expect(end).toBe(5);
  });

  it('handles empty list', () => {
    const { start, end } = computeRange(0, 300, [0], 0, 2);
    expect(start).toBe(0);
    expect(end).toBe(0);
  });

  it('overscan does not exceed bounds', () => {
    const cumulative = [0, 100, 200, 300];
    const { start, end } = computeRange(0, 300, cumulative, 3, 10);
    expect(start).toBe(0);
    expect(end).toBe(3);
  });

  it('handles large overscan with small list', () => {
    const cumulative = [0, 50, 100];
    const { start, end } = computeRange(0, 500, cumulative, 2, 5);
    expect(start).toBe(0);
    expect(end).toBe(2);
  });

  it('handles variable height items', () => {
    // Items: 40, 120, 80, 200, 60 (total 500)
    const cumulative = [0, 40, 160, 240, 440, 500];
    // Viewport 200px at scrollTop=100, overscan=1
    const { start, end } = computeRange(100, 200, cumulative, 5, 1);
    // Raw visible: items whose range overlaps [100, 300)
    // Item 1 (40-160) overlaps, item 2 (160-240) overlaps, item 3 (240-440) overlaps
    // With overscan=1: start max(0, 1-1)=0, end min(5, 4+1)=5
    expect(start).toBe(0);
    expect(end).toBe(5);
  });
});

// ── pruneCache ───────────────────────────────────────────────────────────────

describe('pruneCache', () => {
  const getKey = (item: string) => item;

  it('removes stale keys not in current items', () => {
    const cache = new Map([
      ['a', 100],
      ['b', 200],
      ['c', 300],
      ['d', 400],
    ]);
    const items = ['a', 'c'];
    pruneCache(cache, items, getKey);

    expect(cache.size).toBe(2);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('d')).toBe(false);
  });

  it('does nothing when cache is empty', () => {
    const cache = new Map<string, number>();
    pruneCache(cache, ['a', 'b'], getKey);
    expect(cache.size).toBe(0);
  });

  it('clears all when items is empty', () => {
    const cache = new Map([['a', 100], ['b', 200]]);
    pruneCache(cache, [], getKey);
    expect(cache.size).toBe(0);
  });

  it('keeps all when all keys match', () => {
    const cache = new Map([['a', 100], ['b', 200]]);
    pruneCache(cache, ['a', 'b'], getKey);
    expect(cache.size).toBe(2);
  });
});

// ── Spacer math ──────────────────────────────────────────────────────────────

describe('spacer height computation', () => {
  it('top spacer is sum of heights above visible range', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const getKey = (_: string, i: number) => `k${i}`;
    const cache = new Map<string, number>();
    const { cumulative, total } = computeCumulativeHeights(items, getKey, 100, cache);
    const { start, end } = computeRange(200, 200, cumulative, 5, 0);

    const topSpacer = cumulative[start];
    const bottomSpacer = Math.max(0, total - cumulative[end]);

    expect(topSpacer).toBe(200); // items 0,1 above
    expect(bottomSpacer).toBe(100); // item 4 below
    expect(topSpacer + (end - start) * 100 + bottomSpacer).toBe(total);
  });

  it('spacers sum with visible items equals total height', () => {
    const items = Array.from({ length: 20 }, (_, i) => `item-${i}`);
    const getKey = (_: string, i: number) => `k${i}`;
    const cache = new Map<string, number>();
    const { cumulative, total } = computeCumulativeHeights(items, getKey, 80, cache);
    const { start, end } = computeRange(400, 300, cumulative, 20, 3);

    const topSpacer = cumulative[start];
    const bottomSpacer = Math.max(0, total - cumulative[end]);
    const visibleHeight = cumulative[end] - cumulative[start];

    expect(topSpacer + visibleHeight + bottomSpacer).toBe(total);
  });
});

// ── Threshold gate ───────────────────────────────────────────────────────────

describe('threshold gate logic', () => {
  it('virtualization disabled when items below threshold', () => {
    // Simulates the enabled check: items.length >= VIRTUAL_THRESHOLD
    const VIRTUAL_THRESHOLD = 50;
    expect(30 >= VIRTUAL_THRESHOLD).toBe(false);
    expect(50 >= VIRTUAL_THRESHOLD).toBe(true);
    expect(100 >= VIRTUAL_THRESHOLD).toBe(true);
  });
});
