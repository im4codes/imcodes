export type MetricLabels = Record<string, string>;

const counters = new Map<string, number>();
const MAX_COUNTERS = 1000;

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
  if (!name) return;
  const key = counterKey(name, labels);
  if (!counters.has(key) && counters.size >= MAX_COUNTERS) return;
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

export function getCounter(name: string, labels?: MetricLabels): number {
  return counters.get(counterKey(name, labels)) ?? 0;
}

export function snapshotCounters(): Record<string, number> {
  return Object.fromEntries(counters.entries());
}

export function resetMetricsForTests(): void {
  counters.clear();
}
