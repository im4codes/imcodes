/**
 * Batch keyed updates into one commit per interval.
 *
 * High-rate telemetry (per-session token usage arrives at up to 25 Hz per
 * session) used to call `setState(new Map(prev))` per frame, which re-rendered
 * the whole app and every mounted window for a value only a small bar shows.
 * Here each update is folded into a pending map against the newest known value
 * (pending first, then the committed one), and a single trailing timer commits
 * the lot. The newest value always wins and is at most `intervalMs` late.
 */
export interface MapUpdateBatcher<K, V> {
  /** Fold an update in; `compute` gets the newest known value and returns the next one, or null for "no change". */
  push(key: K, compute: (current: V | undefined) => V | null): void;
  /** Commit whatever is pending now (idempotent). */
  flush(): void;
  /** Drop pending updates and the timer (unmount). */
  cancel(): void;
}

export function createMapUpdateBatcher<K, V>(options: {
  intervalMs: number;
  /** Current committed value for a key. */
  read: (key: K) => V | undefined;
  /** Commit a batch of next values. */
  commit: (updates: ReadonlyMap<K, V>) => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): MapUpdateBatcher<K, V> {
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let pending = new Map<K, V>();
  let timer: unknown = null;
  const flush = () => {
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (pending.size === 0) return;
    const batch = pending;
    pending = new Map();
    options.commit(batch);
  };
  return {
    push(key, compute) {
      const next = compute(pending.has(key) ? pending.get(key) : options.read(key));
      if (next === null) return;
      pending.set(key, next);
      if (timer === null) timer = setTimer(() => { timer = null; flush(); }, options.intervalMs);
    },
    flush,
    cancel() {
      if (timer !== null) { clearTimer(timer); timer = null; }
      pending = new Map();
    },
  };
}
