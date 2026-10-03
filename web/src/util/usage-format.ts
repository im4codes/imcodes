/** Shared token-usage formatting so the full Usage page and the compact
 *  per-session panel render numbers/costs identically. */

export function formatUsageNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

/** USD cost from integer micros. `unknownLabel` is shown when cost is unknown. */
export function formatUsageCost(micros: number | null, unknownLabel: string): string {
  if (micros == null) return unknownLabel;
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4,
  }).format(micros / 1_000_000);
}

/**
 * `part`'s share of `total` as a whole-percent string, e.g. for showing what
 * fraction of a token breakdown (input/cache/output) one category is.
 * `total` is the sum of all categories here (see `computeTotalTokens`), not
 * a model context window, so this is a share-of-whole, not a quota level.
 * Returns `—` when there is nothing to divide by, rather than NaN/Infinity.
 */
export function formatUsageSharePercent(part: number, total: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return '—';
  return `${Math.round((part / total) * 100)}%`;
}
