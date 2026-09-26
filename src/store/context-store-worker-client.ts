/**
 * Context-store process client — the async facade the daemon broker uses to
 * reach the memory/context store. Daemon production code MUST go through this
 * client (typed wrappers), never by importing the synchronous `context-store.ts`
 * directly (enforced by the exact-path import guard, task 4.5).
 *
 * Reliability contract (spec "Async client reliability" / "Failure policy
 * matrix" / "Transport liveness"):
 *  - eager process spawn + `whenReady()` warmup (ensureDb runs in the child,
 *    never blocking the daemon listen path);
 *  - per-RPC client-side timeout (R1 front-of-turn ≤ min(transport budget, 2000),
 *    R3/R5 management+mutation 5000, R4 background 30000);
 *  - late-response discard (a reply whose id is no longer pending is ignored);
 *  - backpressure (cap 128 awaited + 64 in-flight fire-and-forget; overflow
 *    drops telemetry / rejects mutations with `context_store_overloaded`);
 *  - self-heal: respawn the worker after N consecutive timeouts, on a cooldown.
 */
import { spawnChildProcessWorker } from '../util/child-process-worker.js';
import {
  boundedExponentialBackoffMs,
  CONTEXT_STORE_OP_RETRY_CLASS,
  CONTEXT_STORE_RPC_BACKPRESSURE,
  CONTEXT_STORE_RPC_ERROR,
  CONTEXT_STORE_RPC_SELF_HEAL,
  CONTEXT_STORE_RPC_TIMEOUT_MS,
  CONTEXT_STORE_WORKER_DOWN_REASON,
  CONTEXT_STORE_WORKER_HEALTH,
  contextStoreOpRetryClass,
  defaultPriorityForOp,
  isFireAndForgetOp,
  type ContextStoreFireAndForgetOp,
  type ContextStoreWorkerDownReason,
  type ContextStoreWorkerHealth,
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
  /** the op this entry is for - needed to pick the right failure code when the
   *  generation dies with the request still in flight (retry-class policy). */
  op: ContextStoreRpcOp;
  /** true once `postMessage` returned without throwing, i.e. the worker MAY have
   *  observed (and applied) the request. A never-dispatched entry is always
   *  cleanly retryable; a dispatched unsafe-retry op is INDETERMINATE. */
  dispatched: boolean;
}

/** Point-in-time health of the context-store worker, for logs/diagnostics. */
export interface ContextStoreHealthSnapshot {
  state: ContextStoreWorkerHealth;
  /** monotonic generation counter; increments on every (re)spawn */
  generation: number;
  ready: boolean;
  /** consecutive awaited-RPC timeouts on the CURRENT generation */
  consecutiveTimeouts: number;
  /** consecutive timeout-driven respawns not yet cleared by a served op */
  consecutiveTimeoutRespawns: number;
  /** consecutive generations that died without serving a successful op */
  consecutiveWorkerFailures: number;
  /** why the last generation went down (null before the first failure) */
  lastDownReason: ContextStoreWorkerDownReason | null;
  /** generation awaiting confirmed exit, or null when nothing is retiring */
  retiringGeneration: number | null;
  /** true once the retiring generation was escalated to SIGKILL */
  retirementForced: boolean;
  /** ms until the next automatic rebuild attempt; 0 when a rebuild is due/live */
  retryInMs: number;
  pendingAwaited: number;
  pendingFireAndForget: number;
}

