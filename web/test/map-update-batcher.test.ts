import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMapUpdateBatcher } from '../src/map-update-batcher.js';

describe('createMapUpdateBatcher', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function harness(initial: Record<string, number> = {}) {
    const committed = new Map<string, number>(Object.entries(initial));
    const commits: Array<Map<string, number>> = [];
    const batcher = createMapUpdateBatcher<string, number>({
      intervalMs: 250,
      read: (key) => committed.get(key),
      commit: (updates) => { commits.push(new Map(updates)); for (const [k, v] of updates) committed.set(k, v); },
    });
    return { batcher, commits, committed };
  }

  it('turns a burst of updates into ONE commit carrying the newest value per key', () => {
    const { batcher, commits } = harness();
    for (let i = 1; i <= 50; i += 1) batcher.push('a', () => i);
    for (let i = 1; i <= 30; i += 1) batcher.push('b', () => i * 10);
    expect(commits).toHaveLength(0);
    vi.advanceTimersByTime(250);
    expect(commits).toHaveLength(1);
    expect(Object.fromEntries(commits[0]!)).toEqual({ a: 50, b: 300 });
  });

  it('folds against the newest known value: pending first, then committed', () => {
    const { batcher, commits } = harness({ a: 100 });
    batcher.push('a', (current) => (current ?? 0) + 1);
    batcher.push('a', (current) => (current ?? 0) + 1);
    vi.advanceTimersByTime(250);
    expect(commits[0]!.get('a')).toBe(102);
    batcher.push('a', (current) => (current ?? 0) + 1);
    vi.advanceTimersByTime(250);
    expect(commits[1]!.get('a')).toBe(103);
  });

  it('null means "no change": nothing is scheduled or committed', () => {
    const { batcher, commits } = harness({ a: 1 });
    batcher.push('a', () => null);
    vi.advanceTimersByTime(1_000);
    expect(commits).toHaveLength(0);
  });

  it('flush commits immediately and is idempotent; cancel drops pending updates', () => {
    const { batcher, commits } = harness();
    batcher.push('a', () => 1);
    batcher.flush();
    batcher.flush();
    expect(commits).toHaveLength(1);
    batcher.push('a', () => 2);
    batcher.cancel();
    vi.advanceTimersByTime(1_000);
    expect(commits).toHaveLength(1);
  });

  // Counterexample for the cost this removes: N frames used to be N commits.
  it('is bounded to one commit per interval however many frames arrive', () => {
    const { batcher, commits } = harness();
    for (let tick = 0; tick < 40; tick += 1) {
      for (let frame = 0; frame < 25; frame += 1) batcher.push('a', (c) => (c ?? 0) + 1);
      vi.advanceTimersByTime(40); // 40 ms ticks = 25 Hz
    }
    expect(commits.length).toBeLessThanOrEqual(Math.ceil((40 * 40) / 250) + 1);
    expect(commits.at(-1)!.get('a')).toBeGreaterThan(0);
  });
});
