import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AGENT_DELEGATION_PURPOSES,
  AGENT_DELEGATION_REPLY_MAX_MESSAGES,
  AGENT_DELEGATION_REPLY_STATUSES,
} from '../../shared/agent-delegation.js';
import { DelegationReplyStore } from '../../src/daemon/delegation-reply-store.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

const origin = { sessionName: 'deck_project_brain', sessionInstanceId: 'origin_instance', runtimeEpoch: 'origin_epoch' };
const target = { sessionName: 'deck_sub_auditor', sessionInstanceId: 'target_instance', runtimeEpoch: 'target_epoch' };

describe('DelegationReplyStore', () => {
  it('persists an assignment-bound audit authority and accepts append-only idempotent replies without a token', () => {
    const database = new DatabaseSync(':memory:');
    const store = new DelegationReplyStore({ database });
    const created = store.create({
      origin,
      target,
      dispatchId: 'dispatch_1',
      messageId: 'message_1',
      purpose: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
      auditAttemptId: 'audit_attempt_1',
      auditRevision: 'revision-1',
      auditedSessionName: origin.sessionName,
      taskId: 'supervision_task_1',
      assignmentId: 'supervision_assignment_1',
      now: 1_000,
    });

    expect(created).not.toHaveProperty('replyCapability');
    expect(created.record).toMatchObject({
      status: AGENT_DELEGATION_REPLY_STATUSES.PENDING,
      purpose: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
      taskId: 'supervision_task_1',
      assignmentId: 'supervision_assignment_1',
      capabilityHash: '',
    });
    expect(store.matchPendingAuditAuthority({
      taskId: 'supervision_task_1', assignmentId: 'supervision_assignment_1',
      auditAttemptId: 'audit_attempt_1', auditRevision: 'revision-1',
      sender: target, now: created.record.expiresAt + 1,
    })?.delegationId).toBe(created.record.delegationId);
    expect(store.receive({
      delegationId: created.record.delegationId,
      result: 'progress',
      sender: { ...target, runtimeEpoch: 'replacement_epoch' },
      now: 2_000,
    })).toEqual({ ok: false, reason: 'identity' });

    const first = store.receive({ delegationId: created.record.delegationId, result: 'progress', sender: target, now: 2_000 });
    const second = store.receive({ delegationId: created.record.delegationId, result: 'final', sender: target, now: 2_001 });
    expect(first).toMatchObject({ ok: true, replay: false });
    expect(second).toMatchObject({ ok: true, replay: false });
    expect(store.receive({ delegationId: created.record.delegationId, result: 'final', sender: target, now: 2_002 }))
      .toMatchObject({ ok: true, replay: true });
    store.close();
    database.close();
  });

  it('resolves a supervision audit by exact unique attempt and supports an explicit assignment rebind', () => {
    const database = new DatabaseSync(':memory:');
    const store = new DelegationReplyStore({ database });
    const created = store.create({
      origin, target, dispatchId: 'dispatch-audit', messageId: 'message-audit',
      purpose: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
      auditAttemptId: 'attempt-audit-1', auditRevision: 'revision-1',
      taskId: 'task-1', assignmentId: 'assignment-1', now: 100,
    });
    expect(store.matchPendingAuditAuthority({
      taskId: 'task-1', assignmentId: 'assignment-1', auditAttemptId: 'attempt-audit-1',
      auditRevision: 'revision-1', sender: target, now: 101,
    })?.delegationId)
      .toBe(created.record.delegationId);
    expect(store.matchPendingAuditAuthority({
      taskId: 'task-1', assignmentId: 'assignment-1', auditAttemptId: 'attempt-audit-other',
      auditRevision: 'revision-1', sender: target, now: 101,
    })).toBeUndefined();

    const rebound = { sessionName: target.sessionName, sessionInstanceId: 'replacement-instance', runtimeEpoch: 'replacement-epoch' };
    expect(store.rebindAssignmentTarget({
      delegationId: created.record.delegationId, taskId: 'wrong-task', assignmentId: 'assignment-1', target: rebound,
    })).toBeUndefined();
    expect(store.rebindAssignmentTarget({
      delegationId: created.record.delegationId, taskId: 'task-1', assignmentId: 'assignment-1', target: rebound,
    })?.target).toEqual(rebound);
    expect(store.receive({ delegationId: created.record.delegationId, result: 'after rebind', sender: target }))
      .toEqual({ ok: false, reason: 'identity' });
    expect(store.receive({ delegationId: created.record.delegationId, result: 'after rebind', sender: rebound }))
      .toMatchObject({ ok: true, replay: false });
    store.close();
    database.close();
  });

  it('replaces exact audit redelivery authority while conflicting origin history remains non-authoritative', () => {
    const database = new DatabaseSync(':memory:');
    const store = new DelegationReplyStore({ database });
    const exact = {
      origin,
      target,
      messageId: 'message-stable',
      purpose: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
      auditAttemptId: 'attempt-exact',
      auditRevision: 'revision-exact',
      taskId: 'task-exact',
      assignmentId: 'assignment-exact',
    } as const;
    const expired = store.create({ ...exact, dispatchId: 'dispatch-failed', now: 100 });
    store.expire(expired.record.delegationId, 101);
    store.create({ ...exact, dispatchId: 'dispatch-old-attempt', auditAttemptId: 'attempt-old', now: 102 });
    store.create({ ...exact, dispatchId: 'dispatch-old-revision', auditRevision: 'revision-old', now: 103 });
    store.create({ ...exact, dispatchId: 'dispatch-other-task', taskId: 'task-other', now: 104 });
    store.create({ ...exact, dispatchId: 'dispatch-other-assignment', assignmentId: 'assignment-other', now: 105 });
    store.create({
      ...exact,
      dispatchId: 'dispatch-old-sender',
      target: { ...target, runtimeEpoch: 'old-epoch' },
      now: 105,
    });
    const priorCurrent = store.create({ ...exact, dispatchId: 'dispatch-before-redelivery', now: 105 });
    const current = store.create({ ...exact, dispatchId: 'dispatch-redelivery', now: 106 });
    const match = () => store.matchPendingAuditAuthority({
      taskId: exact.taskId,
      assignmentId: exact.assignmentId,
      auditAttemptId: exact.auditAttemptId,
      auditRevision: exact.auditRevision,
      sender: target,
      now: 107,
    });

    expect(store.get(expired.record.delegationId)?.status).toBe(AGENT_DELEGATION_REPLY_STATUSES.EXPIRED);
    expect(store.get(priorCurrent.record.delegationId)?.status).toBe(AGENT_DELEGATION_REPLY_STATUSES.EXPIRED);
    // Simulate two equivalent pending rows persisted by a pre-fix daemon.
    database.prepare('UPDATE delegation_replies SET status = ? WHERE delegation_id = ?')
      .run(AGENT_DELEGATION_REPLY_STATUSES.PENDING, priorCurrent.record.delegationId);
    expect(match()?.delegationId).toBe(current.record.delegationId);
    expect(store.get(priorCurrent.record.delegationId)?.status).toBe(AGENT_DELEGATION_REPLY_STATUSES.EXPIRED);
    expect(match()?.messageId).toBe(exact.messageId);
    expect(store.matchPendingAuditAuthority({
      taskId: exact.taskId,
      assignmentId: exact.assignmentId,
      auditAttemptId: exact.auditAttemptId,
      auditRevision: exact.auditRevision,
      sender: { ...target, runtimeEpoch: 'wrong-epoch' },
      now: 107,
    })).toBeUndefined();

    store.create({
      ...exact,
      origin: { ...origin, runtimeEpoch: 'conflicting-origin-epoch' },
      dispatchId: 'dispatch-conflicting-current',
      now: 108,
    });
    expect(match()).toBeUndefined();
    expect(store.get(expired.record.delegationId)?.status).toBe(AGENT_DELEGATION_REPLY_STATUSES.EXPIRED);
    store.close();
    database.close();
  });

  it('restores a still-valid assignment-bound audit authority after daemon restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-delegation-reply-'));
    const dbPath = join(dir, 'replies.sqlite');
    try {
      const first = new DelegationReplyStore({ dbPath });
      const created = first.create({
        origin, target, dispatchId: 'dispatch-restart', messageId: 'message-restart',
        purpose: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
        auditAttemptId: 'attempt-restart', auditRevision: 'revision-restart',
        taskId: 'task-restart', assignmentId: 'assignment-restart', now: 1,
      });
      first.close();

      const reopened = new DelegationReplyStore({ dbPath });
      expect(reopened.matchPendingAuditAuthority({
        taskId: 'task-restart', assignmentId: 'assignment-restart',
        auditAttemptId: 'attempt-restart', auditRevision: 'revision-restart',
        sender: target, now: created.record.expiresAt + 10_000,
      })).toMatchObject({ taskId: 'task-restart', assignmentId: 'assignment-restart' });
      expect(reopened.receive({ delegationId: created.record.delegationId, result: 'restored', sender: target }))
        .toMatchObject({ ok: true, replay: false });
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('selects one exact ordinary assignment authority and fails closed on duplicate current rows', () => {
    const database = new DatabaseSync(':memory:');
    const store = new DelegationReplyStore({ database });
    const exact = {
      origin,
      target,
      taskId: 'task-ordinary',
      assignmentId: 'assignment-ordinary',
      messageId: 'message-ordinary',
    } as const;
    const first = store.create({ ...exact, dispatchId: 'dispatch-first', now: 100 });
    const resolve = () => store.findCurrentAssignmentAuthority({
      taskId: exact.taskId,
      assignmentId: exact.assignmentId,
      origin,
      target,
      now: 200,
    });
    expect(resolve()).toMatchObject({ status: 'matched', record: { delegationId: first.record.delegationId } });

    const duplicate = store.create({ ...exact, dispatchId: 'dispatch-duplicate', now: 101 });
    expect(resolve()).toEqual({ status: 'ambiguous' });
    store.expire(first.record.delegationId, 102);
    expect(resolve()).toMatchObject({ status: 'matched', record: { delegationId: duplicate.record.delegationId } });
    expect(store.receive({
      delegationId: duplicate.record.delegationId,
      result: 'completed',
      sender: target,
      now: 201,
    })).toMatchObject({ ok: true });
    expect(resolve()).toEqual({ status: 'none' });
    store.close();
    database.close();
  });

  it('accepts multiple ordinary replies, deduplicates each result, and keeps them bounded', () => {
    const database = new DatabaseSync(':memory:');
    const store = new DelegationReplyStore({ database });
    const created = store.create({ origin, target, dispatchId: 'dispatch_multi', messageId: 'message_multi', now: 1_000 });
    for (let index = 0; index < AGENT_DELEGATION_REPLY_MAX_MESSAGES; index += 1) {
      expect(store.receive({
        delegationId: created.record.delegationId, result: `reply ${index}`, sender: target, now: 2_000 + index,
      })).toMatchObject({ ok: true, replay: false });
    }
    expect(store.receive({ delegationId: created.record.delegationId, result: 'reply 0', sender: target, now: 3_000 }))
      .toMatchObject({ ok: true, replay: true });
    expect(store.receive({ delegationId: created.record.delegationId, result: 'one too many', sender: target, now: 3_001 }))
      .toEqual({ ok: false, reason: 'limit' });
    expect(store.listReceived()).toHaveLength(AGENT_DELEGATION_REPLY_MAX_MESSAGES);
    store.close();
    database.close();
  });

  it('expires an ordinary authority but never exposes a bearer token', () => {
    const database = new DatabaseSync(':memory:');
    const store = new DelegationReplyStore({ database });
    const created = store.create({ origin, target, dispatchId: 'dispatch_2', messageId: 'message_2', now: 1 });
    expect(created).not.toHaveProperty('replyCapability');
    expect(store.receive({
      delegationId: created.record.delegationId, result: 'late', sender: target, now: created.record.expiresAt,
    })).toEqual({ ok: false, reason: 'expired' });
    expect(store.get(created.record.delegationId)?.status).toBe(AGENT_DELEGATION_REPLY_STATUSES.EXPIRED);
    store.close();
    database.close();
  });

  it('migrates historical capability columns without requiring or validating the token', () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE delegation_replies (
        delegation_id TEXT PRIMARY KEY, capability_hash TEXT NOT NULL,
        origin_session_name TEXT NOT NULL, origin_session_instance_id TEXT NOT NULL, origin_runtime_epoch TEXT NOT NULL,
        target_session_name TEXT NOT NULL, target_session_instance_id TEXT NOT NULL, target_runtime_epoch TEXT NOT NULL,
        dispatch_id TEXT NOT NULL, message_id TEXT NOT NULL, notification_id TEXT NOT NULL,
        status TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, delivered_at INTEGER
      )
    `);
    const store = new DelegationReplyStore({ database });
    const created = store.create({
      origin, target, dispatchId: 'dispatch_migrated', messageId: 'message_migrated',
      purpose: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT, auditAttemptId: 'audit_attempt_migrated', now: 10,
    });
    expect(created.record).toMatchObject({
      purpose: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
      auditAttemptId: 'audit_attempt_migrated',
      capabilityHash: '',
    });
    store.close();
    database.close();
  });
});

// A pending task-bound return is addressed to the ORIGINAL coordinator
// assignment. When that coordinator's runtime legitimately rotates, the reply
// must move WITH the authorization -- not be lost, and not silently delivered to
// whoever now holds the session name.
describe('authorized coordinator origin rebind', () => {
  const A = { sessionName: 'deck_alpha_brain', sessionInstanceId: 'origin-instance', runtimeEpoch: 'origin-epoch' };
  const T = { sessionName: 'deck_sub_worker', sessionInstanceId: 'target-instance', runtimeEpoch: 'target-epoch' };

  const COORD = 'asg_coordinator_r4';
  function seed() {
    const database = new DatabaseSync(':memory:');
    const store = new DelegationReplyStore({ database });
    const created = store.create({
      origin: A, target: T, dispatchId: 'd-1', messageId: 'm-1',
      taskId: 'task-1', assignmentId: 'assignment-1',
      coordinatorAssignmentId: COORD, now: 100,
    });
    return { database, store, created };
  }

  it('advances the pending reply onto the re-authorized origin without losing it', () => {
    const { database, store, created } = seed();
    const rotated = { ...A, sessionInstanceId: 'origin-instance-2', runtimeEpoch: 'origin-epoch-2' };
    const rebound = store.rebindAuthorizedOrigin({
      delegationId: created.record.delegationId,
      taskId: 'task-1', assignmentId: 'assignment-1', coordinatorAssignmentId: COORD, origin: rotated,
    });
    expect(rebound?.origin).toEqual(rotated);
    // The record itself survives the rebind: same delegation, same result path.
    expect(store.get(created.record.delegationId)?.delegationId).toBe(created.record.delegationId);
    store.close(); database.close();
  });

  it('refuses a rebind that does not carry the exact task+assignment authority', () => {
    const { database, store, created } = seed();
    const rotated = { ...A, sessionInstanceId: 'origin-instance-2', runtimeEpoch: 'origin-epoch-2' };
    expect(store.rebindAuthorizedOrigin({
      delegationId: created.record.delegationId, taskId: 'wrong-task', assignmentId: 'assignment-1', coordinatorAssignmentId: COORD, origin: rotated,
    })).toBeUndefined();
    expect(store.rebindAuthorizedOrigin({
      delegationId: created.record.delegationId, taskId: 'task-1', assignmentId: 'wrong-assignment', coordinatorAssignmentId: COORD, origin: rotated,
    })).toBeUndefined();
    expect(store.get(created.record.delegationId)?.origin).toEqual(A);
    store.close(); database.close();
  });

  it('never adopts a DIFFERENT coordinator session name', () => {
    const { database, store, created } = seed();
    expect(store.rebindAuthorizedOrigin({
      delegationId: created.record.delegationId, taskId: 'task-1', assignmentId: 'assignment-1',
      coordinatorAssignmentId: COORD,
      origin: { sessionName: 'deck_alpha_clone_brain', sessionInstanceId: 'x', runtimeEpoch: 'y' },
    }), 'a different name is a different coordinator, not a rotation').toBeUndefined();
    expect(store.get(created.record.delegationId)?.origin).toEqual(A);
    store.close(); database.close();
  });

  it('is idempotent: repeating the same rebind changes nothing further', () => {
    const { database, store, created } = seed();
    const rotated = { ...A, sessionInstanceId: 'origin-instance-2', runtimeEpoch: 'origin-epoch-2' };
    const first = store.rebindAuthorizedOrigin({
      delegationId: created.record.delegationId, taskId: 'task-1', assignmentId: 'assignment-1', coordinatorAssignmentId: COORD, origin: rotated,
    });
    const second = store.rebindAuthorizedOrigin({
      delegationId: created.record.delegationId, taskId: 'task-1', assignmentId: 'assignment-1', coordinatorAssignmentId: COORD, origin: rotated,
    });
    expect(second?.origin).toEqual(first?.origin);
    store.close(); database.close();
  });
});

// R4 gap, self-reported: the durable return authority carried taskId +
// assignmentId (the worker/auditor) but NOT the ORIGINAL coordinator assignment.
// These assertions are deliberately round-trip based -- they read the value back
// out of SQLite -- so they cannot be satisfied by an inert excess property on a
// record literal, which is exactly how the R4 test fooled itself.
describe('coordinatorAssignmentId is a persisted, load-bearing authority field', () => {
  const A = { sessionName: 'deck_alpha_brain', sessionInstanceId: 'origin-instance', runtimeEpoch: 'origin-epoch' };
  const T = { sessionName: 'deck_sub_worker', sessionInstanceId: 'target-instance', runtimeEpoch: 'target-epoch' };
  const COORD = 'asg_coordinator_1';

  function seed(coordinatorAssignmentId: string | null = COORD) {
    const database = new DatabaseSync(':memory:');
    const store = new DelegationReplyStore({ database });
    const created = store.create({
      origin: A, target: T, dispatchId: 'd-1', messageId: 'm-1',
      taskId: 'task-1', assignmentId: 'assignment-1',
      ...(coordinatorAssignmentId != null ? { coordinatorAssignmentId } : {}),
      now: 100,
    });
    return { database, store, created };
  }

  it('persists the coordinator assignment and reads it back across a store reopen', () => {
    const database = new DatabaseSync(':memory:');
    const store = new DelegationReplyStore({ database });
    const created = store.create({
      origin: A, target: T, dispatchId: 'd-1', messageId: 'm-1',
      taskId: 'task-1', assignmentId: 'assignment-1', coordinatorAssignmentId: COORD, now: 100,
    });
    // Round-trip through SQLite, not the in-memory literal.
    expect(store.get(created.record.delegationId)?.coordinatorAssignmentId).toBe(COORD);
    store.close();
    const reopened = new DelegationReplyStore({ database });
    expect(
      reopened.get(created.record.delegationId)?.coordinatorAssignmentId,
      'the authority must survive a daemon restart',
    ).toBe(COORD);
    reopened.close(); database.close();
  });

  it('refuses an origin rebind that names the WRONG coordinator assignment', () => {
    const { database, store, created } = seed();
    const rotated = { ...A, sessionInstanceId: 'origin-instance-2', runtimeEpoch: 'origin-epoch-2' };
    expect(store.rebindAuthorizedOrigin({
      delegationId: created.record.delegationId, taskId: 'task-1', assignmentId: 'assignment-1',
      coordinatorAssignmentId: 'asg_some_other_coordinator', origin: rotated,
    }), 'only the task\'s original coordinator assignment may advance its return').toBeUndefined();
    expect(store.get(created.record.delegationId)?.origin).toEqual(A);
    store.close(); database.close();
  });

  it('accepts an origin rebind that carries the exact coordinator assignment', () => {
    const { database, store, created } = seed();
    const rotated = { ...A, sessionInstanceId: 'origin-instance-2', runtimeEpoch: 'origin-epoch-2' };
    expect(store.rebindAuthorizedOrigin({
      delegationId: created.record.delegationId, taskId: 'task-1', assignmentId: 'assignment-1',
      coordinatorAssignmentId: COORD, origin: rotated,
    })?.origin).toEqual(rotated);
    store.close(); database.close();
  });

  it('fails closed when the record carries no coordinator assignment at all', () => {
    const { database, store, created } = seed(null);
    const rotated = { ...A, sessionInstanceId: 'origin-instance-2', runtimeEpoch: 'origin-epoch-2' };
    expect(store.rebindAuthorizedOrigin({
      delegationId: created.record.delegationId, taskId: 'task-1', assignmentId: 'assignment-1',
      coordinatorAssignmentId: COORD, origin: rotated,
    }), 'an unbound legacy record must not be adoptable by any coordinator').toBeUndefined();
    expect(store.get(created.record.delegationId)?.origin).toEqual(A);
    store.close(); database.close();
  });
});

// R5 gap found by the cross-vendor auditor: rebindAuthorizedOrigin existed but
// had ZERO production callers. The capability was tested in isolation and never
// connected to the authoritative coordinator rebind, so a real rebind still
// stranded the pending reply. Connecting it needs a query for the returns a
// given coordinator assignment owns.
describe('pending returns are discoverable by their owning coordinator assignment', () => {
  const A = { sessionName: 'deck_alpha_brain', sessionInstanceId: 'origin-instance', runtimeEpoch: 'origin-epoch' };
  const T = { sessionName: 'deck_sub_worker', sessionInstanceId: 'target-instance', runtimeEpoch: 'target-epoch' };
  const COORD = 'asg_coordinator_1';

  function seed(database: InstanceType<typeof DatabaseSync>) {
    const store = new DelegationReplyStore({ database });
    const mine = store.create({
      origin: A, target: T, dispatchId: 'd-1', messageId: 'm-1',
      taskId: 'task-1', assignmentId: 'assignment-1', coordinatorAssignmentId: COORD, now: 100,
    });
    const otherCoordinator = store.create({
      origin: A, target: T, dispatchId: 'd-2', messageId: 'm-2',
      taskId: 'task-1', assignmentId: 'assignment-2', coordinatorAssignmentId: 'asg_other', now: 101,
    });
    const otherTask = store.create({
      origin: A, target: T, dispatchId: 'd-3', messageId: 'm-3',
      taskId: 'task-2', assignmentId: 'assignment-3', coordinatorAssignmentId: COORD, now: 102,
    });
    return { store, mine, otherCoordinator, otherTask };
  }

  it('lists only the returns owned by that exact task + coordinator assignment', () => {
    const database = new DatabaseSync(':memory:');
    const { store, mine } = seed(database);
    const found = store.listPendingByCoordinator({ taskId: 'task-1', coordinatorAssignmentId: COORD });
    expect(found.map((record) => record.delegationId)).toEqual([mine.record.delegationId]);
    store.close(); database.close();
  });

  it('returns nothing for a coordinator that owns no returns on that task', () => {
    const database = new DatabaseSync(':memory:');
    const { store } = seed(database);
    expect(store.listPendingByCoordinator({ taskId: 'task-1', coordinatorAssignmentId: 'asg_unknown' })).toEqual([]);
    store.close(); database.close();
  });

  it('survives a reopen so a restart can still find what to advance', () => {
    const database = new DatabaseSync(':memory:');
    const { store, mine } = seed(database);
    store.close();
    const reopened = new DelegationReplyStore({ database });
    expect(
      reopened.listPendingByCoordinator({ taskId: 'task-1', coordinatorAssignmentId: COORD })
        .map((record) => record.delegationId),
    ).toEqual([mine.record.delegationId]);
    reopened.close(); database.close();
  });
});
