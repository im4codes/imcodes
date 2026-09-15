import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { SupervisionConsoleSessionRegistry } from '../../src/daemon/supervision-console-session.js';
import { SupervisionConsoleProducer } from '../../src/daemon/supervision-console-producer.js';
import { migrateSupervisionStore, type SupervisionMigrationDb } from '../../src/daemon/supervision-store-migrations.js';
import {
  SUPERVISION_TASK_CONSOLE_MSG, SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
} from '../../shared/supervision-task-console.js';
import { SUPERVISION_TASK_STATUS_CONTRACT_VERSION } from '../../shared/supervision-config.js';

const SCOPE = { projectName: 'codedeck', coordinatorSessionName: 'deck_cd_brain' };
const OTHER = { projectName: 'codedeck', coordinatorSessionName: 'deck_other_brain' };
const EPOCH = 'epoch-1';

const LEGACY = `
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

let db: DatabaseSync; let sent: any[]; let producer: SupervisionConsoleProducer;
let registry: SupervisionConsoleSessionRegistry; let clock: number;

function subscribe(over: Record<string, unknown> = {}) {
  return {
    type: SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE, scope: SCOPE, subscriptionId: 'sub-1',
    afterEventId: null, reason: 'initial',
    schemaVersion: SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
    statusContractVersion: SUPERVISION_TASK_STATUS_CONTRACT_VERSION,
    projectionVersion: 0, lastDurableEventId: null, projectionEpoch: EPOCH, ...over,
  };
}
function emit() {
  return producer.appendTaskEvent({ scope: SCOPE, taskId: 'tsk_a', eventType: 'implementing', status: 'implementing' });
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(LEGACY);
  migrateSupervisionStore(db as unknown as SupervisionMigrationDb);
  db.prepare(`INSERT INTO supervision_tasks (task_id, project_name, top_level_task_id, classification, status,
    payload_json, created_at, updated_at) VALUES ('tsk_a','codedeck','top','slice','implementing','{}',1,1)`).run();
  sent = []; clock = 0;
  producer = new SupervisionConsoleProducer(db as unknown as SupervisionMigrationDb, {
    projectionEpoch: EPOCH, now: () => ++clock,
    broadcast: (frame) => registry.broadcast(frame),
  });
  registry = new SupervisionConsoleSessionRegistry({
    producer, send: (f) => sent.push(f), authorize: (s) => s.coordinatorSessionName === SCOPE.coordinatorSessionName,
  });
});

describe('subscribe', () => {
  it('answers afterEventId:null with a full snapshot carrying the subscriptionId', () => {
    expect(registry.handleFrame(subscribe())).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe(SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT);
    expect(sent[0].subscriptionId).toBe('sub-1');
    expect(sent[0].tasks).toHaveLength(1);
    expect(sent[0].projectionEpoch).toBe(EPOCH);
  });

  it('is SILENT for an unauthorized scope: no frame at all', () => {
    expect(registry.handleFrame(subscribe({ scope: OTHER }))).toBe(true);
    expect(sent).toHaveLength(0);
    expect(registry.refusedCount).toBe(1);
  });

  it('replays contiguous owed deltas on catch-up', () => {
    const first = emit(); emit();
    sent.length = 0;
    registry.handleFrame(subscribe({ afterEventId: first.eventId - 1, projectionVersion: 0 }));
    expect(sent.map((f) => f.projectionVersion)).toEqual([1, 2]);
    expect(sent.every((f) => f.subscriptionId === 'sub-1')).toBe(true);
  });

  it('explicitly confirms the snapshot when the reconnect cursor is already current', () => {
    const r = emit();
    sent.length = 0;
    registry.handleFrame(subscribe({ afterEventId: r.eventId, projectionVersion: 1 }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT,
      subscriptionId: 'sub-1',
      projectionVersion: 1,
      lastDurableEventId: r.eventId,
    });
  });

  it('demands resync rather than patching across a pruned outbox', () => {
    emit(); const second = emit();
    producer.recordAck(SCOPE, 1);
    sent.length = 0;
    // Client claims version 0 but v1 is acked/pruned: the hole is unpatchable.
    registry.handleFrame(subscribe({ afterEventId: second.eventId - 2, projectionVersion: 0 }));
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe(SUPERVISION_TASK_CONSOLE_MSG.RESYNC_REQUIRED);
    expect(sent[0].reason).toBe('outbox_truncated');
  });

  it('demands resync on epoch, schema and status-contract mismatch', () => {
    for (const [over, reason] of [
      [{ projectionEpoch: 'epoch-9' }, 'authority_epoch_changed'],
      [{ schemaVersion: 99 }, 'schema_mismatch'],
      [{ statusContractVersion: 99 }, 'status_contract_mismatch'],
    ] as const) {
      sent.length = 0;
      registry.handleFrame(subscribe({ afterEventId: 0, ...over }));
      expect(sent[0]?.reason, reason).toBe(reason);
    }
  });
});

describe('ack', () => {
  it('prunes the outbox durably', () => {
    emit(); emit();
    registry.handleFrame(subscribe());
    registry.handleFrame({ type: SUPERVISION_TASK_CONSOLE_MSG.ACK, scope: SCOPE, subscriptionId: 'sub-1', projectionVersion: 1 });
    expect(producer.pendingFrames(SCOPE).map((r) => r.projectionVersion)).toEqual([2]);
  });

  it('IGNORES an ack from a superseded subscription', () => {
    emit(); emit();
    registry.handleFrame(subscribe({ subscriptionId: 'sub-1' }));
    registry.handleFrame(subscribe({ subscriptionId: 'sub-2' }));
    registry.handleFrame({ type: SUPERVISION_TASK_CONSOLE_MSG.ACK, scope: SCOPE, subscriptionId: 'sub-1', projectionVersion: 2 });
    expect(producer.pendingFrames(SCOPE)).toHaveLength(2);
  });

  it('is silent and inert for an unauthorized ack', () => {
    emit();
    registry.handleFrame({ type: SUPERVISION_TASK_CONSOLE_MSG.ACK, scope: OTHER, subscriptionId: 'x', projectionVersion: 9 });
    expect(producer.pendingFrames(SCOPE)).toHaveLength(1);
    expect(registry.refusedCount).toBe(1);
  });
});

describe('live broadcast + unsubscribe', () => {
  it('pushes new deltas to the active subscriber', () => {
    registry.handleFrame(subscribe());
    sent.length = 0;
    emit();
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe(SUPERVISION_TASK_CONSOLE_MSG.DELTA);
    expect(sent[0].subscriptionId).toBe('sub-1');
  });

  it('stops pushing after unsubscribe, but the frame stays durable', () => {
    registry.handleFrame(subscribe());
    registry.handleFrame({ type: SUPERVISION_TASK_CONSOLE_MSG.UNSUBSCRIBE, scope: SCOPE, subscriptionId: 'sub-1' });
    sent.length = 0;
    emit();
    expect(sent).toHaveLength(0);
    expect(producer.pendingFrames(SCOPE)).toHaveLength(1);
  });

  it('does not let a stale unsubscribe drop the current subscription', () => {
    registry.handleFrame(subscribe({ subscriptionId: 'sub-1' }));
    registry.handleFrame(subscribe({ subscriptionId: 'sub-2' }));
    registry.handleFrame({ type: SUPERVISION_TASK_CONSOLE_MSG.UNSUBSCRIBE, scope: SCOPE, subscriptionId: 'sub-1' });
    expect(registry.activeSubscriptionId(SCOPE)).toBe('sub-2');
  });
});

describe('frame ownership', () => {
  it('claims only its own message types', () => {
    expect(registry.handleFrame({ type: 'session.send' })).toBe(false);
    expect(registry.handleFrame(null)).toBe(false);
    expect(registry.handleFrame({ type: SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT })).toBe(true);
    expect(sent).toHaveLength(0);
  });
});
