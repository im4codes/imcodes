import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import {
  SupervisionTaskRegistry,
  type PersistedSupervisionTaskAssignmentIdentity,
} from '../../src/daemon/supervision-state-store.js';
import { createSupervisionMcpToolHandlers } from '../../src/daemon/supervision-mcp-tools.js';
import { SUPERVISION_MCP_TOOLS } from '../../shared/supervision-mcp-tools.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';

/** The stored identity, as minted before a daemon restart. */
function storedIdentity(
  sessionName = 'deck_alpha_worker',
  agentType = 'claude-code-sdk',
  providerFamily = 'anthropic',
): PersistedSupervisionTaskAssignmentIdentity {
  return { sessionName, sessionInstanceId: 'instance-before', runtimeEpoch: 'epoch-before', agentType, providerFamily };
}

/** The SAME logical participant after a restart rotated instance/epoch. */
function rotated(base = storedIdentity()): PersistedSupervisionTaskAssignmentIdentity {
  return { ...base, sessionInstanceId: 'instance-after', runtimeEpoch: 'epoch-after' };
}

function registryWithLiveParticipants(
  live: PersistedSupervisionTaskAssignmentIdentity[],
): SupervisionTaskRegistry {
  return new SupervisionTaskRegistry({
    database: new DatabaseSync(':memory:'),
    // Specialized heartbeat recovery consumes this census. Ordinary
    // project/session authorization intentionally does not.
    resolveLiveParticipants: (projectName: string | null | undefined) => (
      projectName === 'alpha' ? live : []
    ),
  } as never);
}

function seedOwner(registry: SupervisionTaskRegistry, identity = storedIdentity()) {
  const taskId = 'tsk_identity';
  expect(registry.createOrGet({
    taskId, projectName: 'alpha', classification: 'independent_top_level',
    objective: 'identity convergence', currentRevision: 'rev-1',
  })).toMatchObject({ ok: true });
  const owner = registry.createAssignment({
    taskId, role: 'implementer', identity, scopeFiles: ['src/exact.ts'], auditRevision: 'rev-1',
  } as never);
  if (!owner.ok) throw new Error(owner.reason);
  return { taskId, owner: owner.value };
}

