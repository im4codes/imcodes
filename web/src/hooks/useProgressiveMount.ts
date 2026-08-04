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

  // Rebase when the list shrinks, or the staggering is one-shot.
  //
  // The budget is "how many have been revealed"; without this it only ever
  // grew. Clamping the RETURN value hid that: close every window (count -> 0)
  // and the hook reported 0 while the budget was still at its high-water mark,
  // so restoring them all — which the toolbar does in a single state update —
  // came back as `min(8, 8) === 8` on the very first frame. Every window
  // remounted in one task, which is exactly the freeze this hook exists to
  // prevent, reachable from a button rather than a corner case.
  // Rebase to `initial` rather than to the raw count: the returned value floors
  // at `initial` anyway, so a budget below it would burn a frame growing back
  // to a number that was already on screen.
  useEffect(() => {
    setBudget((current) => (current > count ? Math.max(Math.min(current, count), initial) : current));
  }, [count, initial]);

  useEffect(() => {
    if (budget >= count) return;
    const frame = requestAnimationFrame(() => setBudget((current) => current + 1));
    return () => cancelAnimationFrame(frame);
  }, [budget, count]);

  // Floor at `initial` so a non-empty list still paints something on the frame
  // it appears, instead of going blank for one frame after a rebase to 0.
  if (count <= 0) return 0;
  return Math.min(Math.max(budget, initial), count);
}
