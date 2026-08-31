import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, beforeEach, vi } from 'vitest';

import {
  SupervisionTaskRegistry,
  getSupervisionTaskRegistry,
  resetSupervisionTaskRegistryForTests,
  type PersistedSupervisionTaskAssignmentIdentity,
} from '../../src/daemon/supervision-state-store.js';
import { suppressSqliteExperimentalWarning } from '../../src/util/suppress-sqlite-warning.js';
import { dispatchHookSend, dispatchSendMessage, clearSendIdempotencyCacheForTests } from '../../src/daemon/send-tool.js';
import type { SessionRecord } from '../../src/store/session-store.js';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { SUPERVISION_TASK_REGISTRY_CONTRACT } from '../../shared/supervision-config.js';
import { buildSupervisionExecutionCapabilityId } from '../../shared/supervision-execution-pool.js';
import { createSupervisionMcpToolHandlers } from '../../src/daemon/supervision-mcp-tools.js';
import { SUPERVISION_MCP_TOOLS } from '../../shared/supervision-mcp-tools.js';
import { resolvePeerAuditProviderFamily } from '../../shared/peer-audit.js';
import { AGENT_DELEGATION_PURPOSES } from '../../shared/agent-delegation.js';
import { createSupervisionRegistryPort } from '../../src/daemon/supervision-registry-port.js';
import { resolveSupervisionAssignmentWorktree } from '../../src/daemon/supervision-worktree-inspector.js';

/** Adapts the real registry to the audited handler port. */
function supervisionRegistryPort(registryOverride?: SupervisionTaskRegistry) {
  const registry = () => registryOverride ?? getSupervisionTaskRegistry();
  return {
    getStatus: (taskId: string) => registry().get(taskId)?.status,
    applyIntent: (input: Parameters<SupervisionTaskRegistry['applyTaskIntent']>[0]) => registry().applyTaskIntent(input),
    finishAssignment: (input: {
      assignmentId: string; callerSessionName: string; callerProjectName?: string; projectBrain?: boolean;
      rebindIdentity?: PersistedSupervisionTaskAssignmentIdentity; rebindProjectName?: string;
    }) => {
      const current = registry();
      const assignment = current.getAssignment(input.assignmentId);
      if (!assignment) return { ok: false as const, reason: 'not_found' };
      if (input.projectBrain && input.callerProjectName) {
        return current.finishAssignmentAsProjectBrain({
          assignmentId: input.assignmentId,
          callerProjectName: input.callerProjectName,
          ...(input.rebindIdentity ? { rebindIdentity: input.rebindIdentity } : {}),
          ...(input.rebindProjectName ? { rebindProjectName: input.rebindProjectName } : {}),
        });
      }
      if (assignment.identity.sessionName !== input.callerSessionName) return { ok: false as const, reason: 'owner_mismatch' };
      return current.finishAssignment({ assignmentId: input.assignmentId, identity: assignment.identity });
    },
    list: (filter: never) => registry().list(filter) as never,
    get: (taskId: string) => registry().get(taskId) as never,
    recover: (input: Parameters<SupervisionTaskRegistry['recoverTask']>[0]) => registry().recoverTask(input),
    coordinateTaskAssignment: (input: Parameters<SupervisionTaskRegistry['coordinateTaskAssignment']>[0]) => (
      registry().coordinateTaskAssignment(input)
    ),
    rebindTaskAssignmentRevision: (input: Omit<Parameters<SupervisionTaskRegistry['rebindTaskAssignmentRevision']>[0], 'worktreeSnapshot'>) => (
      registry().rebindTaskAssignmentRevision({
        ...input,
        worktreeSnapshot: recoveryWorktreeSnapshot(input.ownedFiles ?? [], input.evidenceManifestSha256),
      })
    ),
  };
}

function persistedExecutionBinding(name: string) {
  const requested = { agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport' as const, model: 'gpt-5.6' };
  return {
    pool: 'primary' as const,
    requested: { ...requested, capabilityId: buildSupervisionExecutionCapabilityId(requested) },
    actual: { sessionName: name, sessionInstanceId: `instance-${name}`, runtimeEpoch: `epoch-${name}`, ...requested },
    origin: 'reused' as const,
  };
}

const require = createRequire(import.meta.url);
suppressSqliteExperimentalWarning();
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

function identity(name: string, agentType = 'codex-sdk'): PersistedSupervisionTaskAssignmentIdentity {
  return {
    sessionName: name,
    sessionInstanceId: `instance-${name}`,
    runtimeEpoch: `epoch-${name}`,
    agentType,
    providerFamily: resolvePeerAuditProviderFamily({ agentType }),
  };
}

function session(name: string, projectName = 'alpha', agentType = 'codex-sdk'): SessionRecord {
  const selected = { agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport' as const, model: 'gpt-5.6' };
  return {
    name,
    sessionInstanceId: `instance-${name}`,
    runtimeEpoch: `epoch-${name}`,
    projectName,
    role: name.endsWith('_brain') ? 'brain' : 'w1',
    agentType,
    projectDir: `/work/${projectName}`,
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 2,
    label: name,
    requestedModel: 'gpt-5.6',
    activeModel: 'gpt-5.6',
    runtimeType: 'transport',
    transportConfig: name.endsWith('_brain') ? {
      supervision: {
        mode: 'off',
        executionPools: {
          state: 'configured',
          primaryDevelopmentPool: { configs: [{ ...selected, capabilityId: buildSupervisionExecutionCapabilityId(selected) }] },
          economyTaskPool: { configs: [] },
        },
      },
    } : undefined,
  } as SessionRecord;
}

function makeRegistry(): SupervisionTaskRegistry {
  return new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
}

function recoveryWorktreeSnapshot(paths: readonly string[], _evidenceManifestSha256?: string) {
  return {
    worktreePath: '/tmp/authoritative-assignment/repo',
    headSha: 'a'.repeat(40),
    files: [...paths].sort().map((path) => ({ path, sha256: 'b'.repeat(64) })),
    stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
  };
}

const ensureTestAssignmentWorktree = async (input: { assignmentId: string }) => ({
  ok: true as const,
  worktreePath: `/worktrees/${input.assignmentId}/repo`,
  baseRevision: 'a'.repeat(40),
  created: true,
});

function prepareStructuredFinalizationShape(
  registry: SupervisionTaskRegistry,
  taskId: string,
  options: {
    selfAudit?: boolean;
    leaveOwnerLeaseActive?: boolean;
    leaveAuditorUnfinalized?: boolean;
    files?: string[];
    authorizedUntouchedFiles?: string[];
    ownerFileCount?: number;
  } = {},
) {
  const revision = `${taskId}-r1`;
  const attemptId = `${taskId}-overall-audit`;
  const files = [...(options.files ?? ['src/final-a.ts', 'src/final-b.ts'])].sort();
  const scopeFiles = [...files, ...(options.authorizedUntouchedFiles ?? [])].sort();
  const ownerIdentity = identity(`${taskId}-owner`);
  const implementerIdentity = identity(`${taskId}-worker`);
  const auditorIdentity = options.selfAudit ? ownerIdentity : identity(`${taskId}-auditor`, 'claude-code-sdk');
  expect(registry.createOrGet({
    taskId, projectName: 'alpha', classification: 'integration_task',
    objective: 'finalize exact matching PASS', currentRevision: revision,
  })).toMatchObject({ ok: true });
  const coordinator = registry.createAssignment({
    taskId, role: 'coordinator', identity: identity(`${taskId}-brain`), required: false,
  });
  const owner = registry.createAssignment({
    taskId, role: 'integration_owner', identity: ownerIdentity, scopeFiles,
    auditAttemptId: attemptId, auditRevision: revision,
  });
  const implementer = registry.createAssignment({
    taskId, role: 'implementer', identity: implementerIdentity, scopeFiles,
    auditAttemptId: attemptId, auditRevision: revision,
  });
  const auditor = registry.createAssignment({
    taskId, role: 'auditor', identity: auditorIdentity, required: false,
    auditAttemptId: attemptId, auditRevision: revision,
  });
  if (!coordinator.ok || !owner.ok || !implementer.ok || !auditor.ok) throw new Error('shape setup failed');
  for (const [index, path] of files.entries()) {
    const fileOwner = index < (options.ownerFileCount ?? 0) ? owner.value : implementer.value;
    expect(registry.recordFileEvent({
      assignmentId: fileOwner.assignmentId,
      identity: fileOwner.identity,
      path,
      operation: 'modify',
      idempotencyKey: `${taskId}-authoritative-file-${index}`,
    })).toMatchObject({ ok: true });
  }
  for (const target of [owner.value, implementer.value]) {
    for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing', 'passed', 'ready_for_integration'] as const) {
      expect(registry.updateAssignment({
        assignmentId: target.assignmentId,
        identity: target.identity,
        status,
        revision,
        auditAttemptId: attemptId,
        auditRevision: revision,
        ...(status === 'passed' || status === 'ready_for_integration' ? {
          verdict: 'PASS', crossVendorAuditPassed: true,
        } : {}),
        ...(target.role === 'integration_owner' ? {
          externalRunId: '33287386936',
          externalHeadSha: 'a'.repeat(40),
          externalTaskId: 'ci-node24',
        } : {}),
      }), `${target.role}:${status}`).toMatchObject({ ok: true });
    }
  }
  for (const status of ['auditing', 'passed'] as const) {
    expect(registry.updateAssignment({
      assignmentId: auditor.value.assignmentId,
      identity: auditor.value.identity,
      status,
      auditAttemptId: attemptId,
      auditRevision: revision,
      ...(status === 'passed' ? { verdict: 'PASS', crossVendorAuditPassed: true } : {}),
    })).toMatchObject({ ok: true });
  }
  if (!options.leaveAuditorUnfinalized) {
    expect(registry.finishAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditor.value.identity, revision,
    })).toMatchObject({ ok: true, value: { status: 'finalized', leaseId: '' } });
  }
  expect(registry.finishAssignment({
    assignmentId: implementer.value.assignmentId, identity: implementer.value.identity, revision,
  })).toMatchObject({ ok: true, value: { status: 'ready_for_integration', leaseId: '' } });
  if (!options.leaveOwnerLeaseActive) {
    expect(registry.finishAssignment({
      assignmentId: owner.value.assignmentId, identity: owner.value.identity, revision,
    })).toMatchObject({ ok: true, value: { status: 'ready_for_integration', leaseId: '' } });
  } else {
    expect(registry.getAssignment(owner.value.assignmentId)).toMatchObject({
      status: 'ready_for_integration', leaseId: expect.stringMatching(/^(?:lse|supervision_lease)_/),
    });
  }
  const finalization = {
    assignmentId: owner.value.assignmentId,
    revision,
    auditAttemptId: attemptId,
    auditRevision: revision,
    verdict: 'PASS' as const,
    ownedFiles: files,
    integrationManifest: files.map((path, index) => ({
      path,
      sha256: ((index + 1) % 10).toString().repeat(64),
    })),
    integrationOwner: ownerIdentity.sessionName,
    commitSha: 'a'.repeat(40),
    pushResult: 'pushed' as const,
    pushRemoteRef: 'refs/heads/dev',
    stagedPaths: files,
    conflictedPaths: [] as string[],
    untrackedOtherOwnerPaths: [] as string[],
    externalRunId: '33287386936',
    externalHeadSha: 'a'.repeat(40),
    externalTaskId: 'ci-node24',
    ciResult: 'success' as const,
  };
  expect(registry.get(taskId)).toMatchObject({ status: 'ready_for_integration' });
  return {
    taskId, revision, attemptId, files, scopeFiles,
    owner: owner.value, implementer: implementer.value,
    coordinator: coordinator.value, auditor: auditor.value, finalization,
  };
}

function rewritePersistedAssignment(
  database: InstanceType<typeof DatabaseSync>,
  assignment: ReturnType<SupervisionTaskRegistry['getAssignment']> & {},
): void {
  database.prepare(`
    UPDATE supervision_task_assignments SET
      role = ?, status = ?, session_name = ?, session_instance_id = ?, runtime_epoch = ?,
      agent_type = ?, provider_family = ?, lease_id = ?, generation = ?, audit_attempt_id = ?,
      audit_revision = ?, verdict = ?, blocker = ?, payload_json = ?, updated_at = ?
    WHERE assignment_id = ?
  `).run(
    assignment.role, assignment.status, assignment.identity.sessionName,
    assignment.identity.sessionInstanceId, assignment.identity.runtimeEpoch,
    assignment.identity.agentType, assignment.identity.providerFamily,
    assignment.leaseId, assignment.generation, assignment.auditAttemptId ?? null,
    assignment.auditRevision ?? null, assignment.verdict ?? null, assignment.blocker ?? null,
    JSON.stringify(assignment), assignment.updatedAt, assignment.assignmentId,
  );
}

function rewritePersistedTask(
  database: InstanceType<typeof DatabaseSync>,
  task: ReturnType<SupervisionTaskRegistry['get']> & {},
): void {
  database.prepare(`
    UPDATE supervision_tasks SET
      status = ?, current_revision = ?, commit_sha = ?, push_remote_ref = ?,
      blocker = ?, payload_json = ?, updated_at = ?
    WHERE task_id = ?
  `).run(
    task.status, task.currentRevision ?? null, task.commitSha ?? null,
    task.pushRemoteRef ?? null, task.blocker ?? null, JSON.stringify(task),
    task.updatedAt, task.taskId,
  );
}

function prepareFinalizedAuditAuthorityReplayGap(
  registry: SupervisionTaskRegistry,
  database: InstanceType<typeof DatabaseSync>,
  taskId: string,
  options: { receiptVerdict?: 'PASS' | 'REWORK'; omitReceipt?: boolean } = {},
) {
  const shape = prepareStructuredFinalizationShape(registry, taskId, { leaveAuditorUnfinalized: true });
  const receiptVerdict = options.receiptVerdict ?? 'PASS';
  if (!options.omitReceipt) {
    expect(registry.appendMatchingAuditReceipt({
      taskId, auditorAssignmentId: shape.auditor.assignmentId,
      attemptId: shape.attemptId, revision: shape.revision,
      receiptKind: 'final', verdict: receiptVerdict,
      auditorSessionName: shape.auditor.identity.sessionName,
      auditorIdentity: shape.auditor.identity,
      findings: `immutable ${receiptVerdict} receipt`,
      validations: [{ kind: 'test', label: 'frozen', outcome: 'passed', summary: 'frozen evidence passed' }],
      now: 100,
    })).toMatchObject({ ok: true, value: { verdict: receiptVerdict } });
  }

  const auditor = registry.getAssignment(shape.auditor.assignmentId)!;
  rewritePersistedAssignment(database, {
    ...auditor,
    status: 'finalized',
    leaseId: '',
    verdict: receiptVerdict,
    updatedAt: 110,
  });
  const implementer = registry.getAssignment(shape.implementer.assignmentId)!;
  const historicalImplementer = { ...implementer, updatedAt: 110 };
  delete historicalImplementer.auditAttemptId;
  delete historicalImplementer.crossVendorAuditPassed;
  rewritePersistedAssignment(database, historicalImplementer);
  expect(registry.getAssignment(shape.auditor.assignmentId)).toMatchObject({ status: 'finalized', leaseId: '' });
  expect(registry.getAssignment(shape.implementer.assignmentId)).toMatchObject({
    status: 'ready_for_integration', auditRevision: shape.revision, verdict: 'PASS',
  });
  expect(registry.getAssignment(shape.implementer.assignmentId)?.auditAttemptId).toBeUndefined();
  expect(registry.getAssignment(shape.implementer.assignmentId)?.crossVendorAuditPassed).toBeUndefined();
  return shape;
}

function prepareStaleRuntimeIntegrationOwnerShape(
  registry: SupervisionTaskRegistry,
  taskId: string,
  options: {
    oldOwnerLeaseActive?: boolean;
    replacementSessionName?: string;
    replacementScopeFiles?: string[];
    addBrainCoordinator?: boolean;
    addConcurrentOwner?: boolean;
  } = {},
) {
  const shape = prepareStructuredFinalizationShape(registry, taskId, {
    leaveOwnerLeaseActive: options.oldOwnerLeaseActive,
  });
  const replacementIdentity = {
    ...shape.owner.identity,
    sessionName: options.replacementSessionName ?? shape.owner.identity.sessionName,
    sessionInstanceId: `${taskId}-replacement-instance`,
    runtimeEpoch: `${taskId}-replacement-epoch`,
  };
  if (options.addBrainCoordinator !== false) {
    expect(registry.createAssignment({
      taskId, role: 'coordinator', identity: replacementIdentity, required: false,
    })).toMatchObject({ ok: true });
  }
  const replacement = registry.createAssignment({
    assignmentId: `${taskId}-replacement-owner`, taskId, role: 'integration_owner',
    identity: replacementIdentity,
    scopeFiles: options.replacementScopeFiles ?? shape.files,
  });
  if (!replacement.ok) throw new Error(replacement.reason);
  for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing', 'passed', 'ready_for_integration'] as const) {
    expect(registry.updateAssignment({
      assignmentId: replacement.value.assignmentId,
      identity: replacementIdentity,
      status,
      revision: shape.revision,
      auditAttemptId: shape.attemptId,
      auditRevision: shape.revision,
      ...(status === 'passed' || status === 'ready_for_integration' ? {
        verdict: 'PASS', crossVendorAuditPassed: true,
      } : {}),
      externalRunId: shape.finalization.externalRunId,
      externalHeadSha: shape.finalization.externalHeadSha,
      externalTaskId: shape.finalization.externalTaskId,
    }), `replacement:${status}`).toMatchObject({ ok: true });
  }
  expect(registry.finishAssignment({
    assignmentId: replacement.value.assignmentId,
    identity: replacementIdentity,
    revision: shape.revision,
  })).toMatchObject({ ok: true, value: { status: 'ready_for_integration', leaseId: '' } });
  if (options.addConcurrentOwner) {
    expect(registry.createAssignment({
      assignmentId: `${taskId}-concurrent-owner`, taskId, role: 'integration_owner',
      identity: identity(`${taskId}-concurrent-owner`), scopeFiles: shape.files,
    })).toMatchObject({ ok: true, value: { status: 'delegated', leaseId: expect.any(String) } });
  }
  return {
    ...shape,
    replacement: replacement.value,
    replacementIdentity,
    finalization: {
      ...shape.finalization,
      assignmentId: replacement.value.assignmentId,
      integrationOwner: replacementIdentity.sessionName,
    },
  };
}

function prepareSameObjectRevisionRecoveryShape(
  registry: SupervisionTaskRegistry,
  taskId: string,
  options: { keepAuditorActive?: boolean; addAmbiguousImplementer?: boolean } = {},
) {
  const fromRevision = 'supervision-worktree-gc-layout-r1';
  const toRevision = 'supervision-worktree-gc-layout-r3';
  const files = ['src/daemon/supervision-worktree-gc.ts', 'test/daemon/supervision-worktree-gc.test.ts'];
  const scopeFiles = [...files, 'test/daemon/supervision-worktree-gc-layout.integration.test.ts'].sort();
  const implementerIdentity = identity(`deck_${taskId}_worker`);
  const auditorIdentity = identity(`deck_${taskId}_auditor`, 'claude-code-sdk');
  expect(registry.createOrGet({
    taskId, projectName: 'alpha', classification: 'independent_top_level',
    objective: 'recover frozen GC revision on the same objects', currentRevision: fromRevision,
  })).toMatchObject({ ok: true });
  const implementer = registry.createAssignment({
    assignmentId: `${taskId}-implementer`, taskId, role: 'implementer',
    identity: implementerIdentity, scopeFiles,
    auditAttemptId: `${taskId}-r1-attempt`, auditRevision: fromRevision,
  });
  const auditor = registry.createAssignment({
    assignmentId: `${taskId}-r2-auditor`, taskId, role: 'auditor', required: false,
    identity: auditorIdentity, auditAttemptId: `${taskId}-r2-attempt`, auditRevision: 'supervision-worktree-gc-layout-r2',
  });
  if (!implementer.ok || !auditor.ok) throw new Error('revision recovery fixture creation failed');
  expect(registry.updateTask({ taskId, status: 'delegated' })).toMatchObject({ ok: true });
  expect(registry.updateTask({ taskId, status: 'implementing' })).toMatchObject({ ok: true });
  expect(registry.updateAssignment({
    assignmentId: implementer.value.assignmentId, identity: implementerIdentity,
    status: 'implementing', revision: fromRevision,
    auditAttemptId: `${taskId}-r1-attempt`, auditRevision: fromRevision,
    verdict: 'REWORK', blocker: 'R1 finding retained until frozen R3 rebind',
  })).toMatchObject({ ok: true });
  for (const [index, path] of files.entries()) {
    expect(registry.recordFileEvent({
      assignmentId: implementer.value.assignmentId,
      identity: implementerIdentity,
      path,
      operation: 'modify',
      idempotencyKey: `${taskId}-authoritative-file-${index}`,
    })).toMatchObject({ ok: true });
  }
  expect(registry.updateAssignment({
    assignmentId: auditor.value.assignmentId, identity: auditorIdentity,
    status: 'auditing', auditAttemptId: `${taskId}-r2-attempt`,
    auditRevision: 'supervision-worktree-gc-layout-r2',
  })).toMatchObject({ ok: true });
  expect(registry.updateAssignment({
    assignmentId: auditor.value.assignmentId, identity: auditorIdentity,
    status: 'passed', auditAttemptId: `${taskId}-r2-attempt`,
    auditRevision: 'supervision-worktree-gc-layout-r2', verdict: 'PASS', crossVendorAuditPassed: true,
  })).toMatchObject({ ok: true });
  if (!options.keepAuditorActive) {
    expect(registry.applyTaskIntent({
      taskId, assignmentId: auditor.value.assignmentId,
      intent: 'cancel', toStatus: 'cancelled', note: 'retire historical R2 auditor',
    })).toMatchObject({ ok: true });
    expect(registry.getAssignment(auditor.value.assignmentId)).toMatchObject({
      status: 'cancelled', leaseId: '', verdict: 'PASS',
      auditRevision: 'supervision-worktree-gc-layout-r2',
    });
  }
  if (options.addAmbiguousImplementer) {
    expect(registry.createAssignment({
      assignmentId: `${taskId}-other-implementer`, taskId, role: 'implementer',
      identity: identity(`deck_${taskId}_other`), scopeFiles,
      auditRevision: fromRevision,
    })).toMatchObject({ ok: true });
  }
  return {
    taskId, fromRevision, toRevision, files, scopeFiles,
    evidenceManifestSha256: 'd'.repeat(64),
    implementer: implementer.value,
    implementerIdentity,
    auditor: auditor.value,
  };
}

function seedFinalAuditReceipt(
  database: InstanceType<typeof DatabaseSync>,
  input: {
    receiptId: string;
    taskId: string;
    assignmentId: string;
    attemptId: string;
    revision: string;
    verdict: 'PASS' | 'REWORK';
    senderIdentity: PersistedSupervisionTaskAssignmentIdentity;
    createdAt: number;
  },
): void {
  database.prepare(`
    INSERT INTO supervision_audit_receipts (
      receipt_id, task_id, assignment_id, attempt_id, revision, sequence,
      receipt_kind, verdict, findings, validations_json, receipt_digest,
      supersedes_receipt_id, sender_identity_json, created_at
    ) VALUES (?, ?, ?, ?, ?, 1, 'final', ?, ?, '[]', ?, NULL, ?, ?)
  `).run(
    input.receiptId, input.taskId, input.assignmentId, input.attemptId, input.revision,
    input.verdict, `immutable ${input.verdict} receipt`, `${input.receiptId}-digest`,
    JSON.stringify(input.senderIdentity), input.createdAt,
  );
}

function prepareFinalizedPassedSuccessorRecoveryShape(
  registry: SupervisionTaskRegistry,
  database: InstanceType<typeof DatabaseSync>,
  taskId: string,
  receiptBinding: 'exact' | 'missing' | 'wrong-verdict' | 'wrong-attempt'
    | 'foreign-task' | 'foreign-assignment' = 'exact',
) {
  const shape = prepareSameObjectRevisionRecoveryShape(registry, taskId);
  // This specialized fixture models the exact production precondition named
  // by the test: the original implementer is already in R1 REWORK. The shared
  // recovery fixture intentionally leaves it implementing for other boundary
  // cases, so project the REWORK state here before seeding the finalized R2
  // successor evidence.
  const implementer = registry.getAssignment(shape.implementer.assignmentId)!;
  rewritePersistedAssignment(database, {
    ...implementer,
    status: 'rework',
    verdict: 'REWORK',
    blocker: 'R1 finding retained until finalized R2 successor recovery',
  });
  const task = registry.get(taskId)!;
  rewritePersistedTask(database, {
    ...task,
    status: 'rework',
    blocker: 'R1 finding retained until finalized R2 successor recovery',
  });
  const toRevision = registry.getAssignment(shape.auditor.assignmentId)!.auditRevision!;
  const sourceAuditorIdentity = identity(`${taskId}-source-auditor`, 'claude-code-sdk');
  const sourceAuditor = registry.createAssignment({
    assignmentId: `${taskId}-source-auditor`, taskId, role: 'auditor', required: false,
    identity: sourceAuditorIdentity,
    auditAttemptId: `${taskId}-r1-attempt`, auditRevision: shape.fromRevision,
  });
  if (!sourceAuditor.ok) throw new Error(sourceAuditor.reason);
  rewritePersistedAssignment(database, {
    ...sourceAuditor.value, status: 'finalized', leaseId: '', verdict: 'REWORK', updatedAt: 120,
  });
  seedFinalAuditReceipt(database, {
    receiptId: `${taskId}-r1-rework-receipt`, taskId,
    assignmentId: sourceAuditor.value.assignmentId,
    attemptId: `${taskId}-r1-attempt`, revision: shape.fromRevision,
    verdict: 'REWORK', senderIdentity: sourceAuditorIdentity, createdAt: 120,
  });

  const targetAuditor = registry.getAssignment(shape.auditor.assignmentId)!;
  rewritePersistedAssignment(database, {
    ...targetAuditor, status: 'finalized', leaseId: '', verdict: 'PASS', updatedAt: 130,
  });
  if (receiptBinding !== 'missing') {
    let receiptTaskId = taskId;
    let receiptAssignmentId = targetAuditor.assignmentId;
    let receiptAttemptId = targetAuditor.auditAttemptId!;
    if (receiptBinding === 'foreign-task' || receiptBinding === 'foreign-assignment') {
      const foreignTaskId = `${taskId}-foreign`;
      expect(registry.createOrGet({
        taskId: foreignTaskId, projectName: 'other-project',
        classification: 'independent_top_level', objective: 'foreign audit evidence',
        currentRevision: toRevision,
      })).toMatchObject({ ok: true });
      const foreignAuditor = registry.createAssignment({
        assignmentId: `${foreignTaskId}-auditor`, taskId: foreignTaskId,
        role: 'auditor', required: false, identity: identity(`${foreignTaskId}-auditor`),
        auditAttemptId: `${foreignTaskId}-attempt`, auditRevision: toRevision,
      });
      if (!foreignAuditor.ok) throw new Error(foreignAuditor.reason);
      if (receiptBinding === 'foreign-task') receiptTaskId = foreignTaskId;
      else receiptAssignmentId = foreignAuditor.value.assignmentId;
    } else if (receiptBinding === 'wrong-attempt') {
      receiptAttemptId = `${targetAuditor.auditAttemptId}-wrong`;
    }
    seedFinalAuditReceipt(database, {
      receiptId: `${taskId}-target-receipt-${receiptBinding}`,
      taskId: receiptTaskId, assignmentId: receiptAssignmentId,
      attemptId: receiptAttemptId, revision: toRevision,
      verdict: receiptBinding === 'wrong-verdict' ? 'REWORK' : 'PASS',
      senderIdentity: targetAuditor.identity, createdAt: 130,
    });
    if (receiptBinding === 'exact') {
      database.prepare(`
        INSERT INTO supervision_audit_attestations
          (attempt_id, task_id, assignment_id, revision, verdict,
           auditor_session_name, findings, created_at)
        VALUES (?, ?, ?, ?, 'PASS', ?, 'immutable matching R2 PASS', 130)
      `).run(
        targetAuditor.auditAttemptId, taskId, shape.implementer.assignmentId, toRevision,
        targetAuditor.identity.sessionName,
      );
    }
  }
  return { ...shape, toRevision, sourceAuditor: sourceAuditor.value };
}

beforeEach(() => {
  resetSupervisionTaskRegistryForTests();
  clearSendIdempotencyCacheForTests();
});

