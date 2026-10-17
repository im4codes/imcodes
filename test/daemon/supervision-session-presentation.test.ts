/**
 * tsk_58c8fb1b73: a pair row kept saying "running" for a session that had gone
 * idle. The live-state memo (1 s TTL, for bulk snapshot passes) was still warm
 * when the 250 ms session-activity refresh re-read it, so the row looked
 * unchanged, no delta was sent, and no later event corrected it.
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SUPERVISION_LIVE_STATE_CACHE_MS,
  createSupervisionSessionPresentationResolver,
} from '../../src/daemon/supervision-session-presentation.js';
import { createSupervisionPairRefreshScheduler } from '../../src/daemon/supervision-pair-refresh.js';
import { SupervisionConsoleSessionRegistry } from '../../src/daemon/supervision-console-session.js';
import { SupervisionConsoleProducer } from '../../src/daemon/supervision-console-producer.js';
import { migrateSupervisionStore, type SupervisionMigrationDb } from '../../src/daemon/supervision-store-migrations.js';
import { TaskPairStore, setTaskPairStoreForTests } from '../../src/daemon/task-pairs/store.js';
import {
  SUPERVISION_TASK_CONSOLE_FEATURES,
  SUPERVISION_TASK_CONSOLE_MSG,
  SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
} from '../../shared/supervision-task-console.js';
import { SUPERVISION_TASK_STATUS_CONTRACT_VERSION } from '../../shared/supervision-config.js';

type ListState = 'running' | 'queued' | 'idle' | 'error' | 'stopped' | 'unknown';

function makeSources(initial: ListState = 'running') {
  const live = { state: initial, working: false, waiting: false };
  let at = 10_000;
  const reads = { observe: 0, working: 0 };
  const sources = {
    getSession: (name: string) => (name === 'gone' ? undefined : { label: 'L', activeModel: ' opus ', requestedModel: 'sonnet', effort: 'max', updatedAt: 42 }),
    isWaitingForUserInput: () => live.waiting,
    observeListState: () => { reads.observe += 1; return live.state; },
    isSessionWorking: () => { reads.working += 1; return live.working; },
    resolveMissing: (observedAt: number) => ({ state: 'offline' as const, source: 'registry' as const, observedAt }),
    now: () => at,
  };
  return { live, reads, sources, advance: (ms: number) => { at += ms; } };
}

describe('session presentation resolver', () => {
  it('maps live state and presents label/model/thinking', () => {
    const { sources, live } = makeSources('idle');
    const resolver = createSupervisionSessionPresentationResolver(sources);
    expect(resolver.resolve('s', 1)).toEqual({ label: 'L', model: 'opus', thinking: 'max', state: 'idle', source: 'runtime', observedAt: 42 });
    live.state = 'stopped';
    resolver.invalidate('s');
    expect(resolver.resolve('s', 1)).toMatchObject({ state: 'offline', source: 'registry' });
    live.state = 'unknown';
    resolver.invalidate('s');
    expect(resolver.resolve('s', 1)).toMatchObject({ state: 'unknown', source: 'registry' });
    live.waiting = true;
    expect(resolver.resolve('s', 1)).toMatchObject({ state: 'needs_input', source: 'supervision' });
    expect(resolver.resolve('gone', 7)).toEqual({ state: 'offline', source: 'registry', observedAt: 7 });
  });

  it('still memoizes within the TTL for bulk passes (the cost bound is kept)', () => {
    const { sources, reads, advance } = makeSources('running');
    const resolver = createSupervisionSessionPresentationResolver(sources);
    for (let i = 0; i < 300; i += 1) resolver.resolve('s', 1);
    expect(reads.observe).toBe(1);
    advance(SUPERVISION_LIVE_STATE_CACHE_MS);
    resolver.resolve('s', 1);
    expect(reads.observe).toBe(2);
  });

  it('serves the pre-change state inside the TTL until the session is invalidated', () => {
    const { sources, live, advance } = makeSources('running');
    const resolver = createSupervisionSessionPresentationResolver(sources);
    expect(resolver.resolve('s', 1).state).toBe('running');
    live.state = 'idle';
    advance(250); // the refresh the idle event schedules
    expect(resolver.resolve('s', 1).state).toBe('running'); // the production bug
    resolver.invalidate('s');
    expect(resolver.resolve('s', 1).state).toBe('idle');
  });
});

describe('pair refresh scheduler', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function make() {
    const calls: string[] = [];
    const scheduler = createSupervisionPairRefreshScheduler({
      participantsOf: (project, taskId) => [`${taskId}_x`, `${taskId}_a`],
      invalidatePresentation: (name) => calls.push(`invalidate:${name}`),
      pairsChanged: (project, ids, reason) => calls.push(`changed:${project}:${[...ids].sort().join(',')}:${reason}`),
      publishBadges: () => calls.push('badges'),
    });
    return { calls, scheduler };
  }

  it('coalesces a burst per project, refreshes every id, and invalidates participants BEFORE the rows are rebuilt', () => {
    const { calls, scheduler } = make();
    scheduler.schedule('cd', 'p1', 'session_activity_changed');
    scheduler.schedule('cd', 'p2', 'session_activity_changed');
    scheduler.schedule('other', 'q1', 'session_activity_changed');
    vi.advanceTimersByTime(250);
    expect(calls).toEqual([
      'invalidate:p1_x', 'invalidate:p1_a', 'invalidate:p2_x', 'invalidate:p2_a',
      'changed:cd:p1,p2:session_activity_changed',
      'invalidate:q1_x', 'invalidate:q1_a',
      'changed:other:q1:session_activity_changed',
    ]);
  });

  it('a pair change in the burst upgrades the reason and publishes badges; activity alone does not', () => {
    const { calls, scheduler } = make();
    scheduler.schedule('cd', 'p1', 'session_activity_changed');
    scheduler.schedule('cd', 'p1', 'task_pair_changed');
    scheduler.schedule('cd', 'p1', 'session_activity_changed');
    vi.advanceTimersByTime(250);
    expect(calls.at(-2)).toBe('changed:cd:p1:task_pair_changed');
    expect(calls.at(-1)).toBe('badges');
    calls.length = 0;
    scheduler.schedule('cd', 'p1', 'session_activity_changed');
    vi.advanceTimersByTime(250);
    expect(calls).not.toContain('badges');
  });

  it('dispose cancels pending refreshes', () => {
    const { calls, scheduler } = make();
    scheduler.schedule('cd', 'p1', 'task_pair_changed');
    scheduler.dispose();
    vi.advanceTimersByTime(1_000);
    expect(calls).toEqual([]);
  });
});

describe('end to end: a running -> idle transition reaches the viewer without any pair save', () => {
  const PROJECT = 'cd';
  const BRAIN = 'deck_cd_brain';
  const SCOPE = { projectName: PROJECT, coordinatorSessionName: BRAIN };
  const LEGACY_DDL = `
    CREATE TABLE supervision_tasks (task_id TEXT PRIMARY KEY, top_level_task_id TEXT NOT NULL,
      classification TEXT NOT NULL, status TEXT NOT NULL, current_revision TEXT, commit_sha TEXT,
      push_remote_ref TEXT, blocker TEXT, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL);
    CREATE TABLE supervision_task_assignments (assignment_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
      role TEXT NOT NULL, status TEXT NOT NULL, session_name TEXT NOT NULL, session_instance_id TEXT NOT NULL,
      runtime_epoch TEXT NOT NULL, agent_type TEXT NOT NULL, provider_family TEXT NOT NULL,
      lease_id TEXT NOT NULL, generation INTEGER NOT NULL, audit_attempt_id TEXT, audit_revision TEXT,
      verdict TEXT, blocker TEXT, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE supervision_task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
      assignment_id TEXT, event_type TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT, created_at INTEGER NOT NULL);
  `;
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
  let sent: any[]; let registry: SupervisionConsoleSessionRegistry; let store: TaskPairStore;

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    store = new TaskPairStore(':memory:');
    setTaskPairStoreForTests(store);
  });
  afterEach(() => {
    vi.useRealTimers();
    setTaskPairStoreForTests(undefined);
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  function setup(invalidateOnFlush: boolean) {
    const db = new DatabaseSync(':memory:');
    db.exec(LEGACY_DDL);
    migrateSupervisionStore(db as unknown as SupervisionMigrationDb);
    const { sources, live, advance } = makeSources('running');
    const resolver = createSupervisionSessionPresentationResolver({ ...sources, now: () => Date.now() });
    sent = [];
    const producer = new SupervisionConsoleProducer(db as unknown as SupervisionMigrationDb, {
      projectionEpoch: 'e', now: () => Date.now(), snapshotCacheTtlMs: 0,
      broadcast: (frame) => registry.broadcast(frame),
      resolveSessionPresentation: (name, at) => resolver.resolve(name, at),
    });
    registry = new SupervisionConsoleSessionRegistry({ producer, send: (frame) => sent.push(frame), authorize: () => true });
    store.savePair(PROJECT, {
      taskId: 'p1', brain: BRAIN, executor: 'deck_sub_x', auditor: 'deck_sub_a', title: 'P1', status: 'working',
      flags: [], flagSides: {}, round: 0, blocking: [], previousAuditors: [], createdAt: 1, updatedAt: 1,
    } as never, { liveness: { silenceExecutor: 0, silenceAuditor: 0, progressExecutorAt: 1, progressAuditorAt: 1 } as never });
    const scheduler = createSupervisionPairRefreshScheduler({
      participantsOf: () => ['deck_sub_x', 'deck_sub_a'],
      invalidatePresentation: (name) => { if (invalidateOnFlush) resolver.invalidate(name); },
      pairsChanged: (project, ids, reason) => registry.pairsChanged(project, ids, reason),
      publishBadges: () => {},
    });
    registry.handleFrame({
      type: SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE, scope: SCOPE, subscriptionId: 'sub-1', afterEventId: null, reason: 'initial',
      schemaVersion: SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION, statusContractVersion: SUPERVISION_TASK_STATUS_CONTRACT_VERSION,
      projectionVersion: 0, lastDurableEventId: null, projectionEpoch: 'e',
      features: [SUPERVISION_TASK_CONSOLE_FEATURES.PAIR_DELTA_V1],
    });
    return { live, advance, scheduler };
  }

  it('delivers executorState: idle after the session goes idle (invalidation on flush)', () => {
    const { live, scheduler } = setup(true);
    expect(sent.at(-1).tasks[0].pair.executorState).toBe('running');
    sent.length = 0;
    // Streaming activity: a refresh while the session is still running (warms the memo).
    scheduler.schedule(PROJECT, 'p1', 'session_activity_changed');
    vi.advanceTimersByTime(250);
    live.state = 'idle';
    vi.advanceTimersByTime(100);
    scheduler.schedule(PROJECT, 'p1', 'session_activity_changed'); // the idle event
    vi.advanceTimersByTime(250);
    const deltas = sent.filter((frame) => frame.type === SUPERVISION_TASK_CONSOLE_MSG.PAIR_DELTA);
    expect(deltas.at(-1)?.upserts[0].task.pair.executorState).toBe('idle');
  });

  it('(control) without the invalidation the idle transition is lost - the production bug', () => {
    const { live, scheduler } = setup(false);
    sent.length = 0;
    scheduler.schedule(PROJECT, 'p1', 'session_activity_changed');
    vi.advanceTimersByTime(250);
    live.state = 'idle';
    vi.advanceTimersByTime(100);
    scheduler.schedule(PROJECT, 'p1', 'session_activity_changed');
    vi.advanceTimersByTime(250);
    expect(sent.filter((frame) => frame.type === SUPERVISION_TASK_CONSOLE_MSG.PAIR_DELTA)).toEqual([]);
  });
});
