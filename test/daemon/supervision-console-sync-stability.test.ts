/**
 * tsk_58c8fb1b73: the pair console went out of sync with the daemon in ways the
 * user could only fix by reloading the page.
 *
 * Real producer + session registry + task-pair store (in-memory SQLite), the
 * same composition as `supervision-console-pair-delta.test.ts`; nothing is
 * mocked below the WS boundary. Each test names the production failure it pins.
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

const PROJECT = 'cd';
const BRAIN = 'deck_cd_brain';
const SCOPE = { projectName: PROJECT, coordinatorSessionName: BRAIN };
const EPOCH = 'epoch-1';
const ENGINE_ENV = 'IMCODES_SUPERVISION_ENGINE';

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

let db: DatabaseSync;
let store: TaskPairStore;
let sent: any[];
let producer: SupervisionConsoleProducer;
let registry: SupervisionConsoleSessionRegistry;
let clock: number;
const previousEngine = process.env[ENGINE_ENV];

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
    previousAuditors: [], createdAt: 1, updatedAt: 1_000 + clock, brief: '# brief', executorPool: 'primary',
    ...over,
  } as never, { liveness: { silenceExecutor: 0, silenceAuditor: 0, progressExecutorAt: 1_000, progressAuditorAt: 1_000 } as never });
}

/** A task the legacy registry still holds `delegated`, plus a fresh durable event for it (what every daemon start appends). */
function seedLegacyTask(taskId: string): void {
  db.prepare(`INSERT OR IGNORE INTO supervision_tasks (task_id, project_name, top_level_task_id, classification, status,
    payload_json, created_at, updated_at) VALUES (?, ?, ?, 'integration_slice', 'delegated', '{}', 1, 1)`).run(taskId, PROJECT, taskId);
}
function appendLegacyEvent(taskId: string): void {
  seedLegacyTask(taskId);
  db.prepare(`INSERT INTO supervision_task_events (task_id, assignment_id, event_type, status, payload_json, created_at)
    VALUES (?, NULL, 'delegated', 'delegated', '{}', 5)`).run(taskId);
}

const framesOf = (type: string, subscriptionId?: string) => sent.filter((frame) => frame.type === type
  && (subscriptionId === undefined || frame.subscriptionId === subscriptionId));

beforeEach(() => {
  process.env[ENGINE_ENV] = 'pairs';
  store = new TaskPairStore(':memory:');
  setTaskPairStoreForTests(store);
  db = new DatabaseSync(':memory:');
  db.exec(LEGACY_DDL);
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
  if (previousEngine === undefined) delete process.env[ENGINE_ENV];
  else process.env[ENGINE_ENV] = previousEngine;
});

describe('legacy registry events never overwrite the pair rows of a pairs project', () => {
  // Production: tsk_5/tsk_b were imported into the pair store (same ids) and
  // cancelled there, but the legacy registry still holds them `delegated` and
  // re-appends a `delegated` event for each at every daemon start. Those events
  // were projected into DELTA frames, and the browser painted the legacy rows
  // ("running 29 days") over the cancelled pair rows after every restart.
  it('a pair-delta viewer receives no legacy DELTA frame, yet the durable cursor still advances', () => {
    save('tsk_5', { status: 'cancelled' });
    save('p-live');
    registry.handleFrame(subscribe());
    sent.length = 0;
    const before = producer.restoreCursor(SCOPE);

    appendLegacyEvent('tsk_5');
    appendLegacyEvent('tsk_b');
    registry.refreshActiveSubscriptions();

    expect(framesOf(SUPERVISION_TASK_CONSOLE_MSG.DELTA)).toEqual([]);
    expect(sent).toEqual([]);
    const after = producer.restoreCursor(SCOPE);
    expect(after.lastDurableEventId).toBeGreaterThan(before.lastDurableEventId ?? 0);
    expect(after.projectionVersion).toBe(before.projectionVersion + 2);
  });

  it('a legacy-protocol viewer of a pairs project gets none either (its rows are pair rows too)', () => {
    save('tsk_5', { status: 'cancelled' });
    registry.handleFrame(subscribe({ features: undefined }));
    sent.length = 0;
    appendLegacyEvent('tsk_5');
    registry.refreshActiveSubscriptions();
    expect(framesOf(SUPERVISION_TASK_CONSOLE_MSG.DELTA)).toEqual([]);
  });

  it('a project that is NOT on the pairs engine keeps receiving legacy deltas (unchanged behaviour)', () => {
    process.env[ENGINE_ENV] = 'legacy';
    seedLegacyTask('tsk_5');
    registry.handleFrame(subscribe({ features: undefined }));
    sent.length = 0;
    appendLegacyEvent('tsk_5');
    registry.refreshActiveSubscriptions();
    expect(framesOf(SUPERVISION_TASK_CONSOLE_MSG.DELTA)).toHaveLength(1);
  });
});

