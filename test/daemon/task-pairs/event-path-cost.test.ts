import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import {
  TASK_PAIR_LIVENESS_ACTIVITY_WRITE_INTERVAL_MS,
  TaskPairStore,
  getTaskPairStore,
  livenessChangedBeyondActivityTimestamps,
  setTaskPairStoreForTests,
} from '../../../src/daemon/task-pairs/store.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { TaskPairService } from '../../../src/daemon/task-pairs/service.js';
import { TaskPairAutomation } from '../../../src/daemon/task-pairs/scheduler.js';
import { isPairsEngineProject } from '../../../src/daemon/task-pairs/engine.js';
import type { TaskPairState } from '../../../shared/task-pair.js';

/**
 * The pairs heartbeat observes every timeline event of every session (streamed
 * deltas, tool calls, replies). It used to run `listActivePairs()` (a SELECT of
 * every open pair plus JSON.parse of its state and liveness) up to three times
 * and rewrite each participant pair's liveness row per event; on a Brain that
 * streams, that was a full table read plus an UPDATE per delta. The hot paths
 * now read an in-memory index and write activity stamps once per interval.
 */
const PROJECT = 'costpairs';
const BRAIN = 'deck_costpairs_brain';
const WORKERS = Array.from({ length: 40 }, (_, i) => `deck_sub_costw${i}`);
const OUTSIDER = 'deck_sub_costoutsider';
const OPEN_PAIRS = 150;