interface ContextStoreWorkerHandle {
  unref(): void;
  on(event: 'message', listener: (msg: unknown) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  postMessage(message: ContextStoreRpcRequest): void;
  terminate(): Promise<number>;
  /** Optional so an injected test double may omit it; production always has it. */
  forceKill?(): void;
}

type ContextStoreWorkerFactory = (url: URL) => ContextStoreWorkerHandle;

export interface CallOptions {
  priority?: ContextStoreRpcPriority;
  /** Override the per-RPC timeout (ms). `0` disables the timeout. */
  timeoutMs?: number;
}

const { maxAwaitedPending, maxFireAndForgetPending } = CONTEXT_STORE_RPC_BACKPRESSURE;
const {
  consecutiveTimeoutsBeforeRespawn,
  respawnCooldownMs,
  timeoutBackoffBaseMs,
  warmupBackoffBaseMs,
  warmupBackoffMaxMs,
  terminateConfirmMs,
  forceKillConfirmMs,
} = CONTEXT_STORE_RPC_SELF_HEAL;

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
  /** consecutive timeout-driven respawns with no successful op in between -
   *  drives the timeout-domain EXPONENTIAL backoff (base 1s, cap 60s). Reset by
   *  any ok response, exactly like `consecutiveTimeouts`. */
  private consecutiveTimeoutRespawns = 0;
  /** armed whenever there is no live generation and `started` - this is what
   *  makes recovery AUTOMATIC instead of "whenever the next request happens to
   *  arrive". Always unref'd so it never holds the daemon open. */
  private rebuildTimer: NodeJS.Timeout | null = null;
  private lastDownReason: ContextStoreWorkerDownReason | null = null;
  /**
   * A generation that has been retired but has NOT confirmed exit.
   *
   * SINGLE-OWNER INVARIANT. `terminate()` sends SIGTERM and only resolves on
   * the child's `exit`, so a child wedged inside a blocking SQLite call never
   * settles it. Retirement used to be fire-and-forget while the rebuild timer
   * armed independently, so once the backoff elapsed a NEW generation spawned
   * while the old OS process was still alive and still able to write the
   * database. Generation fencing only discards the old generation's IPC
   * replies - it cannot undo that process's side effects.
   *
   * While this is non-null and unconfirmed, NO new generation may be created.
   */
  private retirement: {
    generation: number;
    confirmed: boolean;
    forced: boolean;
    timer: NodeJS.Timeout | null;
  } | null = null;
  private lastHealthState: ContextStoreWorkerHealth | null = null;
  private healthObserver: ((snapshot: ContextStoreHealthSnapshot) => void) | null = null;
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

  /** Observe health-state TRANSITIONS (not every event) - the daemon wires a
   *  logger here so unhealthy -> backoff -> ready is visible in daemon.log. */
  setHealthObserver(fn: ((snapshot: ContextStoreHealthSnapshot) => void) | null): void {
    this.healthObserver = fn;
  }

  getHealthSnapshot(now = Date.now()): ContextStoreHealthSnapshot {
    return {
      state: this.healthState(now),
      generation: this.workerGeneration,
      ready: this.warmReady,
      consecutiveTimeouts: this.consecutiveTimeouts,
      consecutiveTimeoutRespawns: this.consecutiveTimeoutRespawns,
      consecutiveWorkerFailures: this.consecutiveWorkerFailures,
      lastDownReason: this.lastDownReason,
      retiringGeneration: this.retirementBlocksSpawn() ? this.retirement?.generation ?? null : null,
      retirementForced: this.retirement?.forced ?? false,
      retryInMs: this.retryDelayRemainingMs(now),
      pendingAwaited: this.awaitedCount,
      pendingFireAndForget: this.fireAndForgetCount,
    };
  }

  private healthState(now = Date.now()): ContextStoreWorkerHealth {
    if (this.disposed) return CONTEXT_STORE_WORKER_HEALTH.disposed;
    if (this.retirementBlocksSpawn()) return CONTEXT_STORE_WORKER_HEALTH.retiring;
    if (!this.started && !this.worker) return CONTEXT_STORE_WORKER_HEALTH.idle;
    if (this.worker) {
      return this.warmReady ? CONTEXT_STORE_WORKER_HEALTH.ready : CONTEXT_STORE_WORKER_HEALTH.starting;
    }
    return this.isRespawnThrottled(now)
      ? CONTEXT_STORE_WORKER_HEALTH.backoff
      : CONTEXT_STORE_WORKER_HEALTH.unhealthy;
  }

  /** Emit only on a state CHANGE so a hot loop cannot spam the log. */
  private notifyHealth(): void {
    const observer = this.healthObserver;
    const snapshot = this.getHealthSnapshot();
    if (snapshot.state === this.lastHealthState) return;
    this.lastHealthState = snapshot.state;
    if (!observer) return;
    try {
      observer(snapshot);
    } catch {
      /* an observer must never break the store path */
    }
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

  constructor(
    private readonly createWorker: ContextStoreWorkerFactory = (url) => spawnChildProcessWorker(url),
  ) {}

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
    if (this.retirementBlocksSpawn()) return Promise.resolve();
    this.ensureWorker();
    return this.readyPromise ?? Promise.resolve();
  }

  /** True while a retired generation has not confirmed exit. Spawning here
   *  would create a second DB owner, so every spawn path must consult this. */
  private retirementBlocksSpawn(): boolean {
    return this.retirement !== null && !this.retirement.confirmed;
  }

