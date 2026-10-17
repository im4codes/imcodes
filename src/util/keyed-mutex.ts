/**
 * Runs async work one at a time per key, in call order. A failing task never blocks the ones queued behind it. Used where a plan
 * ("how many are idle?") and the writes that act on it ("create them, assign them") must not interleave with another caller's.
 */
const tails = new Map<string, Promise<unknown>>();

export async function runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.then(() => undefined, () => undefined);
  tails.set(key, tail);
  try {
    return await run;
  } finally {
    if (tails.get(key) === tail) tails.delete(key);
  }
}
