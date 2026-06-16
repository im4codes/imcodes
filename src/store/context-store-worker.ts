/**
 * Context-store worker — the single long-lived owner of
 * `shared-agent-context.sqlite` in daemon production. It reuses the synchronous
 * `context-store.ts` implementation (so the SQL/transaction logic lives in one
 * place) and exposes it to the main thread ONLY through the allowlisted RPC
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
import { parentPort } from 'node:worker_threads';
import * as store from './context-store.js';
import {
  CONTEXT_STORE_RPC_ERROR,
  isContextStoreRpcOp,
  type ContextStoreRpcRequest,
  type ContextStoreRpcResponse,
  type ContextStoreRpcPriority,
} from '../../shared/context-store-rpc.js';
import { buildContextStoreOpHandlers } from './context-store-op-handlers.js';

const port = parentPort;
if (!port) throw new Error('context-store-worker must run as a worker thread');

/** How often (ms) the idle checkpoint timer fires. */
const IDLE_CHECKPOINT_INTERVAL_MS = 30_000;

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

function execute(req: ContextStoreRpcRequest): void {
  const { id, op, args } = req;
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
  try {
    const result = handler(Array.isArray(args) ? args : []);
    if (result != null && typeof (result as { then?: unknown }).then === 'function') {
      // Async handler (e.g. L3 semantic rerank): reply when it settles.
      void (result as Promise<unknown>).then(
        (value) => reply({ id, ok: true, result: value }),
        (err) => reply({ id, ok: false, error: toRpcError(err, CONTEXT_STORE_RPC_ERROR.opFailed) }),
      );
    } else {
      reply({ id, ok: true, result });
    }
  } catch (err) {
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
  for (;;) {
    const req = queues.high.shift() ?? queues.normal.shift();
    if (!req) break;
    execute(req);
  }
  const low = queues.low.shift();
  if (low) execute(low);

  draining = false;
  if (hasQueued()) scheduleDrain();
}

// ── Idle WAL checkpoint ──────────────────────────────────────────────────────
function maybeCheckpoint(): void {
  // Idle = nothing draining AND no queued work (in particular no high waiter).
  if (draining || hasQueued()) return;
  try {
    store.checkpointWal();
  } catch {
    // Best-effort; a busy/locked checkpoint is non-fatal.
  }
}
const checkpointTimer = setInterval(maybeCheckpoint, IDLE_CHECKPOINT_INTERVAL_MS);
// Don't keep the worker event loop alive just for the checkpoint timer.
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
