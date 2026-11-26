import { preferTimelineEvent } from '../../src/shared/timeline/merge.js';
import type { TimelineEvent } from './ws-client.js';

/**
 * Coalesce last-value timeline signal writes (session.state, agent.status,
 * usage.update, ...) into one IndexedDB write per interval.
 *
 * Each open presentation persisted its own signals per flush, i.e. one IDB
 * transaction (a read-modify-write per row) per hook per flush -- dozens per
 * second across many windows, on the main thread (~4% of the profile at 20
 * sessions). Only the newest signal per (session, type) is ever kept, so a
 * pending map keyed the same way loses nothing: the newest wins by the same
 * `preferTimelineEvent` ordering the store itself applies. Nothing is delayed
 * beyond `intervalMs`, and `flush()` (page hide / unload / freeze) drains at once.
 */
export interface SignalWriteBatcher {
  push(events: readonly TimelineEvent[]): void;
  /** Write everything pending now (idempotent). */
  flush(): void;
  readonly pendingCount: number;
  /** Drop pending writes and the timer (tests / teardown). */
  cancel(): void;
}

export const SIGNAL_WRITE_INTERVAL_MS = 1_000;

export function createSignalWriteBatcher(options: {
  write: (events: TimelineEvent[]) => void;
  intervalMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): SignalWriteBatcher {
  const intervalMs = options.intervalMs ?? SIGNAL_WRITE_INTERVAL_MS;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const pending = new Map<string, TimelineEvent>();
  let timer: unknown = null;
  const flush = () => {
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (pending.size === 0) return;
    const batch = [...pending.values()];
    pending.clear();
    options.write(batch);
  };
  return {
    push(events) {
      for (const event of events) {
        const key = `${event.sessionId}\u0001${event.type}`;
        const existing = pending.get(key);
        pending.set(key, existing ? preferTimelineEvent(existing, event) : event);
      }
      if (pending.size > 0 && timer === null) timer = setTimer(() => { timer = null; flush(); }, intervalMs);
    },
    flush,
    get pendingCount() { return pending.size; },
    cancel() {
      if (timer !== null) { clearTimer(timer); timer = null; }
      pending.clear();
    },
  };
}
