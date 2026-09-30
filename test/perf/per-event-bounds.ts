import { expect } from 'vitest';

/** Sorted-sample percentile (p in 0..1). */
export function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

/** Wall-clock milliseconds of `samples` synchronous runs, sorted ascending. */
export function measure(run: () => unknown, samples: number): number[] {
  const times: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    const start = performance.now();
    run();
    times.push(performance.now() - start);
  }
  return times.sort((a, b) => a - b);
}

// The median carries the per-event claim: a regression to a full scan costs
// > 5 ms per event. The p99 ceiling only catches pathological outliers,
// because one GC pause under coverage instrumentation on a shared CI runner
// already exceeds 1 ms.
export const PER_EVENT_MEDIAN_MS = 1;
export const PER_EVENT_P99_CEILING_MS = 20;

export function expectFastPerEvent(times: number[]): void {
  expect(percentile(times, 0.5)).toBeLessThan(PER_EVENT_MEDIAN_MS);
  expect(percentile(times, 0.99)).toBeLessThan(PER_EVENT_P99_CEILING_MS);
}
