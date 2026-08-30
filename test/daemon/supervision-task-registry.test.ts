import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { dispatchSendMessage, clearSendIdempotencyCacheForTests } from '../../src/daemon/send-tool.js';
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

/** Adapts the real registry to the audited handler port. */
function supervisionRegistryPort(registryOverride?: SupervisionTaskRegistry) {
  const registry = () => registryOverride ?? getSupervisionTaskRegistry();
  return {
    getStatus: (taskId: string) => registry().get(taskId)?.status,
    applyIntent: (input: Parameters<SupervisionTaskRegistry['applyTaskIntent']>[0]) => registry().applyTaskIntent(input),
    finishAssignment: ({ assignmentId, callerSessionName }: { assignmentId: string; callerSessionName: string }) => {
      const current = registry();
      const assignment = current.getAssignment(assignmentId);
      if (!assignment) return { ok: false as const, reason: 'not_found' };
      if (assignment.identity.sessionName !== callerSessionName) return { ok: false as const, reason: 'owner_mismatch' };
      return current.finishAssignment({ assignmentId, identity: assignment.identity });
    },
    list: (filter: never) => registry().list(filter) as never,
    get: (taskId: string) => registry().get(taskId) as never,
    recover: (input: Parameters<SupervisionTaskRegistry['recoverTask']>[0]) => registry().recoverTask(input),
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

function prepareStructuredFinalizationShape(
  registry: SupervisionTaskRegistry,
  taskId: string,
  options: { selfAudit?: boolean; leaveOwnerLeaseActive?: boolean } = {},
) {
  const revision = `${taskId}-r1`;
  const attemptId = `${taskId}-overall-audit`;
  const files = ['src/final-a.ts', 'src/final-b.ts'];
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
    taskId, role: 'integration_owner', identity: ownerIdentity, scopeFiles: files,
    auditAttemptId: attemptId, auditRevision: revision,
  });
  const implementer = registry.createAssignment({
    taskId, role: 'implementer', identity: implementerIdentity, scopeFiles: files,
    auditAttemptId: attemptId, auditRevision: revision,
  });
  const auditor = registry.createAssignment({
    taskId, role: 'auditor', identity: auditorIdentity, required: false,
    auditAttemptId: attemptId, auditRevision: revision,
  });
  if (!coordinator.ok || !owner.ok || !implementer.ok || !auditor.ok) throw new Error('shape setup failed');
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
  expect(registry.finishAssignment({
    assignmentId: auditor.value.assignmentId, identity: auditor.value.identity, revision,
  })).toMatchObject({ ok: true, value: { status: 'finalized', leaseId: '' } });
  expect(registry.finishAssignment({
    assignmentId: implementer.value.assignmentId, identity: implementer.value.identity, revision,
  })).toMatchObject({ ok: true, value: { status: 'ready_for_integration', leaseId: '' } });
  if (!options.leaveOwnerLeaseActive) {
    expect(registry.finishAssignment({
      assignmentId: owner.value.assignmentId, identity: owner.value.identity, revision,
    })).toMatchObject({ ok: true, value: { status: 'ready_for_integration', leaseId: '' } });
  } else {
    expect(registry.getAssignment(owner.value.assignmentId)).toMatchObject({
      status: 'ready_for_integration', leaseId: expect.stringMatching(/^supervision_lease_/),
    });
  }
  const finalization = {
    assignmentId: owner.value.assignmentId,
    revision,
    auditAttemptId: attemptId,
    auditRevision: revision,
    verdict: 'PASS' as const,
    ownedFiles: files,
    integrationManifest: files.map((path, index) => ({ path, sha256: String(index + 1).repeat(64) })),
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
  return { taskId, revision, attemptId, files, owner: owner.value, coordinator: coordinator.value, auditor: auditor.value, finalization };
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
  const implementerIdentity = identity(`deck_${taskId}_worker`);
  const auditorIdentity = identity(`deck_${taskId}_auditor`, 'claude-code-sdk');
  expect(registry.createOrGet({
    taskId, projectName: 'alpha', classification: 'independent_top_level',
    objective: 'recover frozen GC revision on the same objects', currentRevision: fromRevision,
  })).toMatchObject({ ok: true });
  const implementer = registry.createAssignment({
    assignmentId: `${taskId}-implementer`, taskId, role: 'implementer',
    identity: implementerIdentity, scopeFiles: files,
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
      identity: identity(`deck_${taskId}_other`), scopeFiles: files,
      auditRevision: fromRevision,
    })).toMatchObject({ ok: true });
  }
  return {
    taskId, fromRevision, toRevision, files,
    evidenceManifestSha256: 'd'.repeat(64),
    implementer: implementer.value,
    implementerIdentity,
    auditor: auditor.value,
  };
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

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_INTEGRATION_FINALIZE](shape.finalization))
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

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_INTEGRATION_FINALIZE](shape.finalization))
      .resolves.toMatchObject({ status: 'ok', idempotentReplay: true, item: { status: 'finalized' } });
    expect(registry.listEvents(shape.taskId)).toHaveLength(eventCount + 15);
    expect(registry.listAssignments(shape.taskId)).toHaveLength(assignmentCount);
  });

  it('fails closed on stale audit, dirty staged sets, conflicts, foreign owners, and self-audit without mutation', () => {
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
    expect(call({ stagedPaths: [shape.files[0]] }))
      .toEqual({ ok: false, reason: 'manifest_mismatch' });
    expect(call({ conflictedPaths: [shape.files[0]] }))
      .toEqual({ ok: false, reason: 'invalid' });
    expect(call({ untrackedOtherOwnerPaths: ['src/foreign.ts'] }))
      .toEqual({ ok: false, reason: 'invalid' });
    expect(call({}, identity('foreign-integration-owner')))
      .toEqual({ ok: false, reason: 'owner_mismatch' });
    expect(registry.get(shape.taskId)).toEqual(initial);
    expect(registry.listEvents(shape.taskId)).toHaveLength(initialEvents);

    const selfAudit = prepareStructuredFinalizationShape(registry, 'structured-finalization-self-audit', { selfAudit: true });
    expect(registry.finalizeIntegration({
      ...selfAudit.finalization, identity: selfAudit.owner.identity,
    })).toEqual({ ok: false, reason: 'owner_mismatch' });
    expect(registry.get(selfAudit.taskId)).toMatchObject({ status: 'ready_for_integration' });
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
        taskId: 'stale-owner-scope-mismatch',
        options: { replacementScopeFiles: ['src/final-a.ts'] },
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

  it('atomically rebinds one frozen revision on the same task/assignment and persists replay across restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-same-object-revision-recovery-'));
    const dbPath = join(dir, 'supervision-state.sqlite');
    let registry = new SupervisionTaskRegistry({ dbPath });
    try {
      const shape = prepareSameObjectRevisionRecoveryShape(registry, 'same-object-revision-recovery');
      const assignmentCount = registry.listAssignments(shape.taskId).length;
      const eventCount = registry.listEvents(shape.taskId).length;
      const leaseId = registry.getAssignment(shape.implementer.assignmentId)!.leaseId;
      const historicalAuditor = registry.getAssignment(shape.auditor.assignmentId);
      const request = {
        taskId: shape.taskId,
        assignmentId: shape.implementer.assignmentId,
        fromRevision: shape.fromRevision,
        toRevision: shape.toRevision,
        ownedFiles: shape.files,
        evidenceManifestSha256: shape.evidenceManifestSha256,
        reason: 'bind validated frozen R3 without replacing the GC objects',
        now: 500,
      };

      expect(registry.rebindTaskAssignmentRevision(request)).toMatchObject({
        ok: true,
        value: { taskId: shape.taskId, status: 'implementing', currentRevision: shape.toRevision },
      });
      expect(registry.getAssignment(shape.implementer.assignmentId)).toMatchObject({
        assignmentId: shape.implementer.assignmentId,
        status: 'implementing', leaseId, generation: 2,
        auditRevision: shape.toRevision,
      });
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
      expect(registry.listEvents(shape.taskId)).toHaveLength(persistedEvents);
      expect(registry.listAssignments(shape.taskId)).toHaveLength(assignmentCount);
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
      reason: 'scope mismatch',
    })).toEqual({ ok: false, reason: 'manifest_mismatch' });
    expect(scopeRegistry.rebindTaskAssignmentRevision({
      taskId: scope.taskId, assignmentId: scope.implementer.assignmentId,
      fromRevision: scope.fromRevision, toRevision: scope.toRevision,
      ownedFiles: scope.files, evidenceManifestSha256: '', reason: 'empty evidence',
    })).toEqual({ ok: false, reason: 'invalid' });
    scopeRegistry.close();

    const lifecycleRegistry = makeRegistry();
    const lifecycle = prepareSameObjectRevisionRecoveryShape(lifecycleRegistry, 'revision-recovery-lifecycle');
    expect(lifecycleRegistry.updateTask({ taskId: lifecycle.taskId, status: 'validated' })).toMatchObject({ ok: true });
    expect(lifecycleRegistry.rebindTaskAssignmentRevision({
      taskId: lifecycle.taskId, assignmentId: lifecycle.implementer.assignmentId,
      fromRevision: lifecycle.fromRevision, toRevision: lifecycle.toRevision,
      ownedFiles: lifecycle.files, evidenceManifestSha256: lifecycle.evidenceManifestSha256,
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
        status: 'rework', verdict: 'REWORK', blocker: 'correction before finish',
      });
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
      expect(registry.getAssignment(implementer.value.assignmentId)?.status).toBe('rework');
      registry.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    expect(registry.recordFileEvent({ assignmentId: impl.value.assignmentId, identity: implementer, path: 'src/out.ts', operation: 'create' })).toMatchObject({ ok: true });
    expect(registry.get('task-files')).toMatchObject({ status: 'delegated', touchedFiles: ['src/ok.ts', 'src/out.ts'] });
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

  it('reconciles hooks against declared scope, duplicate deliveries, rename/delete and restart recovery', () => {
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
      expect(registry.reconcileScope({ taskId: 'task-restart', trackedPaths: ['src/old.ts', 'src/new.ts', 'src/untracked.ts'] })).toEqual({ ok: false, reason: 'manifest_mismatch' });
      registry.close();
      const reopened = new SupervisionTaskRegistry({ dbPath });
      expect(reopened.get('task-restart')?.touchedFiles).toEqual(['src/new.ts', 'src/old.ts']);
      expect(reopened.get('task-restart')?.currentRevision).toBe('rev1');
      expect(reopened.get('task-restart')?.assignments[0]?.executionBinding).toStrictEqual(persistedExecutionBinding('deck_sub_restart'));
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
    }, { listSessions: () => sessions, dispatchMessage, exactTargetOnly: true });
    const replay = await dispatchSendMessage({ userId: 'u', sessionName: 'deck_alpha_brain', projectName: 'alpha', projectRoot: '/work/alpha' }, {
      target: 'deck_alpha_w1', message: 'do task', idempotencyKey: 'same', task: { topLevelTaskId: 'top', objective: 'task via send', ownedFiles: ['src/a.ts'] },
    }, { listSessions: () => sessions, dispatchMessage, exactTargetOnly: true });
    if (result.status !== 'accepted' || replay.status !== 'accepted') throw new Error('expected accepted');
    expect(result.taskId).toBeTruthy();
    expect(result.assignmentId).toBeTruthy();
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.taskId).toBe(result.taskId);
    expect(replay.assignmentId).toBe(result.assignmentId);
    expect(result.deliveries[0]).toMatchObject({ delegationId: expect.any(String) });
    const sent = String(dispatchMessage.mock.calls[0]?.[1] ?? '');
    expect(sent).toContain('Use the delegation_reply tool');
    expect(sent).toContain('[Delegated blocker escalation contract]');
    expect(sent).toContain(`taskId=${JSON.stringify(result.taskId)}`);
    expect(sent).toContain(`assignmentId=${JSON.stringify(result.assignmentId)}`);
    expect(sent).toContain('exactError, completedSafeWork, recommendedNextAction');
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
    expect(getSupervisionTaskRegistry().get(result.taskId!)?.assignments[0]?.executionBinding).toMatchObject({
      pool: 'primary',
      requested: { providerFamily: 'openai', model: 'gpt-5.6' },
      actual: { sessionName: 'deck_alpha_w1', sessionInstanceId: 'instance-deck_alpha_w1', runtimeEpoch: 'epoch-deck_alpha_w1', model: 'gpt-5.6' },
      origin: 'reused',
    });
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
    const dispatchMessage = vi.fn(async () => undefined);
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
      { listSessions: () => sessions, dispatchMessage, exactTargetOnly: true, provisionSupervisionTarget },
    );

    expect(provisionSupervisionTarget).toHaveBeenCalledTimes(1);
    expect(dispatchMessage).toHaveBeenCalledWith(worker, expect.stringContaining('provision then dispatch'), expect.any(Object));
    expect(sent).toMatchObject({
      status: 'accepted',
      provisioning: { selectedPool: 'primary', provisionAttemptId: 'supervision_provision_test', createdSessionName: worker.name },
    });
    if (sent.status !== 'accepted' || !sent.assignmentId) throw new Error('expected provisioned assignment');
    expect(getSupervisionTaskRegistry().getAssignment(sent.assignmentId)).toMatchObject({
      executionBinding: { origin: 'spawned', actual: { sessionName: worker.name } },
      provisioning: { selectedConfig, createdSessionName: worker.name },
    });
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
      { listSessions: () => sessions, dispatchMessage: async () => undefined, exactTargetOnly: true },
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
    })).toMatchObject({ status: 'ok' });
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
      revision: 'revision-2',
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
      status: 'ready_for_audit', leaseId: expect.stringMatching(/^supervision_lease_/),
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
    const deps = { listSessions: () => sessions, dispatchMessage, exactTargetOnly: true };

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
    const replay = await handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START](request);
    expect(first).toMatchObject({ status: 'ok', taskId: 'existing-start-task' });
    expect(replay).toMatchObject({
      status: 'ok', taskId: 'existing-start-task',
      assignmentId: first.assignmentId, idempotentReplay: true,
    });
    expect(registry.list({ projectName: 'alpha' })).toHaveLength(1);
    expect(registry.get('existing-start-task')?.assignments).toHaveLength(2);
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
          leaseId: expect.stringMatching(/^supervision_lease_/),
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
