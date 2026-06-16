/**
 * Context-store worker client — the async facade the daemon main thread uses to
 * reach the memory/context store. Daemon production code MUST go through this
 * client (typed wrappers), never by importing the synchronous `context-store.ts`
 * directly (enforced by the exact-path import guard, task 4.5).
 *
 * Reliability contract (spec "Async client reliability" / "Failure policy
 * matrix" / "Transport liveness"):
 *  - eager worker spawn + `whenReady()` warmup (ensureDb runs in the worker,
 *    never blocking the daemon listen path);
 *  - per-RPC client-side timeout (R1 front-of-turn ≤ min(transport budget, 2000),
 *    R3/R5 management+mutation 5000, R4 background 30000);
 *  - late-response discard (a reply whose id is no longer pending is ignored);
 *  - backpressure (cap 128 awaited + 64 in-flight fire-and-forget; overflow
 *    drops telemetry / rejects mutations with `context_store_overloaded`);
 *  - self-heal: respawn the worker after N consecutive timeouts, on a cooldown.
 */
import { Worker } from 'node:worker_threads';
import {
  CONTEXT_STORE_RPC_BACKPRESSURE,
  CONTEXT_STORE_RPC_ERROR,
  CONTEXT_STORE_RPC_SELF_HEAL,
  CONTEXT_STORE_RPC_TIMEOUT_MS,
  CONTEXT_STORE_WORKER_DOWN_REASON,
  defaultPriorityForOp,
  isFireAndForgetOp,
  type ContextStoreFireAndForgetOp,
  type ContextStoreWorkerDownReason,
  type ContextStoreRpcOp,
  type ContextStoreRpcPriority,
  type ContextStoreRpcRequest,
  type ContextStoreRpcResponse,
} from '../../shared/context-store-rpc.js';
import { buildContextStoreOpHandlers, type ContextStoreOpHandler } from './context-store-op-handlers.js';

/** Error carrying a stable `code` for the failure-policy matrix. */
export class ContextStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ContextStoreError';
    this.code = code;
  }
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
  fireAndForget: boolean;
}

interface ContextStoreWorkerHandle {
  unref(): void;
  on(event: 'message', listener: (msg: unknown) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  postMessage(message: ContextStoreRpcRequest): void;
  terminate(): Promise<number>;
}

type ContextStoreWorkerFactory = (url: URL) => ContextStoreWorkerHandle;

export interface CallOptions {
  priority?: ContextStoreRpcPriority;
  /** Override the per-RPC timeout (ms). `0` disables the timeout. */
  timeoutMs?: number;
}

const { maxAwaitedPending, maxFireAndForgetPending } = CONTEXT_STORE_RPC_BACKPRESSURE;
const { consecutiveTimeoutsBeforeRespawn, respawnCooldownMs, warmupBackoffBaseMs, warmupBackoffMaxMs } = CONTEXT_STORE_RPC_SELF_HEAL;

export class ContextStoreWorkerClient {
  private worker: ContextStoreWorkerHandle | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingEntry>();
  private awaitedCount = 0;
  private fireAndForgetCount = 0;
  private warmReady = false;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private consecutiveTimeouts = 0;
  private lastRespawnAt = 0;
  // ── Warmup/crash fault domain — INDEPENDENT from the timeout-respawn cooldown.
  //  timeout(alive-but-slow): 3 consec awaited timeouts → lastRespawnAt 60s cooldown;
  //    reset = any ok response (consecutiveTimeouts=0).
  //  warmup/crash(can't stay up): warmupError / pre-ready exit / crash-before-served
  //    → consecutiveWorkerFailures exponential backoff; reset = served ≥1 ok op.
  /** consecutive generations that died WITHOUT serving a successful op. */
  private consecutiveWorkerFailures = 0;
  private lastWorkerFailureAt = 0;
  /** the CURRENT generation served ≥1 successful op (the only reliable "healthy"
   *  signal — reaching `ready` is NOT enough: a ready-then-crash loop must keep
   *  backing off). Reset per generation in `ensureWorker`. */
  private generationServedOk = false;
  /** dedup: one failing generation (warmupError + its terminate-induced exit) is
   *  counted at most once. */
  private workerFailureRecordedGeneration: number | null = null;
  private disposed = false;
  private workerGeneration = 0;
  /** Lazily-built shared op→handler map for the in-process cold fallback
   *  (`run`/`runInProcess`). Lazy so the client only pulls the store dispatch
   *  layer into memory if a cold fallback actually fires. */
  private fallbackHandlers: Map<string, ContextStoreOpHandler> | null = null;
  /** R1 budget source — injected in Phase 2 with `getTransportContextBudgetMs`
   *  to avoid importing the heavy transport runtime here. Defaults to the R1
   *  ceiling so the client is correct and decoupled until then. */
  private budgetProvider: () => number = () => CONTEXT_STORE_RPC_TIMEOUT_MS.r1FrontOfTurnMax;

