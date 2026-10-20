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

/**
 * A concurrency bound that is SHARED by every caller, unlike `mapWithConcurrency` (which bounds one call's own work list): `run(fn)`
 * starts `fn` at once while fewer than `limit` runs are in flight, and otherwise waits its turn (first come, first served). A run that
 * throws gives its slot back and rejects only its own caller. Use it where independent triggers (timers, sweeps, requests) can each start
 * the same kind of work and the total, not each trigger's share, must stay bounded.
 */
export interface ConcurrencyGate {
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Runs in flight right now (diagnostics/tests). */
  readonly active: number;
}

export function createConcurrencyGate(limit: number): ConcurrencyGate {
  const cap = Math.max(1, Math.trunc(limit) || 1);
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = (): void => {
    const next = waiting.shift();
    if (next) next(); // hand the slot over directly: `active` stays counted for the next run
    else active -= 1;
  };
  return {
    get active() { return active; },
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active < cap) active += 1;
      else await new Promise<void>((resolve) => { waiting.push(resolve); });
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}