describe('same-logical-participant identity convergence', () => {
  it('accepts a restart-rotated identity and atomically rebinds instance/epoch on the same assignment', () => {
    const registry = registryWithLiveParticipants([rotated()]);
    const { taskId, owner } = seedOwner(registry);

    // The live gap: after a restart the caller presents the SAME logical
    // participant with a new instance/epoch and every authorization boundary
    // refused it with owner_mismatch.
    const result = registry.updateAssignment({
      assignmentId: owner.assignmentId, identity: rotated(), status: 'implementing',
    } as never);

    expect(result).toMatchObject({ ok: true });
    const bound = registry.getAssignment(owner.assignmentId)!;
    expect(bound.assignmentId).toBe(owner.assignmentId); // same object, no replacement
    expect(bound.identity.sessionInstanceId).toBe('instance-after');
    expect(bound.identity.runtimeEpoch).toBe('epoch-after');
    expect(bound.identity.sessionName).toBe('deck_alpha_worker');
    expect(registry.listAssignments(taskId)).toHaveLength(1);
  });

  it('refuses a different session name even when only one runtime is live', () => {
    const registry = registryWithLiveParticipants([rotated(storedIdentity('deck_alpha_other'))]);
    const { owner } = seedOwner(registry);

    expect(registry.updateAssignment({
      assignmentId: owner.assignmentId, identity: rotated(storedIdentity('deck_alpha_other')), status: 'implementing',
    } as never)).toMatchObject({ ok: false, reason: 'owner_mismatch' });
    expect(registry.getAssignment(owner.assignmentId)!.identity.runtimeEpoch).toBe('epoch-before');
  });

  it('accepts agent/provider migration for the same durable session', () => {
    const clone = rotated(storedIdentity('deck_alpha_worker', 'codex-sdk', 'openai'));
    const registry = registryWithLiveParticipants([clone]);
    const { owner } = seedOwner(registry);

    expect(registry.updateAssignment({
      assignmentId: owner.assignmentId, identity: clone, status: 'implementing',
    } as never)).toMatchObject({ ok: true });
    expect(registry.getAssignment(owner.assignmentId)!.identity).toMatchObject({
      sessionName: 'deck_alpha_worker', agentType: 'codex-sdk', providerFamily: 'openai',
    });
  });

  it('does not make ordinary durable authority depend on duplicate runtime observations', () => {
    const registry = registryWithLiveParticipants([
      rotated(),
      { ...rotated(), sessionInstanceId: 'instance-other', runtimeEpoch: 'epoch-other' },
    ]);
    const { owner } = seedOwner(registry);

    expect(registry.updateAssignment({
      assignmentId: owner.assignmentId, identity: rotated(), status: 'implementing',
    } as never)).toMatchObject({ ok: true });
    expect(registry.getAssignment(owner.assignmentId)!.identity.runtimeEpoch).toBe('epoch-after');
  });

  it('does not require a live-runtime census for an ordinary same-session update', () => {
    const registry = registryWithLiveParticipants([]);
    const { owner } = seedOwner(registry);

    expect(registry.updateAssignment({
      assignmentId: owner.assignmentId, identity: rotated(), status: 'implementing',
    } as never)).toMatchObject({ ok: true });
    expect(registry.getAssignment(owner.assignmentId)!.identity.runtimeEpoch).toBe('epoch-after');
  });

  it('never converges a terminal assignment', () => {
    const registry = registryWithLiveParticipants([rotated()]);
    const { owner } = seedOwner(registry);
    expect(registry.updateAssignment({
      assignmentId: owner.assignmentId, identity: storedIdentity(), status: 'cancelled',
    } as never)).toMatchObject({ ok: true });

    expect(registry.updateAssignment({
      assignmentId: owner.assignmentId, identity: rotated(), status: 'implementing',
    } as never)).toMatchObject({ ok: false });
    expect(registry.getAssignment(owner.assignmentId)!.identity.runtimeEpoch).toBe('epoch-before');
  });

  it('converges the same participant through applyTaskIntent as well as updateAssignment', () => {
    const registry = registryWithLiveParticipants([rotated()]);
    const { taskId, owner } = seedOwner(registry);

    expect(registry.applyTaskIntent({
      taskId, assignmentId: owner.assignmentId, intent: 'start', identity: rotated(),
    } as never)).toMatchObject({ ok: true });
    expect(registry.getAssignment(owner.assignmentId)!.identity.runtimeEpoch).toBe('epoch-after');
  });

  it('treats presented agent/provider changes as observational metadata', () => {
    const registry = registryWithLiveParticipants([rotated()]);
    const { owner } = seedOwner(registry);
    const impostor = { ...rotated(), agentType: 'codex-sdk', providerFamily: 'openai' };

    expect(registry.updateAssignment({
      assignmentId: owner.assignmentId, identity: impostor, status: 'implementing',
    } as never)).toMatchObject({ ok: true });
    expect(registry.getAssignment(owner.assignmentId)!.identity.agentType).toBe('codex-sdk');
    expect(registry.getAssignment(owner.assignmentId)!.identity.providerFamily).toBe('openai');
    expect(registry.getAssignment(owner.assignmentId)!.identity.runtimeEpoch).toBe('epoch-after');
  });

  it('does not use instance/epoch metadata as durable ownership', () => {
    const registry = registryWithLiveParticipants([rotated()]);
    const { owner } = seedOwner(registry);
    const asserted = { ...storedIdentity(), sessionInstanceId: 'instance-claimed', runtimeEpoch: 'epoch-claimed' };

    expect(registry.updateAssignment({
      assignmentId: owner.assignmentId, identity: asserted, status: 'implementing',
    } as never)).toMatchObject({ ok: true });
    expect(registry.getAssignment(owner.assignmentId)!.identity.runtimeEpoch).toBe('epoch-claimed');
  });

  it('keeps terminal lifecycle state closed while refreshing observational metadata', () => {
    const registry = registryWithLiveParticipants([rotated()]);
    const { taskId, owner } = seedOwner(registry);
    expect(registry.updateAssignment({
      assignmentId: owner.assignmentId, identity: storedIdentity(), status: 'cancelled',
    } as never)).toMatchObject({ ok: true });

    expect(registry.applyTaskIntent({
      taskId, assignmentId: owner.assignmentId, intent: 'start', toStatus: 'implementing', identity: rotated(),
    } as never)).toMatchObject({ ok: false });

    const closed = registry.getAssignment(owner.assignmentId)!;
    expect(closed.status).toBe('cancelled');
    expect(closed.identity.runtimeEpoch).toBe('epoch-after');
    expect(closed.identity.sessionInstanceId).toBe('instance-after');
  });

  it('lets an already-open non-terminal auditor resume on its exact task/attempt/revision after a restart', () => {
    // tsk_5ns shape: the auditor is mid-round when the daemon restarts. Its
    // attempt and revision are unchanged, so the round must be resumable on the
    // same assignment rather than stranded behind a rotated instance/epoch.
    const auditorStored = storedIdentity('deck_alpha_auditor', 'codex-sdk', 'openai');
    const auditorLive = rotated(auditorStored);
    const registry = registryWithLiveParticipants([auditorLive]);
    const { taskId, owner } = seedOwner(registry);
    expect(registry.updateAssignment({
      assignmentId: owner.assignmentId, identity: storedIdentity(), status: 'ready_for_audit',
      auditAttemptId: 'attempt-open', auditRevision: 'rev-1',
    } as never)).toMatchObject({ ok: true });
    const auditor = registry.createAssignment({
      taskId, role: 'auditor', required: false, identity: auditorStored,
      auditAttemptId: 'attempt-open', auditRevision: 'rev-1',
    } as never);
    if (!auditor.ok) throw new Error(auditor.reason);
    expect(registry.updateAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditorStored, status: 'auditing',
      auditAttemptId: 'attempt-open', auditRevision: 'rev-1',
    } as never)).toMatchObject({ ok: true });

    // The restarted auditor submits its receipt on the SAME attempt/revision.
    expect(registry.appendMatchingAuditReceipt({
      taskId, auditorAssignmentId: auditor.value.assignmentId,
      attemptId: 'attempt-open', revision: 'rev-1',
      receiptKind: 'final', verdict: 'PASS', findings: 'resumed after restart', validations: [],
      auditorIdentity: auditorLive,
      auditorSessionName: auditorLive.sessionName,
    } as never), 'auditor resume').toMatchObject({ ok: true });
    expect(registry.getAssignment(auditor.value.assignmentId)!.identity.runtimeEpoch).toBe('epoch-after');
  });

  it('never lets a rotated identity rewrite an already-closed terminal receipt', () => {
    const auditorStored = storedIdentity('deck_alpha_auditor', 'codex-sdk', 'openai');
    const registry = registryWithLiveParticipants([rotated(auditorStored)]);
    const { taskId, owner } = seedOwner(registry);
    expect(registry.updateAssignment({
      assignmentId: owner.assignmentId, identity: storedIdentity(), status: 'ready_for_audit',
      auditAttemptId: 'attempt-closed', auditRevision: 'rev-1',
    } as never)).toMatchObject({ ok: true });
    const auditor = registry.createAssignment({
      taskId, role: 'auditor', required: false, identity: auditorStored,
      auditAttemptId: 'attempt-closed', auditRevision: 'rev-1',
    } as never);
    if (!auditor.ok) throw new Error(auditor.reason);
    expect(registry.updateAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditorStored, status: 'auditing',
      auditAttemptId: 'attempt-closed', auditRevision: 'rev-1',
    } as never)).toMatchObject({ ok: true });
    expect(registry.appendMatchingAuditReceipt({
      taskId, auditorAssignmentId: auditor.value.assignmentId,
      attemptId: 'attempt-closed', revision: 'rev-1',
      receiptKind: 'final', verdict: 'REWORK', findings: 'first and only', validations: [],
      auditorIdentity: auditorStored, auditorSessionName: auditorStored.sessionName,
    } as never)).toMatchObject({ ok: true });
    const before = registry.listAuditReceipts(taskId);

    // A second FINAL receipt on the same closed attempt must not overwrite it.
    registry.appendMatchingAuditReceipt({
      taskId, auditorAssignmentId: auditor.value.assignmentId,
      attemptId: 'attempt-closed', revision: 'rev-1',
      receiptKind: 'final', verdict: 'PASS', findings: 'tries to flip the verdict', validations: [],
      auditorIdentity: rotated(auditorStored), auditorSessionName: auditorStored.sessionName,
    } as never);

    const after = registry.listAuditReceipts(taskId);
    expect(after.find((r) => r.attemptId === 'attempt-closed' && r.sequence === before[0]!.sequence)!.verdict)
      .toBe('REWORK');
  });

  it('heartbeat persists observational metadata for the same durable session', () => {
    const registry = registryWithLiveParticipants([rotated()]);
    const { taskId, owner } = seedOwner(registry);

    const converged = registry.applyTaskIntent({
      taskId, assignmentId: owner.assignmentId, intent: 'heartbeat', toStatus: null, identity: rotated(),
    } as never);
    expect(converged).toMatchObject({ ok: true });
    expect(registry.getAssignment(owner.assignmentId)!.identity.runtimeEpoch).toBe('epoch-after');

    const nextRuntime = { ...storedIdentity(), sessionInstanceId: 'next', runtimeEpoch: 'next-epoch' };
    expect(registry.applyTaskIntent({
      taskId, assignmentId: owner.assignmentId, intent: 'heartbeat', toStatus: null, identity: nextRuntime,
    } as never)).toMatchObject({ ok: true });
    expect(registry.getAssignment(owner.assignmentId)!.identity.runtimeEpoch).toBe('next-epoch');
  });

  it('a newly authorized successor assignment progresses without erasing prior finalization evidence', () => {
    // tsk_5o7 shape: the aggregate is finalized with PASS/commit/CI evidence and
    // a fresh implementer is authorized for the next round.
    const registry = registryWithLiveParticipants([rotated()]);
    const { taskId, owner } = seedOwner(registry);
    expect(registry.updateTask({
      taskId, status: 'implementing',
    } as never)).toMatchObject({ ok: true });
    const successor = registry.createAssignment({
      taskId, role: 'implementer', identity: rotated(), scopeFiles: ['src/next.ts'],
    } as never);
    if (!successor.ok) throw new Error(successor.reason);

    expect(registry.applyTaskIntent({
      taskId, assignmentId: successor.value.assignmentId, intent: 'start',
      toStatus: 'implementing', identity: rotated(),
    } as never)).toMatchObject({ ok: true });

    // The earlier round's assignment and its recorded evidence stay verbatim.
    const prior = registry.getAssignment(owner.assignmentId)!;
    expect(prior.assignmentId).toBe(owner.assignmentId);
    expect(prior.auditRevision).toBe('rev-1');
    expect(registry.listAssignments(taskId).filter((a) => a.role === 'implementer')).toHaveLength(2);
  });
});

