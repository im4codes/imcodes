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