  /** Inject the transport context budget provider used for R1 timeouts. */
  setTransportBudgetProvider(fn: () => number): void {
    this.budgetProvider = fn;
  }

  /** True once `start()` has been called — i.e. the daemon has declared the
   *  worker the production DB owner. Lifecycle calls `start()` in production
   *  only (skipped under VITEST/test and by the short-lived CLI), so this is the
   *  signal that distinguishes "production single-owner mode" (worker is the
   *  owner; NO main-thread in-process fallback) from "tests/CLI" (in-process is
   *  the only path and is single-owner-safe). NOT the same as `worker !== null`:
   *  `call`/`fireAndForget` lazily `ensureWorker()`, so a test can spawn a worker
   *  without entering production owner mode. */
  private started = false;

  constructor(private readonly createWorker: ContextStoreWorkerFactory = (url) => new Worker(url) as ContextStoreWorkerHandle) {}

  /** Eagerly spawn the worker (call once at daemon startup). Enters production
   *  single-owner mode: store access now goes through the worker, and on
   *  worker-unavailable the failure policy (reject/empty) applies instead of a
   *  main-thread in-process fallback. */
  start(): void {
    if (this.disposed) return;
    this.started = true;
    this.ensureWorker();
  }

  get isReady(): boolean {
    return this.warmReady;
  }

  /** True when the daemon has declared the worker the production DB owner
   *  (`start()` was called). Callers that hold an optional in-process recall
   *  fallback MUST suppress it when this is true (production returns bounded
   *  empty/degraded rather than a main-thread `ensureDb`). */
  get isProductionOwner(): boolean {
    return this.started;
  }

  /** Resolves once the worker has warmed `ensureDb()`. Never rejects.
   *  During self-heal cooldown, do not bypass respawn throttling; resolve
   *  immediately while `isReady` remains false. */
  whenReady(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.worker && this.isRespawnThrottled()) return Promise.resolve();
    this.ensureWorker();
    return this.readyPromise ?? Promise.resolve();
  }

  // ── Worker lifecycle ───────────────────────────────────────────────────────
  private ensureWorker(): ContextStoreWorkerHandle {
    if (this.worker) return this.worker;
    this.warmReady = false;
    this.generationServedOk = false; // new generation: must re-prove health via a served op
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
    const generation = ++this.workerGeneration;
    const workerUrl = new URL('./context-store-worker-bootstrap.mjs', import.meta.url);
    const worker = this.createWorker(workerUrl);
    // Don't keep the daemon process alive solely for this worker.
    worker.unref();
    worker.on('message', (msg: unknown) => this.onMessage(msg, generation));
    worker.on('error', (err) =>
      this.markWorkerUnavailable(
        generation,
        new ContextStoreError(CONTEXT_STORE_RPC_ERROR.workerError, err instanceof Error ? err.message : String(err)),
        { reason: CONTEXT_STORE_WORKER_DOWN_REASON.workerError },
      ),
    );
    worker.on('exit', (code) => {
      // Any exit from the current generation makes the worker unavailable, even
      // code 0 with no pending requests: otherwise a pre-ready clean exit leaves
      // whenReady() unresolved forever.
      this.markWorkerUnavailable(
        generation,
        new ContextStoreError(CONTEXT_STORE_RPC_ERROR.workerExit, `context-store worker exited: ${code}`),
        { terminate: false, reason: CONTEXT_STORE_WORKER_DOWN_REASON.workerExit },
      );
    });
    this.worker = worker;
    return worker;
  }

