/**
 * Run an async `fn` over `items` with at most `limit` invocations in flight at
 * once. Resolves once EVERY item has settled.
 *
 * This is the bounded-concurrency primitive for "do N independent async tasks,
 * but don't fire all N at once". Use it instead of:
 *   - `for (const x of items) await fn(x)` — correct but serial (slow when each
 *     task is I/O-bound: the waits don't overlap).
 *   - `await Promise.all(items.map(fn))` — fast but UNBOUNDED: 200 items = 200
 *     concurrent fetches / process spawns / sockets, which spikes CPU/FD/memory.
 *
 * Ordering: results are not collected and item order is not preserved — this is
 * for side-effecting work. Within a single worker, items run sequentially.
 *
 * Errors: a throwing `fn` rejects the returned promise (Promise.all semantics) —
 * remaining not-yet-started items are abandoned. If one task failing must NOT
 * abort the rest, make `fn` catch its own errors (then this never rejects).
 *
 * Determinism note: index handoff uses a synchronous counter, so two workers
 * never receive the same item (JS is single-threaded; the `i = cursor++` read +
 * increment can't interleave across an `await`).
 *
 * @param items  the work list
 * @param limit  max concurrent invocations (clamped to [1, items.length])
 * @param fn     async task; receives the item and its original index
 */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const n = items.length;
  if (n === 0) return;
  const cap = Math.max(1, Math.min(Math.trunc(limit) || 1, n));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= n) return;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: cap }, () => worker()));
}
