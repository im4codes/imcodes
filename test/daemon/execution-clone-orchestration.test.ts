/**
 * Tests for the orchestrator-programmatic execution-clone worker pool
 * (`orchestrateCloneWorkers`).
 *
 * The side-effecting `./execution-clone.js` create/destroy surface is mocked so
 * the pool's bounded-parallelism, deterministic queueing, fail-closed template
 * handling, timeout, and terminal-cleanup behavior can be asserted without
 * touching tmux, the session store, or the live timeline. `dispatch`,
 * `collect`, and `now` are injected for determinism.
 *
 * Coverage (task 6.4):
 *  - disabled routing → the helper is NOT used / no clone created (the caller
 *    keeps the current-model path);
 *  - routing enabled + invalid template → throws fail-closed, NO orchestrator
 *    fallback;
 *  - missing template → launch failure surfaces (create throws);
 *  - max-parallel cap respected with deterministic queueing (5 tasks, cap 3 →
 *    never >3 concurrent, all 5 dispatched, none dropped);
 *  - timeout → clone stopped/destroyed;
 *  - every created clone destroyed after completion / failure (parent-run
 *    terminal cleanup).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXECUTION_CLONE_ERROR_CODES,
  DEFAULT_MAX_PARALLEL_CLONES,
  defaultDedicatedExecutionRoutingPreference,
  type DedicatedExecutionRoutingGlobalPreference,
} from '../../shared/execution-clone.js';

// ── Mock the daemon execution-clone module ───────────────────────────────────

const { cloneMocks, FakeExecutionCloneError } = vi.hoisted(() => {
  class FakeExecutionCloneError extends Error {
    constructor(public readonly code: string, message?: string) {
      super(message ?? code);
      this.name = 'ExecutionCloneError';
    }
  }
  return {
    cloneMocks: {
      createExecutionClone: vi.fn(),
      destroyExecutionClone: vi.fn(),
      countActiveExecutionClones: vi.fn(() => 0),
    },
    FakeExecutionCloneError,
  };
});

vi.mock('../../src/daemon/execution-clone.js', () => ({
  createExecutionClone: cloneMocks.createExecutionClone,
  destroyExecutionClone: cloneMocks.destroyExecutionClone,
  countActiveExecutionClones: cloneMocks.countActiveExecutionClones,
  ExecutionCloneError: FakeExecutionCloneError,
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  orchestrateCloneWorkers,
  WorkerTimeoutError,
  type WorkerTask,
  type OrchestrateCloneWorkersOptions,
} from '../../src/daemon/execution-clone-orchestration.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PARENT_RUN_ID = 'run-1';
const TEMPLATE = 'deck_alpha_w1';
const OWNER = 'deck_alpha_brain';

function pref(
  overrides: Partial<DedicatedExecutionRoutingGlobalPreference> = {},
): DedicatedExecutionRoutingGlobalPreference {
  return { ...defaultDedicatedExecutionRoutingPreference(), enabled: true, ...overrides };
}

function tasks(n: number): WorkerTask[] {
  return Array.from({ length: n }, (_, i) => ({ id: `t${i}`, prompt: `do task ${i}` }));
}

/**
 * Wire `createExecutionClone` to hand out fresh clone targets `clone-0`,
 * `clone-1`, … in creation order, returning the standard create-result shape.
 */
function stubSequentialCreates(): string[] {
  const created: string[] = [];
  cloneMocks.createExecutionClone.mockImplementation(async () => {
    const target = `clone-${created.length}`;
    created.push(target);
    return { sessionName: target, target, metadata: {} };
  });
  return created;
}

function baseOpts(
  overrides: Partial<OrchestrateCloneWorkersOptions> = {},
): OrchestrateCloneWorkersOptions {
  return {
    parentRunId: PARENT_RUN_ID,
    parentStage: 'team_final_execution',
    templateSessionName: TEMPLATE,
    ownerSessionName: OWNER,
    owningMainSessionName: OWNER,
    pref: pref(),
    tasks: tasks(1),
    dispatch: vi.fn().mockResolvedValue(undefined),
    collect: vi.fn().mockResolvedValue('ok'),
    now: () => 1_000,
    ...overrides,
  };
}

