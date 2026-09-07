import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import {
  SupervisionTaskRegistry,
  type PersistedSupervisionTaskAssignmentIdentity,
} from '../../src/daemon/supervision-state-store.js';

const R1 = 'daemon-zombie-recovery-r1-75c73d37bf17';
const R2 = 'daemon-zombie-recovery-r2-8c4d7a21e6f0';
const R1_ATTEMPT = 'auto-audit-daemon-zombie-r1-75c73d37bf17';
const FILES = ['src/daemon/instance-lock.ts', 'test/daemon/instance-lock.test.ts'];

function identity(
  sessionName: string,
  agentType = 'codex-sdk',
  providerFamily = 'openai',
): PersistedSupervisionTaskAssignmentIdentity {
  return {
    sessionName,
    sessionInstanceId: `${sessionName}-instance`,
    runtimeEpoch: `${sessionName}-epoch`,
    agentType,
    providerFamily,
  };
}

function snapshot() {
  return {
    worktreePath: '/worktrees/exact-successor/repo',
    headSha: '8c4d7a21e6f041f4fdb249ff5f8344726eb63344',
    files: FILES.map((path, index) => ({ path, sha256: String(index + 1).repeat(64) })),
    stagedPaths: [],
    conflictedPaths: [],
    untrackedPaths: [],
  };
}

function integrationBundle(taskId: string, assignmentId: string, revision: string) {
  const files = FILES.map((path, index) => ({
    path, sha256: String(index + 1).repeat(64), mode: 0o644 as const,
  }));
  const manifest = {
    version: 1 as const,
    taskId,
    sourceAssignmentId: assignmentId,
    revision,
    headSha: 'a'.repeat(40),
    files,
  };
  const manifestSha256 = createHash('sha256')
    .update(`${JSON.stringify(manifest)}\n`)
    .digest('hex');
  const bundleRoot = '/tmp/imcodes-successor-recovery-bundles';
  return {
    ...manifest,
    manifestSha256,
    bundleRoot,
    bundlePath: join(bundleRoot, manifestSha256.slice(0, 2), manifestSha256),
  };
}

function rewriteStatus(
  database: DatabaseSync,
  table: 'supervision_tasks' | 'supervision_task_assignments',
  idColumn: 'task_id' | 'assignment_id',
  id: string,
  status: 'implementing' | 'rework',
  payload: Record<string, unknown>,
): void {
  database.prepare(`UPDATE ${table} SET status = ?, payload_json = ? WHERE ${idColumn} = ?`)
    .run(status, JSON.stringify({ ...payload, status }), id);
}

