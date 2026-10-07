/**
 * tsk_58c8fb1b73 per-call cost of the code that now runs per poll tick / per
 * legacy delta: the engine check. Production-shaped: 600 stored sessions, one
 * project Brain with a saved supervision snapshot, the maximum 8 viewers on
 * one scope. Numbers are printed for the audit; the assertions are generous
 * ceilings that only fail on an order-of-magnitude regression.
 */
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessions: any[] = [];
vi.mock('../../src/store/session-store.js', () => ({
  listSessions: () => sessions,
  getSession: (name: string) => sessions.find((session) => session.name === name),
}));

import {
  SUPERVISION_CONSOLE_MAX_VIEWERS_PER_SCOPE,
  SupervisionConsoleSessionRegistry,
} from '../../src/daemon/supervision-console-session.js';
import { SupervisionConsoleProducer } from '../../src/daemon/supervision-console-producer.js';
import { migrateSupervisionStore, type SupervisionMigrationDb } from '../../src/daemon/supervision-store-migrations.js';
import { TaskPairStore, setTaskPairStoreForTests } from '../../src/daemon/task-pairs/store.js';
import { SUPERVISION_TASK_CONSOLE_MSG, SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION } from '../../shared/supervision-task-console.js';
import { SUPERVISION_TASK_STATUS_CONTRACT_VERSION } from '../../shared/supervision-config.js';
import { TASK_PAIR_ENGINE_ENV } from '../../shared/task-pair.js';

const SCOPE = { projectName: 'cd', coordinatorSessionName: 'deck_cd_brain' };

