export const PREVIEW_READ_METRICS = {
  WORKER_STARTUP: 'worker_startup',
  WORKER_SHUTDOWN: 'worker_shutdown',
  WORKER_UNAVAILABLE: 'worker_unavailable',
  QUEUE_FULL: 'queue_full',
  TIMEOUT: 'timeout',
  WORKER_CRASH: 'worker_crash',
  WORKER_RESTART: 'worker_restart',
  STALE_READ: 'stale_read',
  SHUTDOWN_DRAIN: 'shutdown_drain',
  WORKER_RECYCLE: 'worker_recycle',
  SANITIZED_INTERNAL_ERROR: 'sanitized_internal_error',
} as const;

export const PREVIEW_READ_METRIC_NAMES = Object.values(PREVIEW_READ_METRICS);

export type PreviewReadMetricName = (typeof PREVIEW_READ_METRIC_NAMES)[number];
export type PreviewReadMetricsSnapshot = Record<PreviewReadMetricName, number>;

const counters = new Map<PreviewReadMetricName, number>();

export function recordPreviewReadMetric(name: PreviewReadMetricName, delta = 1): void {
  if (!Number.isFinite(delta) || delta <= 0) return;
  counters.set(name, (counters.get(name) ?? 0) + delta);
}

export function getPreviewReadMetricsSnapshot(): PreviewReadMetricsSnapshot {
  return Object.fromEntries(
    PREVIEW_READ_METRIC_NAMES.map((name) => [name, counters.get(name) ?? 0]),
  ) as PreviewReadMetricsSnapshot;
}

export function __resetPreviewReadMetricsForTests(): void {
  counters.clear();
}