  /** Open the retirement gate for `generation` and drive bounded termination.
   *
   *  Graceful SIGTERM first; if exit is not confirmed within
   *  `terminateConfirmMs` escalate to SIGKILL; if even `forceKillConfirmMs`
   *  after that brings no confirmation, stay closed (fail-closed) rather than
   *  risk two owners. */
  private beginRetirement(generation: number, dead: ContextStoreWorkerHandle): void {
    const entry: { generation: number; confirmed: boolean; forced: boolean; timer: NodeJS.Timeout | null } = {
      generation,
      confirmed: false,
      forced: false,
      timer: null,
    };
    this.retirement = entry;

    const armTimer = (ms: number, onFire: () => void): void => {
      const timer = setTimeout(onFire, ms);
      if (typeof timer.unref === 'function') timer.unref();
      entry.timer = timer;
    };

    // `terminate()` resolving is one confirmation source; the handle's `exit`
    // event (wired in `ensureWorker`) is the other. Whichever arrives first.
    void dead.terminate().then(
      () => this.confirmRetirement(generation),
      () => {
        // A rejected terminate tells us nothing about the process, so it is NOT
        // a confirmation. The timers below remain the only escalation.
      },
    );

    armTimer(terminateConfirmMs, () => {
      if (entry.confirmed) return;
      entry.forced = true;
      try {
        dead.forceKill?.();
      } catch {
        /* nothing else to try */
      }
      this.notifyHealth();
      armTimer(forceKillConfirmMs, () => {
        if (entry.confirmed) return;
        // Deliberately NOT confirmed: the old process may still hold the DB, so
        // the client stays unavailable instead of creating a second owner.
        this.notifyHealth();
      });
    });
  }

  /** Called by the handle's `exit` event and by a settled `terminate()`. */
  private confirmRetirement(generation: number): void {
    const entry = this.retirement;
    if (!entry || entry.generation !== generation || entry.confirmed) return;
    entry.confirmed = true;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    this.retirement = null;
    this.notifyHealth();
    // Only now may the next generation be created. `maybeRespawn` spawns at
    // once when no throttle applies, and otherwise re-arms the bounded rebuild.
    this.maybeRespawn();
  }

  // ── Worker lifecycle ───────────────────────────────────────────────────────
  /** Returns null when a spawn is not permitted right now (retirement gate). */
  private ensureWorker(): ContextStoreWorkerHandle | null {
    if (this.worker) return this.worker;
    if (this.retirementBlocksSpawn()) return null;
    this.clearRebuildTimer();
    this.warmReady = false;
    this.generationServedOk = false; // new generation: must re-prove health via a served op
    // A FRESH generation starts with a clean timeout strike count. Without this
    // the >=3 strikes that killed the previous generation carried over, so the
    // very FIRST slow RPC on the new worker tripped `respawn()` again - a
    // permanent tear-down loop that never reached a served op (the field
    // "no reliable bounded generation recovery"). The escalating
    // `consecutiveTimeoutRespawns` counter (NOT this one) is what remembers that
    // the previous generations were sick.
    this.consecutiveTimeouts = 0;
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
    const generation = ++this.workerGeneration;
    const workerUrl = new URL('./context-store-worker-bootstrap.mjs', import.meta.url);
    const worker = this.createWorker(workerUrl);
    // Don't keep the daemon process alive solely for this child process.
    worker.unref();
    worker.on('message', (msg: unknown) => this.onMessage(msg, generation));
    worker.on('error', (err) =>
      this.markWorkerUnavailable(
        generation,
        new ContextStoreError(CONTEXT_STORE_RPC_ERROR.workerError, err instanceof Error ? err.message : String(err)),
        { reason: CONTEXT_STORE_WORKER_DOWN_REASON.workerError },
      ),
    );
    worker.on('exit', () => {
      // Authoritative confirmation that this generation's process is gone. Must
      // run even when the generation is no longer current, because that is
      // exactly the retiring case the gate is waiting on.
      this.confirmRetirement(generation);
    });
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
    this.notifyHealth();
    return worker;
  }

  // ── Automatic bounded rebuild ──────────────────────────────────────────────
  private clearRebuildTimer(): void {
    if (!this.rebuildTimer) return;
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = null;
  }