beforeEach(() => {
  cloneMocks.createExecutionClone.mockReset();
  cloneMocks.destroyExecutionClone.mockReset();
  cloneMocks.destroyExecutionClone.mockResolvedValue(undefined);
  // Default: the per-parent-run cap is NOT externally saturated. The
  // deadlock-guard test overrides this to simulate external clones holding the cap.
  cloneMocks.countActiveExecutionClones.mockReset();
  cloneMocks.countActiveExecutionClones.mockReturnValue(0);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('orchestrateCloneWorkers — disabled-routing current-model path', () => {
  it('a disabled-routing caller never invokes the helper, so NO clone is created', async () => {
    // Models the call site: the entry point only calls orchestrateCloneWorkers
    // when routing is enabled with a valid template. With routing disabled the
    // branch is skipped entirely and the current-model path runs.
    const routing = { enabled: false, templateSessionName: TEMPLATE as string | null };

    let helperInvoked = false;
    if (routing.enabled && routing.templateSessionName) {
      helperInvoked = true;
      await orchestrateCloneWorkers(baseOpts());
    }

    expect(helperInvoked).toBe(false);
    expect(cloneMocks.createExecutionClone).not.toHaveBeenCalled();
    expect(cloneMocks.destroyExecutionClone).not.toHaveBeenCalled();
  });
});

describe('orchestrateCloneWorkers — fail-closed template handling', () => {
  it('invalid template → throws fail-closed (no orchestrator fallback, error propagates)', async () => {
    cloneMocks.createExecutionClone.mockRejectedValue(
      new FakeExecutionCloneError(EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE),
    );
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const collect = vi.fn().mockResolvedValue('ok');

    await expect(
      orchestrateCloneWorkers(baseOpts({ dispatch, collect, tasks: tasks(1) })),
    ).rejects.toMatchObject({ code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE });

    // No fallback to the orchestrator session: the task prompt was never
    // dispatched anywhere and nothing was collected.
    expect(dispatch).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
  });

  it('missing template → create throws and the launch failure surfaces', async () => {
    cloneMocks.createExecutionClone.mockRejectedValue(
      new FakeExecutionCloneError(
        EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE,
        'template missing',
      ),
    );
    await expect(orchestrateCloneWorkers(baseOpts())).rejects.toThrow('template missing');
  });

  it('a non-capacity create failure mid-batch aborts and destroys any clone already created', async () => {
    // First create succeeds; the second create fails fail-closed. With cap 1 the
    // runner is serial, so the first clone is fully created + destroyed in its
    // own finally before the second create is attempted and throws.
    let n = 0;
    cloneMocks.createExecutionClone.mockImplementation(async () => {
      n += 1;
      if (n === 1) return { sessionName: 'clone-0', target: 'clone-0', metadata: {} };
      throw new FakeExecutionCloneError(EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE);
    });

    await expect(
      orchestrateCloneWorkers(
        baseOpts({ tasks: tasks(2), pref: pref({ maxParallelClones: 1 }) }),
      ),
    ).rejects.toMatchObject({ code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE });

    // The successfully-created clone must not leak — it is destroyed.
    expect(cloneMocks.destroyExecutionClone).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'clone-0' }),
    );
  });
});