describe('several viewers of one scope (second tab, phone, compact panel + full console)', () => {
  // Production: the daemon kept ONE subscription per scope. The newest subscribe
  // won, every older viewer's frames were stamped with the new id and dropped as
  // stale by the older viewer forever, and when the newest viewer left it deleted
  // the only subscription, leaving everyone else with a frozen view.
  it('each viewer keeps its own subscription, pair view and pair revision', () => {
    save('p1'); save('p2');
    registry.handleFrame(subscribe({ subscriptionId: 'sub-A', clientId: 'tab-A' }));
    registry.handleFrame(subscribe({ subscriptionId: 'sub-B', clientId: 'tab-B' }));
    expect(framesOf(SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT, 'sub-A')).toHaveLength(1);
    expect(framesOf(SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT, 'sub-B')).toHaveLength(1);
    sent.length = 0;

    save('p1', { round: 1 });
    registry.pairsChanged(PROJECT, ['p1'], 'task_pair_changed');
    const deltaA = framesOf(SUPERVISION_TASK_CONSOLE_MSG.PAIR_DELTA, 'sub-A');
    const deltaB = framesOf(SUPERVISION_TASK_CONSOLE_MSG.PAIR_DELTA, 'sub-B');
    expect(deltaA).toHaveLength(1);
    expect(deltaB).toHaveLength(1);
    expect(deltaA[0].pairRevision).toBe(1);
    expect(deltaB[0].pairRevision).toBe(1);

    // A viewer that subscribes later starts at its own revision 0 without
    // disturbing the older viewers' revision sequence.
    registry.handleFrame(subscribe({ subscriptionId: 'sub-C', clientId: 'tab-C' }));
    sent.length = 0;
    save('p1', { round: 2 });
    registry.pairsChanged(PROJECT, ['p1'], 'task_pair_changed');
    expect(framesOf(SUPERVISION_TASK_CONSOLE_MSG.PAIR_DELTA, 'sub-A')[0].pairRevision).toBe(2);
    expect(framesOf(SUPERVISION_TASK_CONSOLE_MSG.PAIR_DELTA, 'sub-B')[0].pairRevision).toBe(2);
    expect(framesOf(SUPERVISION_TASK_CONSOLE_MSG.PAIR_DELTA, 'sub-C')[0].pairRevision).toBe(1);
  });

  it('a viewer leaving removes only its own subscription', () => {
    save('p1');
    registry.handleFrame(subscribe({ subscriptionId: 'sub-A', clientId: 'tab-A' }));
    registry.handleFrame(subscribe({ subscriptionId: 'sub-B', clientId: 'tab-B' }));
    registry.handleFrame({ type: SUPERVISION_TASK_CONSOLE_MSG.UNSUBSCRIBE, scope: SCOPE, subscriptionId: 'sub-B' });
    sent.length = 0;
    save('p1', { round: 1 });
    registry.pairsChanged(PROJECT, ['p1'], 'task_pair_changed');
    expect(framesOf(SUPERVISION_TASK_CONSOLE_MSG.PAIR_DELTA, 'sub-A')).toHaveLength(1);
    expect(framesOf(SUPERVISION_TASK_CONSOLE_MSG.PAIR_DELTA, 'sub-B')).toHaveLength(0);
    expect(registry.activeSubscriptionCount).toBe(1);
  });

  it('a re-subscribe by the SAME viewer replaces its previous subscription instead of piling up', () => {
    save('p1');
    registry.handleFrame(subscribe({ subscriptionId: 'a-1', clientId: 'tab-A' }));
    registry.handleFrame(subscribe({ subscriptionId: 'a-2', clientId: 'tab-A' }));
    expect(registry.activeSubscriptionCount).toBe(1);
    sent.length = 0;
    save('p1', { round: 1 });
    registry.pairsChanged(PROJECT, ['p1'], 'task_pair_changed');
    expect(framesOf(SUPERVISION_TASK_CONSOLE_MSG.PAIR_DELTA).map((frame) => frame.subscriptionId)).toEqual(['a-2']);
  });

  it('viewers that predate clientId keep the old one-subscription-per-scope behaviour', () => {
    save('p1');
    registry.handleFrame(subscribe({ subscriptionId: 'old-1' }));
    registry.handleFrame(subscribe({ subscriptionId: 'old-2' }));
    expect(registry.activeSubscriptionCount).toBe(1);
    expect(registry.activeSubscriptionId(SCOPE)).toBe('old-2');
  });

  it('answers every viewer that subscribed during one yielded replay, not only the last', async () => {
    producer.ensureProjectionBaseline(SCOPE);
    seedLegacyTask('tsk_a');
    for (let i = 0; i < 96; i += 1) {
      db.prepare(`INSERT INTO supervision_task_events (task_id, assignment_id, event_type, status, payload_json, created_at)
        VALUES ('tsk_a', NULL, 'implementing', 'implementing', '{}', ?)`).run(10 + i);
    }
    registry.handleFrame(subscribe({ subscriptionId: 'sub-A', clientId: 'tab-A' }));
    registry.handleFrame(subscribe({ subscriptionId: 'sub-B', clientId: 'tab-B' }));
    expect(sent).toHaveLength(0);
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(framesOf(SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT).map((frame) => frame.subscriptionId).sort()).toEqual(['sub-A', 'sub-B']);
  });

  it('bounds the viewers per scope so abandoned subscriptions cannot accumulate', () => {
    save('p1');
    for (let i = 0; i < 20; i += 1) registry.handleFrame(subscribe({ subscriptionId: `s-${i}`, clientId: `tab-${i}` }));
    expect(registry.activeSubscriptionCount).toBeLessThanOrEqual(8);
    expect(registry.activeSubscriptionId(SCOPE)).toBe('s-19');
  });
});

