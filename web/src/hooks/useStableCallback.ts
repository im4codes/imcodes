import { useCallback, useRef } from 'preact/hooks';

/**
 * Give a callback a permanently stable identity without ever calling a stale
 * closure.
 *
 * `ChatView` is memoized so that an open window costs nothing while its own
 * session is quiet. That only holds if its props are referentially stable, and
 * several of them are handlers threaded down from `app.tsx` as inline arrows —
 * `onViewRepo={() => openRepoPage({ …sub })}` and friends. `app.tsx` re-renders
 * on every timeline event, so those arrows get a fresh identity each time and
 * would defeat the memo completely, silently restoring the per-event cost that
 * made a low-spec tab with many sub-session windows stop responding.
 *
 * Hoisting each of those into a `useCallback` in `app.tsx` is not equivalent:
 * they close over per-sub-session values (`sub.cwd`, `sub.id`, …) that really do
 * change, so a naive memo there would capture stale data. Storing the latest
 * function in a ref and exposing a fixed wrapper keeps the identity constant
 * while always dispatching to the current closure.
 */
export function useStableCallback<A extends unknown[], R>(
  fn: ((...args: A) => R) | undefined,
): (...args: A) => R | undefined {
  const ref = useRef(fn);
  // Assigned during render on purpose: the wrapper must dispatch to the closure
  // from the render that is committing, not the one from the previous commit.
  ref.current = fn;
  return useCallback((...args: A) => ref.current?.(...args), []);
}
