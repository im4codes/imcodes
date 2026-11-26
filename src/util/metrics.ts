/**
 * Daemon-facing entry point for in-process counters.
 *
 * The implementation lives in `shared/metrics.ts` so the daemon and the server
 * cannot drift apart again (they already had, once: only the server copy grew
 * `addCounter`). This file stays so the many existing `../util/metrics.js`
 * imports keep working.
 */
export {
  addCounter,
  counterKeyCount,
  getCounter,
  incrementCounter,
  resetMetricsForTests,
  snapshotCounters,
} from '../../shared/metrics.js';
export type { MetricLabels } from '../../shared/metrics.js';