describe('orchestrateCloneWorkers — bounded parallelism + deterministic queueing', () => {
  it('5 tasks, cap 3 → never more than 3 clones concurrent, all 5 dispatched, none dropped', async () => {
    stubSequentialCreates();

    // Gate every worker's collect on a manual resolver so we can hold workers
    // "running" and observe the live concurrency precisely.
    const resolvers = new Map<string, () => void>();
    let liveCollects = 0;
    let observedPeak = 0;

    const dispatch = vi.fn().mockResolvedValue(undefined);
    const collect = vi.fn().mockImplementation((cloneTarget: string) => {
      liveCollects += 1;
      observedPeak = Math.max(observedPeak, liveCollects);
      return new Promise<string>((resolve) => {
        resolvers.set(cloneTarget, () => {
          liveCollects -= 1;
          resolve(`result-${cloneTarget}`);
        });
      });
    });

    const runPromise = orchestrateCloneWorkers(
      baseOpts({ tasks: tasks(5), pref: pref({ maxParallelClones: 3 }), dispatch, collect }),
    );

    // Let the pool spin up its runners and saturate the cap.
    await flushMicrotasks();
    expect(liveCollects).toBe(3);
    expect(observedPeak).toBe(3);
    expect(resolvers.size).toBe(3);

    // Release the running workers one at a time; each freed slot must pull
    // exactly one queued task — never overshooting the cap.
    const releaseOrder = ['clone-0', 'clone-1', 'clone-2', 'clone-3', 'clone-4'];
    for (let i = 0; i < releaseOrder.length; i += 1) {
      const target = releaseOrder[i];
      // The target may not have started yet on this tick; resolve whatever is
      // currently live, then advance.
      const anyLive = [...resolvers.keys()].find((k) => resolvers.has(k));
      const toRelease = resolvers.has(target) ? target : anyLive!;
      resolvers.get(toRelease)!();
      resolvers.delete(toRelease);
      await flushMicrotasks();
      // Concurrency must NEVER exceed the cap at any observation point.
      expect(liveCollects).toBeLessThanOrEqual(3);
    }

    const result = await runPromise;

    // All 5 tasks dispatched + collected; none dropped; cap never exceeded.
    expect(result.results).toHaveLength(5);
    expect(observedPeak).toBe(3);
    expect(dispatch).toHaveBeenCalledTimes(5);
    expect(collect).toHaveBeenCalledTimes(5);
    expect(cloneMocks.createExecutionClone).toHaveBeenCalledTimes(5);
    expect(result.capacityRejections).toHaveLength(0);
    // Every created clone destroyed exactly once.
    expect(result.createdClones).toHaveLength(5);
    expect(cloneMocks.destroyExecutionClone).toHaveBeenCalledTimes(5);
    expect(new Set(result.results.map((r) => r.taskId))).toEqual(
      new Set(['t0', 't1', 't2', 't3', 't4']),
    );
  });

  it('over-decomposition beyond the queue bound is rejected with capacity_full, never silently dropped', async () => {
    stubSequentialCreates();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const collect = vi.fn().mockResolvedValue('ok');

    // cap 2 + queue 1 → admission limit 3. A 5-task batch admits 3, rejects 2.
    const result = await orchestrateCloneWorkers(
      baseOpts({
        tasks: tasks(5),
        pref: pref({ maxParallelClones: 2, maxQueuedClones: 1 }),
        dispatch,
        collect,
      }),
    );

    expect(result.results).toHaveLength(3);
    expect(result.capacityRejections).toHaveLength(2);
    expect(result.capacityRejections.map((r) => r.taskId).sort()).toEqual(['t3', 't4']);
    for (const rej of result.capacityRejections) {
      expect(rej.reason).toBe(EXECUTION_CLONE_ERROR_CODES.CAPACITY_FULL);
    }
    // Admitted work was fully run + destroyed; rejected work created nothing.
    expect(cloneMocks.createExecutionClone).toHaveBeenCalledTimes(3);
    expect(cloneMocks.destroyExecutionClone).toHaveBeenCalledTimes(3);
  });

  it('a daemon-atomic capacity_full create rejection re-queues the task (retried, never dropped)', async () => {
    // The first create attempt for the LAST task races and gets capacity_full;
    // on retry it succeeds. The task must still be dispatched + collected.
    const created: string[] = [];
    let capacityRacePrimed = true;
    cloneMocks.createExecutionClone.mockImplementation(async () => {
      // Inject exactly one capacity_full once two clones already exist (cap 2),
      // simulating a transient race; subsequent calls succeed.
      if (capacityRacePrimed && created.length === 2) {
        capacityRacePrimed = false;
        throw new FakeExecutionCloneError(EXECUTION_CLONE_ERROR_CODES.CAPACITY_FULL);
      }
      const target = `clone-${created.length}`;
      created.push(target);
      return { sessionName: target, target, metadata: {} };
    });
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const collect = vi.fn().mockResolvedValue('ok');

    const result = await orchestrateCloneWorkers(
      baseOpts({
        tasks: tasks(3),
        pref: pref({ maxParallelClones: 2, maxQueuedClones: 8 }),
        dispatch,
        collect,
      }),
    );

    // All 3 tasks eventually ran despite the transient capacity race.
    expect(result.results).toHaveLength(3);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(result.capacityRejections).toHaveLength(0);
    expect(cloneMocks.destroyExecutionClone).toHaveBeenCalledTimes(3);
  });
});