describe('SupervisionTaskRegistry', () => {
  it('atomically finalizes one exact integration through the production MCP and keeps legacy history queryable', async () => {
    const registry = getSupervisionTaskRegistry();
    const shape = prepareStructuredFinalizationShape(registry, 'structured-finalization-production');
    const assignmentCount = registry.listAssignments(shape.taskId).length;
    const eventCount = registry.listEvents(shape.taskId).length;
    expect(registry.createAssignment({
      taskId: shape.taskId,
      role: 'integration_owner',
      identity: shape.owner.identity,
      scopeFiles: shape.files,
    })).toMatchObject({
      ok: true, replay: true,
      value: { assignmentId: shape.owner.assignmentId },
    });
    expect(registry.listAssignments(shape.taskId)).toHaveLength(assignmentCount);
    const handlers = createMemoryMcpToolHandlers(
      {
        userId: 'u', sessionName: shape.owner.identity.sessionName,
        projectName: 'alpha', projectRoot: '/work/alpha',
      },
      {
        sendDeps: {
          listSessions: () => [
            session(shape.owner.identity.sessionName),
            session(shape.auditor.identity.sessionName, 'alpha', 'claude-code-sdk'),
            session(shape.coordinator.identity.sessionName),
          ],
        },
      },
    );

    const productionFinalization: Record<string, unknown> = { ...shape.finalization };
    for (const field of [
      'ownedFiles', 'integrationManifest', 'stagedPaths',
      'conflictedPaths', 'untrackedOtherOwnerPaths',
    ]) delete productionFinalization[field];
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_INTEGRATION_FINALIZE](productionFinalization))
      .resolves.toMatchObject({
        status: 'ok', idempotentReplay: false,
        item: {
          taskId: shape.taskId, status: 'finalized', currentRevision: shape.revision,
          commitSha: shape.finalization.commitSha,
          pushRemoteRef: shape.finalization.pushRemoteRef,
          archivedAt: expect.any(Number),
          finalization: {
            revision: shape.revision,
            auditAttemptId: shape.attemptId,
            auditRevision: shape.revision,
            verdict: 'PASS',
            ownedFiles: [],
            integrationManifest: [],
            stagedPaths: [],
            ciResult: 'success',
          },
        },
      });

    expect(registry.listAssignments(shape.taskId)).toHaveLength(assignmentCount);
    expect(registry.listAssignments(shape.taskId).every((assignment) => assignment.leaseId === '')).toBe(true);
    expect(registry.listFileClaims(shape.taskId)).toEqual([]);
    expect(registry.list({ projectName: 'alpha' }).map((task) => task.taskId)).not.toContain(shape.taskId);
    expect(registry.list({ projectName: 'alpha', history: true })).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: shape.taskId, status: 'finalized' }),
    ]));
    const lifecycleTail = registry.listEvents(shape.taskId).slice(eventCount, eventCount + 14);
    expect(lifecycleTail.map((event) => `${event.assignmentId ? 'assignment' : 'task'}:${event.status}`)).toEqual([
      'assignment:integrating', 'task:integrating',
      'assignment:final_audit', 'task:final_audit',
      'assignment:passed', 'task:passed',
      'assignment:finalizing', 'task:finalizing',
      'assignment:committed', 'task:committed',
      'assignment:pushed', 'task:pushed',
      'assignment:finalized', 'task:finalized',
    ]);

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_INTEGRATION_FINALIZE]({
      ...shape.finalization,
      ownedFiles: 'not-an-array',
      integrationManifest: { stale: true },
      stagedPaths: 42,
      conflictedPaths: ['caller-only-conflict.ts'],
      untrackedOtherOwnerPaths: ['caller-only-untracked.ts'],
    }))
      .resolves.toMatchObject({ status: 'ok', idempotentReplay: true, item: { status: 'finalized' } });
    expect(registry.listEvents(shape.taskId)).toHaveLength(eventCount + 15);
    expect(registry.listAssignments(shape.taskId)).toHaveLength(assignmentCount);
  });

  it('records caller path metadata without using it as finalization authority', () => {
    const registry = makeRegistry();
    const shape = prepareStructuredFinalizationShape(registry, 'structured-finalization-record-only');
    const eventCount = registry.listEvents(shape.taskId).length;
    expect(registry.finalizeIntegration({
      ...shape.finalization,
      ownedFiles: ['src/reported-only.ts', 'src/reported-only.ts'],
      integrationManifest: [{ path: '../not-authority', sha256: 'not-a-hash' }],
      stagedPaths: ['docs/reported-only.md'],
      conflictedPaths: ['src/caller-reported-conflict.ts'],
      untrackedOtherOwnerPaths: ['src/caller-reported-untracked.ts'],
      identity: shape.owner.identity,
    })).toMatchObject({
      ok: true,
      value: {
        status: 'finalized',
        finalization: {
          ownedFiles: ['src/reported-only.ts'],
          integrationManifest: [{ path: '../not-authority', sha256: 'not-a-hash' }],
          stagedPaths: ['docs/reported-only.md'],
        },
      },
    });
    const finalizedEventCount = registry.listEvents(shape.taskId).length;
    expect(finalizedEventCount).toBeGreaterThan(eventCount);
    expect(registry.finalizeIntegration({
      ...shape.finalization,
      ownedFiles: [],
      integrationManifest: [],
      stagedPaths: [],
      conflictedPaths: [],
      untrackedOtherOwnerPaths: [],
      identity: shape.owner.identity,
    })).toMatchObject({ ok: true, replay: true });
    expect(registry.listEvents(shape.taskId)).toHaveLength(finalizedEventCount);
    registry.close();
  });

  it('does not let out-of-scope or other-assignment file-event metadata veto finalization', () => {
    const outsideRegistry = makeRegistry();
    const outside = prepareStructuredFinalizationShape(outsideRegistry, 'structured-finalization-outside-event');
    expect(outsideRegistry.recordFileEvent({
      assignmentId: outside.implementer.assignmentId,
      identity: outside.implementer.identity,
      path: 'src/authorized-scope-miss.ts',
      operation: 'modify',
      idempotencyKey: 'outside-scope-event',
    })).toMatchObject({ ok: true });
    expect(outsideRegistry.finalizeIntegration({
      ...outside.finalization,
      identity: outside.owner.identity,
    })).toMatchObject({ ok: true, value: { status: 'finalized' } });
    outsideRegistry.close();

    const otherRegistry = makeRegistry();
    const other = prepareStructuredFinalizationShape(otherRegistry, 'structured-finalization-other-assignment-event');
    const observer = otherRegistry.createAssignment({
      taskId: other.taskId,
      role: 'coordinator',
      identity: identity('structured-finalization-observer'),
      scopeFiles: ['src/other-assignment.ts'],
      required: false,
    });
    if (!observer.ok) throw new Error(observer.reason);
    expect(otherRegistry.recordFileEvent({
      assignmentId: observer.value.assignmentId,
      identity: observer.value.identity,
      path: 'src/other-assignment.ts',
      operation: 'modify',
      idempotencyKey: 'other-assignment-event',
    })).toMatchObject({ ok: true });
    expect(otherRegistry.finalizeIntegration({
      ...other.finalization,
      identity: other.owner.identity,
    })).toMatchObject({ ok: true, value: { status: 'finalized' } });
    otherRegistry.close();
  });

  it('keeps matching audit, Git/CI identity, foreign-owner, and self-audit boundaries fail closed', () => {
    const registry = makeRegistry();
    const shape = prepareStructuredFinalizationShape(registry, 'structured-finalization-refusals');
    const initial = registry.get(shape.taskId);
    const initialEvents = registry.listEvents(shape.taskId).length;
    const call = (overrides: Partial<typeof shape.finalization> = {}, ownerIdentity = shape.owner.identity) => (
      registry.finalizeIntegration({ ...shape.finalization, ...overrides, identity: ownerIdentity })
    );

    expect(call({ revision: `${shape.revision}-stale`, auditRevision: `${shape.revision}-stale` }))
      .toEqual({ ok: false, reason: 'old_revision' });
    expect(call({ auditAttemptId: `${shape.attemptId}-stale` }))
      .toEqual({ ok: false, reason: 'old_audit_attempt' });
    expect(call({ ciResult: 'failure' as never }))
      .toEqual({ ok: false, reason: 'invalid' });
    expect(call({ pushRemoteRef: 'heads/dev' }))
      .toEqual({ ok: false, reason: 'invalid' });
    expect(call({ externalHeadSha: 'b'.repeat(40) }))
      .toEqual({ ok: false, reason: 'manifest_mismatch' });
    expect(call({}, identity('foreign-integration-owner')))
      .toEqual({ ok: false, reason: 'owner_mismatch' });
    expect(registry.get(shape.taskId)).toEqual(initial);
    expect(registry.listEvents(shape.taskId)).toHaveLength(initialEvents);

    const selfAudit = prepareStructuredFinalizationShape(registry, 'structured-finalization-self-audit', { selfAudit: true });
    expect(registry.finalizeIntegration({
      ...selfAudit.finalization, identity: selfAudit.owner.identity,
    })).toEqual({ ok: false, reason: 'owner_mismatch' });
    expect(registry.get(selfAudit.taskId)).toMatchObject({ status: 'ready_for_integration' });

    const unfinishedAudit = prepareStructuredFinalizationShape(
      registry,
      'structured-finalization-unfinished-auditor',
      { leaveAuditorUnfinalized: true },
    );
    expect(registry.finalizeIntegration({
      ...unfinishedAudit.finalization,
      identity: unfinishedAudit.owner.identity,
    })).toEqual({ ok: false, reason: 'invalid_transition' });
    expect(registry.get(unfinishedAudit.taskId)).toMatchObject({ status: 'ready_for_integration' });
    registry.close();
  });

  it('fails closed without mutation when a required lineage assignment carries a stale revision', () => {
    const registry = makeRegistry();
    const shape = prepareStructuredFinalizationShape(registry, 'structured-finalization-stale-lineage');
    const staleIdentity = identity('structured-finalization-stale-lineage-worker');
    const stale = registry.createAssignment({
      taskId: shape.taskId,
      role: 'implementer',
      identity: staleIdentity,
      scopeFiles: ['src/stale-lineage.ts'],
      auditAttemptId: 'stale-lineage-attempt',
      auditRevision: 'stale-lineage-revision',
    });
    if (!stale.ok) throw new Error(stale.reason);
    for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing', 'passed', 'ready_for_integration'] as const) {
      expect(registry.updateAssignment({
        assignmentId: stale.value.assignmentId,
        identity: staleIdentity,
        status,
        revision: 'stale-lineage-revision',
        auditAttemptId: 'stale-lineage-attempt',
        auditRevision: 'stale-lineage-revision',
        ...(status === 'passed' || status === 'ready_for_integration'
          ? { verdict: 'PASS', crossVendorAuditPassed: true }
          : {}),
      })).toMatchObject({ ok: true });
    }
    const before = registry.get(shape.taskId);
    const eventCount = registry.listEvents(shape.taskId).length;
    expect(registry.finalizeIntegration({
      ...shape.finalization,
      identity: shape.owner.identity,
    })).toEqual({ ok: false, reason: 'old_revision' });
    expect(registry.get(shape.taskId)).toEqual(before);
    expect(registry.listEvents(shape.taskId)).toHaveLength(eventCount);
    registry.close();
  });

  it('persists structured finalization across SQLite reopen and makes exact replay idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-structured-finalization-'));
    const dbPath = join(dir, 'supervision-state.sqlite');
    let registry = new SupervisionTaskRegistry({ dbPath });
    try {
      const shape = prepareStructuredFinalizationShape(registry, 'structured-finalization-restart');
      expect(registry.finalizeIntegration({
        ...shape.finalization, identity: shape.owner.identity, now: 500,
      })).toMatchObject({ ok: true, value: { status: 'finalized', archivedAt: 500 } });
      const eventCount = registry.listEvents(shape.taskId).length;
      registry.close();
      registry = new SupervisionTaskRegistry({ dbPath });

      expect(registry.get(shape.taskId)).toMatchObject({
        status: 'finalized', archivedAt: 500,
        finalization: {
          revision: shape.revision,
          commitSha: shape.finalization.commitSha,
          finalizedAt: 500,
        },
      });
      expect(registry.finalizeIntegration({
        ...shape.finalization, identity: shape.owner.identity, now: 900,
      })).toMatchObject({ ok: true, replay: true, value: { status: 'finalized', archivedAt: 500 } });
      expect(registry.listEvents(shape.taskId)).toHaveLength(eventCount);
      expect(registry.finalizeIntegration({
        ...shape.finalization,
        commitSha: 'b'.repeat(40), externalHeadSha: 'b'.repeat(40),
        identity: shape.owner.identity,
      })).toEqual({ ok: false, reason: 'conflicting_replay' });
      expect(registry.listEvents(shape.taskId)).toHaveLength(eventCount);
    } finally {
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('atomically rebinds a stale same-session integration owner after restart and replays idempotently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-stale-integration-owner-'));
    const dbPath = join(dir, 'supervision-state.sqlite');
    let registry = new SupervisionTaskRegistry({ dbPath });
    try {
      const shape = prepareStaleRuntimeIntegrationOwnerShape(registry, 'stale-runtime-owner-restart');
      expect(registry.get(shape.taskId)).toMatchObject({
        status: 'ready_for_integration',
        currentRevision: shape.revision,
        integrationOwnerAssignmentId: shape.owner.assignmentId,
        assignments: expect.arrayContaining([
          expect.objectContaining({
            assignmentId: shape.owner.assignmentId,
            role: 'integration_owner', status: 'ready_for_integration', leaseId: '',
          }),
          expect.objectContaining({
            assignmentId: shape.replacement.assignmentId,
            role: 'integration_owner', status: 'ready_for_integration', leaseId: '',
          }),
        ]),
      });
      registry.close();
      registry = new SupervisionTaskRegistry({ dbPath });

      const eventCount = registry.listEvents(shape.taskId).length;
      expect(registry.finalizeIntegration({
        ...shape.finalization, identity: shape.replacementIdentity, now: 500,
      })).toMatchObject({
        ok: true,
        value: {
          status: 'finalized',
          integrationOwnerAssignmentId: shape.replacement.assignmentId,
          archivedAt: 500,
        },
      });
      expect(registry.getAssignment(shape.owner.assignmentId)).toMatchObject({
        status: 'ready_for_integration', leaseId: '',
      });
      const firstFinalizationTaskEvent = registry.listEvents(shape.taskId)
        .slice(eventCount)
        .find((event) => !event.assignmentId);
      expect(firstFinalizationTaskEvent).toMatchObject({
        status: 'integrating',
        payload: {
          integrationOwnerReboundFromAssignmentId: shape.owner.assignmentId,
          integrationOwnerReboundToAssignmentId: shape.replacement.assignmentId,
        },
      });

      const finalizedEventCount = registry.listEvents(shape.taskId).length;
      registry.close();
      registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.finalizeIntegration({
        ...shape.finalization, identity: shape.replacementIdentity, now: 900,
      })).toMatchObject({
        ok: true, replay: true,
        value: {
          status: 'finalized',
          integrationOwnerAssignmentId: shape.replacement.assignmentId,
          archivedAt: 500,
        },
      });
      expect(registry.listEvents(shape.taskId)).toHaveLength(finalizedEventCount);
    } finally {
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when stale integration-owner replacement evidence or authority is not exact', () => {
    const cases = [
      {
        taskId: 'stale-owner-different-session',
        options: { replacementSessionName: 'deck_other_brain' },
        reason: 'owner_mismatch',
      },
      {
        taskId: 'stale-owner-live-lease',
        options: { oldOwnerLeaseActive: true },
        reason: 'owner_mismatch',
      },
      {
        taskId: 'stale-owner-not-project-brain',
        options: { addBrainCoordinator: false },
        reason: 'owner_mismatch',
      },
      {
        taskId: 'stale-owner-ambiguous-active-owner',
        options: { addConcurrentOwner: true },
        reason: 'ambiguous_assignment',
      },
    ] as const;

    for (const testCase of cases) {
      const registry = makeRegistry();
      const shape = prepareStaleRuntimeIntegrationOwnerShape(registry, testCase.taskId, testCase.options);
      const before = registry.get(shape.taskId);
      const eventCount = registry.listEvents(shape.taskId).length;
      expect(registry.finalizeIntegration({
        ...shape.finalization, identity: shape.replacementIdentity,
      }), testCase.taskId).toEqual({ ok: false, reason: testCase.reason });
      expect(registry.get(shape.taskId), testCase.taskId).toEqual(before);
      expect(registry.listEvents(shape.taskId), testCase.taskId).toHaveLength(eventCount);
      registry.close();
    }
  });

  it('does not use scope metadata to veto an otherwise exact stale-owner rebind', () => {
    const registry = makeRegistry();
    const shape = prepareStaleRuntimeIntegrationOwnerShape(registry, 'stale-owner-scope-record-only', {
      replacementScopeFiles: ['src/reported-different.ts'],
    });
    expect(registry.finalizeIntegration({
      ...shape.finalization,
      identity: shape.replacementIdentity,
    })).toMatchObject({
      ok: true,
      value: {
        status: 'finalized',
        integrationOwnerAssignmentId: shape.replacement.assignmentId,
      },
    });
    registry.close();
  });

  it('atomically rebinds one frozen revision on the same task/assignment and persists replay across restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-same-object-revision-recovery-'));
    const dbPath = join(dir, 'supervision-state.sqlite');
    let registry = new SupervisionTaskRegistry({ dbPath });
    try {
      const shape = prepareSameObjectRevisionRecoveryShape(registry, 'same-object-revision-recovery');
      const assignmentCount = registry.listAssignments(shape.taskId).length;
      const originalLeaseId = registry.getAssignment(shape.implementer.assignmentId)!.leaseId;
      const historicalAuditor = registry.getAssignment(shape.auditor.assignmentId);
      expect(registry.coordinateTaskAssignment({
        taskId: shape.taskId,
        assignmentId: shape.implementer.assignmentId,
        leaseAction: 'clear',
        idempotencyKey: 'same-object-revision-clear-stale-lease',
        reason: 'reproduce the pre-recovery empty lease blocker',
        now: 450,
      })).toMatchObject({ ok: true });
      expect(registry.getAssignment(shape.implementer.assignmentId)).toMatchObject({
        status: 'implementing', leaseId: '',
        auditAttemptId: `${shape.taskId}-r1-attempt`,
        auditRevision: shape.fromRevision,
        verdict: 'REWORK',
      });
      const eventCount = registry.listEvents(shape.taskId).length;
      const request = {
        taskId: shape.taskId,
        assignmentId: shape.implementer.assignmentId,
        fromRevision: shape.fromRevision,
        toRevision: shape.toRevision,
        ownedFiles: shape.files,
        scopeFiles: shape.scopeFiles,
        leaseAction: 'preserve' as const,
        idempotencyKey: 'same-object-revision-recovery-r3',
        evidenceManifestSha256: shape.evidenceManifestSha256,
        worktreeSnapshot: recoveryWorktreeSnapshot(shape.files, shape.evidenceManifestSha256),
        reason: 'bind validated frozen R3 without replacing the GC objects',
        now: 500,
      };

      expect(registry.rebindTaskAssignmentRevision(request)).toMatchObject({
        ok: true,
        value: { taskId: shape.taskId, status: 'implementing', currentRevision: shape.toRevision },
      });
      expect(registry.getAssignment(shape.implementer.assignmentId)).toMatchObject({
        assignmentId: shape.implementer.assignmentId,
        status: 'implementing', leaseId: expect.any(String), generation: 3,
        scopeFiles: shape.scopeFiles,
        auditRevision: shape.toRevision,
      });
      const renewedLeaseId = registry.getAssignment(shape.implementer.assignmentId)!.leaseId;
      expect(renewedLeaseId).not.toBe('');
      expect(renewedLeaseId).not.toBe(originalLeaseId);
      expect(registry.getAssignment(shape.implementer.assignmentId)).not.toHaveProperty('auditAttemptId');
      expect(registry.getAssignment(shape.implementer.assignmentId)).not.toHaveProperty('verdict');
      expect(registry.getAssignment(shape.implementer.assignmentId)).not.toHaveProperty('blocker');
      expect(registry.getAssignment(shape.auditor.assignmentId)).toEqual(historicalAuditor);
      expect(registry.listAssignments(shape.taskId)).toHaveLength(assignmentCount);
      const recoveryEvents = registry.listEvents(shape.taskId).slice(eventCount);
      expect(recoveryEvents).toEqual([
        expect.objectContaining({
          assignmentId: shape.implementer.assignmentId, eventType: 'recovered', status: 'implementing',
          payload: expect.objectContaining({
            source: 'brain_authorized_revision_rebind',
            fromRevision: shape.fromRevision, toRevision: shape.toRevision,
            ownedFiles: shape.files,
            scopeFiles: shape.scopeFiles,
            leaseAction: 'preserve',
            evidenceManifestSha256: shape.evidenceManifestSha256,
            previousAuditAttemptId: `${shape.taskId}-r1-attempt`, previousVerdict: 'REWORK',
          }),
        }),
        expect.objectContaining({
          eventType: 'recovered', status: 'implementing',
          payload: expect.objectContaining({ assignmentId: shape.implementer.assignmentId }),
        }),
      ]);
      expect(recoveryEvents[1]?.assignmentId).toBeUndefined();

      registry.close();
      registry = new SupervisionTaskRegistry({ dbPath });
      const persistedEvents = registry.listEvents(shape.taskId).length;
      expect(registry.rebindTaskAssignmentRevision({ ...request, now: 900 })).toMatchObject({
        ok: true, replay: true,
        value: { status: 'implementing', currentRevision: shape.toRevision },
      });
      expect(registry.rebindTaskAssignmentRevision({
        ...request,
        ownedFiles: ['caller/reported-only.ts'],
        scopeFiles: ['caller/reported-only.ts'],
        evidenceManifestSha256: 'f'.repeat(64),
        now: 910,
      })).toMatchObject({ ok: true, replay: true });
      expect(registry.listEvents(shape.taskId)).toHaveLength(persistedEvents);
      expect(registry.listAssignments(shape.taskId)).toHaveLength(assignmentCount);
      expect(registry.getAssignment(shape.implementer.assignmentId)?.leaseId).toBe(renewedLeaseId);
      const persistedState = registry.get(shape.taskId);
      const firstFile = request.worktreeSnapshot.files[0]!;
      for (const [name, worktreeSnapshot] of [
        ['changed-head', { ...request.worktreeSnapshot, headSha: 'b'.repeat(40) }],
        ['same-path-changed-bytes', {
          ...request.worktreeSnapshot,
          files: [{ path: firstFile.path, sha256: 'c'.repeat(64) }, ...request.worktreeSnapshot.files.slice(1)],
        }],
        ['same-path-changed-to-deletion', {
          ...request.worktreeSnapshot,
          files: [{ path: firstFile.path, deleted: true as const }, ...request.worktreeSnapshot.files.slice(1)],
        }],
        ['added-path', {
          ...request.worktreeSnapshot,
          files: [...request.worktreeSnapshot.files, { path: 'src/added-after-freeze.ts', sha256: 'e'.repeat(64) }],
        }],
        ['removed-path', {
          ...request.worktreeSnapshot,
          files: request.worktreeSnapshot.files.slice(1),
        }],
      ] as const) {
        expect(registry.rebindTaskAssignmentRevision({
          ...request,
          worktreeSnapshot,
          now: 925,
        }), name).toEqual({ ok: false, reason: 'conflicting_replay' });
        expect(registry.get(shape.taskId), name).toEqual(persistedState);
        expect(registry.listEvents(shape.taskId), name).toHaveLength(persistedEvents);
      }
      expect(registry.updateAssignment({
        assignmentId: shape.implementer.assignmentId, identity: shape.implementerIdentity,
        status: 'validated', revision: shape.toRevision, auditRevision: shape.toRevision,
      })).toMatchObject({ ok: true, value: { status: 'validated', auditRevision: shape.toRevision } });
      expect(registry.updateAssignment({
        assignmentId: shape.implementer.assignmentId, identity: shape.implementerIdentity,
        status: 'ready_for_audit', revision: shape.toRevision, auditRevision: shape.toRevision,
      })).toMatchObject({ ok: true, value: { status: 'ready_for_audit', auditRevision: shape.toRevision } });
    } finally {
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('atomically binds an R1 REWORK implementer to its sole finalized matching R2 PASS without fabricating completion', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = prepareFinalizedPassedSuccessorRecoveryShape(
      registry, database, 'finalized-passed-successor-recovery',
    );
    const assignmentCount = registry.listAssignments(shape.taskId).length;
    const receipts = registry.listAuditReceipts(shape.taskId);
    const originalLeaseId = registry.getAssignment(shape.implementer.assignmentId)!.leaseId;
    const targetAuditor = registry.getAssignment(shape.auditor.assignmentId);
    const request = {
      taskId: shape.taskId, assignmentId: shape.implementer.assignmentId,
      fromRevision: shape.fromRevision, toRevision: shape.toRevision,
      worktreeSnapshot: recoveryWorktreeSnapshot(shape.files, shape.evidenceManifestSha256),
      leaseAction: 'preserve' as const,
      idempotencyKey: 'bind-finalized-passed-successor-r2',
      reason: 'atomically repair the R1/R2 projection without replacing the implementer',
      now: 200,
    };

    expect(registry.get(shape.taskId)).toMatchObject({
      status: 'rework', currentRevision: shape.fromRevision,
    });
    expect(registry.getAssignment(shape.implementer.assignmentId)).toMatchObject({
      status: 'rework', leaseId: originalLeaseId,
      auditAttemptId: `${shape.taskId}-r1-attempt`, auditRevision: shape.fromRevision,
      verdict: 'REWORK',
    });
    expect(registry.rebindTaskAssignmentRevision(request)).toMatchObject({
      ok: true, value: { status: 'implementing', currentRevision: shape.toRevision },
    });
    expect(registry.getAssignment(shape.implementer.assignmentId)).toMatchObject({
      status: 'implementing', leaseId: originalLeaseId, auditRevision: shape.toRevision,
    });
    expect(registry.getAssignment(shape.implementer.assignmentId)).not.toHaveProperty('auditAttemptId');
    expect(registry.getAssignment(shape.implementer.assignmentId)).not.toHaveProperty('verdict');
    expect(registry.get(shape.taskId)).not.toHaveProperty('commitSha');
    expect(registry.get(shape.taskId)).not.toHaveProperty('pushRemoteRef');
    expect(registry.get(shape.taskId)).not.toHaveProperty('finalization');
    expect(registry.getAssignment(shape.auditor.assignmentId)).toEqual(targetAuditor);
    expect(registry.listAssignments(shape.taskId)).toHaveLength(assignmentCount);
    expect(registry.listAuditReceipts(shape.taskId)).toEqual(receipts);

    const beforeFinishEvents = registry.listEvents(shape.taskId).length;
    expect(registry.finishAssignment({
      assignmentId: shape.implementer.assignmentId,
      identity: shape.implementerIdentity,
      revision: shape.toRevision,
      now: 300,
    })).toMatchObject({
      ok: true,
      value: {
        status: 'ready_for_integration', leaseId: '',
        auditAttemptId: targetAuditor?.auditAttemptId,
        auditRevision: shape.toRevision, verdict: 'PASS',
      },
    });
    const afterFinishEvents = registry.listEvents(shape.taskId).length;
    expect(afterFinishEvents).toBeGreaterThan(beforeFinishEvents);
    expect(registry.finishAssignment({
      assignmentId: shape.implementer.assignmentId,
      identity: shape.implementerIdentity,
      revision: shape.toRevision,
      now: 400,
    })).toMatchObject({ ok: true, replay: true, value: { status: 'ready_for_integration' } });
    expect(registry.listEvents(shape.taskId)).toHaveLength(afterFinishEvents);
    expect(registry.listAuditReceipts(shape.taskId)).toEqual(receipts);
    registry.close();
    database.close();
  });

  it.each([
    'missing', 'wrong-verdict', 'wrong-attempt', 'foreign-task', 'foreign-assignment',
  ] as const)('rejects a %s finalized-successor receipt without mutation', (receiptBinding) => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = prepareFinalizedPassedSuccessorRecoveryShape(
      registry, database, `finalized-successor-${receiptBinding}`, receiptBinding,
    );
    const before = registry.get(shape.taskId);
    const assignments = registry.listAssignments(shape.taskId);
    const receipts = registry.listAuditReceipts(shape.taskId);
    const events = registry.listEvents(shape.taskId).length;
    expect(registry.rebindTaskAssignmentRevision({
      taskId: shape.taskId, assignmentId: shape.implementer.assignmentId,
      fromRevision: shape.fromRevision, toRevision: shape.toRevision,
      worktreeSnapshot: recoveryWorktreeSnapshot(shape.files, shape.evidenceManifestSha256),
      leaseAction: 'preserve', idempotencyKey: `refuse-${receiptBinding}-successor`,
      reason: 'nonmatching PASS evidence must not authorize recovery',
    })).toEqual({ ok: false, reason: 'invalid_transition' });
    expect(registry.get(shape.taskId)).toEqual(before);
    expect(registry.listAssignments(shape.taskId)).toEqual(assignments);
    expect(registry.listAuditReceipts(shape.taskId)).toEqual(receipts);
    expect(registry.listEvents(shape.taskId)).toHaveLength(events);
    registry.close();
    database.close();
  });

  it('rejects ambiguous finalized matching successors without mutation', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = prepareFinalizedPassedSuccessorRecoveryShape(
      registry, database, 'ambiguous-finalized-passed-successor',
    );
    const secondIdentity = identity('ambiguous-finalized-passed-successor-auditor-2');
    const second = registry.createAssignment({
      assignmentId: `${shape.taskId}-target-auditor-2`, taskId: shape.taskId,
      role: 'auditor', required: false, identity: secondIdentity,
      auditAttemptId: `${shape.taskId}-r2-attempt-2`, auditRevision: shape.toRevision,
    });
    if (!second.ok) throw new Error(second.reason);
    rewritePersistedAssignment(database, {
      ...second.value, status: 'finalized', leaseId: '', verdict: 'PASS', updatedAt: 140,
    });
    seedFinalAuditReceipt(database, {
      receiptId: `${shape.taskId}-r2-pass-receipt-2`, taskId: shape.taskId,
      assignmentId: second.value.assignmentId, attemptId: `${shape.taskId}-r2-attempt-2`,
      revision: shape.toRevision, verdict: 'PASS', senderIdentity: secondIdentity, createdAt: 140,
    });
    const before = registry.get(shape.taskId);
    const assignments = registry.listAssignments(shape.taskId);
    const receipts = registry.listAuditReceipts(shape.taskId);
    const events = registry.listEvents(shape.taskId).length;
    expect(registry.rebindTaskAssignmentRevision({
      taskId: shape.taskId, assignmentId: shape.implementer.assignmentId,
      fromRevision: shape.fromRevision, toRevision: shape.toRevision,
      worktreeSnapshot: recoveryWorktreeSnapshot(shape.files, shape.evidenceManifestSha256),
      leaseAction: 'preserve', idempotencyKey: 'refuse-ambiguous-passed-successor',
      reason: 'multiple exact finalized PASS successors must fail closed',
    })).toEqual({ ok: false, reason: 'invalid_transition' });
    expect(registry.get(shape.taskId)).toEqual(before);
    expect(registry.listAssignments(shape.taskId)).toEqual(assignments);
    expect(registry.listAuditReceipts(shape.taskId)).toEqual(receipts);
    expect(registry.listEvents(shape.taskId)).toHaveLength(events);
    registry.close();
    database.close();
  });

  it('converges an inspected assignment-target/task-source split without weakening recovery gates', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = prepareSameObjectRevisionRecoveryShape(registry, 'assignment-target-task-source-split');
    const historicalAuditorIdentity = identity('deck_split_r1_auditor', 'claude-code-sdk');
    const historicalAuditor = registry.createAssignment({
      assignmentId: `${shape.taskId}-r1-auditor`, taskId: shape.taskId,
      role: 'auditor', required: false, identity: historicalAuditorIdentity,
      auditAttemptId: `${shape.taskId}-r1-attempt`, auditRevision: shape.fromRevision,
    });
    if (!historicalAuditor.ok) throw new Error(historicalAuditor.reason);
    expect(registry.updateAssignment({
      assignmentId: historicalAuditor.value.assignmentId, identity: historicalAuditorIdentity,
      status: 'auditing', auditAttemptId: `${shape.taskId}-r1-attempt`,
      auditRevision: shape.fromRevision,
    })).toMatchObject({ ok: true });
    expect(registry.appendMatchingAuditReceipt({
      taskId: shape.taskId, auditorAssignmentId: historicalAuditor.value.assignmentId,
      attemptId: `${shape.taskId}-r1-attempt`, revision: shape.fromRevision,
      receiptKind: 'final', verdict: 'REWORK', auditorSessionName: historicalAuditorIdentity.sessionName,
      auditorIdentity: historicalAuditorIdentity, findings: 'immutable R1 finding',
      validations: [{ kind: 'test', label: 'R1', outcome: 'failed', summary: 'R1 requires correction' }],
      now: 100,
    })).toMatchObject({ ok: true, value: { verdict: 'REWORK' } });
    expect(registry.applyTaskIntent({
      taskId: shape.taskId, assignmentId: historicalAuditor.value.assignmentId,
      intent: 'cancel', toStatus: 'cancelled', note: 'retain the completed R1 audit row',
    })).toMatchObject({ ok: true });

    const implementer = registry.getAssignment(shape.implementer.assignmentId)!;
    rewritePersistedAssignment(database, {
      ...implementer,
      // Production split: the authoritative inspector already projected R2
      // to this exact implementer, while the task row remains on R1.
      auditRevision: shape.toRevision,
      updatedAt: 200,
    });
    expect(registry.get(shape.taskId)).toMatchObject({ currentRevision: shape.fromRevision });
    expect(registry.getAssignment(shape.implementer.assignmentId)).toMatchObject({
      status: 'implementing', auditAttemptId: `${shape.taskId}-r1-attempt`,
      auditRevision: shape.toRevision, verdict: 'REWORK',
    });

    const receiptsBefore = registry.listAuditReceipts(shape.taskId);
    const assignmentsBefore = registry.listAssignments(shape.taskId).length;
    const leaseBefore = registry.getAssignment(shape.implementer.assignmentId)!.leaseId;
    const request = {
      taskId: shape.taskId, assignmentId: shape.implementer.assignmentId,
      fromRevision: shape.fromRevision, toRevision: shape.toRevision,
      worktreeSnapshot: recoveryWorktreeSnapshot(shape.files, shape.evidenceManifestSha256),
      leaseAction: 'preserve' as const, idempotencyKey: 'converge-assignment-target-task-source-r2',
      reason: 'atomically converge the exact inspected assignment and stale task projection',
      now: 300,
    };
    const splitState = registry.get(shape.taskId);
    const splitEvents = registry.listEvents(shape.taskId).length;
    expect(registry.rebindTaskAssignmentRevision({
      ...request, fromRevision: shape.toRevision,
      idempotencyKey: 'must-not-disguise-split-as-target-replay',
    })).toEqual({ ok: false, reason: 'invalid' });
    expect(registry.get(shape.taskId)).toEqual(splitState);
    expect(registry.listEvents(shape.taskId)).toHaveLength(splitEvents);
    expect(registry.rebindTaskAssignmentRevision(request)).toMatchObject({
      ok: true, value: { status: 'implementing', currentRevision: shape.toRevision },
    });
    expect(registry.getAssignment(shape.implementer.assignmentId)).toMatchObject({
      status: 'implementing', auditRevision: shape.toRevision, leaseId: leaseBefore,
    });
    expect(registry.getAssignment(shape.implementer.assignmentId)).not.toHaveProperty('auditAttemptId');
    expect(registry.getAssignment(shape.implementer.assignmentId)).not.toHaveProperty('verdict');
    expect(registry.listAssignments(shape.taskId)).toHaveLength(assignmentsBefore);
    expect(registry.listAuditReceipts(shape.taskId)).toEqual(receiptsBefore);

    const eventCount = registry.listEvents(shape.taskId).length;
    expect(registry.rebindTaskAssignmentRevision({ ...request, now: 400 })).toMatchObject({
      ok: true, replay: true, value: { currentRevision: shape.toRevision },
    });
    expect(registry.listEvents(shape.taskId)).toHaveLength(eventCount);
    expect(registry.rebindTaskAssignmentRevision({
      ...request,
      worktreeSnapshot: {
        ...request.worktreeSnapshot,
        files: request.worktreeSnapshot.files.map((file, index) => (
          index === 0 ? { ...file, sha256: 'c'.repeat(64) } : file
        )),
      },
      now: 500,
    })).toEqual({ ok: false, reason: 'conflicting_replay' });
    expect(registry.listEvents(shape.taskId)).toHaveLength(eventCount);
    registry.close();
    database.close();
  });

  it('rejects task-null/assignment-target recovery without an exact declared source', () => {
    for (const [name, fromRevision] of [
      ['omitted-source', undefined],
      ['claimed-source', 'fabricated-source-r1'],
    ] as const) {
      const database = new DatabaseSync(':memory:');
      const registry = new SupervisionTaskRegistry({ database });
      const taskId = `task-null-assignment-target-${name}`;
      const assignmentId = `${taskId}-implementer`;
      const toRevision = 'inspected-target-r2';
      const owner = identity(`deck_${name}_worker`);
      const files = ['src/null-target.ts'];
      expect(registry.createOrGet({
        taskId, projectName: 'alpha', classification: 'independent_top_level',
        objective: 'reject a target assignment without an exact task source',
      })).toMatchObject({ ok: true });
      const created = registry.createAssignment({
        assignmentId, taskId, role: 'implementer', identity: owner,
        auditRevision: toRevision,
      });
      if (!created.ok) throw new Error(created.reason);
      expect(registry.updateTask({ taskId, status: 'delegated' })).toMatchObject({ ok: true });
      expect(registry.updateTask({ taskId, status: 'implementing' })).toMatchObject({ ok: true });
      rewritePersistedAssignment(database, {
        ...registry.getAssignment(assignmentId)!, status: 'implementing', updatedAt: 100,
      });
      expect(registry.getTaskRecord(taskId)).not.toHaveProperty('currentRevision');
      expect(registry.getAssignment(assignmentId)).toMatchObject({
        status: 'implementing', auditRevision: toRevision,
      });

      const beforeTask = registry.get(taskId);
      const beforeAssignment = registry.getAssignment(assignmentId);
      const eventCount = registry.listEvents(taskId).length;
      expect(registry.rebindTaskAssignmentRevision({
        taskId, assignmentId, fromRevision, toRevision,
        worktreeSnapshot: recoveryWorktreeSnapshot(files),
        leaseAction: 'preserve', idempotencyKey: `${taskId}-must-refuse`,
        reason: 'target assignment cannot supply a missing task source',
      }), name).toEqual({ ok: false, reason: 'old_revision' });
      expect(registry.get(taskId), name).toEqual(beforeTask);
      expect(registry.getAssignment(assignmentId), name).toEqual(beforeAssignment);
      expect(registry.listEvents(taskId), name).toHaveLength(eventCount);
      registry.close();
      database.close();
    }
  });

  it('normalizes stale nonterminal projections and a missing lease in one exact rebind', () => {
    const registry = makeRegistry();
    const shape = prepareSameObjectRevisionRecoveryShape(registry, 'stale-status-missing-lease-rebind');
    expect(registry.updateTask({ taskId: shape.taskId, status: 'validated' })).toMatchObject({ ok: true });
    expect(registry.updateAssignment({
      assignmentId: shape.implementer.assignmentId, identity: shape.implementerIdentity,
      status: 'validated', revision: shape.fromRevision,
      auditAttemptId: `${shape.taskId}-r1-attempt`, auditRevision: shape.fromRevision,
      verdict: 'REWORK',
    })).toMatchObject({ ok: true, value: { status: 'validated' } });
    expect(registry.coordinateTaskAssignment({
      taskId: shape.taskId, assignmentId: shape.implementer.assignmentId,
      leaseAction: 'clear', idempotencyKey: 'stale-status-clear-lease-fixture',
      reason: 'reproduce a stale nonterminal projection without a lease', now: 400,
    })).toMatchObject({ ok: true, value: { status: 'validated' } });
    expect(registry.getAssignment(shape.implementer.assignmentId)).toMatchObject({
      status: 'validated', leaseId: '', auditRevision: shape.fromRevision, verdict: 'REWORK',
    });
    expect(registry.rebindTaskAssignmentRevision({
      taskId: shape.taskId, assignmentId: shape.implementer.assignmentId,
      fromRevision: shape.fromRevision, toRevision: shape.toRevision,
      worktreeSnapshot: recoveryWorktreeSnapshot(shape.files, shape.evidenceManifestSha256),
      leaseAction: 'preserve', idempotencyKey: 'stale-status-missing-lease-bind-r3',
      reason: 'normalize the exact same implementer and worktree in one atomic recovery', now: 500,
    })).toMatchObject({
      ok: true, value: { status: 'implementing', currentRevision: shape.toRevision },
    });
    expect(registry.getAssignment(shape.implementer.assignmentId)).toMatchObject({
      status: 'implementing', auditRevision: shape.toRevision,
      leaseId: expect.stringMatching(/^(?:lse|supervision_lease)_/),
    });
    expect(registry.getAssignment(shape.implementer.assignmentId)).not.toHaveProperty('auditAttemptId');
    expect(registry.getAssignment(shape.implementer.assignmentId)).not.toHaveProperty('verdict');
    expect(registry.getAssignment(shape.implementer.assignmentId)).not.toHaveProperty('primaryReviewPassed');
    expect(registry.getAssignment(shape.implementer.assignmentId)).not.toHaveProperty('crossVendorAuditPassed');
    expect(registry.listAuditReceipts(shape.taskId)).toEqual([]);
    registry.close();
  });

  it('rejects leaseAction clear before revision-rebind mutation', () => {
    const registry = makeRegistry();
    const shape = prepareSameObjectRevisionRecoveryShape(registry, 'revision-rebind-clear-refusal');
    const before = registry.get(shape.taskId);
    const beforeAssignment = registry.getAssignment(shape.implementer.assignmentId);
    const eventCount = registry.listEvents(shape.taskId).length;

    expect(registry.rebindTaskAssignmentRevision({
      taskId: shape.taskId,
      assignmentId: shape.implementer.assignmentId,
      fromRevision: shape.fromRevision,
      toRevision: shape.toRevision,
      worktreeSnapshot: recoveryWorktreeSnapshot(shape.files, shape.evidenceManifestSha256),
      leaseAction: 'clear',
      idempotencyKey: 'revision-rebind-must-not-persist-clear',
      reason: 'clear contradicts the active lease required by a successful revision rebind',
      now: 500,
    })).toEqual({ ok: false, reason: 'invalid' });
    expect(registry.get(shape.taskId)).toEqual(before);
    expect(registry.getAssignment(shape.implementer.assignmentId)).toEqual(beforeAssignment);
    expect(registry.listEvents(shape.taskId)).toHaveLength(eventCount);
    registry.close();
  });

  it('rebinds an explicitly reopened post-PASS CI failure without letting R1 PASS qualify R2', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const taskId = 'post-pass-ci-failure-rebind';
    const fromRevision = 'post-pass-ci-failure-r1';
    const toRevision = 'post-pass-ci-failure-r2';
    const attemptId = 'post-pass-ci-failure-audit-r1';
    const files = ['src/daemon/post-pass-fix.ts', 'test/daemon/post-pass-fix.test.ts'];
    const implementerIdentity = identity('deck_post_pass_worker');
    const auditorIdentity = identity('deck_post_pass_auditor', 'claude-code-sdk');
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'independent_top_level',
      objective: 'repair a real external CI failure after matching PASS', currentRevision: fromRevision,
    })).toMatchObject({ ok: true });
    const implementer = registry.createAssignment({
      assignmentId: `${taskId}-implementer`, taskId, role: 'implementer',
      identity: implementerIdentity, scopeFiles: files,
      auditAttemptId: attemptId, auditRevision: fromRevision,
    });
    const auditor = registry.createAssignment({
      assignmentId: `${taskId}-auditor`, taskId, role: 'auditor', required: false,
      identity: auditorIdentity, scopeFiles: files,
      auditAttemptId: attemptId, auditRevision: fromRevision,
    });
    if (!implementer.ok || !auditor.ok) throw new Error('post-PASS CI fixture creation failed');
    expect(registry.updateTask({ taskId, status: 'delegated' })).toMatchObject({ ok: true });
    expect(registry.updateTask({ taskId, status: 'implementing' })).toMatchObject({ ok: true });
    for (const status of ['implementing', 'validated', 'ready_for_audit'] as const) {
      expect(registry.updateAssignment({
        assignmentId: implementer.value.assignmentId, identity: implementerIdentity,
        status, revision: fromRevision, auditAttemptId: attemptId, auditRevision: fromRevision,
      }), status).toMatchObject({ ok: true });
    }
    expect(registry.updateAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditorIdentity,
      status: 'auditing', auditAttemptId: attemptId, auditRevision: fromRevision,
    })).toMatchObject({ ok: true });
    expect(registry.appendMatchingAuditReceipt({
      taskId, auditorAssignmentId: auditor.value.assignmentId,
      attemptId, revision: fromRevision, receiptKind: 'final', verdict: 'PASS',
      auditorSessionName: auditorIdentity.sessionName, auditorIdentity,
      findings: 'R1 matched before external CI found a real error',
      validations: [{ kind: 'test', label: 'R1', outcome: 'passed', summary: 'R1 frozen evidence passed' }],
      now: 100,
    })).toMatchObject({ ok: true, value: { revision: fromRevision, verdict: 'PASS' } });
    expect(registry.applyMatchingAuditReceipt({
      taskId, auditorAssignmentId: auditor.value.assignmentId,
      attemptId, revision: fromRevision, verdict: 'PASS',
      auditedSessionName: implementerIdentity.sessionName,
      auditorSessionName: auditorIdentity.sessionName,
      findings: 'authenticated R1 PASS',
      validations: [{ kind: 'test', label: 'R1', outcome: 'passed', summary: 'R1 matched' }],
      now: 110,
    })).toMatchObject({ ok: true, value: { status: 'ready_for_integration', verdict: 'PASS' } });
    expect(registry.finishAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditorIdentity,
      revision: fromRevision, now: 120,
    })).toMatchObject({ ok: true, value: { status: 'finalized', leaseId: '' } });

    const request = {
      taskId, assignmentId: implementer.value.assignmentId,
      fromRevision, toRevision, worktreeSnapshot: recoveryWorktreeSnapshot(files),
      leaseAction: 'preserve' as const, idempotencyKey: 'post-pass-ci-failure-bind-r2',
      reason: 'bind the exact compile-clean R2 after Brain reopens the same object',
    };
    const beforeReopen = registry.get(taskId);
    const beforeReopenEvents = registry.listEvents(taskId).length;
    expect(registry.rebindTaskAssignmentRevision(request)).toEqual({ ok: false, reason: 'invalid_transition' });
    expect(registry.get(taskId)).toEqual(beforeReopen);
    expect(registry.listEvents(taskId)).toHaveLength(beforeReopenEvents);

    expect(registry.coordinateTaskAssignment({
      taskId, assignmentId: implementer.value.assignmentId,
      taskStatus: 'implementing', assignmentStatus: 'implementing', leaseAction: 'renew',
      idempotencyKey: 'post-pass-ci-failure-explicit-reopen',
      reason: 'external CI found a real R1 compile error; require corrected R2 and fresh audit',
      now: 200,
    })).toMatchObject({ ok: true, value: { status: 'implementing', currentRevision: fromRevision } });
    expect(registry.getAssignment(implementer.value.assignmentId)).toMatchObject({
      status: 'implementing', leaseId: expect.stringMatching(/^(?:lse|supervision_lease)_/),
    });
    expect(registry.getAssignment(implementer.value.assignmentId)).not.toHaveProperty('auditAttemptId');
    expect(registry.getAssignment(implementer.value.assignmentId)).not.toHaveProperty('auditRevision');
    expect(registry.getAssignment(implementer.value.assignmentId)).not.toHaveProperty('verdict');

    const historicalReceipts = registry.listAuditReceipts(taskId);
    const historicalAttestations = database.prepare(`
      SELECT attempt_id AS attemptId, revision, verdict
      FROM supervision_audit_attestations WHERE task_id = ? ORDER BY created_at
    `).all(taskId);
    expect(historicalReceipts).toEqual([expect.objectContaining({
      attemptId, revision: fromRevision, receiptKind: 'final', verdict: 'PASS',
    })]);
    expect(historicalAttestations).toEqual([expect.objectContaining({
      attemptId, revision: fromRevision, verdict: 'PASS',
    })]);
    expect(registry.rebindTaskAssignmentRevision({ ...request, now: 300 })).toMatchObject({
      ok: true, value: { status: 'implementing', currentRevision: toRevision },
    });
    expect(registry.listAuditReceipts(taskId)).toEqual(historicalReceipts);
    expect(database.prepare(`
      SELECT attempt_id AS attemptId, revision, verdict
      FROM supervision_audit_attestations WHERE task_id = ? ORDER BY created_at
    `).all(taskId)).toEqual(historicalAttestations);
    expect(registry.getAssignment(auditor.value.assignmentId)).toMatchObject({
      status: 'finalized', auditRevision: fromRevision, verdict: 'PASS', leaseId: '',
    });
    expect(registry.getAssignment(implementer.value.assignmentId)).toMatchObject({
      status: 'implementing', auditRevision: toRevision,
    });
    expect(registry.getAssignment(implementer.value.assignmentId)).not.toHaveProperty('auditAttemptId');
    expect(registry.getAssignment(implementer.value.assignmentId)).not.toHaveProperty('verdict');
    expect(registry.get(taskId)).toMatchObject({ status: 'implementing', currentRevision: toRevision });
    registry.close();
    database.close();
  });

  it('rejects assignment-only terminal PASS rows for the target revision without mutation', () => {
    for (const terminalStatus of ['finalized', 'cancelled'] as const) {
      const database = new DatabaseSync(':memory:');
      const registry = new SupervisionTaskRegistry({ database });
      const shape = prepareSameObjectRevisionRecoveryShape(
        registry, `target-pass-assignment-only-${terminalStatus}`,
      );
      const legacyIdentity = identity(`deck_target_pass_${terminalStatus}_auditor`);
      const legacy = registry.createAssignment({
        assignmentId: `${shape.taskId}-legacy-target-pass`, taskId: shape.taskId,
        role: 'auditor', required: false, identity: legacyIdentity,
        auditAttemptId: `${shape.taskId}-legacy-target-pass-attempt`,
        auditRevision: shape.toRevision,
      });
      if (!legacy.ok) throw new Error('legacy target PASS fixture creation failed');
      rewritePersistedAssignment(database, {
        ...legacy.value,
        status: terminalStatus,
        leaseId: '',
        verdict: 'PASS',
        updatedAt: 200,
      });
      expect(registry.listAuditReceipts(shape.taskId)).toEqual([]);
      expect(database.prepare(`
        SELECT 1 AS ok FROM supervision_audit_attestations
        WHERE task_id = ? AND revision = ?
      `).get(shape.taskId, shape.toRevision)).toBeUndefined();
      const before = registry.get(shape.taskId);
      const eventCount = registry.listEvents(shape.taskId).length;
      expect(registry.rebindTaskAssignmentRevision({
        taskId: shape.taskId, assignmentId: shape.implementer.assignmentId,
        fromRevision: shape.fromRevision, toRevision: shape.toRevision,
        worktreeSnapshot: recoveryWorktreeSnapshot(shape.files, shape.evidenceManifestSha256),
        leaseAction: 'preserve', idempotencyKey: `${shape.taskId}-must-refuse`,
        reason: 'assignment-only target PASS must remain authoritative',
      }), terminalStatus).toEqual({ ok: false, reason: 'invalid_transition' });
      expect(registry.get(shape.taskId), terminalStatus).toEqual(before);
      expect(registry.listEvents(shape.taskId), terminalStatus).toHaveLength(eventCount);
      registry.close();
      database.close();
    }
  });

  it('treats legacy claims as metadata while exact worktree bytes still gate recovery', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = prepareSameObjectRevisionRecoveryShape(registry, 'revision-recovery-metadata-claims');
    database.prepare(`
      INSERT INTO supervision_task_file_claims
        (task_id, assignment_id, file_path, claim_mode, created_at)
      VALUES (?, ?, ?, 'exclusive', 100), (?, ?, ?, 'read_only', 101)
    `).run(
      shape.taskId, shape.implementer.assignmentId, 'stale/active-metadata-claim.ts',
      shape.taskId, shape.auditor.assignmentId, 'stale/historical-metadata-claim.ts',
    );
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM supervision_task_file_claims WHERE task_id = ?
    `).get(shape.taskId)).toEqual({ count: 2 });
    const request = {
      taskId: shape.taskId, assignmentId: shape.implementer.assignmentId,
      fromRevision: shape.fromRevision, toRevision: shape.toRevision,
      worktreeSnapshot: recoveryWorktreeSnapshot(shape.files, shape.evidenceManifestSha256),
      leaseAction: 'preserve' as const, idempotencyKey: 'metadata-claims-do-not-veto',
      reason: 'assignment worktree bytes are recovery authority; claims are provenance only',
    };
    expect(registry.rebindTaskAssignmentRevision(request)).toMatchObject({
      ok: true, value: { currentRevision: shape.toRevision, status: 'implementing' },
    });
    const state = registry.get(shape.taskId);
    const events = registry.listEvents(shape.taskId).length;
    const first = request.worktreeSnapshot.files[0]!;
    expect(registry.rebindTaskAssignmentRevision({
      ...request,
      worktreeSnapshot: {
        ...request.worktreeSnapshot,
        files: [{ ...first, sha256: 'd'.repeat(64) }, ...request.worktreeSnapshot.files.slice(1)],
      },
    })).toEqual({ ok: false, reason: 'conflicting_replay' });
    expect(registry.get(shape.taskId)).toEqual(state);
    expect(registry.listEvents(shape.taskId)).toHaveLength(events);
    registry.close();
    database.close();
  });

  it('atomically binds null task/audit revisions from exact file events and replays after SQLite reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-null-revision-recovery-'));
    const dbPath = join(dir, 'supervision-state.sqlite');
    const taskId = 'null-revision-recovery';
    const assignmentId = `${taskId}-implementer`;
    const owner = identity('deck_null_revision_worker');
    const ownedFiles = ['src/one.ts', 'test/one.test.ts'];
    const scopeFiles = [...ownedFiles, 'test/authorized-but-untouched.test.ts'].sort();
    const toRevision = 'null-revision-frozen-r1';
    let registry = new SupervisionTaskRegistry({ dbPath });
    try {
      expect(registry.createOrGet({
        taskId, projectName: 'alpha', classification: 'independent_top_level',
        objective: 'bind frozen evidence after a legacy null revision',
      })).toMatchObject({ ok: true });
      const assignment = registry.createAssignment({
        assignmentId, taskId, role: 'implementer', identity: owner, scopeFiles,
      });
      expect(assignment).toMatchObject({ ok: true });
      expect(registry.updateTask({ taskId, status: 'delegated' })).toMatchObject({ ok: true });
      expect(registry.updateTask({ taskId, status: 'implementing' })).toMatchObject({ ok: true });
      expect(registry.updateAssignment({
        assignmentId, identity: owner, status: 'implementing',
      })).toMatchObject({ ok: true });
      for (const [index, path] of ownedFiles.entries()) {
        expect(registry.recordFileEvent({
          assignmentId, identity: owner, path, operation: 'modify',
          idempotencyKey: `${taskId}-file-${index}`,
        })).toMatchObject({ ok: true });
      }
      expect(registry.getTaskRecord(taskId)).not.toHaveProperty('currentRevision');
      expect(registry.getAssignment(assignmentId)).not.toHaveProperty('auditRevision');

      const request = {
        taskId, assignmentId, toRevision, ownedFiles, scopeFiles,
        leaseAction: 'renew' as const,
        idempotencyKey: 'null-revision-bind-frozen-r1',
        evidenceManifestSha256: 'e'.repeat(64),
        worktreeSnapshot: recoveryWorktreeSnapshot(ownedFiles, 'e'.repeat(64)),
        reason: 'atomically bind exact frozen evidence without replacement objects',
        now: 500,
      };
      expect(registry.rebindTaskAssignmentRevision(request)).toMatchObject({
        ok: true, value: { currentRevision: toRevision, status: 'implementing' },
      });
      const persistedLease = registry.getAssignment(assignmentId)?.leaseId;
      expect(persistedLease).toMatch(/^(?:lse|supervision_lease)_/);
      expect(registry.getAssignment(assignmentId)).toMatchObject({
        auditRevision: toRevision, scopeFiles,
      });
      expect(registry.listEvents(taskId)).toContainEqual(expect.objectContaining({
        assignmentId, eventType: 'recovered',
        payload: expect.objectContaining({ fromRevision: null, toRevision, ownedFiles, scopeFiles }),
      }));

      registry.close();
      registry = new SupervisionTaskRegistry({ dbPath });
      const eventCount = registry.listEvents(taskId).length;
      expect(registry.rebindTaskAssignmentRevision({ ...request, now: 900 })).toMatchObject({
        ok: true, replay: true, value: { currentRevision: toRevision },
      });
      expect(registry.getAssignment(assignmentId)?.leaseId).toBe(persistedLease);
      expect(registry.listEvents(taskId)).toHaveLength(eventCount);
    } finally {
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers a zero-source slice from its clean worktree and ignores missing or misleading metadata', () => {
    const registry = makeRegistry();
    const taskId = 'zero-source-worktree-recovery';
    const assignmentId = `${taskId}-implementer`;
    const owner = identity('deck_zero_source_worker');
    const fromRevision = 'stale-projection-r0';
    const toRevision = 'macos-dual-arch-qualification-cx1-r1-86639573';
    const evidenceManifestSha256 = '8'.repeat(64);
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'integration_slice',
      objective: 'qualify exact bytes without changing source', currentRevision: fromRevision,
    })).toMatchObject({ ok: true });
    expect(registry.createAssignment({
      assignmentId, taskId, role: 'implementer', identity: owner,
      scopeFiles: [], auditRevision: fromRevision,
    })).toMatchObject({ ok: true });
    expect(registry.updateTask({ taskId, status: 'delegated' })).toMatchObject({ ok: true });
    expect(registry.updateTask({ taskId, status: 'implementing' })).toMatchObject({ ok: true });
    expect(registry.updateAssignment({
      assignmentId, identity: owner, status: 'implementing', revision: fromRevision,
      auditRevision: fromRevision,
    })).toMatchObject({ ok: true });
    // Historical/caller-reported metadata may be incomplete or simply stale;
    // it must not override the exact clean worktree observed below.
    expect(registry.recordFileEvent({
      assignmentId, identity: owner, path: 'stale/reported-but-unchanged.ts',
      operation: 'modify', idempotencyKey: 'stale-reference-only-event',
    })).toMatchObject({ ok: true });
    const snapshot = recoveryWorktreeSnapshot([], evidenceManifestSha256);
    const request = {
      taskId, assignmentId, fromRevision, toRevision, worktreeSnapshot: snapshot,
      leaseAction: 'preserve' as const, idempotencyKey: 'zero-source-bind-r1',
      evidenceManifestSha256, reason: 'bind the exact clean qualification worktree',
    };
    expect(registry.rebindTaskAssignmentRevision(request)).toMatchObject({
      ok: true, value: { currentRevision: toRevision, status: 'implementing' },
    });
    const events = registry.listEvents(taskId).length;
    expect(registry.rebindTaskAssignmentRevision({
      ...request,
      ownedFiles: ['fabricated/not-in-worktree.ts'],
      scopeFiles: ['stale/metadata-only.ts'],
      evidenceManifestSha256: 'stale metadata is not authority',
    })).toMatchObject({ ok: true, replay: true });
    expect(registry.listEvents(taskId)).toHaveLength(events);
    registry.close();
  });

  it('rejects staged or conflicted worktree recovery before mutation', () => {
    for (const [name, override] of [
      ['staged', { stagedPaths: ['src/a.ts'] }],
      ['conflicted', { conflictedPaths: ['src/a.ts'] }],
    ] as const) {
      const registry = makeRegistry();
      const shape = prepareSameObjectRevisionRecoveryShape(registry, `worktree-${name}`);
      const before = registry.get(shape.taskId);
      const eventCount = registry.listEvents(shape.taskId).length;
      const snapshot = {
        ...recoveryWorktreeSnapshot(shape.files, shape.evidenceManifestSha256), ...override,
      };
      expect(registry.rebindTaskAssignmentRevision({
        taskId: shape.taskId, assignmentId: shape.implementer.assignmentId,
        fromRevision: shape.fromRevision, toRevision: shape.toRevision,
        worktreeSnapshot: snapshot,
        leaseAction: 'preserve', idempotencyKey: `unsafe-${name}`,
        evidenceManifestSha256: shape.evidenceManifestSha256, reason: 'must fail closed',
      }), name).toEqual({ ok: false, reason: 'manifest_mismatch' });
      expect(registry.get(shape.taskId)).toEqual(before);
      expect(registry.listEvents(shape.taskId)).toHaveLength(eventCount);
      registry.close();
    }
  });

  it('lets Brain atomically repair a misprojected REWORK owner and preserves audit history across restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-brain-coordination-recovery-'));
    const dbPath = join(dir, 'supervision-state.sqlite');
    const taskId = 'brain-coordination-recovery';
    const revision = 'brain-coordination-r1';
    const attemptId = 'brain-coordination-audit-r1';
    const coordinatorIdentity = identity('deck_brain_coordination_brain');
    const implementerIdentity = identity('deck_brain_coordination_worker');
    const reboundIdentity = {
      ...implementerIdentity,
      sessionInstanceId: 'instance-deck_brain_coordination_worker-restarted',
      runtimeEpoch: 'epoch-deck_brain_coordination_worker-restarted',
    };
    const auditorIdentity = identity('deck_brain_coordination_auditor', 'claude-code-sdk');
    let registry = new SupervisionTaskRegistry({ dbPath });
    try {
      expect(registry.createOrGet({
        taskId, projectName: 'alpha', classification: 'independent_top_level',
        objective: 'repair a wedged coordination projection', currentRevision: revision,
      })).toMatchObject({ ok: true });
      const coordinator = registry.createAssignment({
        assignmentId: `${taskId}-coordinator`, taskId, role: 'coordinator', identity: coordinatorIdentity,
        scopeFiles: ['src/brain.ts'],
      });
      const implementer = registry.createAssignment({
        assignmentId: `${taskId}-implementer`, taskId, role: 'implementer', identity: implementerIdentity,
        scopeFiles: ['src/one.ts'], auditAttemptId: attemptId, auditRevision: revision,
      });
      const auditor = registry.createAssignment({
        assignmentId: `${taskId}-auditor`, taskId, role: 'auditor', identity: auditorIdentity,
        required: false, auditAttemptId: attemptId, auditRevision: revision,
      });
      if (!coordinator.ok || !implementer.ok || !auditor.ok) throw new Error('coordination fixture creation failed');

      for (const status of ['implementing', 'validated'] as const) {
        expect(registry.updateAssignment({
          assignmentId: implementer.value.assignmentId, identity: implementerIdentity, status,
          revision, auditAttemptId: attemptId, auditRevision: revision,
        })).toMatchObject({ ok: true });
      }
      expect(registry.updateTask({ taskId, status: 'implementing' })).toMatchObject({ ok: true });
      expect(registry.updateTask({ taskId, status: 'validated' })).toMatchObject({ ok: true });
      expect(registry.updateTask({ taskId, status: 'ready_for_audit' })).toMatchObject({ ok: true });
      expect(registry.appendMatchingAuditReceipt({
        taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId, revision,
        receiptKind: 'final', verdict: 'REWORK', auditorSessionName: auditorIdentity.sessionName,
        auditorIdentity, findings: 'mapper provenance missing', validations: [], now: 80,
      })).toMatchObject({ ok: true, value: { verdict: 'REWORK' } });
      for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing', 'rework'] as const) {
        expect(registry.updateAssignment({
          assignmentId: coordinator.value.assignmentId, identity: coordinatorIdentity, status,
        }), status).toMatchObject({ ok: true });
      }
      expect(registry.getTaskRecord(taskId)).toMatchObject({ status: 'ready_for_audit', currentRevision: revision });
      expect(registry.getAssignment(coordinator.value.assignmentId)).toMatchObject({ status: 'rework' });
      expect(registry.getAssignment(implementer.value.assignmentId)).toMatchObject({
        status: 'validated', auditAttemptId: attemptId, auditRevision: revision,
      });

      const request = {
        taskId, assignmentId: implementer.value.assignmentId,
        taskStatus: 'rework' as const, assignmentStatus: 'rework' as const,
        scopeFiles: ['src/one.ts', 'src/two.ts'], leaseAction: 'clear' as const,
        identity: reboundIdentity,
        idempotencyKey: 'brain-repair-rework-owner-r1',
        reason: 'move REWORK from coordinator to the original implementer', now: 100,
      };
      const receiptsBefore = registry.listAuditReceipts(taskId);
      const assignmentCount = registry.listAssignments(taskId).length;
      const eventCount = registry.listEvents(taskId).length;
      expect(registry.coordinateTaskAssignment(request)).toMatchObject({
        ok: true, value: { status: 'rework', currentRevision: revision },
      });
      expect(registry.getAssignment(implementer.value.assignmentId)).toMatchObject({
        identity: reboundIdentity, status: 'rework', scopeFiles: ['src/one.ts', 'src/two.ts'],
        leaseId: '', generation: 2, blocker: request.reason,
      });
      expect(registry.getAssignment(implementer.value.assignmentId)).not.toHaveProperty('auditAttemptId');
      expect(registry.getAssignment(implementer.value.assignmentId)).not.toHaveProperty('auditRevision');
      expect(registry.getAssignment(implementer.value.assignmentId)).not.toHaveProperty('verdict');
      expect(registry.getAssignment(coordinator.value.assignmentId)).toMatchObject({
        status: 'rework', identity: coordinatorIdentity,
      });
      expect(registry.getAssignment(auditor.value.assignmentId)).toMatchObject({
        status: 'auditing', auditAttemptId: attemptId, auditRevision: revision, verdict: 'REWORK',
      });
      expect(registry.listAssignments(taskId)).toHaveLength(assignmentCount);
      expect(registry.listAuditReceipts(taskId)).toEqual(receiptsBefore);
      expect(registry.listEvents(taskId).slice(eventCount)).toEqual([
        expect.objectContaining({
          assignmentId: implementer.value.assignmentId, eventType: 'recovered', status: 'rework',
          payload: expect.objectContaining({
            source: 'brain_coordination_override', idempotencyKey: request.idempotencyKey,
            priorTaskStatus: 'ready_for_audit', priorAssignmentStatus: 'validated',
            preservedRevision: revision, identity: reboundIdentity, priorIdentity: implementerIdentity,
          }),
        }),
        expect.objectContaining({
          eventType: 'recovered', status: 'rework',
          payload: expect.objectContaining({ assignmentId: implementer.value.assignmentId }),
        }),
      ]);
      expect(registry.listEvents(taskId).slice(eventCount)[1]).not.toHaveProperty('assignmentId');

      registry.close();
      registry = new SupervisionTaskRegistry({ dbPath });
      const persisted = registry.get(taskId);
      const persistedEventCount = registry.listEvents(taskId).length;
      expect(registry.coordinateTaskAssignment({ ...request, now: 200 })).toMatchObject({
        ok: true, replay: true, value: { status: 'rework', currentRevision: revision },
      });
      expect(registry.get(taskId)).toEqual(persisted);
      expect(registry.listEvents(taskId)).toHaveLength(persistedEventCount);
      expect(registry.listAuditReceipts(taskId)).toEqual(receiptsBefore);

      const beforeConflict = registry.get(taskId);
      expect(registry.coordinateTaskAssignment({
        ...request, identity: undefined, now: 250,
      })).toEqual({ ok: false, reason: 'conflicting_replay' });
      expect(registry.coordinateTaskAssignment({
        ...request, reason: 'different operation with reused key', now: 300,
      })).toEqual({ ok: false, reason: 'conflicting_replay' });
      expect(registry.get(taskId)).toEqual(beforeConflict);
      expect(registry.listEvents(taskId)).toHaveLength(persistedEventCount);
    } finally {
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps Brain coordination recovery fail-closed for auditors, success targets, and concrete finalization evidence', () => {
    const registry = makeRegistry();
    const taskId = 'brain-coordination-refusals';
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'independent_top_level',
      objective: 'prove recovery refusal is side-effect free', currentRevision: 'r1',
    })).toMatchObject({ ok: true });
    const implementer = registry.createAssignment({
      assignmentId: `${taskId}-implementer`, taskId, role: 'implementer',
      identity: identity('deck_coordination_refusal_worker'), scopeFiles: ['src/one.ts'],
    });
    const auditor = registry.createAssignment({
      assignmentId: `${taskId}-auditor`, taskId, role: 'auditor', required: false,
      identity: identity('deck_coordination_refusal_auditor'),
      auditAttemptId: 'attempt-r1', auditRevision: 'r1',
    });
    if (!implementer.ok || !auditor.ok) throw new Error('coordination refusal fixture failed');
    const assertNoMutation = (operation: () => unknown, expected: unknown) => {
      const before = registry.get(taskId);
      const events = registry.listEvents(taskId).length;
      expect(operation()).toEqual(expected);
      expect(registry.get(taskId)).toEqual(before);
      expect(registry.listEvents(taskId)).toHaveLength(events);
    };
    assertNoMutation(() => registry.coordinateTaskAssignment({
      taskId, assignmentId: auditor.value.assignmentId, assignmentStatus: 'rework',
      leaseAction: 'preserve',
      idempotencyKey: 'auditor-status-refused', reason: 'must not rewrite an auditor',
    }), { ok: false, reason: 'role_forbidden' });
    assertNoMutation(() => registry.coordinateTaskAssignment({
      taskId, assignmentId: implementer.value.assignmentId,
      assignmentStatus: 'passed' as never,
      leaseAction: 'preserve',
      idempotencyKey: 'success-target-refused', reason: 'must not invent PASS',
    }), { ok: false, reason: 'invalid' });

    expect(registry.updateTask({ taskId, commitSha: 'a'.repeat(40) })).toMatchObject({ ok: true });
    const closed = registry.get(taskId);
    const closedEvents = registry.listEvents(taskId).length;
    expect(registry.coordinateTaskAssignment({
      taskId, assignmentId: implementer.value.assignmentId,
      taskStatus: 'rework', assignmentStatus: 'rework',
      leaseAction: 'preserve',
      idempotencyKey: 'finalization-evidence-refused', reason: 'must preserve commit evidence',
    })).toEqual({ ok: false, reason: 'receipt_closed' });
    expect(registry.get(taskId)).toEqual(closed);
    expect(registry.listEvents(taskId)).toHaveLength(closedEvents);
    registry.close();
  });

  it('records scope-only provenance without changing an existing matching PASS', () => {
    const registry = makeRegistry();
    const taskId = 'brain-coordination-scope-after-pass';
    const revision = 'scope-after-pass-r1';
    const attemptId = 'scope-after-pass-audit-r1';
    const workerIdentity = identity('deck_scope_after_pass_worker');
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'independent_top_level',
      objective: 'keep PASS bound to revision rather than path metadata', currentRevision: revision,
    })).toMatchObject({ ok: true });
    const worker = registry.createAssignment({
      assignmentId: `${taskId}-implementer`, taskId, role: 'implementer', identity: workerIdentity,
      scopeFiles: ['src/audited.ts'], auditAttemptId: attemptId, auditRevision: revision,
    });
    if (!worker.ok) throw new Error('scope-after-PASS fixture creation failed');
    for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing'] as const) {
      expect(registry.updateAssignment({
        assignmentId: worker.value.assignmentId, identity: workerIdentity, status,
        revision, auditAttemptId: attemptId, auditRevision: revision,
      }), status).toMatchObject({ ok: true });
    }
    expect(registry.updateAssignment({
      assignmentId: worker.value.assignmentId, identity: workerIdentity,
      status: 'passed', revision, auditAttemptId: attemptId, auditRevision: revision,
      verdict: 'PASS', primaryReviewPassed: true, crossVendorAuditPassed: true,
    })).toMatchObject({ ok: true });
    expect(registry.updateAssignment({
      assignmentId: worker.value.assignmentId, identity: workerIdentity,
      status: 'ready_for_integration', revision, auditAttemptId: attemptId, auditRevision: revision,
      verdict: 'PASS', primaryReviewPassed: true, crossVendorAuditPassed: true,
    })).toMatchObject({ ok: true });

    const eventCount = registry.listEvents(taskId).length;
    expect(registry.coordinateTaskAssignment({
      taskId, assignmentId: worker.value.assignmentId,
      scopeFiles: ['src/audited.ts', 'src/unaudited.ts'],
      leaseAction: 'preserve',
      idempotencyKey: 'scope-only-after-pass-recorded',
      reason: 'record a newly observed path without changing authority',
    })).toMatchObject({ ok: true });
    expect(registry.getAssignment(worker.value.assignmentId)).toMatchObject({
      status: 'ready_for_integration', scopeFiles: ['src/audited.ts', 'src/unaudited.ts'],
      auditAttemptId: attemptId, auditRevision: revision, verdict: 'PASS',
      primaryReviewPassed: true, crossVendorAuditPassed: true,
    });
    expect(registry.getAssignment(worker.value.assignmentId)?.blocker).toBeUndefined();
    expect(registry.getTaskRecord(taskId)).toMatchObject({ currentRevision: revision });
    expect(registry.listEvents(taskId)).toHaveLength(eventCount + 1);
    registry.close();
  });

  it('records scope-only provenance without clearing validation or pre-PASS audit identity', () => {
    for (const status of ['validated', 'ready_for_audit', 'auditing'] as const) {
      const registry = makeRegistry();
      const taskId = `brain-coordination-scope-${status}`;
      const revision = `scope-${status}-r1`;
      const attemptId = `scope-${status}-audit-r1`;
      const workerIdentity = identity(`deck_scope_${status}_worker`);
      expect(registry.createOrGet({
        taskId, projectName: 'alpha', classification: 'independent_top_level',
        objective: 'keep validation and audit provenance bound to revision', currentRevision: revision,
      })).toMatchObject({ ok: true });
      const worker = registry.createAssignment({
        assignmentId: `${taskId}-implementer`, taskId, role: 'implementer', identity: workerIdentity,
        scopeFiles: ['src/audited.ts'], auditAttemptId: attemptId, auditRevision: revision,
      });
      if (!worker.ok) throw new Error('pre-PASS scope fixture creation failed');
      const path = ['implementing', 'validated', 'ready_for_audit', 'auditing'] as const;
      for (const nextStatus of path.slice(0, path.indexOf(status) + 1)) {
        expect(registry.updateAssignment({
          assignmentId: worker.value.assignmentId, identity: workerIdentity, status: nextStatus,
          revision, auditAttemptId: attemptId, auditRevision: revision,
        }), `${status}:${nextStatus}`).toMatchObject({ ok: true });
      }

      const eventCount = registry.listEvents(taskId).length;
      expect(registry.coordinateTaskAssignment({
        taskId, assignmentId: worker.value.assignmentId,
        scopeFiles: ['src/audited.ts', 'src/unaudited.ts'],
        leaseAction: 'preserve',
        idempotencyKey: `scope-only-${status}-recorded`,
        reason: 'record a newly observed path without changing authority',
      }), status).toMatchObject({ ok: true });
      expect(registry.getAssignment(worker.value.assignmentId)).toMatchObject({
        status, scopeFiles: ['src/audited.ts', 'src/unaudited.ts'],
        auditAttemptId: attemptId, auditRevision: revision,
      });
      expect(registry.getAssignment(worker.value.assignmentId)?.blocker).toBeUndefined();
      expect(registry.listEvents(taskId)).toHaveLength(eventCount + 1);
      registry.close();
    }
  });

  it('fails closed on ambiguous, active-audit, PASS, lifecycle, scope, and evidence revision recovery shapes', () => {
    const cases = [
      { taskId: 'revision-recovery-ambiguous', options: { addAmbiguousImplementer: true }, expected: 'ambiguous_assignment' },
      { taskId: 'revision-recovery-active-auditor', options: { keepAuditorActive: true }, expected: 'invalid_transition' },
    ] as const;
    for (const testCase of cases) {
      const registry = makeRegistry();
      const shape = prepareSameObjectRevisionRecoveryShape(registry, testCase.taskId, testCase.options);
      const before = registry.get(shape.taskId);
      const eventCount = registry.listEvents(shape.taskId).length;
      expect(registry.rebindTaskAssignmentRevision({
        taskId: shape.taskId, assignmentId: shape.implementer.assignmentId,
        fromRevision: shape.fromRevision, toRevision: shape.toRevision,
        ownedFiles: shape.files, evidenceManifestSha256: shape.evidenceManifestSha256,
        worktreeSnapshot: recoveryWorktreeSnapshot(shape.files, shape.evidenceManifestSha256),
        leaseAction: 'preserve', idempotencyKey: `${testCase.taskId}-refusal`,
        reason: 'must fail closed',
      })).toEqual({ ok: false, reason: testCase.expected });
      expect(registry.get(shape.taskId)).toEqual(before);
      expect(registry.listEvents(shape.taskId)).toHaveLength(eventCount);
      registry.close();
    }

    const scopeRegistry = makeRegistry();
    const scope = prepareSameObjectRevisionRecoveryShape(scopeRegistry, 'revision-recovery-scope');
    expect(scopeRegistry.rebindTaskAssignmentRevision({
      taskId: scope.taskId, assignmentId: scope.implementer.assignmentId,
      fromRevision: scope.fromRevision, toRevision: scope.toRevision,
      ownedFiles: [scope.files[0]!], evidenceManifestSha256: scope.evidenceManifestSha256,
      worktreeSnapshot: recoveryWorktreeSnapshot(scope.files, scope.evidenceManifestSha256),
      leaseAction: 'preserve', idempotencyKey: 'scope-owned-mismatch',
      reason: 'scope mismatch',
    })).toMatchObject({ ok: true, value: { currentRevision: scope.toRevision } });
    expect(scopeRegistry.rebindTaskAssignmentRevision({
      taskId: scope.taskId, assignmentId: scope.implementer.assignmentId,
      fromRevision: scope.fromRevision, toRevision: scope.toRevision,
      ownedFiles: scope.files, leaseAction: 'preserve', idempotencyKey: 'scope-owned-mismatch',
      evidenceManifestSha256: '', reason: 'empty evidence',
      worktreeSnapshot: recoveryWorktreeSnapshot(scope.files, scope.evidenceManifestSha256),
    })).toMatchObject({ ok: true, replay: true });
    scopeRegistry.close();

    const lifecycleRegistry = makeRegistry();
    const lifecycle = prepareSameObjectRevisionRecoveryShape(lifecycleRegistry, 'revision-recovery-lifecycle');
    for (const status of [
      'validated', 'ready_for_audit', 'auditing', 'passed', 'ready_for_integration',
      'integrating', 'final_audit', 'finalizing', 'committed',
    ] as const) {
      expect(lifecycleRegistry.updateTask({ taskId: lifecycle.taskId, status }), status)
        .toMatchObject({ ok: true });
    }
    expect(lifecycleRegistry.rebindTaskAssignmentRevision({
      taskId: lifecycle.taskId, assignmentId: lifecycle.implementer.assignmentId,
      fromRevision: lifecycle.fromRevision, toRevision: lifecycle.toRevision,
      ownedFiles: lifecycle.files, evidenceManifestSha256: lifecycle.evidenceManifestSha256,
      worktreeSnapshot: recoveryWorktreeSnapshot(lifecycle.files, lifecycle.evidenceManifestSha256),
      leaseAction: 'preserve', idempotencyKey: 'lifecycle-refusal',
      reason: 'illegal lifecycle',
    })).toEqual({ ok: false, reason: 'invalid_transition' });
    lifecycleRegistry.close();

    const passDb = new DatabaseSync(':memory:');
    const passRegistry = new SupervisionTaskRegistry({ database: passDb });
    const pass = prepareSameObjectRevisionRecoveryShape(passRegistry, 'revision-recovery-pass-conflict');
    passDb.prepare(`INSERT INTO supervision_audit_attestations
      (attempt_id, task_id, assignment_id, revision, verdict, auditor_session_name, findings, created_at)
      VALUES (?, ?, ?, ?, 'PASS', 'deck_pass_auditor', 'conflicting PASS', 70)`)
      .run('revision-recovery-pass-attempt', pass.taskId, pass.implementer.assignmentId, pass.toRevision);
    const passEvents = passRegistry.listEvents(pass.taskId).length;
    expect(passRegistry.rebindTaskAssignmentRevision({
      taskId: pass.taskId, assignmentId: pass.implementer.assignmentId,
      fromRevision: pass.fromRevision, toRevision: pass.toRevision,
      ownedFiles: pass.files, evidenceManifestSha256: pass.evidenceManifestSha256,
      worktreeSnapshot: recoveryWorktreeSnapshot(pass.files, pass.evidenceManifestSha256),
      leaseAction: 'preserve', idempotencyKey: 'pass-conflict-refusal',
      reason: 'PASS conflict',
    })).toEqual({ ok: false, reason: 'invalid_transition' });
    expect(passRegistry.listEvents(pass.taskId)).toHaveLength(passEvents);
    passRegistry.close();
    passDb.close();
  });

  it('persists tokenless append-only audit receipts across restart and gates integration on auditor FINISHED', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-audit-receipts-'));
    const dbPath = join(dir, 'supervision-state.sqlite');
    const taskId = 'tokenless-audit-task';
    const revision = 'tokenless-audit-r1';
    const attemptId = 'tokenless-audit-attempt-1';
    const implementerIdentity = identity('deck_tokenless_worker');
    const auditorIdentity = identity('deck_tokenless_auditor');
    const reboundAuditorIdentity = {
      ...auditorIdentity, sessionInstanceId: 'instance-rebound-auditor', runtimeEpoch: 'epoch-rebound-auditor',
    };
    try {
      let registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.createOrGet({
        taskId, projectName: 'alpha', classification: 'integration_task',
        objective: 'append-only audit receipt', currentRevision: revision,
      }).ok).toBe(true);
      const implementer = registry.createAssignment({
        assignmentId: 'tokenless-implementer', taskId, role: 'implementer', identity: implementerIdentity,
      });
      const auditor = registry.createAssignment({
        assignmentId: 'tokenless-auditor', taskId, role: 'auditor', identity: auditorIdentity,
        auditAttemptId: attemptId, auditRevision: revision,
      });
      if (!implementer.ok || !auditor.ok) throw new Error('expected tokenless audit assignments');
      for (const status of ['implementing', 'validated', 'ready_for_audit'] as const) {
        expect(registry.updateAssignment({
          assignmentId: implementer.value.assignmentId, identity: implementerIdentity, status,
        }).ok).toBe(true);
      }

      const progress = registry.appendMatchingAuditReceipt({
        taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId, revision,
        receiptKind: 'progress', auditorSessionName: auditorIdentity.sessionName,
        auditorIdentity, findings: 'review in progress', validations: [], now: 100,
      });
      expect(progress).toMatchObject({ ok: true, value: { sequence: 1, receiptKind: 'progress' } });
      expect(registry.getAssignment(implementer.value.assignmentId)?.status).toBe('ready_for_audit');
      expect(registry.getAssignment(auditor.value.assignmentId)?.status).toBe('auditing');
      registry.close();

      registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.listAuditReceipts(taskId)).toEqual([
        expect.objectContaining({ sequence: 1, receiptKind: 'progress', findings: 'review in progress' }),
      ]);
      expect(registry.rebindAuditAssignment({
        taskId, assignmentId: auditor.value.assignmentId, identity: reboundAuditorIdentity,
        reason: 'Brain-authorized device replacement', now: 105,
      })).toMatchObject({ ok: true, value: { identity: reboundAuditorIdentity, generation: 2 } });
      expect(registry.appendMatchingAuditReceipt({
        taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId, revision,
        receiptKind: 'progress', auditorSessionName: auditorIdentity.sessionName,
        auditorIdentity, findings: 'stale device', validations: [], now: 106,
      })).toEqual({ ok: false, reason: 'owner_mismatch' });
      expect(registry.appendMatchingAuditReceipt({
        taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId, revision,
        receiptKind: 'progress', auditorSessionName: reboundAuditorIdentity.sessionName,
        auditorIdentity: reboundAuditorIdentity, findings: 'second progress', validations: [], now: 110,
      })).toMatchObject({ ok: true, value: { sequence: 2 } });
      expect(registry.appendMatchingAuditReceipt({
        taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId: 'wrong-attempt', revision,
        receiptKind: 'final', verdict: 'PASS', auditorSessionName: reboundAuditorIdentity.sessionName,
        auditorIdentity: reboundAuditorIdentity, findings: 'wrong attempt', validations: [], now: 111,
      })).toEqual({ ok: false, reason: 'old_audit_attempt' });
      expect(registry.appendMatchingAuditReceipt({
        taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId, revision,
        receiptKind: 'final', verdict: 'PASS', auditorSessionName: auditorIdentity.sessionName,
        auditorIdentity: { ...reboundAuditorIdentity, runtimeEpoch: 'wrong-epoch' },
        findings: 'wrong identity', validations: [], now: 112,
      })).toEqual({ ok: false, reason: 'owner_mismatch' });
      expect(registry.listAuditReceipts(taskId)).toHaveLength(2);

      const pass = registry.appendMatchingAuditReceipt({
        taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId, revision,
        receiptKind: 'final', verdict: 'PASS', auditorSessionName: reboundAuditorIdentity.sessionName,
        auditorIdentity: reboundAuditorIdentity, findings: 'pass before correction',
        validations: [{ kind: 'test', label: 'focused', outcome: 'passed', summary: '1 passed' }], now: 120,
      });
      expect(pass).toMatchObject({ ok: true, value: { sequence: 3, verdict: 'PASS' } });
      expect(registry.getAssignment(implementer.value.assignmentId)?.status).toBe('ready_for_audit');
      const corrected = registry.appendMatchingAuditReceipt({
        taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId, revision,
        receiptKind: 'final', verdict: 'REWORK', auditorSessionName: reboundAuditorIdentity.sessionName,
        auditorIdentity: reboundAuditorIdentity, findings: 'correction before finish', validations: [], now: 130,
      });
      expect(corrected).toMatchObject({
        ok: true,
        value: { sequence: 4, verdict: 'REWORK', supersedesReceiptId: pass.ok ? pass.value.receiptId : undefined },
      });
      expect(registry.appendMatchingAuditReceipt({
        taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId, revision,
        receiptKind: 'final', verdict: 'REWORK', auditorSessionName: reboundAuditorIdentity.sessionName,
        auditorIdentity: reboundAuditorIdentity, findings: 'correction before finish', validations: [], now: 131,
      })).toMatchObject({ ok: true, replay: true, value: { sequence: 4 } });

      expect(registry.finishAssignment({
        assignmentId: auditor.value.assignmentId, identity: reboundAuditorIdentity, revision,
      })).toMatchObject({ ok: true, value: { status: 'finalized', leaseId: '' } });
      expect(registry.getAssignment(implementer.value.assignmentId)).toMatchObject({
        status: 'rework', auditAttemptId: attemptId, auditRevision: revision,
        verdict: 'REWORK', blocker: 'correction before finish',
      });
      expect(registry.getAssignment(implementer.value.assignmentId)).not.toHaveProperty('crossVendorAuditPassed');
      expect(registry.appendMatchingAuditReceipt({
        taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId, revision,
        receiptKind: 'final', verdict: 'PASS', auditorSessionName: reboundAuditorIdentity.sessionName,
        auditorIdentity: reboundAuditorIdentity, findings: 'conflict after finish', validations: [], now: 140,
      })).toEqual({ ok: false, reason: 'receipt_closed' });
      expect(registry.listAuditReceipts(taskId)).toHaveLength(4);
      registry.close();

      registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.listAuditReceipts(taskId).map((receipt) => receipt.sequence)).toEqual([1, 2, 3, 4]);
      expect(registry.getAssignment(auditor.value.assignmentId)?.status).toBe('finalized');
      expect(registry.getAssignment(implementer.value.assignmentId)).toMatchObject({
        status: 'rework', auditAttemptId: attemptId, auditRevision: revision, verdict: 'REWORK',
      });
      expect(registry.getAssignment(implementer.value.assignmentId)).not.toHaveProperty('crossVendorAuditPassed');
      registry.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('atomically propagates receipted PASS authority to structured finalization and replays after reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-audit-finish-finalization-'));
    const dbPath = join(dir, 'supervision-state.sqlite');
    const taskId = 'audit-finish-structured-finalization';
    const revision = 'audit-finish-structured-r1';
    const attemptId = 'audit-finish-structured-attempt';
    const path = 'src/audited-production.ts';
    const ownerIdentity = identity('deck_audit_finish_structured_brain');
    const implementerIdentity = identity('deck_audit_finish_structured_worker');
    const auditorIdentity = identity('deck_audit_finish_structured_auditor', 'claude-code-sdk');
    const commitSha = 'a'.repeat(40);
    try {
      let registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.createOrGet({
        taskId, projectName: 'alpha', classification: 'integration_task',
        objective: 'carry accepted receipt authority into structured finalization', currentRevision: revision,
      })).toMatchObject({ ok: true });
      const owner = registry.createAssignment({
        assignmentId: `${taskId}-owner`, taskId, role: 'integration_owner', identity: ownerIdentity,
        scopeFiles: [path], auditAttemptId: attemptId, auditRevision: revision,
      });
      const implementer = registry.createAssignment({
        assignmentId: `${taskId}-implementer`, taskId, role: 'implementer', identity: implementerIdentity,
        scopeFiles: [path], auditRevision: revision,
      });
      const auditor = registry.createAssignment({
        assignmentId: `${taskId}-auditor`, taskId, role: 'auditor', identity: auditorIdentity,
        required: false, scopeFiles: [path], auditAttemptId: attemptId, auditRevision: revision,
      });
      if (!owner.ok || !implementer.ok || !auditor.ok) throw new Error('expected finalization assignments');
      expect(registry.recordFileEvent({
        assignmentId: implementer.value.assignmentId, identity: implementerIdentity,
        path, operation: 'modify', idempotencyKey: `${taskId}-file`,
      })).toMatchObject({ ok: true });
      for (const status of [
        'implementing', 'validated', 'ready_for_audit', 'auditing', 'passed', 'ready_for_integration',
      ] as const) {
        expect(registry.updateAssignment({
          assignmentId: owner.value.assignmentId, identity: ownerIdentity, status,
          revision, auditAttemptId: attemptId, auditRevision: revision,
          ...(status === 'passed' || status === 'ready_for_integration'
            ? { verdict: 'PASS', crossVendorAuditPassed: true }
            : {}),
          externalRunId: '33287386936', externalHeadSha: commitSha, externalTaskId: 'ci-node24',
        }), `owner:${status}`).toMatchObject({ ok: true });
      }
      for (const status of ['implementing', 'validated', 'ready_for_audit'] as const) {
        expect(registry.updateAssignment({
          assignmentId: implementer.value.assignmentId, identity: implementerIdentity, status,
        }), `implementer:${status}`).toMatchObject({ ok: true });
      }
      expect(registry.getAssignment(implementer.value.assignmentId)).toMatchObject({
        status: 'ready_for_audit', auditRevision: revision,
      });
      expect(registry.getAssignment(implementer.value.assignmentId)?.auditAttemptId).toBeUndefined();
      expect(registry.appendMatchingAuditReceipt({
        taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId, revision,
        receiptKind: 'final', verdict: 'PASS', auditorSessionName: auditorIdentity.sessionName,
        auditorIdentity, findings: 'exact matching PASS',
        validations: [{ kind: 'test', label: 'focused', outcome: 'passed', summary: 'passed' }], now: 100,
      })).toMatchObject({ ok: true, value: { verdict: 'PASS' } });

      expect(registry.finishAssignment({
        assignmentId: auditor.value.assignmentId, identity: auditorIdentity, revision, now: 110,
      })).toMatchObject({ ok: true, value: { status: 'finalized', leaseId: '' } });
      expect(registry.getAssignment(implementer.value.assignmentId)).toMatchObject({
        status: 'ready_for_integration', auditAttemptId: attemptId, auditRevision: revision,
        verdict: 'PASS', crossVendorAuditPassed: true,
      });
      expect(registry.get(taskId)).toMatchObject({ status: 'ready_for_integration' });

      const finalization = {
        assignmentId: owner.value.assignmentId,
        identity: ownerIdentity,
        revision,
        auditAttemptId: attemptId,
        auditRevision: revision,
        verdict: 'PASS' as const,
        ownedFiles: [path],
        integrationManifest: [{ path, sha256: '1'.repeat(64) }],
        integrationOwner: ownerIdentity.sessionName,
        commitSha,
        pushResult: 'pushed' as const,
        pushRemoteRef: 'refs/heads/dev',
        stagedPaths: [path],
        conflictedPaths: [] as string[],
        untrackedOtherOwnerPaths: [] as string[],
        externalRunId: '33287386936',
        externalHeadSha: commitSha,
        externalTaskId: 'ci-node24',
        ciResult: 'success' as const,
        now: 120,
      };
      expect(registry.finalizeIntegration(finalization)).toMatchObject({
        ok: true,
        value: {
          status: 'finalized',
          finalization: { auditAttemptId: attemptId, auditRevision: revision, verdict: 'PASS' },
        },
      });
      const eventsAfterFinalization = registry.listEvents(taskId);
      const receiptsAfterFinalization = registry.listAuditReceipts(taskId);
      registry.close();

      registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.getAssignment(implementer.value.assignmentId)).toMatchObject({
        auditAttemptId: attemptId, auditRevision: revision, verdict: 'PASS', crossVendorAuditPassed: true,
      });
      expect(registry.finishAssignment({
        assignmentId: auditor.value.assignmentId, identity: auditorIdentity, revision, now: 130,
      })).toMatchObject({ ok: true, replay: true, value: { status: 'finalized', leaseId: '' } });
      expect(registry.finalizeIntegration({ ...finalization, now: 140 }))
        .toMatchObject({ ok: true, replay: true, value: { status: 'finalized' } });
      expect(registry.listEvents(taskId)).toEqual(eventsAfterFinalization);
      expect(registry.listAuditReceipts(taskId)).toEqual(receiptsAfterFinalization);
      registry.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['auditor', 'project Brain'] as const)(
    'repairs finalized-auditor PASS authority through exact %s replay and is idempotent after reopen',
    (caller) => {
      const dir = mkdtempSync(join(tmpdir(), 'imcodes-finalized-audit-authority-replay-'));
      const dbPath = join(dir, 'supervision-state.sqlite');
      const taskId = `finalized-audit-authority-${caller.replace(' ', '-')}`;
      try {
        let database = new DatabaseSync(dbPath);
        let registry = new SupervisionTaskRegistry({ database });
        const shape = prepareFinalizedAuditAuthorityReplayGap(registry, database, taskId);
        const assignmentCount = registry.get(taskId)?.assignments.length;
        const receiptsBefore = registry.listAuditReceipts(taskId);
        const eventsBefore = registry.listEvents(taskId);

        const repair = caller === 'auditor'
          ? registry.finishAssignment({
            assignmentId: shape.auditor.assignmentId,
            identity: shape.auditor.identity,
            revision: shape.revision,
            now: 120,
          })
          : registry.finishAssignmentAsProjectBrain({
            assignmentId: shape.auditor.assignmentId,
            callerProjectName: 'alpha',
            now: 120,
          });
        expect(repair).toMatchObject({
          ok: true, replay: true, value: { status: 'finalized', leaseId: '' },
        });
        expect(registry.getAssignment(shape.implementer.assignmentId)).toMatchObject({
          status: 'ready_for_integration',
          auditAttemptId: shape.attemptId,
          auditRevision: shape.revision,
          verdict: 'PASS',
          crossVendorAuditPassed: true,
        });
        expect(registry.get(taskId)?.assignments).toHaveLength(assignmentCount!);
        expect(registry.listAuditReceipts(taskId)).toEqual(receiptsBefore);
        const repairEvents = registry.listEvents(taskId).slice(eventsBefore.length);
        expect(repairEvents).toEqual([
          expect.objectContaining({
            assignmentId: shape.implementer.assignmentId,
            eventType: 'recovered',
            status: 'ready_for_integration',
            payload: expect.objectContaining({
              source: 'finalized_auditor_replay_audit_authority',
              auditorAssignmentId: shape.auditor.assignmentId,
              auditAttemptId: shape.attemptId,
              auditRevision: shape.revision,
              verdict: 'PASS',
            }),
          }),
        ]);
        const snapshotAfterRepair = registry.get(taskId);
        const eventsAfterRepair = registry.listEvents(taskId);
        registry.close();
        database.close();

        database = new DatabaseSync(dbPath);
        registry = new SupervisionTaskRegistry({ database });
        const replay = caller === 'auditor'
          ? registry.finishAssignment({
            assignmentId: shape.auditor.assignmentId,
            identity: shape.auditor.identity,
            revision: shape.revision,
            now: 130,
          })
          : registry.finishAssignmentAsProjectBrain({
            assignmentId: shape.auditor.assignmentId,
            callerProjectName: 'alpha',
            now: 130,
          });
        expect(replay).toMatchObject({ ok: true, replay: true });
        expect(registry.get(taskId)).toEqual(snapshotAfterRepair);
        expect(registry.listEvents(taskId)).toEqual(eventsAfterRepair);
        expect(registry.listAuditReceipts(taskId)).toEqual(receiptsBefore);

        if (caller === 'auditor') {
          expect(registry.finalizeIntegration({
            ...shape.finalization,
            identity: shape.owner.identity,
            now: 140,
          })).toMatchObject({
            ok: true,
            value: { status: 'finalized', finalization: { auditAttemptId: shape.attemptId } },
          });
        }
        registry.close();
        database.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { label: 'missing final receipt', mutate: 'missing-receipt', reason: 'old_audit_attempt' },
    { label: 'REWORK receipt', mutate: 'rework-receipt', reason: 'old_audit_attempt' },
    { label: 'stale attempt', mutate: 'stale-attempt', reason: 'old_audit_attempt' },
    { label: 'stale revision', mutate: 'stale-revision', reason: 'old_revision' },
    { label: 'stale verdict', mutate: 'stale-verdict', reason: 'old_audit_attempt' },
    { label: 'self audit', mutate: 'self-audit', reason: 'owner_mismatch' },
    { label: 'multiple candidates', mutate: 'ambiguous', reason: 'ambiguous_assignment' },
    { label: 'active implementer lease', mutate: 'active-lease', reason: 'invalid_transition' },
    { label: 'active implementer claim', mutate: 'active-claim', reason: 'invalid_transition' },
    { label: 'closed Git evidence', mutate: 'closed', reason: 'receipt_closed' },
    { label: 'closed integration-owner state', mutate: 'closed-owner', reason: 'receipt_closed' },
  ] as const)('refuses finalized-auditor authority repair for $label with zero mutation', ({ mutate, reason }) => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const taskId = `finalized-audit-authority-refusal-${mutate}`;
    const shape = prepareFinalizedAuditAuthorityReplayGap(registry, database, taskId, {
      ...(mutate === 'missing-receipt' ? { omitReceipt: true } : {}),
      ...(mutate === 'rework-receipt' ? { receiptVerdict: 'REWORK' as const } : {}),
    });
    const implementer = registry.getAssignment(shape.implementer.assignmentId)!;
    if (mutate === 'stale-attempt') {
      rewritePersistedAssignment(database, { ...implementer, auditAttemptId: 'stale-attempt' });
    } else if (mutate === 'stale-revision') {
      rewritePersistedAssignment(database, { ...implementer, auditRevision: 'stale-revision' });
    } else if (mutate === 'stale-verdict') {
      rewritePersistedAssignment(database, { ...implementer, verdict: 'REWORK' });
    } else if (mutate === 'self-audit') {
      rewritePersistedAssignment(database, { ...implementer, identity: shape.auditor.identity });
    } else if (mutate === 'ambiguous') {
      const second = registry.createAssignment({
        assignmentId: `${taskId}-second-implementer`, taskId, role: 'implementer',
        identity: identity(`${taskId}-second-worker`), auditRevision: shape.revision,
      });
      if (!second.ok) throw new Error(second.reason);
      rewritePersistedAssignment(database, {
        ...second.value,
        status: 'ready_for_integration',
        verdict: 'PASS',
        updatedAt: 111,
      });
    } else if (mutate === 'active-lease') {
      rewritePersistedAssignment(database, {
        ...implementer,
        leaseId: 'supervision_lease_still_writing',
        updatedAt: 111,
      });
    } else if (mutate === 'active-claim') {
      database.prepare(`
        INSERT INTO supervision_task_file_claims
          (task_id, assignment_id, file_path, claim_mode, created_at)
        VALUES (?, ?, ?, 'exclusive', ?)
      `).run(taskId, implementer.assignmentId, shape.files[0], 111);
    } else if (mutate === 'closed') {
      expect(registry.updateTask({ taskId, commitSha: 'b'.repeat(40), now: 111 })).toMatchObject({ ok: true });
    } else if (mutate === 'closed-owner') {
      rewritePersistedAssignment(database, {
        ...registry.getAssignment(shape.owner.assignmentId)!,
        status: 'committed',
        updatedAt: 111,
      });
    }

    const before = registry.get(taskId);
    const eventsBefore = registry.listEvents(taskId);
    const receiptsBefore = registry.listAuditReceipts(taskId);
    expect(registry.finishAssignment({
      assignmentId: shape.auditor.assignmentId,
      identity: shape.auditor.identity,
      revision: shape.revision,
      now: 120,
    })).toEqual({ ok: false, reason });
    expect(registry.get(taskId)).toEqual(before);
    expect(registry.listEvents(taskId)).toEqual(eventsBefore);
    expect(registry.listAuditReceipts(taskId)).toEqual(receiptsBefore);
    registry.close();
    database.close();
  });

  it('finishes a receipted auditor against the sole revision-only pending implementer without targeting the coordinator', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-audit-finish-target-'));
    const dbPath = join(dir, 'supervision-state.sqlite');
    const taskId = 'audit-finish-production-shape';
    const revision = 'audit-finish-r1';
    const attemptId = 'audit-finish-attempt-1';
    const coordinatorIdentity = identity('deck_audit_finish_brain');
    const implementerIdentity = identity('deck_audit_finish_worker');
    const auditorIdentity = identity('deck_audit_finish_auditor');
    try {
      let registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.createOrGet({
        taskId, projectName: 'alpha', classification: 'integration_task',
        objective: 'finish exact audited implementer', currentRevision: revision,
      })).toMatchObject({ ok: true });
      const coordinator = registry.createAssignment({
        assignmentId: 'audit-finish-coordinator', taskId, role: 'coordinator', identity: coordinatorIdentity,
        auditAttemptId: attemptId, auditRevision: revision,
      });
      const implementer = registry.createAssignment({
        assignmentId: 'audit-finish-implementer', taskId, role: 'implementer', identity: implementerIdentity,
        auditRevision: revision,
      });
      const auditor = registry.createAssignment({
        assignmentId: 'audit-finish-auditor', taskId, role: 'auditor', identity: auditorIdentity,
        auditAttemptId: attemptId, auditRevision: revision,
      });
      if (!coordinator.ok || !implementer.ok || !auditor.ok) throw new Error('expected production assignments');
      for (const status of ['implementing', 'validated', 'ready_for_audit'] as const) {
        expect(registry.updateAssignment({
          assignmentId: implementer.value.assignmentId, identity: implementerIdentity, status,
        })).toMatchObject({ ok: true });
      }
      expect(registry.appendMatchingAuditReceipt({
        taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId, revision,
        receiptKind: 'final', verdict: 'REWORK', auditorSessionName: auditorIdentity.sessionName,
        auditorIdentity, findings: 'production-shaped correction', validations: [], now: 100,
      })).toMatchObject({ ok: true, value: { sequence: 1, verdict: 'REWORK' } });
      expect(registry.getAssignment(implementer.value.assignmentId)).toMatchObject({ auditRevision: revision });
      expect(registry.getAssignment(implementer.value.assignmentId)?.auditAttemptId).toBeUndefined();

      const coordinatorBefore = registry.getAssignment(coordinator.value.assignmentId);
      const assignmentCount = registry.get(taskId)?.assignments.length;
      expect(registry.finishAssignment({
        assignmentId: auditor.value.assignmentId, identity: auditorIdentity, revision, now: 110,
      })).toMatchObject({ ok: true, value: { status: 'finalized', leaseId: '' } });
      expect(registry.getAssignment(implementer.value.assignmentId)).toMatchObject({
        status: 'rework', verdict: 'REWORK', blocker: 'production-shaped correction',
      });
      expect(registry.getAssignment(coordinator.value.assignmentId)).toEqual(coordinatorBefore);
      expect(registry.get(taskId)?.assignments).toHaveLength(assignmentCount!);
      registry.close();

      registry = new SupervisionTaskRegistry({ dbPath });
      const beforeReplay = registry.get(taskId);
      const eventCount = registry.listEvents(taskId).length;
      expect(registry.finishAssignment({
        assignmentId: auditor.value.assignmentId, identity: auditorIdentity, revision, now: 120,
      })).toMatchObject({ ok: true, replay: true, value: { status: 'finalized', leaseId: '' } });
      expect(registry.get(taskId)).toEqual(beforeReplay);
      expect(registry.listEvents(taskId)).toHaveLength(eventCount);
      registry.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets only the same-project Brain clean a revision-only implementer receipt and preserves it across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-brain-auditor-cleanup-'));
    const dbPath = join(dir, 'supervision-state.sqlite');
    const taskId = 'brain-auditor-cleanup';
    const revision = 'brain-auditor-cleanup-r1';
    const attemptId = 'brain-auditor-cleanup-attempt';
    const worker = identity('deck_brain_cleanup_worker');
    const auditorIdentity = identity('deck_brain_cleanup_auditor');
    try {
      let registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.createOrGet({
        taskId, projectName: 'alpha', classification: 'independent_top_level',
        objective: 'cleanup accepted audit', currentRevision: revision,
      })).toMatchObject({ ok: true });
      const implementer = registry.createAssignment({
        assignmentId: 'brain-cleanup-implementer', taskId, role: 'implementer', identity: worker,
        auditRevision: revision,
      });
      const auditor = registry.createAssignment({
        assignmentId: 'brain-cleanup-auditor', taskId, role: 'auditor', identity: auditorIdentity,
        auditAttemptId: attemptId, auditRevision: revision,
      });
      if (!implementer.ok || !auditor.ok) throw new Error('expected assignments');
      for (const status of ['implementing', 'validated', 'ready_for_audit'] as const) {
        expect(registry.updateAssignment({ assignmentId: implementer.value.assignmentId, identity: worker, status }))
          .toMatchObject({ ok: true });
      }
      expect(registry.appendMatchingAuditReceipt({
        taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId, revision,
        receiptKind: 'final', verdict: 'PASS', auditorSessionName: auditorIdentity.sessionName,
        auditorIdentity, findings: 'accepted exact receipt',
        validations: [{ kind: 'test', label: 'focused', outcome: 'passed', summary: 'passed' }], now: 100,
      })).toMatchObject({ ok: true });
      expect(registry.getAssignment(implementer.value.assignmentId)).toMatchObject({ auditRevision: revision });
      expect(registry.getAssignment(implementer.value.assignmentId)?.auditAttemptId).toBeUndefined();
      const receiptBefore = registry.listAuditReceipts(taskId);
      const snapshotBeforeWrongProject = registry.get(taskId);
      expect(registry.finishAssignmentAsProjectBrain({
        assignmentId: auditor.value.assignmentId, callerProjectName: 'beta', now: 105,
      })).toEqual({ ok: false, reason: 'owner_mismatch' });
      expect(registry.get(taskId)).toEqual(snapshotBeforeWrongProject);

      expect(registry.finishAssignmentAsProjectBrain({
        assignmentId: auditor.value.assignmentId, callerProjectName: 'alpha', now: 110,
      })).toMatchObject({ ok: true, value: { status: 'finalized', leaseId: '' } });
      expect(registry.getAssignment(implementer.value.assignmentId)).toMatchObject({
        status: 'ready_for_integration', verdict: 'PASS',
      });
      expect(registry.listAuditReceipts(taskId)).toEqual(receiptBefore);
      registry.close();

      registry = new SupervisionTaskRegistry({ dbPath });
      const beforeReplay = registry.get(taskId);
      const receiptsAfterReopen = registry.listAuditReceipts(taskId);
      expect(registry.finishAssignmentAsProjectBrain({
        assignmentId: auditor.value.assignmentId, callerProjectName: 'alpha', now: 120,
      })).toMatchObject({ ok: true, replay: true, value: { status: 'finalized', leaseId: '' } });
      expect(registry.get(taskId)).toEqual(beforeReplay);
      expect(registry.listAuditReceipts(taskId)).toEqual(receiptsAfterReopen);
      registry.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('atomically rebinds only the same logical validated implementer and refuses audited or cross-user takeover', () => {
    const registry = makeRegistry();
    const taskId = 'brain-owner-mismatch-rebind';
    const revision = 'brain-owner-mismatch-r1';
    const stale = identity('deck_owner_mismatch_worker');
    const live = {
      ...stale,
      sessionInstanceId: 'new-instance',
      runtimeEpoch: 'new-epoch',
    };
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'independent_top_level',
      objective: 'recover drifted validated identity', currentRevision: revision,
    })).toMatchObject({ ok: true });
    const assignment = registry.createAssignment({
      assignmentId: 'brain-owner-mismatch-implementer', taskId, role: 'implementer',
      identity: stale, auditRevision: revision,
    });
    if (!assignment.ok) throw new Error(assignment.reason);
    for (const status of ['implementing', 'validated'] as const) {
      expect(registry.updateAssignment({ assignmentId: assignment.value.assignmentId, identity: stale, status }))
        .toMatchObject({ ok: true });
    }
    expect(registry.updateTask({ taskId, status: 'implementing' })).toMatchObject({ ok: true });
    expect(registry.updateTask({ taskId, status: 'validated' })).toMatchObject({ ok: true });

    const beforeWrongUser = registry.get(taskId);
    expect(registry.finishAssignmentAsProjectBrain({
      assignmentId: assignment.value.assignmentId,
      callerProjectName: 'alpha',
      rebindProjectName: 'alpha',
      rebindIdentity: identity('deck_different_user_worker'),
    })).toEqual({ ok: false, reason: 'owner_mismatch' });
    expect(registry.get(taskId)).toEqual(beforeWrongUser);
    expect(registry.finishAssignmentAsProjectBrain({
      assignmentId: assignment.value.assignmentId,
      callerProjectName: 'beta',
      rebindProjectName: 'beta',
      rebindIdentity: live,
    })).toEqual({ ok: false, reason: 'owner_mismatch' });
    expect(registry.get(taskId)).toEqual(beforeWrongUser);

    expect(registry.finishAssignmentAsProjectBrain({
      assignmentId: assignment.value.assignmentId,
      callerProjectName: 'alpha',
      rebindProjectName: 'alpha',
      rebindIdentity: live,
      now: 100,
    })).toMatchObject({
      ok: true,
      value: { status: 'ready_for_audit', leaseId: '', identity: live },
    });
    expect(registry.get(taskId)).toMatchObject({ status: 'ready_for_audit', currentRevision: revision });
    const beforeReplay = registry.get(taskId);
    expect(registry.finishAssignmentAsProjectBrain({
      assignmentId: assignment.value.assignmentId,
      callerProjectName: 'alpha',
      rebindProjectName: 'alpha',
      rebindIdentity: live,
      now: 110,
    })).toMatchObject({ ok: true, replay: true });
    expect(registry.get(taskId)).toEqual(beforeReplay);

    const auditedTaskId = 'brain-owner-mismatch-audited';
    const auditedRevision = 'brain-owner-mismatch-audited-r1';
    const auditedAttempt = 'brain-owner-mismatch-audited-attempt';
    expect(registry.createOrGet({
      taskId: auditedTaskId, projectName: 'alpha', classification: 'independent_top_level',
      objective: 'do not override accepted audit', currentRevision: auditedRevision,
    })).toMatchObject({ ok: true });
    const auditedWorker = registry.createAssignment({
      assignmentId: 'brain-owner-mismatch-audited-worker', taskId: auditedTaskId,
      role: 'implementer', identity: stale, auditRevision: auditedRevision,
    });
    const auditedAuditorIdentity = identity('deck_owner_mismatch_auditor');
    const auditedAuditor = registry.createAssignment({
      assignmentId: 'brain-owner-mismatch-auditor', taskId: auditedTaskId,
      role: 'auditor', identity: auditedAuditorIdentity,
      auditAttemptId: auditedAttempt, auditRevision: auditedRevision,
    });
    if (!auditedWorker.ok || !auditedAuditor.ok) throw new Error('expected audited fixture');
    for (const status of ['implementing', 'validated'] as const) {
      expect(registry.updateAssignment({
        assignmentId: auditedWorker.value.assignmentId, identity: stale, status,
      })).toMatchObject({ ok: true });
    }
    expect(registry.appendMatchingAuditReceipt({
      taskId: auditedTaskId, auditorAssignmentId: auditedAuditor.value.assignmentId,
      attemptId: auditedAttempt, revision: auditedRevision, receiptKind: 'final', verdict: 'PASS',
      auditorSessionName: auditedAuditorIdentity.sessionName, auditorIdentity: auditedAuditorIdentity,
      findings: 'accepted already', validations: [{
        kind: 'test', label: 'accepted', outcome: 'passed', summary: 'accepted',
      }],
    })).toMatchObject({ ok: true });
    const auditedBefore = registry.get(auditedTaskId);
    expect(registry.finishAssignmentAsProjectBrain({
      assignmentId: auditedWorker.value.assignmentId,
      callerProjectName: 'alpha', rebindProjectName: 'alpha', rebindIdentity: live,
    })).toEqual({ ok: false, reason: 'receipt_closed' });
    expect(registry.get(auditedTaskId)).toEqual(auditedBefore);
    registry.close();
  });

  it('fails closed without mutation when a receipt has multiple revision-only pending implementers', () => {
    const registry = makeRegistry();
    const taskId = 'audit-finish-ambiguous-implementers';
    const revision = 'audit-finish-ambiguous-r1';
    const attemptId = 'audit-finish-ambiguous-attempt';
    const auditorIdentity = identity('deck_audit_finish_ambiguous_auditor');
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'integration_task',
      objective: 'preserve multiple implementer ambiguity', currentRevision: revision,
    })).toMatchObject({ ok: true });
    expect(registry.createAssignment({
      assignmentId: 'audit-finish-ambiguous-coordinator', taskId, role: 'coordinator',
      identity: identity('deck_audit_finish_ambiguous_brain'),
      auditAttemptId: attemptId, auditRevision: revision,
    })).toMatchObject({ ok: true });
    for (const [index, sessionName] of ['deck_audit_finish_worker_a', 'deck_audit_finish_worker_b'].entries()) {
      const owner = identity(sessionName);
      const implementer = registry.createAssignment({
        assignmentId: `audit-finish-ambiguous-implementer-${index}`, taskId, role: 'implementer', identity: owner,
        auditRevision: revision,
      });
      if (!implementer.ok) throw new Error(implementer.reason);
      for (const status of ['implementing', 'validated'] as const) {
        expect(registry.updateAssignment({ assignmentId: implementer.value.assignmentId, identity: owner, status }))
          .toMatchObject({ ok: true });
      }
    }
    const auditor = registry.createAssignment({
      assignmentId: 'audit-finish-ambiguous-auditor', taskId, role: 'auditor', identity: auditorIdentity,
      auditAttemptId: attemptId, auditRevision: revision,
    });
    if (!auditor.ok) throw new Error(auditor.reason);
    expect(registry.appendMatchingAuditReceipt({
      taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId, revision,
      receiptKind: 'final', verdict: 'REWORK', auditorSessionName: auditorIdentity.sessionName,
      auditorIdentity, findings: 'must remain ambiguous', validations: [], now: 100,
    })).toMatchObject({ ok: true });
    const before = registry.get(taskId);
    const eventCount = registry.listEvents(taskId).length;
    expect(registry.finishAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditorIdentity, revision, now: 110,
    })).toEqual({ ok: false, reason: 'ambiguous_assignment' });
    expect(registry.get(taskId)).toEqual(before);
    expect(registry.listEvents(taskId)).toHaveLength(eventCount);
    registry.close();
  });

  it.each([
    {
      label: 'attempt mismatch',
      implementerAttemptId: 'different-attempt',
      implementerRevision: 'audit-finish-mismatch-r1',
      reason: 'old_audit_attempt',
    },
    {
      label: 'revision mismatch',
      implementerAttemptId: undefined,
      implementerRevision: 'different-revision',
      reason: 'old_revision',
    },
  ] as const)('fails closed without mutation on a pending implementer $label', ({
    label, implementerAttemptId, implementerRevision, reason,
  }) => {
    const registry = makeRegistry();
    const suffix = label.replace(' ', '-');
    const taskId = `audit-finish-${suffix}`;
    const revision = 'audit-finish-mismatch-r1';
    const attemptId = 'audit-finish-mismatch-attempt';
    const implementerIdentity = identity(`deck_audit_finish_${suffix}_worker`);
    const auditorIdentity = identity(`deck_audit_finish_${suffix}_auditor`);
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'integration_task',
      objective: `fail closed on ${label}`, currentRevision: revision,
    })).toMatchObject({ ok: true });
    const implementer = registry.createAssignment({
      assignmentId: `${taskId}-implementer`, taskId, role: 'implementer', identity: implementerIdentity,
      ...(implementerAttemptId ? { auditAttemptId: implementerAttemptId } : {}),
      auditRevision: implementerRevision,
    });
    const auditor = registry.createAssignment({
      assignmentId: `${taskId}-auditor`, taskId, role: 'auditor', identity: auditorIdentity,
      auditAttemptId: attemptId, auditRevision: revision,
    });
    if (!implementer.ok || !auditor.ok) throw new Error('expected mismatch assignments');
    for (const status of ['implementing', 'validated', 'ready_for_audit'] as const) {
      expect(registry.updateAssignment({
        assignmentId: implementer.value.assignmentId, identity: implementerIdentity, status,
      })).toMatchObject({ ok: true });
    }
    expect(registry.appendMatchingAuditReceipt({
      taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId, revision,
      receiptKind: 'final', verdict: 'REWORK', auditorSessionName: auditorIdentity.sessionName,
      auditorIdentity, findings: `must reject ${label}`, validations: [], now: 100,
    })).toMatchObject({ ok: true });
    const beforeTask = registry.get(taskId);
    const beforeEvents = registry.listEvents(taskId);
    const beforeReceipts = registry.listAuditReceipts(taskId);
    expect(registry.finishAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditorIdentity, revision, now: 110,
    })).toEqual({ ok: false, reason });
    expect(registry.get(taskId)).toEqual(beforeTask);
    expect(registry.listEvents(taskId)).toEqual(beforeEvents);
    expect(registry.listAuditReceipts(taskId)).toEqual(beforeReceipts);
    registry.close();
  });

  it('hands off a validated integration slice without registering or consuming an audit', () => {
    const registry = makeRegistry();
    const taskId = 'validated-slice-no-audit';
    const revision = 'slice-r1';
    expect(registry.createOrGet({
      taskId, topLevelTaskId: 'top-feature', classification: 'integration_slice',
      objective: 'validated slice handoff',
    }).ok).toBe(true);
    const workerIdentity = identity('deck_slice_worker');
    const worker = registry.createAssignment({
      taskId, role: 'implementer', identity: workerIdentity, scopeFiles: ['src/slice.ts'],
    });
    if (!worker.ok) throw new Error(worker.reason);

    expect(registry.applyTaskIntent({
      taskId, assignmentId: worker.value.assignmentId, intent: 'start', toStatus: 'implementing',
    })).toMatchObject({ ok: true });
    expect(registry.applyTaskIntent({
      taskId, assignmentId: worker.value.assignmentId, intent: 'record_validation',
      validationState: 'passed', toStatus: 'validated',
    })).toMatchObject({ ok: true, value: { status: 'validated' } });
    expect(registry.applyTaskIntent({
      taskId, assignmentId: worker.value.assignmentId, intent: 'open_audit', toStatus: 'ready_for_audit',
    })).toEqual({ ok: false, reason: 'role_forbidden' });
    expect(registry.createAssignment({
      taskId, role: 'auditor', identity: identity('deck_slice_auditor'),
      scopeFiles: ['src/slice.ts'], auditAttemptId: 'must-not-exist', auditRevision: revision,
    })).toEqual({ ok: false, reason: 'role_forbidden' });

    const finished = registry.finishAssignment({
      assignmentId: worker.value.assignmentId, identity: workerIdentity,
      revision, evidence: 'focused tests passed',
    });
    expect(finished).toMatchObject({
      ok: true,
      value: {
        status: 'ready_for_integration', leaseId: '',
      },
    });
    if (!finished.ok) throw new Error(finished.reason);
    expect(finished.value.auditAttemptId).toBeUndefined();
    expect(finished.value.verdict).toBeUndefined();
    expect(registry.get(taskId)).toMatchObject({
      classification: 'integration_slice', currentRevision: revision,
      status: 'ready_for_integration',
      assignments: [expect.objectContaining({
        assignmentId: worker.value.assignmentId,
        status: 'ready_for_integration', leaseId: '',
      })],
    });
    expect(registry.listEvents(taskId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        assignmentId: worker.value.assignmentId,
        eventType: 'implementation_finished',
        payload: expect.objectContaining({
          validatedSliceHandoff: true, implementationHandoff: 'FINISHED', auditVerdict: null, revision,
        }),
      }),
    ]));
  });

  it('rejects integration-slice verdict metadata without an exact revision before mutation', () => {
    const registry = makeRegistry();
    const taskId = 'slice-verdict-requires-revision';
    const owner = identity('deck_slice_revision_worker');
    expect(registry.createOrGet({
      taskId, topLevelTaskId: 'top-feature', classification: 'integration_slice',
      objective: 'bind implementation verdict to exact bytes',
    })).toMatchObject({ ok: true });
    const assignment = registry.createAssignment({
      taskId, role: 'implementer', identity: owner, scopeFiles: ['src/slice.ts'],
    });
    if (!assignment.ok) throw new Error(assignment.reason);
    const beforeTask = registry.get(taskId);
    const beforeAssignment = registry.getAssignment(assignment.value.assignmentId);
    const beforeEvents = registry.listEvents(taskId);

    for (const revision of [undefined, '   ']) {
      expect(registry.updateAssignment({
        assignmentId: assignment.value.assignmentId,
        identity: owner,
        revision,
        verdict: 'FINISHED',
      })).toEqual({ ok: false, reason: 'old_revision' });
      expect(registry.get(taskId)).toEqual(beforeTask);
      expect(registry.getAssignment(assignment.value.assignmentId)).toEqual(beforeAssignment);
      expect(registry.listEvents(taskId)).toEqual(beforeEvents);
    }
    registry.close();
  });

  it('records an independent validated implementer FINISHED handoff without fabricating PASS', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-top-level-finish-'));
    const dbPath = join(dir, 'supervision-state.sqlite');
    const taskId = 'validated-top-level-finish';
    const revision = 'validated-top-level-r1';
    const owner = identity('deck_validated_top_level_worker');
    try {
      let registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.createOrGet({
        taskId, projectName: 'alpha', classification: 'independent_top_level',
        objective: 'finish implementation before audit', currentRevision: revision,
      })).toMatchObject({ ok: true });
      const assignment = registry.createAssignment({
        assignmentId: 'validated-top-level-implementer', taskId, role: 'implementer',
        identity: owner, auditRevision: revision, scopeFiles: ['src/top-level.ts'],
      });
      if (!assignment.ok) throw new Error(assignment.reason);
      for (const status of ['implementing', 'validated'] as const) {
        expect(registry.updateAssignment({ assignmentId: assignment.value.assignmentId, identity: owner, status }))
          .toMatchObject({ ok: true });
      }
      expect(registry.updateTask({ taskId, status: 'implementing' })).toMatchObject({ ok: true });
      expect(registry.updateTask({ taskId, status: 'validated' })).toMatchObject({ ok: true });

      expect(registry.finishAssignment({
        assignmentId: assignment.value.assignmentId, identity: owner, revision, now: 100,
      })).toMatchObject({ ok: true, value: { status: 'ready_for_audit', leaseId: '' } });
      expect(registry.get(taskId)).toMatchObject({
        status: 'ready_for_audit', currentRevision: revision,
        assignments: [expect.objectContaining({
          assignmentId: assignment.value.assignmentId,
          status: 'ready_for_audit', leaseId: '',
        })],
      });
      expect(registry.getAssignment(assignment.value.assignmentId)?.verdict).toBeUndefined();
      expect(registry.listAuditReceipts(taskId)).toEqual([]);
      expect(registry.listEvents(taskId)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          assignmentId: assignment.value.assignmentId,
          eventType: 'implementation_finished',
          payload: expect.objectContaining({
            validatedTopLevelHandoff: true,
            implementationHandoff: 'FINISHED',
            auditVerdict: null,
            revision,
          }),
        }),
      ]));
      registry.close();

      registry = new SupervisionTaskRegistry({ dbPath });
      const before = registry.get(taskId);
      const events = registry.listEvents(taskId);
      expect(registry.finishAssignment({
        assignmentId: assignment.value.assignmentId, identity: owner, revision, now: 200,
      })).toMatchObject({ ok: true, replay: true });
      expect(registry.get(taskId)).toEqual(before);
      expect(registry.listEvents(taskId)).toEqual(events);
      registry.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists implementation heartbeat cooldown receipts without advancing progress or fabricating PASS', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-implementation-heartbeat-'));
    const dbPath = join(dir, 'supervision-state.sqlite');
    const identityValue = identity('deck_alpha_worker');
    try {
      let registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.createOrGet({
        taskId: 'heartbeat-task', projectName: 'alpha', classification: 'independent_top_level',
        objective: 'durable watchdog', now: 1_000,
      }).ok).toBe(true);
      const assignment = registry.createAssignment({
        assignmentId: 'heartbeat-assignment', taskId: 'heartbeat-task', role: 'implementer',
        identity: identityValue, scopeFiles: ['src/a.ts'], now: 2_000,
      });
      if (!assignment.ok) throw new Error(assignment.reason);
      expect(registry.updateTask({ taskId: 'heartbeat-task', status: 'implementing', now: 3_000 }).ok).toBe(true);
      expect(registry.updateAssignment({
        assignmentId: assignment.value.assignmentId, identity: identityValue,
        status: 'implementing', now: 3_000,
      }).ok).toBe(true);
      const progressClock = registry.getAssignment(assignment.value.assignmentId)!.updatedAt;
      expect(registry.recordImplementationHeartbeat({
        assignmentId: assignment.value.assignmentId,
        reminderNumber: 1,
        clientMessageId: 'implementation-heartbeat:1',
        now: 10_000,
      })).toMatchObject({
        ok: true,
        value: {
          eventType: 'implementation_heartbeat', status: 'implementing', createdAt: 10_000,
          payload: expect.objectContaining({ substantiveProgress: false, reminderNumber: 1 }),
        },
      });
      expect(registry.getAssignment(assignment.value.assignmentId)).toMatchObject({
        updatedAt: progressClock, status: 'implementing',
      });
      expect(registry.getAssignment(assignment.value.assignmentId)?.verdict).toBeUndefined();
      registry.close();

      registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.listEvents('heartbeat-task')).toEqual(expect.arrayContaining([
        expect.objectContaining({
          assignmentId: assignment.value.assignmentId,
          eventType: 'implementation_heartbeat', createdAt: 10_000,
        }),
      ]));
      expect(registry.get('heartbeat-task')).toMatchObject({
        status: 'implementing', assignments: [expect.objectContaining({
          assignmentId: assignment.value.assignmentId, status: 'implementing',
        })],
      });
      expect(registry.getAssignment(assignment.value.assignmentId)?.verdict).toBeUndefined();
      registry.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('admits exactly one active overall auditor and makes REWORK belong to the combined revision', () => {
    const registry = makeRegistry();
    expect(registry.createOrGet({
      taskId: 'one-overall-audit', projectName: 'alpha', classification: 'integration_task',
      objective: 'audit once', currentRevision: 'combined-r1',
    }).ok).toBe(true);
    const firstIdentity = identity('deck_alpha_auditor_1', 'claude-code-sdk');
    const first = registry.createAssignment({
      assignmentId: 'overall-auditor-1', taskId: 'one-overall-audit', role: 'auditor',
      identity: firstIdentity, auditAttemptId: 'overall-attempt-1', auditRevision: 'combined-r1',
    });
    if (!first.ok) throw new Error(first.reason);
    expect(registry.createAssignment({
      assignmentId: 'overall-auditor-duplicate', taskId: 'one-overall-audit', role: 'auditor',
      identity: identity('deck_alpha_auditor_2', 'claude-code-sdk'),
      auditAttemptId: 'overall-attempt-duplicate', auditRevision: 'combined-r1',
    })).toEqual({ ok: false, reason: 'duplicate_assignment' });
    expect(registry.updateAssignment({
      assignmentId: first.value.assignmentId, identity: firstIdentity,
      status: 'rework', auditAttemptId: 'overall-attempt-1', auditRevision: 'combined-r1', verdict: 'REWORK',
    }).ok).toBe(true);
    expect(registry.createAssignment({
      assignmentId: 'overall-auditor-r2', taskId: 'one-overall-audit', role: 'auditor',
      identity: identity('deck_alpha_auditor_2', 'claude-code-sdk'),
      auditAttemptId: 'overall-attempt-2', auditRevision: 'combined-r2',
    })).toMatchObject({ ok: true });
    expect(registry.listAssignments('one-overall-audit')).toHaveLength(2);
    registry.close();
  });

  function createReplacementOwnerPassShape(registry: SupervisionTaskRegistry, taskId: string) {
    const revision = 'overall-pass-r1';
    const attemptId = 'overall-pass-attempt-r1';
    const sessionName = 'deck_alpha_brain';
    const oldOwnerIdentity = {
      ...identity(sessionName), sessionInstanceId: 'old-instance', runtimeEpoch: 'old-epoch',
    };
    const replacementIdentity = {
      ...identity(sessionName), sessionInstanceId: 'current-instance', runtimeEpoch: 'current-epoch',
    };
    const auditorIdentity = identity('deck_alpha_auditor');
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'integration_task',
      objective: 'replacement owner recovery', currentRevision: revision, now: 1,
    }).ok).toBe(true);
    const oldOwner = registry.createAssignment({
      assignmentId: `${taskId}-old-owner`, taskId, role: 'integration_owner', identity: oldOwnerIdentity,
      scopeFiles: [], now: 10,
    });
    const replacement = registry.createAssignment({
      assignmentId: `${taskId}-replacement`, taskId, role: 'integration_owner', identity: replacementIdentity,
      scopeFiles: [], now: 20,
    });
    const auditor = registry.createAssignment({
      assignmentId: `${taskId}-auditor`, taskId, role: 'auditor', identity: auditorIdentity,
      scopeFiles: [], auditAttemptId: attemptId, auditRevision: revision, now: 30,
    });
    if (!oldOwner.ok || !replacement.ok || !auditor.ok) throw new Error('fixture creation failed');

    expect(registry.updateAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditorIdentity, status: 'auditing',
      auditAttemptId: attemptId, auditRevision: revision, now: 40,
    }).ok).toBe(true);
    expect(registry.updateAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditorIdentity, status: 'passed',
      auditAttemptId: attemptId, auditRevision: revision, verdict: 'PASS', crossVendorAuditPassed: true, now: 50,
    }).ok).toBe(true);
    expect(registry.finishAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditorIdentity, revision, now: 60,
    })).toMatchObject({ ok: true, value: { status: 'finalized', verdict: 'PASS' } });

    expect(registry.updateAssignment({
      assignmentId: replacement.value.assignmentId, identity: replacementIdentity, status: 'ready_for_audit',
      auditAttemptId: attemptId, auditRevision: revision, now: 70,
    }).ok).toBe(true);
    expect(registry.updateTask({ taskId, status: 'ready_for_audit', currentRevision: revision, now: 80 }).ok).toBe(true);
    expect(registry.finishAssignment({
      assignmentId: replacement.value.assignmentId, identity: replacementIdentity, revision, now: 90,
    })).toMatchObject({
      ok: true,
      value: {
        status: 'ready_for_integration', auditAttemptId: attemptId, auditRevision: revision,
        verdict: 'PASS', crossVendorAuditPassed: true,
      },
    });
    return { revision, attemptId, sessionName, oldOwner, replacement, auditor };
  }

  it('cancels only a superseded integration owner and preserves the replacement PASS aggregate', async () => {
    const registry = makeRegistry();
    const shape = createReplacementOwnerPassShape(registry, 'task-replacement-owner-cancel');
    const handlers = createSupervisionMcpToolHandlers(
      { sessionName: shape.sessionName, projectName: 'alpha' } as never,
      { registry: supervisionRegistryPort(registry) },
    );

    expect(await handlers[SUPERVISION_MCP_TOOLS.INTENT]({
      intent: 'cancel', taskId: 'task-replacement-owner-cancel',
      assignmentId: shape.oldOwner.value.assignmentId, note: 'superseded runtime epoch',
    })).toMatchObject({ status: 'ok', fromStatus: 'ready_for_audit', toStatus: 'cancelled' });

    expect(registry.get('task-replacement-owner-cancel')).toMatchObject({
      status: 'ready_for_integration',
      currentRevision: shape.revision,
      integrationOwnerAssignmentId: shape.replacement.value.assignmentId,
      assignments: expect.arrayContaining([
        expect.objectContaining({
          assignmentId: shape.oldOwner.value.assignmentId, status: 'cancelled', leaseId: '',
        }),
        expect.objectContaining({
          assignmentId: shape.replacement.value.assignmentId, status: 'ready_for_integration',
          auditAttemptId: shape.attemptId, auditRevision: shape.revision, verdict: 'PASS',
        }),
        expect.objectContaining({
          assignmentId: shape.auditor.value.assignmentId, status: 'finalized',
          auditAttemptId: shape.attemptId, auditRevision: shape.revision, verdict: 'PASS',
        }),
      ]),
    });
  });

  it('explicitly recovers a legacy-cascaded cancelled task from exact replacement PASS evidence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'supervision-cancelled-evidence-recovery-'));
    const dbPath = join(dir, 'registry.sqlite');
    let registry = new SupervisionTaskRegistry({ dbPath });
    try {
      const shape = createReplacementOwnerPassShape(registry, 'task-cancelled-evidence-recovery');
      expect(registry.applyTaskIntent({
        taskId: 'task-cancelled-evidence-recovery', intent: 'cancel', toStatus: 'cancelled',
        note: 'legacy task-wide cascade',
      })).toMatchObject({ ok: true, value: { status: 'cancelled' } });
      expect(registry.getAssignment(shape.replacement.value.assignmentId)).toMatchObject({
        status: 'cancelled', leaseId: '', auditAttemptId: shape.attemptId, auditRevision: shape.revision,
      });
      registry.close();
      registry = new SupervisionTaskRegistry({ dbPath });

      const handlers = createSupervisionMcpToolHandlers(
        { sessionName: shape.sessionName, projectName: 'alpha' } as never,
        { registry: supervisionRegistryPort(registry), isProjectBrain: () => true },
      );
      expect(await handlers[SUPERVISION_MCP_TOOLS.RECOVER]({
        taskId: 'task-cancelled-evidence-recovery', toStatus: 'recovered',
        reason: 'repair legacy assignment-cancel cascade',
      })).toEqual({
        status: 'ok', taskId: 'task-cancelled-evidence-recovery',
        fromStatus: 'cancelled', toStatus: 'ready_for_integration',
      });
      expect(registry.get('task-cancelled-evidence-recovery')).toMatchObject({
        status: 'ready_for_integration', currentRevision: shape.revision,
        integrationOwnerAssignmentId: shape.replacement.value.assignmentId,
        assignments: expect.arrayContaining([
          expect.objectContaining({ assignmentId: shape.oldOwner.value.assignmentId, status: 'cancelled' }),
          expect.objectContaining({
            assignmentId: shape.replacement.value.assignmentId, status: 'ready_for_integration',
            verdict: 'PASS', auditAttemptId: shape.attemptId, auditRevision: shape.revision,
          }),
          expect.objectContaining({ assignmentId: shape.auditor.value.assignmentId, status: 'finalized' }),
        ]),
      });
      expect(registry.listEvents('task-cancelled-evidence-recovery')).toEqual(expect.arrayContaining([
        expect.objectContaining({
          eventType: 'recovered', status: 'ready_for_integration',
          payload: expect.objectContaining({
            source: 'cancelled_task_evidence_recovery',
            replacementIntegrationOwnerAssignmentId: shape.replacement.value.assignmentId,
            revision: shape.revision,
            auditAttemptId: shape.attemptId,
          }),
        }),
      ]));
    } finally {
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when cancelled-task recovery lacks exact revision-bound PASS evidence', async () => {
    const registry = makeRegistry();
    expect(registry.createOrGet({
      taskId: 'task-cancelled-without-pass', projectName: 'alpha', objective: 'no evidence',
    }).ok).toBe(true);
    expect(registry.createAssignment({
      assignmentId: 'task-cancelled-without-pass-owner', taskId: 'task-cancelled-without-pass',
      role: 'integration_owner', identity: identity('deck_alpha_brain'), scopeFiles: [],
    }).ok).toBe(true);
    expect(registry.applyTaskIntent({
      taskId: 'task-cancelled-without-pass', intent: 'cancel', toStatus: 'cancelled',
    }).ok).toBe(true);
    expect(registry.recoverTask({
      taskId: 'task-cancelled-without-pass', toStatus: 'recovered', reason: 'must refuse',
    })).toEqual({ ok: false, reason: 'old_revision' });
    expect(registry.get('task-cancelled-without-pass')).toMatchObject({ status: 'cancelled' });
  });

  it('retires legacy claim rows while repairing a cancelled task with a delegated lease on reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-cancelled-reconcile-'));
    const dbPath = join(dir, 'supervision-state.sqlite');
    const paths = Array.from({ length: 12 }, (_, index) => `src/legacy-claim-${index + 1}.ts`);
    try {
      let registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.createOrGet({
        taskId: 'task-legacy-cancelled', projectName: 'alpha', objective: 'legacy stale cancellation',
      }).ok).toBe(true);
      const delegated = registry.createAssignment({
        assignmentId: 'assignment-legacy-delegated', taskId: 'task-legacy-cancelled', role: 'implementer',
        identity: identity('deck_alpha_stale'), scopeFiles: paths, claimMode: 'exclusive',
      });
      expect(delegated).toMatchObject({ ok: true, value: { status: 'delegated', leaseId: expect.any(String) } });

      // Reproduce the old non-atomic write: task cancellation committed while
      // the assignment/lease remained untouched.
      expect(registry.updateTask({ taskId: 'task-legacy-cancelled', status: 'cancelled' }).ok).toBe(true);
      expect(registry.get('task-legacy-cancelled')).toMatchObject({
        status: 'cancelled',
        assignments: [expect.objectContaining({ status: 'delegated', leaseId: expect.any(String) })],
      });
      registry.close();

      // Seed rows using the retired on-disk format. New assignments no longer
      // write these rows and public queries never expose them as authority.
      const legacyDb = new DatabaseSync(dbPath);
      const insertLegacyClaim = legacyDb.prepare(
        'INSERT INTO supervision_task_file_claims (task_id, assignment_id, file_path, claim_mode, created_at) VALUES (?, ?, ?, ?, ?)',
      );
      for (const path of paths) {
        insertLegacyClaim.run('task-legacy-cancelled', 'assignment-legacy-delegated', path, 'exclusive', 1);
      }
      expect((legacyDb.prepare('SELECT COUNT(*) AS count FROM supervision_task_file_claims').get() as { count: number }).count).toBe(12);
      legacyDb.close();

      registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.getAssignment('assignment-legacy-delegated')).toMatchObject({
        status: 'cancelled', leaseId: '',
      });
      expect(registry.listFileClaims('task-legacy-cancelled')).toEqual([]);
      const repairedEventCount = registry.listEvents('task-legacy-cancelled').length;
      registry.close();

      // A second startup is a true no-op, and overlapping replacement work is
      // admitted because its worktree, not this legacy table, is authoritative.
      registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.listEvents('task-legacy-cancelled')).toHaveLength(repairedEventCount);
      expect(registry.createOrGet({
        taskId: 'task-replacement', projectName: 'alpha', objective: 'replacement work',
      }).ok).toBe(true);
      expect(registry.createAssignment({
        assignmentId: 'assignment-replacement', taskId: 'task-replacement', role: 'implementer',
        identity: identity('deck_alpha_replacement'), scopeFiles: paths, claimMode: 'exclusive',
      })).toMatchObject({ ok: true, value: { status: 'delegated' } });
      registry.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('makes administrative cancel atomically clear unfinished assignments, leases, and claims', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-admin-cancel-'));
    const dbPath = join(dir, 'supervision-state.sqlite');
    try {
      let registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.createOrGet({
        taskId: 'task-admin-cancel', projectName: 'alpha', objective: 'admin cancellation',
      }).ok).toBe(true);
      expect(registry.createAssignment({
        assignmentId: 'assignment-admin-cancel', taskId: 'task-admin-cancel', role: 'implementer',
        identity: identity('deck_alpha_blocked'), scopeFiles: ['src/reusable.ts'], claimMode: 'exclusive',
      }).ok).toBe(true);

      // Admin recovery must also repair an already-cancelled task written by
      // the legacy task-only path; `status === cancelled` is not a no-op while
      // assignment resources remain live.
      expect(registry.updateTask({ taskId: 'task-admin-cancel', status: 'cancelled' }).ok).toBe(true);
      expect(registry.recoverTask({
        taskId: 'task-admin-cancel', toStatus: 'cancelled', reason: 'operator recovery',
      })).toMatchObject({ ok: true, value: { status: 'cancelled' } });
      expect(registry.getAssignment('assignment-admin-cancel')).toMatchObject({
        status: 'cancelled', leaseId: '', blocker: 'operator recovery',
      });
      expect(registry.listFileClaims('task-admin-cancel')).toEqual([]);
      expect(registry.recoverTask({
        taskId: 'task-admin-cancel', toStatus: 'cancelled', reason: 'operator recovery',
      })).toMatchObject({ ok: true, replay: true });
      registry.close();

      registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.getAssignment('assignment-admin-cancel')).toMatchObject({ status: 'cancelled', leaseId: '' });
      expect(registry.listFileClaims('task-admin-cancel')).toEqual([]);
      registry.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a stale same-session duplicate, binds a missing task revision, and persists the exact PASS target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-matching-audit-'));
    const dbPath = join(dir, 'supervision-state.sqlite');
    try {
      let registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.createOrGet({
        taskId: 'task-matching-pass', projectName: 'alpha', classification: 'integration_task',
        objective: 'receipt projection',
      }).ok).toBe(true);
      registry.close();

      // Production legacy rows may carry an explicit JSON null rather than an
      // omitted revision. Both forms mean unbound, never a conflicting value.
      const legacyDb = new DatabaseSync(dbPath);
      const taskRow = legacyDb.prepare(
        'SELECT payload_json AS payloadJson FROM supervision_tasks WHERE task_id = ?',
      ).get('task-matching-pass') as { payloadJson: string };
      const legacyPayload = JSON.parse(taskRow.payloadJson) as Record<string, unknown>;
      legacyPayload.currentRevision = null;
      legacyDb.prepare(
        'UPDATE supervision_tasks SET current_revision = NULL, payload_json = ? WHERE task_id = ?',
      ).run(JSON.stringify(legacyPayload), 'task-matching-pass');
      legacyDb.close();
      registry = new SupervisionTaskRegistry({ dbPath });

      const stale = registry.createAssignment({
        assignmentId: 'assignment-stale', taskId: 'task-matching-pass', role: 'implementer',
        identity: identity('deck_alpha_w1'), scopeFiles: ['src/a.ts'],
      });
      const implementer = registry.createAssignment({
        assignmentId: 'assignment-implementer', taskId: 'task-matching-pass', role: 'implementer',
        identity: identity('deck_alpha_w1'), scopeFiles: ['src/a.ts'],
      });
      const auditor = registry.createAssignment({
        assignmentId: 'assignment-auditor', taskId: 'task-matching-pass', role: 'auditor',
        identity: identity('deck_alpha_cc1', 'claude-code-sdk'), scopeFiles: ['src/a.ts'],
        auditAttemptId: 'attempt-pass-1', auditRevision: 'rev-pass-1',
      });
      expect(stale.ok && implementer.ok && auditor.ok).toBe(true);
      if (!implementer.ok) throw new Error('implementer should create');
      for (const status of ['implementing', 'validated', 'ready_for_audit'] as const) {
        expect(registry.updateAssignment({
          assignmentId: implementer.value.assignmentId,
          identity: identity('deck_alpha_w1'),
          status,
        }).ok, status).toBe(true);
      }

      expect(registry.applyMatchingAuditReceipt({
        attemptId: 'attempt-pass-1', revision: 'rev-pass-1', verdict: 'PASS',
        auditedSessionName: 'deck_alpha_missing', auditorSessionName: 'deck_alpha_cc1',
      })).toEqual({ ok: false, reason: 'not_found' });
      expect(registry.applyMatchingAuditReceipt({
        attemptId: 'attempt-pass-1', revision: 'rev-pass-1', verdict: 'PASS',
        auditedSessionName: 'deck_alpha_w1', auditorSessionName: 'deck_alpha_wrong',
      })).toEqual({ ok: false, reason: 'owner_mismatch' });
      expect(registry.applyMatchingAuditReceipt({
        attemptId: 'attempt-pass-1', revision: 'rev-wrong', verdict: 'PASS',
        auditedSessionName: 'deck_alpha_w1', auditorSessionName: 'deck_alpha_cc1',
      })).toEqual({ ok: false, reason: 'old_revision' });
      expect(registry.getTaskRecord('task-matching-pass')?.currentRevision).toBeNull();

      const applied = registry.applyMatchingAuditReceipt({
        attemptId: 'attempt-pass-1', revision: 'rev-pass-1', verdict: 'PASS',
        auditedSessionName: 'deck_alpha_w1', auditorSessionName: 'deck_alpha_cc1',
        findings: 'matching revision passed', now: 50,
      });
      expect(applied).toMatchObject({
        ok: true,
        value: { assignmentId: 'assignment-implementer', status: 'ready_for_integration', verdict: 'PASS' },
      });
      expect(registry.getAssignment('assignment-stale')).toMatchObject({ status: 'delegated' });
      expect(registry.getAssignment('assignment-auditor')).toMatchObject({ status: 'passed', verdict: 'PASS' });
      expect(registry.getTaskRecord('task-matching-pass')).toMatchObject({ currentRevision: 'rev-pass-1' });
      expect(registry.finishAssignment({
        assignmentId: 'assignment-implementer', identity: identity('deck_alpha_w1'), revision: 'rev-pass-1',
      })).toMatchObject({ ok: true, value: { status: 'ready_for_integration', leaseId: '' } });
      expect(registry.applyMatchingAuditReceipt({
        attemptId: 'attempt-pass-1', revision: 'rev-pass-1', verdict: 'PASS',
        auditedSessionName: 'deck_alpha_w1', auditorSessionName: 'deck_alpha_cc1', now: 51,
      })).toMatchObject({ ok: true, replay: true });
      registry.close();

      const evidenceDb = new DatabaseSync(dbPath);
      expect(evidenceDb.prepare(
        'SELECT task_id AS taskId, assignment_id AS assignmentId, revision, verdict FROM supervision_audit_attestations WHERE attempt_id = ?',
      ).get('attempt-pass-1')).toMatchObject({
        taskId: 'task-matching-pass', assignmentId: 'assignment-implementer', revision: 'rev-pass-1', verdict: 'PASS',
      });
      evidenceDb.close();

      registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.getAssignment('assignment-implementer')).toMatchObject({
        status: 'ready_for_integration', leaseId: '', auditAttemptId: 'attempt-pass-1', auditRevision: 'rev-pass-1',
      });
      expect(registry.getTaskRecord('task-matching-pass')).toMatchObject({ currentRevision: 'rev-pass-1' });
      registry.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when two same-session assignments are equally audit eligible', () => {
    const registry = makeRegistry();
    expect(registry.createOrGet({
      taskId: 'task-ambiguous-audit', projectName: 'alpha', classification: 'integration_task',
      objective: 'ambiguous receipt', currentRevision: 'rev-1',
    }).ok).toBe(true);
    for (const assignmentId of ['assignment-eligible-a', 'assignment-eligible-b']) {
      const assignment = registry.createAssignment({
        assignmentId, taskId: 'task-ambiguous-audit', role: 'implementer',
        identity: identity('deck_alpha_w1'), scopeFiles: ['src/a.ts'],
      });
      if (!assignment.ok) throw new Error('eligible assignment should create');
      for (const status of ['implementing', 'validated', 'ready_for_audit'] as const) {
        expect(registry.updateAssignment({
          assignmentId, identity: identity('deck_alpha_w1'), status,
        }).ok, `${assignmentId}:${status}`).toBe(true);
      }
    }
    expect(registry.createAssignment({
      assignmentId: 'assignment-ambiguous-auditor', taskId: 'task-ambiguous-audit', role: 'auditor',
      identity: identity('deck_alpha_cc1', 'claude-code-sdk'), auditAttemptId: 'attempt-ambiguous', auditRevision: 'rev-1',
    }).ok).toBe(true);

    expect(registry.applyMatchingAuditReceipt({
      attemptId: 'attempt-ambiguous', revision: 'rev-1', verdict: 'PASS',
      auditedSessionName: 'deck_alpha_w1', auditorSessionName: 'deck_alpha_cc1',
    })).toEqual({ ok: false, reason: 'ambiguous_assignment' });
    expect(registry.getAssignment('assignment-eligible-a')?.status).toBe('ready_for_audit');
    expect(registry.getAssignment('assignment-eligible-b')?.status).toBe('ready_for_audit');
    registry.close();
  });

  it('does not bind a missing task revision without an exact auditor revision', () => {
    const registry = makeRegistry();
    expect(registry.createOrGet({
      taskId: 'task-unbound-revision', projectName: 'alpha', classification: 'integration_task',
      objective: 'missing auditor revision',
    }).ok).toBe(true);
    const implementer = registry.createAssignment({
      assignmentId: 'assignment-unbound-target', taskId: 'task-unbound-revision', role: 'implementer',
      identity: identity('deck_alpha_w1'),
    });
    if (!implementer.ok) throw new Error('implementer should create');
    for (const status of ['implementing', 'validated', 'ready_for_audit'] as const) {
      expect(registry.updateAssignment({
        assignmentId: implementer.value.assignmentId, identity: identity('deck_alpha_w1'), status,
      }).ok, status).toBe(true);
    }
    expect(registry.createAssignment({
      assignmentId: 'assignment-unbound-auditor', taskId: 'task-unbound-revision', role: 'auditor',
      identity: identity('deck_alpha_cc1', 'claude-code-sdk'), auditAttemptId: 'attempt-unbound',
    }).ok).toBe(true);

    expect(registry.applyMatchingAuditReceipt({
      attemptId: 'attempt-unbound', revision: 'rev-untrusted', verdict: 'PASS',
      auditedSessionName: 'deck_alpha_w1', auditorSessionName: 'deck_alpha_cc1',
    })).toEqual({ ok: false, reason: 'old_revision' });
    expect(registry.getTaskRecord('task-unbound-revision')?.currentRevision).toBeUndefined();
    expect(registry.getAssignment('assignment-unbound-target')?.status).toBe('ready_for_audit');
    registry.close();
  });

  it('rejects an old audit revision without advancing the registry projection', () => {
    const registry = makeRegistry();
    registry.createOrGet({
      taskId: 'task-old-audit', projectName: 'alpha', classification: 'integration_task',
      objective: 'old receipt', currentRevision: 'rev-current',
    });
    const current = registry.createAssignment({
      assignmentId: 'assignment-current', taskId: 'task-old-audit', role: 'implementer',
      identity: identity('deck_alpha_w1'), scopeFiles: ['src/current.ts'],
    });
    if (!current.ok) throw new Error('current assignment should create');
    for (const status of ['implementing', 'validated', 'ready_for_audit'] as const) {
      expect(registry.updateAssignment({
        assignmentId: current.value.assignmentId, identity: identity('deck_alpha_w1'), status,
      }).ok, status).toBe(true);
    }
    registry.createAssignment({
      assignmentId: 'assignment-old-auditor', taskId: 'task-old-audit', role: 'auditor',
      identity: identity('deck_alpha_cc1', 'claude-code-sdk'), scopeFiles: ['src/current.ts'],
      auditAttemptId: 'attempt-old', auditRevision: 'rev-old',
    });

    expect(registry.applyMatchingAuditReceipt({
      attemptId: 'attempt-old', revision: 'rev-old', verdict: 'PASS',
      auditedSessionName: 'deck_alpha_w1', auditorSessionName: 'deck_alpha_cc1',
    })).toEqual({ ok: false, reason: 'old_revision' });
    expect(registry.getAssignment('assignment-current')?.status).toBe('ready_for_audit');
    expect(registry.getTaskRecord('task-old-audit')?.currentRevision).toBe('rev-current');
    registry.close();
  });

  it('scopes task rows and idempotency keys by project', () => {
    const registry = makeRegistry();
    const alpha = registry.createOrGet({ projectName: 'alpha', objective: 'same request', idempotencyKey: 'same-key' });
    const beta = registry.createOrGet({ projectName: 'beta', objective: 'same request', idempotencyKey: 'same-key' });
    expect(alpha.ok && beta.ok).toBe(true);
    if (!alpha.ok || !beta.ok) throw new Error('expected scoped tasks');
    expect(alpha.value.taskId).not.toBe(beta.value.taskId);
    expect(registry.list({ projectName: 'alpha' }).map((task) => task.taskId)).toEqual([alpha.value.taskId]);
    expect(registry.list({ projectName: 'beta' }).map((task) => task.taskId)).toEqual([beta.value.taskId]);
    registry.close();
  });

  it('publishes the caller-reported-only file tracking limitation in the machine contract', () => {
    expect(SUPERVISION_TASK_REGISTRY_CONTRACT.fileTracking).toStrictEqual({
      mode: 'caller_reported_only',
      automaticProviderToolHook: false,
      filesystemOrGitScanner: false,
      reconciliationMode: 'caller_supplied_observations_only',
      detectsUnreportedWrites: false,
    });
  });

  it('rejects illegal lifecycle jumps that would bypass audit or finalization gates', () => {
    const registry = makeRegistry();
    expect(registry.createOrGet({ taskId: 'task-transition-task', objective: 'task transitions' }).ok).toBe(true);
    expect(registry.updateTask({ taskId: 'task-transition-task', status: 'pushed' })).toEqual({
      ok: false,
      reason: 'invalid_transition',
    });

    expect(registry.createOrGet({ taskId: 'task-transition-assignment', objective: 'assignment transitions' }).ok).toBe(true);
    const owner = identity('deck_sub_transition');
    const assignment = registry.createAssignment({
      taskId: 'task-transition-assignment',
      role: 'implementer',
      identity: owner,
      scopeFiles: ['src/transition.ts'],
    });
    if (!assignment.ok) throw new Error('assignment should create');
    for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing', 'rework'] as const) {
      expect(registry.updateAssignment({ assignmentId: assignment.value.assignmentId, identity: owner, status }).ok).toBe(true);
    }
    for (const status of ['committed', 'pushed', 'finalized'] as const) {
      expect(registry.updateAssignment({ assignmentId: assignment.value.assignmentId, identity: owner, status })).toEqual({
        ok: false,
        reason: 'invalid_transition',
      });
    }
    expect(registry.get('task-transition-assignment')?.assignments[0]?.status).toBe('rework');
    registry.close();
  });

  it('keeps one task with multiple disjoint implementer assignments', () => {
    const registry = makeRegistry();
    const task = registry.createOrGet({ taskId: 'task-top', topLevelTaskId: 'top', objective: 'feature', classification: 'integration_task' });
    expect(task.ok).toBe(true);
    expect(registry.createAssignment({ taskId: 'task-top', role: 'implementer', identity: identity('deck_sub_a'), scopeFiles: ['src/a.ts'], claimMode: 'exclusive' }).ok).toBe(true);
    expect(registry.createAssignment({ taskId: 'task-top', role: 'implementer', identity: identity('deck_sub_b'), scopeFiles: ['src/b.ts'], claimMode: 'exclusive' }).ok).toBe(true);

    const item = registry.get('task-top');
    expect(item?.assignments.map((assignment) => assignment.identity.sessionName)).toEqual(['deck_sub_a', 'deck_sub_b']);
    expect(item?.fileClaims).toEqual([]);
    registry.close();
  });

  it('admits overlapping assignment metadata without creating or exposing file claims', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    registry.createOrGet({ taskId: 'task-shared', topLevelTaskId: 'top', objective: 'shared file', classification: 'integration_task' });
    registry.createAssignment({ taskId: 'task-shared', role: 'integration_owner', identity: identity('deck_brain'), required: true });
    expect(registry.createAssignment({ taskId: 'task-shared', role: 'implementer', identity: identity('deck_sub_a'), scopeFiles: ['shared/x.ts'], claimMode: 'shared' }).ok).toBe(true);
    expect(registry.createAssignment({ taskId: 'task-shared', role: 'implementer', identity: identity('deck_sub_b'), scopeFiles: ['shared/x.ts'], claimMode: 'shared' }).ok).toBe(true);
    expect(registry.findByFile('shared/x.ts')).toEqual([]);
    expect(registry.listFileClaims('task-shared')).toEqual([]);

    registry.createOrGet({ taskId: 'task-exclusive', topLevelTaskId: 'top2', objective: 'exclusive', classification: 'integration_slice' });
    expect(registry.createAssignment({ taskId: 'task-exclusive', role: 'implementer', identity: identity('deck_sub_c'), scopeFiles: ['src/y.ts'], claimMode: 'exclusive' }).ok).toBe(true);
    expect(registry.createAssignment({ taskId: 'task-exclusive', role: 'implementer', identity: identity('deck_sub_d'), scopeFiles: ['src/y.ts'], claimMode: 'exclusive' })).toMatchObject({ ok: true });
    expect(registry.listFileClaims('task-exclusive')).toEqual([]);
    expect((database.prepare('SELECT COUNT(*) AS count FROM supervision_task_file_claims').get() as { count: number }).count).toBe(0);
    registry.close();
    database.close();
  });

  it('binds file events to assignment runtime without using scope claims as a write gate', () => {
    const registry = makeRegistry();
    registry.createOrGet({ taskId: 'task-files', objective: 'file hooks', classification: 'integration_task' });
    const implementer = identity('deck_sub_impl');
    const auditor = identity('deck_sub_audit', 'claude-code-sdk');
    const impl = registry.createAssignment({ taskId: 'task-files', role: 'implementer', identity: implementer, scopeFiles: ['src/ok.ts'], claimMode: 'read_only' });
    const audit = registry.createAssignment({ taskId: 'task-files', role: 'auditor', identity: auditor, scopeFiles: ['src/ok.ts'] });
    if (!impl.ok || !audit.ok) throw new Error('assignments should create');

    expect(registry.recordFileEvent({ assignmentId: audit.value.assignmentId, identity: auditor, path: 'src/ok.ts', operation: 'modify' })).toEqual({ ok: false, reason: 'role_forbidden' });
    expect(registry.recordFileEvent({ assignmentId: impl.value.assignmentId, identity: { ...implementer, runtimeEpoch: 'old' }, path: 'src/ok.ts', operation: 'modify' })).toEqual({ ok: false, reason: 'owner_mismatch' });
    const first = registry.recordFileEvent({ assignmentId: impl.value.assignmentId, identity: implementer, path: 'src/ok.ts', operation: 'modify', beforeHash: 'a', afterHash: 'b', tool: 'apply_patch', idempotencyKey: 'edit-1' });
    const replay = registry.recordFileEvent({ assignmentId: impl.value.assignmentId, identity: implementer, path: 'src/ok.ts', operation: 'modify', beforeHash: 'a', afterHash: 'b', tool: 'apply_patch', idempotencyKey: 'edit-1' });
    expect(first.ok).toBe(true);
    expect(replay).toMatchObject({ ok: true, replay: true });
    expect(registry.listFileEvents('task-files')).toHaveLength(1);
    for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing', 'rework'] as const) {
      expect(registry.updateAssignment({
        assignmentId: impl.value.assignmentId,
        identity: implementer,
        status,
        ...(status === 'rework' ? { verdict: 'REWORK' as const } : {}),
      }), status).toMatchObject({ ok: true });
    }
    expect(registry.recordFileEvent({ assignmentId: impl.value.assignmentId, identity: implementer, path: 'src/out.ts', operation: 'create' })).toMatchObject({ ok: true });
    expect(registry.get('task-files')).toMatchObject({ status: 'rework', touchedFiles: ['src/ok.ts', 'src/out.ts'] });
    expect(registry.getAssignment(impl.value.assignmentId)).toMatchObject({
      status: 'rework', scopeFiles: ['src/ok.ts', 'src/out.ts'], verdict: 'REWORK',
    });
    expect(registry.getAssignment(impl.value.assignmentId)?.blocker).toBeUndefined();
    registry.close();
  });

  it('worker finish only closes its assignment; aggregate waits for required siblings', () => {
    const registry = makeRegistry();
    registry.createOrGet({ taskId: 'task-aggregate', objective: 'aggregate' });
    const a = registry.createAssignment({ taskId: 'task-aggregate', role: 'implementer', identity: identity('deck_sub_a'), scopeFiles: ['a.ts'] });
    const b = registry.createAssignment({ taskId: 'task-aggregate', role: 'implementer', identity: identity('deck_sub_b'), scopeFiles: ['b.ts'] });
    if (!a.ok || !b.ok) throw new Error('assignments should create');
    for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing', 'passed', 'ready_for_integration'] as const) {
      expect(registry.updateAssignment({ assignmentId: a.value.assignmentId, identity: identity('deck_sub_a'), status }).ok).toBe(true);
    }
    expect(registry.get('task-aggregate')?.status).toBe('delegated');
    for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing', 'rework'] as const) {
      expect(registry.updateAssignment({ assignmentId: b.value.assignmentId, identity: identity('deck_sub_b'), status }).ok).toBe(true);
    }
    expect(registry.get('task-aggregate')?.status).toBe('rework');
    registry.close();
  });

  it('projects committed/pushed lifecycle from events for the OpenSpec 14.3-14.5 sample', () => {
    const registry = makeRegistry();
    registry.createOrGet({
      taskId: 'openspec-14-3-14-5-lifecycle-crash',
      topLevelTaskId: 'openspec-14-3-14-5-lifecycle-crash',
      objective: 'OpenSpec 14.3-14.5 lifecycle/crash',
      classification: 'independent_top_level',
      currentRevision: '0c59b53b581e14ec195e12701416850a25d591b4',
    });
    const owner = identity('deck_sub_581a235r');
    const assignment = registry.createAssignment({ taskId: 'openspec-14-3-14-5-lifecycle-crash', role: 'implementer', identity: owner, scopeFiles: ['server/test/remote-desktop-lifecycle-crash.integration.test.ts'], auditAttemptId: 'rd-lifecycle-crash-audit-20260827-ds1-r2-47f81d', auditRevision: '0c59b53b581e14ec195e12701416850a25d591b4' });
    if (!assignment.ok) throw new Error('assignment should create');
    for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing', 'passed', 'ready_for_integration'] as const) {
      expect(registry.updateAssignment({ assignmentId: assignment.value.assignmentId, identity: owner, status, auditAttemptId: 'rd-lifecycle-crash-audit-20260827-ds1-r2-47f81d', revision: '0c59b53b581e14ec195e12701416850a25d591b4', verdict: status === 'passed' ? 'PASS' : undefined }).ok).toBe(true);
    }
    expect(registry.updateTask({ taskId: 'openspec-14-3-14-5-lifecycle-crash', status: 'finalizing' }).ok).toBe(true);
    expect(registry.updateTask({ taskId: 'openspec-14-3-14-5-lifecycle-crash', status: 'committed', commitSha: '0c59b53b581e14ec195e12701416850a25d591b4' }).ok).toBe(true);
    expect(registry.updateTask({ taskId: 'openspec-14-3-14-5-lifecycle-crash', status: 'pushed', pushRemoteRef: 'refs/heads/dev' }).ok).toBe(true);
    const task = registry.get('openspec-14-3-14-5-lifecycle-crash');
    expect(task?.status).toBe('pushed');
    expect(task?.assignments[0]?.verdict).toBe('PASS');
    expect(task?.commitSha).toBe('0c59b53b581e14ec195e12701416850a25d591b4');
    expect(task?.pushRemoteRef).toBe('refs/heads/dev');
    expect(registry.listEvents('openspec-14-3-14-5-lifecycle-crash').map((event) => event.eventType)).toEqual(expect.arrayContaining(['audit_replied', 'committed', 'pushed']));
    registry.close();
  });

  it('keeps slice PASS separate from parent readiness for macOS auto-unlock isolation', () => {
    const registry = makeRegistry();
    registry.createOrGet({ taskId: 'cc1-complete-macos-build-graph', topLevelTaskId: 'cc1-complete-macos-build-graph', objective: 'CC1 complete macOS build-graph transaction', classification: 'integration_task' });
    registry.createAssignment({ taskId: 'cc1-complete-macos-build-graph', role: 'integration_owner', identity: identity('deck_cd_brain'), required: true });
    registry.createOrGet({ taskId: 'macos-auto-unlock-default-shipping-isolation', topLevelTaskId: 'cc1-complete-macos-build-graph', objective: 'macOS auto-unlock default-shipping isolation', classification: 'integration_slice' });
    const owner = identity('deck_sub_26624c1t');
    const files = [
      'native/macos-remote-desktop/BUILD.gn',
      'native/macos-remote-desktop/auto_unlock.cc',
      'native/macos-remote-desktop/auto_unlock.h',
      'native/macos-remote-desktop/auto_unlock_test.cc',
      'test/spec/macos-auto-unlock-build.test.ts',
      'test/spec/macos-remote-desktop-build.test.ts',
      'scripts/build-worker.ps1',
    ];
    const assignment = registry.createAssignment({ taskId: 'macos-auto-unlock-default-shipping-isolation', role: 'implementer', identity: owner, scopeFiles: files, auditAttemptId: 'macos-auto-unlock-isolation-audit-20260827-cx6-r3-1947bf' });
    if (!assignment.ok) throw new Error('assignment should create');
    for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing', 'passed', 'ready_for_integration'] as const) {
      expect(registry.updateAssignment({ assignmentId: assignment.value.assignmentId, identity: owner, status, auditAttemptId: 'macos-auto-unlock-isolation-audit-20260827-cx6-r3-1947bf', verdict: status === 'passed' ? 'PASS' : undefined }).ok).toBe(true);
    }
    const slice = registry.get('macos-auto-unlock-default-shipping-isolation');
    const parent = registry.get('cc1-complete-macos-build-graph');
    expect(slice?.status).toBe('ready_for_integration');
    expect(slice?.assignments[0]).toMatchObject({ status: 'ready_for_integration', auditAttemptId: 'macos-auto-unlock-isolation-audit-20260827-cx6-r3-1947bf', verdict: 'PASS' });
    expect(slice?.fileClaims).toEqual([]);
    expect(parent?.status).toBe('delegated');
    expect(parent?.assignments[0]?.role).toBe('integration_owner');
    registry.close();
  });

  it('projects assignment REWORK then matching PASS without downgrading sibling PASS assignments', () => {
    const registry = makeRegistry();
    registry.createOrGet({ taskId: 'supervision-provider-integration', topLevelTaskId: 'supervision-provider-integration', objective: 'provider/supervision integration', classification: 'integration_task' });
    const providerLimited = registry.createAssignment({ taskId: 'supervision-provider-integration', role: 'implementer', identity: identity('deck_sub_provider'), scopeFiles: ['src/daemon/provider-limit.ts'] });
    const codex = registry.createAssignment({ taskId: 'supervision-provider-integration', role: 'implementer', identity: identity('deck_sub_4s48141x'), scopeFiles: ['src/agent/codex-runtime-config.ts'], auditAttemptId: 'codex-limit-producer-audit-20260827-cc2-r2-350feb' });
    if (!providerLimited.ok || !codex.ok) throw new Error('assignments should create');
    for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing', 'passed', 'ready_for_integration'] as const) {
      expect(registry.updateAssignment({ assignmentId: providerLimited.value.assignmentId, identity: identity('deck_sub_provider'), status, verdict: status === 'passed' ? 'PASS' : undefined }).ok).toBe(true);
    }
    for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing'] as const) {
      expect(registry.updateAssignment({ assignmentId: codex.value.assignmentId, identity: identity('deck_sub_4s48141x'), status, auditAttemptId: 'codex-limit-producer-audit-20260827-cc2-r2-350feb' }).ok).toBe(true);
    }
    expect(registry.updateAssignment({
      assignmentId: codex.value.assignmentId,
      identity: identity('deck_sub_4s48141x'),
      status: 'rework',
      auditAttemptId: 'codex-limit-producer-audit-20260827-cc2-r2-350feb',
      blocker: 'raw resetsAt unit unknown but forwarded to canonical epoch-seconds field, causing garbage quota label; owner repair request sent',
      verdict: 'REWORK',
    }).ok).toBe(true);
    let task = registry.get('supervision-provider-integration');
    expect(task?.status).toBe('rework');
    expect(task?.assignments.find((assignment) => assignment.assignmentId === providerLimited.value.assignmentId)?.status).toBe('ready_for_integration');
    expect(task?.assignments.find((assignment) => assignment.assignmentId === codex.value.assignmentId)).toMatchObject({ status: 'rework', verdict: 'REWORK', blocker: expect.stringContaining('resetsAt unit unknown') });

    expect(registry.updateAssignment({ assignmentId: codex.value.assignmentId, identity: identity('deck_sub_4s48141x'), status: 'auditing', auditAttemptId: 'codex-limit-producer-audit-20260827-cc2-r3-9f6a77' }).ok).toBe(true);
    expect(registry.updateAssignment({ assignmentId: codex.value.assignmentId, identity: identity('deck_sub_4s48141x'), status: 'passed', auditAttemptId: 'codex-limit-producer-audit-20260827-cc2-r3-9f6a77', verdict: 'PASS' }).ok).toBe(true);
    expect(registry.updateAssignment({ assignmentId: codex.value.assignmentId, identity: identity('deck_sub_4s48141x'), status: 'ready_for_integration', auditAttemptId: 'codex-limit-producer-audit-20260827-cc2-r3-9f6a77' }).ok).toBe(true);
    task = registry.get('supervision-provider-integration');
    expect(task?.status).toBe('ready_for_integration');
    expect(task?.assignments.find((assignment) => assignment.assignmentId === providerLimited.value.assignmentId)).toMatchObject({ status: 'ready_for_integration', verdict: 'PASS' });
    expect(task?.assignments.find((assignment) => assignment.assignmentId === codex.value.assignmentId)).toMatchObject({ status: 'ready_for_integration', verdict: 'PASS', auditAttemptId: 'codex-limit-producer-audit-20260827-cc2-r3-9f6a77' });
    expect(task?.assignments.find((assignment) => assignment.assignmentId === codex.value.assignmentId)?.blocker).toBeUndefined();
    registry.close();
  });

  it('reconciles observed paths as provenance, duplicate deliveries, rename/delete and restart recovery', () => {
    const dir = mkdtempSync(join(tmpdir(), 'supervision-task-registry-'));
    const dbPath = join(dir, 'tasks.sqlite');
    try {
      const registry = new SupervisionTaskRegistry({ dbPath });
      registry.createOrGet({ taskId: 'task-restart', objective: 'restartable hooks', idempotencyKey: 'task-restart' });
      const owner = identity('deck_sub_restart');
      const assignment = registry.createAssignment({ taskId: 'task-restart', role: 'implementer', identity: owner, scopeFiles: ['src/old.ts', 'src/new.ts'], idempotencyKey: 'assignment', executionBinding: persistedExecutionBinding('deck_sub_restart') });
      if (!assignment.ok) throw new Error('assignment should create');
      expect(registry.recordFileEvent({ assignmentId: assignment.value.assignmentId, identity: owner, path: 'src/old.ts', operation: 'rename', beforeHash: 'old', afterHash: 'new', idempotencyKey: 'rename-1' }).ok).toBe(true);
      expect(registry.recordFileEvent({ assignmentId: assignment.value.assignmentId, identity: owner, path: 'src/old.ts', operation: 'rename', beforeHash: 'old', afterHash: 'new', idempotencyKey: 'rename-1' })).toMatchObject({ ok: true, replay: true });
      expect(registry.recordFileEvent({ assignmentId: assignment.value.assignmentId, identity: owner, path: 'src/new.ts', operation: 'delete', beforeHash: 'new', idempotencyKey: 'delete-1' }).ok).toBe(true);
      expect(registry.reconcileScope({ taskId: 'task-restart', trackedPaths: ['src/old.ts', 'src/new.ts'], currentRevision: 'rev1' }).ok).toBe(true);
      expect(registry.reconcileScope({ taskId: 'task-restart', trackedPaths: ['src/old.ts', 'src/new.ts', 'src/untracked.ts'] })).toMatchObject({ ok: true });
      registry.close();
      const reopened = new SupervisionTaskRegistry({ dbPath });
      expect(reopened.get('task-restart')?.touchedFiles).toEqual(['src/new.ts', 'src/old.ts']);
      expect(reopened.get('task-restart')?.currentRevision).toBe('rev1');
      expect(reopened.get('task-restart')?.assignments[0]).toMatchObject({
        scopeFiles: ['src/new.ts', 'src/old.ts', 'src/untracked.ts'],
        executionBinding: persistedExecutionBinding('deck_sub_restart'),
      });
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps one session with two queued assignments attributable only by assignmentId', () => {
    const registry = makeRegistry();
    const same = identity('deck_sub_same');
    registry.createOrGet({ taskId: 'task-one', objective: 'first' });
    registry.createOrGet({ taskId: 'task-two', objective: 'second' });
    const one = registry.createAssignment({ taskId: 'task-one', role: 'implementer', identity: same, scopeFiles: ['src/one.ts'], idempotencyKey: 'one' });
    const two = registry.createAssignment({ taskId: 'task-two', role: 'implementer', identity: same, scopeFiles: ['src/two.ts'], idempotencyKey: 'two' });
    if (!one.ok || !two.ok) throw new Error('assignments should create');
    expect(registry.recordFileEvent({ assignmentId: one.value.assignmentId, identity: same, path: 'src/two.ts', operation: 'modify' })).toMatchObject({ ok: true });
    expect(registry.recordFileEvent({ assignmentId: two.value.assignmentId, identity: same, path: 'src/two.ts', operation: 'modify' }).ok).toBe(true);
    expect(registry.get('task-one')).toMatchObject({ status: 'delegated', touchedFiles: ['src/two.ts'] });
    expect(registry.get('task-two')?.touchedFiles).toEqual(['src/two.ts']);
    registry.close();
  });

  it('projects external CI recovery run/task ids from assignment events', () => {
    const registry = makeRegistry();
    registry.createOrGet({
      taskId: 'ci-android-release-recovery-33034747853',
      topLevelTaskId: 'ci-android-release-recovery-33034747853',
      objective: 'Android Release Build/Create GitHub Release recovery',
      classification: 'independent_top_level',
      currentRevision: '0c59b53b581e14ec195e12701416850a25d591b4',
    });
    registry.createAssignment({ taskId: 'ci-android-release-recovery-33034747853', role: 'coordinator', identity: identity('deck_cd_brain'), required: false });
    const target = identity('deck_sub_0h4a1o3i');
    const assignment = registry.createAssignment({
      taskId: 'ci-android-release-recovery-33034747853',
      assignmentId: 'ci-release-recovery-pi1-v1',
      role: 'implementer',
      identity: target,
      scopeFiles: ['.github/workflows/android-release.yml'],
      required: true,
    });
    if (!assignment.ok) throw new Error('assignment should create');
    expect(registry.updateAssignment({
      assignmentId: 'ci-release-recovery-pi1-v1',
      identity: target,
      status: 'retrying_external_ci',
      externalRunId: '33034747853',
      externalHeadSha: '0c59b53b581e14ec195e12701416850a25d591b4',
      externalTaskId: 'ci-android-release-recovery-33034747853',
      blocker: 'Android Release Build/Create GitHub Release transient Unicorn; all tests/build/typecheck/lint passed; 3/4 assets uploaded, global APK missing.',
    }).ok).toBe(true);
    let task = registry.get('ci-android-release-recovery-33034747853');
    expect(task?.status).toBe('retrying_external_ci');
    expect(task?.assignments.find((item) => item.assignmentId === 'ci-release-recovery-pi1-v1')).toMatchObject({
      status: 'retrying_external_ci',
      externalRunId: '33034747853',
      externalHeadSha: '0c59b53b581e14ec195e12701416850a25d591b4',
      externalTaskId: 'ci-android-release-recovery-33034747853',
      blocker: expect.stringContaining('transient Unicorn'),
    });
    expect(registry.updateAssignment({ assignmentId: 'ci-release-recovery-pi1-v1', identity: target, status: 'recovered' }).ok).toBe(true);
    expect(registry.updateAssignment({ assignmentId: 'ci-release-recovery-pi1-v1', identity: target, status: 'finalized' }).ok).toBe(true);
    task = registry.get('ci-android-release-recovery-33034747853');
    expect(task?.status).toBe('finalized');
    expect(task?.assignments.find((item) => item.assignmentId === 'ci-release-recovery-pi1-v1')).toMatchObject({ status: 'finalized', externalRunId: '33034747853' });
    expect(registry.listEvents('ci-android-release-recovery-33034747853').map((event) => event.eventType)).toEqual(expect.arrayContaining(['retrying_external_ci', 'recovered', 'finalized']));
    registry.close();
  });

  it('send_message task metadata creates one assignment and idempotency replay reuses it', async () => {
    const sessions = [session('deck_alpha_brain'), session('deck_alpha_w1')];
    const dispatchMessage = vi.fn(async () => undefined);
    const result = await dispatchSendMessage({ userId: 'u', sessionName: 'deck_alpha_brain', projectName: 'alpha', projectRoot: '/work/alpha' }, {
      target: 'deck_alpha_w1', message: 'do task', idempotencyKey: 'same', task: { topLevelTaskId: 'top', objective: 'task via send', ownedFiles: ['src/a.ts'] },
    }, { listSessions: () => sessions, dispatchMessage, exactTargetOnly: true, ensureSupervisionAssignmentWorktree: ensureTestAssignmentWorktree });
    const replay = await dispatchSendMessage({ userId: 'u', sessionName: 'deck_alpha_brain', projectName: 'alpha', projectRoot: '/work/alpha' }, {
      target: 'deck_alpha_w1', message: 'do task', idempotencyKey: 'same', task: { topLevelTaskId: 'top', objective: 'task via send', ownedFiles: ['src/a.ts'] },
    }, { listSessions: () => sessions, dispatchMessage, exactTargetOnly: true, ensureSupervisionAssignmentWorktree: ensureTestAssignmentWorktree });
    if (result.status !== 'accepted' || replay.status !== 'accepted') throw new Error('expected accepted');
    expect(result.taskId).toBeTruthy();
    expect(result.assignmentId).toBeTruthy();
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.taskId).toBe(result.taskId);
    expect(replay.assignmentId).toBe(result.assignmentId);
    expect(result.deliveries[0]).toMatchObject({ delegationId: expect.any(String) });
    const sent = String(dispatchMessage.mock.calls[0]?.[1] ?? '');
    expect(sent).toContain('"tool":"delegation_reply"');
    expect(sent).toContain('"contractRefs":["supervision_messaging_v1"]');
    expect(sent).toContain(`"taskId":"${result.taskId}"`);
    expect(sent).toContain(`"assignmentId":"${result.assignmentId}"`);
    expect(sent).toContain('"onBlock":"reply_immediately"');
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
    expect(dispatchMessage.mock.calls[0]?.[2]).toMatchObject({
      supervision: { taskId: result.taskId, assignmentId: result.assignmentId },
    });
    expect(getSupervisionTaskRegistry().get(result.taskId!)?.assignments[0]?.executionBinding).toMatchObject({
      pool: 'primary',
      requested: { providerFamily: 'openai', model: 'gpt-5.6' },
      actual: { sessionName: 'deck_alpha_w1', sessionInstanceId: 'instance-deck_alpha_w1', runtimeEpoch: 'epoch-deck_alpha_w1', model: 'gpt-5.6' },
      origin: 'reused',
    });
  });

  it('creates and verifies the exact worktree before live-hook delivery for exact-target and autoProvision tasks', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'imcodes-send-worktree-e2e-'));
    const source = join(temp, 'source');
    const worktrees = join(temp, 'worktrees');
    mkdirSync(source, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: source });
    writeFileSync(join(source, 'fixture.txt'), 'base\n');
    execFileSync('git', ['add', 'fixture.txt'], { cwd: source });
    execFileSync('git', ['-c', 'user.name=IM.codes Test', '-c', 'user.email=test@im.codes', 'commit', '-qm', 'base'], { cwd: source });
    const baseRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
    const priorRoot = process.env.IMCODES_WORKTREES_ROOT;
    process.env.IMCODES_WORKTREES_ROOT = worktrees;

    const brain = session('deck_alpha_brain');
    const exactWorker = session('deck_sub_exact_worker');
    const autoWorker = session('deck_sub_auto_worker');
    for (const item of [brain, exactWorker, autoWorker]) item.projectDir = source;
    exactWorker.parentSession = brain.name;
    autoWorker.parentSession = brain.name;
    const sessions = [brain, exactWorker, autoWorker];
    const deliveryOrder: string[] = [];
    const liveDispatch = async (target: SessionRecord, message: string, options: { supervision?: { taskId: string; assignmentId: string } }) => {
      if (!options.supervision) throw new Error('missing supervision transport binding');
      const expectedRepo = resolveSupervisionAssignmentWorktree({
        sessionName: target.name,
        assignmentId: options.supervision.assignmentId,
      });
      expect(existsSync(expectedRepo)).toBe(true);
      const hook = await dispatchHookSend({
        from: brain.name,
        targetRecords: [target],
        message,
        projectRoot: source,
        supervision: options.supervision,
      }, {
        listSessions: () => sessions,
        getSession: (name) => sessions.find((item) => item.name === name),
        dispatchMessage: async () => {
          expect(existsSync(expectedRepo)).toBe(true);
          expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: expectedRepo, encoding: 'utf8' }).trim()).toBe(baseRevision);
          deliveryOrder.push(target.name);
        },
      });
      if (hook.errors.length > 0) throw new Error(hook.errors.join('; '));
    };

    try {
      const caller = { userId: 'u', sessionName: brain.name, projectName: 'alpha', projectRoot: source };
      const exact = await dispatchSendMessage(caller, {
        target: exactWorker.name,
        message: 'exact target',
        idempotencyKey: 'worktree-e2e-exact',
        task: { objective: 'exact target worktree', baseRevision },
      }, { listSessions: () => sessions, dispatchMessage: liveDispatch, exactTargetOnly: true });
      expect(exact).toMatchObject({ status: 'accepted', assignmentId: expect.any(String) });

      const provisionSupervisionTarget = vi.fn(async () => ({
        ok: true as const,
        target: autoWorker,
        evidence: {
          selectedPool: 'primary' as const,
          selectedConfig: {
            agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport' as const, model: 'gpt-5.6',
            capabilityId: buildSupervisionExecutionCapabilityId({
              agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport', model: 'gpt-5.6',
            }),
          },
          createdSessionName: autoWorker.name,
        },
      }));
      const automatic = await dispatchSendMessage(caller, {
        message: 'automatic target',
        idempotencyKey: 'worktree-e2e-auto',
        task: { objective: 'automatic target worktree', baseRevision, autoProvision: true, executionPool: 'primary' },
      }, { listSessions: () => sessions, dispatchMessage: liveDispatch, exactTargetOnly: true, provisionSupervisionTarget });
      expect(automatic).toMatchObject({ status: 'accepted', assignmentId: expect.any(String) });
      expect(deliveryOrder).toEqual([exactWorker.name, autoWorker.name]);
    } finally {
      if (priorRoot === undefined) delete process.env.IMCODES_WORKTREES_ROOT;
      else process.env.IMCODES_WORKTREES_ROOT = priorRoot;
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('rejects an explicit binding when the live target agentType differs without ensure, dispatch, or registry mutation', async () => {
    const brain = session('deck_alpha_brain');
    const target = session('deck_sub_identity_target', 'alpha', 'codex');
    const sessions = [brain, target];
    const registry = getSupervisionTaskRegistry();
    const taskId = 'hook-agent-type-mismatch-task';
    const assignmentId = 'hook-agent-type-mismatch-assignment';
    expect(registry.createOrGet({ taskId, projectName: 'alpha', objective: 'agent type mismatch' }).ok).toBe(true);
    expect(registry.createAssignment({
      taskId, assignmentId, role: 'implementer', scopeFiles: [],
      identity: { ...identity(target.name, 'codex-sdk'), providerFamily: 'openai' },
    }).ok).toBe(true);
    const before = JSON.stringify(registry.get(taskId));
    const eventCount = registry.listEvents(taskId).length;
    const ensure = vi.fn();
    const dispatchMessage = vi.fn();

    const result = await dispatchHookSend({
      from: brain.name,
      targetRecords: [target],
      message: 'must refuse wrong agent type',
      projectRoot: '/work/alpha',
      supervision: { taskId, assignmentId },
    }, {
      listSessions: () => sessions,
      getSession: (name) => sessions.find((item) => item.name === name),
      ensureSupervisionAssignmentWorktree: ensure,
      dispatchMessage,
    });

    expect(result).toMatchObject({
      delivered: [], queued: [],
      errors: [expect.stringContaining('supervision binding does not match the live task, implementer, and target identity')],
    });
    expect(ensure).not.toHaveBeenCalled();
    expect(dispatchMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(registry.get(taskId))).toBe(before);
    expect(registry.listEvents(taskId)).toHaveLength(eventCount);
  });

  it('rejects stale-bridge fallback when the resolved live providerFamily differs without ensure, dispatch, or registry mutation', async () => {
    const brain = session('deck_alpha_brain');
    const target = session('deck_sub_provider_target');
    target.providerId = 'anthropic';
    const sessions = [brain, target];
    const registry = getSupervisionTaskRegistry();
    const taskId = 'hook-provider-mismatch-task';
    const assignmentId = 'hook-provider-mismatch-assignment';
    expect(registry.createOrGet({ taskId, projectName: 'alpha', objective: 'provider mismatch' }).ok).toBe(true);
    expect(registry.createAssignment({
      taskId, assignmentId, role: 'implementer', scopeFiles: [],
      identity: { ...identity(target.name, target.agentType), providerFamily: 'openai' },
    }).ok).toBe(true);
    const before = JSON.stringify(registry.get(taskId));
    const eventCount = registry.listEvents(taskId).length;
    const ensure = vi.fn();
    const dispatchMessage = vi.fn();

    const result = await dispatchHookSend({
      from: brain.name,
      targetRecords: [target],
      message: 'stale bridge must refuse wrong provider',
      projectRoot: '/work/alpha',
    }, {
      listSessions: () => sessions,
      getSession: (name) => sessions.find((item) => item.name === name),
      ensureSupervisionAssignmentWorktree: ensure,
      dispatchMessage,
    });

    expect(result).toMatchObject({
      delivered: [], queued: [],
      errors: [expect.stringContaining('active implementer identity does not match the live target agent/provider')],
    });
    expect(ensure).not.toHaveBeenCalled();
    expect(dispatchMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(registry.get(taskId))).toBe(before);
    expect(registry.listEvents(taskId)).toHaveLength(eventCount);
  });

  it('send_message provisions before dispatch and durably projects the selected pool/config/session evidence', async () => {
    const brain = session('deck_alpha_brain');
    const worker = session('deck_sub_auto_worker');
    worker.parentSession = brain.name;
    worker.label = 'Auto primary';
    const sessions = [brain, worker];
    const selectedConfig = {
      agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport' as const, model: 'gpt-5.6',
      capabilityId: buildSupervisionExecutionCapabilityId({
        agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport', model: 'gpt-5.6',
      }),
    };
    const order: string[] = [];
    const dispatchMessage = vi.fn(async () => { order.push('dispatch'); });
    const ensureSupervisionAssignmentWorktree = vi.fn(async (input: { assignmentId: string }) => {
      order.push('worktree');
      return {
        ok: true as const,
        worktreePath: `/worktrees/${input.assignmentId}/repo`,
        baseRevision: 'c'.repeat(40),
        created: true,
      };
    });
    const provisionSupervisionTarget = vi.fn(async () => ({
      ok: true as const,
      target: worker,
      evidence: {
        selectedPool: 'primary' as const,
        selectedConfig,
        provisionAttemptId: 'supervision_provision_test',
        createdSessionName: worker.name,
      },
    }));

    const sent = await dispatchSendMessage(
      { userId: 'u', sessionName: brain.name, projectName: 'alpha', projectRoot: '/work/alpha' },
      {
        message: 'provision then dispatch',
        idempotencyKey: 'auto-provision-task',
        task: { autoProvision: true, executionPool: 'primary', objective: 'automatic capacity' },
      },
      { listSessions: () => sessions, dispatchMessage, exactTargetOnly: true, provisionSupervisionTarget, ensureSupervisionAssignmentWorktree },
    );

    expect(provisionSupervisionTarget).toHaveBeenCalledTimes(1);
    expect(ensureSupervisionAssignmentWorktree).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['worktree', 'dispatch']);
    expect(dispatchMessage).toHaveBeenCalledWith(worker, expect.stringContaining('provision then dispatch'), expect.objectContaining({
      supervision: { taskId: sent.taskId, assignmentId: sent.assignmentId },
    }));
    expect(sent).toMatchObject({
      status: 'accepted',
      provisioning: { selectedPool: 'primary', provisionAttemptId: 'supervision_provision_test', createdSessionName: worker.name },
    });
    if (sent.status !== 'accepted' || !sent.assignmentId) throw new Error('expected provisioned assignment');
    expect(String(dispatchMessage.mock.calls[0]?.[1])).toContain(`/worktrees/${sent.assignmentId}/repo`);
    expect(String(dispatchMessage.mock.calls[0]?.[1])).toContain('c'.repeat(40));
    expect(getSupervisionTaskRegistry().get(sent.taskId!)).toMatchObject({ baseRevision: 'c'.repeat(40) });
    expect(getSupervisionTaskRegistry().getAssignment(sent.assignmentId)).toMatchObject({
      executionBinding: { origin: 'spawned', actual: { sessionName: worker.name } },
      provisioning: { selectedConfig, createdSessionName: worker.name },
    });
  });

  it('does not dispatch a missing-worktree assignment and retries the same object after recovery', async () => {
    const brain = session('deck_alpha_brain');
    const worker = session('deck_alpha_w1');
    const sessions = [brain, worker];
    const dispatchMessage = vi.fn(async () => undefined);
    const ensureSupervisionAssignmentWorktree = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: 'create_failed', detail: 'simulated interrupted git worktree add' })
      .mockImplementation(async (input: { assignmentId: string }) => ({
        ok: true as const,
        worktreePath: `/worktrees/${input.assignmentId}/repo`,
        baseRevision: 'd'.repeat(40),
        created: true,
      }));
    const request = {
      target: worker.name,
      message: 'deliver only after worktree recovery',
      idempotencyKey: 'missing-worktree-recovery',
      task: { objective: 'recover same assignment' },
    } as const;
    const caller = { userId: 'u', sessionName: brain.name, projectName: 'alpha', projectRoot: '/work/alpha' };
    const deps = { listSessions: () => sessions, dispatchMessage, exactTargetOnly: true, ensureSupervisionAssignmentWorktree };

    const failed = await dispatchSendMessage(caller, request, deps);
    expect(failed).toMatchObject({
      status: 'error', reason: 'validation_failed',
      error: expect.stringContaining('create_failed: simulated interrupted git worktree add'),
    });
    expect(dispatchMessage).not.toHaveBeenCalled();
    const afterFailure = getSupervisionTaskRegistry().list();
    expect(afterFailure).toHaveLength(1);
    expect(afterFailure[0]).toMatchObject({
      status: 'delegated',
      assignments: expect.arrayContaining([expect.objectContaining({ role: 'implementer', status: 'delegated' })]),
    });
    const failedAssignmentId = afterFailure[0]!.assignments.find((assignment) => assignment.role === 'implementer')!.assignmentId;

    const recovered = await dispatchSendMessage(caller, request, deps);
    expect(recovered).toMatchObject({ status: 'accepted', taskId: afterFailure[0]!.taskId, assignmentId: failedAssignmentId });
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
    expect(getSupervisionTaskRegistry().list()).toHaveLength(1);
    expect(getSupervisionTaskRegistry().get(afterFailure[0]!.taskId)?.assignments.filter((assignment) => assignment.role === 'implementer'))
      .toHaveLength(1);
  });

  it('persists an availability-driven same-family audit degradation without changing the Brain-named route', async () => {
    const brain = session('deck_alpha_brain');
    const audited = session('deck_sub_audited');
    audited.parentSession = brain.name;
    const reviewer = session('deck_sub_reviewer');
    reviewer.parentSession = brain.name;
    const sessions = [brain, audited, reviewer];
    const selectedConfig = {
      agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport' as const, model: 'gpt-5.6',
      capabilityId: buildSupervisionExecutionCapabilityId({
        agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport', model: 'gpt-5.6',
      }),
    };
    const dispatchMessage = vi.fn(async () => undefined);

    const sent = await dispatchSendMessage(
      { userId: 'u', sessionName: brain.name, projectName: 'alpha', projectRoot: '/work/alpha' },
      {
        message: 'independent degraded audit',
        reply: true,
        idempotencyKey: 'audit-degraded-once',
        audit: {
          kind: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
          attemptId: 'attempt-degraded-12345678',
          auditedSessionName: audited.name,
        },
        task: { autoProvision: true, objective: 'audit the implementation', classification: 'integration_task' },
      },
      {
        listSessions: () => sessions,
        dispatchMessage,
        exactTargetOnly: true,
        provisionSupervisionTarget: async () => ({
          ok: true,
          target: reviewer,
          auditRoutingReason: 'same_family_degraded',
          auditDegradedReason: 'cross_vendor_provision_failed',
          evidence: {
            selectedPool: 'audit', selectedConfig,
            failureReason: 'launch_failed', degradedReason: 'cross_vendor_provision_failed',
          },
        }),
      },
    );

    expect(sent).toMatchObject({
      status: 'accepted',
      auditRoutingReason: 'same_family_degraded',
      auditDegradedReason: 'cross_vendor_provision_failed',
      provisioning: { selectedPool: 'audit', failureReason: 'launch_failed' },
    });
    expect(dispatchMessage).toHaveBeenCalledWith(reviewer, expect.any(String), expect.any(Object));
    if (sent.status !== 'accepted' || !sent.assignmentId) throw new Error('expected degraded audit assignment');
    expect(getSupervisionTaskRegistry().getAssignment(sent.assignmentId)).toMatchObject({
      role: 'auditor',
      identity: { sessionName: reviewer.name },
      auditRoutingReason: 'same_family_degraded',
      auditDegradedReason: 'cross_vendor_provision_failed',
      provisioning: { failureReason: 'launch_failed', degradedReason: 'cross_vendor_provision_failed' },
    });
  });

  it('keeps one canonical provider identity across send_message and delegate task-report tools', async () => {
    const selected = {
      agentType: 'claude-code-sdk',
      providerFamily: 'anthropic',
      runtimeType: 'transport' as const,
      model: 'opus[1M]',
    };
    const brain = session('deck_alpha_brain');
    brain.transportConfig = {
      supervision: {
        mode: 'off',
        executionPools: {
          state: 'configured',
          primaryDevelopmentPool: {
            configs: [{
              ...selected,
              capabilityId: buildSupervisionExecutionCapabilityId(selected),
            }],
          },
          economyTaskPool: { configs: [] },
        },
      },
    } as SessionRecord['transportConfig'];
    const worker = session('deck_alpha_w1', 'alpha', 'claude-code-sdk');
    worker.requestedModel = 'claude-opus-5';
    worker.activeModel = 'claude-opus-5';
    const sessions = [brain, worker];

    const sent = await dispatchSendMessage(
      { userId: 'u', sessionName: brain.name, projectName: 'alpha', projectRoot: '/work/alpha' },
      {
        target: worker.name,
        message: 'implement the cross-entrypoint task',
        idempotencyKey: 'cross-entrypoint-provider-family',
        task: { objective: 'canonical provider family', ownedFiles: ['src/cross-entrypoint.ts'] },
      },
      { listSessions: () => sessions, dispatchMessage: async () => undefined, exactTargetOnly: true, ensureSupervisionAssignmentWorktree: ensureTestAssignmentWorktree },
    );
    expect(sent).toMatchObject({ status: 'accepted', taskId: expect.any(String), assignmentId: expect.any(String) });
    if (sent.status !== 'accepted' || !sent.assignmentId || !sent.taskId) throw new Error('expected task assignment');

    const registry = getSupervisionTaskRegistry();
    const assignment = registry.getAssignment(sent.assignmentId);
    expect(assignment?.identity).toMatchObject({
      sessionName: worker.name,
      agentType: 'claude-code-sdk',
      providerFamily: 'anthropic',
    });
    if (!assignment) throw new Error('assignment missing');

    const handlers = createMemoryMcpToolHandlers(
      { userId: 'u', sessionName: worker.name, projectName: 'alpha', projectRoot: '/work/alpha' },
      { sendDeps: { listSessions: () => sessions } },
    );
    expect(await handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_UPDATE]({
      assignmentId: assignment.assignmentId,
      revision: 'revision-1',
      verdict: 'FINISHED',
    })).toMatchObject({ status: 'ok' });
    expect(registry.get(assignment.taskId)).toMatchObject({ currentRevision: 'revision-1' });
    expect(registry.getAssignment(assignment.assignmentId)).toMatchObject({
      auditRevision: 'revision-1',
      verdict: 'FINISHED',
    });
    const boundTask = registry.get(assignment.taskId);
    const boundAssignment = registry.getAssignment(assignment.assignmentId);
    const boundEventCount = registry.listEvents(assignment.taskId).length;
    expect(await handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_UPDATE]({
      assignmentId: assignment.assignmentId,
      revision: 'revision-2',
      verdict: 'FINISHED-again',
    })).toMatchObject({ status: 'error', reason: 'validation_failed' });
    expect(registry.get(assignment.taskId)).toEqual(boundTask);
    expect(registry.getAssignment(assignment.assignmentId)).toEqual(boundAssignment);
    expect(registry.listEvents(assignment.taskId)).toHaveLength(boundEventCount);
    expect(await handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FILE_EVENT]({
      assignmentId: assignment.assignmentId,
      filePath: 'src/cross-entrypoint.ts',
      operation: 'modify',
      beforeHash: 'before',
      afterHash: 'after',
    })).toMatchObject({ status: 'ok' });

    for (const status of [
      'implementing', 'validated', 'ready_for_audit', 'auditing', 'passed',
      'ready_for_integration', 'integrating', 'final_audit', 'passed',
      'finalizing', 'committed', 'pushed',
    ] as const) {
      expect(registry.updateAssignment({
        assignmentId: assignment.assignmentId,
        identity: assignment.identity,
        status,
      }).ok, status).toBe(true);
    }
    expect(await handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FINISH]({
      assignmentId: assignment.assignmentId,
      revision: 'revision-1',
      evidence: 'delegate completed',
    })).toMatchObject({ status: 'ok', item: { status: 'finalized' } });
  });

  it('synchronizes intent lifecycle and closes matching PASS assignments without treating read-only scope as evidence', async () => {
    const registry = getSupervisionTaskRegistry();
    const revision = 'task-worktree-core-r2';
    expect(registry.createOrGet({
      projectName: 'alpha', taskId: 'matching-pass-close', classification: 'integration_task',
      objective: 'close reachable lifecycle', currentRevision: revision,
    }).ok).toBe(true);
    const implementerIdentity = identity('deck_alpha_w1');
    const auditorIdentity = identity('deck_alpha_w2', 'claude-code-sdk');
    const implementationFiles = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'];
    const auditScope = [...implementationFiles, 'test/a.test.ts', 'test/b.test.ts'];
    const implementer = registry.createAssignment({
      taskId: 'matching-pass-close', role: 'implementer', identity: implementerIdentity,
      scopeFiles: implementationFiles, claimMode: 'exclusive',
    });
    const auditor = registry.createAssignment({
      taskId: 'matching-pass-close', role: 'auditor', identity: auditorIdentity,
      scopeFiles: auditScope, claimMode: 'read_only', auditAttemptId: 'audit-attempt-exact', auditRevision: revision,
    });
    if (!implementer.ok || !auditor.ok) throw new Error('expected assignments');

    const ownerIntent = createSupervisionMcpToolHandlers(
      { sessionName: implementerIdentity.sessionName } as never,
      { registry: createSupervisionRegistryPort() },
    );
    expect(await ownerIntent[SUPERVISION_MCP_TOOLS.INTENT]({
      intent: 'start', taskId: 'matching-pass-close', assignmentId: implementer.value.assignmentId,
    })).toMatchObject({ status: 'ok', fromStatus: 'delegated', toStatus: 'implementing' });
    expect(registry.get('matching-pass-close')).toMatchObject({
      status: 'implementing',
      assignments: expect.arrayContaining([expect.objectContaining({ assignmentId: implementer.value.assignmentId, status: 'implementing' })]),
    });
    expect(await ownerIntent[SUPERVISION_MCP_TOOLS.INTENT]({
      intent: 'record_validation', validationState: 'passed',
      taskId: 'matching-pass-close', assignmentId: implementer.value.assignmentId,
    })).toMatchObject({ status: 'ok', fromStatus: 'implementing', toStatus: 'validated' });
    expect(registry.get('matching-pass-close')).toMatchObject({
      status: 'validated',
      assignments: expect.arrayContaining([expect.objectContaining({ assignmentId: implementer.value.assignmentId, status: 'validated' })]),
    });
    expect(await ownerIntent[SUPERVISION_MCP_TOOLS.INTENT]({
      intent: 'open_audit', taskId: 'matching-pass-close', assignmentId: implementer.value.assignmentId,
    })).toMatchObject({ status: 'ok', fromStatus: 'validated', toStatus: 'ready_for_audit' });

    // A persisted structured verdict is the evidence. The auditor can still be
    // in the legacy delegated state; status skew and scope metadata cannot
    // erase/substitute the exact revision bind.
    expect(registry.updateAssignment({
      assignmentId: auditor.value.assignmentId,
      identity: auditorIdentity,
      status: 'delegated',
      auditAttemptId: 'audit-attempt-exact',
      auditRevision: revision,
      verdict: 'PASS',
    })).toMatchObject({ ok: true });

    const ownerTaskTools = createMemoryMcpToolHandlers(
      { userId: 'u', sessionName: implementerIdentity.sessionName, projectName: 'alpha', projectRoot: '/work/alpha' },
      { sendDeps: { listSessions: () => [session('deck_alpha_brain'), session(implementerIdentity.sessionName), session(auditorIdentity.sessionName, 'alpha', 'claude-code-sdk')] } },
    );
    await expect(ownerTaskTools[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FINISH]({
      assignmentId: implementer.value.assignmentId,
      revision: 'wrong-revision',
    })).resolves.toMatchObject({ status: 'error' });
    expect(registry.getAssignment(implementer.value.assignmentId)).toMatchObject({
      status: 'ready_for_audit', leaseId: expect.stringMatching(/^(?:lse|supervision_lease)_/),
    });
    expect(registry.listFileClaims('matching-pass-close')).toEqual([]);

    await expect(ownerTaskTools[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FINISH]({
      assignmentId: implementer.value.assignmentId,
      revision,
      evidence: 'matching PASS accepted',
    })).resolves.toMatchObject({
      status: 'ok',
      item: {
        status: 'ready_for_integration', leaseId: '', verdict: 'PASS',
        auditAttemptId: 'audit-attempt-exact', auditRevision: revision,
      },
    });
    expect(registry.get('matching-pass-close')).toMatchObject({ status: 'ready_for_integration' });
    expect(registry.listFileClaims('matching-pass-close')).toEqual([]);

    const auditorIntent = createSupervisionMcpToolHandlers(
      { sessionName: auditorIdentity.sessionName } as never,
      { registry: createSupervisionRegistryPort() },
    );
    await expect(auditorIntent[SUPERVISION_MCP_TOOLS.INTENT]({
      intent: 'finish', taskId: 'matching-pass-close', assignmentId: auditor.value.assignmentId,
    })).resolves.toMatchObject({ status: 'ok', toStatus: 'finalized' });
    expect(registry.getAssignment(auditor.value.assignmentId)).toMatchObject({ status: 'finalized', leaseId: '' });
    expect(registry.listFileClaims('matching-pass-close')).toEqual([]);

    // Replaying the implementer finish through the intent path is idempotent
    // and cannot recreate claims or a lease.
    await expect(ownerIntent[SUPERVISION_MCP_TOOLS.INTENT]({
      intent: 'finish', taskId: 'matching-pass-close', assignmentId: implementer.value.assignmentId,
    })).resolves.toMatchObject({ status: 'ok', toStatus: 'ready_for_integration', idempotentReplay: true });
  });

  it('recovers an exact PASS revision after legacy finish cleared the lease without binding the task revision', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-finish-revision-recovery-'));
    const dbPath = join(dir, 'supervision-state.sqlite');
    const revision = 'integration-revision-r1';
    const roles = ['coordinator', 'integration_owner', 'implementer'] as const;
    const targets: Array<{
      taskId: string;
      assignmentId: string;
      owner: PersistedSupervisionTaskAssignmentIdentity;
    }> = [];
    try {
      let registry = new SupervisionTaskRegistry({ dbPath });
      for (const role of roles) {
        const taskId = `finish-revision-${role}`;
        const owner = identity(`deck_alpha_${role}`);
        const auditorIdentity = identity(`deck_alpha_${role}_auditor`, 'claude-code-sdk');
        expect(registry.createOrGet({
          taskId, projectName: 'alpha', classification: 'integration_task',
          objective: `finish ${role}`, currentRevision: revision,
        }).ok).toBe(true);
        const target = registry.createAssignment({ taskId, role, identity: owner });
        const staleAuditorIdentity = identity(`deck_alpha_${role}_stale_auditor`, 'claude-code-sdk');
        const staleAuditor = registry.createAssignment({
          taskId, role: 'auditor', identity: staleAuditorIdentity,
          auditAttemptId: `stale-attempt-${role}`, auditRevision: 'older-revision',
        });
        if (!target.ok || !staleAuditor.ok) throw new Error('expected initial finalization assignments');
        for (const status of ['auditing', 'rework'] as const) {
          expect(registry.updateAssignment({
            assignmentId: staleAuditor.value.assignmentId,
            identity: staleAuditorIdentity,
            status,
            auditAttemptId: `stale-attempt-${role}`,
            auditRevision: 'older-revision',
            ...(status === 'rework' ? { verdict: 'REWORK' } : {}),
          }).ok, `${role}:stale-auditor:prepare:${status}`).toBe(true);
        }
        const auditor = registry.createAssignment({
          taskId, role: 'auditor', identity: auditorIdentity,
          auditAttemptId: `attempt-${role}`, auditRevision: revision,
        });
        if (!auditor.ok) throw new Error('expected current finalization auditor');

        for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing', 'passed', 'ready_for_integration'] as const) {
          expect(registry.updateAssignment({
            assignmentId: target.value.assignmentId,
            identity: owner,
            status,
            auditAttemptId: `attempt-${role}`,
            auditRevision: revision,
            ...(status === 'passed' || status === 'ready_for_integration'
              ? { verdict: 'PASS', crossVendorAuditPassed: true }
              : {}),
          }).ok, `${role}:${status}`).toBe(true);
        }
        for (const status of ['auditing', 'passed'] as const) {
          expect(registry.updateAssignment({
            assignmentId: auditor.value.assignmentId,
            identity: auditorIdentity,
            status,
            auditAttemptId: `attempt-${role}`,
            auditRevision: revision,
            ...(status === 'passed' ? { verdict: 'PASS', crossVendorAuditPassed: true } : {}),
          }).ok, `${role}:auditor:${status}`).toBe(true);
        }
        for (const status of ['auditing', 'passed'] as const) {
          expect(registry.updateAssignment({
            assignmentId: staleAuditor.value.assignmentId,
            identity: staleAuditorIdentity,
            status,
            auditAttemptId: `stale-attempt-${role}`,
            auditRevision: 'older-revision',
            ...(status === 'passed' ? { verdict: 'PASS', crossVendorAuditPassed: true } : {}),
          }).ok, `${role}:stale-auditor:${status}`).toBe(true);
        }
        expect(registry.finishAssignment({
          assignmentId: target.value.assignmentId, identity: owner, revision,
        })).toMatchObject({ ok: true, value: { status: 'ready_for_integration', leaseId: '' } });
        targets.push({ taskId, assignmentId: target.value.assignmentId, owner });
      }
      registry.close();

      // Reproduce the persisted production defect exactly: a prior finish
      // durably copied the matching audit onto the assignment and revoked its
      // lease, but left task.currentRevision NULL. Two accepted exact revision
      // updates validate the assignment bind without repairing that task row.
      const db = new DatabaseSync(dbPath);
      for (const { taskId } of targets) {
        const row = db.prepare('SELECT payload_json AS payloadJson FROM supervision_tasks WHERE task_id = ?')
          .get(taskId) as { payloadJson: string };
        const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
        delete payload.currentRevision;
        db.prepare('UPDATE supervision_tasks SET current_revision = NULL, payload_json = ? WHERE task_id = ?')
          .run(JSON.stringify(payload), taskId);
      }
      db.close();

      registry = new SupervisionTaskRegistry({ dbPath });
      for (const target of targets) {
        expect(registry.getTaskRecord(target.taskId)?.currentRevision).toBeUndefined();
        for (let retry = 0; retry < 2; retry += 1) {
          expect(registry.updateAssignment({
            assignmentId: target.assignmentId,
            identity: target.owner,
            status: 'ready_for_integration',
            revision,
          }), `${target.taskId}:rebind:${retry}`).toMatchObject({ ok: true });
        }
        expect(registry.finishAssignment({
          assignmentId: target.assignmentId, identity: target.owner, revision: 'older-revision',
        })).toEqual({ ok: false, reason: 'old_revision' });
        const intent = createSupervisionMcpToolHandlers(
          { sessionName: target.owner.sessionName } as never,
          { registry: supervisionRegistryPort(registry) },
        );
        await expect(intent[SUPERVISION_MCP_TOOLS.INTENT]({
          intent: 'finish', taskId: target.taskId, assignmentId: target.assignmentId,
        })).resolves.toMatchObject({
          status: 'ok',
          intent: 'finish',
          toStatus: 'ready_for_integration',
          idempotentReplay: true,
          item: { status: 'ready_for_integration', leaseId: '', auditRevision: revision, verdict: 'PASS' },
        });
        expect(registry.getTaskRecord(target.taskId)?.currentRevision).toBe(revision);
        expect(registry.finishAssignment({
          assignmentId: target.assignmentId, identity: target.owner, revision: 'newer-revision',
        })).toEqual({ ok: false, reason: 'old_revision' });
      }
      registry.close();

      registry = new SupervisionTaskRegistry({ dbPath });
      for (const target of targets) {
        expect(registry.getTaskRecord(target.taskId)?.currentRevision).toBe(revision);
        expect(registry.finishAssignment({
          assignmentId: target.assignmentId, identity: target.owner,
        })).toMatchObject({ ok: true, replay: true });
      }
      registry.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('send_message binds a visible existing task and idempotency replay keeps the same assignment', async () => {
    const registry = getSupervisionTaskRegistry();
    const task = registry.createOrGet({ projectName: 'alpha', taskId: 'existing-visible-task', objective: 'existing task' });
    expect(task).toMatchObject({ ok: true, value: { taskId: 'existing-visible-task' } });
    expect(registry.createAssignment({
      taskId: 'existing-visible-task',
      role: 'coordinator',
      identity: identity('deck_alpha_brain'),
      scopeFiles: [],
    }).ok).toBe(true);

    const sessions = [session('deck_alpha_brain'), session('deck_alpha_w1')];
    const dispatchMessage = vi.fn(async () => undefined);
    const request = {
      target: 'deck_alpha_w1',
      message: 'continue the existing task',
      idempotencyKey: 'bind-existing-once',
      task: { taskId: 'existing-visible-task', objective: 'must not mint a replacement' },
    } as const;
    const deps = { listSessions: () => sessions, dispatchMessage, exactTargetOnly: true, ensureSupervisionAssignmentWorktree: ensureTestAssignmentWorktree };

    const first = await dispatchSendMessage(
      { userId: 'u', sessionName: 'deck_alpha_brain', projectName: 'alpha', projectRoot: '/work/alpha' },
      request,
      deps,
    );
    const replay = await dispatchSendMessage(
      { userId: 'u', sessionName: 'deck_alpha_brain', projectName: 'alpha', projectRoot: '/work/alpha' },
      request,
      deps,
    );

    expect(first).toMatchObject({ status: 'accepted', taskId: 'existing-visible-task' });
    if (first.status !== 'accepted' || replay.status !== 'accepted') throw new Error('expected accepted');
    expect(first.taskId).toBe('existing-visible-task');
    expect(replay).toMatchObject({
      idempotentReplay: true,
      taskId: 'existing-visible-task',
      assignmentId: first.assignmentId,
    });
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('existing-visible-task')?.assignments.map((item) => item.identity.sessionName).sort())
      .toEqual(['deck_alpha_brain', 'deck_alpha_w1']);
  });

  it('send_message appends to the exact existing assignment with busy FIFO fallback and never mints a replacement', async () => {
    const registry = getSupervisionTaskRegistry();
    const taskId = 'existing-task-exact-continuation';
    const revision = 'existing-task-exact-r1';
    expect(registry.createOrGet({
      projectName: 'alpha', taskId, objective: 'exact append', currentRevision: revision,
    })).toMatchObject({ ok: true });
    expect(registry.createAssignment({
      taskId, role: 'coordinator', identity: identity('deck_alpha_brain'), required: false,
    })).toMatchObject({ ok: true });
    const exact = registry.createAssignment({
      assignmentId: 'exact-continuation-assignment', taskId, role: 'implementer',
      identity: identity('deck_alpha_w1'), auditRevision: revision,
    });
    const historical = registry.createAssignment({
      assignmentId: 'other-continuation-assignment', taskId, role: 'implementer',
      identity: identity('deck_alpha_w2'), auditRevision: revision,
    });
    if (!exact.ok || !historical.ok) throw new Error('expected implementers');
    for (const status of ['implementing', 'validated', 'ready_for_audit'] as const) {
      expect(registry.updateAssignment({ assignmentId: exact.value.assignmentId, identity: exact.value.identity, status }))
        .toMatchObject({ ok: true });
    }
    const assignmentCount = registry.listAssignments(taskId).length;
    const sessions = [session('deck_alpha_brain'), session('deck_alpha_w1'), session('deck_alpha_w2')];
    sessions[1]!.state = 'busy';
    const dispatchMessage = vi.fn(async () => 'queued' as const);
    const deps = { listSessions: () => sessions, dispatchMessage, exactTargetOnly: true, ensureSupervisionAssignmentWorktree: ensureTestAssignmentWorktree };
    const caller = { userId: 'u', sessionName: 'deck_alpha_brain', projectName: 'alpha', projectRoot: '/work/alpha' };

    const sent = await dispatchSendMessage(caller, {
      target: 'deck_alpha_w1', message: 'append exact recovered work',
      task: { taskId, assignmentId: exact.value.assignmentId, currentRevision: revision },
    }, deps);
    expect(sent).toMatchObject({
      status: 'accepted', taskId, assignmentId: exact.value.assignmentId,
      deliveries: [expect.objectContaining({ target: 'deck_alpha_w1', status: 'queued' })],
    });
    expect(dispatchMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'deck_alpha_w1' }),
      expect.stringContaining('append exact recovered work'),
      expect.objectContaining({ deliveryMode: 'append' }),
    );
    const continuationMessage = String(dispatchMessage.mock.calls.at(-1)?.[1] ?? '');
    expect(continuationMessage).toContain('"contractRefs":["supervision_messaging_v1"]');
    expect(continuationMessage).toContain(`"taskId":"${taskId}"`);
    expect(continuationMessage).toContain(`"assignmentId":"${exact.value.assignmentId}"`);
    expect(continuationMessage).not.toContain('Delegated blocker escalation:');
    expect(continuationMessage).not.toContain('[Daemon-resolved development assignment]');
    expect(registry.listAssignments(taskId)).toHaveLength(assignmentCount);

    const ambiguous = await dispatchSendMessage(caller, {
      target: 'deck_alpha_w1', message: 'must not guess', task: { taskId, currentRevision: revision },
    }, deps);
    expect(ambiguous).toMatchObject({ status: 'error', reason: 'identity_rejected' });
    const wrong = await dispatchSendMessage(caller, {
      target: 'deck_alpha_w1', message: 'must not replace',
      task: { taskId, assignmentId: 'missing-assignment', currentRevision: revision },
    }, deps);
    expect(wrong).toMatchObject({ status: 'error', reason: 'identity_rejected' });
    expect(registry.listAssignments(taskId)).toHaveLength(assignmentCount);
  });

  it('send_message rejects missing and inaccessible explicit task ids without minting or dispatching', async () => {
    const registry = getSupervisionTaskRegistry();
    expect(registry.createOrGet({ projectName: 'alpha', taskId: 'other-owner-task', objective: 'private task' }).ok).toBe(true);
    expect(registry.createAssignment({
      taskId: 'other-owner-task',
      role: 'coordinator',
      identity: identity('deck_alpha_other'),
      scopeFiles: [],
    }).ok).toBe(true);
    const sessions = [session('deck_alpha_brain'), session('deck_alpha_w1')];
    const dispatchMessage = vi.fn(async () => undefined);
    const deps = { listSessions: () => sessions, dispatchMessage, exactTargetOnly: true };
    const runtimeCaller = { userId: 'u', sessionName: 'deck_alpha_brain', projectName: 'alpha', projectRoot: '/work/alpha' };

    const inaccessible = await dispatchSendMessage(runtimeCaller, {
      target: 'deck_alpha_w1', message: 'must not dispatch',
      task: { taskId: 'other-owner-task', objective: 'must not replace' },
    }, deps);
    const missing = await dispatchSendMessage(runtimeCaller, {
      target: 'deck_alpha_w1', message: 'must not dispatch',
      task: { taskId: 'missing-task', objective: 'must not create' },
    }, deps);

    expect(inaccessible).toEqual({
      status: 'error', reason: 'identity_rejected', error: 'task is not visible to this caller',
    });
    expect(missing).toEqual(inaccessible);
    expect(dispatchMessage).not.toHaveBeenCalled();
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('missing-task')).toBeUndefined();
  });

  it('MCP task_list/task_get use registry projection and reject unrelated session enumeration', async () => {
    const sessions = [session('deck_alpha_brain'), session('deck_alpha_w1'), session('deck_alpha_w2')];
    const handlers = createMemoryMcpToolHandlers({ userId: 'u', sessionName: 'deck_alpha_w1', projectName: 'alpha', projectRoot: '/work/alpha' }, { sendDeps: { listSessions: () => sessions } });
    const start = await handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START]({ role: 'implementer', objective: 'visible', scopeFiles: ['src/a.ts'], idempotencyKey: 'visible' });
    expect(start.status).toBe('ok');
    // list/get are now owned by the audited supervision handlers; the legacy
    // duplicates were removed in the consolidation merge.
    const own = createSupervisionMcpToolHandlers(
      { sessionName: 'deck_alpha_w1' } as never, { registry: supervisionRegistryPort() },
    );
    const list: any = await own[SUPERVISION_MCP_TOOLS.LIST]({});
    expect(list.status).toBe('ok');
    expect(list.tasks).toHaveLength(1);
    expect(list.tasks[0]?.taskId).toBe((start as { taskId: string }).taskId);
    const get: any = await own[SUPERVISION_MCP_TOOLS.GET]({ taskId: (start as { taskId: string }).taskId });
    expect(get.status).toBe('ok');

    const other = createSupervisionMcpToolHandlers(
      { sessionName: 'deck_alpha_w2' } as never, { registry: supervisionRegistryPort() },
    );
    const invisible = await other[SUPERVISION_MCP_TOOLS.GET]({ taskId: (start as { taskId: string }).taskId });
    expect(invisible).toMatchObject({ status: 'error', reason: 'identity_rejected' });
  });

  it('supervision_task_start treats taskId as a visible reference and replays one assignment', async () => {
    const registry = getSupervisionTaskRegistry();
    expect(registry.createOrGet({ projectName: 'alpha', taskId: 'existing-start-task', objective: 'existing' }).ok).toBe(true);
    expect(registry.createAssignment({
      taskId: 'existing-start-task', role: 'coordinator', identity: identity('deck_alpha_w1'), scopeFiles: [],
    }).ok).toBe(true);
    const sessions = [session('deck_alpha_brain'), session('deck_alpha_w1')];
    const handlers = createMemoryMcpToolHandlers(
      { userId: 'u', sessionName: 'deck_alpha_w1', projectName: 'alpha', projectRoot: '/work/alpha' },
      { sendDeps: { listSessions: () => sessions } },
    );
    const request = {
      taskId: 'existing-start-task', role: 'implementer', objective: 'join existing',
      scopeFiles: ['src/join.ts'], idempotencyKey: 'join-existing-once',
    } as const;
    const first = await handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START](request);
    const replay = await handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START]({
      ...request,
      scopeFiles: ['src/observed-later.ts'],
    });
    expect(first).toMatchObject({ status: 'ok', taskId: 'existing-start-task' });
    expect(replay).toMatchObject({
      status: 'ok', taskId: 'existing-start-task',
      assignmentId: first.assignmentId, idempotentReplay: true,
    });
    expect(registry.list({ projectName: 'alpha' })).toHaveLength(1);
    expect(registry.get('existing-start-task')?.assignments).toHaveLength(2);
    expect(registry.getAssignment(first.assignmentId as string)?.scopeFiles).toEqual(['src/join.ts']);
  });

  it('supervision_task_start makes missing, foreign-project and inaccessible task ids indistinguishable', async () => {
    const registry = getSupervisionTaskRegistry();
    expect(registry.createOrGet({ projectName: 'alpha', taskId: 'private-start-task', objective: 'private' }).ok).toBe(true);
    expect(registry.createAssignment({
      taskId: 'private-start-task', role: 'coordinator', identity: identity('deck_alpha_other'), scopeFiles: [],
    }).ok).toBe(true);
    expect(registry.createOrGet({ projectName: 'beta', taskId: 'foreign-start-task', objective: 'foreign' }).ok).toBe(true);
    expect(registry.createAssignment({
      taskId: 'foreign-start-task', role: 'coordinator', identity: identity('deck_alpha_w1'), scopeFiles: [],
    }).ok).toBe(true);
    const handlers = createMemoryMcpToolHandlers(
      { userId: 'u', sessionName: 'deck_alpha_w1', projectName: 'alpha', projectRoot: '/work/alpha' },
      { sendDeps: { listSessions: () => [session('deck_alpha_brain'), session('deck_alpha_w1')] } },
    );
    const results = await Promise.all(['missing-start-task', 'private-start-task', 'foreign-start-task'].map((taskId) => (
      handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START]({
        taskId, role: 'implementer', objective: 'must not reveal', idempotencyKey: `probe-${taskId}`,
      })
    )));
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(results[0]).toEqual({
      status: 'error', reason: 'identity_rejected', message: 'task is not visible to this caller', recoverable: false,
    });
    expect(registry.get('missing-start-task')).toBeUndefined();
    expect(registry.list()).toHaveLength(2);
  });

  it('atomically cancels unfinished assignments and revokes leases without claim authority after SQLite reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'supervision-cancel-release-'));
    const dbPath = join(dir, 'registry.sqlite');
    let registry = new SupervisionTaskRegistry({ dbPath });
    try {
      expect(registry.createOrGet({
        projectName: 'alpha', taskId: 'cancel-me', classification: 'integration_task', objective: 'cancel safely',
      }).ok).toBe(true);
      const owner = identity('deck_alpha_w1');
      const assignment = registry.createAssignment({
        taskId: 'cancel-me', role: 'implementer', identity: owner,
        scopeFiles: ['src/shared-after-cancel.ts'], claimMode: 'exclusive',
      });
      if (!assignment.ok) throw new Error(assignment.reason);

      expect(registry.createOrGet({ projectName: 'alpha', taskId: 'unrelated', objective: 'must survive' }).ok).toBe(true);
      const unrelated = registry.createAssignment({
        taskId: 'unrelated', role: 'implementer', identity: identity('deck_alpha_w2'),
        scopeFiles: ['src/unrelated.ts'], claimMode: 'exclusive',
      });
      if (!unrelated.ok) throw new Error(unrelated.reason);

      const port = () => ({
        getStatus: (taskId: string) => registry.get(taskId)?.status,
        applyIntent: (input: Parameters<SupervisionTaskRegistry['applyTaskIntent']>[0]) => {
          const applied = registry.applyTaskIntent(input);
          if (!applied.ok) throw new Error(applied.reason);
        },
        list: (filter: never) => registry.list(filter) as never,
        get: (taskId: string) => registry.get(taskId) as never,
        recover: () => {},
      });
      const handlers = createSupervisionMcpToolHandlers(
        { sessionName: owner.sessionName } as never,
        { registry: port() },
      );
      expect(await handlers[SUPERVISION_MCP_TOOLS.INTENT]({ intent: 'start', taskId: 'cancel-me' }))
        .toMatchObject({ status: 'ok', toStatus: 'implementing' });
      expect(await handlers[SUPERVISION_MCP_TOOLS.INTENT]({ intent: 'open_audit', taskId: 'cancel-me' }))
        .toMatchObject({ status: 'ok', toStatus: 'ready_for_audit' });
      expect(await handlers[SUPERVISION_MCP_TOOLS.INTENT]({
        intent: 'cancel', taskId: 'cancel-me', assignmentId: assignment.value.assignmentId,
        note: 'superseded by integration',
      })).toMatchObject({ status: 'ok', fromStatus: 'ready_for_audit', toStatus: 'cancelled' });

      let cancelled = registry.get('cancel-me');
      expect(cancelled).toMatchObject({
        status: 'ready_for_audit',
        assignments: [expect.objectContaining({
          assignmentId: assignment.value.assignmentId,
          status: 'cancelled',
          leaseId: '',
        })],
        fileClaims: [],
      });
      expect(registry.get('unrelated')).toMatchObject({
        status: 'delegated',
        assignments: [expect.objectContaining({
          assignmentId: unrelated.value.assignmentId,
          status: 'delegated',
          leaseId: expect.stringMatching(/^(?:lse|supervision_lease)_/),
        })],
        fileClaims: [],
      });

      const eventsAfterScopedCancel = registry.listEvents('cancel-me').length;
      expect(await handlers[SUPERVISION_MCP_TOOLS.INTENT]({
        intent: 'cancel', taskId: 'cancel-me', assignmentId: assignment.value.assignmentId,
      })).toMatchObject({ status: 'ok', fromStatus: 'ready_for_audit', toStatus: 'cancelled' });
      expect(registry.listEvents('cancel-me')).toHaveLength(eventsAfterScopedCancel);

      expect(registry.applyTaskIntent({
        intent: 'cancel', taskId: 'cancel-me', toStatus: 'cancelled', note: 'cancel whole task',
      })).toMatchObject({ ok: true, value: { status: 'cancelled' } });
      const eventsAfterTaskCancel = registry.listEvents('cancel-me').length;
      expect(await handlers[SUPERVISION_MCP_TOOLS.INTENT]({ intent: 'cancel', taskId: 'cancel-me' }))
        .toMatchObject({ status: 'ok', fromStatus: 'cancelled', toStatus: 'cancelled' });
      expect(registry.listEvents('cancel-me')).toHaveLength(eventsAfterTaskCancel);

      registry.close();
      registry = new SupervisionTaskRegistry({ dbPath });
      cancelled = registry.get('cancel-me');
      expect(cancelled?.fileClaims).toEqual([]);
      expect(cancelled?.assignments[0]).toMatchObject({ status: 'cancelled', leaseId: '' });

      expect(registry.createOrGet({ projectName: 'alpha', taskId: 'integration-now', objective: 'claim released file' }).ok).toBe(true);
      expect(registry.createAssignment({
        taskId: 'integration-now', role: 'integration_owner', identity: identity('deck_alpha_brain'),
        scopeFiles: ['src/shared-after-cancel.ts'], claimMode: 'exclusive',
      })).toMatchObject({ ok: true });
      expect(registry.createAssignment({
        taskId: 'integration-now', role: 'implementer', identity: identity('deck_alpha_w3'),
        scopeFiles: ['src/unrelated.ts'], claimMode: 'exclusive',
      })).toMatchObject({ ok: true });

      // The restricted admin recovery path must close the same stale-resource
      // shape rather than changing only the task row.
      expect(registry.createOrGet({ projectName: 'alpha', taskId: 'admin-stale', objective: 'recover stale owner' }).ok).toBe(true);
      const stale = registry.createAssignment({
        taskId: 'admin-stale', role: 'implementer', identity: identity('deck_alpha_stale'),
        scopeFiles: ['src/admin-released.ts'], claimMode: 'exclusive',
      });
      if (!stale.ok) throw new Error(stale.reason);
      expect(registry.recoverTask({
        taskId: 'admin-stale', toStatus: 'cancelled', reason: 'owner process ended',
      })).toMatchObject({ ok: true, value: { status: 'cancelled' } });
      expect(registry.getAssignment(stale.value.assignmentId)).toMatchObject({ status: 'cancelled', leaseId: '' });
      expect(registry.listFileClaims('admin-stale')).toEqual([]);
    } finally {
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists task-level cancel when every required assignment is already cancelled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'supervision-task-level-cancel-'));
    const dbPath = join(dir, 'registry.sqlite');
    let registry = new SupervisionTaskRegistry({ dbPath });
    try {
      const taskId = 'validated-with-retired-assignments';
      expect(registry.createOrGet({
        projectName: 'alpha', taskId, objective: 'cancel the durable task row',
      }).ok).toBe(true);

      const assignments = [
        { role: 'coordinator' as const, owner: identity('deck_alpha_brain') },
        { role: 'implementer' as const, owner: identity('deck_alpha_w1') },
        { role: 'integration_owner' as const, owner: identity('deck_alpha_owner') },
      ].map(({ role, owner }) => {
        const created = registry.createAssignment({ taskId, role, identity: owner, scopeFiles: [] });
        if (!created.ok) throw new Error(created.reason);
        expect(registry.applyTaskIntent({
          taskId, assignmentId: created.value.assignmentId,
          intent: 'cancel', toStatus: 'cancelled',
        })).toMatchObject({ ok: true });
        return created.value;
      });

      expect(registry.updateTask({ taskId, status: 'validated' })).toMatchObject({
        ok: true, value: { status: 'validated' },
      });
      expect(registry.get(taskId)?.assignments).toEqual(expect.arrayContaining(
        assignments.map((assignment) => expect.objectContaining({
          assignmentId: assignment.assignmentId, status: 'cancelled', leaseId: '',
        })),
      ));

      const handlers = createSupervisionMcpToolHandlers(
        { sessionName: 'deck_alpha_brain', projectName: 'alpha' } as never,
        { registry: supervisionRegistryPort(registry) },
      );
      expect(await handlers[SUPERVISION_MCP_TOOLS.INTENT]({ intent: 'cancel', taskId }))
        .toMatchObject({ status: 'ok', fromStatus: 'validated', toStatus: 'cancelled' });
      expect(registry.get(taskId)).toMatchObject({ status: 'cancelled' });

      registry.close();
      registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.get(taskId)).toMatchObject({
        status: 'cancelled',
        assignments: expect.arrayContaining(assignments.map((assignment) => expect.objectContaining({
          assignmentId: assignment.assignmentId, status: 'cancelled', leaseId: '',
        }))),
      });
    } finally {
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('atomically recovers an exact retired-REWORK aggregate split and fails closed on ambiguous evidence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'supervision-rework-aggregate-recovery-'));
    const dbPath = join(dir, 'registry.sqlite');
    let registry = new SupervisionTaskRegistry({ dbPath });
    const db = new DatabaseSync(dbPath);
    const rewriteTask = (taskId: string, patch: Record<string, unknown>) => {
      const row = db.prepare('SELECT payload_json AS payload FROM supervision_tasks WHERE task_id = ?')
        .get(taskId) as { payload: string };
      const payload = { ...JSON.parse(row.payload), ...patch };
      db.prepare(`UPDATE supervision_tasks SET status = ?, current_revision = ?, payload_json = ?, updated_at = ?
                  WHERE task_id = ?`)
        .run(payload.status, payload.currentRevision ?? null, JSON.stringify(payload), payload.updatedAt, taskId);
    };
    const rewriteAssignment = (assignmentId: string, patch: Record<string, unknown>) => {
      const row = db.prepare('SELECT payload_json AS payload FROM supervision_task_assignments WHERE assignment_id = ?')
        .get(assignmentId) as { payload: string };
      const payload = { ...JSON.parse(row.payload), ...patch };
      db.prepare(`UPDATE supervision_task_assignments SET status = ?, lease_id = ?, audit_attempt_id = ?,
                    audit_revision = ?, verdict = ?, blocker = ?, payload_json = ?, updated_at = ?
                  WHERE assignment_id = ?`)
        .run(payload.status, payload.leaseId ?? '', payload.auditAttemptId ?? null,
          payload.auditRevision ?? null, payload.verdict ?? null, payload.blocker ?? null,
          JSON.stringify(payload), payload.updatedAt, assignmentId);
    };
    const seedSplit = (input: {
      taskId: string;
      taskRevision: string;
      auditRevision?: string;
      activeAuditor?: boolean;
      auditorVerdict?: 'REWORK' | 'PASS';
      implementerRequired?: boolean;
      ambiguousImplementer?: boolean;
    }) => {
      const auditRevision = input.auditRevision ?? input.taskRevision;
      const attemptId = `${input.taskId}-attempt`;
      expect(registry.createOrGet({
        taskId: input.taskId, projectName: 'alpha', objective: input.taskId,
        classification: 'independent_top_level', currentRevision: input.taskRevision, now: 10,
      })).toMatchObject({ ok: true });
      const implementer = registry.createAssignment({
        taskId: input.taskId, role: 'implementer', identity: identity(`deck_${input.taskId}_worker`), now: 20,
      });
      if (!implementer.ok) throw new Error(implementer.reason);
      const auditor = registry.createAssignment({
        taskId: input.taskId, role: 'auditor', identity: identity(`deck_${input.taskId}_auditor`),
        auditAttemptId: attemptId, auditRevision, now: 30,
      });
      if (!auditor.ok) throw new Error(auditor.reason);
      rewriteAssignment(implementer.value.assignmentId, {
        status: 'rework', leaseId: implementer.value.leaseId,
        required: input.implementerRequired ?? true,
        auditAttemptId: attemptId, auditRevision, verdict: 'REWORK',
        blocker: `${input.taskId} retained finding`, updatedAt: 40,
      });
      rewriteAssignment(auditor.value.assignmentId, {
        status: 'cancelled', leaseId: '',
        auditAttemptId: attemptId, auditRevision,
        verdict: input.auditorVerdict ?? 'REWORK',
        blocker: `${input.taskId} auditor provenance`, updatedAt: 50,
      });
      if (input.activeAuditor) {
        const activeAuditor = registry.createAssignment({
          taskId: input.taskId, role: 'auditor', identity: identity(`deck_${input.taskId}_active_auditor`),
          auditAttemptId: `${input.taskId}-active-attempt`, auditRevision, now: 55,
        });
        if (!activeAuditor.ok) throw new Error(activeAuditor.reason);
      }
      if (input.ambiguousImplementer) {
        const other = registry.createAssignment({
          taskId: input.taskId, role: 'implementer', identity: identity(`deck_${input.taskId}_other`), now: 35,
        });
        if (!other.ok) throw new Error(other.reason);
        rewriteAssignment(other.value.assignmentId, {
          status: 'rework', leaseId: other.value.leaseId, required: true,
          auditAttemptId: attemptId, auditRevision, verdict: 'REWORK', updatedAt: 45,
        });
      }
      rewriteTask(input.taskId, {
        status: 'ready_for_audit', currentRevision: input.taskRevision, updatedAt: 60,
      });
      return { implementer: implementer.value, auditor: auditor.value, attemptId, auditRevision };
    };

    try {
      const exact = seedSplit({ taskId: 'same-revision-split', taskRevision: 'revision-r1' });
      const beforeImplementer = registry.getAssignment(exact.implementer.assignmentId)!;
      const beforeAuditor = registry.getAssignment(exact.auditor.assignmentId)!;
      expect(registry.applyTaskIntent({
        taskId: 'same-revision-split', assignmentId: exact.implementer.assignmentId,
        intent: 'checkpoint', toStatus: null, note: 'resume after retired audit',
      })).toMatchObject({ ok: true, value: { status: 'rework', currentRevision: 'revision-r1' } });
      expect(registry.getAssignment(exact.implementer.assignmentId)).toMatchObject({
        leaseId: beforeImplementer.leaseId, auditAttemptId: exact.attemptId,
        auditRevision: 'revision-r1', verdict: 'REWORK', blocker: 'same-revision-split retained finding',
      });
      expect(registry.getAssignment(exact.auditor.assignmentId)).toEqual(beforeAuditor);
      expect(registry.get('same-revision-split')?.assignments).toHaveLength(2);
      const reworkEvents = () => registry.listEvents('same-revision-split')
        .filter((event) => event.eventType === 'rework' && !event.assignmentId);
      expect(reworkEvents()).toHaveLength(1);
      expect(registry.applyTaskIntent({
        taskId: 'same-revision-split', assignmentId: exact.implementer.assignmentId,
        intent: 'checkpoint', toStatus: null,
      })).toMatchObject({ ok: true, value: { status: 'rework', currentRevision: 'revision-r1' } });
      expect(reworkEvents()).toHaveLength(1);

      const changed = seedSplit({
        taskId: 'changed-revision-split', taskRevision: 'revision-r1', auditRevision: 'revision-r2',
      });
      const planned = registry.reconcileHousekeeping({ mode: 'dryRun', projectName: 'alpha', limit: 50, now: 1_000 });
      expect(planned.actions).toEqual(expect.arrayContaining([expect.objectContaining({
        taskId: 'changed-revision-split', kind: 'repair_revision',
        assignmentId: changed.implementer.assignmentId,
        fromRevision: 'revision-r1', toRevision: 'revision-r2', toStatus: 'rework',
      })]));
      registry.reconcileHousekeeping({ mode: 'apply', projectName: 'alpha', limit: 50, now: 1_000 });
      expect(registry.get('changed-revision-split')).toMatchObject({
        status: 'rework', currentRevision: 'revision-r2',
      });
      expect(registry.getAssignment(changed.implementer.assignmentId)).toMatchObject({
        leaseId: changed.implementer.leaseId, auditAttemptId: changed.attemptId,
        auditRevision: 'revision-r2', verdict: 'REWORK',
      });
      const replay = registry.reconcileHousekeeping({ mode: 'apply', projectName: 'alpha', limit: 50, now: 2_000 });
      expect(replay.actions.filter((action) => (
        action.taskId === 'changed-revision-split'
        && (action.kind === 'repair_revision' || action.kind === 'repair_aggregate')
      ))).toEqual([]);

      const viaUpdate = seedSplit({ taskId: 'assignment-update-split', taskRevision: 'revision-r1' });
      expect(registry.updateAssignment({
        assignmentId: viaUpdate.implementer.assignmentId,
        identity: viaUpdate.implementer.identity,
        status: 'rework', revision: 'revision-r1',
        auditAttemptId: viaUpdate.attemptId, auditRevision: 'revision-r1', verdict: 'REWORK',
      })).toMatchObject({ ok: true });
      expect(registry.get('assignment-update-split')).toMatchObject({
        status: 'rework', currentRevision: 'revision-r1',
      });

      const attestedPass = seedSplit({ taskId: 'attested-pass-split', taskRevision: 'revision-r1' });
      db.prepare(`INSERT INTO supervision_audit_attestations
        (attempt_id, task_id, assignment_id, revision, verdict, auditor_session_name, findings, created_at)
        VALUES (?, ?, ?, 'revision-r1', 'PASS', 'deck_pass_auditor', 'retained PASS', 70)`)
        .run('attested-pass-attempt', attestedPass.implementer.taskId, attestedPass.implementer.assignmentId);
      const receiptedPass = seedSplit({ taskId: 'receipted-pass-split', taskRevision: 'revision-r1' });
      db.prepare(`INSERT INTO supervision_audit_receipts
        (receipt_id, task_id, assignment_id, attempt_id, revision, sequence, receipt_kind, verdict,
         findings, validations_json, receipt_digest, sender_identity_json, created_at)
        VALUES (?, ?, ?, ?, 'revision-r1', 1, 'final', 'PASS', 'retained PASS', '[]', ?, ?, 70)`)
        .run('receipted-pass-id', receiptedPass.implementer.taskId, receiptedPass.auditor.assignmentId,
          'receipted-pass-attempt', 'receipted-pass-digest', JSON.stringify(receiptedPass.auditor.identity));
      const refused = [
        seedSplit({ taskId: 'active-auditor-split', taskRevision: 'revision-r1', activeAuditor: true }),
        seedSplit({ taskId: 'pass-evidence-split', taskRevision: 'revision-r1', auditorVerdict: 'PASS' }),
        attestedPass,
        receiptedPass,
        seedSplit({ taskId: 'no-required-worker-split', taskRevision: 'revision-r1', implementerRequired: false }),
        seedSplit({ taskId: 'ambiguous-worker-split', taskRevision: 'revision-r1', ambiguousImplementer: true }),
      ];
      for (const shape of refused) {
        expect(registry.applyTaskIntent({
          taskId: shape.implementer.taskId, assignmentId: shape.implementer.assignmentId,
          intent: 'checkpoint', toStatus: null,
        })).toMatchObject({ ok: true, value: { status: 'ready_for_audit' } });
        expect(registry.get(shape.implementer.taskId)).toMatchObject({
          status: 'ready_for_audit', currentRevision: 'revision-r1',
        });
      }

      db.close();
      registry.close();
      registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.get('same-revision-split')).toMatchObject({
        status: 'rework', currentRevision: 'revision-r1',
        assignments: expect.arrayContaining([
          expect.objectContaining({
            assignmentId: exact.implementer.assignmentId, status: 'rework',
            leaseId: beforeImplementer.leaseId, auditAttemptId: exact.attemptId,
            auditRevision: 'revision-r1', verdict: 'REWORK',
          }),
          expect.objectContaining({
            assignmentId: exact.auditor.assignmentId, status: 'cancelled', leaseId: '',
            auditAttemptId: exact.attemptId, auditRevision: 'revision-r1', verdict: 'REWORK',
          }),
        ]),
      });
      const handlers = createSupervisionMcpToolHandlers(
        { sessionName: exact.implementer.identity.sessionName, projectName: 'alpha' } as never,
        { registry: supervisionRegistryPort(registry) },
      );
      expect(await handlers[SUPERVISION_MCP_TOOLS.INTENT]({
        intent: 'start', taskId: 'same-revision-split', assignmentId: exact.implementer.assignmentId,
      })).toMatchObject({ status: 'ok', fromStatus: 'rework', toStatus: 'implementing' });
      expect(registry.get('same-revision-split')).toMatchObject({
        status: 'implementing',
        assignments: expect.arrayContaining([expect.objectContaining({
          assignmentId: exact.implementer.assignmentId, status: 'implementing',
        })]),
      });
    } finally {
      try { db.close(); } catch { /* already closed before SQLite reopen */ }
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dry-runs and applies bounded housekeeping without deleting provenance or touching active exceptions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'supervision-housekeeping-'));
    const dbPath = join(dir, 'registry.sqlite');
    const now = 30 * 24 * 60 * 60_000;
    let registry = new SupervisionTaskRegistry({ dbPath });
    const db = new DatabaseSync(dbPath);
    const task = (taskId: string, objective: string, createdAt = 1_000) => {
      expect(registry.createOrGet({
        taskId, topLevelTaskId: 'housekeeping-top', projectName: 'alpha',
        classification: 'independent_top_level', objective, now: createdAt,
      })).toMatchObject({ ok: true });
    };
    const assignment = (taskId: string, assignmentId: string) => {
      const created = registry.createAssignment({
        taskId, assignmentId, role: 'implementer', identity: identity(`deck_${assignmentId}`), now: 2_000,
      });
      if (!created.ok) throw new Error(created.reason);
      return created.value;
    };
    const rewriteTask = (taskId: string, patch: Record<string, unknown>) => {
      const row = db.prepare('SELECT payload_json AS payload FROM supervision_tasks WHERE task_id = ?')
        .get(taskId) as { payload: string };
      const payload = { ...JSON.parse(row.payload), ...patch };
      db.prepare(`UPDATE supervision_tasks SET status = ?, current_revision = ?, payload_json = ?, updated_at = ?
                  WHERE task_id = ?`)
        .run(payload.status, payload.currentRevision ?? null, JSON.stringify(payload), payload.updatedAt, taskId);
    };
    const rewriteAssignment = (assignmentId: string, patch: Record<string, unknown>) => {
      const row = db.prepare('SELECT payload_json AS payload FROM supervision_task_assignments WHERE assignment_id = ?')
        .get(assignmentId) as { payload: string };
      const payload = { ...JSON.parse(row.payload), ...patch };
      db.prepare(`UPDATE supervision_task_assignments SET status = ?, lease_id = ?, audit_revision = ?,
                    verdict = ?, payload_json = ?, updated_at = ? WHERE assignment_id = ?`)
        .run(payload.status, payload.leaseId ?? '', payload.auditRevision ?? null, payload.verdict ?? null,
          JSON.stringify(payload), payload.updatedAt, assignmentId);
    };

    try {
      task('a-completed-stale', 'completed but aggregate delegated');
      assignment('a-completed-stale', 'a-completed-worker');
      rewriteAssignment('a-completed-worker', { status: 'finalized', leaseId: 'stale-finalized-lease', updatedAt: 2_000 });
      rewriteTask('a-completed-stale', {
        status: 'delegated', currentRevision: 'completed-r1', commitSha: 'abc1234',
        pushRemoteRef: 'refs/heads/dev', updatedAt: 3_000,
      });
      db.prepare(`INSERT INTO supervision_audit_attestations
        (attempt_id, task_id, assignment_id, revision, verdict, auditor_session_name, findings, created_at)
        VALUES ('completed-pass-attempt','a-completed-stale','a-completed-worker','completed-r1','PASS',
          'deck_auditor','retained PASS evidence',2500)`).run();

      task('b-cancelled-stale', 'cancelled but aggregate validated');
      assignment('b-cancelled-stale', 'b-cancelled-worker');
      rewriteAssignment('b-cancelled-worker', { status: 'cancelled', leaseId: 'stale-cancelled-lease', updatedAt: 2_000 });
      rewriteTask('b-cancelled-stale', { status: 'validated', updatedAt: 3_000 });
      db.prepare(`INSERT INTO supervision_task_file_claims
        (task_id, assignment_id, file_path, claim_mode, created_at) VALUES (?, ?, ?, 'read_only', ?)`)
        .run('b-cancelled-stale', 'b-cancelled-worker', 'src/stale.ts', 2_000);

      task('c-live-active', 'live active work');
      assignment('c-live-active', 'c-live-worker');
      rewriteAssignment('c-live-worker', { status: 'implementing', leaseId: 'live-lease', updatedAt: 2_000 });
      rewriteTask('c-live-active', { status: 'implementing', updatedAt: 3_000 });

      task('d-rework-split', 'legitimate R2 rework recovery');
      assignment('d-rework-split', 'd-rework-worker');
      const reworkAuditor = registry.createAssignment({
        taskId: 'd-rework-split', assignmentId: 'd-rework-auditor', role: 'auditor',
        identity: identity('deck_d-rework-auditor'), auditAttemptId: 'd-rework-attempt',
        auditRevision: 'revision-r2', now: 2_000,
      });
      if (!reworkAuditor.ok) throw new Error(reworkAuditor.reason);
      rewriteAssignment('d-rework-worker', {
        status: 'rework', leaseId: 'rework-lease', auditAttemptId: 'd-rework-attempt',
        auditRevision: 'revision-r2', verdict: 'REWORK', updatedAt: now - 500,
      });
      rewriteAssignment('d-rework-auditor', {
        status: 'cancelled', leaseId: '', auditAttemptId: 'd-rework-attempt',
        auditRevision: 'revision-r2', verdict: 'REWORK', updatedAt: now - 500,
      });
      rewriteTask('d-rework-split', { status: 'ready_for_audit', currentRevision: 'revision-r1', updatedAt: now - 500 });

      task('e-old-pass', 'PASS awaiting integration');
      assignment('e-old-pass', 'e-pass-worker');
      rewriteAssignment('e-pass-worker', { status: 'passed', leaseId: '', verdict: 'PASS', updatedAt: 2_000 });
      rewriteTask('e-old-pass', { status: 'passed', currentRevision: 'pass-r1', updatedAt: 3_000 });

      task('f-duplicate-original', '  Same   Objective  ', now - 1_000);
      task('g-duplicate-copy', 'same objective', now - 500);
      task('h-empty-planned', 'never dispatched garbage');

      const eventsBefore = new Map(registry.list({ includeArchived: true }).map((item) => (
        [item.taskId, registry.listEvents(item.taskId).length]
      )));
      const dryRun = registry.reconcileHousekeeping({ mode: 'dryRun', projectName: 'alpha', limit: 20, now });
      expect(dryRun).toMatchObject({
        mode: 'dryRun', scanned: 8, hasMore: false, activeCount: 8, archivedCount: 0,
        applyAuthorized: false,
      });
      expect(dryRun.actions).toEqual(expect.arrayContaining([
        expect.objectContaining({ taskId: 'a-completed-stale', kind: 'release_terminal_assignment' }),
        expect.objectContaining({ taskId: 'a-completed-stale', kind: 'repair_aggregate', toStatus: 'finalized' }),
        expect.objectContaining({ taskId: 'a-completed-stale', kind: 'archive_terminal' }),
        expect.objectContaining({ taskId: 'b-cancelled-stale', kind: 'archive_terminal' }),
        expect.objectContaining({ taskId: 'd-rework-split', kind: 'repair_revision', toRevision: 'revision-r2' }),
        expect.objectContaining({ taskId: 'g-duplicate-copy', kind: 'mark_duplicate_candidate' }),
        expect.objectContaining({ taskId: 'h-empty-planned', kind: 'archive_abandoned' }),
      ]));
      expect(registry.get('a-completed-stale')).not.toHaveProperty('archivedAt');

      const applied = registry.reconcileHousekeeping({ mode: 'apply', projectName: 'alpha', limit: 20, now });
      expect(applied).toMatchObject({ activeCount: 5, archivedCount: 3, applyAuthorized: true });
      expect(registry.list().map((item) => item.taskId)).toEqual([
        'c-live-active', 'd-rework-split', 'e-old-pass', 'f-duplicate-original', 'g-duplicate-copy',
      ]);
      expect(registry.list({ history: true }).map((item) => item.taskId)).toEqual([
        'a-completed-stale', 'b-cancelled-stale', 'h-empty-planned',
      ]);
      expect(registry.list({ includeArchived: true })).toHaveLength(8);
      expect(registry.get('d-rework-split')).toMatchObject({
        status: 'rework', currentRevision: 'revision-r2',
      });
      expect(registry.get('d-rework-split')).not.toHaveProperty('archivedAt');
      expect(registry.get('c-live-active')).toMatchObject({ status: 'implementing' });
      expect(registry.get('c-live-active')).not.toHaveProperty('archivedAt');
      expect(registry.get('e-old-pass')).toMatchObject({ status: 'passed' });
      expect(registry.get('e-old-pass')).not.toHaveProperty('archivedAt');
      expect(registry.get('g-duplicate-copy')).toMatchObject({
        duplicateCandidate: true, duplicateCandidateOf: 'f-duplicate-original',
      });
      expect(registry.get('g-duplicate-copy')).not.toHaveProperty('archivedAt');
      expect(registry.getAssignment('a-completed-worker')).toMatchObject({ status: 'finalized', leaseId: '' });
      expect(registry.getAssignment('b-cancelled-worker')).toMatchObject({ status: 'cancelled', leaseId: '' });
      expect(db.prepare('SELECT COUNT(*) AS n FROM supervision_task_file_claims').get()).toEqual({ n: 0 });
      expect(db.prepare(`SELECT revision, verdict, findings FROM supervision_audit_attestations
                         WHERE attempt_id='completed-pass-attempt'`).get()).toEqual({
        revision: 'completed-r1', verdict: 'PASS', findings: 'retained PASS evidence',
      });
      expect(registry.get('a-completed-stale')).toMatchObject({
        archivedAt: now, currentRevision: 'completed-r1', commitSha: 'abc1234', pushRemoteRef: 'refs/heads/dev',
      });
      for (const [taskId, count] of eventsBefore) {
        expect(registry.listEvents(taskId).length).toBeGreaterThanOrEqual(count);
      }

      registry.close();
      registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.list()).toHaveLength(5);
      expect(registry.list({ history: true })).toHaveLength(3);
      expect(registry.housekeepingApplyAuthorized('alpha')).toBe(true);
    } finally {
      registry.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pushes the housekeeping page bound into SQLite and returns a deterministic cursor', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    for (const suffix of ['a', 'b', 'c', 'd']) {
      expect(registry.createOrGet({
        taskId: `bounded-${suffix}`, projectName: 'alpha', objective: `bounded ${suffix}`, now: 10,
      })).toMatchObject({ ok: true });
    }
    const prepare = vi.spyOn(database, 'prepare');
    const first = registry.reconcileHousekeeping({ mode: 'dryRun', projectName: 'alpha', limit: 2, now: 20 });
    expect(first).toMatchObject({ scanned: 2, hasMore: true, nextCursor: 'bounded-b' });
    expect(prepare.mock.calls.some(([sql]) => (
      String(sql).includes('FROM supervision_tasks t') && String(sql).includes('LIMIT ?')
    ))).toBe(true);
    expect(registry.reconcileHousekeeping({
      mode: 'dryRun', cursor: first.nextCursor, limit: 2, now: 20,
      projectName: 'alpha',
    })).toMatchObject({ scanned: 2, hasMore: false });
    registry.close();
    database.close();
  });
});
