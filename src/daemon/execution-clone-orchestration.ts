/**
 * Orchestrator-programmatic execution-clone worker pool.
 *
 * When dedicated execution routing is enabled with a valid template, an
 * execution entry point (Team final-execution, OpenSpec implementation, Auto
 * Deliver implementation, generic execution) decomposes its work into one or
 * more {@link WorkerTask}s and hands them to {@link orchestrateCloneWorkers}.
 * The helper:
 *
 *  1. creates at most `pref.maxParallelClones` CONCURRENT clones PER
 *     `parentRunId` (a fixed runner pool of that size IS the concurrency cap;
 *     {@link createExecutionClone} additionally enforces the same cap
 *     daemon-atomically as a backstop against racing paths);
 *  2. QUEUES the remaining tasks (bounded by `pref.maxQueuedClones`) and
 *     dispatches each queued task onto a freed slot as a running clone
 *     completes — it NEVER exceeds the cap and NEVER silently drops queued
 *     work;
 *  3. dispatches each task's prompt to its clone via the injected `dispatch`;
 *  4. collects the result via the injected `collect`;
 *  5. DESTROYS every clone it created — on completion, failure, OR timeout —
 *     via an eager per-worker destroy in each worker's `finally` (the
 *     creator-gone orphan sweep is the daemon GC backstop, not this helper).
 *
 * Fail-closed: if the template is invalid/missing, {@link createExecutionClone}
 * throws an {@link ExecutionCloneError} which propagates unchanged. There is NO
 * fallback to running the work in the orchestrator session — the caller
 * surfaces a reselect-required error. (A `capacity_full` create rejection while
 * the queue still has room is recoverable: the task is re-queued and retried on
 * the next freed slot rather than aborting the whole batch.)
 *
 * `dispatch`, `collect`, and the `now()` clock are INJECTED so this module is
 * deterministic and unit-testable without real sub-sessions, timers, or panes.
 * The side-effecting create/destroy delegate to the shared
 * `./execution-clone.js` surface (which is mocked in tests).
 */

import {
  createExecutionClone,
  destroyExecutionClone,
  countActiveExecutionClones,
  ExecutionCloneError,
} from './execution-clone.js';
import {
  EXECUTION_CLONE_ERROR_CODES,
  EXECUTION_CLONE_TERMINAL_REASONS,
  parseDedicatedExecutionRoutingPreference,
  type ExecutionCloneParentStage,
  type DedicatedExecutionRoutingGlobalPreference,
} from '../../shared/execution-clone.js';
import logger from '../util/logger.js';

/** One unit of decomposed execution work routed to a single clone worker. */
export interface WorkerTask {
  /** Stable id for correlation in results/logs (e.g. a task index or label). */
  id: string;
  /** The worker hand-off prompt dispatched to the clone. */
  prompt: string;
}

/** Per-task outcome of running a worker on its clone. */
export type WorkerOutcome = 'completed' | 'failed' | 'timeout';

/** Result of orchestrating one worker task on its dedicated clone. */
export interface WorkerResult<TCollected = unknown> {
  taskId: string;
  /** The clone session target this task ran on (the create result's `target`). */
  cloneTarget: string;
  outcome: WorkerOutcome;
  /** Whatever the injected `collect` returned (marker, summary, etc.). */
  collected?: TCollected;
  /** Populated when `outcome !== 'completed'`. */
  error?: string;
}

/** A task that could not be admitted because the pending queue was already full. */
export interface CapacityRejection {
  taskId: string;
  reason: typeof EXECUTION_CLONE_ERROR_CODES.CAPACITY_FULL;
}

export interface OrchestrateCloneWorkersOptions<TCollected = unknown> {
  /** Parent run id — the cap-enforcement scope. */
  parentRunId: string;
  /** Execution entry-point stage owning the task semantics. */
  parentStage: ExecutionCloneParentStage;
  /** Template session each clone is copied from. */
  templateSessionName: string;
  /** Authorized creator (destroy authz anchor). */
  ownerSessionName: string;
  /** Owning main/orchestrator session (written as the clone's `parentSession`). */
  owningMainSessionName: string;
  /** Resolved routing preference (caps + timers). */
  pref: DedicatedExecutionRoutingGlobalPreference;
  /** Decomposed worker tasks. */
  tasks: WorkerTask[];
  /** Dispatch a task's prompt to its clone. Rejects on dispatch failure. */
  dispatch: (cloneTarget: string, prompt: string) => Promise<void>;
  /**
   * Collect a clone's result. Throwing is treated as a worker failure (the
   * clone is still destroyed). A `timeout` outcome is signalled by throwing a
   * {@link WorkerTimeoutError} (or returning via the optional `outcomeOf` hook).
   */
  collect: (cloneTarget: string) => Promise<TCollected>;
  /**
   * Optional classifier mapping a successfully-collected value to an outcome.
   * Defaults to `'completed'`. Lets a caller treat a collected failure/timeout
   * marker as a non-completed outcome WITHOUT throwing.
   */
  outcomeOf?: (collected: TCollected) => WorkerOutcome;
  /** Injected clock (defaults to {@link Date.now}). */
  now?: () => number;
}