  private isCurrentGeneration(generation: number): boolean {
    return generation === this.workerGeneration;
  }

  private settleReady(): void {
    this.readyResolve?.();
    this.readyResolve = null;
    this.readyPromise = null;
  }

  private onMessage(msg: unknown, generation: number): void {
    if (!this.isCurrentGeneration(generation)) return;
    if (!msg || typeof msg !== 'object') return;
    if ((msg as { type?: unknown }).type === 'ready') {
      const warmupError = (msg as { warmupError?: unknown }).warmupError;
      if (typeof warmupError === 'string' && warmupError) {
        // The worker's warmup `ensureDb()` FAILED. Do NOT advertise it warm;
        // terminate/clear this generation so a later request can respawn.
        this.markWorkerUnavailable(
          generation,
          new ContextStoreError(CONTEXT_STORE_RPC_ERROR.workerError, warmupError),
          { reason: CONTEXT_STORE_WORKER_DOWN_REASON.warmupError },
        );
        return;
      }
      this.warmReady = true;
      this.settleReady();
      return;
    }
    const res = msg as ContextStoreRpcResponse;
    if (typeof res.id !== 'number') return;
    const entry = this.pending.get(res.id);
    if (!entry) return; // late-response discard (already timed out / settled)
    this.finish(res.id, entry);
    if (res.ok) {
      this.consecutiveTimeouts = 0;
      // Served ≥1 successful op → worker is genuinely healthy: clear the
      // warmup/crash backoff (reaching `ready` alone is NOT enough).
      this.consecutiveWorkerFailures = 0;
      this.generationServedOk = true;
      entry.resolve(res.result);
    } else {
      entry.reject(new ContextStoreError(res.error?.code ?? CONTEXT_STORE_RPC_ERROR.opFailed, res.error?.message ?? 'context store error'));
    }
  }

  private markWorkerUnavailable(
    generation: number | null,
    err: Error,
    options: { terminate?: boolean; reason: ContextStoreWorkerDownReason },
  ): void {
    if (generation !== null && !this.isCurrentGeneration(generation)) return;
    // Warmup/crash fault domain: count a generation that died WITHOUT serving a
    // successful op — once per generation (a warmupError and its terminate-induced
    // exit are the SAME failure). timeout_respawn / dispose never pollute it.
    const { reason } = options;
    if (
      generation !== null
      && !this.generationServedOk
      && this.workerFailureRecordedGeneration !== generation
      && (reason === CONTEXT_STORE_WORKER_DOWN_REASON.warmupError
        || reason === CONTEXT_STORE_WORKER_DOWN_REASON.workerError
        || reason === CONTEXT_STORE_WORKER_DOWN_REASON.workerExit)
    ) {
      this.consecutiveWorkerFailures += 1;
      this.lastWorkerFailureAt = Date.now();
      this.workerFailureRecordedGeneration = generation;
    }
    const dead = this.worker;
    this.worker = null;
    this.warmReady = false;
    this.settleReady();
    if (dead && options.terminate !== false) void dead.terminate().catch(() => {});
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.awaitedCount = 0;
    this.fireAndForgetCount = 0;
  }

  private isRespawnCoolingDown(now = Date.now()): boolean {
    return this.lastRespawnAt > 0 && now - this.lastRespawnAt < respawnCooldownMs;
  }

  /** Exponential backoff for the warmup/crash fault domain. First failure → 0
   *  (immediate retry, preserving transient fast-recovery); 2nd+ → base*2^(n-2)
   *  capped at `warmupBackoffMaxMs`. */
  private warmupBackoffMs(): number {
    if (this.consecutiveWorkerFailures <= 1) return 0;
    return Math.min(warmupBackoffBaseMs << (this.consecutiveWorkerFailures - 2), warmupBackoffMaxMs);
  }