function r1ReworkThenBoundR2(
  registry: SupervisionTaskRegistry,
  database: DatabaseSync,
  taskId: string,
  staleTaskStatus: 'implementing' | 'rework' = 'rework',
  bindStaleBundle = false,
) {
  const implementerIdentity = identity(`${taskId}-implementer`);
  const auditorIdentity = identity(`${taskId}-auditor`, 'claude-code-sdk', 'anthropic');
  const implementerId = `${taskId}-implementer`;
  const auditorId = `${taskId}-auditor-r1`;
  expect(registry.createOrGet({
    taskId,
    projectName: 'alpha',
    classification: 'independent_top_level',
    objective: 'same implementer R1 REWORK to exact frozen R2',
    currentRevision: R1,
  })).toMatchObject({ ok: true });
  expect(registry.createAssignment({
    taskId,
    assignmentId: implementerId,
    role: 'implementer',
    identity: implementerIdentity,
    scopeFiles: FILES,
    auditAttemptId: R1_ATTEMPT,
    auditRevision: R1,
  })).toMatchObject({ ok: true });
  for (const status of ['implementing', 'validated', 'ready_for_audit'] as const) {
    expect(registry.updateAssignment({
      assignmentId: implementerId,
      identity: implementerIdentity,
      status,
      revision: R1,
      auditAttemptId: R1_ATTEMPT,
      auditRevision: R1,
    }), status).toMatchObject({ ok: true });
  }
  if (bindStaleBundle) {
    expect(registry.bindIntegrationBundle({
      taskId,
      assignmentId: implementerId,
      identity: implementerIdentity,
      revision: R1,
      bundle: integrationBundle(taskId, implementerId, R1),
    })).toMatchObject({ ok: true });
  }
  expect(registry.createAssignment({
    taskId,
    assignmentId: auditorId,
    role: 'auditor',
    required: false,
    identity: auditorIdentity,
    auditAttemptId: R1_ATTEMPT,
    auditRevision: R1,
  })).toMatchObject({ ok: true });
  expect(registry.updateAssignment({
    assignmentId: auditorId,
    identity: auditorIdentity,
    status: 'auditing',
    auditAttemptId: R1_ATTEMPT,
    auditRevision: R1,
  })).toMatchObject({ ok: true });
  expect(registry.appendMatchingAuditReceipt({
    taskId,
    auditorAssignmentId: auditorId,
    auditorIdentity,
    auditorSessionName: auditorIdentity.sessionName,
    attemptId: R1_ATTEMPT,
    revision: R1,
    receiptKind: 'final',
    verdict: 'REWORK',
    findings: 'bounded recovery trigger is missing',
    validations: [],
  })).toMatchObject({ ok: true });
  expect(registry.finishAssignment({
    assignmentId: auditorId,
    identity: auditorIdentity,
    revision: R1,
  })).toMatchObject({ ok: true });

  expect(registry.coordinateTaskAssignment({
    taskId,
    assignmentId: implementerId,
    taskStatus: 'rework',
    assignmentStatus: 'rework',
    leaseAction: 'renew',
    idempotencyKey: `${taskId}-resume-r1-rework`,
    reason: 'resume the same object for the audited successor',
  })).toMatchObject({ ok: true });
  expect(registry.applyTaskIntent({
    taskId,
    assignmentId: implementerId,
    intent: 'start',
    toStatus: 'implementing',
    identity: implementerIdentity,
  })).toMatchObject({ ok: true });
  expect(registry.updateAssignment({
    assignmentId: implementerId,
    identity: implementerIdentity,
    revision: R2,
    auditRevision: R2,
  })).toMatchObject({ ok: true });
  expect(registry.applyTaskIntent({
    taskId,
    assignmentId: implementerId,
    intent: 'record_validation',
    toStatus: 'validated',
    validationState: 'passed',
    identity: implementerIdentity,
  })).toMatchObject({ ok: true });

  // Exact field shape from the interrupted transition: the durable validation
  // and exact R2 bindings survived, while the lifecycle columns/payloads still
  // project the preceding implementing/rework pair.
  rewriteStatus(
    database,
    'supervision_tasks',
    'task_id',
    taskId,
    staleTaskStatus,
    registry.getTaskRecord(taskId)!,
  );
  rewriteStatus(
    database,
    'supervision_task_assignments',
    'assignment_id',
    implementerId,
    'implementing',
    registry.getAssignment(implementerId)!,
  );
  expect(registry.getTaskRecord(taskId)).toMatchObject({
    status: staleTaskStatus, currentRevision: R2, validationState: 'passed',
  });
  expect(registry.getAssignment(implementerId)).toMatchObject({
    status: 'implementing', auditRevision: R2, validationState: 'passed',
  });
  return { taskId, implementerId, implementerIdentity };
}

function recoveryRequest(taskId: string, implementerId: string) {
  return {
    taskId,
    assignmentId: implementerId,
    fromRevision: R1,
    toRevision: R2,
    scopeFiles: FILES,
    ownedFiles: FILES,
    worktreeSnapshot: snapshot(),
    leaseAction: 'preserve' as const,
    idempotencyKey: `${taskId}-adopt-prepersisted-r2`,
    reason: 'adopt the exact frozen successor already persisted before finish',
  };
}