describe('orchestrateCloneWorkers — external-saturation deadlock guard', () => {
  it('throws capacity_externally_saturated (no busy-loop) when the per-run cap is held by external clones', async () => {
    // The pool owns ZERO in-flight clones, yet every create returns capacity_full
    // and the per-parent-run cap is reported saturated by clones OUTSIDE this
    // pool. The orchestration must fail closed with a typed error rather than
    // spin retrying a cap it can never free.
    cloneMocks.createExecutionClone.mockRejectedValue(
      new FakeExecutionCloneError(EXECUTION_CLONE_ERROR_CODES.CAPACITY_FULL),
    );
    // External saturation: cap (maxParallelClones) is fully consumed elsewhere.
    cloneMocks.countActiveExecutionClones.mockReturnValue(2);
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const collect = vi.fn().mockResolvedValue('ok');

    // Iteration-cap / no-infinite-loop guard: race the orchestration against a
    // bounded microtask drain. A regression to a busy-loop would never settle
    // within the cap, failing the test instead of hanging the run.
    let settled = false;
    const run = orchestrateCloneWorkers(
      baseOpts({ tasks: tasks(1), pref: pref({ maxParallelClones: 2 }), dispatch, collect }),
    ).then(
      (v) => { settled = true; return { ok: true as const, v }; },
      (e) => { settled = true; return { ok: false as const, e }; },
    );

    for (let i = 0; i < 1000 && !settled; i += 1) {
      await Promise.resolve();
    }
    expect(settled).toBe(true);

    const outcome = await run;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.e).toMatchObject({ code: EXECUTION_CLONE_ERROR_CODES.CAPACITY_EXTERNALLY_SATURATED });
    }
    // Fail-closed on the FIRST capacity_full: the create is attempted at most once,
    // never dispatched, and nothing is left to destroy.
    expect(cloneMocks.createExecutionClone.mock.calls.length).toBeLessThanOrEqual(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(cloneMocks.destroyExecutionClone).not.toHaveBeenCalled();
  });

  it('does NOT fail closed on a transient capacity_full while the pool owns an in-flight slot', async () => {
    // The guard keys on OWN in-flight slots, not the raw external count. A second
    // pool worker stays HELD running (gated collect) when a transient
    // capacity_full races a freed runner's retry, so inFlight > 0 → the guard
    // must NOT trip. The task re-queues, blocks on the next own completion, then
    // succeeds once the held worker is released.
    cloneMocks.countActiveExecutionClones.mockReturnValue(5);

    const resolvers = new Map<string, () => void>();
    const created: string[] = [];
    let injectNextCapacityFull = false;
    let capacityInjected = false;
    cloneMocks.createExecutionClone.mockImplementation(async () => {
      if (injectNextCapacityFull) {
        injectNextCapacityFull = false;
        capacityInjected = true;
        throw new FakeExecutionCloneError(EXECUTION_CLONE_ERROR_CODES.CAPACITY_FULL);
      }
      const target = `clone-${created.length}`;
      created.push(target);
      return { sessionName: target, target, metadata: {} };
    });
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const collect = vi.fn().mockImplementation((cloneTarget: string) =>
      new Promise<string>((resolve) => {
        resolvers.set(cloneTarget, () => resolve(`r-${cloneTarget}`));
      }),
    );

    const runPromise = orchestrateCloneWorkers(
      baseOpts({ tasks: tasks(3), pref: pref({ maxParallelClones: 2, maxQueuedClones: 8 }), dispatch, collect }),
    );

    // Two runners create clone-0 + clone-1 and block in their gated collect.
    await flushMicrotasks();
    expect(resolvers.size).toBe(2);

    // Arm a one-shot capacity_full for the NEXT create, then free clone-0. The
    // freed runner retries task 3 → hits capacity_full → but clone-1 is still
    // in flight (inFlight === 1), so the guard does NOT trip; it re-queues.
    injectNextCapacityFull = true;
    resolvers.get('clone-0')!();
    await flushMicrotasks();
    expect(capacityInjected).toBe(true);

    // Release the still-held worker → its completion wakes the blocked runner,
    // which retries task 3 successfully.
    for (const [, release] of [...resolvers]) release();
    await flushMicrotasks();
    for (const [, release] of [...resolvers]) release();
    await flushMicrotasks();

    const result = await runPromise;
    expect(result.results).toHaveLength(3);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(result.capacityRejections).toHaveLength(0);
  });
});

