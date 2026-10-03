import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import {
  TASK_PAIR_LIVENESS_ACTIVITY_WRITE_INTERVAL_MS,
  TaskPairStore,
  getTaskPairStore,
  setTaskPairSharedFreezeForTests,
  setTaskPairStoreForTests,
} from '../../../src/daemon/task-pairs/store.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { TaskPairService } from '../../../src/daemon/task-pairs/service.js';
import { TaskPairAutomation } from '../../../src/daemon/task-pairs/scheduler.js';
import { TASK_PAIR_IDEMPOTENT_STARTED_EFFECT, type TaskPairState } from '../../../shared/task-pair.js';

/**
 * Per-event pair bookkeeping must not write the database or push console
 * frames for every event. These tests count SQL statements (the real store, a
 * real SQLite file where durability is the point) instead of measuring time.
 */
const PROJECT = 'writecost';
const BRAIN = 'deck_writecost_brain';
const WORKERS = Array.from({ length: 40 }, (_, i) => `deck_sub_wcw${i}`);
const INTERVAL = TASK_PAIR_LIVENESS_ACTIVITY_WRITE_INTERVAL_MS;

function session(name: string, role: SessionRecord['role']): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType: 'claude-code-sdk', projectDir: `/tmp/${PROJECT}`, state: 'idle',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`,
    restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
  } as SessionRecord;
}

function pairState(index: number, status: TaskPairState['status'] = 'working', extra: Partial<TaskPairState> = {}): TaskPairState {
  return {
    taskId: `tsk_wc${String(index).padStart(4, '0')}`,
    brain: BRAIN,
    executor: WORKERS[index % WORKERS.length],
    auditor: WORKERS[(index + 17) % WORKERS.length],
    status,
    flags: [], flagSides: {}, round: 1, blocking: ['P0'], previousAuditors: [], capCounts: {}, capRound: 1,
    createdAt: 1_000 + index, updatedAt: 1_000 + index,
    title: `Task ${index}`,
    brief: `Realistic brief ${index}. ${'Investigate, implement and verify the change end to end. '.repeat(200)}`,
    ...extra,
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
const writesTo = (prepares: string[], table: string) => prepares.filter((sql) => new RegExp(`(UPDATE|INSERT INTO)\\s+${table}\\b`, 'i').test(sql));

describe('per-event pair write cost', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
  let service: TaskPairService;
  let automation: TaskPairAutomation;
  let badgePublishes: number;
  let saved: number;
  let unsubscribe: () => void;

  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairSharedFreezeForTests(true);
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    setTaskPairDeliveryDepsForTests({ send: async () => undefined });
    upsertSession(session(BRAIN, 'brain'));
    for (const name of WORKERS) upsertSession(session(name, 'w1'));
    service = new TaskPairService();
    automation = new TaskPairAutomation({
      now: () => Date.now(), isBusy: () => false, isLimited: () => false, pickCandidate: () => undefined,
      provision: async () => undefined, poolOf: () => 'primary', importLegacy: () => undefined,
    });
    badgePublishes = 0;
    const realPublish = automation.publishBadges.bind(automation);
    (automation as unknown as { publishBadges: () => void }).publishBadges = () => { badgePublishes += 1; realPublish(); };
    service.setScheduler(automation);
    saved = 0;
    unsubscribe = getTaskPairStore().onPairSaved(() => { saved += 1; });
  });

  afterEach(async () => {
    vi.useRealTimers();
    unsubscribe();
    await service.dispose();
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    setTaskPairSharedFreezeForTests(false);
    for (const name of [BRAIN, ...WORKERS]) removeSession(name);
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  const started = (writer: string, taskId: string, eventId: string, now: number, attrs: Record<string, string> = {}) => service.applyMarker({
    project: PROJECT, writer, marker: { verb: 'STARTED', knownVerb: 'STARTED', taskId, attrs }, source: 'marker', eventId, now,
  });
  /** The queue's admission: the only route by which a queued pair starts. */
  const admit = (pair: { executor?: string; auditor?: string; taskId: string }, now: number) => service.applyMarker({
    project: PROJECT, writer: 'daemon',
    marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: pair.taskId, attrs: { executor: pair.executor!, auditor: pair.auditor! } },
    source: 'queue', eventId: `admit-${pair.taskId}-${now}`, now,
  });
  const startedEvents = (taskId: string) => getTaskPairStore().listEvents(PROJECT, taskId, 500).filter((event) => event.verb === 'STARTED');

  describe('repeated STARTED', () => {
    it('writes no status event per repeated STARTED once the pair is started, however many times the executor repeats it (54 in 95 minutes was seen)', () => {
      const store = getTaskPairStore();
      const queued = pairState(0, 'queued');
      store.savePair(PROJECT, queued);
      const t0 = 10_000_000;
      admit(queued, t0);
      expect(store.getPair(PROJECT, queued.taskId)!.state.status).toBe('working');
      expect(started(queued.executor!, queued.taskId, 'first', t0).effect).toBe(TASK_PAIR_IDEMPOTENT_STARTED_EFFECT);
      saved = 0;
      const { result: results, prepares } = statements(() => Array.from({ length: 53 }, (_, i) => started(queued.executor!, queued.taskId, `again-${i}`, t0 + (i + 1) * 60_000)));
      expect(results.every((result) => result.effect === TASK_PAIR_IDEMPOTENT_STARTED_EFFECT)).toBe(true);
      expect(startedEvents(queued.taskId)).toHaveLength(0);
      // No pair rewrite, no console push, no event row: at most the throttled liveness row.
      expect(saved).toBe(0);
      expect(writesTo(prepares, 'task_pair_events')).toEqual([]);
      expect(writesTo(prepares, 'task_pairs').length).toBeLessThanOrEqual(1);
      expect(store.getPair(PROJECT, queued.taskId)!.state.updatedAt).toBeLessThan(t0 + 60_000);
    });

    it('still counts as the executor\'s liveness: every repeat moves progress and activity, in memory at once', () => {
      const store = getTaskPairStore();
      const queued = pairState(1, 'queued');
      store.savePair(PROJECT, queued);
      started(queued.executor!, queued.taskId, 'first', 5_000_000);
      const stamp = 5_000_000 + 7 * 60_000;
      started(queued.executor!, queued.taskId, 'repeat', stamp);
      const live = store.pairsForSession(queued.executor!).find((pair) => pair.state.taskId === queued.taskId)!.liveness;
      expect(live.progressExecutorAt).toBe(stamp);
      expect(live.activityExecutorAt).toBe(stamp);
      expect(live.silenceExecutor).toBe(0);
    });

    it('a repeated STARTED after the same event id was recorded is still a plain replay', () => {
      const store = getTaskPairStore();
      const queued = pairState(2, 'queued');
      store.savePair(PROJECT, queued);
      started(queued.executor!, queued.taskId, 'same-id', 1_000_000);
      expect(started(queued.executor!, queued.taskId, 'same-id', 1_000_100).effect).toBe('replayed');
      expect(startedEvents(queued.taskId)).toHaveLength(1);
    });

    it('still records every STARTED that changes something: a queue start, a cleared flag, a re-assigned role, a foreign writer, a closed or passed pair', () => {
      const store = getTaskPairStore();
      // queued: an executor STARTED does not start it (only admission does) -- recorded, never swallowed as a no-op
      const queued = pairState(3, 'queued');
      store.savePair(PROJECT, queued);
      const early = started(queued.executor!, queued.taskId, 'q1', 2_000_000);
      expect(early.effect).toBe('recorded'); // the marker itself changed nothing (the queue may admit the pair right after, on its own path)
      expect(startedEvents(queued.taskId)).toHaveLength(1);

      // an executor-side blocked flag is cleared by a fresh STARTED: a real state change
      const blocked = pairState(4, 'working', { flags: ['blocked'], flagSides: { blocked: 'executor' } });
      store.savePair(PROJECT, blocked);
      const cleared = started(blocked.executor!, blocked.taskId, 'b1', 2_100_000);
      expect(cleared.effect).toBe('status');
      expect(store.getPair(PROJECT, blocked.taskId)!.state.flags).not.toContain('blocked');
      expect(startedEvents(blocked.taskId)).toHaveLength(1);

      // attributes STARTED ignores on an existing pair change nothing: still a strict no-op
      const ignored = pairState(5, 'working');
      store.savePair(PROJECT, ignored);
      expect(started(ignored.executor!, ignored.taskId, 'r1', 2_200_000, { auditor: WORKERS[30]! }).effect).toBe(TASK_PAIR_IDEMPOTENT_STARTED_EFFECT);
      expect(store.getPair(PROJECT, ignored.taskId)!.state.auditor).toBe(ignored.auditor);

      // a participant that is not the executor is recorded (as unusual), never swallowed
      const foreign = pairState(6, 'working');
      store.savePair(PROJECT, foreign);
      const stray = started(foreign.auditor!, foreign.taskId, 'f1', 2_300_000);
      expect(stray.effect).not.toBe(TASK_PAIR_IDEMPOTENT_STARTED_EFFECT);
      expect(startedEvents(foreign.taskId)).toHaveLength(1);

      // in_audit: an executor STARTED is unusual and recorded
      const inAudit = pairState(7, 'in_audit');
      store.savePair(PROJECT, inAudit);
      expect(started(inAudit.executor!, inAudit.taskId, 'a1', 2_400_000).effect).not.toBe(TASK_PAIR_IDEMPOTENT_STARTED_EFFECT);
      expect(startedEvents(inAudit.taskId)).toHaveLength(1);

      // Brain reopens a passed pair with STARTED: a real transition
      const passed = pairState(8, 'passed');
      store.savePair(PROJECT, passed);
      const reopened = started(BRAIN, passed.taskId, 'p1', 2_500_000);
      expect(reopened.effect).toBe('reopened');
      expect(store.getPair(PROJECT, passed.taskId)!.state.status).toBe('working');
    });
  });

  describe('activity stamps under a burst', () => {
    it('writes each pair\'s liveness at most once per interval at 50 events/s, with many pairs per session, and every event visible in memory', () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      vi.setSystemTime(20_000_000);
      const store = getTaskPairStore();
      const worker = WORKERS[3]!;
      // A session executing 12 pairs and auditing 6 more: many pairs per session.
      for (let i = 0; i < 12; i += 1) store.savePair(PROJECT, pairState(100 + i, 'working', { executor: worker, auditor: WORKERS[20 + (i % 10)] }));
      for (let i = 0; i < 6; i += 1) store.savePair(PROJECT, pairState(200 + i, 'in_audit', { executor: WORKERS[25]!, auditor: worker }));
      const owned = store.pairsForSession(worker).filter((pair) => pair.state.executor === worker || pair.state.auditor === worker);
      expect(owned).toHaveLength(18);
      saved = 0;

      const seconds = 12;
      const events = seconds * 50;
      const { prepares } = statements(() => {
        for (let i = 0; i < events; i += 1) {
          service.recordActivity(worker, Date.now());
          automation.observeTimelineEvent({ sessionId: worker, type: 'assistant.text', payload: { text: 'delta', streaming: true } });
          vi.advanceTimersByTime(20);
        }
        // The burst ends; the pending stamps flush within one more interval.
        vi.advanceTimersByTime(INTERVAL + 100);
      });
      const liveWrites = writesTo(prepares, 'task_pairs');
      const perPairCeiling = Math.ceil((seconds * 1000 + INTERVAL) / INTERVAL) + 1;
      expect(liveWrites.length).toBeLessThanOrEqual(owned.length * perPairCeiling);
      // Nothing else scanned or rewrote pairs per event.
      expect(prepares.filter((sql) => /SELECT \* FROM task_pairs WHERE status NOT IN/i.test(sql))).toEqual([]);
      expect(writesTo(prepares, 'task_pair_events')).toEqual([]);
      // events x pairs stamp attempts, a handful of writes.
      expect(liveWrites.length / (events * owned.length)).toBeLessThan(0.01);
      const newest = Date.now();
      for (const pair of store.pairsForSession(worker).filter((entry) => entry.state.executor === worker)) {
        expect(pair.liveness.activityExecutorAt).toBeGreaterThan(newest - (seconds + 6) * 1000);
      }
      expect(saved).toBe(0);
    });

    it.each([
      ['a fresh wait (nothing reminded yet)', 29_999_000, 0],
      ['a wait whose first reminder is already due (the first reply clears it: one material change)', 29_000_000, 1],
    ])('a Brain streaming during %s is throttled stamps, not a clear + re-arm write and a badge pass per event', (_label, updatedAt, allowedBadgePasses) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      vi.setSystemTime(30_000_000);
      const store = getTaskPairStore();
      const passed = pairState(300, 'passed', { updatedAt });
      store.savePair(PROJECT, passed);
      automation.publishBadges(); // arms the durable wait for the passed pair
      const armed = store.getPair(PROJECT, passed.taskId)!.liveness;
      expect(armed.brainWaitKey).toBe(`passed:${passed.round}`);
      badgePublishes = 0;

      const events = 500;
      const { prepares } = statements(() => {
        for (let i = 0; i < events; i += 1) {
          service.recordActivity(BRAIN, Date.now());
          vi.advanceTimersByTime(20);
        }
        vi.advanceTimersByTime(INTERVAL + 100);
      });
      expect(badgePublishes).toBeLessThanOrEqual(allowedBadgePasses);
      expect(writesTo(prepares, 'task_pairs').length).toBeLessThanOrEqual(Math.ceil(((events * 20) + INTERVAL) / INTERVAL) + 3);
      // The wait is armed again for the same state, exactly what clear + re-arm used to leave.
      const live = store.getPair(PROJECT, passed.taskId)!.liveness;
      expect(live.brainWaitKey).toBe(armed.brainWaitKey);
      expect(live.brainWaitStartedAt).toBe(armed.brainWaitStartedAt);
      expect(live.brainReminderCount).toBe(0);
      expect(live.brainReminderResolvedAt).toBeUndefined();
      expect(live.brainLastActivityAt).toBeGreaterThan(armed.brainLastActivityAt ?? 0);
    });

    it('a Brain reply after a reminder was already sent is still a material change: written at once, and badges are republished once', () => {
      const store = getTaskPairStore();
      const passed = pairState(301, 'passed', { updatedAt: 1_000 });
      store.savePair(PROJECT, passed);
      const live = store.getPair(PROJECT, passed.taskId)!.liveness;
      store.saveLiveness(PROJECT, passed.taskId, { ...live, brainWaitKey: `passed:${passed.round}`, brainWaitStartedAt: 1_000, brainReminderCount: 2, brainReminderLastAt: 5_000, brainReminderDue: true });
      badgePublishes = 0;
      const { prepares } = statements(() => service.recordActivity(BRAIN, Date.now()));
      expect(badgePublishes).toBe(1);
      // The material clear is one write; the badge pass may add the reminder-skip diagnostic, never more.
      expect(writesTo(prepares, 'task_pairs').length).toBeLessThanOrEqual(2);
      const after = store.getPair(PROJECT, passed.taskId)!.liveness;
      expect(after.brainReminderCount).toBe(0);
      expect(after.brainReminderDue).toBeUndefined();
      expect(after.brainReminderLastAt).toBeUndefined();
    });

    it('a stamp that has not reached the database yet still counts for the both-idle and silence decisions', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      vi.setSystemTime(40_000_000);
      const store = getTaskPairStore();
      const pair = pairState(400, 'working');
      store.savePair(PROJECT, pair);
      service.recordActivity(pair.executor!, Date.now()); // first stamp: persisted
      vi.advanceTimersByTime(3_000);
      const stamp = Date.now();
      const { prepares } = statements(() => service.recordActivity(pair.executor!, stamp));
      expect(writesTo(prepares, 'task_pairs')).toEqual([]); // deferred
      // Every reader used by the heartbeat (the SQL path) sees the deferred stamp.
      expect(store.getPair(PROJECT, pair.taskId)!.liveness.activityExecutorAt).toBe(stamp);
      expect(store.listActivePairs().find((entry) => entry.state.taskId === pair.taskId)!.liveness.activityExecutorAt).toBe(stamp);
      expect(store.listPairs(PROJECT).find((entry) => entry.state.taskId === pair.taskId)!.liveness.activityExecutorAt).toBe(stamp);
    });
  });

  describe('deferred stamps are durable within one interval', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'imcodes-pair-writecost-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    const openFileStore = (): TaskPairStore => new TaskPairStore(join(dir, 'task-pairs.sqlite'));

    it('a timer flushes deferred stamps within one interval even when no further event arrives', () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      vi.setSystemTime(50_000_000);
      const store = openFileStore();
      try {
        const pair = pairState(500, 'working');
        store.savePair(PROJECT, pair);
        const live = () => store.getPair(PROJECT, pair.taskId)!.liveness;
        store.saveLivenessActivityStamp(PROJECT, pair.taskId, { ...live(), activityExecutorAt: 1 }); // first: persisted
        vi.advanceTimersByTime(1_000);
        store.saveLivenessActivityStamp(PROJECT, pair.taskId, { ...live(), activityExecutorAt: 2 }); // deferred
        const reader = openFileStore();
        try {
          expect(reader.getPair(PROJECT, pair.taskId)!.liveness.activityExecutorAt).toBe(1);
          vi.advanceTimersByTime(INTERVAL + 100);
          expect(reader.getPair(PROJECT, pair.taskId)!.liveness.activityExecutorAt).toBe(2);
        } finally { reader.close(); }
      } finally { store.close(); }
    });

    it('a crash between flushes loses at most one interval of stamps and corrupts nothing', () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      vi.setSystemTime(60_000_000);
      const crashed = openFileStore();
      const pair = pairState(501, 'working');
      crashed.savePair(PROJECT, pair);
      const live = () => crashed.getPair(PROJECT, pair.taskId)!.liveness;
      crashed.saveLivenessActivityStamp(PROJECT, pair.taskId, { ...live(), activityExecutorAt: Date.now() });
      let lastStamp = Date.now();
      for (let i = 0; i < 100; i += 1) { // ~4 s of a 25 events/s burst, all inside the interval
        vi.advanceTimersByTime(40);
        lastStamp = Date.now();
        crashed.saveLivenessActivityStamp(PROJECT, pair.taskId, { ...live(), activityExecutorAt: lastStamp });
      }
      // The process dies here: no close(), no flush, timers never fire.
      const restarted = openFileStore();
      try {
        const recovered = restarted.getPair(PROJECT, pair.taskId)!;
        expect(lastStamp - recovered.liveness.activityExecutorAt!).toBeLessThan(INTERVAL);
        expect(recovered.state).toMatchObject({ taskId: pair.taskId, status: 'working', executor: pair.executor });
        expect(recovered.state.brief).toBe(pair.brief);
        expect(restarted.listActivePairs()).toHaveLength(1);
        expect(restarted.listEvents(PROJECT, pair.taskId)).toEqual([]);
      } finally {
        restarted.close();
        vi.clearAllTimers();
      }
    });

    it('close() (daemon shutdown) flushes the deferred stamps, so a restart sees the latest', () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      vi.setSystemTime(70_000_000);
      const store = openFileStore();
      const pair = pairState(502, 'working');
      store.savePair(PROJECT, pair);
      const live = () => store.getPair(PROJECT, pair.taskId)!.liveness;
      store.saveLivenessActivityStamp(PROJECT, pair.taskId, { ...live(), activityExecutorAt: 10 });
      vi.advanceTimersByTime(500);
      store.saveLivenessActivityStamp(PROJECT, pair.taskId, { ...live(), activityExecutorAt: 11 });
      store.close();
      const restarted = openFileStore();
      try {
        expect(restarted.getPair(PROJECT, pair.taskId)!.liveness.activityExecutorAt).toBe(11);
      } finally { restarted.close(); }
    });

    it('the service disposal at daemon shutdown flushes the deferred stamps of the active store', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      vi.setSystemTime(75_000_000);
      const file = openFileStore();
      setTaskPairStoreForTests(file);
      try {
        const pair = pairState(504, 'working');
        file.savePair(PROJECT, pair);
        const live = () => file.getPair(PROJECT, pair.taskId)!.liveness;
        file.saveLivenessActivityStamp(PROJECT, pair.taskId, { ...live(), activityExecutorAt: 30 });
        vi.advanceTimersByTime(500);
        file.saveLivenessActivityStamp(PROJECT, pair.taskId, { ...live(), activityExecutorAt: 31 });
        const reader = openFileStore();
        try {
          expect(reader.getPair(PROJECT, pair.taskId)!.liveness.activityExecutorAt).toBe(30);
          await service.dispose();
          expect(reader.getPair(PROJECT, pair.taskId)!.liveness.activityExecutorAt).toBe(31);
        } finally { reader.close(); }
      } finally {
        setTaskPairStoreForTests(undefined);
      }
    });

    it('a pair state change persists the newest stamp with it instead of an older one from the row', () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      vi.setSystemTime(80_000_000);
      const store = openFileStore();
      try {
        const pair = pairState(503, 'working');
        store.savePair(PROJECT, pair);
        const live = () => store.getPair(PROJECT, pair.taskId)!.liveness;
        store.saveLivenessActivityStamp(PROJECT, pair.taskId, { ...live(), activityExecutorAt: 20 });
        vi.advanceTimersByTime(500);
        store.saveLivenessActivityStamp(PROJECT, pair.taskId, { ...live(), activityExecutorAt: 21 }); // deferred
        store.savePair(PROJECT, { ...pair, status: 'in_audit', updatedAt: Date.now() }); // state change, no explicit liveness
        const reader = openFileStore();
        try {
          expect(reader.getPair(PROJECT, pair.taskId)!.liveness.activityExecutorAt).toBe(21);
          expect(reader.getPair(PROJECT, pair.taskId)!.state.status).toBe('in_audit');
        } finally { reader.close(); }
      } finally { store.close(); }
    });

    it('a daemon restart rebuilds the same open-pair view from the file', () => {
      const store = openFileStore();
      for (let i = 0; i < 20; i += 1) store.savePair(PROJECT, pairState(600 + i, i % 5 === 0 ? 'queued' : 'working'));
      store.savePair(PROJECT, pairState(630, 'done'));
      const before = store.listActivePairsShared().map((pair) => pair.state.taskId);
      store.close();
      const restarted = openFileStore();
      try {
        expect(restarted.listActivePairsShared().map((pair) => pair.state.taskId)).toEqual(before);
        expect(restarted.pairsForSession(WORKERS[0]!).length).toBeGreaterThan(0);
      } finally { restarted.close(); }
    });
  });

  describe('the in-memory session index follows pair writes without a rebuild', () => {
    it('one changed pair costs one single-row read, not a re-parse of every open pair, and the answers equal the database', () => {
      const store = getTaskPairStore();
      for (let i = 0; i < 50; i += 1) store.savePair(PROJECT, pairState(700 + i));
      store.pairsForSession(WORKERS[0]!); // build once
      const { prepares } = statements(() => {
        for (let round = 0; round < 20; round += 1) {
          store.savePair(PROJECT, { ...pairState(700 + round), updatedAt: 90_000_000 + round });
          for (let event = 0; event < 50; event += 1) {
            store.pairsForSession(WORKERS[(round + event) % WORKERS.length]!);
            store.isParticipantOfOpenPair(WORKERS[event % WORKERS.length]!);
          }
        }
      });
      expect(prepares.filter((sql) => /SELECT \* FROM task_pairs WHERE status NOT IN/i.test(sql))).toEqual([]);
      expect(prepares.filter((sql) => /SELECT \* FROM task_pairs WHERE project = \? AND task_id = \?/i.test(sql)).length).toBeGreaterThan(0);

      const viaDb = (name: string) => store.listActivePairs()
        .filter((pair) => pair.state.executor === name || pair.state.auditor === name || pair.state.brain === name)
        .map((pair) => pair.state.taskId);
      for (const name of [BRAIN, ...WORKERS]) expect(store.pairsForSession(name).map((pair) => pair.state.taskId)).toEqual(viaDb(name));
      expect(store.listActivePairsShared().map((pair) => pair.state.taskId)).toEqual(store.listActivePairs().map((pair) => pair.state.taskId));
      // A terminal write and a reassignment move the pair out of / between buckets.
      store.savePair(PROJECT, { ...pairState(700), status: 'done', updatedAt: 95_000_000 });
      store.savePair(PROJECT, { ...pairState(701), executor: WORKERS[39]!, updatedAt: 95_000_001 });
      for (const name of [BRAIN, ...WORKERS]) expect(store.pairsForSession(name).map((pair) => pair.state.taskId)).toEqual(viaDb(name));
      expect(store.listActivePairsShared().map((pair) => pair.state.taskId)).toEqual(store.listActivePairs().map((pair) => pair.state.taskId));
    });

    it('publishing badges over 50 open pairs reads nothing from SQLite and writes nothing when no input changed', () => {
      const store = getTaskPairStore();
      for (let i = 0; i < 50; i += 1) store.savePair(PROJECT, pairState(800 + i));
      automation.publishBadges(); // warm the index and arm any waits
      const { prepares } = statements(() => { for (let i = 0; i < 20; i += 1) automation.publishBadges(); });
      expect(prepares.filter((sql) => /task_pairs/i.test(sql))).toEqual([]);
    });

    it('per-event and periodic paths never mutate the shared entries (deep-frozen in this suite)', () => {
      const store = getTaskPairStore();
      for (let i = 0; i < 12; i += 1) store.savePair(PROJECT, pairState(900 + i, i % 4 === 0 ? 'passed' : 'working'));
      for (const name of WORKERS.slice(0, 12)) {
        service.recordActivity(name, Date.now());
        service.recordProgress(name, Date.now(), 'done with it');
        automation.observeTimelineEvent({ sessionId: name, type: 'session.state', payload: { state: 'idle' } });
      }
      service.recordActivity(BRAIN, Date.now());
      automation.observeTimelineEvent({ sessionId: BRAIN, type: 'assistant.text', payload: { text: 'reply' } });
      automation.publishBadges();
      expect(store.listActivePairsShared().length).toBe(12);
    });
  });

  describe('resource claims are unaffected', () => {
    it('TTL renewals still write the claim row every time, and a repeated STARTED neither renews nor drops a claim', () => {
      const store = getTaskPairStore();
      const pair = pairState(950, 'working');
      store.savePair(PROJECT, pair);
      const claim = (now: number) => store.tryClaimResource({ project: PROJECT, taskId: pair.taskId, owner: pair.executor!, resource: 'port:8080', mode: 'exclusive', ttlMs: 600_000, now });
      const first = claim(1_000_000);
      expect(first.ok).toBe(true);
      const { prepares } = statements(() => {
        expect(claim(1_100_000).ok).toBe(true);
        expect(claim(1_200_000).ok).toBe(true);
        started(pair.executor!, pair.taskId, 'renew-noop-1', 1_250_000);
        started(pair.executor!, pair.taskId, 'renew-noop-2', 1_260_000);
      });
      expect(prepares.filter((sql) => /INSERT INTO task_pair_resource_claims/i.test(sql))).toHaveLength(2);
      const [active] = store.listActiveResourceClaims(1_300_000);
      expect(active).toMatchObject({ resource: 'port:8080', renewedAt: 1_200_000, expiresAt: 1_800_000 });
    });
  });
});