describe('the engine behind a scope changing under an open viewer', () => {
  // Production: the project flipped legacy-engine <-> pairs while a viewer was
  // subscribed. Nothing told the viewer, so it kept the other engine's rows (the
  // legacy `delegated` rows) until some unrelated pair save happened.
  it('off/legacy -> pairs: the viewer is told to resync', () => {
    process.env[ENGINE_ENV] = 'legacy';
    seedLegacyTask('tsk_5');
    registry.handleFrame(subscribe());
    sent.length = 0;
    process.env[ENGINE_ENV] = 'pairs';
    registry.reconcileProjectEngines();
    expect(sent).toEqual([expect.objectContaining({
      type: SUPERVISION_TASK_CONSOLE_MSG.RESYNC_REQUIRED, subscriptionId: 'sub-1', reason: 'task_pair_changed',
    })]);
    // Told once; the unanswered request is not repeated every tick.
    sent.length = 0;
    registry.reconcileProjectEngines();
    expect(sent).toEqual([]);
  });

  it('pairs -> legacy: the viewer is told to resync', () => {
    save('p1');
    registry.handleFrame(subscribe());
    sent.length = 0;
    process.env[ENGINE_ENV] = 'legacy';
    registry.reconcileProjectEngines();
    expect(framesOf(SUPERVISION_TASK_CONSOLE_MSG.RESYNC_REQUIRED, 'sub-1')).toHaveLength(1);
  });

  it('an unchanged engine costs no frame', () => {
    save('p1');
    registry.handleFrame(subscribe());
    sent.length = 0;
    registry.reconcileProjectEngines();
    expect(sent).toEqual([]);
  });
});