describe('same-object successor finish/recovery convergence', () => {
  it('finishes a successor audit after its implementer retained the predecessor attempt projection', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = r1ReworkThenBoundR2(
      registry, database, 'successor-audit-stale-predecessor-attempt', 'rework', false,
    );
    const task = registry.getTaskRecord(shape.taskId)!;
    const implementer = registry.getAssignment(shape.implementerId)!;
    database.prepare('UPDATE supervision_tasks SET status = ?, payload_json = ? WHERE task_id = ?')
      .run('ready_for_audit', JSON.stringify({
        ...task,
        status: 'ready_for_audit',
        integrationBundle: integrationBundle(shape.taskId, shape.implementerId, R2),
      }), shape.taskId);
    database.prepare(
      'UPDATE supervision_task_assignments SET status = ?, payload_json = ? WHERE assignment_id = ?',
    ).run('ready_for_audit', JSON.stringify({
      ...implementer,
      status: 'ready_for_audit',
      auditAttemptId: R1_ATTEMPT,
      verdict: 'REWORK',
      blocker: 'bounded recovery trigger is missing',
    }), shape.implementerId);
    expect(registry.getAssignment(shape.implementerId)).toMatchObject({
      auditAttemptId: R1_ATTEMPT,
      auditRevision: R2,
      verdict: 'REWORK',
      validationState: 'passed',
    });

    const attemptId = 'successor-audit-r2-attempt';
    const auditorIdentity = identity('successor-audit-r2-auditor', 'claude-code-sdk', 'anthropic');
    const auditor = registry.createAssignment({
      taskId: shape.taskId,
      assignmentId: 'successor-audit-r2-auditor',
      role: 'auditor',
      required: false,
      identity: auditorIdentity,
      auditAttemptId: attemptId,
      auditRevision: R2,
    });
    if (!auditor.ok) throw new Error(auditor.reason);
    expect(registry.updateAssignment({
      assignmentId: auditor.value.assignmentId,
      identity: auditorIdentity,
      status: 'auditing',
      auditAttemptId: attemptId,
      auditRevision: R2,
    })).toMatchObject({ ok: true });
    expect(registry.appendMatchingAuditReceipt({
      taskId: shape.taskId,
      auditorAssignmentId: auditor.value.assignmentId,
      auditorIdentity,
      auditorSessionName: auditorIdentity.sessionName,
      attemptId,
      revision: R2,
      receiptKind: 'final',
      verdict: 'PASS',
      findings: 'successor closes predecessor rework',
      validations: [],
    })).toMatchObject({ ok: true });
    expect(registry.finishAssignment({
      assignmentId: auditor.value.assignmentId,
      identity: auditorIdentity,
      revision: R2,
    })).toMatchObject({ ok: true, value: { status: 'finalized', verdict: 'PASS' } });
    expect(registry.getTaskRecord(shape.taskId)?.status).toBe('ready_for_integration');
    expect(registry.getAssignment(shape.implementerId)).toMatchObject({
      status: 'ready_for_integration',
      auditAttemptId: attemptId,
      auditRevision: R2,
      verdict: 'PASS',
      crossVendorAuditPassed: true,
    });
    registry.close();
    database.close();
  });

  it('does not finish when a successor implementer carries an unproven stale attempt', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = r1ReworkThenBoundR2(
      registry, database, 'successor-audit-unproven-stale-attempt', 'rework', false,
    );
    const task = registry.getTaskRecord(shape.taskId)!;
    const implementer = registry.getAssignment(shape.implementerId)!;
    database.prepare('UPDATE supervision_tasks SET status = ?, payload_json = ? WHERE task_id = ?')
      .run('ready_for_audit', JSON.stringify({
        ...task,
        status: 'ready_for_audit',
        integrationBundle: integrationBundle(shape.taskId, shape.implementerId, R2),
      }), shape.taskId);
    database.prepare(
      'UPDATE supervision_task_assignments SET status = ?, payload_json = ? WHERE assignment_id = ?',
    ).run('ready_for_audit', JSON.stringify({
      ...implementer,
      status: 'ready_for_audit',
      auditAttemptId: R1_ATTEMPT,
      verdict: 'REWORK',
    }), shape.implementerId);
    database.prepare(
      `DELETE FROM supervision_task_events
       WHERE task_id = ? AND assignment_id = ? AND payload_json LIKE ?`,
    ).run(shape.taskId, shape.implementerId, `%${R1_ATTEMPT}%`);
    const attemptId = 'successor-audit-unproven-r2-attempt';
    const auditorIdentity = identity('successor-audit-unproven-r2-auditor', 'claude-code-sdk', 'anthropic');
    const auditor = registry.createAssignment({
      taskId: shape.taskId,
      assignmentId: 'successor-audit-unproven-r2-auditor',
      role: 'auditor',
      required: false,
      identity: auditorIdentity,
      auditAttemptId: attemptId,
      auditRevision: R2,
    });
    if (!auditor.ok) throw new Error(auditor.reason);
    expect(registry.appendMatchingAuditReceipt({
      taskId: shape.taskId,
      auditorAssignmentId: auditor.value.assignmentId,
      auditorIdentity,
      auditorSessionName: auditorIdentity.sessionName,
      attemptId,
      revision: R2,
      receiptKind: 'final',
      verdict: 'PASS',
      findings: 'must remain blocked',
      validations: [],
    })).toMatchObject({ ok: true });
    const before = registry.get(shape.taskId);
    expect(registry.finishAssignment({
      assignmentId: auditor.value.assignmentId,
      identity: auditorIdentity,
      revision: R2,
    })).toEqual({ ok: false, reason: 'old_audit_attempt' });
    expect(registry.get(shape.taskId)).toEqual(before);
    registry.close();
    database.close();
  });

  it('does not finish a successor audit against a foreign-task integration bundle', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = r1ReworkThenBoundR2(
      registry, database, 'successor-audit-foreign-task-bundle', 'rework', false,
    );
    const task = registry.getTaskRecord(shape.taskId)!;
    const implementer = registry.getAssignment(shape.implementerId)!;
    database.prepare('UPDATE supervision_tasks SET status = ?, payload_json = ? WHERE task_id = ?')
      .run('ready_for_audit', JSON.stringify({
        ...task,
        status: 'ready_for_audit',
        integrationBundle: {
          ...integrationBundle(shape.taskId, shape.implementerId, R2),
          taskId: 'foreign-task',
        },
      }), shape.taskId);
    database.prepare(
      'UPDATE supervision_task_assignments SET status = ?, payload_json = ? WHERE assignment_id = ?',
    ).run('ready_for_audit', JSON.stringify({
      ...implementer,
      status: 'ready_for_audit',
      auditAttemptId: R1_ATTEMPT,
      verdict: 'REWORK',
      blocker: 'bounded recovery trigger is missing',
    }), shape.implementerId);

    const attemptId = 'successor-audit-foreign-task-r2-attempt';
    const auditorIdentity = identity(
      'successor-audit-foreign-task-r2-auditor', 'claude-code-sdk', 'anthropic',
    );
    const auditor = registry.createAssignment({
      taskId: shape.taskId,
      assignmentId: 'successor-audit-foreign-task-r2-auditor',
      role: 'auditor',
      required: false,
      identity: auditorIdentity,
      auditAttemptId: attemptId,
      auditRevision: R2,
    });
    if (!auditor.ok) throw new Error(auditor.reason);
    expect(registry.appendMatchingAuditReceipt({
      taskId: shape.taskId,
      auditorAssignmentId: auditor.value.assignmentId,
      auditorIdentity,
      auditorSessionName: auditorIdentity.sessionName,
      attemptId,
      revision: R2,
      receiptKind: 'final',
      verdict: 'PASS',
      findings: 'must not authorize a foreign-task bundle',
      validations: [],
    })).toMatchObject({ ok: true });
    const taskBefore = registry.getTaskRecord(shape.taskId);
    const assignmentsBefore = registry.listAssignments(shape.taskId);
    expect(registry.finishAssignment({
      assignmentId: auditor.value.assignmentId,
      identity: auditorIdentity,
      revision: R2,
    })).toEqual({ ok: false, reason: 'old_audit_attempt' });
    expect(registry.getTaskRecord(shape.taskId)).toEqual(taskBefore);
    expect(registry.listAssignments(shape.taskId)).toEqual(assignmentsBefore);
    registry.close();
    database.close();
  });

  it('clears only the exact predecessor bundle after a successor was pre-persisted', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = r1ReworkThenBoundR2(
      registry, database, 'prepersisted-successor-stale-bundle', 'rework', true,
    );
    const implementer = registry.getAssignment(shape.implementerId)!;
    database.prepare(
      'UPDATE supervision_task_assignments SET payload_json = ? WHERE assignment_id = ?',
    ).run(JSON.stringify({
      ...implementer,
      auditAttemptId: R1_ATTEMPT,
      verdict: 'REWORK',
      blocker: 'bounded recovery trigger is missing',
    }), shape.implementerId);
    expect(registry.getTaskRecord(shape.taskId)?.integrationBundle?.revision).toBe(R1);
    expect(registry.getAssignment(shape.implementerId)).toMatchObject({
      auditAttemptId: R1_ATTEMPT,
      auditRevision: R2,
      verdict: 'REWORK',
      blocker: 'bounded recovery trigger is missing',
    });

    expect(registry.rebindTaskAssignmentRevision(recoveryRequest(shape.taskId, shape.implementerId)))
      .toMatchObject({ ok: true, value: { currentRevision: R2 } });
    expect(registry.getTaskRecord(shape.taskId)).not.toHaveProperty('integrationBundle');
    const recovered = registry.getAssignment(shape.implementerId)!;
    expect(recovered.auditRevision).toBe(R2);
    expect(recovered).not.toHaveProperty('auditAttemptId');
    expect(recovered).not.toHaveProperty('verdict');
    expect(recovered).not.toHaveProperty('blocker');
    registry.close();
    database.close();
  });

  it('refuses to erase unrelated audit evidence from a pre-persisted successor', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = r1ReworkThenBoundR2(
      registry, database, 'prepersisted-successor-foreign-audit', 'rework', true,
    );
    const assignment = registry.getAssignment(shape.implementerId)!;
    database.prepare(
      'UPDATE supervision_task_assignments SET payload_json = ? WHERE assignment_id = ?',
    ).run(JSON.stringify({
      ...assignment,
      auditAttemptId: 'unrelated-target-attempt',
      verdict: 'PASS',
    }), shape.implementerId);

    expect(registry.rebindTaskAssignmentRevision(recoveryRequest(shape.taskId, shape.implementerId)))
      .toEqual({ ok: false, reason: 'conflicting_replay' });
    expect(registry.getAssignment(shape.implementerId)).toMatchObject({
      auditAttemptId: 'unrelated-target-attempt',
      verdict: 'PASS',
    });
    registry.close();
    database.close();
  });

  it('refuses to clear an unrelated bundle during successor recovery', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = r1ReworkThenBoundR2(
      registry, database, 'prepersisted-successor-foreign-bundle', 'rework', true,
    );
    const task = registry.getTaskRecord(shape.taskId)!;
    const unrelated = integrationBundle(shape.taskId, shape.implementerId, 'unrelated-r0');
    database.prepare('UPDATE supervision_tasks SET payload_json = ? WHERE task_id = ?')
      .run(JSON.stringify({ ...task, integrationBundle: unrelated }), shape.taskId);

    expect(registry.rebindTaskAssignmentRevision(recoveryRequest(shape.taskId, shape.implementerId)))
      .toEqual({ ok: false, reason: 'conflicting_replay' });
    expect(registry.getTaskRecord(shape.taskId)?.integrationBundle).toEqual(unrelated);
    registry.close();
    database.close();
  });

  it.each([
    ['foreign task', 'foreign-task', undefined],
    ['foreign source', undefined, 'foreign-implementer'],
  ] as const)('refuses a same-revision bundle with %s authority', (
    _label, foreignTaskId, foreignSourceAssignmentId,
  ) => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = r1ReworkThenBoundR2(
      registry, database, `prepersisted-successor-${_label.replace(' ', '-')}`, 'rework', false,
    );
    const task = registry.getTaskRecord(shape.taskId)!;
    const foreign = integrationBundle(shape.taskId, shape.implementerId, R2);
    database.prepare('UPDATE supervision_tasks SET payload_json = ? WHERE task_id = ?')
      .run(JSON.stringify({
        ...task,
        integrationBundle: {
          ...foreign,
          ...(foreignTaskId ? { taskId: foreignTaskId } : {}),
          ...(foreignSourceAssignmentId
            ? { sourceAssignmentId: foreignSourceAssignmentId } : {}),
        },
      }), shape.taskId);

    expect(registry.rebindTaskAssignmentRevision(recoveryRequest(shape.taskId, shape.implementerId)))
      .toEqual({ ok: false, reason: 'conflicting_replay' });
    expect(registry.getTaskRecord(shape.taskId)?.integrationBundle).toMatchObject({
      revision: R2,
      taskId: foreignTaskId ?? shape.taskId,
      sourceAssignmentId: foreignSourceAssignmentId ?? shape.implementerId,
    });
    registry.close();
    database.close();
  });

  it('clears a stale blocker when Brain resumes the same assignment', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const taskId = 'same-object-heartbeat-blocker-resume';
    const assignmentId = `${taskId}-implementer`;
    const implementerIdentity = identity(assignmentId);
    expect(registry.createOrGet({
      taskId,
      projectName: 'alpha',
      classification: 'independent_top_level',
      objective: 'resume the exact implementation after a watchdog escalation',
    })).toMatchObject({ ok: true });
    expect(registry.createAssignment({
      taskId,
      assignmentId,
      role: 'implementer',
      identity: implementerIdentity,
      scopeFiles: FILES,
    })).toMatchObject({ ok: true });
    expect(registry.coordinateTaskAssignment({
      taskId,
      assignmentId,
      taskStatus: 'blocked',
      assignmentStatus: 'blocked',
      leaseAction: 'clear',
      idempotencyKey: `${taskId}-blocked`,
      reason: 'heartbeat completed without durable progress',
    })).toMatchObject({ ok: true });
    expect(registry.getTaskRecord(taskId)?.blocker).toBe('heartbeat completed without durable progress');
    expect(registry.getAssignment(assignmentId)?.blocker).toBe('heartbeat completed without durable progress');

    expect(registry.coordinateTaskAssignment({
      taskId,
      assignmentId,
      taskStatus: 'implementing',
      assignmentStatus: 'implementing',
      leaseAction: 'renew',
      idempotencyKey: `${taskId}-resume`,
      reason: 'Brain-authorized same-object repair',
    })).toMatchObject({ ok: true });
    expect(registry.getTaskRecord(taskId)).toMatchObject({ status: 'implementing' });
    expect(registry.getTaskRecord(taskId)).not.toHaveProperty('blocker');
    expect(registry.getAssignment(assignmentId)).toMatchObject({
      status: 'implementing',
      leaseId: expect.stringMatching(/^lse_/),
    });
    expect(registry.getAssignment(assignmentId)).not.toHaveProperty('blocker');
    expect(registry.listEvents(taskId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: 'recovered',
        payload: expect.objectContaining({ reason: 'Brain-authorized same-object repair' }),
      }),
    ]));
    registry.close();
    database.close();
  });

  it('finishes the exact validated R2 directly when only lifecycle projection lagged', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = r1ReworkThenBoundR2(registry, database, 'prepersisted-successor-direct-finish');

    expect(registry.finishAssignment({
      assignmentId: shape.implementerId,
      identity: shape.implementerIdentity,
      revision: R2,
    })).toMatchObject({
      ok: true,
      value: { status: 'ready_for_audit', auditRevision: R2, validationState: 'passed', leaseId: '' },
    });
    expect(registry.getTaskRecord(shape.taskId)).toMatchObject({
      status: 'ready_for_audit', currentRevision: R2, validationState: 'passed',
    });
    registry.close();
    database.close();
  });

  it.each([
    ['PASS', 'implementing'],
    ['REWORK', 'rework'],
  ] as const)(
    'adopts the pre-persisted R2 for a fresh %s lifecycle from stale task %s',
    (verdict, staleTaskStatus) => {
      const database = new DatabaseSync(':memory:');
      const registry = new SupervisionTaskRegistry({ database });
      const taskId = `prepersisted-successor-${verdict.toLowerCase()}`;
      const shape = r1ReworkThenBoundR2(registry, database, taskId, staleTaskStatus);
      const receiptBefore = registry.listAuditReceipts(taskId)[0]!;
      const assignmentCount = registry.listAssignments(taskId).length;

      expect(registry.rebindTaskAssignmentRevision(recoveryRequest(taskId, shape.implementerId)))
        .toMatchObject({ ok: true, value: { currentRevision: R2 } });
      expect(registry.finishAssignment({
        assignmentId: shape.implementerId,
        identity: shape.implementerIdentity,
        revision: R2,
      })).toMatchObject({ ok: true, value: { status: 'ready_for_audit', auditRevision: R2 } });

      const attemptId = `${taskId}-audit-r2`;
      const auditorIdentity = identity(`${taskId}-auditor-r2`, 'claude-code-sdk', 'anthropic');
      const auditor = registry.createAssignment({
        taskId,
        assignmentId: `${taskId}-auditor-r2`,
        role: 'auditor',
        required: false,
        identity: auditorIdentity,
        auditAttemptId: attemptId,
        auditRevision: R2,
      });
      if (!auditor.ok) throw new Error(auditor.reason);
      expect(registry.updateAssignment({
        assignmentId: auditor.value.assignmentId,
        identity: auditorIdentity,
        status: 'auditing',
        auditAttemptId: attemptId,
        auditRevision: R2,
      })).toMatchObject({ ok: true });
      expect(registry.appendMatchingAuditReceipt({
        taskId,
        auditorAssignmentId: auditor.value.assignmentId,
        auditorIdentity,
        auditorSessionName: auditorIdentity.sessionName,
        attemptId,
        revision: R2,
        receiptKind: 'final',
        verdict,
        findings: verdict === 'PASS' ? 'closed' : 'still needs work',
        validations: [],
      })).toMatchObject({ ok: true });
      expect(registry.finishAssignment({
        assignmentId: auditor.value.assignmentId,
        identity: auditorIdentity,
        revision: R2,
      })).toMatchObject({ ok: true });
      expect(registry.getAssignment(shape.implementerId)?.status)
        .toBe(verdict === 'PASS' ? 'ready_for_integration' : 'rework');
      expect(registry.listAuditReceipts(taskId)[0]).toEqual(receiptBefore);
      expect(registry.listAssignments(taskId)).toHaveLength(assignmentCount + 1);
      registry.close();
      database.close();
    },
  );

  it('boot convergence advances durable passed validation without another client call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-prepersisted-successor-'));
    const dbPath = join(dir, 'state.sqlite');
    let registry = new SupervisionTaskRegistry({ dbPath });
    try {
      const database = new DatabaseSync(dbPath);
      const shape = r1ReworkThenBoundR2(registry, database, 'prepersisted-successor-restart');
      const request = recoveryRequest(shape.taskId, shape.implementerId);
      expect(registry.rebindTaskAssignmentRevision(request)).toMatchObject({ ok: true });
      database.close();
      registry.close();
      registry = new SupervisionTaskRegistry({ dbPath });

      expect(registry.rebindTaskAssignmentRevision(request)).toMatchObject({ ok: true, replay: true });

      expect(await registry.convergeLifecycle(Date.now())).toEqual(expect.arrayContaining([
        expect.objectContaining({
          taskId: shape.taskId,
          assignmentId: shape.implementerId,
          action: 'project_validated_handoff',
        }),
      ]));
      expect(registry.getTaskRecord(shape.taskId)).toMatchObject({
        status: 'ready_for_audit', currentRevision: R2, validationState: 'passed',
      });
      expect(registry.getAssignment(shape.implementerId)).toMatchObject({
        status: 'ready_for_audit', auditRevision: R2, leaseId: '', validationState: 'passed',
      });
    } finally {
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on a second active implementer but ignores a sibling shard', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = r1ReworkThenBoundR2(registry, database, 'prepersisted-successor-ambiguous');
    const siblingTaskId = `${shape.taskId}-slice`;
    expect(registry.createOrGet({
      taskId: siblingTaskId,
      topLevelTaskId: shape.taskId,
      projectName: 'alpha',
      classification: 'integration_slice',
      objective: 'independent sibling shard',
      currentRevision: R2,
    })).toMatchObject({ ok: true });
    expect(registry.createAssignment({
      taskId: siblingTaskId,
      assignmentId: `${siblingTaskId}-implementer`,
      role: 'implementer',
      identity: identity(`${siblingTaskId}-implementer`),
      scopeFiles: ['src/daemon/sibling.ts'],
      auditRevision: R2,
    })).toMatchObject({ ok: true });

    expect(registry.rebindTaskAssignmentRevision(recoveryRequest(shape.taskId, shape.implementerId)))
      .toMatchObject({ ok: true });

    const ambiguousDatabase = new DatabaseSync(':memory:');
    const ambiguousRegistry = new SupervisionTaskRegistry({ database: ambiguousDatabase });
    const ambiguous = r1ReworkThenBoundR2(
      ambiguousRegistry,
      ambiguousDatabase,
      'prepersisted-successor-two-implementers',
    );
    expect(ambiguousRegistry.createAssignment({
      taskId: ambiguous.taskId,
      assignmentId: `${ambiguous.taskId}-other`,
      role: 'implementer',
      identity: identity(`${ambiguous.taskId}-other`),
      scopeFiles: FILES,
      auditRevision: R2,
    })).toMatchObject({ ok: true });
    expect(ambiguousRegistry.rebindTaskAssignmentRevision(
      recoveryRequest(ambiguous.taskId, ambiguous.implementerId),
    )).toEqual({ ok: false, reason: 'ambiguous_assignment' });

    registry.close();
    database.close();
    ambiguousRegistry.close();
    ambiguousDatabase.close();
  });
});
