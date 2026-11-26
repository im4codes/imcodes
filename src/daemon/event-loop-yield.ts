/**
 * Yield without introducing a timer delay. Long daemon projections use this
 * between bounded chunks so heartbeats, socket reads, and control messages can
 * run before the next database slice.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