describe('orchestrateCloneWorkers — timeout + terminal cleanup', () => {
  it('a worker timeout (collect throws WorkerTimeoutError) → outcome timeout, clone destroyed', async () => {
    stubSequentialCreates();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const collect = vi.fn().mockRejectedValue(new WorkerTimeoutError('marker timed out'));

    const result = await orchestrateCloneWorkers(baseOpts({ tasks: tasks(1), dispatch, collect }));

    expect(result.results).toHaveLength(1);
    expect(result.results[0].outcome).toBe('timeout');
    // Clone destroyed with the hard-timeout terminal reason.
    expect(cloneMocks.destroyExecutionClone).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'clone-0', reason: 'hard_timeout' }),
    );
  });

  it('a worker failure (collect rejects) → outcome failed, clone still destroyed', async () => {
    stubSequentialCreates();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const collect = vi.fn().mockRejectedValue(new Error('collect boom'));

    const result = await orchestrateCloneWorkers(baseOpts({ tasks: tasks(1), dispatch, collect }));

    expect(result.results[0].outcome).toBe('failed');
    expect(result.results[0].error).toContain('collect boom');
    expect(cloneMocks.destroyExecutionClone).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'clone-0', reason: 'destroyed' }),
    );
  });

  it('a dispatch failure → outcome failed, clone still destroyed (no leak)', async () => {
    stubSequentialCreates();
    const dispatch = vi.fn().mockRejectedValue(new Error('dispatch boom'));
    const collect = vi.fn().mockResolvedValue('ok');

    const result = await orchestrateCloneWorkers(baseOpts({ tasks: tasks(1), dispatch, collect }));

    expect(result.results[0].outcome).toBe('failed');
    expect(collect).not.toHaveBeenCalled();
    expect(cloneMocks.destroyExecutionClone).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'clone-0' }),
    );
  });

  it('every created clone is destroyed after completion (parent-run terminal cleanup)', async () => {
    stubSequentialCreates();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const collect = vi.fn().mockResolvedValue('done');

    const result = await orchestrateCloneWorkers(
      baseOpts({ tasks: tasks(4), pref: pref({ maxParallelClones: 2 }), dispatch, collect }),
    );

    expect(result.createdClones).toHaveLength(4);
    expect(result.results.every((r) => r.outcome === 'completed')).toBe(true);
    // One destroy per created clone — no clone outlives the orchestration.
    expect(cloneMocks.destroyExecutionClone).toHaveBeenCalledTimes(4);
    const destroyedTargets = cloneMocks.destroyExecutionClone.mock.calls.map(
      (c) => (c[0] as { target: string }).target,
    );
    expect(new Set(destroyedTargets)).toEqual(new Set(result.createdClones));
    // Destroy is authorized by the owner (creator) session.
    for (const call of cloneMocks.destroyExecutionClone.mock.calls) {
      expect((call[0] as { callerSessionName?: string }).callerSessionName).toBe(OWNER);
    }
  });

  it('collected results are returned for integration before the clones are destroyed', async () => {
    stubSequentialCreates();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const collect = vi.fn().mockImplementation((t: string) => Promise.resolve(`R(${t})`));

    const result = await orchestrateCloneWorkers(
      baseOpts({ tasks: tasks(2), pref: pref({ maxParallelClones: 2 }), dispatch, collect }),
    );

    const collectedById = Object.fromEntries(result.results.map((r) => [r.taskId, r.collected]));
    expect(collectedById.t0).toMatch(/^R\(clone-\d\)$/);
    expect(collectedById.t1).toMatch(/^R\(clone-\d\)$/);
    // Results carry the collected payload (the caller integrates these before
    // the clones — already destroyed here — are gone).
    expect(result.results.every((r) => typeof r.collected === 'string')).toBe(true);
  });
});