/**
 * The exact live tsk_5o7 shape: an independent_top_level aggregate that already
 * carries real finalization evidence (PASS receipt, commit, push, CI) for R4,
 * and then has a NEWLY AUTHORIZED implementer for the next round. The earlier
 * gap-4 test only proved such an assignment could `start`; it never bound a
 * successor REVISION, which is the step the registry actually refuses.
 */
const R4 = 'lifecycle-cc3-r4-e76694e7';
const R5 = 'identity-cc3-r5-cfee0439';
const COMMIT = 'c9aaab488f56dacc619602251705861b6ecc9f61';

function id(sessionName: string): PersistedSupervisionTaskAssignmentIdentity {
  return {
    sessionName,
    sessionInstanceId: `${sessionName}-instance`,
    runtimeEpoch: `${sessionName}-epoch`,
    agentType: 'claude-code-sdk',
    providerFamily: 'anthropic',
  };
}

function finalizedAggregate(registry: SupervisionTaskRegistry) {
  const taskId = 'tsk_finalized';
  const attemptId = 'auto-audit-551450fdefffad26574b7aa6';
  const files = ['src/exact.ts'];
  expect(registry.createOrGet({
    taskId, projectName: 'alpha', classification: 'independent_top_level',
    objective: 'finalized aggregate', currentRevision: R4,
  })).toMatchObject({ ok: true });
  const impl = registry.createAssignment({
    taskId, role: 'implementer', identity: id('deck_alpha_worker'),
    scopeFiles: files, auditAttemptId: attemptId, auditRevision: R4,
  } as never);
  const owner = registry.createAssignment({
    taskId, role: 'integration_owner', identity: id('deck_alpha_brain'),
    scopeFiles: files, auditAttemptId: attemptId, auditRevision: R4,
  } as never);
  const auditor = registry.createAssignment({
    taskId, role: 'auditor', identity: id('deck_alpha_auditor'), required: false,
    auditAttemptId: attemptId, auditRevision: R4,
  } as never);
  if (!impl.ok || !owner.ok || !auditor.ok) throw new Error('finalized shape failed');
  for (const target of [impl.value, owner.value]) {
    for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing', 'passed', 'ready_for_integration'] as const) {
      expect(registry.updateAssignment({
        assignmentId: target.assignmentId, identity: target.identity, status,
        revision: R4, auditAttemptId: attemptId, auditRevision: R4,
        ...(status === 'passed' || status === 'ready_for_integration'
          ? { verdict: 'PASS', crossVendorAuditPassed: true } : {}),
        ...(target.role === 'integration_owner'
          ? { externalRunId: '33748331802', externalHeadSha: COMMIT, externalTaskId: 'CI' } : {}),
      } as never), `${target.role}:${status}`).toMatchObject({ ok: true });
    }
  }
  for (const status of ['auditing', 'passed'] as const) {
    expect(registry.updateAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditor.value.identity, status,
      auditAttemptId: attemptId, auditRevision: R4, ...(status === 'passed' ? { verdict: 'PASS' } : {}),
    } as never)).toMatchObject({ ok: true });
  }
  expect(registry.finishAssignment({
    assignmentId: auditor.value.assignmentId, identity: auditor.value.identity, revision: R4,
  } as never)).toMatchObject({ ok: true });
  expect(registry.finalizeIntegration({
    assignmentId: owner.value.assignmentId, identity: owner.value.identity,
    revision: R4, auditAttemptId: attemptId, auditRevision: R4, verdict: 'PASS',
    integrationOwner: 'deck_alpha_brain', ownedFiles: files, integrationManifest: [],
    commitSha: COMMIT, pushResult: 'pushed', pushRemoteRef: 'refs/heads/dev', stagedPaths: files,
    externalRunId: '33748331802', externalHeadSha: COMMIT, externalTaskId: 'CI', ciResult: 'success',
  } as never)).toMatchObject({ ok: true });
  const finalized = registry.getTaskRecord(taskId)!;
  expect(finalized.finalization?.revision).toBe(R4);
  return { taskId, attemptId, impl: impl.value, owner: owner.value, finalization: finalized.finalization };
}

