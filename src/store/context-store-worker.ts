/**
 * Context-store child process — the single long-lived owner of
 * `shared-agent-context.sqlite` in daemon production. It reuses the synchronous
 * `context-store.ts` implementation (so the SQL/transaction logic lives in one
 * place) and exposes it to the daemon broker ONLY through the allowlisted RPC
 * protocol in `shared/context-store-rpc.ts`.
 *
 * Responsibilities (Phase 1 / foundation):
 *  - Own `ensureDb()` (the heavy first-call DDL/FTS/backfill/repair burst) off
 *    the daemon main thread; announce `{ type: 'ready' }` once warm.
 *  - Dispatch allowlisted L1 ops to the real store function of the same name
 *    (never a raw arbitrary `store[fn]`: only ops present in the allowlist AND
 *    resolving to a callable export get a handler).
 *  - Maintain a high/normal/low priority queue so front-of-turn recall jumps
 *    ahead of background writes, and a long op never head-of-line-blocks recall
 *    beyond its own in-flight execution.
 *  - Run a periodic idle PASSIVE WAL checkpoint (escalating to TRUNCATE past the
 *    threshold) — the daemon main thread never checkpoints.
 *
 * L2 (aggregate/transaction) and L3 (bounded recall) ops are defined in the
 * shared allowlist; their worker orchestration handlers land in Phases 2/3.
 * Until then a call to one resolves to a stable `unsupported_operation` error.
 */
import { performance } from 'node:perf_hooks';
import { resolveWorkerRuntime } from '../util/worker-runtime-port.js';
import * as store from './context-store.js';
import {
  CONTEXT_STORE_RPC_ERROR,
  CONTEXT_STORE_WORKER_DIAGNOSTIC_TYPE,
  CONTEXT_STORE_WORKER_SLOW_OP_MS,
  isContextStoreRpcOp,
  type ContextStoreRpcRequest,
  type ContextStoreRpcResponse,
  type ContextStoreRpcPriority,
} from '../../shared/context-store-rpc.js';
import { buildContextStoreOpHandlers } from './context-store-op-handlers.js';

const { port } = resolveWorkerRuntime();

/** How often (ms) the idle WAL checkpoint timer fires. */
const IDLE_CHECKPOINT_INTERVAL_MS = 30_000;
/** How often (ms) one bounded maintenance slice is considered. Each tick runs
 * ONE step (never the whole batch), so the worker returns to its event loop
 * between steps and a queued ingest/enqueue waits at most one step. */
const MAINTENANCE_TICK_MS = 1_000;
/** While requests keep the worker busy, idle gating alone would starve the
 * cursor backfills forever (the stalled noise backfill). A bounded step is
 * therefore forced at least this often even under load. */
const MAINTENANCE_FORCE_INTERVAL_MS = 10_000;
/** While index builds are still pending, one is run at least this often even
 * under load (each is bounded to a few hundred ms). */
const MAINTENANCE_INDEX_BUSY_INTERVAL_MS = 2_000;
/** A forced checkpoint under sustained load, so the WAL cannot grow unbounded
 * while the idle gate is never open. */
const CHECKPOINT_FORCE_INTERVAL_MS = 120_000;
/** Yield between bounded request slices so a normal-ingest flood cannot starve
 * high-priority recall or the worker's own timers indefinitely. */
const MAX_REQUESTS_PER_DRAIN_SLICE = 32;

// ── Build the allowlisted handler map (shared with the client cold fallback;
// explicit, allowlist-bounded — never raw store[arbitrary]). ──
const { handlers, missingL1Ops } = buildContextStoreOpHandlers();
for (const op of missingL1Ops) {
  // A registry/store mismatch — log once; the op will return
  // unsupported_operation rather than crash the worker.
  // eslint-disable-next-line no-console
  console.error(`[context-store-worker] allowlisted L1 op has no callable store export: ${op}`);
}

/** Serialize any thrown value as a plain `{ code, message }` — no stack, no
 *  filesystem path — per the spec's error-serialization contract. */
function toRpcError(err: unknown, fallbackCode: string): { code: string; message: string } {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    const message = (err as { message?: unknown }).message;
    return {
      code: typeof code === 'string' && code ? code : fallbackCode,
      message: typeof message === 'string' ? message : String(err),
    };
  }
  return { code: fallbackCode, message: String(err) };
}