function session(name: string, role: SessionRecord['role']): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType: 'claude-code-sdk', projectDir: `/tmp/${PROJECT}`, state: 'idle',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`,
    restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
  } as SessionRecord;
}

function pairState(index: number, status: TaskPairState['status'] = 'working'): TaskPairState {
  return {
    taskId: `tsk_cost${String(index).padStart(4, '0')}`,
    brain: BRAIN,
    executor: WORKERS[index % WORKERS.length],
    auditor: WORKERS[(index + 17) % WORKERS.length],
    status,
    flags: [], flagSides: {}, round: 1, blocking: ['P0'], previousAuditors: [], capCounts: {}, capRound: 1,
    createdAt: 1_000 + index, updatedAt: 1_000 + index,
    title: `Task ${index}`,
    brief: `Realistic brief ${index}. ${'Investigate, implement and verify the change end to end. '.repeat(200)}`,
  } as TaskPairState;
}

function statements<T>(run: () => T): { result: T; prepares: string[] } {
  const proto = DatabaseSync.prototype as unknown as { prepare: (sql: string, ...rest: unknown[]) => unknown };
  const original = proto.prepare;
  const prepares: string[] = [];
  proto.prepare = function patched(this: unknown, sql: string, ...rest: unknown[]) {
    prepares.push(String(sql));
    return original.call(this, sql, ...rest);
  };
  try {
    return { result: run(), prepares };
  } finally {
    proto.prepare = original;
  }
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

function measure(run: () => unknown, samples: number): number[] {
  const times: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    const start = performance.now();
    run();
    times.push(performance.now() - start);
  }
  return times.sort((a, b) => a - b);
}

describe('task-pair per-event paths', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
  let service: TaskPairService;
  let automation: TaskPairAutomation;
  let badgePublishes = 0;

  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    setTaskPairDeliveryDepsForTests({ send: async () => undefined });
    upsertSession(session(BRAIN, 'brain'));
    for (const name of [...WORKERS, OUTSIDER]) upsertSession(session(name, 'w1'));
    const store = getTaskPairStore();
    for (let i = 0; i < OPEN_PAIRS; i += 1) store.savePair(PROJECT, pairState(i));
    // Terminal history a real database carries: never part of the open index.
    for (let i = OPEN_PAIRS; i < OPEN_PAIRS + 300; i += 1) store.savePair(PROJECT, pairState(i, 'done'));
    service = new TaskPairService();
    automation = new TaskPairAutomation({
      now: () => Date.now(),
      isBusy: () => false,
      isLimited: () => false,
      pickCandidate: () => undefined,
      provision: async () => undefined,
      poolOf: () => 'primary',
      importLegacy: () => undefined,
    });
    badgePublishes = 0;
    (automation as unknown as { publishBadges: () => void }).publishBadges = () => { badgePublishes += 1; };
    service.setScheduler(automation);
  });

  afterEach(async () => {
    await service.dispose();
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    for (const name of [BRAIN, ...WORKERS, OUTSIDER]) removeSession(name);
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  it('BASELINE: the old per-event chain (three scans of every open pair, one engine check per pair) blocks the loop for many ms per event', () => {
    const store = getTaskPairStore();
    const involves = (pair: ReturnType<typeof store.listActivePairs>[number]) => (
      pair.state.executor === OUTSIDER || pair.state.auditor === OUTSIDER || pair.state.brain === OUTSIDER
    );
    // What one streamed delta of one session used to trigger: recordActivity's
    // pairsForSession, observeTimelineEvent's engine-filtered scan, and the
    // lifecycle listener's second pairsForSession.
    const old = measure(() => {
      store.listActivePairs().filter(involves);
      store.listActivePairs().filter((pair) => isPairsEngineProject(pair.project)).filter(involves);
      store.listActivePairs().filter(involves);
    }, 15);
    const fast = measure(() => {
      store.pairsForSession(OUTSIDER);
      automation.observeTimelineEvent({ sessionId: OUTSIDER, type: 'assistant.text', payload: { text: 'delta' } });
      store.pairsForSession(OUTSIDER);
    }, 2000);
    expect(percentile(old, 0.5)).toBeGreaterThan(5);
    expect(percentile(fast, 0.99)).toBeLessThan(1);
    expect(percentile(old, 0.5) / Math.max(percentile(fast, 0.5), 0.001)).toBeGreaterThan(50);
  });

  it('an unrelated session costs no SQL and < 1 ms p99 on every per-event path', () => {
    const store = getTaskPairStore();
    store.pairsForSession(OUTSIDER); // build the index once
    const event = { sessionId: OUTSIDER, type: 'assistant.text', payload: { text: 'streamed delta', streaming: true } };
    const { prepares } = statements(() => {
      for (let i = 0; i < 200; i += 1) {
        service.recordActivity(OUTSIDER, Date.now());
        automation.observeTimelineEvent(event);
      }
    });
    expect(prepares).toEqual([]);
    const times = measure(() => {
      service.recordActivity(OUTSIDER, Date.now());
      automation.observeTimelineEvent(event);
    }, 3000);
    expect(percentile(times, 0.99)).toBeLessThan(1);
  });

  it('a participant\'s streamed events write its liveness row at most once per interval, and every one is visible in memory at once', () => {
    const store = getTaskPairStore();
    const worker = WORKERS[3]!;
    const owned = store.pairsForSession(worker).filter((pair) => pair.state.executor === worker);
    expect(owned.length).toBeGreaterThan(0);
    const before = Date.now();
    // Warm: the first stamp of a pair this process has never written persists.
    service.recordActivity(worker, before);
    const { prepares, result: times } = statements(() => measure(() => service.recordActivity(worker, Date.now()), 500));
    expect(prepares.filter((sql) => /UPDATE task_pairs/i.test(sql))).toEqual([]);
    expect(percentile(times, 0.99)).toBeLessThan(1);
    // In memory, the latest stamp is what readers see.
    const stamp = Date.now() + 1;
    service.recordActivity(worker, stamp);
    for (const pair of store.pairsForSession(worker).filter((entry) => entry.state.executor === worker)) {
      expect(pair.liveness.activityExecutorAt).toBe(stamp);
      expect(pair.liveness.lastMaterialAt).toBe(stamp);
    }
  });

  it('writes an activity stamp again once the interval passed, and at once when anything beyond a timestamp changed', () => {
    const store = getTaskPairStore();
    const [pair] = store.pairsForSession(WORKERS[5]!).filter((entry) => entry.state.executor === WORKERS[5]);
    const key = { project: pair!.project, taskId: pair!.state.taskId };
    const stamp = (activityExecutorAt: number, extra: Record<string, unknown> = {}) => store.saveLivenessActivityStamp(
      key.project, key.taskId, { ...store.pairsForSession(WORKERS[5]!).find((p) => p.state.taskId === key.taskId)!.liveness, activityExecutorAt, ...extra },
    );
    expect(stamp(10)).toBe(true); // never written by this process: persisted
    expect(stamp(11)).toBe(false); // pure timestamp inside the interval: memory only
    expect(store.getPair(key.project, key.taskId)!.liveness.activityExecutorAt).toBe(10);
    expect(store.pairsForSession(WORKERS[5]!).find((p) => p.state.taskId === key.taskId)!.liveness.activityExecutorAt).toBe(11);
    expect(stamp(12, { silenceExecutor: 3 })).toBe(true); // material change: immediate
    expect(store.getPair(key.project, key.taskId)!.liveness).toMatchObject({ activityExecutorAt: 12, silenceExecutor: 3 });
    // The interval is real: after it elapses a pure stamp is persisted again.
    const realNow = Date.now;
    Date.now = () => realNow() + TASK_PAIR_LIVENESS_ACTIVITY_WRITE_INTERVAL_MS + 1;
    try {
      expect(stamp(13)).toBe(true);
    } finally {
      Date.now = realNow;
    }
    expect(store.getPair(key.project, key.taskId)!.liveness.activityExecutorAt).toBe(13);
  });

  it('livenessChangedBeyondActivityTimestamps only ignores the activity clocks', () => {
    const base = getTaskPairStore().pairsForSession(WORKERS[0]!)[0]!.liveness;
    expect(livenessChangedBeyondActivityTimestamps(base, { ...base, activityExecutorAt: 99, lastMaterialAt: 99, brainLastActivityAt: 99 })).toBe(false);
    expect(livenessChangedBeyondActivityTimestamps(base, { ...base, silenceExecutor: base.silenceExecutor + 1 })).toBe(true);
    expect(livenessChangedBeyondActivityTimestamps(base, { ...base, notified: [...base.notified, 'k'] })).toBe(true);
    expect(livenessChangedBeyondActivityTimestamps(base, { ...base, brainWaitKey: 'wait' })).toBe(true);
  });

  it('the index follows every write: reassigned participants, ended pairs and prune', () => {
    const store = getTaskPairStore();
    const first = pairState(0);
    expect(store.pairsForSession(first.executor!).some((pair) => pair.state.taskId === first.taskId)).toBe(true);
    // Same answer as the database for every session, before and after writes.
    const viaDb = (name: string) => store.listActivePairs()
      .filter((pair) => pair.state.executor === name || pair.state.auditor === name || pair.state.brain === name)
      .map((pair) => pair.state.taskId).sort();
    const viaIndex = (name: string) => store.pairsForSession(name).map((pair) => pair.state.taskId).sort();
    for (const name of [BRAIN, OUTSIDER, ...WORKERS]) expect(viaIndex(name)).toEqual(viaDb(name));

    store.savePair(PROJECT, { ...first, executor: OUTSIDER, updatedAt: first.updatedAt + 1 });
    expect(viaIndex(OUTSIDER)).toEqual([first.taskId]);
    expect(viaIndex(WORKERS[0]!)).toEqual(viaDb(WORKERS[0]!));
    store.savePair(PROJECT, { ...first, executor: OUTSIDER, status: 'done', updatedAt: first.updatedAt + 2 });
    expect(viaIndex(OUTSIDER)).toEqual([]);
    for (const name of [BRAIN, OUTSIDER, ...WORKERS]) expect(viaIndex(name)).toEqual(viaDb(name));
    store.prune(Date.now() + 365 * 24 * 60 * 60_000);
    for (const name of [BRAIN, OUTSIDER, ...WORKERS]) expect(viaIndex(name)).toEqual(viaDb(name));
  });

  it('a Brain reply that clears a pending reminder is a material change: written at once and publishes badges; further replies only refresh memory', () => {
    const store = getTaskPairStore();
    const [pair] = store.pairsForSession(BRAIN).filter((entry) => entry.state.brain === BRAIN);
    store.saveLiveness(pair!.project, pair!.state.taskId, {
      ...pair!.liveness, brainWaitKey: 'wait-1', brainWaitStartedAt: 5, brainReminderCount: 2, brainReminderDue: 9,
    });
    badgePublishes = 0;
    service.recordActivity(BRAIN, Date.now());
    expect(badgePublishes).toBe(1);
    const stored = store.getPair(pair!.project, pair!.state.taskId)!.liveness;
    expect(stored.brainWaitKey).toBeUndefined();
    expect(stored.brainReminderCount).toBe(0);
    badgePublishes = 0;
    const { prepares } = statements(() => { for (let i = 0; i < 100; i += 1) service.recordActivity(BRAIN, Date.now()); });
    expect(badgePublishes).toBe(0);
    expect(prepares.filter((sql) => /UPDATE task_pairs/i.test(sql))).toEqual([]);
  });

  it('observeTimelineEvent stamps a Brain reply once per interval and skips sessions outside every pair', () => {
    const store = getTaskPairStore();
    const [pair] = store.pairsForSession(BRAIN).filter((entry) => entry.state.brain === BRAIN);
    const reply = { sessionId: BRAIN, type: 'assistant.text', payload: { text: 'thinking out loud', streaming: true } };
    automation.observeTimelineEvent(reply); // first stamp of this pair: persisted
    const { prepares } = statements(() => { for (let i = 0; i < 100; i += 1) automation.observeTimelineEvent(reply); });
    expect(prepares.filter((sql) => /UPDATE task_pairs/i.test(sql))).toEqual([]);
    const live = store.pairsForSession(BRAIN).find((entry) => entry.state.taskId === pair!.state.taskId)!.liveness;
    expect(live.brainLastActivityAt).toBeGreaterThan(0);
    expect(live.brainWaitKey).toBeUndefined();
  });
});
