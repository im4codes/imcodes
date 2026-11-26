/**
 * Leading-edge + trailing-edge throttle, keyed by an arbitrary string.
 *
 * The first push for a key emits immediately; further pushes inside the
 * interval are coalesced and the LAST one is emitted when the window closes.
 * That shape matters for progress-style events (streaming assistant text, a
 * live token counter): the user sees the update start instantly, intermediate
 * frames are dropped rather than queued, and the final value is never lost.
 *
 * `clear()` discards a pending value WITHOUT emitting it — callers that already
 * emit an authoritative final frame (e.g. the non-streaming `assistant.text`
 * written on completion) must not also flush a stale intermediate one.
 */
export class TrailingThrottle<T> {
  private readonly entries = new Map<string, {
    lastEmitAt: number;
    pending: T | null;
    timer: ReturnType<typeof setTimeout> | null;
  }>();

  constructor(
    private readonly intervalMs: number,
    private readonly emit: (value: T) => void,
  ) {}

  /** Throttled push: emits now if the window is open, else coalesces. */
  push(key: string, value: T): void {
    const now = Date.now();
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { lastEmitAt: 0, pending: null, timer: null };
      this.entries.set(key, entry);
    }

    if (entry.lastEmitAt === 0 || now - entry.lastEmitAt >= this.intervalMs) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      entry.pending = null;
      entry.lastEmitAt = now;
      this.emit(value);
      return;
    }

    entry.pending = value;
    if (entry.timer) return;
    entry.timer = setTimeout(() => this.flush(key), this.intervalMs - (now - entry.lastEmitAt));
  }

  /**
   * Bypass the throttle: drop any coalesced value, emit immediately and reopen
   * the window. Use for transitions that must not be delayed or reordered
   * behind a stale pending frame.
   */
  pushNow(key: string, value: T): void {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { lastEmitAt: 0, pending: null, timer: null };
      this.entries.set(key, entry);
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.pending = null;
    entry.lastEmitAt = Date.now();
    this.emit(value);
  }

  /** Emit a coalesced value early (no-op when nothing is pending). */
  flush(key: string): void {
    const entry = this.entries.get(key);
    if (!entry || entry.pending == null) return;
    entry.timer = null;
    entry.lastEmitAt = Date.now();
    const value = entry.pending;
    entry.pending = null;
    this.emit(value);
  }

  /** Forget a key, discarding any pending value without emitting it. */
  clear(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.entries.delete(key);
  }

  clearAll(): void {
    for (const key of [...this.entries.keys()]) this.clear(key);
  }
}
