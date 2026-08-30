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
      auditAttemptId: 'audit_attempt_1', sender: target, now: created.record.expiresAt + 1,
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
    expect(store.matchPendingAuditAuthority({ auditAttemptId: 'attempt-audit-1', sender: target, now: 101 })?.delegationId)
      .toBe(created.record.delegationId);
    expect(store.matchPendingAuditAuthority({ auditAttemptId: 'attempt-audit-other', sender: target, now: 101 })).toBeUndefined();

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
        auditAttemptId: 'attempt-restart', sender: target, now: created.record.expiresAt + 10_000,
      })).toMatchObject({ taskId: 'task-restart', assignmentId: 'assignment-restart' });
      expect(reopened.receive({ delegationId: created.record.delegationId, result: 'restored', sender: target }))
        .toMatchObject({ ok: true, replay: false });
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
