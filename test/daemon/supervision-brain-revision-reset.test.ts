import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createSupervisionMcpToolHandlers,
  type SupervisionRegistryPort,
} from '../../src/daemon/supervision-mcp-tools.js';
import { SUPERVISION_MCP_TOOLS } from '../../shared/supervision-mcp-tools.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import {
  SupervisionTaskRegistry,
  type PersistedSupervisionTaskAssignment,
  type PersistedSupervisionTaskAssignmentIdentity,
  type PersistedSupervisionTaskRecord,
} from '../../src/daemon/supervision-state-store.js';
import { suppressSqliteExperimentalWarning } from '../../src/util/suppress-sqlite-warning.js';

const require = createRequire(import.meta.url);
suppressSqliteExperimentalWarning();
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

const R1 = 'brain-reset-r1';
const R2 = 'brain-reset-r2';

function identity(name: string): PersistedSupervisionTaskAssignmentIdentity {
  return {
    sessionName: name,
    sessionInstanceId: `instance-${name}`,
    runtimeEpoch: `epoch-${name}`,
    agentType: 'codex-sdk',
    providerFamily: 'openai',
  };
}

function rewriteTask(
  database: InstanceType<typeof DatabaseSync>,
  task: PersistedSupervisionTaskRecord,
): void {
  database.prepare(`UPDATE supervision_tasks SET status = ?, current_revision = ?,
    blocker = ?, validation_state = ?, payload_json = ?, updated_at = ? WHERE task_id = ?`)
    .run(task.status, task.currentRevision ?? null, task.blocker ?? null,
      task.validationState ?? null, JSON.stringify(task), task.updatedAt, task.taskId);
}

function rewriteAssignment(
  database: InstanceType<typeof DatabaseSync>,
  assignment: PersistedSupervisionTaskAssignment,
): void {
  database.prepare(`UPDATE supervision_task_assignments SET status = ?, lease_id = ?,
    audit_attempt_id = ?, audit_revision = ?, verdict = ?, blocker = ?, validation_state = ?,
    payload_json = ?, updated_at = ? WHERE assignment_id = ?`).run(
    assignment.status, assignment.leaseId, assignment.auditAttemptId ?? null,
    assignment.auditRevision ?? null, assignment.verdict ?? null, assignment.blocker ?? null,
    assignment.validationState ?? null, JSON.stringify(assignment), assignment.updatedAt,
    assignment.assignmentId,
  );
}

function createBrokenMatrix() {
  const database = new DatabaseSync(':memory:');
  const registry = new SupervisionTaskRegistry({ database });
  const taskId = 'tsk-brain-reset-matrix';
  expect(registry.createOrGet({
    taskId, projectName: 'alpha', classification: 'integration_task',
    objective: 'repair every daemon-created mutable projection split', currentRevision: R1,
  })).toMatchObject({ ok: true });
  const coordinator = registry.createAssignment({
    taskId, role: 'coordinator', identity: identity('deck_alpha_brain'),
    auditRevision: 'stale-baseline', required: false,
  });
  const duplicateCoordinator = registry.createAssignment({
    taskId, role: 'coordinator', identity: identity('deck_alpha_brain_stale'),
    auditRevision: 'older-stale-baseline', required: false,
  });
  const implementer = registry.createAssignment({
    taskId, role: 'implementer', identity: identity('deck_alpha_worker'),
    auditRevision: R1, required: true, scopeFiles: ['src/exact.ts'],
  });
  const auditor = registry.createAssignment({
    taskId, role: 'auditor', identity: identity('deck_alpha_auditor'),
    auditRevision: R1, auditAttemptId: 'attempt-r1', required: true,
  });
  const owner = registry.createAssignment({
    taskId, role: 'integration_owner', identity: identity('deck_alpha_brain'),
    auditRevision: R1, required: true,
  });
  if (!coordinator.ok || !duplicateCoordinator.ok || !implementer.ok || !auditor.ok || !owner.ok) {
    throw new Error('fixture assignment creation failed');
  }
  const task = registry.getTaskRecord(taskId)!;
  rewriteTask(database, {
    ...task, status: 'blocked', currentRevision: R1, blocker: 'stale blocker',
    validationState: 'passed', validatedRevision: R1, updatedAt: task.updatedAt + 10,
  });
  rewriteAssignment(database, {
    ...registry.getAssignment(coordinator.value.assignmentId)!,
    status: 'delegated', auditRevision: 'stale-baseline', leaseId: 'lease-coordinator',
    updatedAt: task.updatedAt + 11,
  });
  rewriteAssignment(database, {
    ...registry.getAssignment(duplicateCoordinator.value.assignmentId)!,
    status: 'blocked', auditRevision: 'older-stale-baseline', leaseId: '',
    updatedAt: task.updatedAt + 11,
  });
  rewriteAssignment(database, {
    ...registry.getAssignment(implementer.value.assignmentId)!,
    status: 'blocked', auditRevision: R2, leaseId: '', auditAttemptId: 'attempt-r1',
    verdict: 'READY_FOR_REAUDIT', blocker: 'stale blocker', validationState: 'passed',
    validatedRevision: R1, updatedAt: task.updatedAt + 12,
  });
  rewriteAssignment(database, {
    ...registry.getAssignment(auditor.value.assignmentId)!,
    status: 'auditing', auditRevision: R1, leaseId: 'lease-auditor', verdict: 'REWORK',
    updatedAt: task.updatedAt + 13,
  });
  rewriteAssignment(database, {
    ...registry.getAssignment(owner.value.assignmentId)!,
    status: 'ready_for_integration', auditRevision: R1, leaseId: '',
    auditAttemptId: 'attempt-r1', verdict: 'PASS', updatedAt: task.updatedAt + 14,
  });
  return {
    database, registry, taskId,
    coordinatorId: coordinator.value.assignmentId,
    duplicateCoordinatorId: duplicateCoordinator.value.assignmentId,
    implementerId: implementer.value.assignmentId,
    auditorId: auditor.value.assignmentId,
    ownerId: owner.value.assignmentId,
  };
}

