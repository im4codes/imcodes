/**
 * Server-facing entry point for in-process counters.
 *
 * The implementation lives in `shared/metrics.ts` so the daemon and the server
 * cannot drift apart again. Note the scope: counters are per-process, and the
 * server runs multiple replicas, so a number here reflects ONE pod's traffic and
 * resets on every deploy.
 */
export {
  addCounter,
  counterKeyCount,
  getCounter,
  incrementCounter,
  resetMetricsForTests,
  snapshotCounters,
} from '../../../shared/metrics.js';
export type { MetricLabels } from '../../../shared/metrics.js';
