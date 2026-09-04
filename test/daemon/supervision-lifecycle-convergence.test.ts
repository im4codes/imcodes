import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import {
  SupervisionTaskRegistry,
  type PersistedSupervisionTaskAssignmentIdentity,
} from '../../src/daemon/supervision-state-store.js';
import { isTerminalSupervisionTaskStatus } from '../../shared/supervision-config.js';

function identity(sessionName: string): PersistedSupervisionTaskAssignmentIdentity {
  return {
    sessionName,
    sessionInstanceId: `${sessionName}-instance`,
    runtimeEpoch: `${sessionName}-epoch`,
    agentType: 'claude-code-sdk',
    providerFamily: 'anthropic',
  };
}

function memoryRegistry(): SupervisionTaskRegistry {
  return new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
}

const RUN_ID = '33653730690';
const HEAD_SHA = '3f3bb4c1d2e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9';
const PARENT_REVISION = 'parent-r1';

/**
 * Rebuilds the exact production shape of tsk_4nh/asg_4nk: an integration_slice
 * whose finalized parent already consumed the child's exact delivery evidence
 * (same externalRunId + externalHeadSha), while the child itself is still
 * `implementing` with both revisions empty and its lease still alive.
 */
function makeConsumedSlice(registry: SupervisionTaskRegistry, opts: { childRunId?: string } = {}) {
  const parentId = 'tsk_parent';
  const childId = 'tsk_child';
  const files = ['src/exact.ts'];
  const attemptId = `${parentId}-overall-audit`;

  expect(registry.createOrGet({
    taskId: parentId, projectName: 'alpha', classification: 'integration_task',
    objective: 'parent integration', currentRevision: PARENT_REVISION,
  })).toMatchObject({ ok: true });
  const coordinator = registry.createAssignment({
    taskId: parentId, role: 'coordinator', identity: identity('deck_alpha_brain'), required: false,
  });
  const owner = registry.createAssignment({
    taskId: parentId, role: 'integration_owner', identity: identity('deck_alpha_owner'),
    scopeFiles: files, auditAttemptId: attemptId, auditRevision: PARENT_REVISION,
  });
  const parentImpl = registry.createAssignment({
    taskId: parentId, role: 'implementer', identity: identity('deck_alpha_pimpl'),
    scopeFiles: files, auditAttemptId: attemptId, auditRevision: PARENT_REVISION,
  });
  const auditor = registry.createAssignment({
    taskId: parentId, role: 'auditor', identity: identity('deck_alpha_auditor'), required: false,
    auditAttemptId: attemptId, auditRevision: PARENT_REVISION,
  });
  if (!coordinator.ok || !owner.ok || !parentImpl.ok || !auditor.ok) throw new Error('parent shape failed');
  expect(registry.recordFileEvent({
    assignmentId: parentImpl.value.assignmentId, identity: parentImpl.value.identity,
    path: files[0]!, operation: 'modify', afterHash: 'b'.repeat(64), idempotencyKey: `${parentId}-file-0`,
  })).toMatchObject({ ok: true });
  for (const target of [owner.value, parentImpl.value]) {
    for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing', 'passed', 'ready_for_integration'] as const) {
      expect(registry.updateAssignment({
        assignmentId: target.assignmentId, identity: target.identity, status,
        revision: PARENT_REVISION, auditAttemptId: attemptId, auditRevision: PARENT_REVISION,
        ...(status === 'passed' || status === 'ready_for_integration'
          ? { verdict: 'PASS', crossVendorAuditPassed: true } : {}),
        ...(target.role === 'integration_owner'
          ? { externalRunId: RUN_ID, externalHeadSha: HEAD_SHA } : {}),
      } as never), `${target.role}:${status}`).toMatchObject({ ok: true });
    }
  }
  for (const status of ['auditing', 'passed'] as const) {
    expect(registry.updateAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditor.value.identity, status,
      auditAttemptId: attemptId, auditRevision: PARENT_REVISION,
      ...(status === 'passed' ? { verdict: 'PASS' } : {}),
    } as never)).toMatchObject({ ok: true });
  }
  // finalizeIntegration requires the exact PASS auditor to be closed.
  expect(registry.finishAssignment({
    assignmentId: auditor.value.assignmentId,
    identity: auditor.value.identity,
    revision: PARENT_REVISION,
  })).toMatchObject({ ok: true });

  // The child slice: still implementing, both revisions empty, lease alive, and
  // carrying exactly the delivery evidence the parent finalization consumed.
  expect(registry.createOrGet({
    taskId: childId, projectName: 'alpha', topLevelTaskId: parentId,
    classification: 'integration_slice', objective: 'child slice',
  })).toMatchObject({ ok: true });
  const child = registry.createAssignment({
    taskId: childId, role: 'implementer', identity: identity('deck_alpha_worker'),
    scopeFiles: files,
  });
  if (!child.ok) throw new Error(child.reason);
  expect(registry.updateAssignment({
    assignmentId: child.value.assignmentId, identity: child.value.identity, status: 'implementing',
    externalRunId: opts.childRunId ?? RUN_ID, externalHeadSha: HEAD_SHA,
  } as never), 'child must be left implementing with its delivery evidence').toMatchObject({ ok: true });
  return {
    parentId, childId,
    ownerAssignmentId: owner.value.assignmentId,
    childAssignmentId: child.value.assignmentId,
    attemptId,
  };
}

