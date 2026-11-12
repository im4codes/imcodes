import { monitorEventLoopDelay } from 'node:perf_hooks';

export interface PerfLatencyStats {
  elapsedMs: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  stallsOver50ms: number;
  heapUsedDeltaMb: number;
  rssDeltaMb: number;
}

export async function measureAsyncPerf<T>(
  fn: () => Promise<T>,
  options: { stallThresholdMs?: number } = {},
): Promise<{ result: T; stats: PerfLatencyStats }> {
  const stallThresholdNs = (options.stallThresholdMs ?? 50) * 1e6;
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();

  const memBefore = process.memoryUsage();
  const startedAt = performance.now();
  let stallsOver50ms = 0;

  // Also sample event loop gaps directly with a 20ms interval timer so sync stalls
  // longer than 50ms are counted deterministically even inside single-turn work.
  let lastTick = performance.now();
  const stallTimer = setInterval(() => {
    const now = performance.now();
    const gap = now - lastTick - 20;
    lastTick = now;
    if (gap > 50) stallsOver50ms += 1;
  }, 20);
  stallTimer.unref?.();

  try {
    const result = await fn();
    const elapsedMs = performance.now() - startedAt;
    const memAfter = process.memoryUsage();
    histogram.disable();

    const finalGap = performance.now() - lastTick - 20;
    if (finalGap > 50) stallsOver50ms += 1;

    if (stallsOver50ms === 0 && histogram.max > stallThresholdNs) {
      stallsOver50ms = 1;
    }

    return {
      result,
      stats: {
        elapsedMs: round2(elapsedMs),
        p50Ms: round2(histogram.percentile(50) / 1e6),
        p99Ms: round2(histogram.percentile(99) / 1e6),
        maxMs: round2(Math.max(histogram.max / 1e6, elapsedMs > 50 ? 0 : 0)),
        stallsOver50ms,
        heapUsedDeltaMb: round2((memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024)),
        rssDeltaMb: round2((memAfter.rss - memBefore.rss) / (1024 * 1024)),
      },
    };
  } finally {
    clearInterval(stallTimer);
    histogram.disable();
  }
}

export function percentile(samples: number[], pct: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return round2(sorted[idx]!);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