describe('engine-check cost at production shape', () => {
  beforeEach(() => {
    delete process.env[TASK_PAIR_ENGINE_ENV];
    sessions.length = 0;
    for (let i = 0; i < 600; i += 1) {
      sessions.push({ name: `deck_proj${i % 40}_w${i}`, projectName: `proj${i % 40}`, role: 'w', transportConfig: null });
    }
    sessions.push({
      name: 'deck_cd_brain', projectName: 'cd', role: 'brain',
      transportConfig: { supervision: { mode: 'supervised', pairEngine: 'pairs' } },
    });
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
  });

  it('reconcile over 8 viewers of one scope, and a legacy broadcast, stay far below a millisecond', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE supervision_tasks (task_id TEXT PRIMARY KEY, top_level_task_id TEXT NOT NULL,
        classification TEXT NOT NULL, status TEXT NOT NULL, current_revision TEXT, commit_sha TEXT,
        push_remote_ref TEXT, blocker TEXT, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE supervision_task_assignments (assignment_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
        role TEXT NOT NULL, status TEXT NOT NULL, session_name TEXT NOT NULL, session_instance_id TEXT NOT NULL,
        runtime_epoch TEXT NOT NULL, agent_type TEXT NOT NULL, provider_family TEXT NOT NULL,
        lease_id TEXT NOT NULL, generation INTEGER NOT NULL, audit_attempt_id TEXT, audit_revision TEXT,
        verdict TEXT, blocker TEXT, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE supervision_task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
        assignment_id TEXT, event_type TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT, created_at INTEGER NOT NULL);
    `);
    migrateSupervisionStore(db as unknown as SupervisionMigrationDb);
    const sent: unknown[] = [];
    let registry!: SupervisionConsoleSessionRegistry;
    const producer = new SupervisionConsoleProducer(db as unknown as SupervisionMigrationDb, {
      projectionEpoch: 'e', now: () => 1, broadcast: (frame) => registry.broadcast(frame),
    });
    registry = new SupervisionConsoleSessionRegistry({ producer, send: (frame) => sent.push(frame), authorize: () => true });
    for (let i = 0; i < SUPERVISION_CONSOLE_MAX_VIEWERS_PER_SCOPE; i += 1) {
      registry.handleFrame({
        type: SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE, scope: SCOPE, subscriptionId: `s${i}`, clientId: `c${i}`,
        afterEventId: null, reason: 'initial', schemaVersion: SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
        statusContractVersion: SUPERVISION_TASK_STATUS_CONTRACT_VERSION, projectionVersion: 0,
        lastDurableEventId: null, projectionEpoch: 'e',
      });
    }
    expect(registry.activeSubscriptionCount).toBe(SUPERVISION_CONSOLE_MAX_VIEWERS_PER_SCOPE);
    sent.length = 0;

    // Per-call cost of the cheapest of several batches: a batch slowed down by a neighbour on a shared runner is not what the code costs.
    const batch = 400;
    const cheapestMsPerCall = (run: () => void): number => {
      let cheapest = Number.POSITIVE_INFINITY;
      for (let round = 0; round < 6; round += 1) {
        const startedAt = performance.now();
        for (let i = 0; i < batch; i += 1) run();
        cheapest = Math.min(cheapest, (performance.now() - startedAt) / batch);
      }
      return cheapest;
    };
    const reconcileMs = cheapestMsPerCall(() => registry.reconcileProjectEngines());
    expect(sent).toEqual([]);

    const delta = { type: SUPERVISION_TASK_CONSOLE_MSG.DELTA, scope: SCOPE, subscriptionId: '' } as never;
    const broadcastMs = cheapestMsPerCall(() => registry.broadcast(delta));

    console.log(JSON.stringify({ sessions: sessions.length, viewers: SUPERVISION_CONSOLE_MAX_VIEWERS_PER_SCOPE, reconcileMsPerTick: +reconcileMs.toFixed(4), broadcastMsPerLegacyDelta: +broadcastMs.toFixed(4) }));
    expect(reconcileMs).toBeLessThan(1);
    expect(broadcastMs).toBeLessThan(1);
  });

  it('one pair change fanned out to 1, 3 and 8 viewers of a 228-pair project (production shape)', () => {
    process.env[TASK_PAIR_ENGINE_ENV] = 'pairs';
    const store = new TaskPairStore(':memory:');
    setTaskPairStoreForTests(store);
    const save = (taskId: string, over: Record<string, unknown> = {}) => store.savePair('cd', {
      taskId, brain: 'deck_cd_brain', executor: `deck_sub_${taskId}_x`, auditor: `deck_sub_${taskId}_a`,
      title: `Pair ${taskId}`, status: 'working', flags: [], flagSides: {}, round: 0, blocking: ['P0'],
      previousAuditors: [], createdAt: 1, updatedAt: 1_000, brief: `# brief\n${'- [ ][ ] item\n'.repeat(60)}`, executorPool: 'primary',
      ...over,
    } as never, { liveness: { silenceExecutor: 0, silenceAuditor: 0, progressExecutorAt: 1, progressAuditorAt: 1 } as never });
    for (let i = 0; i < 228; i += 1) save(`p${i}`);
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE supervision_tasks (task_id TEXT PRIMARY KEY, top_level_task_id TEXT NOT NULL,
        classification TEXT NOT NULL, status TEXT NOT NULL, current_revision TEXT, commit_sha TEXT,
        push_remote_ref TEXT, blocker TEXT, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE supervision_task_assignments (assignment_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
        role TEXT NOT NULL, status TEXT NOT NULL, session_name TEXT NOT NULL, session_instance_id TEXT NOT NULL,
        runtime_epoch TEXT NOT NULL, agent_type TEXT NOT NULL, provider_family TEXT NOT NULL,
        lease_id TEXT NOT NULL, generation INTEGER NOT NULL, audit_attempt_id TEXT, audit_revision TEXT,
        verdict TEXT, blocker TEXT, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE supervision_task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
        assignment_id TEXT, event_type TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT, created_at INTEGER NOT NULL);
    `);
    migrateSupervisionStore(db as unknown as SupervisionMigrationDb);
    const sent: any[] = [];
    let registry!: SupervisionConsoleSessionRegistry;
    const producer = new SupervisionConsoleProducer(db as unknown as SupervisionMigrationDb, {
      projectionEpoch: 'e', now: () => 1, snapshotCacheTtlMs: 0, broadcast: (frame) => registry.broadcast(frame),
    });
    registry = new SupervisionConsoleSessionRegistry({ producer, send: (frame) => sent.push(frame), authorize: () => true });
    const result: Record<string, number> = {};
    let round = 0;
    for (const viewers of [1, 3, SUPERVISION_CONSOLE_MAX_VIEWERS_PER_SCOPE]) {
      for (let i = 0; i < SUPERVISION_CONSOLE_MAX_VIEWERS_PER_SCOPE; i += 1) {
        registry.handleFrame({ type: SUPERVISION_TASK_CONSOLE_MSG.UNSUBSCRIBE, scope: SCOPE, subscriptionId: `s${i}` });
      }
      for (let i = 0; i < viewers; i += 1) {
        registry.handleFrame({
          type: SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE, scope: SCOPE, subscriptionId: `s${i}`, clientId: `c${i}`,
          afterEventId: null, reason: 'initial', features: ['pair_delta_v1'], schemaVersion: SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
          statusContractVersion: SUPERVISION_TASK_STATUS_CONTRACT_VERSION, projectionVersion: 0, lastDurableEventId: null, projectionEpoch: 'e',
        });
      }
      sent.length = 0;
      const runs = 20;
      const startedAt = performance.now();
      for (let i = 0; i < runs; i += 1) {
        round += 1;
        save('p100', { round });
        registry.pairsChanged('cd', ['p100'], 'task_pair_changed');
      }
      result[`viewers${viewers}`] = +((performance.now() - startedAt) / runs).toFixed(2);
      expect(sent.filter((frame) => frame.type === SUPERVISION_TASK_CONSOLE_MSG.PAIR_DELTA)).toHaveLength(runs * viewers);
    }
    console.log(JSON.stringify({ pairs: 228, msPerPairChangeIncludingSave: result }));
    expect(result.viewers8!).toBeLessThan(50);
  });
});