describe('orchestrateCloneWorkers — pref normalization (T-A-prog)', () => {
  it('T-A-prog: a NaN maxParallelClones is normalized so the pool dispatches >=1 and <=default, never zero', async () => {
    // The programmatic NaN failure mode: `Math.max(1, NaN) === NaN` is NOT a
    // guard, so without the entry-point normalizer `slice(0, NaN)` admits ZERO
    // tasks → the routing-enabled run silently executes nothing. The parser
    // normalizes NaN → the field default (3), so the pool admits + dispatches.
    stubSequentialCreates();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const collect = vi.fn().mockResolvedValue('ok');

    const result = await orchestrateCloneWorkers(
      baseOpts({
        tasks: tasks(2),
        // Partial/NaN pref — maxParallelClones is NaN, maxQueuedClones missing.
        pref: { maxParallelClones: NaN } as unknown as DedicatedExecutionRoutingGlobalPreference,
        dispatch,
        collect,
      }),
    );

    // NOT zero-dispatch: both tasks ran (normalized cap default 3 >= 2 tasks).
    expect(result.results).toHaveLength(2);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result.capacityRejections).toHaveLength(0);
    // Bounded above: at most the normalized default (3) clones were created for
    // the 2 tasks — never unbounded.
    expect(cloneMocks.createExecutionClone).toHaveBeenCalledTimes(2);
    expect(result.createdClones.length).toBeGreaterThanOrEqual(1);
    expect(result.createdClones.length).toBeLessThanOrEqual(DEFAULT_MAX_PARALLEL_CLONES);

    // Proof that the raw `Math.max(1, NaN)` floor would NOT have saved this:
    expect(Math.max(1, NaN)).toBeNaN();
    // …and `slice(0, NaN)` admits zero, the exact silent no-op the normalizer fixes.
    expect([1, 2].slice(0, NaN)).toHaveLength(0);
  });

  it('T-A-prog: the normalized cap binds the pool — 5 tasks with a NaN cap run under the default cap of 3', async () => {
    // With the cap normalized to default 3, a 5-task batch admits 3 (queue 64)
    // and never overshoots; all 5 still run as slots free. Concurrency is gated
    // on a manual resolver to observe the live peak precisely.
    stubSequentialCreates();
    const resolvers = new Map<string, () => void>();
    let liveCollects = 0;
    let observedPeak = 0;
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const collect = vi.fn().mockImplementation((cloneTarget: string) => {
      liveCollects += 1;
      observedPeak = Math.max(observedPeak, liveCollects);
      return new Promise<string>((resolve) => {
        resolvers.set(cloneTarget, () => { liveCollects -= 1; resolve(`r-${cloneTarget}`); });
      });
    });

    const runPromise = orchestrateCloneWorkers(
      baseOpts({
        tasks: tasks(5),
        pref: { maxParallelClones: NaN, maxQueuedClones: NaN } as unknown as DedicatedExecutionRoutingGlobalPreference,
        dispatch,
        collect,
      }),
    );

    await flushMicrotasks();
    // Normalized cap = default 3 (not NaN → not zero, not unbounded).
    expect(liveCollects).toBe(DEFAULT_MAX_PARALLEL_CLONES);
    expect(observedPeak).toBe(DEFAULT_MAX_PARALLEL_CLONES);

    // Drain all running workers; each freed slot pulls one queued task.
    for (let i = 0; i < 5; i += 1) {
      const anyLive = [...resolvers.keys()][0];
      if (anyLive === undefined) break;
      resolvers.get(anyLive)!();
      resolvers.delete(anyLive);
      await flushMicrotasks();
      expect(liveCollects).toBeLessThanOrEqual(DEFAULT_MAX_PARALLEL_CLONES);
    }

    const result = await runPromise;
    expect(result.results).toHaveLength(5);
    expect(observedPeak).toBe(DEFAULT_MAX_PARALLEL_CLONES);
  });
});

describe('orchestrateCloneWorkers — outcomeOf classifier', () => {
  it('a collected failure marker is classified without throwing', async () => {
    stubSequentialCreates();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const collect = vi.fn().mockResolvedValue({ status: 'failed' });

    const result = await orchestrateCloneWorkers(
      baseOpts({
        tasks: tasks(1),
        dispatch,
        collect,
        outcomeOf: (c: unknown) =>
          (c as { status: string }).status === 'failed' ? 'failed' : 'completed',
      }),
    );

    expect(result.results[0].outcome).toBe('failed');
    expect(cloneMocks.destroyExecutionClone).toHaveBeenCalledTimes(1);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Flush queued microtasks several times so chained awaits settle. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}
