/**
 * Production-shaped soak for the context-store worker: drives the REAL worker
 * child process through the REAL client (timeouts, queue-aware classification,
 * respawn) against a synthetic production-shaped DB (synth-db.ts), with the same
 * op mix the daemon issues: live ingest (bursty), trigger -> enqueue -> claim ->
 * materialization reads -> complete, the 15 s sweep (dirty targets + master
 * summary sweep), and interactive high-priority reads.
 *
 *   IMCODES_CONTEXT_DB_PATH=/tmp/x/soak.sqlite npx tsx test/perf/context-store/soak.ts <minutes> [eventsPerSec]
 *   SOAK_LEGACY=1   call listProcessedProjections the way the base coordinator did
 *                   (whole namespace, no options) so the same harness can run
 *                   against the base commit for the before/after comparison.
 *
 * Emits one JSON summary line: per-op latency percentiles, error counts by code,
 * "remained queued" / "worker lost" / slow-op log counts, maintenance cursor.
 */
import { execSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { ContextStoreWorkerClient } from '../../../src/store/context-store-worker-client.js';

const dbPath = process.env.IMCODES_CONTEXT_DB_PATH?.trim();
if (!dbPath || dbPath.includes('/.imcodes/')) throw new Error('IMCODES_CONTEXT_DB_PATH must be a scratch DB');
const MINUTES = Number(process.argv[2] ?? 2);
const RATE = Number(process.argv[3] ?? 10);
const LEGACY = process.env.SOAK_LEGACY === '1';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const nsFor = (i: number) => ({ scope: 'personal', userId: 'synthetic-user', projectId: `github.com/synthetic/project-${i}` }) as const;
let rng = 0x9e3779b9;
const rand = () => { rng ^= rng << 13; rng >>>= 0; rng ^= rng >>> 17; rng ^= rng << 5; rng >>>= 0; return rng / 0x1_0000_0000; };
function pickTarget() {
  const r = rand();
  const [ns, n] = r < 0.6 ? [0, 60] : r < 0.8 ? [1, 5] : [2 + Math.floor(rand() * 9), 2];
  return { namespace: nsFor(ns), kind: 'session' as const, sessionName: `deck_synth${ns}_w${Math.floor(rand() * n)}` };
}

// ── log capture ──
const logCounts = { remainedQueued: 0, unknownOutcome: 0, workerLost: 0, respawned: 0, rpcTimeout: 0, slowOpLines: 0, workerUnavailable: 0 };
for (const level of ['warn', 'error', 'log'] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.includes('worker lost')) logCounts.workerLost += 1;
    if (line.includes('worker slow')) logCounts.slowOpLines += 1;
    if (line.includes('RPC timeout')) logCounts.rpcTimeout += 1;
    if (line.includes('respawned after repeated timeouts')) logCounts.respawned += 1;
    if (line.includes('worker lost') || line.includes('worker slow') || line.includes('RPC timeout')) orig(`[t+${Math.round((Date.now() - T0) / 1000)}s] ${line}`);
  };
}

// Optional fault injection: SIGKILL the worker child at N seconds and measure
// how long until the first ingest succeeds again (respawn mid-op / restart with
// a queued backlog). Loss-time state is verified by the caller from the summary.
const KILL_AT_SEC = Number(process.env.SOAK_KILL_AT_SEC ?? 0);
const recovery = { killedAt: 0, firstOkAfterKillMs: -1 };

const T0 = Date.now();
const stats = new Map<string, { samples: number[]; errors: Record<string, number> }>();
async function timed<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  const s = stats.get(name) ?? { samples: [], errors: {} };
  stats.set(name, s);
  const t0 = performance.now();
  try {
    const r = await fn();
    s.samples.push(performance.now() - t0);
    if (name === 'ingestContextEvent' && recovery.killedAt > 0 && recovery.firstOkAfterKillMs < 0 && Date.now() > recovery.killedAt) {
      recovery.firstOkAfterKillMs = Date.now() - recovery.killedAt;
    }
    return r;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    const msg = String(e.message ?? '');
    const key = msg.includes('remained queued') ? 'remained_queued' : msg.includes('outcome unknown') ? 'outcome_unknown' : String(e.code ?? 'error');
    if (key === 'remained_queued') logCounts.remainedQueued += 1;
    if (key === 'outcome_unknown') logCounts.unknownOutcome += 1;
    s.errors[key] = (s.errors[key] ?? 0) + 1;
    s.samples.push(performance.now() - t0);
    return undefined;
  }
}

const client = new ContextStoreWorkerClient();
client.start();
await client.whenReady();
const meta = async (k: string) => client.run<string | null>('getContextMeta', [k]);
const cursorBefore = await meta('processed_noise_backfill_rowid');

