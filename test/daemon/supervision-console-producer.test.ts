import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  SupervisionConsoleProducer,
  SUPERVISION_CRASH_BOUNDARIES,
  type SupervisionCrashBoundary,
} from '../../src/daemon/supervision-console-producer.js';
import {
  migrateSupervisionStore,
  type SupervisionMigrationDb,
} from '../../src/daemon/supervision-store-migrations.js';
import { resolveMissingSupervisionSessionPresentation } from '../../src/daemon/lifecycle.js';
import type { SupervisionTaskConsoleDelta } from '../../shared/supervision-task-console.js';
import type { SupervisionAuditReceipt } from '../../shared/supervision-audit-handoff.js';

const SCOPE = { projectName: 'codedeck', coordinatorSessionName: 'deck_cd_brain' };
const EPOCH = 'epoch-1';
const ATTEMPT = '140fa35f-126f-4175-884d-1a2464bb25e8';
const REVISION = '3eacaeca54522a05cb174831f19a2721d2e102c805b269437b3f9988064ac4ae';

const LEGACY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS supervision_tasks (
    task_id TEXT PRIMARY KEY, top_level_task_id TEXT NOT NULL, classification TEXT NOT NULL,
    status TEXT NOT NULL, current_revision TEXT, commit_sha TEXT, push_remote_ref TEXT,
    blocker TEXT, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS supervision_task_assignments (
    assignment_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL,
    session_name TEXT NOT NULL, session_instance_id TEXT NOT NULL, runtime_epoch TEXT NOT NULL,
    agent_type TEXT NOT NULL, provider_family TEXT NOT NULL, lease_id TEXT NOT NULL,
    generation INTEGER NOT NULL, audit_attempt_id TEXT, audit_revision TEXT, verdict TEXT,
    blocker TEXT, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS supervision_task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, assignment_id TEXT,
    event_type TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT, created_at INTEGER NOT NULL);
`;

let db: DatabaseSync;
let sent: SupervisionTaskConsoleDelta[];
let clock: number;

function asDb(): SupervisionMigrationDb { return db as unknown as SupervisionMigrationDb; }

function producer(over: Partial<{
  onBoundary: (b: SupervisionCrashBoundary) => void;
  broadcast: boolean;
  epoch: string;
  resolveSessionPresentation: (sessionName: string, durableObservedAt: number) => {
    label?: string;
    state: 'running' | 'idle' | 'needs_input' | 'offline' | 'unknown';
    source: 'runtime' | 'supervision' | 'registry';
    observedAt: number;
  } | undefined;
}> = {}) {
  return new SupervisionConsoleProducer(asDb(), {
    projectionEpoch: over.epoch ?? EPOCH,
    now: () => ++clock,
    onBoundary: over.onBoundary,
    broadcast: over.broadcast === false ? undefined : (frame) => { sent.push(frame); },
    resolveSessionPresentation: over.resolveSessionPresentation,
  });
}

function seedTask(status = 'auditing'): void {
  db.prepare(`INSERT INTO supervision_tasks
    (task_id, project_name, top_level_task_id, classification, status, current_revision, payload_json, created_at, updated_at)
    VALUES ('tsk_console','codedeck','top','slice',?,?,'{}',1,1)`).run(status, REVISION);
  db.prepare(`INSERT INTO supervision_task_assignments
    (assignment_id, task_id, role, status, session_name, session_instance_id, runtime_epoch,
     agent_type, provider_family, lease_id, generation, audit_attempt_id, payload_json, created_at, updated_at)
    VALUES ('asg_console','tsk_console','implementer',?, 'deck_sub_4s48141x','i','e','codex','openai','l',1,?,'{}',1,1)`)
    .run(status, ATTEMPT);
}

function receipt(over: Partial<SupervisionAuditReceipt> = {}): SupervisionAuditReceipt {
  return {
    attemptId: ATTEMPT, taskId: 'tsk_console', assignmentId: 'asg_console',
    revision: REVISION, verdict: 'PASS', auditorSessionName: 'deck_sub_1g6w5672',
    receivedAt: 1, ...over,
  };
}

function counts() {
  const one = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
  return {
    events: one('SELECT COUNT(*) AS n FROM supervision_task_events'),
    outbox: one('SELECT COUNT(*) AS n FROM supervision_outbox'),
    projection: one('SELECT COUNT(*) AS n FROM supervision_projection_state'),
  };
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(LEGACY_SCHEMA);
  migrateSupervisionStore(asDb());
  sent = [];
  clock = 100;
});

describe('transactional event + projection + outbox', () => {
  it('writes all three atomically and broadcasts once', () => {
    seedTask('implementing');
    const result = producer().appendTaskEvent({
      scope: SCOPE, taskId: 'tsk_console', eventType: 'implementing', status: 'implementing',
    });
    expect(result.projectionVersion).toBe(1);
    expect(counts()).toEqual({ events: 1, outbox: 1, projection: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.projectionVersion).toBe(1);
    expect(sent[0]!.eventId).toBe(result.eventId);
  });

  it('advances projectionVersion densely across appends', () => {
    seedTask('implementing');
    const p = producer();
    const versions = [1, 2, 3].map(() => p.appendTaskEvent({
      scope: SCOPE, taskId: 'tsk_console', eventType: 'implementing', status: 'implementing',
    }).projectionVersion);
    expect(versions).toEqual([1, 2, 3]);
  });
});

describe('crash boundary matrix', () => {
  const PRE_COMMIT: SupervisionCrashBoundary[] = [
    'after_event_insert', 'after_projection_update', 'after_outbox_insert', 'before_commit',
  ];

  it.each(PRE_COMMIT)('crash at %s persists NOTHING and broadcasts nothing', (boundary) => {
    seedTask('implementing');
    const p = producer({ onBoundary: (b) => { if (b === boundary) throw new Error(`crash:${b}`); } });
    expect(() => p.appendTaskEvent({
      scope: SCOPE, taskId: 'tsk_console', eventType: 'implementing', status: 'implementing',
    })).toThrow(`crash:${boundary}`);
    expect(counts(), boundary).toEqual({ events: 0, outbox: 0, projection: 0 });
    expect(sent, boundary).toHaveLength(0);
  });

  it('crash AFTER commit before broadcast keeps the frame pending for redelivery', () => {
    seedTask('implementing');
    const p = producer({ onBoundary: (b) => { if (b === 'after_commit_before_broadcast') throw new Error('crash'); } });
    expect(() => p.appendTaskEvent({
      scope: SCOPE, taskId: 'tsk_console', eventType: 'implementing', status: 'implementing',
    })).toThrow('crash');
    // Durable: committed. Not delivered.
    expect(counts()).toEqual({ events: 1, outbox: 1, projection: 1 });
    expect(sent).toHaveLength(0);
    // A fresh producer (restart) still sees it as owed.
    const pending = producer().pendingFrames(SCOPE);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.deliveryState).toBe('pending');
  });

  it('crash after broadcast before ack still owes the frame until acked', () => {
    seedTask('implementing');
    const p = producer({ onBoundary: (b) => { if (b === 'after_broadcast_before_ack') throw new Error('crash'); } });
    expect(() => p.appendTaskEvent({
      scope: SCOPE, taskId: 'tsk_console', eventType: 'implementing', status: 'implementing',
    })).toThrow('crash');
    const pending = producer().pendingFrames(SCOPE);
    expect(pending).toHaveLength(1);
    // Sent but unacked is still owed: at-least-once, never at-most-once.
    expect(pending[0]!.deliveryState).toBe('sent');
  });

  it('covers every declared boundary', () => {
    expect(new Set(SUPERVISION_CRASH_BOUNDARIES)).toEqual(new Set([
      ...PRE_COMMIT, 'after_commit_before_broadcast', 'after_broadcast_before_ack',
    ]));
  });
});

describe('restart reconstruction from SQLite alone', () => {
  it('restores the projection cursor, not a reset one', () => {
    seedTask('implementing');
    const first = producer();
    first.appendTaskEvent({ scope: SCOPE, taskId: 'tsk_console', eventType: 'implementing', status: 'implementing' });
    first.appendTaskEvent({ scope: SCOPE, taskId: 'tsk_console', eventType: 'implementing', status: 'implementing' });
    // "Restart": brand new instance, same DB, no in-memory state.
    const restored = producer().restoreCursor(SCOPE);
    expect(restored.projectionVersion).toBe(2);
    expect(restored.projectionEpoch).toBe(EPOCH);
    expect(restored.lastDurableEventId).not.toBeNull();
    // And it continues the sequence rather than restarting it.
    expect(producer().appendTaskEvent({
      scope: SCOPE, taskId: 'tsk_console', eventType: 'implementing', status: 'implementing',
    }).projectionVersion).toBe(3);
  });

  it('does NOT let a task become complete merely because the daemon restarted', () => {
    seedTask('auditing');
    const before = db.prepare('SELECT status FROM supervision_tasks').get();
    producer().restoreCursor(SCOPE);
    producer().buildSnapshot(SCOPE, 'sub-1');
    expect(db.prepare('SELECT status FROM supervision_tasks').get()).toEqual(before);
  });

  it('rebuilds the integration queue and owner without model context', () => {
    seedTask('auditing');
    db.prepare("UPDATE supervision_tasks SET integration_owner = 'deck_cd_cc2'").run();
    producer().applyAuditReceipt(SCOPE, receipt());
    const queue = producer().integrationQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      taskId: 'tsk_console', integrationOwner: 'deck_cd_cc2', attemptId: ATTEMPT, revision: REVISION,
    });
    expect(queue[0]!.nextAction).toContain('deck_cd_cc2');
  });

  it('acks durably and stops re-owing acked frames', () => {
    seedTask('implementing');
    const p = producer();
    p.appendTaskEvent({ scope: SCOPE, taskId: 'tsk_console', eventType: 'implementing', status: 'implementing' });
    p.appendTaskEvent({ scope: SCOPE, taskId: 'tsk_console', eventType: 'implementing', status: 'implementing' });
    expect(producer().pendingFrames(SCOPE)).toHaveLength(2);
    producer().recordAck(SCOPE, 1);
    const remaining = producer().pendingFrames(SCOPE);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.projectionVersion).toBe(2);
  });
});

describe('assignment, pool and validation projections', () => {
  it('projects assignments with pool kind, observed provider and validation state', () => {
    seedTask('implementing');
    db.prepare(`UPDATE supervision_task_assignments SET pool_kind='primary',
      validation_state='passed', observed_model='gpt-5.6-sol', observed_provider='openai',
      heartbeat_at=555 WHERE assignment_id='asg_console'`).run();
    const rows = producer().readAssignmentRows(SCOPE.projectName);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      assignmentId: 'asg_console', taskId: 'tsk_console', status: 'implementing', phase: 'active',
      role: 'implementer', ownerSessionName: 'deck_sub_4s48141x', poolKind: 'primary',
      observedModel: 'gpt-5.6-sol', observedProvider: 'openai', validationState: 'passed',
      heartbeatAt: 555,
    });
  });

  it('falls back to provider_family when no observed provider is recorded', () => {
    seedTask('implementing');
    expect(producer().readAssignmentRows(SCOPE.projectName)[0]!.observedProvider).toBe('openai');
  });

  it('coerces an unknown validation state / pool kind to fail-closed values', () => {
    seedTask('implementing');
    db.exec('DROP TRIGGER IF EXISTS supervision_assignments_pool_kind_guard');
    db.prepare("UPDATE supervision_task_assignments SET pool_kind='turbo', validation_state='maybe'").run();
    const row = producer().readAssignmentRows(SCOPE.projectName)[0]!;
    expect(row.poolKind).toBeUndefined();
    expect(row.validationState).toBe('unknown');
  });

  it('skips an assignment whose durable status is not in the contract', () => {
    seedTask('implementing');
    db.exec('DROP TRIGGER IF EXISTS supervision_task_assignments_status_guard_update');
    db.prepare("UPDATE supervision_task_assignments SET status='scope_violation'").run();
    expect(producer().readAssignmentRows(SCOPE.projectName)).toHaveLength(0);
  });

  it('always projects BOTH pools, including at zero occupancy', () => {
    seedTask('implementing');
    const empty = producer().readPools(SCOPE.projectName);
    expect(empty.map((p) => p.poolId)).toEqual(['primary', 'economy']);
    expect(empty.every((p) => p.activeCount === 0)).toBe(true);
    expect(empty[0]!.capacity).toBeGreaterThan(0);
    db.prepare("UPDATE supervision_task_assignments SET pool_kind='economy'").run();
    const occupied = producer().readPools(SCOPE.projectName);
    expect(occupied.find((p) => p.poolId === 'economy')!.activeCount).toBe(1);
    expect(occupied.find((p) => p.poolId === 'primary')!.activeCount).toBe(0);
  });

  it('does not count terminal assignments as occupying a pool', () => {
    seedTask('implementing');
    db.prepare("UPDATE supervision_task_assignments SET pool_kind='primary', status='finalized'").run();
    expect(producer().readPools(SCOPE.projectName).find((p) => p.poolId === 'primary')!.activeCount).toBe(0);
  });

  it('ships assignments and pools inside the snapshot', () => {
    seedTask('implementing');
    db.prepare("UPDATE supervision_task_assignments SET pool_kind='primary'").run();
    const snapshot = producer().buildSnapshot(SCOPE, 'sub-1');
    expect(snapshot.assignments).toHaveLength(1);
    expect(snapshot.pools).toHaveLength(2);
    expect(snapshot.tasks).toHaveLength(1);
  });

  it('projects the canonical objective and daemon-authoritative owner activity', () => {
    seedTask('implementing');
    db.prepare("UPDATE supervision_tasks SET payload_json=? WHERE task_id='tsk_console'")
      .run(JSON.stringify({ objective: 'Build a human-readable activity board' }));
    const snapshot = producer({
      resolveSessionPresentation: (sessionName) => sessionName === 'deck_sub_4s48141x'
        ? { label: 'Cx7', state: 'needs_input', source: 'supervision', observedAt: 444 }
        : undefined,
    }).buildSnapshot(SCOPE, 'sub-presentation');
    expect(snapshot.tasks[0]!.title).toBe('Build a human-readable activity board');
    expect(snapshot.assignments[0]).toMatchObject({
      ownerSessionName: 'deck_sub_4s48141x',
      ownerSessionLabel: 'Cx7',
      sessionState: 'needs_input',
      sessionStateSource: 'supervision',
      sessionStateObservedAt: 444,
    });
  });

  it('keeps a missing owner offline at its durable assignment timestamp', () => {
    seedTask('implementing');
    db.prepare("UPDATE supervision_task_assignments SET updated_at=731 WHERE assignment_id='asg_console'").run();
    const snapshot = producer({
      resolveSessionPresentation: (_sessionName, durableObservedAt) => (
        resolveMissingSupervisionSessionPresentation(durableObservedAt)
      ),
    }).buildSnapshot(SCOPE, 'sub-missing-owner');

    expect(snapshot.assignments[0]).toMatchObject({
      sessionState: 'offline',
      sessionStateSource: 'registry',
      sessionStateObservedAt: 731,
      updatedAt: 731,
    });
  });

  it('never projects tasks or assignments from another project', () => {
    seedTask('implementing');
    db.prepare(`INSERT INTO supervision_tasks
      (task_id, project_name, top_level_task_id, classification, status, payload_json, created_at, updated_at)
      VALUES ('tsk_other','other','other-top','slice','implementing','{}',1,1)`).run();
    db.prepare(`INSERT INTO supervision_task_assignments
      (assignment_id, task_id, role, status, session_name, session_instance_id, runtime_epoch,
       agent_type, provider_family, lease_id, generation, payload_json, created_at, updated_at)
      VALUES ('asg_other','tsk_other','implementer','implementing','deck_other_w1','i2','e2',
       'codex','openai','l2',1,'{}',1,1)`).run();
    const snapshot = producer().buildSnapshot(SCOPE, 'sub-project');
    expect(snapshot.tasks.map((task) => task.taskId)).toEqual(['tsk_console']);
    expect(snapshot.assignments.map((assignment) => assignment.assignmentId)).toEqual(['asg_console']);
    expect(() => producer().appendTaskEvent({
      scope: SCOPE,
      taskId: 'tsk_other',
      eventType: 'implementing',
      status: 'implementing',
    })).toThrow('outside the requested project scope');
    expect(() => producer().applyAuditReceipt(
      { projectName: 'other', coordinatorSessionName: 'deck_other_brain' },
      receipt(),
    )).toThrow('audit receipt is outside the requested project scope');
  });

  it('projects the task validation state from the durable column', () => {
    seedTask('implementing');
    db.prepare("UPDATE supervision_tasks SET validation_state='failed', heartbeat_at=42").run();
    const row = producer().readTaskRow('tsk_console', SCOPE.projectName)!;
    expect(row.validationState).toBe('failed');
    expect(row.heartbeatAt).toBe(42);
  });
});

describe('audit receipt persistence', () => {
  beforeEach(() => {
    seedTask('auditing');
    db.prepare("UPDATE supervision_tasks SET integration_owner = 'deck_cd_cc2'").run();
  });

  it('PASS promotes, assigns the owner, queues and emits a delta', () => {
    const decision = producer().applyAuditReceipt(SCOPE, receipt());
    expect(decision.action).toBe('promote_to_integration');
    const row = db.prepare('SELECT status, integration_owner, next_action FROM supervision_tasks').get() as Record<string, string>;
    expect(row.status).toBe('ready_for_integration');
    expect(row.integration_owner).toBe('deck_cd_cc2');
    expect(row.next_action).toContain('deck_cd_cc2');
    expect(sent.some((f) => f.op === 'task_upsert')).toBe(true);
  });

  it('is idempotent on a replayed receipt', () => {
    const p = producer();
    p.applyAuditReceipt(SCOPE, receipt());
    const outboxAfterFirst = counts().outbox;
    const second = p.applyAuditReceipt(SCOPE, receipt());
    expect(second.refusal).toBe('duplicate_receipt');
    expect(second.action).toBe('hold');
    expect(counts().outbox).toBe(outboxAfterFirst);
    expect(Number((db.prepare('SELECT COUNT(*) AS n FROM supervision_audit_attestations').get() as { n: number }).n)).toBe(1);
  });

  it('a stale-revision PASS cannot advance and records why', () => {
    const decision = producer().applyAuditReceipt(SCOPE, receipt({ revision: 'deadbeef' }));
    expect(decision.refusal).toBe('stale_revision');
    const row = db.prepare('SELECT status, blocked_reason FROM supervision_tasks').get() as Record<string, string>;
    expect(row.status).toBe('auditing');
    expect(row.blocked_reason).toContain('deadbeef');
  });

  it('REWORK returns to rework and clears the queue', () => {
    const p = producer();
    p.applyAuditReceipt(SCOPE, receipt());
    expect(p.integrationQueue()).toHaveLength(1);
    db.prepare("UPDATE supervision_tasks SET status = 'auditing'").run();
    db.prepare("UPDATE supervision_task_assignments SET audit_attempt_id = 'attempt-2'").run();
    const decision = p.applyAuditReceipt(SCOPE, receipt({ attemptId: 'attempt-2', verdict: 'REWORK', findings: 'phase drift' }));
    expect(decision.action).toBe('return_to_rework');
    expect(db.prepare('SELECT status FROM supervision_tasks').get()).toEqual({ status: 'rework' });
    expect(p.integrationQueue()).toHaveLength(0);
  });

  it('never projects a row whose durable status is not in the contract', () => {
    // Bypass the trigger the way a corrupted/legacy row would look.
    db.exec('DROP TRIGGER IF EXISTS supervision_tasks_status_guard_update');
    db.prepare("UPDATE supervision_tasks SET status = 'file_event'").run();
    expect(producer().readTaskRow('tsk_console', SCOPE.projectName)).toBeUndefined();
    expect(producer().buildSnapshot(SCOPE, 'sub-1').tasks).toHaveLength(0);
  });
});