  /** ms remaining before a rebuild is allowed - the max of both independent
   *  throttles, so the timer fires exactly when the last one clears. */
  private retryDelayRemainingMs(now = Date.now()): number {
    if (this.disposed || this.worker) return 0;
    let remaining = 0;
    if (this.lastRespawnAt > 0) {
      remaining = Math.max(remaining, this.timeoutBackoffMs() - (now - this.lastRespawnAt));
    }
    if (this.consecutiveWorkerFailures > 1) {
      remaining = Math.max(remaining, this.warmupBackoffMs() - (now - this.lastWorkerFailureAt));
    }
    return Math.max(0, remaining);
  }

  /** Arm the automatic rebuild. This is the core of "the memory worker must
   *  recover by itself": previously a respawn only happened if some caller
   *  happened to issue another request after the throttle expired, so a quiet
   *  period left the store down indefinitely. */
  private scheduleRebuild(): void {
    if (this.disposed || !this.started || this.worker) return;
    // A retirement in flight must not be raced by a rebuild; `confirmRetirement`
    // re-arms this once the old process is provably gone.
    if (this.retirementBlocksSpawn()) return;
    if (this.rebuildTimer) return;
    const delay = this.retryDelayRemainingMs();
    const timer = setTimeout(() => {
      this.rebuildTimer = null;
      if (this.disposed || !this.started || this.worker) return;
      if (this.retirementBlocksSpawn()) return; // re-armed by confirmRetirement
      if (this.isRespawnThrottled()) {
        this.scheduleRebuild(); // clock moved / another throttle armed meanwhile
        return;
      }
      this.ensureWorker();
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    this.rebuildTimer = timer;
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
    // A RETIRING generation stays "current" by number until its successor is
    // created (the successor is gated on confirmed exit), so the generation
    // check alone is not enough: a late `ready` from the process being killed
    // would otherwise flip `warmReady` back on with no live handle behind it.
    // Late signals from a retired generation are inert by contract.
    if (this.retirement?.generation === generation) return;
    if (!this.worker) return;
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
      // The starting -> ready handshake is the recovery signal operators look
      // for in daemon.log; without this the observer only ever saw the failure
      // half of the cycle.
      this.notifyHealth();
      return;
    }
    const res = msg as ContextStoreRpcResponse;
    if (typeof res.id !== 'number') return;
    const entry = this.pending.get(res.id);
    if (!entry) return; // late-response discard (already timed out / settled)
    this.finish(res.id, entry);
    if (res.ok) {
      this.consecutiveTimeouts = 0;
      // A served op also clears the timeout-respawn ESCALATION and its cooldown
      // anchor, so a worker that recovered is not still treated as sick.
      this.consecutiveTimeoutRespawns = 0;
      this.lastRespawnAt = 0;
      // Served ≥1 successful op → worker is genuinely healthy: clear the
      // warmup/crash backoff (reaching `ready` alone is NOT enough).
      this.consecutiveWorkerFailures = 0;
      this.generationServedOk = true;
      this.notifyHealth();
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
    if (reason !== CONTEXT_STORE_WORKER_DOWN_REASON.dispose) this.lastDownReason = reason;
    const dead = this.worker;
    this.worker = null;
    this.warmReady = false;
    this.settleReady();
    if (dead && options.terminate !== false) {
      // Gate the next generation on confirmed exit instead of firing and
      // forgetting - see `retirement`.
      this.beginRetirement(generation ?? this.workerGeneration, dead);
    }
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(this.pendingFailureFor(entry, err));
    }
    this.awaitedCount = 0;
    this.fireAndForgetCount = 0;
    this.scheduleRebuild();
    this.notifyHealth();
  }

  /** Failure handed to a pending RPC when its generation dies.
   *
   *  A request that was never dispatched is cleanly retryable, and so is a
   *  dispatched read/idempotent write. A DISPATCHED `unsafeRetry` op (append,
   *  lease/claim, commit bundle) has an UNKNOWN outcome - the worker may have
   *  committed it before dying - so it gets the distinct `indeterminate` code.
   *  Background callers requeue on `unavailable`/`timeout` but MUST NOT requeue
   *  `indeterminate`, which is what stops a worker crash from duplicating
   *  appends or double-consuming a usage-sync lease. */
  private pendingFailureFor(entry: PendingEntry, err: Error): Error {
    if (!entry.dispatched) return err;
    if (contextStoreOpRetryClass(entry.op) !== CONTEXT_STORE_OP_RETRY_CLASS.unsafeRetry) return err;
    return new ContextStoreError(
      CONTEXT_STORE_RPC_ERROR.indeterminate,
      `context-store op outcome unknown after worker loss: ${entry.op} (${err.message})`,
    );
  }

  /** Exponential backoff for the TIMEOUT fault domain: 1st respawn waits
   *  `timeoutBackoffBaseMs`, each further consecutive respawn doubles it, capped
   *  at `respawnCooldownMs`. Reset by any ok response.
   *
   *  Uses `boundedExponentialBackoffMs` rather than a shift: at respawn 23 the
   *  old `1000 << 22` wrapped to -100663296, which disabled the throttle instead
   *  of capping it. */
  private timeoutBackoffMs(): number {
    return boundedExponentialBackoffMs(
      timeoutBackoffBaseMs,
      this.consecutiveTimeoutRespawns,
      respawnCooldownMs,
    );
  }

  private isRespawnCoolingDown(now = Date.now()): boolean {
    return this.lastRespawnAt > 0 && now - this.lastRespawnAt < this.timeoutBackoffMs();
  }

  /** Exponential backoff for the warmup/crash fault domain. First failure → 0
   *  (immediate retry, preserving transient fast-recovery); 2nd+ → base*2^(n-2)
   *  capped at `warmupBackoffMaxMs`. */
  private warmupBackoffMs(): number {
    if (this.consecutiveWorkerFailures <= 1) return 0;
    // Same overflow hazard as the timeout domain: `500 << 23` wrapped negative
    // at failure 25.
    return boundedExponentialBackoffMs(
      warmupBackoffBaseMs,
      this.consecutiveWorkerFailures - 1,
      warmupBackoffMaxMs,
    );
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
    if (this.retirementBlocksSpawn()) return;
    if (this.isRespawnThrottled()) {
      // Still throttled: make sure the AUTOMATIC rebuild is armed so recovery
      // does not depend on another caller showing up later.
      this.scheduleRebuild();
      return;
    }
    this.ensureWorker();
  }

  private respawn(): void {
    const now = Date.now();
    if (this.isRespawnCoolingDown(now)) return;
    this.lastRespawnAt = now;
    this.consecutiveTimeoutRespawns += 1;
    // NOTE: `consecutiveTimeouts` is deliberately NOT reset here. It is owned by
    // the generation lifecycle and cleared in `ensureWorker()`; resetting it in
    // both places left the generation reset unreachable and hid the original
    // defect (strikes carrying into a fresh worker).
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
      entry.dispatched = true;
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
    // A timeout is NOT proof the op did not run - the worker may still be
    // executing it. Reads/idempotent writes keep the plain timeout code; a
    // dispatched unsafe-retry op becomes `indeterminate` so nobody replays it.
    entry.reject(
      this.pendingFailureFor(
        entry,
        new ContextStoreError(CONTEXT_STORE_RPC_ERROR.timeout, `context-store RPC timed out: id ${id}`),
      ),
    );
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
    if (!worker) {
      // Retiring: the previous generation has not confirmed exit, so there is
      // deliberately no owner to dispatch to.
      return Promise.reject(new ContextStoreError(
        CONTEXT_STORE_RPC_ERROR.unavailable,
        `context-store worker retiring for op: ${op}`,
      ));
    }
    const id = this.nextId++;
    const priority = opts.priority ?? defaultPriorityForOp(op);
    const timeoutMs = opts.timeoutMs ?? CONTEXT_STORE_RPC_TIMEOUT_MS.r3r5Management;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => this.onTimeout(id), timeoutMs) : null;
      if (timer && typeof timer.unref === 'function') timer.unref();
      const entry: PendingEntry = {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        fireAndForget: false,
        op,
        dispatched: false,
      };
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
    if (!worker) return; // retiring: drop / coalesce
    const id = this.nextId++;
    const priority = defaultPriorityForOp(op);
    // Time the entry out so a lost response cannot leak a pending slot forever.
    const timer = setTimeout(() => this.onTimeout(id), CONTEXT_STORE_RPC_TIMEOUT_MS.r4Background);
    if (typeof timer.unref === 'function') timer.unref();
    const entry: PendingEntry = {
      resolve: () => {},
      reject: () => {},
      timer,
      fireAndForget: true,
      op,
      dispatched: false,
    };
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
    this.clearRebuildTimer();
    // The retirement escalation is deliberately LEFT RUNNING: the child must
    // still be terminated/killed. Nothing can spawn because `disposed` gates
    // every spawn path, and the escalation timers are unref'd.
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