export interface OrchestrateCloneWorkersResult<TCollected = unknown> {
  results: WorkerResult<TCollected>[];
  /** Clone targets created during this orchestration (in creation order). */
  createdClones: string[];
  /** Tasks rejected because the pending queue was full. */
  capacityRejections: CapacityRejection[];
}

/**
 * Throw from `collect` to signal that a worker timed out (vs. failed). The
 * clone is still destroyed; the result outcome is `'timeout'`.
 */
export class WorkerTimeoutError extends Error {
  constructor(message?: string) {
    super(message ?? 'execution clone worker timed out');
    this.name = 'WorkerTimeoutError';
  }
}

/** Terminal reason recorded when a worker clone is destroyed after collection. */
const TERMINAL_REASON_DESTROYED = EXECUTION_CLONE_TERMINAL_REASONS[3]; // 'destroyed'
const TERMINAL_REASON_HARD_TIMEOUT = EXECUTION_CLONE_TERMINAL_REASONS[2]; // 'hard_timeout'

/** True iff `err` is an {@link ExecutionCloneError} whose code is `capacity_full`. */
function isCapacityFull(err: unknown): err is ExecutionCloneError {
  return err instanceof ExecutionCloneError
    && err.code === EXECUTION_CLONE_ERROR_CODES.CAPACITY_FULL;
}

/**
 * Run a worker task pool over dedicated execution clones with bounded
 * parallelism + deterministic queueing.
 *
 * Concurrency invariant: at no point do more than `pref.maxParallelClones`
 * clones run concurrently for this `parentRunId`. The orchestrator admits a new
 * task only after a running slot frees, and re-checks the daemon-atomic cap via
 * the create call itself (which returns `capacity_full` if another path raced
 * in). Queue invariant: the pending queue never holds more than
 * `pref.maxQueuedClones` tasks; a task that cannot be queued because the queue
 * is full is recorded as a {@link CapacityRejection} (never silently dropped),
 * and every admitted task is eventually dispatched as a slot frees.
 *
 * Cleanup invariant: every clone this helper creates is destroyed before it
 * returns, regardless of per-task outcome (completion / failure / timeout) —
 * the `finally` of each worker performs the eager destroy, and a terminal
 * sweep destroys any clone whose worker never reached its own `finally`.
 */
