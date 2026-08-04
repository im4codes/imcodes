import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import {
  AGENT_DELEGATION_PURPOSES,
  AGENT_DELEGATION_REPLY_STATUSES,
} from '../../shared/agent-delegation.js';
import { DelegationReplyStore } from '../../src/daemon/delegation-reply-store.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

const origin = {
  sessionName: 'deck_project_brain',
  sessionInstanceId: 'origin_instance',
  runtimeEpoch: 'origin_epoch',
};
const target = {
  sessionName: 'deck_sub_auditor',
  sessionInstanceId: 'target_instance',
  runtimeEpoch: 'target_epoch',
};

describe('DelegationReplyStore', () => {
  it('binds one capability to both session identities and consumes it only after delivery', () => {
    const database = new DatabaseSync(':memory:');
    const store = new DelegationReplyStore({ database });
    const created = store.create({
      origin,
      target,
      dispatchId: 'dispatch_1',
      messageId: 'message_1',
      purpose: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
      auditAttemptId: 'audit_attempt_1',
      now: 1_000,
    });

    expect(created.record).toMatchObject({
      status: AGENT_DELEGATION_REPLY_STATUSES.PENDING,
      purpose: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
      auditAttemptId: 'audit_attempt_1',
    });
    expect(created.record.capabilityHash).not.toBe(created.replyCapability);
    expect(store.matchPendingAuthority({
      delegationId: created.record.delegationId,
      replyCapability: created.replyCapability,
      now: 1_001,
    })).toMatchObject({ delegationId: created.record.delegationId });
    expect(store.matchPendingAuthority({
      delegationId: created.record.delegationId,
      replyCapability: `${created.replyCapability}x`,
      now: 1_001,
    })).toBeUndefined();
    expect(store.receive({
      delegationId: created.record.delegationId,
      replyCapability: `${created.replyCapability}x`,
      result: 'result',
      sender: target,
      now: 2_000,
    })).toEqual({ ok: false, reason: 'capability' });
    expect(store.receive({
      delegationId: created.record.delegationId,
      replyCapability: created.replyCapability,
      result: 'result',
      sender: { ...target, runtimeEpoch: 'replacement_epoch' },
      now: 2_000,
    })).toEqual({ ok: false, reason: 'identity' });

    const accepted = store.receive({
      delegationId: created.record.delegationId,
      replyCapability: created.replyCapability,
      result: 'result',
      sender: target,
      now: 2_000,
    });
    expect(accepted).toMatchObject({
      ok: true,
      replay: false,
      record: {
        status: AGENT_DELEGATION_REPLY_STATUSES.RECEIVED,
        result: 'result',
      },
    });
    expect(store.receive({
      delegationId: created.record.delegationId,
      replyCapability: created.replyCapability,
      result: 'result',
      sender: target,
      now: 2_001,
    })).toMatchObject({ ok: true, replay: true });
    expect(store.receive({
      delegationId: created.record.delegationId,
      replyCapability: created.replyCapability,
      result: 'different result',
      sender: target,
      now: 2_001,
    })).toEqual({ ok: false, reason: 'already_replied' });

    expect(store.markDelivered(created.record.delegationId, 3_000)).toBe(true);
    expect(store.get(created.record.delegationId)).toMatchObject({
      status: AGENT_DELEGATION_REPLY_STATUSES.DELIVERED,
      deliveredAt: 3_000,
    });
    expect(store.receive({
      delegationId: created.record.delegationId,
      replyCapability: created.replyCapability,
      result: 'result',
      sender: target,
      now: 3_001,
    })).toEqual({ ok: false, reason: 'already_replied' });
    store.close();
    database.close();
  });

  it('expires an authority without exposing or accepting its capability', () => {
    const database = new DatabaseSync(':memory:');
    const store = new DelegationReplyStore({ database });
    const created = store.create({
      origin,
      target,
      dispatchId: 'dispatch_2',
      messageId: 'message_2',
      now: 1,
    });
    const record = store.get(created.record.delegationId);
    expect(record).not.toHaveProperty('replyCapability');
    expect(store.receive({
      delegationId: created.record.delegationId,
      replyCapability: created.replyCapability,
      result: 'late',
      sender: target,
      now: created.record.expiresAt,
    })).toEqual({ ok: false, reason: 'expired' });
    expect(store.get(created.record.delegationId)?.status).toBe(AGENT_DELEGATION_REPLY_STATUSES.EXPIRED);
    store.close();
    database.close();
  });

  it('migrates an existing reply database before storing structured audit purpose', () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE delegation_replies (
        delegation_id TEXT PRIMARY KEY,
        capability_hash TEXT NOT NULL,
        origin_session_name TEXT NOT NULL,
        origin_session_instance_id TEXT NOT NULL,
        origin_runtime_epoch TEXT NOT NULL,
        target_session_name TEXT NOT NULL,
        target_session_instance_id TEXT NOT NULL,
        target_runtime_epoch TEXT NOT NULL,
        dispatch_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        notification_id TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        delivered_at INTEGER
      )
    `);
    const store = new DelegationReplyStore({ database });
    const created = store.create({
      origin,
      target,
      dispatchId: 'dispatch_migrated',
      messageId: 'message_migrated',
      purpose: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
      auditAttemptId: 'audit_attempt_migrated',
      now: 10,
    });
    expect(created.record).toMatchObject({
      purpose: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
      auditAttemptId: 'audit_attempt_migrated',
    });
    store.close();
    database.close();
  });
});
