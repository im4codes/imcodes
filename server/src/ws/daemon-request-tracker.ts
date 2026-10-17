/**
 * requestId → awaiting caller, for server routes that send the daemon one frame
 * and wait for its correlated reply over the same WebSocket. Every entry ends
 * exactly once: answered, timed out, or rejected when the daemon goes away.
 */
export class DaemonRequestTracker {
  private readonly pending = new Map<string, {
    resolve: (msg: Record<string, unknown>) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  /**
   * Register `requestId`, then hand the frame to `send`. Rejects with 'timeout'
   * after `timeoutMs`, or with whatever `send` throws.
   */
  request(requestId: string, timeoutMs: number, send: () => void): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('timeout'));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        send();
      } catch (err) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Settle the caller waiting on `requestId`; false when nobody is. */
  resolve(requestId: string, msg: Record<string, unknown>): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(msg);
    return true;
  }

  rejectAll(reason: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