function finalizeParent(registry: SupervisionTaskRegistry, ownerAssignmentId: string, attemptId: string): void {
  const res = registry.finalizeIntegration({
    assignmentId: ownerAssignmentId,
    identity: identity('deck_alpha_owner'),
    revision: PARENT_REVISION,
    auditAttemptId: attemptId,
    auditRevision: PARENT_REVISION,
    verdict: 'PASS',
    ownedFiles: ['src/exact.ts'],
    stagedPaths: ['src/exact.ts'],
    integrationManifest: [{ path: 'src/exact.ts', sha256: 'b'.repeat(64) }],
    integrationOwner: 'deck_alpha_owner',
    // finalizeIntegration requires commitSha === externalHeadSha.
    commitSha: HEAD_SHA,
    pushResult: 'pushed',
    pushRemoteRef: 'refs/heads/dev',
    externalRunId: RUN_ID,
    externalHeadSha: HEAD_SHA,
    ciResult: 'success',
  } as never);
  expect(res, 'parent finalization must succeed for this fixture to be meaningful').toMatchObject({ ok: true });
}

describe('supervision lifecycle convergence', () => {
  it('retires an integration slice whose finalized parent already consumed its exact delivery evidence', () => {
    const registry = memoryRegistry();
    const { childId, ownerAssignmentId, childAssignmentId, attemptId } = makeConsumedSlice(registry);
    finalizeParent(registry, ownerAssignmentId, attemptId);

    const before = registry.getAssignment(childAssignmentId)!;
    expect(before.status).toBe('implementing');
    // The exact tsk_4nh shape: both revision sides empty on the stranded child.
    expect(registry.getTaskRecord(childId)!.currentRevision ?? '').toBe('');
    expect(before.auditRevision ?? '').toBe('');
    expect(registry.getAssignment(childAssignmentId)!.leaseId).not.toBe('');

    const actions = registry.convergeLifecycle(2_000);

    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: childId, action: 'retire_consumed_slice' }),
    ]));
    const after = registry.getTaskRecord(childId)!;
    expect(isTerminalSupervisionTaskStatus(after.status) || after.status === 'recovered').toBe(true);
    // The lease must actually be released, not merely marked.
    expect(registry.getAssignment(childAssignmentId)!.leaseId).toBe('');
  });

  it('never converges a blocked task, because a blocker is not a uniquely derivable forward fact', () => {
    const registry = memoryRegistry();
    const { childId, ownerAssignmentId, childAssignmentId, attemptId } = makeConsumedSlice(registry);
    finalizeParent(registry, ownerAssignmentId, attemptId);
    registry.updateAssignment({
      assignmentId: childAssignmentId,
      identity: identity('deck_alpha_worker'),
      blocker: 'needs human adjudication',
    });
    registry.updateTask({ taskId: childId, status: 'blocked' } as never);
    expect(registry.getTaskRecord(childId)!.status).toBe('blocked');

    const actions = registry.convergeLifecycle(2_000);

    expect(actions.some((a) => a.taskId === childId)).toBe(false);
    expect(registry.getTaskRecord(childId)!.status).toBe('blocked');
  });

  it('refuses to converge when the delivery evidence matches more than one implementer', () => {
    const registry = memoryRegistry();
    const { childId, ownerAssignmentId, attemptId } = makeConsumedSlice(registry);
    const second = registry.createAssignment({
      taskId: childId, role: 'implementer', identity: identity('deck_alpha_second'),
      scopeFiles: ['src/other.ts'],
    });
    if (!second.ok) throw new Error(second.reason);
    registry.updateAssignment({
      assignmentId: second.value.assignmentId,
      identity: identity('deck_alpha_second'),
      externalRunId: RUN_ID,
      externalHeadSha: HEAD_SHA,
    });
    finalizeParent(registry, ownerAssignmentId, attemptId);

    const actions = registry.convergeLifecycle(2_000);

    expect(actions.some((a) => a.taskId === childId && a.action === 'retire_consumed_slice')).toBe(false);
  });

  it('does not retire a slice whose evidence does not match the parent finalization', () => {
    const registry = memoryRegistry();
    const { childId, ownerAssignmentId, attemptId } = makeConsumedSlice(registry, { childRunId: '999' });
    finalizeParent(registry, ownerAssignmentId, attemptId);

    const actions = registry.convergeLifecycle(2_000);

    expect(actions.some((a) => a.taskId === childId && a.action === 'retire_consumed_slice')).toBe(false);
    // The slice must be left alive, not retired, when the evidence differs.
    expect(isTerminalSupervisionTaskStatus(registry.getTaskRecord(childId)!.status)).toBe(false);
    expect(registry.getAssignment(registry.listAssignments(childId)[0]!.assignmentId)!.leaseId).not.toBe('');
  });

  it('is idempotent: a second pass produces no further actions for the same object', () => {
    const registry = memoryRegistry();
    const { ownerAssignmentId, attemptId } = makeConsumedSlice(registry);
    finalizeParent(registry, ownerAssignmentId, attemptId);

    const first = registry.convergeLifecycle(2_000);
    expect(first.length).toBeGreaterThan(0);
    const second = registry.convergeLifecycle(3_000);
    expect(second).toEqual([]);
  });

  it('is restart-idempotent across a reopened database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'supervision-converge-'));
    const dbPath = join(dir, 'state.sqlite');
    try {
      let registry = new SupervisionTaskRegistry({ dbPath });
      const { ownerAssignmentId, attemptId } = makeConsumedSlice(registry);
      finalizeParent(registry, ownerAssignmentId, attemptId);
      expect(registry.convergeLifecycle(2_000).length).toBeGreaterThan(0);

      registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.convergeLifecycle(3_000)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is bounded so one pass cannot walk the whole registry', () => {
    const registry = memoryRegistry();
    for (let i = 0; i < 6; i++) {
      expect(registry.createOrGet({
        taskId: `bulk-${i}`, projectName: 'alpha', classification: 'independent_top_level',
        objective: 'bulk', currentRevision: `rev-${i}`,
      }).ok).toBe(true);
    }
    const actions = registry.convergeLifecycle(2_000, { limit: 2 });
    expect(actions.length).toBeLessThanOrEqual(2);
  });
});