export async function orchestrateCloneWorkers<TCollected = unknown>(
  opts: OrchestrateCloneWorkersOptions<TCollected>,
): Promise<OrchestrateCloneWorkersResult<TCollected>> {
  const now = opts.now ?? Date.now;
  // Normalize the preference BEFORE any pool/queue arithmetic. The `Math.max`
  // floors below are NOT NaN guards — `Math.max(1, NaN) === NaN`, which would
  // make `slice(0, NaN)` admit ZERO tasks (a silent no-op run) or let
  // `Infinity` over-admit. The shared parser is the single SSOT: it maps
  // NaN/missing/Infinity → the field default and clamps finite-out-of-bounds to
  // `[MIN,MAX]`, so every derived bound is finite. The `Math.max` floors are
  // kept only as harmless belt-and-suspenders.
  const pref = parseDedicatedExecutionRoutingPreference(opts.pref);
  const maxParallel = Math.max(1, pref.maxParallelClones);
  const maxQueued = Math.max(0, pref.maxQueuedClones);

  // Admission: the first `maxQueued + maxParallel` tasks are admitted to the
  // pending pool; any beyond that overflow the bounded queue and are rejected
  // up front with an explicit capacity reason (never silently dropped). The
  // "+ maxParallel" accounts for the slots that are actively running rather
  // than waiting in the queue, so a batch of exactly `maxParallel` tasks with a
  // zero-length queue is fully admitted.
  const admissionLimit = maxQueued + maxParallel;
  const admitted: WorkerTask[] = opts.tasks.slice(0, admissionLimit);
  const capacityRejections: CapacityRejection[] = opts.tasks
    .slice(admissionLimit)
    .map((task) => ({ taskId: task.id, reason: EXECUTION_CLONE_ERROR_CODES.CAPACITY_FULL }));

  const results: WorkerResult<TCollected>[] = [];
  const createdClones: string[] = [];
  // Liveness map: clone target → still-needs-destroy. A worker clears its own
  // entry in its `finally`; the terminal sweep destroys anything left set.
  const liveClones = new Map<string, boolean>();

  // Shared FIFO queue of admitted tasks. Bounded by construction
  // (`admitted.length <= maxQueued + maxParallel`). A fixed pool of at most
  // `maxParallel` runner coroutines drain it, so NO more than `maxParallel`
  // clones are ever in flight — the pool size IS the concurrency cap. A
  // `capacity_full` create rejection (daemon-atomic cap raced by another path)
  // pushes the task back so it is retried on the next freed slot, never dropped.
  const queue: WorkerTask[] = [...admitted];

  /** Concurrency-observability counter — peak simultaneous in-flight workers. */
  let inFlight = 0;
  let peakInFlight = 0;

  // Completion notifier: lets a runner that re-queued a `capacity_full` task
  // BLOCK until one of THIS pool's own workers finishes (freeing a slot), rather
  // than immediately retrying against an unchanged cap (a hot spin). Each
  // worker's `finally` calls `notifyCompletion()` after clearing its live entry.
  let completionWaiters: Array<() => void> = [];
  function notifyCompletion(): void {
    const waiters = completionWaiters;
    completionWaiters = [];
    for (const resolve of waiters) resolve();
  }
  /**
   * Resolve when the next own-pool worker completes. If nothing is in flight
   * there is no completion to await (blocking would deadlock), so yield a
   * microtask instead and let the bounded retry counter bound any spin.
   */
  function awaitNextCompletion(): Promise<void> {
    if (inFlight === 0) return Promise.resolve();
    return new Promise<void>((resolve) => { completionWaiters.push(resolve); });
  }

  /** Number of own-pool clones still live (created here, not yet destroyed). */
  function ownLiveCloneCount(): number {
    let n = 0;
    for (const live of liveClones.values()) if (live) n += 1;
    return n;
  }

  // Bounded per-task `capacity_full` retry counter (belt-and-suspenders): even
  // when a completion is awaited, a pathological repeated race is bounded so the
  // pool can never spin unboundedly on one task.
  const MAX_CAPACITY_REQUEUE_RETRIES = 3;
  const capacityRetries = new Map<string, number>();

  /**
   * Create → dispatch → collect → destroy ONE task on its own clone.
   *
   * Create errors: `capacity_full` re-queues the task (recoverable, never
   * dropped). ANY OTHER create error (invalid/missing template) propagates —
   * fail-closed, NO fallback to the orchestrator session. Dispatch/collect
   * failures are captured as a per-task `failed`/`timeout` outcome; the clone
   * is destroyed regardless in the `finally`.
   */
  async function runTask(task: WorkerTask): Promise<'done' | 'requeued'> {
    let created;
    try {
      created = await createExecutionClone({
        templateSessionName: opts.templateSessionName,
        parentRunId: opts.parentRunId,
        parentStage: opts.parentStage,
        ownerSessionName: opts.ownerSessionName,
        owningMainSessionName: opts.owningMainSessionName,
        pref,
      });
    } catch (err) {
      if (isCapacityFull(err)) {
        // Deadlock guard: if THIS pool owns ZERO in-flight/live clones AND the
        // per-parent-run cap is already at/over `maxParallel`, the cap is
        // consumed by clones OUTSIDE this pool that no runner here can free.
        // Retrying would busy-loop forever → fail closed with a typed error.
        const externallySaturated =
          inFlight === 0
          && ownLiveCloneCount() === 0
          && countActiveExecutionClones(opts.parentRunId) >= maxParallel;
        if (externallySaturated) {
          throw new ExecutionCloneError(
            EXECUTION_CLONE_ERROR_CODES.CAPACITY_EXTERNALLY_SATURATED,
            `Execution-clone pool for run ${opts.parentRunId} owns no in-flight slots `
              + `and the per-run cap (${maxParallel}) is saturated by external clones`,
          );
        }
        // Belt-and-suspenders: bound repeated `capacity_full` races on one task
        // so a pathological loop can never spin unboundedly.
        const retries = (capacityRetries.get(task.id) ?? 0) + 1;
        if (retries > MAX_CAPACITY_REQUEUE_RETRIES) {
          throw new ExecutionCloneError(
            EXECUTION_CLONE_ERROR_CODES.CAPACITY_EXTERNALLY_SATURATED,
            `Execution-clone task ${task.id} exceeded ${MAX_CAPACITY_REQUEUE_RETRIES} `
              + `capacity_full retries for run ${opts.parentRunId}`,
          );
        }
        capacityRetries.set(task.id, retries);
        // Recoverable race: a slot will free as an own-pool worker completes.
        // Re-queue (front) and let the runner BLOCK on the next completion (not
        // an immediate retry) so we never spin against an unchanged cap.
        queue.unshift(task);
        return 'requeued';
      }
      // Fail-closed: invalid/missing template (or any non-capacity create
      // failure) aborts the whole orchestration. No orchestrator fallback.
      throw err;
    }

    const cloneTarget = created.target;
    createdClones.push(cloneTarget);
    liveClones.set(cloneTarget, true);
    inFlight += 1;
    if (inFlight > peakInFlight) peakInFlight = inFlight;

    let outcome: WorkerOutcome = 'completed';
    let collected: TCollected | undefined;
    let errorMessage: string | undefined;
    try {
      await opts.dispatch(cloneTarget, task.prompt);
      collected = await opts.collect(cloneTarget);
      outcome = opts.outcomeOf ? opts.outcomeOf(collected) : 'completed';
    } catch (err) {
      outcome = err instanceof WorkerTimeoutError ? 'timeout' : 'failed';
      errorMessage = err instanceof Error ? err.message : String(err);
    } finally {
      inFlight -= 1;
      // Eager destroy: every created clone is torn down regardless of outcome.
      const reason = outcome === 'timeout'
        ? TERMINAL_REASON_HARD_TIMEOUT
        : TERMINAL_REASON_DESTROYED;
      await destroyExecutionClone({
        target: cloneTarget,
        reason,
        callerSessionName: opts.ownerSessionName,
      }).catch((destroyErr) => {
        logger.warn(
          { cloneTarget, parentRunId: opts.parentRunId, err: destroyErr },
          'Execution-clone worker destroy failed; terminal sweep will retry',
        );
      });
      liveClones.set(cloneTarget, false);
      // This worker freed its slot — wake any runner blocked on a `capacity_full`
      // re-queue so it can retry now that an own-pool clone has been released.
      notifyCompletion();
    }

    // This task ran to completion — clear any prior capacity-race retry count.
    capacityRetries.delete(task.id);
    results.push({
      taskId: task.id,
      cloneTarget,
      outcome,
      ...(collected !== undefined ? { collected } : {}),
      ...(errorMessage !== undefined ? { error: errorMessage } : {}),
    });
    return 'done';
  }

  /**
   * One runner coroutine: pull the next task and process it until the queue is
   * drained. A `capacity_full` re-queue yields to the event loop so the freeing
   * runner can persist its destroy before this runner retries the same task —
   * preventing a hot spin against the cap.
   */
  async function runner(): Promise<void> {
    for (;;) {
      const task = queue.shift();
      if (task === undefined) return;
      const r = await runTask(task);
      if (r === 'requeued') {
        // The cap was momentarily full (a racing path holds slots). Rather than
        // immediately retrying against an unchanged cap (a hot spin), BLOCK
        // until one of this pool's own workers completes and frees a slot. If
        // nothing is in flight, `awaitNextCompletion` resolves immediately and
        // the bounded retry counter (+ the externally-saturated guard in
        // `runTask`) prevents any unbounded loop.
        await awaitNextCompletion();
      }
    }
  }

  const poolSize = Math.min(maxParallel, Math.max(1, admitted.length));
  const runners: Promise<void>[] = [];
  for (let i = 0; i < poolSize; i += 1) runners.push(runner());

  let fatalError: unknown;
  try {
    await Promise.all(runners);
  } catch (err) {
    // Fail-closed create error from one runner — stop admitting new work and
    // let the others settle so their clones reach the terminal sweep below.
    fatalError = err;
    await Promise.allSettled(runners);
  }

  // Terminal sweep: destroy any clone whose worker did not reach its own
  // `finally` (e.g. a fail-closed throw between create and the inner try).
  // Idempotent — already-torn clones are marked false and skipped.
  for (const [target, live] of liveClones) {
    if (!live) continue;
    await destroyExecutionClone({
      target,
      reason: TERMINAL_REASON_DESTROYED,
      callerSessionName: opts.ownerSessionName,
    }).catch((destroyErr) => {
      logger.warn(
        { cloneTarget: target, parentRunId: opts.parentRunId, err: destroyErr },
        'Execution-clone terminal sweep destroy failed',
      );
    });
    liveClones.set(target, false);
  }

  // Defensive cap assertion — the pool size guarantees this, but a regression
  // in the runner accounting would surface loudly rather than silently
  // over-running the host. `now` is referenced so the injected clock is part of
  // the helper's signature for callers that need deterministic time.
  if (peakInFlight > maxParallel) {
    logger.error(
      { parentRunId: opts.parentRunId, peakInFlight, maxParallel, at: now() },
      'Execution-clone orchestration exceeded the per-run parallelism cap',
    );
  }

  if (fatalError !== undefined) throw fatalError;

  return { results, createdClones, capacityRejections };
}
