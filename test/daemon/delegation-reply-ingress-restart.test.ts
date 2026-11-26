import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_DELEGATION_NOTIFICATION_RESULTS,
} from '../../shared/agent-delegation.js';
import { PEER_AUDIT_REPLY_VERSION } from '../../shared/peer-audit.js';

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, Record<string, unknown>>(),
  deliver: vi.fn(async () => AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED),
  timelineEmit: vi.fn(),
}));

vi.mock('../../src/store/session-store.js', () => ({
  getSession: (name: string) => mocks.sessions.get(name),
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  getTransportRuntime: () => ({ deliverDelegationNotification: mocks.deliver }),
  ensureTransportRuntimeAvailable: vi.fn(async () => undefined),
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: mocks.timelineEmit },
}));

import {
  clearDelegationReplyIngressForTests,
} from '../../src/daemon/delegation-reply-ingress.js';
import {
  clearPeerAuditReplyIngressRateLimits,
  registerPeerAuditReplyIngressHandler,
  submitPeerAuditReply,
} from '../../src/daemon/peer-audit-reply-ingress.js';
import {
  getDelegationReplyStore,
  resetDelegationReplyStoreForTests,
} from '../../src/daemon/delegation-reply-store.js';
import {
  getSupervisionTaskRegistry,
  resetSupervisionTaskRegistryForTests,
  type PersistedSupervisionTaskAssignmentIdentity,
} from '../../src/daemon/supervision-state-store.js';
import { freezeSupervisionIntegrationBundle } from '../../src/daemon/supervision-integration-bundle.js';

const roots: string[] = [];
let priorRegistryPath: string | undefined;
let priorReplyPath: string | undefined;

function identity(
  sessionName: string,
  agentType = 'codex-sdk',
  providerFamily = 'openai',
): PersistedSupervisionTaskAssignmentIdentity {
  return {
    sessionName,
    sessionInstanceId: `instance-${sessionName}`,
    runtimeEpoch: `epoch-${sessionName}`,
    agentType,
    providerFamily,
  };
}

function liveSession(value: PersistedSupervisionTaskAssignmentIdentity): Record<string, unknown> {
  return {
    name: value.sessionName,
    sessionInstanceId: value.sessionInstanceId,
    runtimeEpoch: value.runtimeEpoch,
    state: 'idle',
  };
}

beforeEach(() => {
  clearDelegationReplyIngressForTests();
  clearPeerAuditReplyIngressRateLimits();
  registerPeerAuditReplyIngressHandler(null);
  resetDelegationReplyStoreForTests();
  resetSupervisionTaskRegistryForTests();
  mocks.sessions.clear();
  mocks.deliver.mockClear();
  mocks.timelineEmit.mockClear();
  priorRegistryPath = process.env.IMCODES_SUPERVISION_STATE_DB_PATH;
  priorReplyPath = process.env.IMCODES_DELEGATION_REPLY_DB_PATH;
  const root = mkdtempSync(join(tmpdir(), 'imcodes-audit-controller-restart-'));
  roots.push(root);
  process.env.IMCODES_SUPERVISION_STATE_DB_PATH = join(root, 'supervision.sqlite');
  process.env.IMCODES_DELEGATION_REPLY_DB_PATH = join(root, 'delegation-replies.sqlite');
});