describe('Brain-authoritative reset to revision', () => {
  it('atomically repairs stale coordinator/auditor/owner, blocked state, missing lease and residual stamps', () => {
    const shape = createBrokenMatrix();
    try {
      expect(shape.registry.resetTaskToRevisionAsBrain({
        taskId: shape.taskId, assignmentId: shape.implementerId, toRevision: R2,
        taskStatus: 'rework', leaseAction: 'renew', idempotencyKey: 'matrix-reset-r2',
        reason: 'repair daemon-created mutable projection divergence', now: 500,
      })).toMatchObject({ ok: true, value: { status: 'rework', currentRevision: R2 } });

      expect(shape.registry.getTaskRecord(shape.taskId)).toMatchObject({
        status: 'rework', currentRevision: R2,
      });
      expect(shape.registry.getTaskRecord(shape.taskId)?.blocker).toBeUndefined();
      expect(shape.registry.getTaskRecord(shape.taskId)?.validationState).toBeUndefined();
      expect(shape.registry.getTaskRecord(shape.taskId)?.validatedRevision).toBeUndefined();
      expect(shape.registry.getAssignment(shape.implementerId)).toMatchObject({
        status: 'rework', auditRevision: R2,
      });
      const resetImplementer = shape.registry.getAssignment(shape.implementerId);
      expect(resetImplementer?.auditAttemptId).toBeUndefined();
      expect(resetImplementer?.verdict).toBeUndefined();
      expect(resetImplementer?.blocker).toBeUndefined();
      expect(resetImplementer?.validationState).toBeUndefined();
      expect(resetImplementer?.leaseId).toBeTruthy();
      expect(shape.registry.getAssignment(shape.coordinatorId)).toMatchObject({
        status: 'implementing', auditRevision: R2,
      });
      expect(shape.registry.getAssignment(shape.coordinatorId)?.auditAttemptId).toBeUndefined();
      expect(shape.registry.getAssignment(shape.coordinatorId)?.verdict).toBeUndefined();
      expect(shape.registry.getAssignment(shape.coordinatorId)?.blocker).toBeUndefined();
      expect(shape.registry.getAssignment(shape.duplicateCoordinatorId)).toMatchObject({
        status: 'cancelled', auditRevision: R2, leaseId: '',
      });
      expect(shape.registry.getAssignment(shape.auditorId)).toMatchObject({
        status: 'cancelled', auditRevision: R2, leaseId: '',
      });
      expect(shape.registry.getAssignment(shape.auditorId)?.auditAttemptId).toBeUndefined();
      expect(shape.registry.getAssignment(shape.auditorId)?.verdict).toBeUndefined();
      expect(shape.registry.getAssignment(shape.ownerId)).toMatchObject({
        status: 'cancelled', auditRevision: R2, leaseId: '',
      });
      expect(shape.registry.getAssignment(shape.ownerId)?.auditAttemptId).toBeUndefined();
      expect(shape.registry.getAssignment(shape.ownerId)?.verdict).toBeUndefined();
      const resetEvent = shape.registry.listEvents(shape.taskId).at(-1);
      expect(resetEvent).toMatchObject({
        eventType: 'recovered',
        payload: {
          source: 'brain_authoritative_revision_reset',
          idempotencyKey: 'matrix-reset-r2',
          toRevision: R2,
          fromState: {
            task: { status: 'blocked', currentRevision: R1, validationState: 'passed' },
            assignments: expect.arrayContaining([
              expect.objectContaining({ assignmentId: shape.implementerId, auditRevision: R2 }),
              expect.objectContaining({ assignmentId: shape.coordinatorId, auditRevision: 'stale-baseline' }),
            ]),
          },
        },
      });
      expect(shape.registry.resetTaskToRevisionAsBrain({
        taskId: shape.taskId, assignmentId: shape.implementerId, toRevision: R2,
        taskStatus: 'rework', leaseAction: 'renew', idempotencyKey: 'matrix-reset-r2',
        reason: 'repair daemon-created mutable projection divergence', now: 600,
      })).toMatchObject({ ok: true, replay: true });
    } finally {
      shape.registry.close();
      shape.database.close();
    }
  });

  it('allows the repaired implementation owner to validate and finish without inventing PASS', () => {
    const shape = createBrokenMatrix();
    try {
      expect(shape.registry.resetTaskToRevisionAsBrain({
        taskId: shape.taskId, assignmentId: shape.implementerId, toRevision: R2,
        taskStatus: 'rework', leaseAction: 'preserve', idempotencyKey: 'continue-r2',
        reason: 'resume exact implementation owner', now: 500,
      })).toMatchObject({ ok: true });
      expect(shape.registry.applyTaskIntent({
        taskId: shape.taskId, assignmentId: shape.implementerId, intent: 'record_validation',
        toStatus: 'validated', validationState: 'passed', expectedRevision: R2, now: 510,
      })).toMatchObject({ ok: true });
      const worker = shape.registry.getAssignment(shape.implementerId)!;
      expect(shape.registry.finishAssignment({
        assignmentId: shape.implementerId, identity: worker.identity, revision: R2, now: 520,
      })).toMatchObject({ ok: true, value: { status: 'ready_for_audit' } });
      expect(shape.registry.listAuditReceipts(shape.taskId)
        .some((receipt) => receipt.verdict === 'PASS')).toBe(false);
      expect(shape.registry.getTaskRecord(shape.taskId)?.finalization).toBeUndefined();
    } finally {
      shape.registry.close();
      shape.database.close();
    }
  });

  it('converges idempotently to rework when no mutable implementer exists', () => {
    const shape = createBrokenMatrix();
    try {
      const implementer = shape.registry.getAssignment(shape.implementerId)!;
      rewriteAssignment(shape.database, {
        ...implementer, status: 'cancelled', leaseId: '', updatedAt: implementer.updatedAt + 1,
      });
      const input = {
        taskId: shape.taskId,
        assignmentId: shape.auditorId,
        toRevision: R2,
        taskStatus: 'implementing' as const,
        leaseAction: 'renew' as const,
        idempotencyKey: 'no-owner-reset-r2',
        reason: 'retire stale audit state before a replacement implementer is delegated',
        now: 500,
      };
      expect(shape.registry.resetTaskToRevisionAsBrain(input)).toMatchObject({
        ok: true, value: { status: 'rework', currentRevision: R2 },
      });
      const replayResult = shape.registry.resetTaskToRevisionAsBrain({ ...input, now: 600 });
      expect(replayResult)
        .toMatchObject({ ok: true, replay: true, value: { status: 'rework' } });
    } finally {
      shape.registry.close();
      shape.database.close();
    }
  });

  it.each([
    ['commit evidence', { commitSha: 'a'.repeat(40) }],
    ['push evidence', { pushRemoteRef: 'origin/dev' }],
    ['finalized lifecycle', { status: 'finalized' as const }],
  ])('refuses only the immutable closed-task boundary: %s', (_name, mutation) => {
    const shape = createBrokenMatrix();
    try {
      const task = shape.registry.getTaskRecord(shape.taskId)!;
      rewriteTask(shape.database, { ...task, ...mutation, updatedAt: task.updatedAt + 100 });
      expect(shape.registry.resetTaskToRevisionAsBrain({
        taskId: shape.taskId, assignmentId: shape.implementerId, toRevision: R2,
        taskStatus: 'rework', leaseAction: 'renew', idempotencyKey: `closed-${_name}`,
        reason: 'must fail closed', now: 500,
      })).toEqual({ ok: false, reason: 'safety_boundary_closed_task' });
    } finally {
      shape.registry.close();
      shape.database.close();
    }
  });
});