  /** True when ANY respawn throttle is active — the timeout-respawn cooldown OR
   *  the warmup/crash backoff (independent counters; this is only the boolean
   *  union used to gate every respawn entry point so a degraded worker is not
   *  respawn-stormed — spec "Worker fault tolerance: all dispatch paths"). */
  private isRespawnThrottled(now = Date.now()): boolean {
    if (this.isRespawnCoolingDown(now)) return true;
    return this.consecutiveWorkerFailures > 1 && now - this.lastWorkerFailureAt < this.warmupBackoffMs();
  }

  private maybeRespawn(): void {
    if (this.disposed || this.worker || !this.started) return;
    if (this.isRespawnThrottled()) return;
    this.ensureWorker();
  }

  private respawn(): void {
    const now = Date.now();
    if (now - this.lastRespawnAt < respawnCooldownMs) return;
    this.lastRespawnAt = now;
    this.consecutiveTimeouts = 0;
    this.markWorkerUnavailable(
      null,
      new ContextStoreError(CONTEXT_STORE_RPC_ERROR.timeout, 'context-store worker respawned after repeated timeouts'),
      { reason: CONTEXT_STORE_WORKER_DOWN_REASON.timeoutRespawn },
    );
    // Lazily respawned on the next request / whenReady().
  }

  private finish(id: number, entry: PendingEntry): void {
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(id);
    if (entry.fireAndForget) this.fireAndForgetCount = Math.max(0, this.fireAndForgetCount - 1);
    else this.awaitedCount = Math.max(0, this.awaitedCount - 1);
  }

  private tryPostMessage(
    worker: ContextStoreWorkerHandle,
    request: ContextStoreRpcRequest,
    entry: PendingEntry,
  ): void {
    try {
      worker.postMessage(request);
    } catch (err) {
      this.finish(request.id, entry);
      const message = err instanceof Error ? err.message : String(err);
      if (!entry.fireAndForget) {
        entry.reject(new ContextStoreError(CONTEXT_STORE_RPC_ERROR.cloneError, message));
      }
      // Fire-and-forget must never throw through the caller; the pending slot is
      // already cleared above. Awaited callers receive the stable clone error.
    }
  }