afterEach(() => {
  clearDelegationReplyIngressForTests();
  resetDelegationReplyStoreForTests();
  resetSupervisionTaskRegistryForTests();
  if (priorRegistryPath === undefined) delete process.env.IMCODES_SUPERVISION_STATE_DB_PATH;
  else process.env.IMCODES_SUPERVISION_STATE_DB_PATH = priorRegistryPath;
  if (priorReplyPath === undefined) delete process.env.IMCODES_DELEGATION_REPLY_DB_PATH;
  else process.env.IMCODES_DELEGATION_REPLY_DB_PATH = priorReplyPath;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('peer audit reply controller restart recovery', () => {
  it('restores the real ready_for_audit shape once and fences duplicate and foreign authority', async () => {
    const taskId = 'tsk_restart_production_shape';
    const revision = 'restart-production-shape-r1';
    const attemptId = 'auto-audit-restart-production-shape';
    const coordinatorIdentity = identity('deck_restart_brain');
    const implementerIdentity = identity('deck_restart_w1');
    const auditorIdentity = identity('deck_sub_restart_auditor', 'claude-code-sdk', 'anthropic');
    const registry = getSupervisionTaskRegistry();
    expect(registry.createOrGet({
      taskId,
      projectName: 'restart-project',
      classification: 'integration_task',
      objective: 'prove controller restoration on production-shaped rows',
      acceptance: ['one exact final receipt'],
      auditPolicy: 'auto_strict_cross_vendor',
      currentRevision: revision,
    })).toMatchObject({ ok: true });
    const coordinator = registry.createAssignment({
      assignmentId: 'asg_restart_brain',
      taskId,
      role: 'coordinator',
      identity: coordinatorIdentity,
      required: false,
      auditRevision: revision,
    });
    const implementer = registry.createAssignment({
      assignmentId: 'asg_restart_worker',
      taskId,
      role: 'implementer',
      identity: implementerIdentity,
      required: true,
      auditRevision: revision,
      scopeFiles: ['src/exact.ts'],
    });
    if (!coordinator.ok || !implementer.ok) throw new Error('fixture assignment creation failed');
    for (const [intent, toStatus, validationState] of [
      ['start', 'implementing', undefined],
      ['record_validation', 'validated', 'passed'],
      ['open_audit', 'ready_for_audit', undefined],
    ] as const) {
      expect(registry.applyTaskIntent({
        taskId,
        assignmentId: implementer.value.assignmentId,
        expectedRevision: revision,
        intent,
        toStatus,
        ...(validationState ? { validationState } : {}),
      })).toMatchObject({ ok: true });
    }
    const bundleSource = join(roots[0]!, 'bundle-source');
    mkdirSync(join(bundleSource, 'src'), { recursive: true });
    const fileBytes = 'restart-safe exact bytes\n';
    writeFileSync(join(bundleSource, 'src/exact.ts'), fileBytes);
    const frozen = freezeSupervisionIntegrationBundle({
      taskId,
      assignmentId: implementer.value.assignmentId,
      revision,
      scopeFiles: ['src/exact.ts'],
      bundleRoot: join(roots[0]!, 'bundles'),
      snapshot: {
        worktreePath: bundleSource,
        headSha: 'a'.repeat(40),
        files: [{
          path: 'src/exact.ts',
          sha256: createHash('sha256').update(fileBytes).digest('hex'),
        }],
        stagedPaths: [],
        conflictedPaths: [],
        untrackedPaths: [],
      },
    });
    if (!frozen.ok) throw new Error(frozen.reason);
    expect(registry.bindIntegrationBundle({
      taskId,
      assignmentId: implementer.value.assignmentId,
      identity: implementerIdentity,
      revision,
      bundle: frozen.bundle,
    })).toMatchObject({ ok: true });
    const auditor = registry.createAssignment({
      assignmentId: 'asg_restart_auditor',
      taskId,
      role: 'auditor',
      identity: auditorIdentity,
      required: false,
      auditAttemptId: attemptId,
      auditRevision: revision,
    });
    if (!auditor.ok) throw new Error(auditor.reason);
    expect(registry.updateAssignment({
      assignmentId: auditor.value.assignmentId,
      identity: auditorIdentity,
      status: 'auditing',
      auditAttemptId: attemptId,
      auditRevision: revision,
    })).toMatchObject({ ok: true });
    expect(registry.getAssignment(implementer.value.assignmentId)).toMatchObject({
      status: 'ready_for_audit',
      auditRevision: revision,
    });
    expect(registry.getAssignment(implementer.value.assignmentId)).not.toHaveProperty('auditAttemptId');
    expect(getDelegationReplyStore().matchPendingAuditAuthority({
      taskId,
      assignmentId: auditor.value.assignmentId,
      auditAttemptId: attemptId,
      auditRevision: revision,
      sender: auditorIdentity,
      now: 999,
    })).toBeUndefined();

    // Close and lazily reopen both SQLite-backed stores. No controller row is
    // persisted, matching the production restart loss that triggered R3.
    resetDelegationReplyStoreForTests();
    resetSupervisionTaskRegistryForTests();
    mocks.sessions.set(coordinatorIdentity.sessionName, liveSession(coordinatorIdentity));
    mocks.sessions.set(auditorIdentity.sessionName, liveSession(auditorIdentity));
    const body = JSON.stringify({
      version: PEER_AUDIT_REPLY_VERSION,
      taskId,
      assignmentId: auditor.value.assignmentId,
      attemptId,
      revision,
      receiptKind: 'final',
      verdict: 'PASS',
      findings: 'exact production-shaped restart authority passed',
      validations: [{ kind: 'test', label: 'restart', outcome: 'passed', summary: 'real stores reopened' }],
    });

    const foreignIdentity = {
      ...auditorIdentity,
      sessionInstanceId: 'foreign-auditor-instance',
      runtimeEpoch: 'foreign-auditor-epoch',
    };
    mocks.sessions.set(auditorIdentity.sessionName, liveSession(foreignIdentity));
    await expect(submitPeerAuditReply({
      rawBody: body,
      senderSessionName: auditorIdentity.sessionName,
      now: 1_000,
    })).resolves.toEqual({
      ok: false,
      error: 'identity_mismatch',
      message: 'audit sender identity rejected: sessionInstanceId expected="instance-deck_sub_restart_auditor" actual="foreign-auditor-instance"; runtimeEpoch expected="epoch-deck_sub_restart_auditor" actual="foreign-auditor-epoch"',
    });
    expect(mocks.timelineEmit).not.toHaveBeenCalled();
    expect(getDelegationReplyStore().matchPendingAuditAuthority({
      taskId,
      assignmentId: auditor.value.assignmentId,
      auditAttemptId: attemptId,
      auditRevision: revision,
      sender: auditorIdentity,
      now: 1_000,
    })).toBeUndefined();

    mocks.sessions.set(auditorIdentity.sessionName, liveSession(auditorIdentity));
    await expect(submitPeerAuditReply({
      rawBody: body,
      senderSessionName: auditorIdentity.sessionName,
      now: 1_001,
    })).resolves.toEqual({ ok: true });
    expect(getSupervisionTaskRegistry().listAuditReceipts(taskId).filter(
      (receipt) => receipt.assignmentId === auditor.value.assignmentId
        && receipt.attemptId === attemptId
        && receipt.revision === revision
        && receipt.receiptKind === 'final',
    )).toHaveLength(1);
    expect(mocks.timelineEmit).toHaveBeenCalledTimes(1);

    await expect(submitPeerAuditReply({
      rawBody: body,
      senderSessionName: auditorIdentity.sessionName,
      now: 1_002,
    })).resolves.toEqual({ ok: false, error: 'receipt_closed' });
    expect(getSupervisionTaskRegistry().listAuditReceipts(taskId).filter(
      (receipt) => receipt.assignmentId === auditor.value.assignmentId
        && receipt.attemptId === attemptId
        && receipt.revision === revision
        && receipt.receiptKind === 'final',
    )).toHaveLength(1);
    expect(mocks.timelineEmit).toHaveBeenCalledTimes(1);
  });
});
