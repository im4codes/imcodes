/**
 * tsk_cd_console_pairs_snapshot_delta: pair changes reach a console viewer as a
 * one-pair delta, snapshots no longer embed briefs, and briefs are fetched on
 * demand. Everything here runs the real producer + session registry over a real
 * task-pair store (in-memory SQLite); nothing is mocked below the WS boundary.
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SupervisionConsoleSessionRegistry } from '../../src/daemon/supervision-console-session.js';
import { SupervisionConsoleProducer } from '../../src/daemon/supervision-console-producer.js';
import { migrateSupervisionStore, type SupervisionMigrationDb } from '../../src/daemon/supervision-store-migrations.js';
import { TaskPairStore, setTaskPairStoreForTests } from '../../src/daemon/task-pairs/store.js';
import { taskPairBriefRevision } from '../../src/daemon/supervision-console-pair-projection.js';
import {
  SUPERVISION_TASK_CONSOLE_FEATURES,
  SUPERVISION_TASK_CONSOLE_MSG,
  SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
} from '../../shared/supervision-task-console.js';
import { SUPERVISION_TASK_STATUS_CONTRACT_VERSION } from '../../shared/supervision-config.js';
import { taskPairChecklistCounts } from '../../shared/task-pair-checklist.js';

const PROJECT = 'codedeck';
const BRAIN = 'deck_cd_brain';
const SCOPE = { projectName: PROJECT, coordinatorSessionName: BRAIN };
const EPOCH = 'epoch-1';

const BRIEF = `# Brief\n${'- [ ][ ] a checklist line with some words in it\n'.repeat(60)}`;

let db: DatabaseSync;
let store: TaskPairStore;
let sent: any[];
let producer: SupervisionConsoleProducer;
let registry: SupervisionConsoleSessionRegistry;
let clock: number;
const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;

function subscribe(over: Record<string, unknown> = {}) {
  return {
    type: SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE, scope: SCOPE, subscriptionId: 'sub-1',
    afterEventId: null, reason: 'initial',
    schemaVersion: SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
    statusContractVersion: SUPERVISION_TASK_STATUS_CONTRACT_VERSION,
    projectionVersion: 0, lastDurableEventId: null, projectionEpoch: EPOCH,
    features: [SUPERVISION_TASK_CONSOLE_FEATURES.PAIR_DELTA_V1],
    ...over,
  };
}

function save(taskId: string, over: Record<string, unknown> = {}) {
  clock += 1;
  return store.savePair(PROJECT, {
    taskId, brain: BRAIN, executor: `deck_sub_${taskId}_x`, auditor: `deck_sub_${taskId}_a`,
    title: `Pair ${taskId}`, status: 'working', flags: [], flagSides: {}, round: 0, blocking: ['P0'],
    previousAuditors: [], createdAt: 1, updatedAt: 1_000 + clock, brief: BRIEF, executorPool: 'primary',
    ...over,
  } as never, { liveness: { silenceExecutor: 0, silenceAuditor: 0, progressExecutorAt: 1_000, progressAuditorAt: 1_000 } as never });
}

const framesOf = (type: string) => sent.filter((frame) => frame.type === type);

beforeEach(() => {
  process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
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
  producer = new SupervisionConsoleProducer(db as unknown as SupervisionMigrationDb, {
    projectionEpoch: EPOCH, now: () => ++clock, snapshotCacheTtlMs: 0,
    broadcast: (frame) => registry.broadcast(frame),
  });
  registry = new SupervisionConsoleSessionRegistry({
    producer, send: (frame) => sent.push(frame),
    authorize: (scope) => scope.coordinatorSessionName === BRAIN,
    now: () => clock,
  });
});

afterEach(() => {
  setTaskPairStoreForTests(undefined);
  if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
  else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
});

describe('snapshot rows no longer embed the brief', () => {
  it('a PAIR_DELTA_V1 viewer gets briefRevision + checklist counts, never the text; a legacy viewer is unchanged', () => {
    save('p1');
    registry.handleFrame(subscribe());
    const modern = sent.at(-1);
    const row = modern.tasks[0];
    expect(row.pair.brief).toBeUndefined();
    expect(row.pair.briefRevision).toBe(taskPairBriefRevision(BRIEF));
    expect(row.pair.checklist).toEqual(taskPairChecklistCounts(BRIEF));
    expect(JSON.stringify(modern)).not.toContain('a checklist line');
    expect(modern.pairRevision).toBe(0);

    registry.handleFrame(subscribe({ subscriptionId: 'sub-legacy', features: undefined }));
    const legacy = sent.at(-1);
    expect(legacy.tasks[0].pair.brief).toBe(BRIEF);
    expect(legacy.tasks[0].pair.briefRevision).toBeUndefined();
    expect(legacy.pairRevision).toBeUndefined();
  });

  it('a pair without a brief carries neither brief nor revision', () => {
    save('p1', { brief: undefined });
    registry.handleFrame(subscribe());
    expect(sent.at(-1).tasks[0].pair.briefRevision).toBeUndefined();
    expect(sent.at(-1).tasks[0].pair.checklist).toBeUndefined();
  });

  it('the brief revision changes exactly when the brief text changes', () => {
    save('p1');
    registry.handleFrame(subscribe());
    const before = sent.at(-1).tasks[0].pair.briefRevision;
    save('p1', { brief: BRIEF.replace('[ ][ ] a checklist', '[x][ ] a checklist') });
    registry.pairsChanged(PROJECT, ['p1'], 'task_pair_changed');
    const delta = framesOf(SUPERVISION_TASK_CONSOLE_MSG.PAIR_DELTA).at(-1);
    expect(delta.upserts[0].task.pair.briefRevision).not.toBe(before);
    save('p1', { brief: BRIEF.replace('[ ][ ] a checklist', '[x][ ] a checklist'), round: 1 });
    registry.pairsChanged(PROJECT, ['p1'], 'task_pair_changed');
    const again = framesOf(SUPERVISION_TASK_CONSOLE_MSG.PAIR_DELTA).at(-1);
    expect(again.upserts[0].task.pair.briefRevision).toBe(delta.upserts[0].task.pair.briefRevision);
  });
});

describe('a pair change is one small delta frame', () => {
  it('pushes only the changed pair, revisioned, and never demands a resync', () => {
    for (let i = 0; i < 40; i += 1) save(`p${i}`);
    registry.handleFrame(subscribe());
    sent.length = 0;
    save('p7', { status: 'in_audit', round: 1 });
    registry.pairsChanged(PROJECT, ['p7'], 'task_pair_changed');
    expect(sent).toHaveLength(1);
    const delta = sent[0];
    expect(delta).toMatchObject({ type: SUPERVISION_TASK_CONSOLE_MSG.PAIR_DELTA, subscriptionId: 'sub-1', pairRevision: 1, removes: [] });
    expect(delta.upserts).toHaveLength(1);
    expect(delta.upserts[0].task).toMatchObject({ taskId: 'p7', pair: { status: 'in_audit', round: 1 } });
    expect(delta.upserts[0].assignments.map((row: any) => row.role)).toEqual(['implementer', 'auditor']);
    expect(delta.upserts[0].position).toBe(0); // most recently updated => first in snapshot order
    expect(framesOf(SUPERVISION_TASK_CONSOLE_MSG.RESYNC_REQUIRED)).toHaveLength(0);
    expect(framesOf(SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT)).toHaveLength(0);
  });

  it('revisions are dense: each visible change is exactly the previous revision + 1', () => {
    save('p1'); save('p2');
    registry.handleFrame(subscribe());
    sent.length = 0;
    for (const round of [1, 2, 3]) {
      save('p1', { round });
      registry.pairsChanged(PROJECT, ['p1'], 'task_pair_changed');
    }
    expect(framesOf(SUPERVISION_TASK_CONSOLE_MSG.PAIR_DELTA).map((frame) => frame.pairRevision)).toEqual([1, 2, 3]);
  });

  it('sends nothing when the visible row did not change (no revision is burned)', () => {
    save('p1');
    registry.handleFrame(subscribe());
    sent.length = 0;
    registry.pairsChanged(PROJECT, ['p1'], 'session_activity_changed');
    expect(sent).toHaveLength(0);
    save('p1', { round: 1 });
    registry.pairsChanged(PROJECT, ['p1'], 'task_pair_changed');
    expect(sent[0].pairRevision).toBe(1);
  });

  it('is measurably smaller than the full snapshot it replaces (production-shaped: 228 pairs, 3 KB briefs)', () => {
    for (let i = 0; i < 228; i += 1) save(`p${i}`);
    registry.handleFrame(subscribe({ subscriptionId: 'sub-legacy', features: undefined }));
    const legacyBytes = JSON.stringify(sent.at(-1)).length;
    registry.handleFrame(subscribe());
    const snapshotBytes = JSON.stringify(sent.at(-1)).length;
    sent.length = 0;

    save('p100', { round: 2 });
    const startedAt = performance.now();
    registry.pairsChanged(PROJECT, ['p100'], 'task_pair_changed');
    const deltaMs = performance.now() - startedAt;
    const deltaBytes = JSON.stringify(sent[0]).length;

    const fullStartedAt = performance.now();
    registry.handleFrame(subscribe({ subscriptionId: 'sub-legacy2', features: undefined }));
    const fullMs = performance.now() - fullStartedAt;

    // Recorded evidence for the audit (printed, not asserted, except the ratio).
    console.log(JSON.stringify({ legacyFullSnapshotBytes: legacyBytes, briefFreeSnapshotBytes: snapshotBytes, singlePairDeltaBytes: deltaBytes, deltaMs: +deltaMs.toFixed(2), legacyFullBuildMs: +fullMs.toFixed(2) }));
    expect(legacyBytes).toBeGreaterThan(500_000);
    expect(deltaBytes).toBeLessThan(6_000);
    expect(deltaBytes * 100).toBeLessThan(legacyBytes);
    expect(deltaMs).toBeLessThan(fullMs);
  });

  it('a legacy viewer of the same project still gets the resync-and-snapshot behaviour', () => {
    save('p1');
    registry.handleFrame(subscribe({ features: undefined }));
    sent.length = 0;
    save('p1', { round: 1 });
    registry.pairsChanged(PROJECT, ['p1'], 'task_pair_changed');
    expect(sent).toEqual([expect.objectContaining({
      type: SUPERVISION_TASK_CONSOLE_MSG.RESYNC_REQUIRED, subscriptionId: 'sub-1', reason: 'task_pair_changed',
    })]);
  });

  it('other projects and unsubscribed scopes are untouched', () => {
    save('p1');
    registry.handleFrame(subscribe());
    sent.length = 0;
    registry.pairsChanged('otherproject', ['p1'], 'task_pair_changed');
    expect(sent).toHaveLength(0);
    registry.handleFrame({ type: SUPERVISION_TASK_CONSOLE_MSG.UNSUBSCRIBE, scope: SCOPE, subscriptionId: 'sub-1' });
    save('p1', { round: 1 });
    registry.pairsChanged(PROJECT, ['p1'], 'task_pair_changed');
    expect(sent).toHaveLength(0);
  });

  it('reports a queue-position ripple: siblings whose position moved are upserted with the changed pair', () => {
    save('q1', { status: 'queued', executor: undefined, auditor: undefined });
    save('q2', { status: 'queued', executor: undefined, auditor: undefined });
    save('q3', { status: 'queued', executor: undefined, auditor: undefined });
    registry.handleFrame(subscribe());
    const positions = (rows: any[]) => Object.fromEntries(rows.map((row) => [row.taskId, row.pair.queuePosition]));
    expect(positions(sent.at(-1).tasks)).toEqual({ q1: 1, q2: 2, q3: 3 });
    sent.length = 0;
    save('q1', { status: 'working' });
    registry.pairsChanged(PROJECT, ['q1'], 'task_pair_changed');
    const delta = sent[0];
    expect(positions(delta.upserts.map((upsert: any) => upsert.task))).toEqual({ q1: undefined, q2: 1, q3: 2 });
  });

  it('a pair that falls out of the 200-row window is removed, the one that enters is upserted', () => {
    for (let i = 0; i < 200; i += 1) save(`p${i}`);
    registry.handleFrame(subscribe());
    expect(sent.at(-1).tasks).toHaveLength(200);
    sent.length = 0;
    save('newest');
    registry.pairsChanged(PROJECT, ['newest'], 'task_pair_changed');
    const delta = sent[0];
    expect(delta.removes).toEqual(['p0']);
    expect(delta.upserts.map((upsert: any) => upsert.task.taskId)).toEqual(['newest']);
  });

  it('a producer failure while building the delta falls back to a resync instead of going silent', () => {
    save('p1');
    registry.handleFrame(subscribe());
    sent.length = 0;
    const original = producer.buildPairDelta.bind(producer);
    producer.buildPairDelta = () => { throw new Error('boom'); };
    registry.pairsChanged(PROJECT, ['p1'], 'task_pair_changed');
    producer.buildPairDelta = original;
    expect(sent).toEqual([expect.objectContaining({ type: SUPERVISION_TASK_CONSOLE_MSG.RESYNC_REQUIRED })]);
  });
});

describe('subscribe / reconnect always answers with a full, current snapshot', () => {
  it('a resume with a durable cursor still gets a snapshot (pair state has no outbox) that re-bases pairRevision at 0', () => {
    save('p1');
    registry.handleFrame(subscribe());
    save('p1', { round: 1 });
    registry.pairsChanged(PROJECT, ['p1'], 'task_pair_changed');
    expect(sent.at(-1).pairRevision).toBe(1);
    // Pair change while the viewer is disconnected: only the reconnect can repair it.
    save('p1', { round: 2 });
    sent.length = 0;
    registry.handleFrame(subscribe({ subscriptionId: 'sub-2', afterEventId: 0, projectionVersion: 0, lastDurableEventId: 0, reason: 'initial' }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT, subscriptionId: 'sub-2', pairRevision: 0 });
    expect(sent[0].tasks[0].pair.round).toBe(2);
  });

  it('no delta is produced between a re-subscribe and its snapshot, and none is stamped with a stale id', () => {
    save('p1');
    registry.handleFrame(subscribe());
    registry.handleFrame(subscribe({ subscriptionId: 'sub-2' }));
    sent.length = 0;
    // Simulate a pair change racing ahead of a deferred snapshot: the view was
    // dropped at subscribe, so nothing may be sent against the old subscription.
    producer.dropPairView(SCOPE);
    save('p1', { round: 1 });
    registry.pairsChanged(PROJECT, ['p1'], 'task_pair_changed');
    expect(sent).toHaveLength(0);
    registry.handleFrame(subscribe({ subscriptionId: 'sub-3' }));
    save('p1', { round: 2 });
    registry.pairsChanged(PROJECT, ['p1'], 'task_pair_changed');
    expect(sent.at(-1)).toMatchObject({ type: SUPERVISION_TASK_CONSOLE_MSG.PAIR_DELTA, subscriptionId: 'sub-3', pairRevision: 1 });
  });
});

describe('on-demand brief fetch', () => {
  it('returns the exact brief text and its revision for the active subscription', () => {
    save('p1');
    registry.handleFrame(subscribe());
    sent.length = 0;
    registry.handleFrame({ type: SUPERVISION_TASK_CONSOLE_MSG.BRIEF_REQUEST, scope: SCOPE, subscriptionId: 'sub-1', taskId: 'p1' });
    expect(sent).toEqual([{
      type: SUPERVISION_TASK_CONSOLE_MSG.BRIEF_RESPONSE, scope: SCOPE, subscriptionId: 'sub-1', taskId: 'p1',
      briefRevision: taskPairBriefRevision(BRIEF), brief: BRIEF,
    }]);
  });

  it('answers an unknown or brief-less pair with nulls (never another pair\'s text)', () => {
    save('p1', { brief: undefined });
    registry.handleFrame(subscribe());
    sent.length = 0;
    registry.handleFrame({ type: SUPERVISION_TASK_CONSOLE_MSG.BRIEF_REQUEST, scope: SCOPE, subscriptionId: 'sub-1', taskId: 'p1' });
    registry.handleFrame({ type: SUPERVISION_TASK_CONSOLE_MSG.BRIEF_REQUEST, scope: SCOPE, subscriptionId: 'sub-1', taskId: 'nope' });
    expect(sent.map((frame) => [frame.taskId, frame.briefRevision, frame.brief])).toEqual([['p1', null, null], ['nope', null, null]]);
  });

  it('is silent for an unauthorized scope, a stale subscription, an unsubscribed scope, and a bad frame', () => {
    save('p1');
    registry.handleFrame(subscribe());
    sent.length = 0;
    registry.handleFrame({ type: SUPERVISION_TASK_CONSOLE_MSG.BRIEF_REQUEST, scope: { ...SCOPE, coordinatorSessionName: 'deck_x_brain' }, subscriptionId: 'sub-1', taskId: 'p1' });
    registry.handleFrame({ type: SUPERVISION_TASK_CONSOLE_MSG.BRIEF_REQUEST, scope: SCOPE, subscriptionId: 'stale', taskId: 'p1' });
    registry.handleFrame({ type: SUPERVISION_TASK_CONSOLE_MSG.BRIEF_REQUEST, scope: SCOPE, subscriptionId: 'sub-1' });
    registry.handleFrame({ type: SUPERVISION_TASK_CONSOLE_MSG.UNSUBSCRIBE, scope: SCOPE, subscriptionId: 'sub-1' });
    registry.handleFrame({ type: SUPERVISION_TASK_CONSOLE_MSG.BRIEF_REQUEST, scope: SCOPE, subscriptionId: 'sub-1', taskId: 'p1' });
    expect(sent).toHaveLength(0);
  });

  it('does not let a project read another project\'s pair by task id', () => {
    store.savePair('otherproject', {
      taskId: 'secret', brain: BRAIN, title: 'x', status: 'working', flags: [], flagSides: {}, round: 0, blocking: ['P0'],
      previousAuditors: [], createdAt: 1, updatedAt: 1, brief: 'other project brief',
    } as never);
    save('p1');
    registry.handleFrame(subscribe());
    sent.length = 0;
    registry.handleFrame({ type: SUPERVISION_TASK_CONSOLE_MSG.BRIEF_REQUEST, scope: SCOPE, subscriptionId: 'sub-1', taskId: 'secret' });
    expect(sent[0]).toMatchObject({ taskId: 'secret', brief: null, briefRevision: null });
  });
});