  private onTimeout(id: number): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.finish(id, entry);
    entry.reject(new ContextStoreError(CONTEXT_STORE_RPC_ERROR.timeout, `context-store RPC timed out: id ${id}`));
    if (!entry.fireAndForget) {
      this.consecutiveTimeouts += 1;
      if (this.consecutiveTimeouts >= consecutiveTimeoutsBeforeRespawn) this.respawn();
    }
  }

  // ── Dispatch ───────────────────────────────────────────────────────────────
  /** Awaited RPC. Rejects with `context_store_overloaded` when the awaited cap
   *  is exceeded. Use a named wrapper in production; `op` is type-bounded to the
   *  allowlist so arbitrary dynamic dispatch is not possible. */
  call<T = unknown>(op: ContextStoreRpcOp, args: unknown[] = [], opts: CallOptions = {}): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new ContextStoreError(CONTEXT_STORE_RPC_ERROR.disposed, 'context-store client disposed'));
    }
    if (this.awaitedCount >= maxAwaitedPending) {
      return Promise.reject(new ContextStoreError(CONTEXT_STORE_RPC_ERROR.overloaded, 'context-store client overloaded'));
    }
    // ALL dispatch paths honor the respawn throttle (spec "all dispatch paths" —
    // not just the wrappers): a direct call() during the timeout cooldown OR the
    // warmup/crash backoff MUST NOT respawn a torn-down worker. Reject without a
    // pending entry; callR1OrEmpty degrades to empty and run/callOrElse map
    // unavailable to R3/R4/R5 policy.
    if (!this.worker && this.isRespawnThrottled()) {
      return Promise.reject(new ContextStoreError(CONTEXT_STORE_RPC_ERROR.unavailable, `context-store worker throttled for op: ${op}`));
    }
    const worker = this.ensureWorker();
    const id = this.nextId++;
    const priority = opts.priority ?? defaultPriorityForOp(op);
    const timeoutMs = opts.timeoutMs ?? CONTEXT_STORE_RPC_TIMEOUT_MS.r3r5Management;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => this.onTimeout(id), timeoutMs) : null;
      if (timer && typeof timer.unref === 'function') timer.unref();
      const entry: PendingEntry = { resolve: resolve as (v: unknown) => void, reject, timer, fireAndForget: false };
      this.pending.set(id, entry);
      this.awaitedCount += 1;
      this.tryPostMessage(worker, { id, priority, op, args } satisfies ContextStoreRpcRequest, entry);
    });
  }

  /** Fire-and-forget RPC (R2 telemetry / lazy fill). Never awaited, never
   *  rejects the caller; dropped when the in-flight cap is exceeded. */
  fireAndForget(op: ContextStoreFireAndForgetOp, args: unknown[] = []): void {
    if (this.disposed) return;
    // Defense in depth for JS callers / casts: only R2 telemetry + lazy embedding
    // fill may be fire-and-forget; a durable mutation here would be silently
    // dropped/reordered, so refuse it rather than enqueue it.
    if (!isFireAndForgetOp(op)) return;
    if (this.fireAndForgetCount >= maxFireAndForgetPending) return; // drop / coalesce
    // Honor the respawn throttle (audit H-B + N-1): a best-effort R2 telemetry /
    // lazy-fill RPC MUST NOT respawn a worker the watchdog just tore down — during
    // the timeout cooldown OR the warmup/crash backoff — which would defeat the
    // respawn-storm throttle that run/callOrElse/callR1OrEmpty honor via
    // maybeRespawn(). Dropping is spec-compliant ("fire-and-forget MAY be dropped").
    if (!this.worker && this.isRespawnThrottled()) return; // drop / coalesce
    const worker = this.ensureWorker();
    const id = this.nextId++;
    const priority = defaultPriorityForOp(op);
    // Time the entry out so a lost response cannot leak a pending slot forever.
    const timer = setTimeout(() => this.onTimeout(id), CONTEXT_STORE_RPC_TIMEOUT_MS.r4Background);
    if (typeof timer.unref === 'function') timer.unref();
    const entry: PendingEntry = { resolve: () => {}, reject: () => {}, timer, fireAndForget: true };
    this.pending.set(id, entry);
    this.fireAndForgetCount += 1;
    this.tryPostMessage(worker, { id, priority, op, args } satisfies ContextStoreRpcRequest, entry);
  }

  /** R1 front-of-turn read: returns `emptyValue` immediately if the worker is
   *  not yet warm (cold-start, not queued behind ensureDb) and degrades to
   *  `emptyValue` on timeout/error — never delaying the turn. */
  async callR1OrEmpty<T>(op: ContextStoreRpcOp, args: unknown[], emptyValue: T): Promise<T> {
    if (this.disposed) return emptyValue;
    this.maybeRespawn();
    if (!this.warmReady) return emptyValue;
    const timeoutMs = Math.min(this.budgetProvider(), CONTEXT_STORE_RPC_TIMEOUT_MS.r1FrontOfTurnMax);
    try {
      return await this.call<T>(op, args, { priority: 'high', timeoutMs });
    } catch {
      return emptyValue;
    }
  }

  /** Run `op` in the worker when it is warm (and on success), else fall back to
   *  the provided local synchronous implementation. Also falls back on a worker
   *  error/timeout — safe for idempotent writes and for reads. This is the
   *  migration seam for background main-thread store callers. */
  async callOrElse<T>(op: ContextStoreRpcOp, args: unknown[], fallback: () => T, opts: CallOptions = {}): Promise<T> {
    if (!this.disposed && this.warmReady) {
      try {
        return await this.call<T>(op, args, opts);
      } catch (err) {
        if (this.started) throw err;
        // tests/CLI fall through to local fallback
      }
    }
    this.maybeRespawn();
    if (this.started) {
      // Production single-owner mode: the worker is the DB owner, so do NOT open
      // a second main-thread connection. Reject (R3 mutation / R5 read) or let
      // the caller convert to requeue/backoff (R4) — never a silent in-process
      // write. (R1 front-of-turn reads use callR1OrEmpty, which returns empty.)
      throw new ContextStoreError(
        CONTEXT_STORE_RPC_ERROR.unavailable,
        `context-store worker unavailable for op: ${op}`,
      );
    }
    return fallback();
  }

  /** Run `op` in the worker when warm (and on success), else dispatch the SAME
   *  allowlisted op IN-PROCESS via the shared op-handler map (the bounded cold
   *  fallback, identical to what the worker runs). This is the CENTRALIZED form
   *  of `callOrElse`: callers pass NO fallback closure and therefore do NOT
   *  import `context-store` directly (the facade owns the single main-thread
   *  store touchpoint). Falls back on worker error/timeout too — safe for
   *  idempotent writes and reads. The cold path runs only when the worker is not
   *  ready (startup window / tests / CLI), never in steady-state production. */
  async run<T>(op: ContextStoreRpcOp, args: unknown[] = [], opts: CallOptions = {}): Promise<T> {
    if (!this.disposed && this.warmReady) {
      try {
        return await this.call<T>(op, args, opts);
      } catch (err) {
        if (this.started) throw err;
        // tests/CLI fall through to local fallback
      }
    }
    this.maybeRespawn();
    if (this.started) {
      // Production single-owner mode (see callOrElse): reject rather than run a
      // main-thread in-process op behind/around the worker. Callers map this to
      // R3 reject / R5 reject-or-stale / R4 requeue. R1 reads use callR1OrEmpty.
      throw new ContextStoreError(
        CONTEXT_STORE_RPC_ERROR.unavailable,
        `context-store worker unavailable for op: ${op}`,
      );
    }
    return this.runInProcess<T>(op, args);
  }

  /** Synchronous in-process dispatch via the shared op-handler map — the cold
   *  fallback for `run()`. PRIVATE on purpose: it never routes to the worker, so
   *  exposing it would let callers do main-thread SQLite (and trigger `ensureDb`)
   *  on a hot path, defeating the worker isolation. Use `run()`/`callOrElse()`. */
  private runInProcess<T>(op: ContextStoreRpcOp, args: unknown[] = []): T {
    if (!this.fallbackHandlers) this.fallbackHandlers = buildContextStoreOpHandlers().handlers;
    const handler = this.fallbackHandlers.get(op);
    if (!handler) {
      throw new ContextStoreError(
        CONTEXT_STORE_RPC_ERROR.unsupportedOperation,
        `no in-process fallback handler for op: ${op}`,
      );
    }
    return handler(args) as T;
  }

  // ── Observability (also used by the Foundation tests) ──────────────────────
  get pendingAwaitedCount(): number {
    return this.awaitedCount;
  }
  get pendingFireAndForgetCount(): number {
    return this.fireAndForgetCount;
  }

  dispose(): void {
    this.disposed = true;
    this.markWorkerUnavailable(null, new ContextStoreError(CONTEXT_STORE_RPC_ERROR.disposed, 'context-store client disposed'), { reason: CONTEXT_STORE_WORKER_DOWN_REASON.dispose });
  }
}

// ── Daemon singleton ─────────────────────────────────────────────────────────
let singleton: ContextStoreWorkerClient | null = null;

/** The process-wide context-store client. Spawns lazily; call `start()` at
 *  daemon startup for eager warmup. */
export function getContextStoreClient(): ContextStoreWorkerClient {
  if (!singleton) singleton = new ContextStoreWorkerClient();
  return singleton;
}

/** Test hook: dispose and drop the singleton so the next get spawns fresh. */
export function resetContextStoreClientForTests(): void {
  if (singleton) singleton.dispose();
  singleton = null;
}
