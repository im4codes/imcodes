/**
 * tsk_a800294cfa: a project with a long pair history and a few open pairs
 * (the shape of a busy real project: dozens of finished pairs, three working,
 * a supervised_audit Brain) must show every open pair in the console snapshot,
 * with executor/auditor presentation; a supervision-off project shows the pairs
 * it was given by hand (manual pairs are first-class); a project the owner rolled
 * back to legacy that still holds pairs on disk must say so instead of presenting a
 * silent empty list; and a Brain of another project must never read this
 * project's pairs.
 *
 * Deliberately does NOT force IMCODES_SUPERVISION_ENGINE: the engine is
 * resolved from the real Brain session snapshot, exactly as in production.
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SupervisionConsoleSessionRegistry } from '../../src/daemon/supervision-console-session.js';
import { SupervisionConsoleProducer } from '../../src/daemon/supervision-console-producer.js';
import { isAuthorizedSupervisionConsoleScope } from '../../src/daemon/supervision-console-binding.js';
import { migrateSupervisionStore, type SupervisionMigrationDb } from '../../src/daemon/supervision-store-migrations.js';
import { TaskPairStore, setTaskPairStoreForTests } from '../../src/daemon/task-pairs/store.js';
import { listSessions, removeSession, upsertSession, type SessionRecord } from '../../src/store/session-store.js';
import {
  SUPERVISION_TASK_CONSOLE_FEATURES,
  SUPERVISION_TASK_CONSOLE_MSG,
  SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
} from '../../shared/supervision-task-console.js';
import { SUPERVISION_MODE, SUPERVISION_TASK_STATUS_CONTRACT_VERSION, normalizeSessionSupervisionSnapshot } from '../../shared/supervision-config.js';

const BUSY = { project: 'many_pairs_busy', brain: 'deck_many_pairs_busy_brain' };
const OFF = { project: 'many_pairs_off', brain: 'deck_many_pairs_off_brain' };
const EPOCH = 'epoch-1';

function brain(entry: { project: string; brain: string }, mode: string): SessionRecord {
  return {
    name: entry.brain, projectName: entry.project, role: 'brain', agentType: 'claude-code-sdk',
    projectDir: `/tmp/${entry.project}`, state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
    sessionInstanceId: `${entry.brain}-instance`, runtimeEpoch: `${entry.brain}-epoch`,
    transportConfig: { supervision: normalizeSessionSupervisionSnapshot({ mode }) },
  } as unknown as SessionRecord;
}

let db: DatabaseSync;
let store: TaskPairStore;
let sent: any[];
let registry: SupervisionConsoleSessionRegistry;
let clock: number;
const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;

function save(entry: { project: string; brain: string }, taskId: string, status: string, updatedAt: number) {
  return store.savePair(entry.project, {
    taskId, brain: entry.brain, executor: `deck_sub_${taskId}_x`, auditor: `deck_sub_${taskId}_a`,
    title: `Pair ${taskId}`, status, flags: [], flagSides: {}, round: 0, blocking: ['P0'],
    previousAuditors: [], createdAt: 1, updatedAt, brief: '- [ ][ ] one', executorPool: 'primary',
  } as never, { liveness: { silenceExecutor: 0, silenceAuditor: 0, progressExecutorAt: 1_000, progressAuditorAt: 1_000 } as never });
}

function subscribe(entry: { project: string; brain: string }, over: Record<string, unknown> = {}) {
  return {
    type: SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE, scope: { projectName: entry.project, coordinatorSessionName: entry.brain },
    subscriptionId: 'sub-1', afterEventId: null, reason: 'initial',
    schemaVersion: SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
    statusContractVersion: SUPERVISION_TASK_STATUS_CONTRACT_VERSION,
    projectionVersion: 0, lastDurableEventId: null, projectionEpoch: EPOCH,
    features: [SUPERVISION_TASK_CONSOLE_FEATURES.PAIR_DELTA_V1],
    ...over,
  };
}

beforeEach(() => {
  delete process.env.IMCODES_SUPERVISION_ENGINE;
  store = new TaskPairStore(':memory:');
  setTaskPairStoreForTests(store);
  db = new DatabaseSync(':memory:');
  db.exec(`
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
  `);
  migrateSupervisionStore(db as unknown as SupervisionMigrationDb);
  sent = []; clock = 0;
  upsertSession(brain(BUSY, SUPERVISION_MODE.SUPERVISED_AUDIT));
  upsertSession(brain(OFF, SUPERVISION_MODE.OFF));
  const producer = new SupervisionConsoleProducer(db as unknown as SupervisionMigrationDb, {
    projectionEpoch: EPOCH, now: () => ++clock, snapshotCacheTtlMs: 0,
    broadcast: (frame) => registry.broadcast(frame),
    resolveSessionPresentation: (sessionName, at) => ({
      label: `label of ${sessionName}`, model: 'sonnet-5.5', thinking: 'high', state: 'running', source: 'registry', observedAt: at,
    }),
  });
  registry = new SupervisionConsoleSessionRegistry({
    producer, send: (frame) => sent.push(frame),
    authorize: (scope) => isAuthorizedSupervisionConsoleScope(scope, listSessions()),
    now: () => clock,
  });
});

afterEach(() => {
  setTaskPairStoreForTests(undefined);
  removeSession(BUSY.brain);
  removeSession(OFF.brain);
  if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
  else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
});

describe('a busy supervised_audit project with a long finished history', () => {
  it('lists every open pair (even long-quiet ones) with executor/auditor presentation', () => {
    // Three working pairs that went quiet long ago, behind 62 done + 6 cancelled.
    save(BUSY, 'w1', 'working', 10);
    save(BUSY, 'w2', 'in_audit', 11);
    save(BUSY, 'w3', 'rework', 12);
    for (let i = 0; i < 62; i += 1) save(BUSY, `d${i}`, 'done', 1_000 + i);
    for (let i = 0; i < 6; i += 1) save(BUSY, `c${i}`, 'cancelled', 2_000 + i);

    registry.handleFrame(subscribe(BUSY));
    const snapshot = sent.at(-1);
    expect(snapshot.type).toBe(SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT);
    expect(snapshot.inertPairs).toBeUndefined();
    expect(snapshot.tasks).toHaveLength(71);
    const open = snapshot.tasks.filter((task: any) => !['done', 'cancelled'].includes(task.pair.status));
    expect(open.map((task: any) => task.taskId).sort()).toEqual(['w1', 'w2', 'w3']);
    const row = snapshot.tasks.find((task: any) => task.taskId === 'w1');
    expect(row.pair).toMatchObject({
      executor: 'deck_sub_w1_x', auditor: 'deck_sub_w1_a',
      executorLabel: 'label of deck_sub_w1_x', auditorLabel: 'label of deck_sub_w1_a',
      executorModel: 'sonnet-5.5', auditorModel: 'sonnet-5.5',
    });
    expect(snapshot.assignments.filter((assignment: any) => assignment.taskId === 'w1').map((assignment: any) => assignment.role).sort())
      .toEqual(['auditor', 'implementer']);
  });

  it('keeps open pairs in the (capped) window when the finished history exceeds it', () => {
    save(BUSY, 'old-open', 'working', 1);
    for (let i = 0; i < 260; i += 1) save(BUSY, `d${i}`, 'done', 1_000 + i);

    registry.handleFrame(subscribe(BUSY));
    const ids = sent.at(-1).tasks.map((task: any) => task.taskId);
    expect(ids).toContain('old-open');
    // Capped at 200 rows: the open pair first, then the newest finished ones.
    expect(ids).toHaveLength(200);
    expect(ids).toContain('d259');
    expect(ids).not.toContain('d0');
    expect(store.listPairWindowIds(BUSY.project)).toEqual(store.listPairs(BUSY.project).map((stored) => stored.state.taskId));
  });

  it('does not let another project Brain read these pairs (isolation)', () => {
    save(BUSY, 'w1', 'working', 10);
    registry.handleFrame(subscribe(
      { project: BUSY.project, brain: OFF.brain },
    ));
    // Authorization is fail-closed and silent: not even a refusal frame.
    expect(sent).toEqual([]);
  });
});

describe('a supervision-off project that holds pairs', () => {
  it('shows the pairs it was given by hand, with no inert marker (manual pairs work in every supervision mode)', () => {
    save(OFF, 'manual', 'working', 10);
    registry.handleFrame(subscribe(OFF));
    const snapshot = sent.at(-1);
    expect(snapshot.type).toBe(SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT);
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({ taskId: 'manual' });
    expect(snapshot.inertPairs).toBeUndefined();
  });

  it('a project with no pairs carries no marker', () => {
    registry.handleFrame(subscribe(OFF));
    expect(sent.at(-1).inertPairs).toBeUndefined();
  });
});

describe('a project the owner explicitly rolled back to legacy (no pairs here) that still holds pairs on disk', () => {
  it('reports the stored pairs instead of a silent empty list, and exposes none of their rows', () => {
    save(OFF, 'stuck', 'working', 10);
    upsertSession({ ...brain(OFF, SUPERVISION_MODE.OFF), transportConfig: { supervision: normalizeSessionSupervisionSnapshot({ mode: SUPERVISION_MODE.OFF, pairEngine: 'legacy' }) } } as unknown as SessionRecord);
    registry.handleFrame(subscribe(OFF));
    const snapshot = sent.at(-1);
    expect(snapshot.type).toBe(SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT);
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.inertPairs).toBe(1);
  });
});
