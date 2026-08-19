/**
 * Human-readable byte sizes and transfer rates.
 *
 * Shared so a size rendered next to a download and a size rendered next to a
 * transfer never drift into two different conventions.
 */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** The same units per second, for a transfer in flight. */
export function formatByteRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  return `${formatByteSize(bytesPerSecond)}/s`;
}