const REAL_215_SNAPSHOT = '/Users/k/.imcodes/scratch/brain/jdzj-tsk18tm/supervision-state-215-0922.sqlite';

describe.runIf(existsSync(REAL_215_SNAPSHOT))('215 jdzj reset-to-revision snapshots', () => {
  it('turns the real tsk_19g5 old-path refusal into an exact hinted reset that succeeds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsk-19g5-brain-reset-hint-'));
    const copied = join(dir, 'state.sqlite');
    copyFileSync(REAL_215_SNAPSHOT, copied);
    const registry = new SupervisionTaskRegistry({ dbPath: copied });
    const target = 'e14ed7999901cf5cf4c8e35e9c27f69682808998cb16823b2682bd4ddab5d466';
    const port = {
      getStatus: (taskId: string) => registry.get(taskId)?.status,
      applyIntent: (input: never) => registry.applyTaskIntent(input),
      list: (filter: never) => registry.list(filter),
      get: (taskId: string) => registry.get(taskId),
      recover: (input: never) => registry.recoverTask(input),
      rebindTaskAssignmentRevision: (input: never) => registry.rebindTaskAssignmentRevision(input),
      resetTaskToRevisionAsBrain: (input: never) => registry.resetTaskToRevisionAsBrain(input),
      housekeeping: (input: never) => registry.reconcileHousekeeping(input),
    } as unknown as SupervisionRegistryPort;
    const caller = {
      userId: 'u', sessionName: 'deck_jdzj_brain', projectName: 'jdzj',
      serverId: 's', transport: 'stdio',
    } as unknown as McpRuntimeCaller;
    const handlers = createSupervisionMcpToolHandlers(caller, {
      registry: port,
      isProjectBrain: () => true,
      resolveSessionIdentity: (sessionName) => ({
        sessionName, sessionInstanceId: 'live-brain-instance', runtimeEpoch: 'live-brain-epoch',
        agentType: 'codex-sdk', providerFamily: 'openai', projectName: 'jdzj', role: 'brain',
      }),
    });
    try {
      const rejected: any = await handlers[SUPERVISION_MCP_TOOLS.RECOVER]({
        taskId: 'tsk_19g5', assignmentId: 'asg_19g9',
        fromRevision: '0a4e834d0a8f1e4420618b8135bcc1e9f59b837cefe0bcc2eaaff71dba8986de',
        toRevision: target, leaseAction: 'renew', idempotencyKey: 'legacy-r2-r3',
        reason: 'try the narrow recovery once',
      });
      expect(rejected).toMatchObject({ status: 'error', reason: 'manifest_mismatch' });
      expect(rejected.detail).toContain('Use supervision_task_recover with recoveryMode=reset_revision');
      expect(rejected.detail).toContain(`"toRevision":"${target}"`);

      const reset = await handlers[SUPERVISION_MCP_TOOLS.RECOVER]({
        taskId: 'tsk_19g5', assignmentId: 'asg_19g9', recoveryMode: 'reset_revision',
        toRevision: target, taskStatus: 'rework', leaseAction: 'renew',
        idempotencyKey: 'brain-reset-tsk-19g5-r3',
        reason: 'repair recoverable daemon-created control-plane divergence',
      });
      expect(reset).toMatchObject({ status: 'ok', taskId: 'tsk_19g5', toRevision: target });
      expect(registry.getTaskRecord('tsk_19g5')).toMatchObject({
        status: 'rework', currentRevision: target,
      });
      expect(registry.listAuditReceipts('tsk_19g5').some((receipt) => receipt.verdict === 'PASS'))
        .toBe(false);
      expect(registry.getTaskRecord('tsk_19g5')?.finalization).toBeUndefined();
    } finally {
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('repairs tsk_19g5 R2/R3/base triple split and preserves the immutable R2 receipt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsk-19g5-brain-reset-'));
    const copied = join(dir, 'state.sqlite');
    copyFileSync(REAL_215_SNAPSHOT, copied);
    const registry = new SupervisionTaskRegistry({ dbPath: copied });
    const target = 'e14ed7999901cf5cf4c8e35e9c27f69682808998cb16823b2682bd4ddab5d466';
    try {
      const receiptsBefore = registry.listAuditReceipts('tsk_19g5');
      expect(registry.resetTaskToRevisionAsBrain({
        taskId: 'tsk_19g5', assignmentId: 'asg_19g9', toRevision: target,
        taskStatus: 'rework', leaseAction: 'renew', idempotencyKey: 'tsk-19g5-reset-r3',
        reason: 'repair the copied 215 R2/R3/base split',
      })).toMatchObject({ ok: true });
      expect(registry.getTaskRecord('tsk_19g5')).toMatchObject({
        status: 'rework', currentRevision: target,
      });
      expect(registry.getTaskRecord('tsk_19g5')?.validationState).toBeUndefined();
      expect(registry.getAssignment('asg_19g9')).toMatchObject({
        status: 'rework', auditRevision: target,
      });
      expect(registry.getAssignment('asg_19g9')?.auditAttemptId).toBeUndefined();
      expect(registry.getAssignment('asg_19g9')?.verdict).toBeUndefined();
      expect(registry.getAssignment('asg_19g6')).toMatchObject({
        status: 'implementing', auditRevision: target,
      });
      expect(registry.listAuditReceipts('tsk_19g5')).toEqual(receiptsBefore);
      expect(registry.getTaskRecord('tsk_19g5')?.finalization).toBeUndefined();
    } finally {
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retires the stuck tsk_18th REWORK auditor, preserves its receipt, then admits a new implementer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsk-18th-brain-reset-'));
    const copied = join(dir, 'state.sqlite');
    copyFileSync(REAL_215_SNAPSHOT, copied);
    const registry = new SupervisionTaskRegistry({ dbPath: copied });
    const target = '01e65024c34347e0c25e6f21191e242c5ec6ef61';
    try {
      const receiptsBefore = registry.listAuditReceipts('tsk_18th');
      expect(registry.resetTaskToRevisionAsBrain({
        taskId: 'tsk_18th', assignmentId: 'asg_18ti', toRevision: target,
        taskStatus: 'rework', leaseAction: 'renew', idempotencyKey: 'tsk-18th-reset-r1',
        reason: 'retire the copied stuck auditor without erasing its receipt',
      })).toMatchObject({ ok: true });
      expect(registry.getTaskRecord('tsk_18th')).toMatchObject({
        status: 'rework', currentRevision: target,
      });
      expect(registry.getTaskRecord('tsk_18th')?.blocker).toBeUndefined();
      expect(registry.getAssignment('asg_18ti')).toMatchObject({
        status: 'cancelled', auditRevision: target, leaseId: '',
      });
      expect(registry.getAssignment('asg_18ti')?.auditAttemptId).toBeUndefined();
      expect(registry.getAssignment('asg_18ti')?.verdict).toBeUndefined();
      expect(registry.listAuditReceipts('tsk_18th')).toEqual(receiptsBefore);

      const worker = registry.createAssignment({
        taskId: 'tsk_18th', role: 'implementer', identity: identity('deck_jdzj_repair'),
        auditRevision: target, required: true, scopeFiles: ['src/repaired.ts'],
      });
      expect(worker).toMatchObject({ ok: true });
      if (!worker.ok) throw new Error(worker.reason);
      expect(registry.applyTaskIntent({
        taskId: 'tsk_18th', assignmentId: worker.value.assignmentId,
        intent: 'start', toStatus: 'implementing', now: 600,
      })).toMatchObject({ ok: true });
      expect(registry.applyTaskIntent({
        taskId: 'tsk_18th', assignmentId: worker.value.assignmentId,
        intent: 'record_validation', toStatus: 'validated', validationState: 'passed',
        expectedRevision: target, now: 610,
      })).toMatchObject({ ok: true });
      expect(registry.finishAssignment({
        assignmentId: worker.value.assignmentId, identity: worker.value.identity,
        revision: target, now: 620,
      })).toMatchObject({ ok: true, value: { status: 'ready_for_audit' } });
      expect(registry.getTaskRecord('tsk_18th')?.finalization).toBeUndefined();
    } finally {
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
