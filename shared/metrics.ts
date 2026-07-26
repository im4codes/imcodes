/**
 * In-process counters. THE single implementation — daemon and server both
 * re-export this module from their own `util/metrics.ts`.
 *
 * These are NOT persisted. The store is a plain in-memory Map, so every counter
 * resets when the process restarts, and on the server each replica counts only
 * the traffic that hit that pod. Anything that needs a durable or cluster-wide
 * number has to be written to the database explicitly — do not assume these
 * survive a deploy.
 *
 * Previously this existed as two near-identical copies (`src/util/metrics.ts` and
 * `server/src/util/metrics.ts`) which had already drifted: only the server copy
 * had `addCounter`. That is exactly the duplication the repo rules forbid, so the
 * two files are now thin re-exports of this one.
 */

export type MetricLabels = Record<string, string>;

const counters = new Map<string, number>();

/**
 * Cardinality guard, not a capacity target.
 *
 * Each distinct name+labels combination is one entry, so a caller that labels by
 * something unbounded (a session id, a file path) would otherwise grow the Map
 * forever. Past the cap, NEW keys are dropped while existing ones keep counting —
 * so a hit means later metrics silently go missing, which is worth noticing.
 */
const MAX_COUNTERS = 10_000;

function labelsKey(labels?: MetricLabels): string {
  if (!labels) return '';
  const entries = Object.entries(labels)
    .filter(([, value]) => typeof value === 'string')
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([key, value]) => `${key}=${value}`).join(',');
}

function counterKey(name: string, labels?: MetricLabels): string {
  const suffix = labelsKey(labels);
  return suffix ? `${name}{${suffix}}` : name;
}

export function incrementCounter(name: string, labels?: MetricLabels): void {
  addCounter(name, 1, labels);
}

export function addCounter(name: string, amount: number, labels?: MetricLabels): void {
  if (!name) return;
  if (!Number.isFinite(amount) || amount <= 0) return;
  const key = counterKey(name, labels);
  if (!counters.has(key) && counters.size >= MAX_COUNTERS) return;
  counters.set(key, (counters.get(key) ?? 0) + amount);
}

export function getCounter(name: string, labels?: MetricLabels): number {
  return counters.get(counterKey(name, labels)) ?? 0;
}

export function snapshotCounters(): Record<string, number> {
  return Object.fromEntries(counters.entries());
}

/** Number of distinct counter keys currently held (for cap/leak assertions). */
export function counterKeyCount(): number {
  return counters.size;
}

export function resetMetricsForTests(): void {
  counters.clear();
}
