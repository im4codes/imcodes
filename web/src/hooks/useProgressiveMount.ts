import { useEffect, useState } from 'preact/hooks';

/**
 * Reveals at most `count` items, growing the budget by one per animation frame.
 *
 * Mounting several heavy components inside one render pass puts all of their
 * work in a SINGLE task, and the browser cannot service anything — input,
 * paint, or even a reload — until that task returns. Splitting the same work
 * across frames does not make it smaller; it makes it interruptible, which is
 * the difference between "slow" and "the tab is dead".
 *
 * Measured on a 20x-CPU-throttled browser restoring 4 chat windows with 300
 * history events each (`web/perf-harness`):
 *
 *                        worst single task    total blocked
 *   all at once               13979 ms          15594 ms
 *   one window per frame       5762 ms          15583 ms
 *
 * Total blocked time is unchanged — that is the point, and the check that the
 * numbers are real. Only the worst uninterruptible span shrinks.
 *
 * Once the budget has caught up, later additions cost at most one frame of
 * delay, so opening a single window by hand still feels immediate.
 */
export function useProgressiveMount(count: number, initial = 1): number {
  const [budget, setBudget] = useState(initial);

  useEffect(() => {
    if (budget >= count) return;
    const frame = requestAnimationFrame(() => setBudget((current) => current + 1));
    return () => cancelAnimationFrame(frame);
  }, [budget, count]);

  return Math.min(budget, count);
}