// ── Priority queue ───────────────────────────────────────────────────────────
const queues: Record<ContextStoreRpcPriority, ContextStoreRpcRequest[]> = {
  high: [],
  normal: [],
  low: [],
};
let draining = false;

function hasQueued(): boolean {
  return queues.high.length > 0 || queues.normal.length > 0 || queues.low.length > 0;
}

function reply(res: ContextStoreRpcResponse): void {
  port!.postMessage(res);
}

function reportSlow(kind: 'op' | 'maintenance', name: string, durationMs: number): void {
  if (durationMs < CONTEXT_STORE_WORKER_SLOW_OP_MS) return;
  // Op/step NAME only: arguments and row contents never leave the worker in
  // diagnostics. rss lets an operator tell a memory-bound stall from a scan.
  try {
    port!.postMessage({
      type: CONTEXT_STORE_WORKER_DIAGNOSTIC_TYPE.slowOp,
      kind,
      op: name,
      durationMs: Math.round(durationMs),
      rssBytes: process.memoryUsage().rss,
      queued: queues.high.length + queues.normal.length + queues.low.length,
    });
  } catch {
    /* diagnostics are best-effort */
  }
}

function execute(req: ContextStoreRpcRequest): void {
  const { id, op, args } = req;
  // A queued request is not a hung request.  Acknowledging execution before
  // entering synchronous SQLite work lets the client start its RPC budget at
  // the actual operation, not while the request waits behind backfill.
  port!.postMessage({ type: 'started', id, op, startedAtMs: Date.now() });
  if (!isContextStoreRpcOp(op)) {
    reply({ id, ok: false, error: { code: CONTEXT_STORE_RPC_ERROR.unsupportedOperation, message: `unknown op: ${String(op)}` } });
    return;
  }
  const handler = handlers.get(op);
  if (!handler) {
    // Allowlisted but no handler registered in this build phase (L2/L3 land in
    // Phases 2/3, or an L1 op without a callable export).
    reply({ id, ok: false, error: { code: CONTEXT_STORE_RPC_ERROR.unsupportedOperation, message: `op not available: ${op}` } });
    return;
  }
  const startedAt = performance.now();
  try {
    const result = handler(Array.isArray(args) ? args : []);
    if (result != null && typeof (result as { then?: unknown }).then === 'function') {
      // Async handler (e.g. L3 semantic rerank): reply when it settles.
      void (result as Promise<unknown>).then(
        (value) => { reportSlow('op', op, performance.now() - startedAt); reply({ id, ok: true, result: value }); },
        (err) => { reportSlow('op', op, performance.now() - startedAt); reply({ id, ok: false, error: toRpcError(err, CONTEXT_STORE_RPC_ERROR.opFailed) }); },
      );
    } else {
      reportSlow('op', op, performance.now() - startedAt);
      reply({ id, ok: true, result });
    }
  } catch (err) {
    reportSlow('op', op, performance.now() - startedAt);
    reply({ id, ok: false, error: toRpcError(err, CONTEXT_STORE_RPC_ERROR.opFailed) });
  }
}

function scheduleDrain(): void {
  if (draining) return;
  draining = true;
  setImmediate(drain);
}

function drain(): void {
  // Process ALL high+normal first (front-of-turn recall + writes jump ahead of
  // background work), then at most ONE low item before yielding, so a newly
  // arrived high/normal preempts the rest of the low backlog.
  let processed = 0;
  for (; processed < MAX_REQUESTS_PER_DRAIN_SLICE;) {
    const req = queues.high.shift() ?? queues.normal.shift();
    if (!req) break;
    execute(req);
    processed += 1;
  }
  // A sustained normal/high backlog must yield to the worker event loop. This
  // keeps timers (including health/checkpoint maintenance) and newly-arriving
  // high-priority reads responsive instead of draining an unbounded slice.
  if (processed >= MAX_REQUESTS_PER_DRAIN_SLICE && (queues.high.length > 0 || queues.normal.length > 0)) {
    draining = false;
    scheduleDrain();
    return;
  }
  const low = queues.low.shift();
  if (low) execute(low);

  draining = false;
  if (hasQueued()) scheduleDrain();
}

