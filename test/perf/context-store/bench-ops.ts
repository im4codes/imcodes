/**
 * Per-op cost of the context-store ops on a production-shaped DB (see
 * synth-db.ts). Calls the real store functions in-process, i.e. exactly the
 * synchronous SQLite/JS work the worker's single event loop executes per RPC.
 *
 *   IMCODES_CONTEXT_DB_PATH=/tmp/x/ctx.sqlite npx tsx test/perf/context-store/bench-ops.ts [iterations]
 *
 * Prints one JSON line per op: { op, n, p50, p99, max, mean } in milliseconds.
 */
import { performance } from 'node:perf_hooks';
import * as store from '../../../src/store/context-store.js';

const dbPath = process.env.IMCODES_CONTEXT_DB_PATH?.trim();
if (!dbPath || dbPath.includes('/.imcodes/')) throw new Error('IMCODES_CONTEXT_DB_PATH must be a scratch DB');
const ITER = Number(process.argv[2] ?? 30);

const heavyNs = { scope: 'personal', userId: 'synthetic-user', projectId: 'github.com/synthetic/project-0' } as const;
const mediumNs = { scope: 'personal', userId: 'synthetic-user', projectId: 'github.com/synthetic/project-1' } as const;
const sessionTarget = (ns: typeof heavyNs, k: number) => ({ namespace: ns, kind: 'session' as const, sessionName: `deck_synth${ns === heavyNs ? 0 : 1}_w${k}` });
const heavyProject = { namespace: heavyNs, kind: 'project' as const };

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}
const results: Array<{ op: string; n: number; p50: number; p99: number; max: number; mean: number }> = [];
function measure(op: string, fn: (i: number) => unknown, iterations = ITER): void {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    fn(i);
    samples.push(performance.now() - t0);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const row = {
    op, n: samples.length,
    p50: +pct(sorted, 50).toFixed(2), p99: +pct(sorted, 99).toFixed(2), max: +sorted[sorted.length - 1]!.toFixed(2),
    mean: +(samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(2),
  };
  results.push(row);
  console.log(JSON.stringify(row));
}

const t0 = performance.now();
store.getContextMeta('__bench_warm__');
console.log(JSON.stringify({ op: 'ensureDb(first call: schema+repair)', n: 1, ms: +(performance.now() - t0).toFixed(1) }));

let seq = 0;
measure('ingestContextEvent(eligible, heavy ns)', (i) => store.ingestContextEvent({
  target: sessionTarget(heavyNs, i % 60), eventType: 'assistant.text', content: `bench event ${seq++} ${'x'.repeat(400)}`,
}, true));
measure('ingestContextEvent(eligible, medium ns)', (i) => store.ingestContextEvent({
  target: sessionTarget(mediumNs, i % 5), eventType: 'assistant.text', content: `bench event ${seq++} ${'x'.repeat(400)}`,
}, true));
measure('ingestContextEvent(non-eligible)', (i) => store.ingestContextEvent({
  target: sessionTarget(heavyNs, i % 60), eventType: 'tool.call', content: 'x',
}, false));
measure('listDirtyTargets(all)', () => store.listDirtyTargets(undefined));
measure('listDirtyTargets(heavy ns)', () => store.listDirtyTargets(heavyNs));
measure('estimateStagedTokenUpperBound', (i) => store.estimateStagedTokenUpperBound(sessionTarget(heavyNs, i % 60)));
measure('getLatestRecentSummaryUpdatedAtForTarget(session, heavy ns)', (i) => store.getLatestRecentSummaryUpdatedAtForTarget(sessionTarget(heavyNs, i % 60)));
measure('getLatestRecentSummaryUpdatedAtForTarget(project, heavy ns)', () => store.getLatestRecentSummaryUpdatedAtForTarget(heavyProject));
measure('getLatestRecentSummaryUpdatedAtForTarget(session, medium ns)', (i) => store.getLatestRecentSummaryUpdatedAtForTarget(sessionTarget(mediumNs, i % 5)));
measure('listLatestRecentSummarySessions(1000)', () => store.listLatestRecentSummarySessions(1000));
measure('getLatestMasterSummaryUpdatedAt', (i) => store.getLatestMasterSummaryUpdatedAt(sessionTarget(heavyNs, i % 60).sessionName, heavyNs));
measure('listProcessedProjections(heavy ns, recent_summary)', () => store.listProcessedProjections(heavyNs, 'recent_summary'), 5);
measure('listProcessedProjections(heavy ns, master_summary)', () => store.listProcessedProjections(heavyNs, 'master_summary'), 5);
measure('listProcessedProjections(medium ns, recent_summary)', () => store.listProcessedProjections(mediumNs, 'recent_summary'), 5);
if (process.env.BENCH_OPTS === '1') {
  const opts = store as unknown as { listProcessedProjections: (...a: unknown[]) => unknown };
  measure('listProcessedProjections(heavy ns, recent_summary, {excludeArchived,limit:1})', () => opts.listProcessedProjections(heavyNs, 'recent_summary', { excludeArchived: true, limit: 1 }), 30);
  measure('listProcessedProjections(heavy ns, recent_summary, {sessionName,updatedAfter:0})', (i) => opts.listProcessedProjections(heavyNs, 'recent_summary', { sessionName: `deck_synth0_w${i % 60}`, updatedAfter: 0, excludeArchived: true }), 30);
  measure('listProcessedProjections(heavy ns, master_summary, {sessionName,limit:1})', (i) => opts.listProcessedProjections(heavyNs, 'master_summary', { sessionName: `deck_synth0_w${i % 60}`, excludeArchived: true, limit: 1 }), 30);
}
measure('hasProcessedProjectionsInNamespace(heavy ns)', () => store.hasProcessedProjectionsInNamespace(heavyNs), 5);
measure('enqueueContextJob', (i) => store.enqueueContextJob(sessionTarget(heavyNs, i % 60), 'materialize_session', 'idle', Date.now()));
{
  const ids: string[] = [];
  for (let i = 0; i < ITER; i += 1) ids.push(store.enqueueContextJob(sessionTarget(mediumNs, i % 5), 'materialize_session', 'idle', Date.now()).id);
  measure('claimContextJob', (i) => store.claimContextJob(ids[i % ids.length]!, Date.now()));
}
measure('selectTurnUsageSyncBatch', () => (store as unknown as { selectTurnUsageSyncBatch: (...a: unknown[]) => unknown }).selectTurnUsageSyncBatch?.(50, Date.now()));
// idle-maintenance slices, exactly as the worker's idle tick runs them
measure('maint: ensureContextStoreMaintenanceIndexes', () => store.ensureContextStoreMaintenanceIndexes(), 3);
measure('maint: backfillNamespaceFilterColumnsBatch', () => store.backfillNamespaceFilterColumnsBatch(), 10);
measure('maint: backfillProcessedNoiseBatch', () => store.backfillProcessedNoiseBatch(), 10);
measure('maint: reconcileMaterializedStagedEventsBatch', () => store.reconcileMaterializedStagedEventsBatch(), 10);
measure('maint: purgeMemoryNoiseProjectionsBatch', () => store.purgeMemoryNoiseProjectionsBatch(), 10);
measure('maint: checkpointWal', () => store.checkpointWal(), 3);
const worst = results.reduce((a, b) => (b.max > a.max ? b : a));
console.log(JSON.stringify({ summary: 'worst op', op: worst.op, max: worst.max }));