describe('supervision lifecycle convergence — R2 branches', () => {
  /** A plain task with one implementer, used by the projection branches. */
  function simpleTask(registry: SupervisionTaskRegistry, opts: {
    taskId?: string; currentRevision?: string | null; auditRevision?: string | null;
  } = {}) {
    const taskId = opts.taskId ?? 'tsk_simple';
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'independent_top_level',
      objective: 'projection', ...(opts.currentRevision ? { currentRevision: opts.currentRevision } : {}),
    })).toMatchObject({ ok: true });
    const impl = registry.createAssignment({
      taskId, role: 'implementer', identity: identity('deck_alpha_worker'),
      scopeFiles: ['src/exact.ts'],
      ...(opts.auditRevision ? { auditRevision: opts.auditRevision } : {}),
    } as never);
    if (!impl.ok) throw new Error(impl.reason);
    return { taskId, assignmentId: impl.value.assignmentId, identity: impl.value.identity };
  }

  it('aligns a single-sided revision from the task onto the only authoritative assignment', () => {
    const registry = memoryRegistry();
    const { taskId, assignmentId } = simpleTask(registry, { currentRevision: 'r-authoritative' });
    expect(registry.getAssignment(assignmentId)!.auditRevision ?? '').toBe('');

    const actions = registry.convergeLifecycle(2_000);

    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId, action: 'align_revision_projection' }),
    ]));
    expect(registry.getAssignment(assignmentId)!.auditRevision).toBe('r-authoritative');
  });

  it('aligns a single-sided revision from the only assignment back onto the task', () => {
    const registry = memoryRegistry();
    const { taskId } = simpleTask(registry, { auditRevision: 'r-from-assignment' });
    expect(registry.getTaskRecord(taskId)!.currentRevision ?? '').toBe('');

    registry.convergeLifecycle(2_000);

    expect(registry.getTaskRecord(taskId)!.currentRevision).toBe('r-from-assignment');
  });

  it('fails closed when two assignments disagree about the revision', () => {
    const registry = memoryRegistry();
    const { taskId } = simpleTask(registry, { auditRevision: 'r-one' });
    const second = registry.createAssignment({
      taskId, role: 'implementer', identity: identity('deck_alpha_second'),
      scopeFiles: ['src/other.ts'], auditRevision: 'r-two',
    } as never);
    if (!second.ok) throw new Error(second.reason);

    const actions = registry.convergeLifecycle(2_000);

    expect(actions.some((a) => a.action === 'align_revision_projection')).toBe(false);
    expect(registry.getTaskRecord(taskId)!.currentRevision ?? '').toBe('');
  });

  it('projects a passed validation forward without demanding a repeated record_validation call', () => {
    const registry = memoryRegistry();
    const { taskId, assignmentId, identity: workerIdentity } = simpleTask(registry, { currentRevision: 'r-v' });
    expect(registry.applyTaskIntent({
      taskId, assignmentId, intent: 'start', identity: workerIdentity,
    } as never)).toMatchObject({ ok: true });
    expect(registry.applyTaskIntent({
      taskId, assignmentId, intent: 'record_validation', validationState: 'passed', identity: workerIdentity,
    } as never)).toMatchObject({ ok: true });
    // The durable fact (validation passed) is recorded, but the object now sits
    // at `validated` waiting for someone to call open_audit. That call order is
    // exactly what must NOT be a gate.
    expect(registry.getAssignment(assignmentId)!.status).toBe('validated');

    const actions = registry.convergeLifecycle(2_000);

    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId, action: 'project_validated_handoff' }),
    ]));
    // Order of intent calls must not be a gate: the durable fact is enough.
    expect(registry.getAssignment(assignmentId)!.status).toBe('ready_for_audit');
  });

  it('closes an auditor that already has its exact immutable final receipt', () => {
    const registry = memoryRegistry();
    const { taskId, assignmentId: implAssignmentId, identity: implIdentity } = simpleTask(registry, { currentRevision: 'r-a' });
    // A real open_audit binds the implementer to the same attempt + revision so
    // the verdict has exactly one target.
    expect(registry.updateAssignment({
      assignmentId: implAssignmentId, identity: implIdentity, status: 'ready_for_audit',
      auditAttemptId: 'attempt-exact', auditRevision: 'r-a',
    } as never)).toMatchObject({ ok: true });
    const auditor = registry.createAssignment({
      taskId, role: 'auditor', required: false,
      identity: identity('deck_alpha_auditor'),
      auditAttemptId: 'attempt-exact', auditRevision: 'r-a',
    } as never);
    if (!auditor.ok) throw new Error(auditor.reason);
    expect(registry.updateAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditor.value.identity, status: 'auditing',
      auditAttemptId: 'attempt-exact', auditRevision: 'r-a',
    } as never)).toMatchObject({ ok: true });
    expect(registry.appendMatchingAuditReceipt({
      taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId: 'attempt-exact', revision: 'r-a',
      receiptKind: 'final', verdict: 'PASS', findings: 'ok', validations: [],
      auditorIdentity: auditor.value.identity,
      auditorSessionName: auditor.value.identity.sessionName,
    } as never)).toMatchObject({ ok: true });

    const actions = registry.convergeLifecycle(2_000);

    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId, action: 'close_recorded_audit_receipt' }),
    ]));
    const closed = registry.getAssignment(auditor.value.assignmentId)!;
    expect(closed.status).toBe('finalized');
    expect(closed.leaseId).toBe('');
  });

  it('never reuses a receipt recorded against a different revision', () => {
    const registry = memoryRegistry();
    const { taskId } = simpleTask(registry, { currentRevision: 'r-old' });
    // The OLD auditor legitimately earned a PASS receipt at r-old and closed.
    const old = registry.createAssignment({
      taskId, role: 'auditor', required: false,
      identity: identity('deck_alpha_old_auditor'),
      auditAttemptId: 'attempt-old', auditRevision: 'r-old',
    } as never);
    if (!old.ok) throw new Error(old.reason);
    expect(registry.updateAssignment({
      assignmentId: old.value.assignmentId, identity: old.value.identity, status: 'auditing',
      auditAttemptId: 'attempt-old', auditRevision: 'r-old',
    } as never), 'old auditor -> auditing').toMatchObject({ ok: true });
    expect(registry.appendMatchingAuditReceipt({
      taskId, auditorAssignmentId: old.value.assignmentId, attemptId: 'attempt-old', revision: 'r-old',
      receiptKind: 'final', verdict: 'PASS', findings: 'stale pass', validations: [],
      auditorIdentity: old.value.identity,
      auditorSessionName: old.value.identity.sessionName,
    } as never), 'append old receipt').toMatchObject({ ok: true });
    // Retire the old auditor so a fresh one may exist; the stale receipt stays.
    expect(registry.updateAssignment({
      assignmentId: old.value.assignmentId, identity: old.value.identity, status: 'rework',
      auditAttemptId: 'attempt-old', auditRevision: 'r-old', verdict: 'REWORK',
    } as never), 'retire old auditor').toMatchObject({ ok: true });

    // The task moved on. A NEW auditor for r-new has no receipt of its own and
    // must never be closed by the previous revision's PASS.
    expect(registry.updateTask({ taskId, currentRevision: 'r-new' } as never), 'advance task revision').toMatchObject({ ok: true });
    const fresh = registry.createAssignment({
      taskId, role: 'auditor', required: false,
      identity: identity('deck_alpha_new_auditor'),
      auditAttemptId: 'attempt-new', auditRevision: 'r-new',
    } as never);
    if (!fresh.ok) throw new Error(fresh.reason);

    const actions = registry.convergeLifecycle(2_000);

    expect(actions.some((a) => a.assignmentId === fresh.value.assignmentId
      && a.action === 'close_recorded_audit_receipt')).toBe(false);
    expect(registry.getAssignment(fresh.value.assignmentId)!.status).not.toBe('finalized');
  });

  it('pins an auditor to one revision so a stale receipt can never be reinterpreted', () => {
    // This is where cross-revision reuse is actually prevented. A receipt is
    // refused unless it matches the auditor's own attempt AND revision, and the
    // auditor cannot be re-bound to a successor revision -- so a single auditor
    // can never accumulate receipts from two rounds for convergence to confuse.
    const registry = memoryRegistry();
    const { taskId, assignmentId: implAssignmentId, identity: implIdentity } = simpleTask(registry, { currentRevision: 'r-old' });
    expect(registry.updateAssignment({
      assignmentId: implAssignmentId, identity: implIdentity, status: 'ready_for_audit',
      auditAttemptId: 'attempt-old', auditRevision: 'r-old',
    } as never)).toMatchObject({ ok: true });
    const auditor = registry.createAssignment({
      taskId, role: 'auditor', required: false, identity: identity('deck_alpha_auditor'),
      auditAttemptId: 'attempt-old', auditRevision: 'r-old',
    } as never);
    if (!auditor.ok) throw new Error(auditor.reason);
    expect(registry.updateAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditor.value.identity, status: 'auditing',
      auditAttemptId: 'attempt-old', auditRevision: 'r-old',
    } as never)).toMatchObject({ ok: true });

    // A receipt for a different revision is refused at write time.
    expect(registry.appendMatchingAuditReceipt({
      taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId: 'attempt-old', revision: 'r-other',
      receiptKind: 'final', verdict: 'PASS', findings: 'wrong revision', validations: [],
      auditorIdentity: auditor.value.identity,
      auditorSessionName: auditor.value.identity.sessionName,
    } as never)).toMatchObject({ ok: false });
    // ...and so is one for a different attempt.
    expect(registry.appendMatchingAuditReceipt({
      taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId: 'attempt-other', revision: 'r-old',
      receiptKind: 'final', verdict: 'PASS', findings: 'wrong attempt', validations: [],
      auditorIdentity: auditor.value.identity,
      auditorSessionName: auditor.value.identity.sessionName,
    } as never)).toMatchObject({ ok: false });

    // The auditor cannot be moved onto a successor revision either.
    expect(registry.updateTask({ taskId, currentRevision: 'r-new' } as never)).toMatchObject({ ok: true });
    expect(registry.updateAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditor.value.identity,
      auditAttemptId: 'attempt-new', auditRevision: 'r-new',
    } as never)).toMatchObject({ ok: false });
    expect(registry.getAssignment(auditor.value.assignmentId)!.auditRevision).toBe('r-old');
    expect(registry.listAuditReceipts(taskId)).toEqual([]);
  });

  it('refuses a final receipt that carries no PASS/REWORK verdict', () => {
    // Everything else aligns (assignment, attempt, revision, task revision), so
    // the ONLY reason this may be refused is the missing verdict.
    const registry = memoryRegistry();
    const { taskId } = simpleTask(registry, { currentRevision: 'r-a' });
    const auditor = registry.createAssignment({
      taskId, role: 'auditor', required: false, identity: identity('deck_alpha_auditor'),
      auditAttemptId: 'attempt-exact', auditRevision: 'r-a',
    } as never);
    if (!auditor.ok) throw new Error(auditor.reason);

    expect(registry.appendMatchingAuditReceipt({
      taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId: 'attempt-exact', revision: 'r-a',
      receiptKind: 'final', findings: 'no verdict', validations: [],
      auditorIdentity: auditor.value.identity,
      auditorSessionName: auditor.value.identity.sessionName,
    } as never)).toMatchObject({ ok: false });
    expect(registry.listAuditReceipts(taskId)).toEqual([]);
    // A well-formed PASS on the same alignment is accepted, proving the case
    // above was refused for the verdict alone.
    expect(registry.appendMatchingAuditReceipt({
      taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId: 'attempt-exact', revision: 'r-a',
      receiptKind: 'final', verdict: 'PASS', findings: 'ok', validations: [],
      auditorIdentity: auditor.value.identity,
      auditorSessionName: auditor.value.identity.sessionName,
    } as never)).toMatchObject({ ok: true });
  });

  it('rebinds a stale coordinator epoch in place and refuses a same-named clone Brain', () => {
    const registry = memoryRegistry();
    const { taskId } = simpleTask(registry, { currentRevision: 'r-c' });
    const coordinator = registry.createAssignment({
      taskId, role: 'coordinator', required: false, identity: identity('deck_alpha_brain'),
    } as never);
    if (!coordinator.ok) throw new Error(coordinator.reason);
    const staleEpoch = coordinator.value.identity.runtimeEpoch;

    // Same logical Brain, new runtime epoch/instance: an in-place rebind.
    const live = { ...identity('deck_alpha_brain'), runtimeEpoch: 'epoch-live', sessionInstanceId: 'instance-live' };
    const actions = registry.convergeLifecycle(2_000, { resolveAuthoritativeBrain: () => live });

    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId, action: 'rebind_stale_coordinator' }),
    ]));
    const rebound = registry.getAssignment(coordinator.value.assignmentId)!;
    expect(rebound.assignmentId).toBe(coordinator.value.assignmentId); // same object, no replacement
    expect(rebound.identity.runtimeEpoch).toBe('epoch-live');
    expect(rebound.identity.runtimeEpoch).not.toBe(staleEpoch);
    expect(registry.listAssignments(taskId).filter((a) => a.role === 'coordinator')).toHaveLength(1);
  });

  it('refuses to hand a coordinator assignment to a different durable Brain session', () => {
    const registry = memoryRegistry();
    const { taskId } = simpleTask(registry, { currentRevision: 'r-c' });
    const coordinator = registry.createAssignment({
      taskId, role: 'coordinator', required: false, identity: identity('deck_alpha_brain'),
    } as never);
    if (!coordinator.ok) throw new Error(coordinator.reason);

    const clone = { ...identity('deck_alpha_clone_brain'), agentType: 'codex-sdk', providerFamily: 'openai', runtimeEpoch: 'epoch-clone' };
    const actions = registry.convergeLifecycle(2_000, { resolveAuthoritativeBrain: () => clone });

    expect(actions.some((a) => a.action === 'rebind_stale_coordinator')).toBe(false);
    expect(registry.getAssignment(coordinator.value.assignmentId)!.identity.agentType).toBe('claude-code-sdk');
  });
});