// ── Maintenance (cursor backfills, index builds) and WAL checkpoint ─────────
// Legacy noise cleanup is cursor-bounded and must never be part of ensureDb()'s
// warmup transaction: loading every historical summary there can exceed the RPC
// timeout and trigger a respawn storm on a large store. It used to run as one
// five-batch + checkpoint burst inside a single event-loop turn every 30 s and
// only when the queue happened to be empty at that instant, i.e. never under
// load. It is now one bounded step per tick, rotating, and forced periodically.
interface MaintenanceStep {
  name: string;
  run: () => void;
}
const cursorSteps: MaintenanceStep[] = [
  { name: 'backfillNamespaceFilterColumnsBatch', run: () => store.backfillNamespaceFilterColumnsBatch() },
  { name: 'backfillProcessedNoiseBatch', run: () => { store.backfillProcessedNoiseBatch(); } },
  { name: 'reconcileMaterializedStagedEventsBatch', run: () => { store.reconcileMaterializedStagedEventsBatch(); } },
  { name: 'purgeMemoryNoiseProjectionsBatch', run: () => { store.purgeMemoryNoiseProjectionsBatch(); } },
];
let maintenanceCursor = 0;
let lastMaintenanceAt = 0;
let lastIndexStepAt = 0;
let indexesDone = false;
let lastCheckpointAt = Date.now();

function isWorkerBusy(): boolean {
  return draining || hasQueued();
}

function runStep(name: string, run: () => void): void {
  const startedAt = performance.now();
  try {
    run();
  } catch {
    // Best-effort; a busy/locked step is retried on a later tick.
  }
  reportSlow('maintenance', name, performance.now() - startedAt);
}

function maintenanceTick(): void {
  const now = Date.now();
  const busy = isWorkerBusy();
  // Index builds come first and are NOT idle-only: queries such as the master
  // sweep depend on them, so a busy worker that never built them would serve
  // those queries as full scans indefinitely. One index per step (a few hundred
  // ms on a 1 GB store), paced so a queued request waits at most one build.
  if (!indexesDone && (!busy || now - lastIndexStepAt >= MAINTENANCE_INDEX_BUSY_INTERVAL_MS)) {
    lastIndexStepAt = now;
    runStep('ensureContextStoreMaintenanceIndexes', () => { indexesDone = store.ensureContextStoreMaintenanceIndexes().done; });
    return;
  }
  if (busy && now - lastMaintenanceAt < MAINTENANCE_FORCE_INTERVAL_MS) return;
  const step = cursorSteps[maintenanceCursor % cursorSteps.length]!;
  maintenanceCursor = (maintenanceCursor + 1) % cursorSteps.length;
  lastMaintenanceAt = now;
  runStep(step.name, step.run);
}

function maybeCheckpoint(): void {
  const now = Date.now();
  if (isWorkerBusy() && now - lastCheckpointAt < CHECKPOINT_FORCE_INTERVAL_MS) return;
  lastCheckpointAt = now;
  const startedAt = performance.now();
  try {
    store.checkpointWal();
  } catch {
    // Best-effort; a busy/locked checkpoint is non-fatal.
  }
  reportSlow('maintenance', 'checkpointWal', performance.now() - startedAt);
}
const maintenanceTimer = setInterval(maintenanceTick, MAINTENANCE_TICK_MS);
const checkpointTimer = setInterval(maybeCheckpoint, IDLE_CHECKPOINT_INTERVAL_MS);
// Don't keep the worker event loop alive just for the maintenance timers.
if (typeof maintenanceTimer.unref === 'function') maintenanceTimer.unref();
if (typeof checkpointTimer.unref === 'function') checkpointTimer.unref();

// ── Message intake ───────────────────────────────────────────────────────────
port.on('message', (msg: ContextStoreRpcRequest) => {
  if (!msg || typeof msg !== 'object' || typeof (msg as { id?: unknown }).id !== 'number') return;
  const priority: ContextStoreRpcPriority =
    msg.priority === 'high' || msg.priority === 'low' ? msg.priority : 'normal';
  queues[priority].push(msg);
  scheduleDrain();
});

// ── Warmup: own ensureDb() off the main thread, then announce readiness ───────
try {
  // Any store read triggers the lazy ensureDb() — the heavy first-call burst now
  // runs here, in the worker, not on the daemon main thread.
  store.getContextMeta('__context_store_worker_warmup__');
  port.postMessage({ type: 'ready' });
} catch (err) {
  port.postMessage({ type: 'ready', warmupError: toRpcError(err, CONTEXT_STORE_RPC_ERROR.opFailed).message });
}