/** Authorizes the next round's implementer exactly as Brain does live. */
function authorizeSuccessor(registry: SupervisionTaskRegistry, taskId: string, sessionName = 'deck_alpha_next') {
  const next = registry.createAssignment({
    taskId, role: 'implementer', identity: id(sessionName), scopeFiles: ['src/exact.ts'],
  } as never);
  if (!next.ok) throw new Error(next.reason);
  expect(registry.applyTaskIntent({
    taskId, assignmentId: next.value.assignmentId, intent: 'start',
    toStatus: 'implementing', identity: id(sessionName),
  } as never)).toMatchObject({ ok: true });
  return next.value;
}

describe('finalized aggregate projects forward onto a newly authorized successor', () => {
  it('binds the successor revision while every byte of finalization evidence survives', () => {
    const registry = registryWithLiveParticipants([]);
    const { taskId, impl, finalization } = finalizedAggregate(registry);
    const receiptsBefore = registry.listAuditReceipts(taskId).length;
    const successor = authorizeSuccessor(registry, taskId);

    // THE LIVE DEFECT: this is the first revision the fresh owner ever reports,
    // so it carries no auditRevision and the successor-bind rule cannot fire;
    // taskRevisionConflicts then rejected it as `old_revision`, and the
    // finalization guard would have rejected it as `invalid_transition`. The
    // finalized aggregate could therefore never record another round at all.
    expect(registry.updateAssignment({
      assignmentId: successor.assignmentId, identity: id('deck_alpha_next'),
      status: 'ready_for_audit', revision: R5,
    } as never)).toMatchObject({ ok: true });

    const task = registry.getTaskRecord(taskId)!;
    expect(task.currentRevision).toBe(R5);
    // Forward projection is NOT a rewrite: the recorded finalization, its Git
    // and CI evidence stay verbatim.
    expect(task.finalization).toEqual(finalization);
    expect(task.commitSha).toBe(COMMIT);
    expect(registry.listAuditReceipts(taskId)).toHaveLength(receiptsBefore);
    // The predecessor earned its PASS against R4 bytes that were really
    // committed and pushed, so it is preserved, not demoted.
    const prior = registry.getAssignment(impl.assignmentId)!;
    expect(prior.status).toBe('ready_for_integration');
    expect(prior.auditRevision).toBe(R4);
    expect(prior.verdict).toBe('PASS');
  });

  it('refuses a second free-running advance once the task has moved past the finalized revision', () => {
    const registry = registryWithLiveParticipants([]);
    const { taskId } = finalizedAggregate(registry);
    const first = authorizeSuccessor(registry, taskId);
    expect(registry.updateAssignment({
      assignmentId: first.assignmentId, identity: id('deck_alpha_next'),
      status: 'ready_for_audit', revision: R5,
    } as never)).toMatchObject({ ok: true });

    // The finalization anchor is the whole authority: R5 is NOT covered by
    // finalization evidence, so another fresh assignment must not be able to
    // overwrite the in-flight revision. Without the anchor this rule would
    // degrade into "any fresh owner may rewrite task.currentRevision".
    const second = authorizeSuccessor(registry, taskId, 'deck_alpha_third');
    expect(registry.updateAssignment({
      assignmentId: second.assignmentId, identity: id('deck_alpha_third'),
      status: 'ready_for_audit', revision: 'identity-cc3-r6-deadbeef',
    } as never)).toMatchObject({ ok: false, reason: 'old_revision' });
    expect(registry.getTaskRecord(taskId)!.currentRevision).toBe(R5);
  });

  it('ordinary binding refuses to choose between two active successors at the finalized boundary', () => {
    const registry = registryWithLiveParticipants([]);
    const { taskId, finalization } = finalizedAggregate(registry);
    const first = authorizeSuccessor(registry, taskId);
    authorizeSuccessor(registry, taskId, 'deck_alpha_other_successor');

    // Both rows are real, required, non-terminal successor owners. Naming one
    // in task_update is not proof that it uniquely owns the next revision.
    expect(registry.updateAssignment({
      assignmentId: first.assignmentId, identity: id('deck_alpha_next'),
      status: 'ready_for_audit', revision: R5,
    } as never)).toMatchObject({ ok: false, reason: 'ambiguous_assignment' });
    expect(registry.getTaskRecord(taskId)).toMatchObject({ currentRevision: R4, finalization });
    expect(registry.getAssignment(first.assignmentId)!.auditRevision).toBeUndefined();
  });

  it('gives no forward authority to an auditor or to a non-required non-pointer assignment', () => {
    const registry = registryWithLiveParticipants([]);
    const { taskId } = finalizedAggregate(registry);

    // Auditors never own the task revision, whatever they report.
    const auditor = registry.createAssignment({
      taskId, role: 'auditor', identity: id('deck_alpha_next_auditor'), required: false,
    } as never);
    if (!auditor.ok) throw new Error(auditor.reason);
    registry.updateAssignment({
      assignmentId: auditor.value.assignmentId, identity: id('deck_alpha_next_auditor'),
      status: 'auditing', revision: R5,
    } as never);
    expect(registry.getTaskRecord(taskId)!.currentRevision).toBe(R4);

    // A non-required implementer that is not the pointer owner owns nothing.
    const optional = registry.createAssignment({
      taskId, role: 'implementer', identity: id('deck_alpha_optional'),
      scopeFiles: ['src/exact.ts'], required: false,
    } as never);
    if (!optional.ok) throw new Error(optional.reason);
    expect(registry.applyTaskIntent({
      taskId, assignmentId: optional.value.assignmentId, intent: 'start',
      toStatus: 'implementing', identity: id('deck_alpha_optional'),
    } as never)).toMatchObject({ ok: true });
    expect(registry.updateAssignment({
      assignmentId: optional.value.assignmentId, identity: id('deck_alpha_optional'),
      status: 'ready_for_audit', revision: R5,
    } as never)).toMatchObject({ ok: false, reason: 'owner_mismatch' });
    expect(registry.getTaskRecord(taskId)!.currentRevision).toBe(R4);
  });

  it('lets Brain repair the exact active successor without reopening or rewriting the finalized round', () => {
    const registry = registryWithLiveParticipants([]);
    const { taskId, impl, finalization } = finalizedAggregate(registry);
    const successor = authorizeSuccessor(registry, taskId);
    const receiptsBefore = registry.listAuditReceipts(taskId);

    // LIVE tsk_5o7 failure: the exact current successor was specified, but the
    // old handler rejected before looking at it merely because R4 had already
    // produced immutable finalization/Git/CI evidence.
    expect(registry.coordinateTaskAssignment({
      taskId, assignmentId: successor.assignmentId,
      taskStatus: 'implementing', assignmentStatus: 'implementing',
      leaseAction: 'renew', idempotencyKey: 'repair-finalized-successor-control-state',
      reason: 'continue the authorized successor without changing R4 evidence',
    })).toMatchObject({ ok: true, value: { status: 'implementing' } });

    expect(registry.getTaskRecord(taskId)).toMatchObject({
      status: 'implementing', currentRevision: R4, finalization,
      commitSha: COMMIT, pushRemoteRef: 'refs/heads/dev',
    });
    expect(registry.getAssignment(successor.assignmentId)).toMatchObject({
      status: 'implementing', leaseId: expect.stringMatching(/^(?:lse|supervision_lease)_/),
    });
    expect(registry.getAssignment(impl.assignmentId)).toMatchObject({
      status: 'ready_for_integration', auditRevision: R4, verdict: 'PASS',
    });
    expect(registry.listAuditReceipts(taskId)).toEqual(receiptsBefore);
  });

  it('cannot spend an R4 finalization anchor again after the task revision has advanced to R5', () => {
    const registry = registryWithLiveParticipants([]);
    const { taskId, finalization } = finalizedAggregate(registry);
    const successor = authorizeSuccessor(registry, taskId);
    expect(registry.updateAssignment({
      assignmentId: successor.assignmentId, identity: id('deck_alpha_next'),
      status: 'ready_for_audit', revision: R5,
    } as never)).toMatchObject({ ok: true });
    const before = registry.get(taskId);
    const eventsBefore = registry.listEvents(taskId);

    // The immutable R4 receipt proves only the R4 -> R5 forward edge. Once the
    // task pointer is on R5, the same receipt cannot authorize a second control
    // rewrite of that live revision.
    expect(registry.coordinateTaskAssignment({
      taskId, assignmentId: successor.assignmentId,
      taskStatus: 'rework', assignmentStatus: 'rework',
      leaseAction: 'renew', idempotencyKey: 'do-not-respend-r4-finalization',
      reason: 'R4 authority was consumed when currentRevision advanced to R5',
    })).toMatchObject({ ok: false, reason: 'receipt_closed' });
    expect(registry.get(taskId)).toEqual(before);
    expect(registry.listEvents(taskId)).toEqual(eventsBefore);
    expect(registry.getTaskRecord(taskId)).toMatchObject({ currentRevision: R5, finalization });
  });

  it('lets Brain repair the one exact active coordinator while finalized evidence stays immutable', () => {
    const registry = registryWithLiveParticipants([]);
    const { taskId, finalization } = finalizedAggregate(registry);
    const receiptsBefore = registry.listAuditReceipts(taskId);
    const coordinator = registry.createAssignment({
      taskId, role: 'coordinator', identity: id('deck_alpha_coordinator'),
      scopeFiles: ['src/exact.ts'],
    } as never);
    if (!coordinator.ok) throw new Error(coordinator.reason);

    expect(registry.coordinateTaskAssignment({
      taskId, assignmentId: coordinator.value.assignmentId,
      taskStatus: 'implementing', assignmentStatus: 'implementing',
      leaseAction: 'renew', idempotencyKey: 'repair-finalized-coordinator-control-state',
      reason: 'restore the authoritative coordinator without changing R4 evidence',
    })).toMatchObject({ ok: true, value: { status: 'implementing' } });

    expect(registry.getTaskRecord(taskId)).toMatchObject({
      status: 'implementing', currentRevision: R4, finalization,
      commitSha: COMMIT, pushRemoteRef: 'refs/heads/dev',
    });
    expect(registry.getAssignment(coordinator.value.assignmentId)).toMatchObject({
      status: 'implementing', leaseId: expect.stringMatching(/^(?:lse|supervision_lease)_/),
    });
    expect(registry.listAuditReceipts(taskId)).toEqual(receiptsBefore);
  });

  it('routes the same exact-successor repair through the real MCP recovery handler', async () => {
    const registry = registryWithLiveParticipants([]);
    const { taskId, finalization } = finalizedAggregate(registry);
    const successor = authorizeSuccessor(registry, taskId);
    const handlers = createSupervisionMcpToolHandlers({
      userId: 'u1', serverId: 's1', projectName: 'alpha',
      sessionName: 'deck_alpha_brain', transport: 'stdio',
    } as McpRuntimeCaller, {
      registry: {
        get: (id: string) => registry.get(id) as never,
        coordinateTaskAssignment: (input: never) => registry.coordinateTaskAssignment(input),
      } as never,
      isProjectBrain: () => true,
    });

    expect(await handlers[SUPERVISION_MCP_TOOLS.RECOVER]({
      taskId, assignmentId: successor.assignmentId,
      taskStatus: 'implementing', assignmentStatus: 'implementing',
      leaseAction: 'renew', idempotencyKey: 'mcp-repair-finalized-successor',
      reason: 'exercise the production handler instead of the store in isolation',
    })).toMatchObject({ status: 'ok', taskId, assignmentId: successor.assignmentId });
    expect(registry.getTaskRecord(taskId)).toMatchObject({
      status: 'implementing', currentRevision: R4, finalization,
    });
  });

  it('revision-recovers the exact successor while excluding only the implementer consumed by finalization', () => {
    const registry = registryWithLiveParticipants([]);
    const { taskId, impl, finalization } = finalizedAggregate(registry);
    const successor = authorizeSuccessor(registry, taskId);
    const receiptsBefore = registry.listAuditReceipts(taskId);

    // The historical R4 implementer remains ready_for_integration forever as
    // immutable provenance. It must not be counted as a second ACTIVE owner of
    // R5 after finalization consumed its exact attempt/revision.
    expect(registry.rebindTaskAssignmentRevision({
      taskId, assignmentId: successor.assignmentId,
      fromRevision: R4, toRevision: R5,
      worktreeSnapshot: {
        worktreePath: '/tmp/tsk_5o7-successor', headSha: 'a'.repeat(40),
        files: [{ path: 'src/exact.ts', sha256: 'b'.repeat(64) }],
        stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
      },
      leaseAction: 'renew', idempotencyKey: 'bind-finalized-successor-r5',
      reason: 'bind the exact frozen R5 onto the authorized successor',
    })).toMatchObject({ ok: true, value: { status: 'implementing', currentRevision: R5 } });

    expect(registry.getTaskRecord(taskId)).toMatchObject({
      currentRevision: R5, finalization, commitSha: COMMIT,
    });
    expect(registry.getAssignment(successor.assignmentId)).toMatchObject({
      status: 'implementing', auditRevision: R5,
    });
    expect(registry.getAssignment(impl.assignmentId)).toMatchObject({
      status: 'ready_for_integration', auditRevision: R4, verdict: 'PASS',
    });
    expect(registry.listAuditReceipts(taskId)).toEqual(receiptsBefore);
  });

  it('advances past a HISTORICAL finalization more than once, but only while no owner is live', () => {
    // Deliberate reversal of the earlier "exactly one forward edge" rule.
    // That rule made an aggregate wedge permanently: after one advance past a
    // finalization, Brain's own revision recovery refused every later rebind
    // with `old_revision`, and only a human could unstick it. The replacement
    // is not free-running -- it requires the finalization to cover a DIFFERENT
    // revision than the one in flight, the task not to be in a Git/terminal
    // state, and NO live integration owner, on top of every existing
    // worktree/PASS/lease/ambiguity gate. The live-owner half is asserted below.
    const registry = registryWithLiveParticipants([]);
    const { taskId, finalization } = finalizedAggregate(registry);
    const successor = authorizeSuccessor(registry, taskId);
    const snapshot = (worktreePath: string) => ({
      worktreePath,
      headSha: 'a'.repeat(40),
      files: [{ path: 'src/exact.ts', sha256: 'b'.repeat(64) }],
      stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
    });

    expect(registry.rebindTaskAssignmentRevision({
      taskId, assignmentId: successor.assignmentId,
      fromRevision: R4, toRevision: R5,
      worktreeSnapshot: snapshot('/tmp/tsk_5o7-first-successor'),
      leaseAction: 'renew', idempotencyKey: 'bind-finalized-successor-first-r5',
      reason: 'first advance past the finalized round',
    })).toMatchObject({ ok: true });

    // Second advance is now authorized: R4 finalization is history relative to R5.
    expect(registry.rebindTaskAssignmentRevision({
      taskId, assignmentId: successor.assignmentId,
      fromRevision: R5, toRevision: 'identity-cc3-r6-deadbeef',
      worktreeSnapshot: snapshot('/tmp/tsk_5o7-second-successor'),
      leaseAction: 'renew', idempotencyKey: 'advance-past-historical-finalization-r6',
      reason: 'historical finalization must not wedge the aggregate forever',
    })).toMatchObject({ ok: true });
    expect(registry.getTaskRecord(taskId)).toMatchObject({
      currentRevision: 'identity-cc3-r6-deadbeef', finalization, commitSha: COMMIT,
    });

    // Fail-closed half: a LIVE integration owner makes the finalization current
    // authority again, and the next advance is refused.
    const liveOwner = registry.createAssignment({
      taskId, role: 'integration_owner', identity: id('deck_alpha_owner2'),
      scopeFiles: ['src/exact.ts'],
    } as never);
    if (!liveOwner.ok) throw new Error('liveOwner: ' + liveOwner.reason);
    const before = registry.get(taskId);
    expect(registry.rebindTaskAssignmentRevision({
      taskId, assignmentId: successor.assignmentId,
      fromRevision: 'identity-cc3-r6-deadbeef', toRevision: 'identity-cc3-r7-cafebabe',
      worktreeSnapshot: snapshot('/tmp/tsk_5o7-third-successor'),
      leaseAction: 'renew', idempotencyKey: 'refuse-advance-while-owner-live',
      reason: 'a live integration owner still holds the round',
    }).ok).toBe(false);
    expect(registry.get(taskId)).toEqual(before);
  });

  it('still refuses a genuinely ambiguous pair of unconsumed successor implementers', () => {
    const registry = registryWithLiveParticipants([]);
    const { taskId } = finalizedAggregate(registry);
    const successor = authorizeSuccessor(registry, taskId);
    authorizeSuccessor(registry, taskId, 'deck_alpha_other_successor');

    expect(registry.rebindTaskAssignmentRevision({
      taskId, assignmentId: successor.assignmentId,
      fromRevision: R4, toRevision: R5,
      worktreeSnapshot: {
        worktreePath: '/tmp/tsk_5o7-ambiguous', headSha: 'a'.repeat(40),
        files: [{ path: 'src/exact.ts', sha256: 'b'.repeat(64) }],
        stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
      },
      leaseAction: 'renew', idempotencyKey: 'refuse-ambiguous-successor-r5',
      reason: 'must not pick between two real successors',
    })).toMatchObject({ ok: false, reason: 'ambiguous_assignment' });
    expect(registry.getTaskRecord(taskId)!.currentRevision).toBe(R4);
  });

  it('keeps the consumed historical implementer and its receipt closed to control-plane rewriting', () => {
    const registry = registryWithLiveParticipants([]);
    const { taskId, impl, finalization } = finalizedAggregate(registry);
    const receiptsBefore = registry.listAuditReceipts(taskId);

    expect(registry.coordinateTaskAssignment({
      taskId, assignmentId: impl.assignmentId,
      taskStatus: 'rework', assignmentStatus: 'rework',
      leaseAction: 'renew', idempotencyKey: 'do-not-reopen-consumed-r4',
      reason: 'must not rewrite the consumed finalization owner',
    })).toMatchObject({ ok: false, reason: 'receipt_closed' });
    expect(registry.getTaskRecord(taskId)).toMatchObject({ finalization, currentRevision: R4 });
    expect(registry.getAssignment(impl.assignmentId)).toMatchObject({
      status: 'ready_for_integration', auditRevision: R4, verdict: 'PASS',
    });
    expect(registry.listAuditReceipts(taskId)).toEqual(receiptsBefore);
  });
});