if (KILL_AT_SEC > 0) {
  setTimeout(() => {
    const pids = execSync(`pgrep -P ${process.pid}`).toString().trim().split('\n').filter(Boolean);
    recovery.killedAt = Date.now();
    for (const pid of pids) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ } }
  }, KILL_AT_SEC * 1000);
}
const endAt = Date.now() + MINUTES * 60_000;
const jobs: string[] = [];
const eventCounts = new Map<string, number>();
const workers: Array<Promise<void>> = [];

// ingest with bursts
workers.push((async () => {
  let burstUntil = 0;
  let nextBurst = Date.now() + 30_000;
  while (Date.now() < endAt) {
    const now = Date.now();
    if (now >= nextBurst) { burstUntil = now + 2000; nextBurst = now + 30_000; }
    const rate = now < burstUntil ? RATE * 4 : RATE;
    const target = pickTarget();
    const key = `${target.namespace.projectId}/${target.sessionName}`;
    void (async () => {
      const res = await timed('ingestContextEvent', () => client.run<{ dirtyTarget?: unknown }>('ingestContextEvent', [{ target, eventType: 'assistant.text', content: `soak event ${now} ${'x'.repeat(300)}` }, true]));
      const n = (eventCounts.get(key) ?? 0) + 1;
      eventCounts.set(key, n);
      if (res?.dirtyTarget && n % 8 === 0) {
        const job = await timed('enqueueContextJob', () => client.run<{ id: string }>('enqueueContextJob', [target, 'materialize_session', 'threshold', Date.now()]));
        if (job?.id && jobs.length < 200) jobs.push(job.id);
      }
    })();
    await sleep(-Math.log(1 - rand()) / rate * 1000);
  }
})());

// materialization simulator
workers.push((async () => {
  while (Date.now() < endAt) {
    await sleep(2000);
    const id = jobs.shift();
    if (!id) continue;
    const claimed = await timed('claimContextJob', () => client.run<boolean>('claimContextJob', [id, Date.now()]));
    if (!claimed) continue;
    const ns = nsFor(0);
    await timed('listProcessedProjections(recent, existence)', () => LEGACY
      ? client.run('listProcessedProjections', [ns, 'recent_summary'])
      : client.run('listProcessedProjections', [ns, 'recent_summary', { excludeArchived: true, limit: 1 }]));
    await sleep(150);
    await timed('updateContextJob', () => client.run('updateContextJob', [id, 'completed', { now: Date.now() }]));
  }
})());

// 15 s sweep
workers.push((async () => {
  while (Date.now() < endAt) {
    await timed('listDirtyTargets', () => client.run('listDirtyTargets', []));
    const sessions = await timed('listLatestRecentSummarySessions', () => client.run<Array<{ sessionName: string; namespace: unknown }>>('listLatestRecentSummarySessions', [1000]));
    for (const s of (sessions ?? []).slice(0, 300)) {
      await timed('getLatestMasterSummaryUpdatedAt', () => client.run('getLatestMasterSummaryUpdatedAt', [s.sessionName, s.namespace]));
    }
    await sleep(15_000);
  }
})());

// master-summary materialization reads (per idle-elapsed session)
workers.push((async () => {
  while (Date.now() < endAt) {
    await sleep(20_000);
    const t = pickTarget();
    await timed('master batch read', () => LEGACY
      ? client.run('listProcessedProjections', [t.namespace, 'recent_summary'])
      : client.run('listProcessedProjections', [t.namespace, 'recent_summary', { sessionName: t.sessionName, updatedAfter: 0, excludeArchived: true }]));
  }
})());

// interactive high-priority reads
workers.push((async () => {
  while (Date.now() < endAt) {
    await sleep(2000);
    await timed('hasProcessedProjectionsInNamespace(high)', () => client.run('hasProcessedProjectionsInNamespace', [nsFor(0)], { priority: 'high', timeoutMs: 2000 }));
  }
})());

await Promise.all(workers);
await sleep(3000); // let in-flight ops settle
const cursorAfter = await meta('processed_noise_backfill_rowid');
const noiseDone = await meta('processed_noise_backfill_complete');
const pct = (a: number[], p: number) => a.length ? +[...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p / 100 * a.length))]!.toFixed(1) : 0;
const ops = Object.fromEntries([...stats].map(([k, v]) => [k, {
  n: v.samples.length, p50: pct(v.samples, 50), p99: pct(v.samples, 99), max: pct(v.samples, 100), errors: v.errors,
}]));
process.stdout.write(JSON.stringify({
  soak: { minutes: MINUTES, ratePerSec: RATE, legacy: LEGACY, dbPath },
  remainedQueued: logCounts.remainedQueued, outcomeUnknown: logCounts.unknownOutcome, respawnsWorkerLost: logCounts.workerLost,
  respawnedAfterTimeouts: logCounts.respawned, rpcTimeoutLines: logCounts.rpcTimeout, workerSlowLines: logCounts.slowOpLines,
  recovery: KILL_AT_SEC > 0 ? recovery : undefined,
  noiseBackfillCursor: { before: cursorBefore, after: cursorAfter, complete: noiseDone },
  ops,
}, null, 1) + '\n');
client.dispose();
process.exit(0);
