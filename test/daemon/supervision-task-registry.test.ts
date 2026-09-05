import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, beforeEach, vi } from 'vitest';

import {
  SupervisionTaskRegistry,
  SUPERVISION_ORPHAN_QUARANTINE_SCOPE,
  isReservedSupervisionProjectScope,
  getSupervisionTaskRegistry,
  resetSupervisionTaskRegistryForTests,
  type PersistedSupervisionTaskAssignmentIdentity,
} from '../../src/daemon/supervision-state-store.js';
import { suppressSqliteExperimentalWarning } from '../../src/util/suppress-sqlite-warning.js';
import { dispatchHookSend, dispatchSendMessage, clearSendIdempotencyCacheForTests } from '../../src/daemon/send-tool.js';
import type { SessionRecord } from '../../src/store/session-store.js';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import {
  SUPERVISION_TASK_REGISTRY_CONTRACT,
  type SupervisionTaskClassification,
} from '../../shared/supervision-config.js';
import { buildSupervisionExecutionCapabilityId } from '../../shared/supervision-execution-pool.js';
import { createSupervisionMcpToolHandlers } from '../../src/daemon/supervision-mcp-tools.js';
import { SUPERVISION_MCP_TOOLS } from '../../shared/supervision-mcp-tools.js';
import { resolvePeerAuditProviderFamily } from '../../shared/peer-audit.js';
import { AGENT_DELEGATION_PURPOSES } from '../../shared/agent-delegation.js';
import { createSupervisionRegistryPort } from '../../src/daemon/supervision-registry-port.js';
import { supervisionIdentityMatches } from '../../shared/supervision-participant-authority.js';
import { getDelegationReplyStore } from '../../src/daemon/delegation-reply-store.js';
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
      // Mirrors the production port: authority is the caller's resolved LIVE
      // identity, never a name, and never the stored identity handed back to
      // the registry (which would make its own exact check vacuous).
      const callerIdentity = testIdentityResolver(input.callerSessionName);
      if (input.projectBrain && input.callerProjectName) {
        return current.finishAssignmentAsProjectBrain({
          assignmentId: input.assignmentId,
          callerProjectName: input.callerProjectName,
          callerIdentity,
          ...(input.rebindIdentity ? { rebindIdentity: input.rebindIdentity } : {}),
          ...(input.rebindProjectName ? { rebindProjectName: input.rebindProjectName } : {}),
        });
      }
      if (!supervisionIdentityMatches(assignment.identity, callerIdentity)) {
        return { ok: false as const, reason: 'owner_mismatch' };
      }
      return current.finishAssignment({ assignmentId: input.assignmentId, identity: callerIdentity });
    },
    convergeValidatedAssignment: (input: { taskId: string; assignmentId: string }) => {
      const current = registry();
      const assignment = current.getAssignment(input.assignmentId);
      if (!assignment || assignment.taskId !== input.taskId) return [];
      return current.convergeValidatedAssignment(input.assignmentId, Date.now(), () => ({
        worktreePath: `/worktrees/${input.assignmentId}/repo`,
        headSha: '5f3d543ace7e73b95e58849f890299cef93bd3c5',
        files: assignment.scopeFiles.map((path) => ({ path, sha256: 'a'.repeat(64) })),
        stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
      }));
    },
    convergeExactReworkAssignment: (input: { taskId: string; assignmentId: string }) => {
      const current = registry();
      const assignment = current.getAssignment(input.assignmentId);
      if (!assignment || assignment.taskId !== input.taskId) return undefined;
      return current.convergeExactReworkAssignment(input.assignmentId);
    },
    list: (filter: never) => registry().list(filter) as never,
    get: (taskId: string) => registry().get(taskId) as never,
    recover: (input: Parameters<SupervisionTaskRegistry['recoverTask']>[0]) => registry().recoverTask(input),
    rebindValidatedImplementerAssignment: (
      input: Parameters<SupervisionTaskRegistry['rebindValidatedImplementerAssignment']>[0],
    ) => registry().rebindValidatedImplementerAssignment(input),
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

/**
 * Participation is now an exact-identity gate, so handler fixtures must resolve
 * the caller's live identity exactly as production does. Every fixture identity
 * in this file is derived deterministically from the session name.
 */
const TEST_SESSION_AGENT_TYPES: Record<string, string> = { deck_alpha_w2: 'claude-code-sdk' };
const testIdentityResolver = (name: string) => ({
  ...identity(name, TEST_SESSION_AGENT_TYPES[name]), projectName: 'alpha',
});

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

function prepareValidatedStaleImplementerShape(
  registry: SupervisionTaskRegistry,
  taskId: string,
  options: { readyForAudit?: boolean; addAmbiguousImplementer?: boolean } = {},
) {
  const revision = `${taskId}-r2`;
  const files = ['src/recovery-a.ts', 'test/recovery-a.test.ts'];
  const oldIdentity = identity(`${taskId}-worker`);
  const currentIdentity = {
    ...oldIdentity,
    sessionInstanceId: `${taskId}-current-instance`,
    runtimeEpoch: `${taskId}-current-epoch`,
  };
  expect(registry.createOrGet({
    taskId, projectName: 'alpha', classification: 'independent_top_level',
    objective: 'recover one stale validated implementer runtime', currentRevision: revision,
  })).toMatchObject({ ok: true });
  const implementer = registry.createAssignment({
    assignmentId: `${taskId}-implementer`, taskId, role: 'implementer',
    identity: oldIdentity, scopeFiles: files, required: true, auditRevision: revision,
  });
  if (!implementer.ok) throw new Error(implementer.reason);
  expect(registry.updateTask({ taskId, status: 'implementing', currentRevision: revision }))
    .toMatchObject({ ok: true });
  for (const status of ['implementing', 'validated'] as const) {
    expect(registry.updateAssignment({
      assignmentId: implementer.value.assignmentId, identity: oldIdentity,
      status, revision, auditRevision: revision,
    })).toMatchObject({ ok: true });
  }
  expect(registry.updateTask({ taskId, status: 'validated', currentRevision: revision }))
    .toMatchObject({ ok: true });
  if (options.readyForAudit) {
    expect(registry.updateAssignment({
      assignmentId: implementer.value.assignmentId, identity: oldIdentity,
      status: 'ready_for_audit', revision, auditRevision: revision,
    })).toMatchObject({ ok: true });
    expect(registry.updateTask({ taskId, status: 'ready_for_audit', currentRevision: revision }))
      .toMatchObject({ ok: true });
  }
  if (options.addAmbiguousImplementer) {
    const duplicateIdentity = identity(`${taskId}-duplicate`);
    const duplicate = registry.createAssignment({
      assignmentId: `${taskId}-duplicate`, taskId, role: 'implementer',
      identity: duplicateIdentity, scopeFiles: files, required: true, auditRevision: revision,
    });
    if (!duplicate.ok) throw new Error(duplicate.reason);
  }
  return {
    taskId, revision, files, oldIdentity, currentIdentity,
    evidenceManifestSha256: 'c'.repeat(64), implementer: implementer.value,
  };
}


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
    classification?: SupervisionTaskClassification;
    revision?: string;
    attemptId?: string;
    ownerAssignmentId?: string;
    commitSha?: string;
  } = {},
) {
  const revision = options.revision ?? `${taskId}-r1`;
  const attemptId = options.attemptId ?? `${taskId}-overall-audit`;
  const commitSha = options.commitSha ?? 'a'.repeat(40);
  const files = [...(options.files ?? ['src/final-a.ts', 'src/final-b.ts'])].sort();
  const scopeFiles = [...files, ...(options.authorizedUntouchedFiles ?? [])].sort();
  const ownerIdentity = identity(`${taskId}-owner`);
  const implementerIdentity = identity(`${taskId}-worker`);
  const auditorIdentity = options.selfAudit ? ownerIdentity : identity(`${taskId}-auditor`, 'claude-code-sdk');
  expect(registry.createOrGet({
    taskId, projectName: 'alpha', classification: options.classification ?? 'integration_task',
    objective: 'finalize exact matching PASS', currentRevision: revision,
  })).toMatchObject({ ok: true });
  const coordinator = registry.createAssignment({
    taskId, role: 'coordinator', identity: identity(`${taskId}-brain`), required: false,
  });
  const owner = registry.createAssignment({
    taskId, assignmentId: options.ownerAssignmentId,
    role: 'integration_owner', identity: ownerIdentity, scopeFiles,
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
          externalHeadSha: commitSha,
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
    commitSha,
    pushResult: 'pushed' as const,
    pushRemoteRef: 'refs/heads/dev',
    stagedPaths: files,
    conflictedPaths: [] as string[],
    untrackedOtherOwnerPaths: [] as string[],
    externalRunId: '33287386936',
    externalHeadSha: commitSha,
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

describe('implementation heartbeat legacy authority convergence', () => {
  it('atomically converges tsk_5w9 identity and executionBinding.actual on the same durable owner', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const taskId = 'tsk_5w9';
    const assignmentId = 'asg_5wc';
    const oldIdentity = {
      sessionName: 'deck_sub_1g6w5672', sessionInstanceId: '8db00b24', runtimeEpoch: '60136366',
      agentType: 'claude-code-sdk', providerFamily: 'anthropic',
    };
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'independent_top_level', objective: 'same durable owner', now: 1,
    }).ok).toBe(true);
    expect(registry.createAssignment({
      assignmentId, taskId, role: 'implementer', required: true, identity: oldIdentity,
      executionBinding: {
        pool: 'primary',
        requested: {
          capabilityId: buildSupervisionExecutionCapabilityId({
            agentType: 'claude-code-sdk', providerFamily: 'anthropic', runtimeType: 'transport', model: 'claude-sonnet',
          }),
          agentType: 'claude-code-sdk', providerFamily: 'anthropic', runtimeType: 'transport', model: 'claude-sonnet',
        },
        actual: {
          ...oldIdentity, runtimeType: 'transport', model: 'claude-sonnet',
        },
        origin: 'reused',
      },
      now: 2,
    }).ok).toBe(true);
    const currentIdentity = {
      sessionName: oldIdentity.sessionName, sessionInstanceId: '3ae6320c', runtimeEpoch: 'd1210488',
      agentType: 'codex-sdk', providerFamily: 'openai',
    };

    expect(registry.convergeImplementationHeartbeatTarget({
      taskId,
      assignmentId,
      candidates: [{ projectName: 'alpha', identity: currentIdentity }],
      now: 3,
    })).toMatchObject({ ok: true, value: { assignmentId, identity: currentIdentity } });
    expect(registry.getAssignment(assignmentId)?.executionBinding?.actual).toMatchObject(currentIdentity);
    expect(registry.listAssignments(taskId)).toHaveLength(1);
    database.close();
  });

  it.each(['coordinator', 'integration_owner', 'auditor'] as const)(
    'refreshes %s runtime metadata without changing durable project+session ownership',
    (role) => {
      const database = new DatabaseSync(':memory:');
      const registry = new SupervisionTaskRegistry({ database });
      const taskId = `stable-role-${role}`;
      const revision = 'stable-role-r1';
      expect(registry.createOrGet({
        taskId, projectName: 'alpha', classification: 'independent_top_level',
        objective: 'role restart continuity', currentRevision: revision, now: 1,
      }).ok).toBe(true);
      const assignmentId = `${taskId}-assignment`;
      const created = registry.createAssignment({
        assignmentId, taskId, role, required: role === 'auditor',
        identity: {
          sessionName: `deck_alpha_${role}`, sessionInstanceId: 'old-instance', runtimeEpoch: 'old-epoch',
          agentType: 'claude-code-sdk', providerFamily: 'anthropic',
        },
        ...(role === 'auditor' ? { auditAttemptId: 'attempt-1', auditRevision: revision } : {}),
        now: 2,
      });
      if (!created.ok) throw new Error(created.reason);
      const live = {
        sessionName: created.value.identity.sessionName,
        sessionInstanceId: 'new-instance', runtimeEpoch: 'new-epoch',
        agentType: 'codex-sdk', providerFamily: 'openai',
      };
      expect(registry.convergeImplementationHeartbeatTarget({
        taskId, assignmentId, candidates: [{ projectName: 'alpha', identity: live }], now: 3,
      })).toMatchObject({ ok: true, value: { assignmentId, identity: live } });
      expect(registry.listAssignments(taskId)).toHaveLength(1);
      database.close();
    },
  );

  it('requires bounded admin census before normalizing NULL project, then refreshes legacy runtime metadata', () => {
    const database = new DatabaseSync(':memory:');
    const liveIdentity = {
      sessionName: 'deck_legacy_worker', sessionInstanceId: 'live-instance', runtimeEpoch: 'live-epoch',
      agentType: 'claude-code-sdk', providerFamily: 'anthropic',
    };
    const registry = new SupervisionTaskRegistry({
      database,
      resolveLiveParticipants: (projectName) => projectName === 'legacy-project' ? [liveIdentity] : [],
    });
    const taskId = 'supervision_task_936f239f-d86f-4708-9d9f-f952cb82d0b5';
    const assignmentId = 'supervision_assignment_b4945502-0d07-4b6d-8009-e6db970d6689';
    expect(registry.createOrGet({
      taskId, projectName: 'legacy-project', classification: 'independent_top_level', objective: 'legacy wake', now: 1,
    }).ok).toBe(true);
    const created = registry.createAssignment({
      assignmentId, taskId, role: 'implementer', required: true,
      identity: {
        sessionName: 'deck_legacy_worker', sessionInstanceId: 'old-instance', runtimeEpoch: 'old-epoch',
        agentType: 'claude-code-sdk', providerFamily: 'claude',
      },
      now: 2,
    });
    if (!created.ok) throw new Error(created.reason);
    // Production legacy shape: payload and indexed project column both lost
    // their project audience, and there is deliberately no coordinator row.
    const task = registry.get(taskId)!;
    rewritePersistedTask(database, { ...task, projectName: null as never });
    database.prepare('UPDATE supervision_tasks SET project_name = NULL WHERE task_id = ?').run(taskId);

    const converge = () => registry.convergeImplementationHeartbeatTarget({
      taskId,
      assignmentId,
      candidates: [{
        projectName: 'legacy-project',
        identity: liveIdentity,
      }],
      now: 3,
    });

    // Ordinary delivery cannot infer a missing durable project identity. The
    // restricted census must establish that authority first; observational
    // identity refresh is not a substitute for project recovery.
    expect(converge()).toMatchObject({ ok: false, reason: 'ambiguous_assignment' });
    expect(registry.getTaskRecord(taskId)!.projectName).toBeNull();
    const normalPage = registry.reconcileHousekeeping({
      mode: 'dryRun', projectName: 'legacy-project', limit: 10, now: 3,
    });
    expect(normalPage).toMatchObject({ scanned: 0, hasMore: true, nextCursor: 'orphan:' });
    const orphanPage = registry.reconcileHousekeeping({
      mode: 'apply', projectName: 'legacy-project', cursor: normalPage.nextCursor, limit: 10, now: 3,
    });
    expect(orphanPage.actions).toEqual([
      expect.objectContaining({
        taskId, kind: 'backfill_orphan_project', reason: 'unique_live_session_lineage',
      }),
    ]);
    expect(converge()).toMatchObject({ ok: true, value: { assignmentId } });
    expect(registry.getAssignment(assignmentId)!.identity).toMatchObject({
      sessionInstanceId: 'live-instance', runtimeEpoch: 'live-epoch', providerFamily: 'anthropic',
    });
    expect(registry.getTaskRecord(taskId)!.projectName).toBe('legacy-project');
    expect(registry.listAssignments(taskId).filter((entry) => entry.role === 'coordinator')).toHaveLength(0);
    database.close();
  });

  it('boundedly retires the exact terminal-task stale auditors and resumes after restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'terminal-stale-auditor-cleanup-'));
    const dbPath = join(dir, 'registry.sqlite');
    let registry = new SupervisionTaskRegistry({ dbPath });
    const taskId = 'supervision_task_3559c97a-b45e-4ab4-95c1-0a8cdbc55dd2';
    const auditorIds = [
      'supervision_assignment_442148e6-e553-4ad7-b4c7-0af82d808bad',
      'supervision_assignment_3f6e473e-5d85-4af0-995b-58bb91c0cf99',
      'supervision_assignment_634cce10-6a76-4f8c-a041-b181f9774380',
    ];
    try {
      expect(registry.createOrGet({
        taskId, projectName: 'alpha', classification: 'integration_task', objective: 'already landed at c2fc056', now: 1,
      }).ok).toBe(true);
      for (const [index, assignmentId] of auditorIds.entries()) {
        const auditorIdentity = identity(`deck_legacy_auditor_${index}`, 'claude-code-sdk');
        const created = registry.createAssignment({
          assignmentId, taskId, role: 'auditor', required: true,
          identity: auditorIdentity,
          auditAttemptId: `legacy-attempt-${index}`,
          leaseId: `legacy-lease-${index}`,
          now: 2 + index,
        });
        if (!created.ok) throw new Error(created.reason);
        expect(registry.updateAssignment({
          assignmentId, identity: auditorIdentity, status: 'cancelled', now: 5 + index,
        }).ok).toBe(true);
      }
      const database = new DatabaseSync(dbPath);
      rewritePersistedTask(database, { ...registry.get(taskId)!, status: 'cancelled', currentRevision: undefined });
      for (const [index, assignmentId] of auditorIds.entries()) {
        rewritePersistedAssignment(database, {
          ...registry.getAssignment(assignmentId)!,
          status: 'delegated',
          leaseId: `legacy-lease-${index}`,
          blocker: undefined,
        });
      }
      database.close();

      const first = registry.convergeLifecycle(10, { limit: 2 });
      expect(first).toEqual([
        expect.objectContaining({ taskId, action: 'retire_terminal_stale_auditor' }),
        expect.objectContaining({ taskId, action: 'retire_terminal_stale_auditor' }),
      ]);
      expect(auditorIds.filter((id) => registry.getAssignment(id)!.status === 'cancelled')).toHaveLength(2);
      registry.close();

      registry = new SupervisionTaskRegistry({ dbPath });
      // Startup's existing cancelled-task repair may consume the final row
      // before the periodic backstop runs; either way, no replacement object
      // is created and the next tick has no repeated cleanup.
      const resumed = registry.convergeLifecycle(20, { limit: 2 });
      expect(resumed.length).toBeLessThanOrEqual(1);
      expect(resumed.every((action) => (
        action.taskId === taskId && action.action === 'retire_terminal_stale_auditor'
      ))).toBe(true);
      for (const assignmentId of auditorIds) {
        expect(registry.getAssignment(assignmentId)).toMatchObject({
          assignmentId, status: 'cancelled', leaseId: '',
        });
      }
      expect(registry.listAuditReceipts(taskId)).toEqual([]);
      const eventCount = registry.listEvents(taskId).length;
      expect(registry.convergeLifecycle(30, { limit: 2 })).toEqual([]);
      expect(registry.listEvents(taskId)).toHaveLength(eventCount);
    } finally {
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
    sessionName: options.replacementSessionName ?? `${shape.owner.identity.sessionName}_replacement`,
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
    status: 'implementing',
    blocker: 'R1 REWORK retained while project coordination remains active',
  });
  const coordinator = registry.createAssignment({
    assignmentId: `${taskId}-coordinator`, taskId, role: 'coordinator', required: false,
    identity: identity(`${taskId}-coordinator`),
  });
  if (!coordinator.ok) throw new Error(coordinator.reason);
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
  return { ...shape, toRevision, sourceAuditor: sourceAuditor.value, coordinator: coordinator.value };
}

beforeEach(() => {
  resetSupervisionTaskRegistryForTests();
  clearSendIdempotencyCacheForTests();
});

describe('SupervisionTaskRegistry', () => {

  it('durably persists every record_validation outcome on BOTH task and assignment', () => {
    // The R1 audit caught two real defects here:
    //  * supervision_tasks had no validation_state column in its upsert, so the
    //    task-side outcome was silently dropped;
    //  * failed/unavailable do not advance status, so the intent hit the
    //    "nothing changed" replay short-circuit and persisted nothing at all.
    // Both are asserted against raw SQLite, not through a convenience getter.
    const identityValue = identity('deck_alpha_worker');
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-validation-'));
    const dbPath = join(dir, 'state.sqlite');
    try {
      for (const [outcome, taskId] of [
        ['passed', 'val-passed'], ['failed', 'val-failed'], ['unavailable', 'val-unavailable'],
      ] as const) {
        let registry = new SupervisionTaskRegistry({ dbPath });
        expect(registry.createOrGet({
          taskId, projectName: 'alpha', classification: 'independent_top_level',
          objective: 'validation persistence', now: 1_000,
        }).ok).toBe(true);
        const assignment = registry.createAssignment({
          assignmentId: `${taskId}-asg`, taskId, role: 'implementer',
          identity: identityValue, scopeFiles: ['src/a.ts'], now: 2_000,
        });
        if (!assignment.ok) throw new Error(assignment.reason);
        expect(registry.updateTask({ taskId, status: 'implementing', now: 3_000 }).ok).toBe(true);
        expect(registry.updateAssignment({
          assignmentId: assignment.value.assignmentId, identity: identityValue,
          status: 'implementing', now: 3_000,
        }).ok).toBe(true);

        const result = registry.applyTaskIntent({
          taskId, assignmentId: assignment.value.assignmentId,
          intent: 'record_validation', validationState: outcome,
          ...(outcome === 'passed' ? { toStatus: 'validated' as const } : {}),
          now: 4_000,
        } as never);
        expect(result.ok, `${outcome} intent must be accepted`).toBe(true);
        // A non-advancing outcome must NOT be reported as an idempotent replay.
        expect((result as { replay?: boolean }).replay, `${outcome} must not no-op`).not.toBe(true);
        registry.close();

        // Exact SQLite counterexample: read the durable columns directly.
        const db = new DatabaseSync(dbPath);
        const taskRow = db.prepare('SELECT validation_state AS v FROM supervision_tasks WHERE task_id = ?')
          .get(taskId) as { v?: string } | undefined;
        const asgRow = db.prepare('SELECT validation_state AS v FROM supervision_task_assignments WHERE assignment_id = ?')
          .get(assignment.value.assignmentId) as { v?: string } | undefined;
        expect(taskRow?.v, `task validation_state for ${outcome}`).toBe(outcome);
        expect(asgRow?.v, `assignment validation_state for ${outcome}`).toBe(outcome);
        const events = db.prepare(
          "SELECT COUNT(*) AS n FROM supervision_task_events WHERE task_id = ? AND event_type LIKE '%validat%'",
        ).get(taskId) as { n: number };
        expect(events.n, `canonical validation event for ${outcome}`).toBeGreaterThan(0);
        db.close();

        // Restart readback: the outcome survives a fresh registry instance.
        registry = new SupervisionTaskRegistry({ dbPath });
        expect(registry.getAssignment(assignment.value.assignmentId)?.validationState).toBe(outcome);
        expect(registry.getTaskRecord(taskId)?.validationState).toBe(outcome);
        registry.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  it('finalizes and archives from exact PASS/Git/push authority when no CI provider is configured', () => {
    const registry = makeRegistry();
    const shape = prepareStructuredFinalizationShape(registry, 'structured-finalization-no-ci');
    const {
      externalRunId: _run, externalHeadSha: _head, externalTaskId: _task,
      ciResult: _ci, ...withoutCi
    } = shape.finalization;
    expect(registry.finalizeIntegration({
      ...withoutCi, ciResult: 'ci_not_configured', identity: shape.owner.identity,
    })).toMatchObject({
      ok: true,
      value: {
        status: 'finalized', archivedAt: expect.any(Number),
        finalization: { commitSha: shape.finalization.commitSha, ciResult: 'ci_not_configured' },
      },
    });
    expect(registry.get(shape.taskId)?.finalization).toHaveProperty('ciResult', 'ci_not_configured');
    expect(registry.get(shape.taskId)?.finalization).not.toHaveProperty('externalRunId');
    expect(registry.get(shape.taskId)?.finalization).not.toHaveProperty('externalHeadSha');
    registry.close();
  });

  it('finalizes the exact tsk_7l9 PASS already present on dev after only runtime metadata rotates', () => {
    const registry = makeRegistry();
    const shape = prepareStructuredFinalizationShape(registry, 'tsk_7l9', {
      ownerAssignmentId: 'asg_a3t',
      revision: 'supervision-console-stale-while-revalidate-cx5-r1-66338e3ccf07',
      attemptId: 'auto-audit-b216c040cdb19632efcfe4f7',
      commitSha: 'a3c610eef5997990a9bf608aa0b0d7401dc3a79b',
      files: Array.from({ length: 10 }, (_, index) => `web/src/tsk-7l9-${index}.ts`),
    });
    const rotatedBrain = {
      ...shape.owner.identity,
      sessionInstanceId: 'current-brain-instance',
      runtimeEpoch: 'current-brain-epoch',
      agentType: 'codex-sdk',
      providerFamily: 'openai',
    };
    const {
      externalRunId: _run, externalHeadSha: _head, externalTaskId: _task,
      ciResult: _ci, ...alreadyPresent
    } = shape.finalization;

    expect(registry.finalizeIntegration({
      ...alreadyPresent,
      pushResult: 'already_present',
      ciResult: 'ci_not_configured',
      identity: rotatedBrain,
    })).toMatchObject({
      ok: true,
      value: {
        status: 'finalized', archivedAt: expect.any(Number),
        commitSha: 'a3c610eef5997990a9bf608aa0b0d7401dc3a79b',
      },
    });
    expect(registry.finalizeIntegration({
      ...alreadyPresent,
      pushResult: 'already_present',
      ciResult: 'ci_not_configured',
      identity: { ...rotatedBrain, sessionName: 'deck_other_project_brain' },
    })).toEqual({ ok: false, reason: 'owner_mismatch' });
    registry.close();
  });

  it('records current exact-commit pending CI as optional smoke without blocking finalization', () => {
    const registry = makeRegistry();
    const shape = prepareStructuredFinalizationShape(registry, 'structured-finalization-current-ci-running');
    expect(registry.updateAssignment({
      assignmentId: shape.owner.assignmentId, identity: shape.owner.identity,
      externalRunId: '33839919696', externalHeadSha: shape.finalization.commitSha,
    })).toMatchObject({ ok: true });
    expect(registry.finalizeIntegration({
      ...shape.finalization,
      ciResult: 'pending',
      externalRunId: '33839919696', externalHeadSha: shape.finalization.commitSha,
      identity: shape.owner.identity,
    })).toMatchObject({
      ok: true,
      value: { status: 'finalized' },
    });
    expect(registry.get(shape.taskId)?.finalization).toMatchObject({
      ciResult: 'pending', externalRunId: '33839919696',
      externalHeadSha: shape.finalization.commitSha,
    });
    registry.close();
  });

  it('records current exact-commit failed CI as optional smoke without blocking PASS/Git/push finalization', () => {
    const registry = makeRegistry();
    const shape = prepareStructuredFinalizationShape(registry, 'structured-finalization-current-ci-failed');
    expect(registry.updateAssignment({
      assignmentId: shape.owner.assignmentId, identity: shape.owner.identity,
      externalRunId: 'current-failed-run', externalHeadSha: shape.finalization.commitSha,
    })).toMatchObject({ ok: true });
    expect(registry.finalizeIntegration({
      ...shape.finalization,
      ciResult: 'failure',
      externalRunId: 'current-failed-run', externalHeadSha: shape.finalization.commitSha,
      identity: shape.owner.identity,
    })).toMatchObject({
      ok: true,
      value: { status: 'finalized', archivedAt: expect.any(Number) },
    });
    expect(registry.get(shape.taskId)?.finalization).toMatchObject({
      ciResult: 'failure', externalRunId: 'current-failed-run',
      externalHeadSha: shape.finalization.commitSha,
    });
    registry.close();
  });

  it('does not leak a stale CI failure/run from another commit into current PASS finalization', () => {
    const registry = makeRegistry();
    const shape = prepareStructuredFinalizationShape(registry, 'structured-finalization-stale-ci-run');
    expect(registry.updateAssignment({
      assignmentId: shape.owner.assignmentId, identity: shape.owner.identity,
      externalRunId: 'old-failed-run-3812c300',
      externalHeadSha: '3812c30000000000000000000000000000000000',
    })).toMatchObject({ ok: true });
    expect(registry.finalizeIntegration({
      ...shape.finalization,
      ciResult: 'failure', externalRunId: 'old-failed-run-3812c300',
      externalHeadSha: '3812c30000000000000000000000000000000000',
      identity: shape.owner.identity,
    })).toEqual({ ok: false, reason: 'manifest_mismatch' });
    const {
      externalRunId: _run, externalHeadSha: _head, externalTaskId: _task,
      ciResult: _ci, ...withoutCi
    } = shape.finalization;
    expect(registry.finalizeIntegration({
      ...withoutCi, ciResult: 'ci_unavailable', identity: shape.owner.identity,
    }))
      .toMatchObject({ ok: true, value: { status: 'finalized' } });
    expect(registry.get(shape.taskId)?.finalization).not.toHaveProperty('externalRunId');
    expect(registry.get(shape.taskId)?.finalization).toHaveProperty('ciResult', 'ci_unavailable');
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
    expect(call({ ciResult: 'ci_not_configured' }))
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

  it('finalizes through the same durable project+session owner after runtime rotation and replays idempotently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-stale-integration-owner-'));
    const dbPath = join(dir, 'supervision-state.sqlite');
    let registry = new SupervisionTaskRegistry({ dbPath });
    try {
      const shape = prepareStructuredFinalizationShape(registry, 'stale-runtime-owner-restart');
      const rotatedIdentity = {
        ...shape.owner.identity,
        sessionInstanceId: 'rotated-owner-instance',
        runtimeEpoch: 'rotated-owner-epoch',
        agentType: 'claude-code-sdk',
        providerFamily: 'anthropic',
      };
      expect(registry.get(shape.taskId)).toMatchObject({
        status: 'ready_for_integration',
        currentRevision: shape.revision,
        integrationOwnerAssignmentId: shape.owner.assignmentId,
        assignments: expect.arrayContaining([
          expect.objectContaining({
            assignmentId: shape.owner.assignmentId,
            role: 'integration_owner', status: 'ready_for_integration', leaseId: '',
          }),
        ]),
      });
      registry.close();
      registry = new SupervisionTaskRegistry({ dbPath });

      const eventCount = registry.listEvents(shape.taskId).length;
      expect(registry.finalizeIntegration({
        ...shape.finalization, identity: rotatedIdentity, now: 500,
      })).toMatchObject({
        ok: true,
        value: {
          status: 'finalized',
          integrationOwnerAssignmentId: shape.owner.assignmentId,
          archivedAt: 500,
        },
      });
      expect(registry.getAssignment(shape.owner.assignmentId)).toMatchObject({
        status: 'finalized', leaseId: '',
      });
      expect(registry.listEvents(shape.taskId).length).toBeGreaterThan(eventCount);

      const finalizedEventCount = registry.listEvents(shape.taskId).length;
      registry.close();
      registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.finalizeIntegration({
        ...shape.finalization, identity: rotatedIdentity, now: 900,
      })).toMatchObject({
        ok: true, replay: true,
        value: {
          status: 'finalized',
          integrationOwnerAssignmentId: shape.owner.assignmentId,
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

  it('does not use runtime metadata to veto the exact durable owner', () => {
    const registry = makeRegistry();
    const shape = prepareStructuredFinalizationShape(registry, 'stale-owner-scope-record-only');
    const rotatedIdentity = {
      ...shape.owner.identity,
      sessionInstanceId: 'new-instance', runtimeEpoch: 'new-epoch',
      agentType: 'claude-code-sdk', providerFamily: 'anthropic',
    };
    expect(registry.finalizeIntegration({
      ...shape.finalization,
      identity: rotatedIdentity,
    })).toMatchObject({
      ok: true,
      value: {
        status: 'finalized',
        integrationOwnerAssignmentId: shape.owner.assignmentId,
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

  it('atomically rebinds one stale validated implementer runtime and preserves the same object across restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-validated-runtime-recovery-'));
    const dbPath = join(dir, 'supervision-state.sqlite');
    let registry = new SupervisionTaskRegistry({ dbPath });
    try {
      const shape = prepareValidatedStaleImplementerShape(registry, 'validated-runtime-recovery');
      const before = registry.getAssignment(shape.implementer.assignmentId)!;
      const assignmentCount = registry.listAssignments(shape.taskId).length;
      const eventCount = registry.listEvents(shape.taskId).length;
      const request = {
        taskId: shape.taskId,
        assignmentId: shape.implementer.assignmentId,
        identity: shape.currentIdentity,
        expectedRevision: shape.revision,
        ownedFiles: shape.files,
        evidenceManifestSha256: shape.evidenceManifestSha256,
        reason: 'daemon observed the same logical worker after restart',
        now: 500,
      };

      const rebound = registry.rebindValidatedImplementerAssignment(request);
      expect(rebound.ok, JSON.stringify({ rebound, task: registry.get(shape.taskId) })).toBe(true);
      expect(rebound).toMatchObject({
        ok: true,
        value: {
          assignmentId: shape.implementer.assignmentId,
          taskId: shape.taskId,
          identity: shape.currentIdentity,
          status: 'validated',
          leaseId: before.leaseId,
          auditRevision: shape.revision,
          generation: before.generation + 1,
        },
      });
      expect(registry.get(shape.taskId)).toMatchObject({
        taskId: shape.taskId, status: 'validated', currentRevision: shape.revision,
      });
      expect(registry.listAssignments(shape.taskId)).toHaveLength(assignmentCount);
      expect(registry.listFileClaims(shape.taskId)).toEqual([]);
      expect(registry.listEvents(shape.taskId).slice(eventCount)).toEqual([
        expect.objectContaining({
          assignmentId: shape.implementer.assignmentId,
          eventType: 'recovered', status: 'validated',
          payload: expect.objectContaining({
            source: 'brain_authorized_implementer_identity_rebind',
            priorIdentity: shape.oldIdentity,
            targetIdentity: shape.currentIdentity,
            revision: shape.revision,
            ownedFiles: shape.files,
            evidenceManifestSha256: shape.evidenceManifestSha256,
          }),
        }),
      ]);

      registry.close();
      registry = new SupervisionTaskRegistry({ dbPath });
      const persistedEvents = registry.listEvents(shape.taskId).length;
      expect(registry.rebindValidatedImplementerAssignment({ ...request, now: 900 }))
        .toMatchObject({ ok: true, replay: true, value: { identity: shape.currentIdentity } });
      expect(registry.listEvents(shape.taskId)).toHaveLength(persistedEvents);
      const nextIdentity = {
        ...shape.currentIdentity,
        sessionInstanceId: `${shape.taskId}-next-instance`,
        runtimeEpoch: `${shape.taskId}-next-epoch`,
      };
      const nextRequest = {
        ...request,
        identity: nextIdentity,
        reason: 'same logical worker restarted again',
        now: 950,
      };
      expect(registry.rebindValidatedImplementerAssignment(nextRequest)).toMatchObject({
        ok: true, value: { identity: nextIdentity, generation: before.generation + 2 },
      });
      expect(registry.rebindValidatedImplementerAssignment({ ...request, now: 960 }))
        .toEqual({ ok: false, reason: 'conflicting_replay' });
      expect(registry.updateAssignment({
        assignmentId: shape.implementer.assignmentId,
        identity: shape.oldIdentity,
        status: 'ready_for_audit', revision: shape.revision, auditRevision: shape.revision,
      })).toMatchObject({ ok: true, value: { status: 'ready_for_audit' } });
      expect(registry.updateAssignment({
        assignmentId: shape.implementer.assignmentId,
        identity: nextIdentity,
        status: 'ready_for_audit', revision: shape.revision, auditRevision: shape.revision,
      })).toMatchObject({ ok: true, value: { status: 'ready_for_audit' } });
      expect(registry.updateTask({
        taskId: shape.taskId, status: 'ready_for_audit', currentRevision: shape.revision,
      })).toMatchObject({ ok: true });
      const beforeReadyReplay = registry.listEvents(shape.taskId).length;
      expect(registry.rebindValidatedImplementerAssignment({ ...nextRequest, now: 1_000 }))
        .toMatchObject({ ok: true, replay: true, value: { status: 'ready_for_audit' } });
      expect(registry.listEvents(shape.taskId)).toHaveLength(beforeReadyReplay);
    } finally {
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects validated runtime recovery when a finalized same-revision PASS exists only on an assignment', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    try {
      const shape = prepareValidatedStaleImplementerShape(
        registry, 'runtime-recovery-finalized-assignment-pass',
      );
      const auditorIdentity = identity('runtime-recovery-finalized-assignment-pass-auditor');
      const auditor = registry.createAssignment({
        assignmentId: 'runtime-recovery-finalized-assignment-pass-auditor',
        taskId: shape.taskId,
        role: 'auditor',
        identity: auditorIdentity,
        auditAttemptId: 'assignment-only-pass-attempt',
        auditRevision: shape.revision,
      });
      if (!auditor.ok) throw new Error(auditor.reason);
      expect(registry.updateAssignment({
        assignmentId: auditor.value.assignmentId,
        identity: auditorIdentity,
        status: 'auditing',
        auditAttemptId: 'assignment-only-pass-attempt',
        auditRevision: shape.revision,
      })).toMatchObject({ ok: true });
      expect(registry.updateAssignment({
        assignmentId: auditor.value.assignmentId,
        identity: auditorIdentity,
        status: 'passed',
        auditAttemptId: 'assignment-only-pass-attempt',
        auditRevision: shape.revision,
        verdict: 'PASS',
        crossVendorAuditPassed: true,
      })).toMatchObject({ ok: true });
      expect(registry.finishAssignment({
        assignmentId: auditor.value.assignmentId,
        identity: auditorIdentity,
        revision: shape.revision,
      })).toMatchObject({ ok: true, value: { status: 'finalized', verdict: 'PASS' } });

      // Legacy assignment provenance can predate both receipt tables. It still
      // represents an authoritative PASS and must close the zero-PASS rebind.
      expect(registry.listAuditReceipts(shape.taskId)).toEqual([]);
      expect(database.prepare(
        'SELECT COUNT(*) AS count FROM supervision_audit_attestations WHERE task_id = ?',
      ).get(shape.taskId)).toEqual({ count: 0 });
      const before = registry.get(shape.taskId);
      const eventCount = registry.listEvents(shape.taskId).length;

      expect(registry.rebindValidatedImplementerAssignment({
        taskId: shape.taskId,
        assignmentId: shape.implementer.assignmentId,
        identity: shape.currentIdentity,
        expectedRevision: shape.revision,
        ownedFiles: shape.files,
        evidenceManifestSha256: shape.evidenceManifestSha256,
        reason: 'must not launder finalized assignment-only PASS provenance',
      })).toEqual({ ok: false, reason: 'invalid_transition' });
      expect(registry.get(shape.taskId)).toEqual(before);
      expect(registry.listEvents(shape.taskId)).toHaveLength(eventCount);
    } finally {
      registry.close();
      database.close();
    }
  });

  it('fails closed for current, cross-session, ambiguous, scope, revision, audit, claim, and terminal implementer recovery shapes', () => {
    const makeRequest = (shape: ReturnType<typeof prepareValidatedStaleImplementerShape>) => ({
      taskId: shape.taskId,
      assignmentId: shape.implementer.assignmentId,
      identity: shape.currentIdentity,
      expectedRevision: shape.revision,
      ownedFiles: shape.files,
      evidenceManifestSha256: shape.evidenceManifestSha256,
      reason: 'strict stale runtime recovery',
    });

    const currentRegistry = makeRegistry();
    const current = prepareValidatedStaleImplementerShape(currentRegistry, 'runtime-recovery-current');
    expect(currentRegistry.rebindValidatedImplementerAssignment({
      ...makeRequest(current), identity: current.oldIdentity,
    })).toEqual({ ok: false, reason: 'invalid_transition' });
    currentRegistry.close();

    const crossRegistry = makeRegistry();
    const cross = prepareValidatedStaleImplementerShape(crossRegistry, 'runtime-recovery-cross-session');
    expect(crossRegistry.rebindValidatedImplementerAssignment({
      ...makeRequest(cross), identity: identity('different-session'),
    })).toEqual({ ok: false, reason: 'owner_mismatch' });
    expect(crossRegistry.rebindValidatedImplementerAssignment({
      ...makeRequest(cross), identity: { ...cross.currentIdentity, runtimeEpoch: '' },
    })).toEqual({ ok: false, reason: 'invalid' });
    crossRegistry.close();

    const ambiguousRegistry = makeRegistry();
    const ambiguous = prepareValidatedStaleImplementerShape(
      ambiguousRegistry, 'runtime-recovery-ambiguous', { addAmbiguousImplementer: true },
    );
    expect(ambiguousRegistry.rebindValidatedImplementerAssignment(makeRequest(ambiguous)))
      .toEqual({ ok: false, reason: 'ambiguous_assignment' });
    ambiguousRegistry.close();

    const mismatchRegistry = makeRegistry();
    const mismatch = prepareValidatedStaleImplementerShape(mismatchRegistry, 'runtime-recovery-mismatch');
    expect(mismatchRegistry.rebindValidatedImplementerAssignment({
      ...makeRequest(mismatch), ownedFiles: [mismatch.files[0]!],
    })).toEqual({ ok: false, reason: 'manifest_mismatch' });
    expect(mismatchRegistry.rebindValidatedImplementerAssignment({
      ...makeRequest(mismatch), expectedRevision: 'other-revision',
    })).toEqual({ ok: false, reason: 'old_revision' });
    expect(mismatchRegistry.updateAssignment({
      assignmentId: mismatch.implementer.assignmentId, identity: mismatch.oldIdentity,
      auditAttemptId: 'unexpected-audit', verdict: 'PASS',
    })).toMatchObject({ ok: true });
    expect(mismatchRegistry.rebindValidatedImplementerAssignment(makeRequest(mismatch)))
      .toEqual({ ok: false, reason: 'invalid_transition' });
    mismatchRegistry.close();

    const claimDb = new DatabaseSync(':memory:');
    const claimRegistry = new SupervisionTaskRegistry({ database: claimDb });
    const claim = prepareValidatedStaleImplementerShape(claimRegistry, 'runtime-recovery-claim');
    claimDb.prepare(`INSERT INTO supervision_task_file_claims
      (task_id, assignment_id, file_path, claim_mode, created_at)
      VALUES (?, ?, ?, 'exclusive', 10)`)
      .run(claim.taskId, claim.implementer.assignmentId, claim.files[0]);
    expect(claimRegistry.rebindValidatedImplementerAssignment(makeRequest(claim)))
      .toEqual({ ok: false, reason: 'invalid_transition' });
    claimRegistry.close();
    claimDb.close();

    const terminalRegistry = makeRegistry();
    const terminal = prepareValidatedStaleImplementerShape(terminalRegistry, 'runtime-recovery-terminal');
    expect(terminalRegistry.updateTask({ taskId: terminal.taskId, status: 'cancelled' }))
      .toMatchObject({ ok: true });
    expect(terminalRegistry.rebindValidatedImplementerAssignment(makeRequest(terminal)))
      .toEqual({ ok: false, reason: 'invalid_transition' });
    terminalRegistry.close();
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
      status: 'implementing', currentRevision: shape.fromRevision,
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

  it('advances the task revision when the owner already carries the successor auditRevision', () => {
    // Live shape from tsk_4l8: a semantic rebase produced successor R4, the
    // integration owner already had auditRevision=R4 bound (an auditRevision-only
    // update succeeds), but task.currentRevision was still R3. Re-sending the
    // exact same R4 as `revision` was then refused as old_revision, so the task
    // revision could never catch up -- a deadlock, because bindsSuccessorRevision
    // requires requestedRevision !== existing.auditRevision and is therefore
    // false precisely once the assignment is already on the successor.
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const taskId = 'successor-task-revision-catchup';
    const older = 'console-delta-r3';
    const successor = 'console-delta-r4';
    const ownerIdentity = identity(`deck_${taskId}_owner`);

    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'independent_top_level',
      objective: 'advance the task revision to the bound successor', currentRevision: older,
    })).toMatchObject({ ok: true });
    const owner = registry.createAssignment({
      assignmentId: `${taskId}-owner`, taskId, role: 'integration_owner',
      identity: ownerIdentity, auditRevision: older,
    });
    if (!owner.ok) throw new Error('owner fixture creation failed');
    expect(registry.updateTask({ taskId, status: 'delegated' })).toMatchObject({ ok: true });
    expect(registry.updateTask({ taskId, status: 'implementing' })).toMatchObject({ ok: true });
    expect(registry.updateAssignment({
      assignmentId: owner.value.assignmentId, identity: ownerIdentity, status: 'implementing',
    })).toMatchObject({ ok: true });

    // Exactly the call that already works today: bind the successor on the
    // assignment alone, leaving the task revision behind.
    expect(registry.updateAssignment({
      assignmentId: owner.value.assignmentId, identity: ownerIdentity,
      auditRevision: successor,
    })).toMatchObject({ ok: true });
    expect(registry.getAssignment(owner.value.assignmentId)?.auditRevision).toBe(successor);
    expect(registry.getTaskRecord(taskId)?.currentRevision).toBe(older);

    // Now the same exact successor must be able to move the task revision.
    const advanced = registry.updateAssignment({
      assignmentId: owner.value.assignmentId, identity: ownerIdentity,
      revision: successor, auditRevision: successor,
    });
    expect(advanced, 'the bound successor must be able to advance the task revision')
      .toMatchObject({ ok: true });
    expect(
      registry.getTaskRecord(taskId)?.currentRevision,
      'task.currentRevision and assignment.auditRevision must advance atomically',
    ).toBe(successor);
    expect(registry.getAssignment(owner.value.assignmentId)?.auditRevision).toBe(successor);
    registry.close();
    database.close();
  });
  function prepareCatchUpShape(registry: SupervisionTaskRegistry, taskId: string) {
    const older = `${taskId}-r3`;
    const successor = `${taskId}-r4`;
    const attemptId = `${taskId}-attempt-r3`;
    const ownerIdentity = identity(`deck_${taskId}_owner`);
    const auditorIdentity = identity(`deck_${taskId}_auditor`, 'codex-sdk');
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'independent_top_level',
      objective: 'predecessor PASS must not authorize a successor', currentRevision: older,
    })).toMatchObject({ ok: true });
    const owner = registry.createAssignment({
      assignmentId: `${taskId}-owner`, taskId, role: 'integration_owner',
      identity: ownerIdentity,
    });
    const auditor = registry.createAssignment({
      assignmentId: `${taskId}-auditor`, taskId, role: 'auditor', required: false,
      identity: auditorIdentity, auditAttemptId: attemptId, auditRevision: older,
    });
    // finishAssignment resolves through exactly one active implementer.
    const implementerIdentity = identity(`deck_${taskId}_worker`);
    const implementer = registry.createAssignment({
      assignmentId: `${taskId}-implementer`, taskId, role: 'implementer',
      identity: implementerIdentity, scopeFiles: ['src/a.ts'],
      auditAttemptId: attemptId, auditRevision: older,
    });
    if (!owner.ok || !auditor.ok || !implementer.ok) throw new Error('catch-up fixture failed');
    expect(registry.updateTask({ taskId, status: 'delegated' })).toMatchObject({ ok: true });
    expect(registry.updateTask({ taskId, status: 'implementing' })).toMatchObject({ ok: true });
    // The owner deliberately STAYS in implementing -- that is the catch-up shape.
    expect(registry.updateAssignment({
      assignmentId: owner.value.assignmentId, identity: ownerIdentity, status: 'implementing',
    })).toMatchObject({ ok: true });
    expect(registry.updateAssignment({
      assignmentId: implementer.value.assignmentId, identity: implementerIdentity,
      status: 'implementing',
    })).toMatchObject({ ok: true });
    expect(registry.updateAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditorIdentity,
      status: 'auditing', auditAttemptId: attemptId, auditRevision: older,
    })).toMatchObject({ ok: true });
    expect(registry.appendMatchingAuditReceipt({
      taskId, auditorAssignmentId: auditor.value.assignmentId,
      attemptId, revision: older, receiptKind: 'final', verdict: 'PASS',
      auditorSessionName: auditorIdentity.sessionName, auditorIdentity,
      findings: 'accepted predecessor PASS',
      validations: [{ kind: 'test', label: 'frozen', outcome: 'passed', summary: 'predecessor evidence' }],
    })).toMatchObject({ ok: true, value: { verdict: 'PASS' } });
    expect(registry.finishAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditorIdentity, revision: older,
    })).toMatchObject({ ok: true });
    // Bind the owner pointer only after the auditor is finalized, so the
    // predecessor PASS is unambiguously the auditor's.
    expect(registry.updateAssignment({
      assignmentId: owner.value.assignmentId, identity: ownerIdentity, auditRevision: older,
    })).toMatchObject({ ok: true });
    // Exact acceptance state: predecessor PASS retained, owner still implementing.
    expect(registry.updateTask({ taskId, status: 'ready_for_integration' })).toMatchObject({ ok: true });
    return { taskId, older, successor, owner: owner.value, ownerIdentity, auditorIdentity };
  }

  it('demotes the predecessor integration-ready projection when the revision catches up', () => {
    // Cx REWORK P1: the accepted R3 PASS must never authorize the unaudited R4.
    const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
    const shape = prepareCatchUpShape(registry, 'catchup-old-pass');
    expect(registry.getTaskRecord(shape.taskId)).toMatchObject({
      status: 'ready_for_integration', currentRevision: shape.older,
    });

    // auditRevision-only pointer move to the successor (this already worked).
    expect(registry.updateAssignment({
      assignmentId: shape.owner.assignmentId, identity: shape.ownerIdentity,
      auditRevision: shape.successor,
    })).toMatchObject({ ok: true });

    expect(registry.updateAssignment({
      assignmentId: shape.owner.assignmentId, identity: shape.ownerIdentity,
      revision: shape.successor, auditRevision: shape.successor,
    })).toMatchObject({ ok: true });

    const after = registry.getTaskRecord(shape.taskId);
    expect(after?.currentRevision, 'the revision must advance atomically').toBe(shape.successor);
    expect(
      after?.status,
      'an unaudited successor must not inherit the predecessor PASS lifecycle',
    ).toBe('implementing');
  });

  it('refuses a catch-up that would move the task back onto an already audited revision', () => {
    // Downgrade is decidable from existing relations: the requested revision
    // already carries an accepted final PASS receipt.
    const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
    const shape = prepareCatchUpShape(registry, 'catchup-two-pass');
    expect(registry.updateAssignment({
      assignmentId: shape.owner.assignmentId, identity: shape.ownerIdentity,
      auditRevision: shape.successor,
    })).toMatchObject({ ok: true });
    expect(registry.updateAssignment({
      assignmentId: shape.owner.assignmentId, identity: shape.ownerIdentity,
      revision: shape.successor, auditRevision: shape.successor,
    })).toMatchObject({ ok: true });
    expect(registry.getTaskRecord(shape.taskId)?.currentRevision).toBe(shape.successor);

    // Point the owner back at the AUDITED predecessor and try to drag the task back.
    expect(registry.updateAssignment({
      assignmentId: shape.owner.assignmentId, identity: shape.ownerIdentity,
      auditRevision: shape.older,
    })).toMatchObject({ ok: true });
    expect(registry.updateAssignment({
      assignmentId: shape.owner.assignmentId, identity: shape.ownerIdentity,
      revision: shape.older, auditRevision: shape.older,
    }), 'a downgrade onto an audited revision must be refused')
      .toMatchObject({ ok: false, reason: 'old_revision' });
    expect(
      registry.getTaskRecord(shape.taskId)?.currentRevision,
      'a refused downgrade must not move the revision',
    ).toBe(shape.successor);
  });

  it('refuses a catch-up from an owner that is not the task integration pointer', () => {
    const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
    const shape = prepareCatchUpShape(registry, 'catchup-ptr-pass');
    const otherIdentity = identity('deck_catchup_second_owner');
    const second = registry.createAssignment({
      assignmentId: 'catchup-wrong-pointer-owner-2', taskId: shape.taskId,
      role: 'integration_owner', identity: otherIdentity, auditRevision: shape.older,
    });
    if (!second.ok) throw new Error('second owner fixture failed');
    expect(registry.updateAssignment({
      assignmentId: second.value.assignmentId, identity: otherIdentity, status: 'implementing',
    })).toMatchObject({ ok: true });
    expect(registry.updateAssignment({
      assignmentId: second.value.assignmentId, identity: otherIdentity,
      auditRevision: shape.successor,
    })).toMatchObject({ ok: true });

    expect(registry.getTaskRecord(shape.taskId)?.integrationOwnerAssignmentId)
      .toBe(shape.owner.assignmentId);
    expect(registry.updateAssignment({
      assignmentId: second.value.assignmentId, identity: otherIdentity,
      revision: shape.successor, auditRevision: shape.successor,
    }), 'a non-pointer owner must not drive the catch-up')
      .toMatchObject({ ok: false, reason: 'owner_mismatch' });
    expect(registry.getTaskRecord(shape.taskId)?.currentRevision).toBe(shape.older);
  });

  it('does not widen the ordinary lifecycle: plain updateTask cannot walk back to implementing', () => {
    // The catch-up demotion is scoped to its own authorized transaction. The
    // shared transition table must stay untouched, so the generic surface still
    // refuses ready_for_integration -> implementing.
    const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
    const shape = prepareCatchUpShape(registry, 'catchup-no-widening');
    expect(registry.getTaskRecord(shape.taskId)).toMatchObject({ status: 'ready_for_integration' });
    expect(
      registry.updateTask({ taskId: shape.taskId, status: 'implementing' }),
      'the ordinary lifecycle surface must not gain this edge',
    ).toMatchObject({ ok: false });
    expect(registry.getTaskRecord(shape.taskId)?.status).toBe('ready_for_integration');
  });

  it('refuses a catch-up from an optional implementer when the task has an authoritative pointer', () => {
    // Cx6 REWORK: completesSuccessorRevision admits EVERY non-auditor, but the
    // pointer gate only ran for role === 'integration_owner'. So while the task
    // pointer named a different owner, an authenticated required:false
    // implementer could bind auditRevision=R4 and then submit revision=R4,
    // moving the task revision without any pointer authority at all. The gate
    // must key on authority, not on role.
    const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
    const shape = prepareCatchUpShape(registry, 'catchup-optional-impl');
    const strangerIdentity = identity('deck_catchup_optional_impl');
    const stranger = registry.createAssignment({
      assignmentId: 'catchup-optional-impl-extra', taskId: shape.taskId,
      role: 'implementer', required: false, identity: strangerIdentity,
    });
    if (!stranger.ok) throw new Error('optional implementer fixture failed');
    expect(registry.updateAssignment({
      assignmentId: stranger.value.assignmentId, identity: strangerIdentity, status: 'implementing',
    })).toMatchObject({ ok: true });
    expect(registry.updateAssignment({
      assignmentId: stranger.value.assignmentId, identity: strangerIdentity,
      auditRevision: shape.successor,
    })).toMatchObject({ ok: true });

    // The pointer names the real integration owner, not this assignment.
    expect(registry.getTaskRecord(shape.taskId)?.integrationOwnerAssignmentId)
      .toBe(shape.owner.assignmentId);

    expect(registry.updateAssignment({
      assignmentId: stranger.value.assignmentId, identity: strangerIdentity,
      revision: shape.successor, auditRevision: shape.successor,
    }), 'an optional implementer must not move the task revision past the pointer')
      .toMatchObject({ ok: false });
    expect(
      registry.getTaskRecord(shape.taskId)?.currentRevision,
      'the task revision must be unchanged',
    ).toBe(shape.older);
  });

  it('refuses a catch-up driven by a required coordinator even with no pointer', () => {
    // Cx6 REWORK: R3's no-pointer fallback only checked `required`, so a
    // required:true COORDINATOR -- an observer/orchestrator that owns no
    // implementation authority -- could bind auditRevision=r3 and then move the
    // task revision. Authority must additionally be an implementation role.
    const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
    const taskId = 'catchup-coordinator-authority';
    const coordinatorIdentity = identity(`deck_${taskId}_brain`, 'codex-sdk');
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'independent_top_level',
      objective: 'coordinators are not implementation authority', currentRevision: 'coord-r2',
    })).toMatchObject({ ok: true });
    const coordinator = registry.createAssignment({
      assignmentId: `${taskId}-coordinator`, taskId, role: 'coordinator',
      required: true, identity: coordinatorIdentity, auditRevision: 'coord-r2',
    });
    if (!coordinator.ok) throw new Error('coordinator fixture failed');
    expect(registry.updateTask({ taskId, status: 'delegated' })).toMatchObject({ ok: true });
    expect(registry.updateTask({ taskId, status: 'implementing' })).toMatchObject({ ok: true });
    expect(registry.updateAssignment({
      assignmentId: coordinator.value.assignmentId, identity: coordinatorIdentity,
      status: 'implementing',
    })).toMatchObject({ ok: true });
    expect(registry.getTaskRecord(taskId)?.integrationOwnerAssignmentId).toBeUndefined();

    expect(registry.updateAssignment({
      assignmentId: coordinator.value.assignmentId, identity: coordinatorIdentity,
      auditRevision: 'coord-r3',
    })).toMatchObject({ ok: true });

    expect(registry.updateAssignment({
      assignmentId: coordinator.value.assignmentId, identity: coordinatorIdentity,
      revision: 'coord-r3', auditRevision: 'coord-r3',
    }), 'a coordinator must not advance the task revision').toMatchObject({ ok: false });
    expect(
      registry.getTaskRecord(taskId)?.currentRevision,
      'the task revision must be unchanged',
    ).toBe('coord-r2');
  });

  it('refuses a ONE-CALL successor bind from a non-pointer optional implementer', () => {
    // Cx6 REWORK on R4: R1-R4 all guarded the two-step catch-up
    // (completesSuccessorRevision). A single
    // updateAssignment({revision, auditRevision}) takes the
    // bindsSuccessorRevision path instead and skipped every one of those gates.
    const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
    const shape = prepareCatchUpShape(registry, 'onecall-nonpointer');
    const strangerIdentity = identity('deck_onecall_stranger');
    const stranger = registry.createAssignment({
      assignmentId: 'onecall-nonpointer-extra', taskId: shape.taskId,
      role: 'implementer', required: false, identity: strangerIdentity,
      auditRevision: shape.older,
    });
    if (!stranger.ok) throw new Error('optional implementer fixture failed');
    expect(registry.updateAssignment({
      assignmentId: stranger.value.assignmentId, identity: strangerIdentity, status: 'implementing',
    })).toMatchObject({ ok: true });
    expect(registry.getTaskRecord(shape.taskId)?.integrationOwnerAssignmentId)
      .toBe(shape.owner.assignmentId);

    // ONE call: bind the successor and move the revision in a single request.
    expect(registry.updateAssignment({
      assignmentId: stranger.value.assignmentId, identity: strangerIdentity,
      revision: shape.successor, auditRevision: shape.successor,
    }), 'a single-call successor bind must obey the same authority boundary')
      .toMatchObject({ ok: false });
    expect(
      registry.getTaskRecord(shape.taskId)?.currentRevision,
      'the task revision must be unchanged',
    ).toBe(shape.older);
  });

  it('refuses a ONE-CALL successor bind from the exact pointer owner on a blocked task', () => {
    // Same boundary, terminal dimension: even the authoritative pointer owner
    // must not move the task revision while the task is blocked.
    const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
    const shape = prepareCatchUpShape(registry, 'onecall-blocked');
    expect(registry.updateTask({ taskId: shape.taskId, status: 'blocked' })).toMatchObject({ ok: true });

    expect(registry.updateAssignment({
      assignmentId: shape.owner.assignmentId, identity: shape.ownerIdentity,
      revision: shape.successor, auditRevision: shape.successor,
    }), 'a blocked task must refuse a single-call successor bind')
      .toMatchObject({ ok: false });
    expect(
      registry.getTaskRecord(shape.taskId)?.currentRevision,
      'the task revision must be unchanged',
    ).toBe(shape.older);
  });

  // One boundary, both shapes: every dimension is exercised through a single
  // updateAssignment (bindsSuccessorRevision) AND through the two-step
  // auditRevision-then-revision catch-up (completesSuccessorRevision).
  for (const shapeName of ['one-call', 'two-call'] as const) {
    const advance = (
      registry: SupervisionTaskRegistry,
      assignmentId: string,
      who: ReturnType<typeof identity>,
      revision: string,
    ) => {
      if (shapeName === 'two-call') {
        const bound = registry.updateAssignment({ assignmentId, identity: who, auditRevision: revision });
        if (!bound.ok) return bound;
      }
      return registry.updateAssignment({ assignmentId, identity: who, revision, auditRevision: revision });
    };

    it(`(${shapeName}) lets the no-pointer required implementer advance the task revision`, () => {
      const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
      const taskId = `matrix-ok-${shapeName}`;
      const workerIdentity = identity(`deck_${taskId}_worker`);
      expect(registry.createOrGet({
        taskId, projectName: 'alpha', classification: 'independent_top_level',
        objective: 'ordinary successor advance', currentRevision: 'm-r2',
      })).toMatchObject({ ok: true });
      const worker = registry.createAssignment({
        assignmentId: `${taskId}-impl`, taskId, role: 'implementer',
        identity: workerIdentity, scopeFiles: ['src/a.ts'], auditRevision: 'm-r2',
      });
      if (!worker.ok) throw new Error('fixture failed');
      expect(registry.updateTask({ taskId, status: 'delegated' })).toMatchObject({ ok: true });
      expect(registry.updateTask({ taskId, status: 'implementing' })).toMatchObject({ ok: true });
      expect(registry.updateAssignment({
        assignmentId: worker.value.assignmentId, identity: workerIdentity, status: 'implementing',
      })).toMatchObject({ ok: true });
      expect(registry.getTaskRecord(taskId)?.integrationOwnerAssignmentId).toBeUndefined();

      expect(advance(registry, worker.value.assignmentId, workerIdentity, 'm-r3'))
        .toMatchObject({ ok: true });
      expect(registry.getTaskRecord(taskId)?.currentRevision).toBe('m-r3');
    });

    it(`(${shapeName}) refuses a coordinator, a non-pointer optional implementer, and a blocked task`, () => {
      // coordinator, no pointer
      const coordReg = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
      const coordIdentity = identity('deck_matrix_coord', 'codex-sdk');
      expect(coordReg.createOrGet({
        taskId: 'matrix-coord', projectName: 'alpha', classification: 'independent_top_level',
        objective: 'coordinator has no implementation authority', currentRevision: 'c-r2',
      })).toMatchObject({ ok: true });
      const coord = coordReg.createAssignment({
        assignmentId: 'matrix-coord-c', taskId: 'matrix-coord', role: 'coordinator',
        required: true, identity: coordIdentity, auditRevision: 'c-r2',
      });
      if (!coord.ok) throw new Error('fixture failed');
      expect(coordReg.updateTask({ taskId: 'matrix-coord', status: 'delegated' })).toMatchObject({ ok: true });
      expect(coordReg.updateTask({ taskId: 'matrix-coord', status: 'implementing' })).toMatchObject({ ok: true });
      expect(coordReg.updateAssignment({
        assignmentId: coord.value.assignmentId, identity: coordIdentity, status: 'implementing',
      })).toMatchObject({ ok: true });
      expect(advance(coordReg, coord.value.assignmentId, coordIdentity, 'c-r3')).toMatchObject({ ok: false });
      expect(coordReg.getTaskRecord('matrix-coord')?.currentRevision).toBe('c-r2');

      // non-pointer optional implementer, pointer names someone else
      const ptrReg = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
      const ptrShape = prepareCatchUpShape(ptrReg, `matrix-ptr-${shapeName}`);
      const strangerIdentity = identity(`deck_matrix_stranger_${shapeName}`);
      const stranger = ptrReg.createAssignment({
        assignmentId: `matrix-ptr-${shapeName}-extra`, taskId: ptrShape.taskId,
        role: 'implementer', required: false, identity: strangerIdentity, auditRevision: ptrShape.older,
      });
      if (!stranger.ok) throw new Error('fixture failed');
      expect(ptrReg.updateAssignment({
        assignmentId: stranger.value.assignmentId, identity: strangerIdentity, status: 'implementing',
      })).toMatchObject({ ok: true });
      expect(advance(ptrReg, stranger.value.assignmentId, strangerIdentity, ptrShape.successor))
        .toMatchObject({ ok: false });
      expect(ptrReg.getTaskRecord(ptrShape.taskId)?.currentRevision).toBe(ptrShape.older);

      // exact pointer owner, but the task is blocked
      const blockedReg = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
      const blockedShape = prepareCatchUpShape(blockedReg, `matrix-blocked-${shapeName}`);
      expect(blockedReg.updateTask({ taskId: blockedShape.taskId, status: 'blocked' })).toMatchObject({ ok: true });
      expect(advance(blockedReg, blockedShape.owner.assignmentId, blockedShape.ownerIdentity, blockedShape.successor))
        .toMatchObject({ ok: false });
      expect(blockedReg.getTaskRecord(blockedShape.taskId)?.currentRevision).toBe(blockedShape.older);
    });
  }

  it('revokes the predecessor PASS projection on a ONE-CALL successor bind', () => {
    // Cx6 REWORK on R5: R5 unified the GUARDS across both shapes but left the
    // predecessor-PASS isolation EFFECT branching on completesSuccessorRevision.
    // A single updateAssignment({revision, auditRevision}) therefore advanced the
    // revision while leaving task=ready_for_integration and the predecessor
    // implementer still holding its R3 PASS -- the old audit authorizing new bytes.
    const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
    const shape = prepareCatchUpShape(registry, 'onecall-old-pass');
    expect(registry.getTaskRecord(shape.taskId)).toMatchObject({
      status: 'ready_for_integration', currentRevision: shape.older,
    });
    const predecessor = registry.listAssignments(shape.taskId)
      .find((a) => a.role === 'implementer');
    expect(predecessor).toMatchObject({ status: 'ready_for_integration', verdict: 'PASS' });

    // ONE call: bind the successor and move the revision in a single request.
    expect(registry.updateAssignment({
      assignmentId: shape.owner.assignmentId, identity: shape.ownerIdentity,
      revision: shape.successor, auditRevision: shape.successor,
    })).toMatchObject({ ok: true });

    expect(registry.getTaskRecord(shape.taskId)?.currentRevision).toBe(shape.successor);
    expect(
      registry.getTaskRecord(shape.taskId)?.status,
      'an unaudited successor must not inherit the predecessor PASS lifecycle',
    ).toBe('implementing');
    const after = registry.listAssignments(shape.taskId).find((a) => a.role === 'implementer');
    expect(after?.status, 'the predecessor implementer must be demoted').toBe('implementing');
    expect(after?.verdict, 'the predecessor PASS must not survive the successor').toBeUndefined();
  });

  // The predecessor-PASS isolation EFFECT must be identical for both shapes.
  for (const shapeName of ['one-call', 'two-call'] as const) {
    it(`(${shapeName}) produces the same predecessor-PASS revocation`, () => {
      const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
      const shape = prepareCatchUpShape(registry, `equiv-${shapeName}`);
      expect(registry.getTaskRecord(shape.taskId)).toMatchObject({
        status: 'ready_for_integration', currentRevision: shape.older,
      });

      if (shapeName === 'two-call') {
        expect(registry.updateAssignment({
          assignmentId: shape.owner.assignmentId, identity: shape.ownerIdentity,
          auditRevision: shape.successor,
        })).toMatchObject({ ok: true });
      }
      expect(registry.updateAssignment({
        assignmentId: shape.owner.assignmentId, identity: shape.ownerIdentity,
        revision: shape.successor, auditRevision: shape.successor,
      })).toMatchObject({ ok: true });

      // Identical post-state whichever shape got here.
      const task = registry.getTaskRecord(shape.taskId);
      expect(task?.currentRevision).toBe(shape.successor);
      expect(task?.status).toBe('implementing');
      const predecessor = registry.listAssignments(shape.taskId)
        .find((a) => a.role === 'implementer');
      expect(predecessor?.status).toBe('implementing');
      expect(predecessor?.verdict).toBeUndefined();
      expect(predecessor?.crossVendorAuditPassed).toBeUndefined();
      // The predecessor's own audit history is retired, not rewritten.
      expect(predecessor?.auditRevision).toBe(shape.older);
    });
  }

  // R7 (Cx R6 P1): the unified successor effects cleared verdict and
  // crossVendorAuditPassed but NOT the revision-scoped primaryReviewPassed. An
  // economy implementer therefore carried its R3 primary review across the
  // R3->R4 boundary, so supplying only a fresh R4 cross-vendor receipt satisfied
  // mayFinalizeEconomyAssignment and reached ready_for_integration -- an old
  // primary review authorizing unaudited successor bytes.
  for (const shapeName of ['one-call', 'two-call'] as const) {
    it(`(${shapeName}) clears the economy primary review when the revision moves to a successor`, () => {
      const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
      const taskId = `economy-primary-${shapeName}`;
      const older = `${taskId}-r3`;
      const successor = `${taskId}-r4`;
      const workerIdentity = identity(`deck_${taskId}_worker`);

      expect(registry.createOrGet({
        taskId, projectName: 'alpha', classification: 'independent_top_level',
        objective: 'economy primary review is revision scoped', currentRevision: older,
      })).toMatchObject({ ok: true });
      const economyBinding = {
        ...persistedExecutionBinding(`deck_${taskId}_worker`),
        pool: 'economy' as const,
      };
      const worker = registry.createAssignment({
        assignmentId: `${taskId}-impl`, taskId, role: 'implementer',
        identity: workerIdentity, scopeFiles: ['src/a.ts'], auditRevision: older,
        executionBinding: economyBinding,
      });
      if (!worker.ok) throw new Error('economy fixture failed');
      expect(registry.updateTask({ taskId, status: 'delegated' })).toMatchObject({ ok: true });
      expect(registry.updateTask({ taskId, status: 'implementing' })).toMatchObject({ ok: true });
      // The R3 round: an economy implementer that earned BOTH reviews.
      expect(registry.updateAssignment({
        assignmentId: worker.value.assignmentId, identity: workerIdentity,
        status: 'implementing', primaryReviewPassed: true,
      })).toMatchObject({ ok: true });
      expect(registry.getAssignment(worker.value.assignmentId)?.primaryReviewPassed).toBe(true);

      // Move the task revision onto the unaudited successor.
      if (shapeName === 'two-call') {
        expect(registry.updateAssignment({
          assignmentId: worker.value.assignmentId, identity: workerIdentity, auditRevision: successor,
        })).toMatchObject({ ok: true });
      }
      expect(registry.updateAssignment({
        assignmentId: worker.value.assignmentId, identity: workerIdentity,
        revision: successor, auditRevision: successor,
      })).toMatchObject({ ok: true });

      const after = registry.getAssignment(worker.value.assignmentId);
      expect(registry.getTaskRecord(taskId)?.currentRevision).toBe(successor);
      expect(
        after?.primaryReviewPassed,
        'an R3 primary review must not survive onto the R4 successor',
      ).not.toBe(true);
      // Terminal-state equivalence across both shapes.
      expect(after?.status).toBe('implementing');
      expect(after?.verdict).toBeUndefined();
      expect(after?.crossVendorAuditPassed).toBeUndefined();
      // The predecessor revision itself is retired, never rewritten.
      expect(after?.auditRevision).toBe(successor);
      registry.close();
    });
  }

  it('clears the economy primary review on a PARKED predecessor implementer too', () => {
    // Distinct from the caller-record case: here the owner moving the revision
    // is a different assignment, and the economy implementer is parked at
    // ready_for_integration on the predecessor. Without this the demotion loop's
    // own clearing is unverified -- a mutant that drops it passes.
    const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
    const shape = prepareCatchUpShape(registry, 'economy-parked');
    const parked = registry.listAssignments(shape.taskId).find((a) => a.role === 'implementer');
    expect(parked?.status, 'the fixture must park an implementer on the predecessor')
      .toBe('ready_for_integration');

    // Give that parked predecessor an economy primary review for the old revision.
    expect(registry.updateAssignment({
      assignmentId: parked!.assignmentId, identity: parked!.identity,
      primaryReviewPassed: true,
    })).toMatchObject({ ok: true });
    expect(registry.getAssignment(parked!.assignmentId)?.primaryReviewPassed).toBe(true);

    // A DIFFERENT assignment (the pointer owner) moves the task revision.
    expect(registry.updateAssignment({
      assignmentId: shape.owner.assignmentId, identity: shape.ownerIdentity,
      revision: shape.successor, auditRevision: shape.successor,
    })).toMatchObject({ ok: true });

    const after = registry.getAssignment(parked!.assignmentId);
    expect(after?.status, 'the parked predecessor must be demoted').toBe('implementing');
    expect(
      after?.primaryReviewPassed,
      'a parked predecessor must not keep its primary review across the boundary',
    ).not.toBe(true);
    expect(after?.verdict).toBeUndefined();
    // Its own audit history is retired, not rewritten.
    expect(after?.auditRevision).toBe(shape.older);
    registry.close();
  });

  it('refuses a revision catch-up on a blocked task', () => {
    const registry = getSupervisionTaskRegistry();
    const taskId = 'catchup-blocked';
    const ownerIdentity = identity(`deck_${taskId}_owner`);
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'independent_top_level',
      objective: 'blocked tasks refuse catch-up', currentRevision: 'blk-r1',
    })).toMatchObject({ ok: true });
    const owner = registry.createAssignment({
      assignmentId: `${taskId}-owner`, taskId, role: 'integration_owner',
      identity: ownerIdentity, auditRevision: 'blk-r1',
    });
    if (!owner.ok) throw new Error('fixture failed');
    expect(registry.updateTask({ taskId, status: 'delegated' })).toMatchObject({ ok: true });
    expect(registry.updateTask({ taskId, status: 'implementing' })).toMatchObject({ ok: true });
    expect(registry.updateAssignment({
      assignmentId: owner.value.assignmentId, identity: ownerIdentity, status: 'implementing',
    })).toMatchObject({ ok: true });
    expect(registry.updateAssignment({
      assignmentId: owner.value.assignmentId, identity: ownerIdentity, auditRevision: 'blk-r2',
    })).toMatchObject({ ok: true });
    expect(registry.updateTask({ taskId, status: 'blocked' })).toMatchObject({ ok: true });

    expect(registry.updateAssignment({
      assignmentId: owner.value.assignmentId, identity: ownerIdentity,
      revision: 'blk-r2', auditRevision: 'blk-r2',
    }), 'a blocked task must refuse the catch-up').toMatchObject({ ok: false });
    expect(registry.getTaskRecord(taskId)?.currentRevision).toBe('blk-r1');
  });

  it('still fails closed on Git authority and foreign identity during a revision catch-up', () => {
    // The catch-up exemption must move the task revision ONTO the successor the
    // assignment already carries, and nothing else.
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const identityOf = (taskId: string) => identity(`deck_${taskId}_owner`);

    const build = (taskId: string, current: string, bound: string) => {
      const ownerIdentity = identityOf(taskId);
      expect(registry.createOrGet({
        taskId, projectName: 'alpha', classification: 'independent_top_level',
        objective: 'fail-closed boundary', currentRevision: current,
      })).toMatchObject({ ok: true });
      const owner = registry.createAssignment({
        assignmentId: `${taskId}-owner`, taskId, role: 'integration_owner',
        identity: ownerIdentity, auditRevision: current,
      });
      if (!owner.ok) throw new Error('fixture failed');
      expect(registry.updateTask({ taskId, status: 'delegated' })).toMatchObject({ ok: true });
      expect(registry.updateTask({ taskId, status: 'implementing' })).toMatchObject({ ok: true });
      expect(registry.updateAssignment({
        assignmentId: owner.value.assignmentId, identity: ownerIdentity, status: 'implementing',
      })).toMatchObject({ ok: true });
      expect(registry.updateAssignment({
        assignmentId: owner.value.assignmentId, identity: ownerIdentity, auditRevision: bound,
      })).toMatchObject({ ok: true });
      return { owner: owner.value, ownerIdentity };
    };

    // Git authority already exists -> the revision must never be rewritten.
    const git = build('catchup-git-authority', 'rev-r3', 'rev-r4');
    expect(registry.updateTask({
      taskId: 'catchup-git-authority', commitSha: 'a'.repeat(40),
    })).toMatchObject({ ok: true });
    expect(registry.updateAssignment({
      assignmentId: git.owner.assignmentId, identity: git.ownerIdentity,
      revision: 'rev-r4', auditRevision: 'rev-r4',
    }), 'a task carrying Git authority must fail closed').toMatchObject({
      ok: false, reason: 'invalid_transition',
    });
    expect(registry.getTaskRecord('catchup-git-authority')?.currentRevision).toBe('rev-r3');

    // A foreign identity must never drive the catch-up.
    const foreign = build('catchup-foreign', 'rev-r3', 'rev-r4');
    expect(registry.updateAssignment({
      assignmentId: foreign.owner.assignmentId, identity: identity('deck_other_project_owner'),
      revision: 'rev-r4', auditRevision: 'rev-r4',
    }), 'a foreign identity must be refused').toMatchObject({ ok: false });
    expect(registry.getTaskRecord('catchup-foreign')?.currentRevision).toBe('rev-r3');

    registry.close();
    database.close();
  });

  it('keeps the ordinary task-and-implementer REWORK finalized-successor recovery path', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = prepareFinalizedPassedSuccessorRecoveryShape(
      registry, database, 'ordinary-finalized-passed-successor',
    );
    rewritePersistedTask(database, {
      ...registry.get(shape.taskId)!, status: 'rework', updatedAt: 150,
    });
    expect(registry.get(shape.taskId)).toMatchObject({ status: 'rework' });
    expect(registry.rebindTaskAssignmentRevision({
      taskId: shape.taskId, assignmentId: shape.implementer.assignmentId,
      fromRevision: shape.fromRevision, toRevision: shape.toRevision,
      worktreeSnapshot: recoveryWorktreeSnapshot(shape.files, shape.evidenceManifestSha256),
      leaseAction: 'preserve', idempotencyKey: 'bind-ordinary-finalized-successor-r2',
      reason: 'preserve the ordinary exact task and implementer REWORK path',
    })).toMatchObject({
      ok: true, value: { status: 'implementing', currentRevision: shape.toRevision },
    });
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
    expect(before).toMatchObject({ status: 'implementing', currentRevision: shape.fromRevision });
    expect(registry.getAssignment(shape.implementer.assignmentId)).toMatchObject({
      status: 'rework', auditRevision: shape.fromRevision, verdict: 'REWORK',
      leaseId: expect.any(String),
    });
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

  it('keeps aggregate-implementing successor recovery narrow when source lifecycle or evidence is not exact', () => {
    for (const variant of [
      'implementer-implementing',
      'implementer-validated',
      'missing-active-lease',
      'inactive-coordinator',
      'mismatched-source-receipt',
    ] as const) {
      const database = new DatabaseSync(':memory:');
      const registry = new SupervisionTaskRegistry({ database });
      const shape = prepareFinalizedPassedSuccessorRecoveryShape(
        registry, database, `aggregate-implementing-${variant}`,
      );
      const implementer = registry.getAssignment(shape.implementer.assignmentId)!;
      if (variant === 'implementer-implementing' || variant === 'implementer-validated') {
        rewritePersistedAssignment(database, {
          ...implementer,
          status: variant === 'implementer-implementing' ? 'implementing' : 'validated',
          updatedAt: 150,
        });
      } else if (variant === 'missing-active-lease') {
        rewritePersistedAssignment(database, { ...implementer, leaseId: '', updatedAt: 150 });
      } else if (variant === 'inactive-coordinator') {
        rewritePersistedAssignment(database, {
          ...registry.getAssignment(shape.coordinator.assignmentId)!,
          status: 'cancelled', leaseId: '', updatedAt: 150,
        });
      } else {
        database.prepare(
          `UPDATE supervision_audit_receipts SET revision = ? WHERE receipt_id = ?`,
        ).run('mismatched-source-r0', `${shape.taskId}-r1-rework-receipt`);
      }

      const before = registry.get(shape.taskId);
      const assignments = registry.listAssignments(shape.taskId);
      const receipts = registry.listAuditReceipts(shape.taskId);
      const events = registry.listEvents(shape.taskId).length;
      expect(before).toMatchObject({ status: 'implementing', currentRevision: shape.fromRevision });
      expect(registry.rebindTaskAssignmentRevision({
        taskId: shape.taskId, assignmentId: shape.implementer.assignmentId,
        fromRevision: shape.fromRevision, toRevision: shape.toRevision,
        worktreeSnapshot: recoveryWorktreeSnapshot(shape.files, shape.evidenceManifestSha256),
        leaseAction: 'preserve', idempotencyKey: `refuse-${variant}`,
        reason: 'aggregate implementing must not widen successor recovery',
      }), variant).toEqual({ ok: false, reason: 'invalid_transition' });
      expect(registry.get(shape.taskId), variant).toEqual(before);
      expect(registry.listAssignments(shape.taskId), variant).toEqual(assignments);
      expect(registry.listAuditReceipts(shape.taskId), variant).toEqual(receipts);
      expect(registry.listEvents(shape.taskId), variant).toHaveLength(events);
      registry.close();
      database.close();
    }
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
      // This active auditor carries verdict PASS (on r2), so it is protected by
      // the strongest rule: an accepted PASS is authority and is NEVER
      // supersedable. Recovery still fails closed; the diagnostic just sharpened
      // from a generic invalid_transition to receipt_closed, which names why.
      // Retiring a stale auditor is permitted ONLY when it is bound to the
      // revision being superseded AND holds no accepted PASS.
      { taskId: 'revision-recovery-active-auditor', options: { keepAuditorActive: true }, expected: 'receipt_closed' },
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
      })).toMatchObject({ ok: false, reason: testCase.expected });
      // Refusal must leave the object byte-identical: fail-closed, not partial.
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
        callerProjectName: 'alpha',
        reason: 'Brain-authorized device replacement', now: 105,
      })).toMatchObject({ ok: true, value: { identity: reboundAuditorIdentity, generation: 2 } });
      expect(registry.appendMatchingAuditReceipt({
        taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId, revision,
        receiptKind: 'progress', auditorSessionName: auditorIdentity.sessionName,
        auditorIdentity, findings: 'stale device', validations: [], now: 106,
      })).toMatchObject({ ok: true, value: { sequence: 2 } });
      expect(registry.appendMatchingAuditReceipt({
        taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId, revision,
        receiptKind: 'progress', auditorSessionName: reboundAuditorIdentity.sessionName,
        auditorIdentity: reboundAuditorIdentity, findings: 'second progress', validations: [], now: 110,
      })).toMatchObject({ ok: true, value: { sequence: 3 } });
      expect(registry.appendMatchingAuditReceipt({
        taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId: 'wrong-attempt', revision,
        receiptKind: 'final', verdict: 'PASS', auditorSessionName: reboundAuditorIdentity.sessionName,
        auditorIdentity: reboundAuditorIdentity, findings: 'wrong attempt', validations: [], now: 111,
      })).toEqual({ ok: false, reason: 'old_audit_attempt' });
      expect(registry.appendMatchingAuditReceipt({
        taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId, revision,
        receiptKind: 'final', verdict: 'PASS', auditorSessionName: 'deck_other_auditor',
        auditorIdentity: { ...reboundAuditorIdentity, sessionName: 'deck_other_auditor' },
        findings: 'wrong identity', validations: [], now: 112,
      })).toEqual({ ok: false, reason: 'owner_mismatch' });
      expect(registry.listAuditReceipts(taskId)).toHaveLength(3);

      const pass = registry.appendMatchingAuditReceipt({
        taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId, revision,
        receiptKind: 'final', verdict: 'PASS', auditorSessionName: reboundAuditorIdentity.sessionName,
        auditorIdentity: reboundAuditorIdentity, findings: 'pass before correction',
        validations: [{ kind: 'test', label: 'focused', outcome: 'passed', summary: '1 passed' }], now: 120,
      });
      expect(pass).toMatchObject({ ok: true, value: { sequence: 4, verdict: 'PASS' } });
      expect(registry.getAssignment(implementer.value.assignmentId)?.status).toBe('ready_for_audit');
      const corrected = registry.appendMatchingAuditReceipt({
        taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId, revision,
        receiptKind: 'final', verdict: 'REWORK', auditorSessionName: reboundAuditorIdentity.sessionName,
        auditorIdentity: reboundAuditorIdentity, findings: 'correction before finish', validations: [], now: 130,
      });
      expect(corrected).toMatchObject({
        ok: true,
        value: { sequence: 5, verdict: 'REWORK', supersedesReceiptId: pass.ok ? pass.value.receiptId : undefined },
      });
      expect(registry.appendMatchingAuditReceipt({
        taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId, revision,
        receiptKind: 'final', verdict: 'REWORK', auditorSessionName: reboundAuditorIdentity.sessionName,
        auditorIdentity: reboundAuditorIdentity, findings: 'correction before finish', validations: [], now: 131,
      })).toMatchObject({ ok: true, replay: true, value: { sequence: 5 } });

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
      expect(registry.listAuditReceipts(taskId)).toHaveLength(5);
      registry.close();

      registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.listAuditReceipts(taskId).map((receipt) => receipt.sequence)).toEqual([1, 2, 3, 4, 5]);
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

  it('repairs an accepted final receipt crash window on reopen without losing manual fallback history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-final-receipt-reconcile-'));
    const dbPath = join(dir, 'supervision-state.sqlite');
    const taskId = 'accepted-final-receipt-reconcile';
    const revision = 'accepted-final-receipt-r1';
    const attemptId = 'accepted-final-receipt-attempt';
    const implementerIdentity = identity('deck_receipt_worker');
    const coordinatorIdentity = identity('deck_receipt_brain');
    const auditorIdentity = identity('deck_receipt_auditor');
    try {
      let registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.createOrGet({
        taskId, projectName: 'alpha', classification: 'integration_task',
        objective: 'recover exact accepted final receipt', currentRevision: revision,
      })).toMatchObject({ ok: true });
      const implementer = registry.createAssignment({
        taskId, role: 'implementer', identity: implementerIdentity, auditRevision: revision,
      });
      const coordinator = registry.createAssignment({
        taskId, role: 'coordinator', identity: coordinatorIdentity, auditRevision: revision,
      });
      const auditor = registry.createAssignment({
        taskId, role: 'auditor', identity: auditorIdentity,
        auditAttemptId: attemptId, auditRevision: revision,
      });
      if (!implementer.ok || !coordinator.ok || !auditor.ok) throw new Error('expected assignments');
      for (const status of ['implementing', 'validated'] as const) {
        expect(registry.updateAssignment({
          assignmentId: implementer.value.assignmentId, identity: implementerIdentity, status,
        })).toMatchObject({ ok: true });
      }
      for (const status of ['implementing', 'validated', 'ready_for_audit'] as const) {
        expect(registry.updateAssignment({
          assignmentId: coordinator.value.assignmentId, identity: coordinatorIdentity, status,
        })).toMatchObject({ ok: true });
      }
      for (const status of ['implementing', 'validated', 'ready_for_audit'] as const) {
        expect(registry.updateTask({ taskId, status })).toMatchObject({ ok: true });
      }
      expect(registry.appendMatchingAuditReceipt({
        taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId, revision,
        receiptKind: 'final', verdict: 'PASS', auditorSessionName: auditorIdentity.sessionName,
        auditorIdentity, findings: 'exact PASS persisted before crash',
        validations: [{ kind: 'test', label: 'focused', outcome: 'passed', summary: 'passed' }],
        now: 100,
      })).toMatchObject({ ok: true, value: { verdict: 'PASS' } });
      expect(registry.getAssignment(auditor.value.assignmentId)).toMatchObject({ status: 'auditing' });
      expect(registry.getAssignment(implementer.value.assignmentId)).toMatchObject({ status: 'validated' });
      registry.close();

      registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.listAuditReceipts(taskId)).toEqual([
        expect.objectContaining({ attemptId, revision, receiptKind: 'final', verdict: 'PASS' }),
      ]);
      expect(registry.getAssignment(auditor.value.assignmentId)).toMatchObject({
        status: 'finalized', leaseId: '', verdict: 'PASS',
      });
      expect(registry.getAssignment(implementer.value.assignmentId)).toMatchObject({
        status: 'ready_for_integration', leaseId: '', auditAttemptId: attemptId,
        auditRevision: revision, verdict: 'PASS', crossVendorAuditPassed: true,
      });
      expect(registry.getAssignment(coordinator.value.assignmentId)).toMatchObject({ status: 'ready_for_audit' });
      expect(registry.get(taskId)).toMatchObject({ status: 'ready_for_integration' });
      expect(registry.finishAssignment({
        assignmentId: auditor.value.assignmentId, identity: auditorIdentity, revision,
      })).toMatchObject({ ok: true, replay: true });
      registry.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps an ambiguous accepted receipt recoverable instead of blocking registry startup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-final-receipt-fallback-'));
    const dbPath = join(dir, 'supervision-state.sqlite');
    const taskId = 'accepted-final-receipt-fallback';
    const revision = 'accepted-final-receipt-fallback-r1';
    const attemptId = 'accepted-final-receipt-fallback-attempt';
    const primaryIdentity = identity('deck_receipt_primary');
    const staleIdentity = identity('deck_receipt_stale');
    const auditorIdentity = identity('deck_receipt_fallback_auditor');
    try {
      let registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.createOrGet({
        taskId, projectName: 'alpha', classification: 'integration_task',
        objective: 'preserve same-object fallback after ambiguous receipt', currentRevision: revision,
      })).toMatchObject({ ok: true });
      const primary = registry.createAssignment({
        taskId, role: 'implementer', identity: primaryIdentity, auditRevision: revision,
      });
      const stale = registry.createAssignment({
        taskId, role: 'implementer', identity: staleIdentity, auditRevision: revision,
      });
      const auditor = registry.createAssignment({
        taskId, role: 'auditor', identity: auditorIdentity,
        auditAttemptId: attemptId, auditRevision: revision,
      });
      if (!primary.ok || !stale.ok || !auditor.ok) throw new Error('expected assignments');
      for (const worker of [primary.value, stale.value]) {
        for (const status of ['implementing', 'validated'] as const) {
          expect(registry.updateAssignment({
            assignmentId: worker.assignmentId, identity: worker.identity, status,
          })).toMatchObject({ ok: true });
        }
      }
      for (const status of ['implementing', 'validated', 'ready_for_audit'] as const) {
        expect(registry.updateTask({ taskId, status })).toMatchObject({ ok: true });
      }
      expect(registry.appendMatchingAuditReceipt({
        taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId, revision,
        receiptKind: 'final', verdict: 'PASS', auditorSessionName: auditorIdentity.sessionName,
        auditorIdentity, findings: 'exact PASS retained across fallback',
        validations: [{ kind: 'test', label: 'focused', outcome: 'passed', summary: 'passed' }],
        now: 100,
      })).toMatchObject({ ok: true });
      registry.close();

      // The bounded boot repair must fail closed on ambiguity without making
      // the registry unavailable or consuming the immutable receipt.
      registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.getAssignment(auditor.value.assignmentId)).toMatchObject({
        status: 'auditing', leaseId: expect.any(String), verdict: 'PASS',
      });
      expect(registry.listAuditReceipts(taskId)).toEqual([
        expect.objectContaining({ attemptId, revision, receiptKind: 'final', verdict: 'PASS' }),
      ]);
      expect(registry.applyTaskIntent({
        taskId, assignmentId: stale.value.assignmentId,
        intent: 'cancel', toStatus: 'cancelled', note: 'Brain resolved exact stale candidate',
      })).toMatchObject({ ok: true });
      expect(registry.finishAssignment({
        assignmentId: auditor.value.assignmentId, identity: auditorIdentity, revision,
      })).toMatchObject({ ok: true, value: { status: 'finalized', leaseId: '' } });
      expect(registry.getAssignment(primary.value.assignmentId)).toMatchObject({
        status: 'ready_for_integration', leaseId: '', auditAttemptId: attemptId,
        auditRevision: revision, verdict: 'PASS',
      });
      expect(registry.get(taskId)).toMatchObject({ status: 'ready_for_integration' });
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
            callerIdentity: identity(shape.taskId + '-brain'),
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
            callerIdentity: identity(shape.taskId + '-brain'),
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
    // The dispatching Brain is a real coordinator assignment on the task; that
    // binding -- not the project string -- is the finish authority.
    const brain = identity('deck_alpha_brain');
    try {
      let registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.createOrGet({
        taskId, projectName: 'alpha', classification: 'independent_top_level',
        objective: 'cleanup accepted audit', currentRevision: revision,
      })).toMatchObject({ ok: true });
      expect(registry.createAssignment({
        assignmentId: taskId + '-coordinator', taskId, role: 'coordinator',
        identity: brain, required: false,
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
        assignmentId: auditor.value.assignmentId, callerProjectName: 'beta',
        callerIdentity: brain, now: 105,
      })).toEqual({ ok: false, reason: 'owner_mismatch' });
      expect(registry.get(taskId)).toEqual(snapshotBeforeWrongProject);

      expect(registry.finishAssignmentAsProjectBrain({
        assignmentId: auditor.value.assignmentId, callerProjectName: 'alpha',
        callerIdentity: brain, now: 110,
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
        assignmentId: auditor.value.assignmentId, callerProjectName: 'alpha',
        callerIdentity: brain, now: 120,
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
    const rebindBrain = identity('deck_alpha_brain');
    expect(registry.createAssignment({
      assignmentId: taskId + '-coordinator', taskId, role: 'coordinator',
      identity: rebindBrain, required: false,
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
      callerIdentity: rebindBrain,
      callerProjectName: 'alpha',
      rebindProjectName: 'alpha',
      rebindIdentity: identity('deck_different_user_worker'),
    })).toEqual({ ok: false, reason: 'owner_mismatch' });
    expect(registry.get(taskId)).toEqual(beforeWrongUser);
    expect(registry.finishAssignmentAsProjectBrain({
      assignmentId: assignment.value.assignmentId,
      callerIdentity: rebindBrain,
      callerProjectName: 'beta',
      rebindProjectName: 'beta',
      rebindIdentity: live,
    })).toEqual({ ok: false, reason: 'owner_mismatch' });
    expect(registry.get(taskId)).toEqual(beforeWrongUser);

    expect(registry.finishAssignmentAsProjectBrain({
      assignmentId: assignment.value.assignmentId,
      callerIdentity: rebindBrain,
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
      callerIdentity: rebindBrain,
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
    // Same Brain coordinates this task too, so the refusal below is proven to
    // come from the accepted receipt, not from missing coordinator authority.
    expect(registry.createAssignment({
      assignmentId: auditedTaskId + '-coordinator', taskId: auditedTaskId,
      role: 'coordinator', identity: rebindBrain, required: false,
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
      assignmentId: auditedWorker.value.assignmentId, callerIdentity: rebindBrain,
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
      // The heartbeat must leave a DURABLE liveness beat, not just an event
      // row. The console projects `heartbeatAt` from this column, so if the
      // heartbeat never writes it the UI can only fall back to lease presence
      // -- which stays true for an abandoned assignment forever.
      expect(registry.getAssignment(assignment.value.assignmentId)?.heartbeatAt).toBe(10_000);
      // ...and it still must NOT move the substantive progress clock.
      expect(registry.getAssignment(assignment.value.assignmentId)?.updatedAt).toBe(progressClock);
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
      // Survives a reopen: liveness is durable, not in-memory.
      expect(registry.getAssignment(assignment.value.assignmentId)?.heartbeatAt).toBe(10_000);
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
    return { revision, attemptId, sessionName, replacementIdentity, oldOwner, replacement, auditor };
  }

  it('cancels only a superseded integration owner and preserves the replacement PASS aggregate', async () => {
    const registry = makeRegistry();
    const shape = createReplacementOwnerPassShape(registry, 'task-replacement-owner-cancel');
    // RETIRED (R2 ruling): this fixture previously resolved the caller to
    // identity(sessionName) and passed only because the superseded owner shared
    // that sessionName -- cross-instance authority by name equality, which is
    // now formally retired. The caller is the task's COORDINATOR, created with
    // the replacement identity, so it is resolved exactly; authority now comes
    // from being that coordinator, not from sharing a name with the old owner.
    const handlers = createSupervisionMcpToolHandlers(
      { sessionName: shape.sessionName, projectName: 'alpha' } as never,
      {
        resolveSessionIdentity: () => ({ ...shape.replacementIdentity, projectName: 'alpha' }),
        registry: supervisionRegistryPort(registry),
      },
    );

    // Runtime incarnation metadata is observational. The same project/session
    // owns the same assignment after restart and may cancel it once.
    expect(await handlers[SUPERVISION_MCP_TOOLS.INTENT]({
      intent: 'cancel', taskId: 'task-replacement-owner-cancel',
      assignmentId: shape.oldOwner.value.assignmentId, note: 'superseded runtime epoch',
    })).toMatchObject({ status: 'ok', toStatus: 'cancelled' });

    // Superseded-owner cleanup now travels the EXPLICIT authorized path on the
    // same assignment, which carries its own reason/idempotency and leaves the
    // replacement's PASS aggregate untouched.
    expect(registry.coordinateTaskAssignment({
      taskId: 'task-replacement-owner-cancel',
      assignmentId: shape.oldOwner.value.assignmentId,
      assignmentStatus: 'cancelled',
      leaseAction: 'clear',
      idempotencyKey: 'retire-superseded-owner',
      reason: 'superseded runtime epoch',
    })).toMatchObject({ ok: true });
    // Idempotent: the same explicit operation replays without further effect.
    expect(registry.coordinateTaskAssignment({
      taskId: 'task-replacement-owner-cancel',
      assignmentId: shape.oldOwner.value.assignmentId,
      assignmentStatus: 'cancelled',
      leaseAction: 'clear',
      idempotencyKey: 'retire-superseded-owner',
      reason: 'superseded runtime epoch',
    })).toMatchObject({ ok: true });

    // RETIRED (R2 ruling), second half. The original block also asserted
    //   status: 'ready_for_integration' and
    //   integrationOwnerAssignmentId: <replacement>
    // Those were EFFECTS of the retired cross-instance intent cancel, which
    // recomputed the task aggregate as a side effect. The explicit authorized
    // path acts on the named assignment only, so task-level promotion is no
    // longer implied by cancelling a superseded owner; it must be requested in
    // its own right. What remains asserted is the part that is still true and
    // still load-bearing: exactly the superseded owner is cancelled and its
    // lease released, while the replacement's PASS aggregate and the auditor's
    // immutable finalized receipt are untouched.
    expect(registry.get('task-replacement-owner-cancel')).toMatchObject({
      currentRevision: shape.revision,
      assignments: expect.arrayContaining([
        expect.objectContaining({
          assignmentId: shape.oldOwner.value.assignmentId, status: 'cancelled', leaseId: '',
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
        { resolveSessionIdentity: testIdentityResolver, registry: supervisionRegistryPort(registry), isProjectBrain: () => true },
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
        integrationOwnerAssignmentId: shape.oldOwner.value.assignmentId,
        assignments: expect.arrayContaining([
          expect.objectContaining({
            assignmentId: shape.oldOwner.value.assignmentId, status: 'ready_for_integration',
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
            replacementIntegrationOwnerAssignmentId: shape.oldOwner.value.assignmentId,
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

  it('refuses a successor bind rather than silently cancelling authority', () => {
    // Each case must FAIL the bind, not quietly retire the auditor. A passed
    // audit is authority; a mismatched auditRevision means the predecessor was
    // never what this owner thinks it was; a Git-finalized task is closed.
    const setup = (name: string) => {
      const database = new DatabaseSync(':memory:');
      const registry = new SupervisionTaskRegistry({ database });
      const taskId = `task-refuse-${name}`;
      const implId = `${taskId}-implementer`;
      const auditorId = `${taskId}-auditor`;
      const owner = identity(`deck_owner_${name}`);
      expect(registry.createOrGet({
        taskId, projectName: 'alpha', classification: 'independent_top_level',
        objective: 'refuse unsafe successor binds',
      })).toMatchObject({ ok: true });
      const impl = registry.createAssignment({
        assignmentId: implId, taskId, role: 'implementer', identity: owner, auditRevision: 'r1',
      });
      if (!impl.ok) throw new Error(impl.reason);
      const aud = registry.createAssignment({
        assignmentId: auditorId, taskId, role: 'auditor', identity: identity(`deck_auditor_${name}`),
        auditAttemptId: 'attempt-r1', auditRevision: 'r1',
      });
      if (!aud.ok) throw new Error(aud.reason);
      expect(registry.updateTask({ taskId, status: 'delegated' })).toMatchObject({ ok: true });
      expect(registry.updateTask({ taskId, status: 'implementing' })).toMatchObject({ ok: true });
      rewritePersistedAssignment(database, {
        ...registry.getAssignment(implId)!, status: 'rework', updatedAt: 100,
      });
      return { database, registry, taskId, implId, auditorId, owner };
    };

    // (1) auditor already carries an accepted PASS -> receipt_closed
    {
      const ctx = setup('pass');
      rewritePersistedAssignment(ctx.database, {
        ...ctx.registry.getAssignment(ctx.auditorId)!, verdict: 'PASS', updatedAt: 101,
      });
      const before = ctx.registry.getAssignment(ctx.auditorId);
      const result = ctx.registry.updateAssignment({
        assignmentId: ctx.implId, identity: ctx.owner, revision: 'r2', auditRevision: 'r2',
      });
      expect(result).toMatchObject({ ok: false, reason: 'receipt_closed' });
      expect(ctx.registry.getAssignment(ctx.auditorId)).toEqual(before);
      ctx.registry.close(); ctx.database.close();
    }

    // (2) auditor bound to a different revision than the one being superseded
    {
      const ctx = setup('mismatch');
      rewritePersistedAssignment(ctx.database, {
        ...ctx.registry.getAssignment(ctx.auditorId)!, auditRevision: 'r0-other', updatedAt: 101,
      });
      const before = ctx.registry.getAssignment(ctx.auditorId);
      const result = ctx.registry.updateAssignment({
        assignmentId: ctx.implId, identity: ctx.owner, revision: 'r2', auditRevision: 'r2',
      });
      expect(result).toMatchObject({ ok: false, reason: 'stale_audit_revision' });
      expect(result).toMatchObject({
        detail: { expectedRevision: 'r1', actualRevision: 'r0-other' },
      });
      expect(ctx.registry.getAssignment(ctx.auditorId)).toEqual(before);
      ctx.registry.close(); ctx.database.close();
    }

    // (3) Git-finalized task is closed to successor binds
    {
      const ctx = setup('finalized');
      const before = ctx.registry.getAssignment(ctx.auditorId);
      const task = ctx.registry.getTaskRecord(ctx.taskId)!;
      rewritePersistedTask(ctx.database, { ...task, commitSha: 'a'.repeat(40), updatedAt: 101 });
      const result = ctx.registry.updateAssignment({
        assignmentId: ctx.implId, identity: ctx.owner, revision: 'r2', auditRevision: 'r2',
      });
      expect(result).toMatchObject({ ok: false, reason: 'invalid_transition' });
      expect(ctx.registry.getAssignment(ctx.auditorId)).toEqual(before);
      ctx.registry.close(); ctx.database.close();
    }
  });

  it('supersedes the active predecessor auditor atomically when a successor revision binds', () => {
    // DEADLOCK B, security half. tsk_4dd had an ACTIVE R1 auditor while an R2
    // successor needed to bind. Two things must hold, and today neither is
    // reachable because the successor bind itself is refused:
    //   1. the R1 auditor must lose current authority the moment R2 binds, so
    //      an R1-era receipt can never be counted toward R2;
    //   2. a fresh R2 auditor must be able to materialize -- today an active
    //      auditor makes createAssignment return duplicate_assignment, so the
    //      task deadlocks with no auditor able to act.
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const taskId = 'task-supersede-auditor';
    const implId = `${taskId}-implementer`;
    const r1Auditor = `${taskId}-auditor-r1`;
    const r1 = 'combined-cc8-r1-11111111';
    const r2 = 'combined-cc8-r2-22222222';
    const owner = identity('deck_owner_worker');
    const auditor1 = identity('deck_auditor_one');
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'independent_top_level',
      objective: 'supersede an active auditor when the successor binds',
    })).toMatchObject({ ok: true });
    const impl = registry.createAssignment({
      assignmentId: implId, taskId, role: 'implementer', identity: owner, auditRevision: r1,
    });
    if (!impl.ok) throw new Error(impl.reason);
    const aud = registry.createAssignment({
      assignmentId: r1Auditor, taskId, role: 'auditor', identity: auditor1,
      auditAttemptId: 'attempt-r1', auditRevision: r1,
    });
    if (!aud.ok) throw new Error(aud.reason);
    expect(registry.updateTask({ taskId, status: 'delegated' })).toMatchObject({ ok: true });
    expect(registry.updateTask({ taskId, status: 'implementing' })).toMatchObject({ ok: true });
    rewritePersistedAssignment(database, {
      ...registry.getAssignment(implId)!, status: 'rework', updatedAt: 100,
    });

    // The owner binds the R2 successor.
    expect(registry.updateAssignment({
      assignmentId: implId, identity: owner, revision: r2, auditRevision: r2,
    })).toMatchObject({ ok: true });

    // 1. The R1 auditor must no longer hold current authority.
    const superseded = registry.getAssignment(r1Auditor)!;
    expect(['cancelled', 'rework', 'finalized']).toContain(superseded.status);
    expect(superseded.auditRevision).toBe(r1);

    // 2. A fresh R2 auditor must be able to materialize.
    expect(registry.createAssignment({
      assignmentId: `${taskId}-auditor-r2`, taskId, role: 'auditor',
      identity: identity('deck_auditor_two'),
      auditAttemptId: 'attempt-r2', auditRevision: r2,
    })).toMatchObject({ ok: true });

    registry.close();
    database.close();
  });

  it('lets an implementation owner bind a strictly-new hash-anchored successor revision', () => {
    // DEADLOCK B, reproduced from production. An owner in implementing/rework
    // that already carries an auditRevision from a previous round cannot bind
    // ANY successor: every strictly-new, hash-anchored revision name is
    // rejected as old_revision. The name is also wrong -- the revision is not
    // old, it is different -- and the rejection carries no comparison fields,
    // so the caller cannot see what was compared against what.
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const taskId = 'task-successor-binding';
    const assignmentId = `${taskId}-implementer`;
    const predecessor = 'feature-cc8-r1-aaaaaaaa';
    const successor = 'feature-cc8-r2-bbbbbbbb';
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'independent_top_level',
      objective: 'bind a successor revision after a prior audit round',
    })).toMatchObject({ ok: true });
    const owner = identity('deck_owner_worker');
    const created = registry.createAssignment({
      assignmentId, taskId, role: 'implementer', identity: owner,
      auditRevision: predecessor,
    });
    if (!created.ok) throw new Error(created.reason);
    expect(registry.updateTask({ taskId, status: 'delegated' })).toMatchObject({ ok: true });
    expect(registry.updateTask({ taskId, status: 'implementing' })).toMatchObject({ ok: true });
    rewritePersistedAssignment(database, {
      ...registry.getAssignment(assignmentId)!, status: 'implementing', updatedAt: 100,
    });

    // The owner binds its next frozen candidate. This must be accepted.
    expect(registry.updateAssignment({
      assignmentId,
      identity: owner,
      revision: successor,
      auditRevision: successor,
    })).toMatchObject({ ok: true });
    expect(registry.getAssignment(assignmentId)).toMatchObject({ auditRevision: successor });

    registry.close();
    database.close();
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
      ownedFilesSemantics: 'observed_delivery_evidence_not_acl',
      implementationAdmission: 'isolated_worktree',
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
    expect(registry.recordFileEvent({ assignmentId: impl.value.assignmentId, identity: { ...implementer, runtimeEpoch: 'old' }, path: 'src/ok.ts', operation: 'modify' })).toMatchObject({ ok: true });
    const first = registry.recordFileEvent({ assignmentId: impl.value.assignmentId, identity: implementer, path: 'src/ok.ts', operation: 'modify', beforeHash: 'a', afterHash: 'b', tool: 'apply_patch', idempotencyKey: 'edit-1' });
    const replay = registry.recordFileEvent({ assignmentId: impl.value.assignmentId, identity: implementer, path: 'src/ok.ts', operation: 'modify', beforeHash: 'a', afterHash: 'b', tool: 'apply_patch', idempotencyKey: 'edit-1' });
    expect(first.ok).toBe(true);
    expect(replay).toMatchObject({ ok: true, replay: true });
    expect(registry.listFileEvents('task-files')).toHaveLength(2);
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

  it('checkpoint reprojects a retained ready-for-audit integration owner after a stale implementer is cancelled', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const taskId = 'aggregate-ready-for-audit-after-stale-cancel';
    const revision = 'aggregate-ready-for-audit-r1';
    const ownerIdentity = identity('deck_alpha_brain');
    const staleIdentity = identity('deck_alpha_stale_worker');
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'integration_task',
      objective: 'retain the exact integration round', currentRevision: revision,
    })).toMatchObject({ ok: true });
    const owner = registry.createAssignment({
      assignmentId: `${taskId}-owner`, taskId, role: 'integration_owner', identity: ownerIdentity,
      required: true, scopeFiles: ['src/integration.ts'], auditRevision: revision,
    });
    const stale = registry.createAssignment({
      assignmentId: `${taskId}-stale`, taskId, role: 'implementer', identity: staleIdentity,
      required: true, scopeFiles: [], auditRevision: revision,
    });
    if (!owner.ok || !stale.ok) throw new Error('assignments should create');
    for (const status of ['implementing', 'validated', 'ready_for_audit'] as const) {
      expect(registry.updateAssignment({
        assignmentId: owner.value.assignmentId, identity: ownerIdentity, status,
        revision, auditRevision: revision,
      })).toMatchObject({ ok: true });
    }
    expect(registry.updateAssignment({
      assignmentId: stale.value.assignmentId, identity: staleIdentity, status: 'implementing',
    })).toMatchObject({ ok: true });
    expect(registry.updateTask({ taskId, status: 'implementing', currentRevision: revision }))
      .toMatchObject({ ok: true });
    expect(registry.updateAssignment({
      assignmentId: stale.value.assignmentId, identity: staleIdentity, status: 'cancelled',
      blocker: 'superseded empty assignment',
    })).toMatchObject({ ok: true });

    const beforeOwner = registry.getAssignment(owner.value.assignmentId)!;
    const beforeStale = registry.getAssignment(stale.value.assignmentId)!;
    // Cancellation normally projects immediately. Recreate the persisted stale
    // aggregate observed in production so checkpoint must repair it on reread.
    rewritePersistedTask(database, { ...registry.get(taskId)!, status: 'implementing' });
    expect(registry.get(taskId)).toMatchObject({ status: 'implementing', currentRevision: revision });
    expect(registry.applyTaskIntent({
      taskId, assignmentId: owner.value.assignmentId, intent: 'checkpoint', toStatus: null,
      note: 'reproject retained integration round',
    })).toMatchObject({ ok: true, value: { status: 'ready_for_audit', currentRevision: revision } });

    expect(registry.get(taskId)).toMatchObject({ status: 'ready_for_audit', currentRevision: revision });
    expect(registry.getAssignment(owner.value.assignmentId)).toMatchObject({
      status: 'ready_for_audit', leaseId: beforeOwner.leaseId, auditRevision: revision,
      scopeFiles: beforeOwner.scopeFiles,
    });
    expect(registry.getAssignment(stale.value.assignmentId)).toEqual(beforeStale);
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

  it('atomically invalidates live validation when the observed delivery set changes', () => {
    const registry = makeRegistry();
    const taskId = 'observed-set-invalidates-pass';
    const owner = identity('deck_observed_worker');
    const fromRevision = 'observed-r1';
    const toRevision = 'observed-r2';
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'independent_top_level',
      objective: 'invalidate stale audit', currentRevision: fromRevision,
    })).toMatchObject({ ok: true });
    const assignment = registry.createAssignment({
      taskId, role: 'implementer', identity: owner, scopeFiles: ['src/initial.ts', 'src/removed.ts'],
      auditAttemptId: 'observed-r1-audit', auditRevision: fromRevision,
    });
    if (!assignment.ok) throw new Error(assignment.reason);
    for (const path of ['src/initial.ts', 'src/removed.ts']) {
      expect(registry.recordFileEvent({
        assignmentId: assignment.value.assignmentId, identity: owner,
        path, operation: 'modify', beforeHash: `before-${path}`, afterHash: `after-${path}`,
      })).toMatchObject({ ok: true });
    }
    for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing', 'passed'] as const) {
      expect(registry.updateAssignment({
        assignmentId: assignment.value.assignmentId, identity: owner, status,
        revision: fromRevision, auditAttemptId: 'observed-r1-audit', auditRevision: fromRevision,
        ...(status === 'passed' ? { verdict: 'PASS', crossVendorAuditPassed: true } : {}),
      }), status).toMatchObject({ ok: true });
    }
    const before = registry.get(taskId);
    expect(registry.reconcileScope({
      taskId, assignmentId: assignment.value.assignmentId,
      trackedPaths: ['src/initial.ts'], currentRevision: fromRevision,
    })).toEqual({ ok: false, reason: 'old_revision' });
    expect(registry.get(taskId)).toEqual(before);

    expect(registry.reconcileScope({
      taskId, assignmentId: assignment.value.assignmentId,
      trackedPaths: ['src/initial.ts'], currentRevision: toRevision,
    })).toMatchObject({
      ok: true,
      value: {
        status: 'implementing', currentRevision: toRevision,
        assignments: [expect.objectContaining({
          assignmentId: assignment.value.assignmentId,
          status: 'implementing', auditRevision: toRevision,
          scopeFiles: ['src/initial.ts'],
        })],
      },
    });
    expect(registry.getAssignment(assignment.value.assignmentId)).not.toHaveProperty('auditAttemptId');
    expect(registry.getAssignment(assignment.value.assignmentId)).not.toHaveProperty('verdict');
    expect(registry.listEvents(taskId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        assignmentId: assignment.value.assignmentId,
        eventType: 'recovered',
        payload: expect.objectContaining({ auditInvalidated: true, observedFiles: ['src/initial.ts'] }),
      }),
    ]));
    registry.close();
  });

  it('invalidates a stale PASS through the authenticated file-event production handler', async () => {
    const registry = getSupervisionTaskRegistry();
    const taskId = 'production-file-event-invalidates-pass';
    const owner = identity('deck_alpha_w1');
    const revision = 'production-file-event-r1';
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'independent_top_level',
      objective: 'invalidate stale PASS from the public file-event path', currentRevision: revision,
    })).toMatchObject({ ok: true });
    const assignment = registry.createAssignment({
      taskId, role: 'implementer', identity: owner, scopeFiles: ['src/initial.ts'],
      auditAttemptId: 'production-file-event-audit-r1', auditRevision: revision,
    });
    if (!assignment.ok) throw new Error(assignment.reason);
    for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing', 'passed'] as const) {
      expect(registry.updateTask({ taskId, status, currentRevision: revision }), status).toMatchObject({ ok: true });
      expect(registry.updateAssignment({
        assignmentId: assignment.value.assignmentId, identity: owner, status,
        auditAttemptId: 'production-file-event-audit-r1', auditRevision: revision,
        ...(status === 'passed' ? { verdict: 'PASS', crossVendorAuditPassed: true } : {}),
      }), status).toMatchObject({ ok: true });
    }

    const handlers = createMemoryMcpToolHandlers(
      { userId: 'u', sessionName: owner.sessionName, projectName: 'alpha', projectRoot: '/work/alpha' },
      { sendDeps: { listSessions: () => [session(owner.sessionName)] } },
    );
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FILE_EVENT]({
      assignmentId: assignment.value.assignmentId,
      filePath: 'src/discovered.ts', operation: 'create', afterHash: 'discovered-hash',
      idempotencyKey: 'discovered-create',
    })).resolves.toMatchObject({
      status: 'ok',
      item: {
        status: 'implementing',
        scopeFiles: ['src/discovered.ts', 'src/initial.ts'],
      },
    });
    expect(registry.get(taskId)).toMatchObject({
      status: 'implementing', currentRevision: revision,
      assignments: [expect.objectContaining({
        assignmentId: assignment.value.assignmentId,
        status: 'implementing',
        scopeFiles: ['src/discovered.ts', 'src/initial.ts'],
      })],
    });
    const invalidated = registry.getAssignment(assignment.value.assignmentId);
    expect(invalidated).not.toHaveProperty('auditAttemptId');
    expect(invalidated).not.toHaveProperty('auditRevision');
    expect(invalidated).not.toHaveProperty('verdict');
    expect(invalidated).not.toHaveProperty('crossVendorAuditPassed');
    expect(registry.listFileEvents(taskId)).toHaveLength(1);

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FILE_EVENT]({
      assignmentId: assignment.value.assignmentId,
      filePath: 'src/discovered.ts', operation: 'create', afterHash: 'discovered-hash',
      idempotencyKey: 'discovered-create',
    })).resolves.toMatchObject({ status: 'ok', item: { status: 'implementing' } });
    expect(registry.listFileEvents(taskId)).toHaveLength(1);
  });

  it.each([
    ['ready_for_integration', ['implementing', 'validated', 'ready_for_audit', 'auditing', 'passed', 'ready_for_integration']],
    ['committed', ['implementing', 'validated', 'ready_for_audit', 'auditing', 'passed', 'ready_for_integration', 'integrating', 'final_audit', 'passed', 'finalizing', 'committed']],
    ['pushed', ['implementing', 'validated', 'ready_for_audit', 'auditing', 'passed', 'ready_for_integration', 'integrating', 'final_audit', 'passed', 'finalizing', 'committed', 'pushed']],
    ['finalized', ['implementing', 'validated', 'ready_for_audit', 'auditing', 'passed', 'ready_for_integration', 'integrating', 'final_audit', 'passed', 'finalizing', 'committed', 'pushed', 'finalized']],
    ['cancelled', ['implementing', 'cancelled']],
  ] as const)('does not reopen %s delivery evidence from file events or reconciliation', (closedStatus, statuses) => {
    const registry = makeRegistry();
    const taskId = `closed-scope-${closedStatus}`;
    const owner = identity(`deck_${closedStatus}_worker`);
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'independent_top_level',
      objective: 'keep closed delivery evidence immutable', currentRevision: 'closed-r1',
    })).toMatchObject({ ok: true });
    const assignment = registry.createAssignment({
      taskId, role: 'implementer', identity: owner, scopeFiles: ['src/closed.ts'],
      auditAttemptId: 'closed-audit-r1', auditRevision: 'closed-r1',
    });
    if (!assignment.ok) throw new Error(assignment.reason);
    for (const status of statuses) {
      expect(registry.updateAssignment({
        assignmentId: assignment.value.assignmentId, identity: owner, status,
        auditAttemptId: 'closed-audit-r1', auditRevision: 'closed-r1',
        ...(status === 'passed' || status === 'ready_for_integration'
          ? { verdict: 'PASS', crossVendorAuditPassed: true }
          : {}),
      }), `${closedStatus}:${status}`).toMatchObject({ ok: true });
    }
    const beforeTask = registry.getTaskRecord(taskId);
    const beforeAssignment = registry.getAssignment(assignment.value.assignmentId);
    const eventCount = registry.listFileEvents(taskId).length;
    expect(beforeAssignment?.status).toBe(closedStatus);

    expect(registry.recordFileEvent({
      assignmentId: assignment.value.assignmentId, identity: owner,
      path: 'src/brand-new.ts', operation: 'create', afterHash: 'new',
    })).toMatchObject({ ok: true });
    expect(registry.getTaskRecord(taskId)).toEqual(beforeTask);
    expect(registry.getAssignment(assignment.value.assignmentId)).toEqual(beforeAssignment);
    expect(registry.listFileEvents(taskId)).toHaveLength(eventCount + 1);

    expect(registry.reconcileScope({
      taskId, assignmentId: assignment.value.assignmentId,
      trackedPaths: ['src/brand-new.ts', 'src/closed.ts'], currentRevision: 'closed-r2',
    })).toEqual({ ok: false, reason: 'invalid_transition' });
    expect(registry.getTaskRecord(taskId)).toEqual(beforeTask);
    expect(registry.getAssignment(assignment.value.assignmentId)).toEqual(beforeAssignment);
    expect(registry.listFileEvents(taskId)).toHaveLength(eventCount + 1);
    registry.close();
  });

  it('keeps structured finalization immutable through the authenticated file-event handler', async () => {
    const registry = getSupervisionTaskRegistry();
    const shape = prepareStructuredFinalizationShape(registry, 'closed-production-file-event');
    expect(registry.finalizeIntegration({ ...shape.finalization, identity: shape.owner.identity }))
      .toMatchObject({ ok: true, value: { status: 'finalized', archivedAt: expect.any(Number) } });
    const beforeTask = registry.getTaskRecord(shape.taskId);
    const beforeAssignment = registry.getAssignment(shape.owner.assignmentId);
    const eventCount = registry.listFileEvents(shape.taskId).length;
    const handlers = createMemoryMcpToolHandlers(
      {
        userId: 'u', sessionName: shape.owner.identity.sessionName,
        projectName: 'alpha', projectRoot: '/work/alpha',
      },
      { sendDeps: { listSessions: () => [session(shape.owner.identity.sessionName)] } },
    );

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FILE_EVENT]({
      assignmentId: shape.owner.assignmentId,
      filePath: 'src/post-finalization.ts', operation: 'create', afterHash: 'post-finalization',
    })).resolves.toMatchObject({ status: 'ok', item: { status: 'finalized' } });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FILE_EVENT]({
      assignmentId: shape.owner.assignmentId,
      filePath: shape.files[0], operation: 'modify', beforeHash: 'before', afterHash: 'after',
    })).resolves.toMatchObject({ status: 'ok', item: { status: 'finalized' } });
    expect(registry.getTaskRecord(shape.taskId)).toEqual(beforeTask);
    expect(registry.getAssignment(shape.owner.assignmentId)).toEqual(beforeAssignment);
    expect(registry.listFileEvents(shape.taskId)).toHaveLength(eventCount + 2);
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

  it('keeps an explicit durable project+session binding across agent/provider/epoch rotation', async () => {
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
    const ensure = vi.fn(async () => ({
      ok: true as const, worktreePath: '/worktrees/stable-owner/repo', baseRevision: 'a'.repeat(40), created: true,
    }));
    const dispatchMessage = vi.fn();

    const result = await dispatchHookSend({
      from: brain.name,
      targetRecords: [target],
      message: 'same durable owner after restart',
      projectRoot: '/work/alpha',
      supervision: { taskId, assignmentId },
    }, {
      listSessions: () => sessions,
      getSession: (name) => sessions.find((item) => item.name === name),
      ensureSupervisionAssignmentWorktree: ensure,
      dispatchMessage,
    });

    expect(result.errors).toEqual([]);
    expect(result.delivered).toEqual([target.name]);
    expect(ensure).toHaveBeenCalledOnce();
    expect(dispatchMessage).toHaveBeenCalledOnce();
    expect(registry.getAssignment(assignmentId)?.identity).toMatchObject({
      sessionName: target.name,
      sessionInstanceId: target.sessionInstanceId,
      runtimeEpoch: target.runtimeEpoch,
      agentType: target.agentType,
      providerFamily: 'openai',
    });
  });

  it('keeps legacy fallback on the same project+session when provider metadata rotates', async () => {
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
    const ensure = vi.fn(async () => ({
      ok: true as const, worktreePath: '/worktrees/stable-provider/repo', baseRevision: 'b'.repeat(40), created: true,
    }));
    const dispatchMessage = vi.fn();

    const result = await dispatchHookSend({
      from: brain.name,
      targetRecords: [target],
      message: 'same durable owner after provider migration',
      projectRoot: '/work/alpha',
    }, {
      listSessions: () => sessions,
      getSession: (name) => sessions.find((item) => item.name === name),
      ensureSupervisionAssignmentWorktree: ensure,
      dispatchMessage,
    });

    expect(result.errors).toEqual([]);
    expect(result.delivered).toEqual([target.name]);
    expect(ensure).toHaveBeenCalledOnce();
    expect(dispatchMessage).toHaveBeenCalledOnce();
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
    const ensureSupervisionAssignmentWorktree = vi.fn(async (input: { assignmentId: string }) => ({
      ok: true as const,
      worktreePath: `/worktrees/${input.assignmentId}/repo`,
      baseRevision: 'e'.repeat(40),
      created: true,
    }));

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
        ensureSupervisionAssignmentWorktree,
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
    expect(ensureSupervisionAssignmentWorktree).toHaveBeenCalledTimes(1);
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
      { sessionName: implementerIdentity.sessionName, projectName: 'alpha' } as never,
      { resolveSessionIdentity: testIdentityResolver, registry: supervisionRegistryPort(registry) },
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
    })).toMatchObject({ status: 'ok', fromStatus: 'implementing', toStatus: 'ready_for_audit' });
    expect(registry.get('matching-pass-close')).toMatchObject({
      status: 'ready_for_audit',
      assignments: expect.arrayContaining([expect.objectContaining({ assignmentId: implementer.value.assignmentId, status: 'ready_for_audit' })]),
    });
      // record_validation must leave a DURABLE validation_state, not only an
      // event payload. The console projects validationState from that column,
      // so an unwritten column makes every row read 'unknown' forever.
      expect(registry.getAssignment(implementer.value.assignmentId)?.validationState).toBe('passed');
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
      status: 'ready_for_audit', leaseId: '',
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
      { sessionName: auditorIdentity.sessionName, projectName: 'alpha' } as never,
      { resolveSessionIdentity: testIdentityResolver, registry: supervisionRegistryPort(registry) },
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

  it('uses record_validation as the production wire for atomic finish and one immediate audit dispatch', async () => {
    const registry = getSupervisionTaskRegistry();
    const taskId = 'tsk_79u';
    const revision = 'tsk-79u-r1';
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'integration_task',
      objective: 'dispatch after validation', currentRevision: revision,
      auditPolicy: 'auto_strict_cross_vendor',
    })).toMatchObject({ ok: true });
    expect(registry.createAssignment({
      taskId, role: 'coordinator', identity: identity('deck_alpha_brain'), required: false,
    })).toMatchObject({ ok: true });
    const worker = registry.createAssignment({
      taskId, role: 'implementer', identity: identity('deck_alpha_w1'), required: true,
      auditRevision: revision, scopeFiles: ['src/validated.ts'],
    });
    if (!worker.ok) throw new Error(worker.reason);
    const dispatchReadyAudit = vi.fn().mockResolvedValue({ status: 'dispatched' });
    const handlers = createSupervisionMcpToolHandlers(
      { sessionName: 'deck_alpha_w1', projectName: 'alpha' } as never,
      {
        resolveSessionIdentity: testIdentityResolver,
        registry: supervisionRegistryPort(registry),
        dispatchReadyAudit,
      },
    );
    expect(await handlers[SUPERVISION_MCP_TOOLS.INTENT]({
      intent: 'start', taskId, assignmentId: worker.value.assignmentId,
    })).toMatchObject({ status: 'ok', toStatus: 'implementing' });
    expect(await handlers[SUPERVISION_MCP_TOOLS.INTENT]({
      intent: 'record_validation', validationState: 'passed',
      taskId, assignmentId: worker.value.assignmentId,
    })).toMatchObject({ status: 'ok', fromStatus: 'implementing', toStatus: 'ready_for_audit' });
    expect(registry.get(taskId)).toMatchObject({
      status: 'ready_for_audit', currentRevision: revision,
      assignments: expect.arrayContaining([expect.objectContaining({
        assignmentId: worker.value.assignmentId, status: 'ready_for_audit',
        auditRevision: revision, leaseId: '', validationState: 'passed',
      })]),
    });
    expect(dispatchReadyAudit).toHaveBeenCalledTimes(1);
    expect(dispatchReadyAudit).toHaveBeenCalledWith(taskId);
  });

  it.each([
    ['tsk_73i', 'asg_73l'],
    ['tsk_768', 'asg_76b'],
  ])('recovers the %s exact REWORK split through the public ingress on the same implementer', async (taskId, assignmentId) => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const revision = `${taskId}-r1`;
    const attemptId = `auto-audit-${taskId}-r1`;
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'integration_task',
      objective: 'resume exact rework', currentRevision: revision,
    })).toMatchObject({ ok: true });
    expect(registry.createAssignment({
      taskId, role: 'coordinator', identity: identity('deck_alpha_brain'), required: false,
    })).toMatchObject({ ok: true });
    const worker = registry.createAssignment({
      taskId, assignmentId, role: 'implementer', identity: identity('deck_alpha_w1'),
      required: true, auditAttemptId: attemptId, auditRevision: revision,
    });
    const auditor = registry.createAssignment({
      taskId, role: 'auditor', identity: identity('deck_alpha_w2', 'claude-code-sdk'),
      required: false, auditAttemptId: attemptId, auditRevision: revision,
    });
    if (!worker.ok || !auditor.ok) throw new Error('fixture assignment failed');
    for (const status of ['implementing', 'validated', 'ready_for_audit'] as const) {
      expect(registry.updateAssignment({
        assignmentId: worker.value.assignmentId, identity: worker.value.identity,
        status, auditAttemptId: attemptId, auditRevision: revision,
        ...(status === 'validated' ? { validationState: 'passed' } : {}),
      })).toMatchObject({ ok: true });
    }
    expect(registry.appendMatchingAuditReceipt({
      taskId, auditorAssignmentId: auditor.value.assignmentId,
      auditorIdentity: auditor.value.identity, auditorSessionName: auditor.value.identity.sessionName,
      attemptId, revision, receiptKind: 'final', verdict: 'REWORK',
      findings: 'repair exact production finding', validations: [], now: 40,
    })).toMatchObject({ ok: true });
    rewritePersistedAssignment(database, {
      ...registry.getAssignment(auditor.value.assignmentId)!,
      status: 'finalized', leaseId: '', verdict: 'REWORK', updatedAt: 45,
    });
    rewritePersistedTask(database, {
      ...registry.get(taskId)!, status: 'rework', currentRevision: revision, updatedAt: 50,
    });
    // Exact live RED: aggregate already rework, sole implementer still parked
    // ready_for_audit with no usable lease.
    rewritePersistedAssignment(database, {
      ...registry.getAssignment(worker.value.assignmentId)!,
      status: 'ready_for_audit', leaseId: '', verdict: undefined, updatedAt: 50,
    });
    const handlers = createSupervisionMcpToolHandlers(
      { sessionName: 'deck_alpha_brain', projectName: 'alpha' } as never,
      {
        resolveSessionIdentity: testIdentityResolver,
        registry: supervisionRegistryPort(registry),
        isProjectBrain: () => true,
      },
    );
    const request = {
      taskId, assignmentId: worker.value.assignmentId, toRevision: revision,
      leaseAction: 'renew', idempotencyKey: `${taskId}-exact-rework`,
      reason: 'consume the exact REWORK receipt on the same object',
      // Compatible redundant projection fields from older Brain clients must
      // not make the otherwise complete recovery request malformed.
      taskStatus: 'rework', assignmentStatus: 'rework', toStatus: 'rework',
    };
    expect(await handlers[SUPERVISION_MCP_TOOLS.RECOVER](request)).toMatchObject({
      status: 'ok', taskId, assignmentId: worker.value.assignmentId,
      converged: 'exact_rework_receipt', replay: false,
    });
    expect(registry.get(taskId)).toMatchObject({ status: 'rework', currentRevision: revision });
    expect(registry.getAssignment(worker.value.assignmentId)).toMatchObject({
      status: 'rework', auditAttemptId: attemptId, auditRevision: revision,
      verdict: 'REWORK', blocker: 'repair exact production finding',
      leaseId: expect.stringMatching(/^(?:lse|supervision_lease)_/),
    });
    expect(registry.get(taskId)!.assignments.filter((candidate) => candidate.role === 'implementer'))
      .toHaveLength(1);
    expect(await handlers[SUPERVISION_MCP_TOOLS.RECOVER](request)).toMatchObject({
      status: 'ok', replay: true, converged: 'exact_rework_receipt',
    });
    registry.close();
    database.close();
  });

  it('recovers an exact PASS revision after legacy finish cleared the lease without binding the task revision', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-finish-revision-recovery-'));
    const dbPath = join(dir, 'supervision-state.sqlite');
    const revision = 'integration-revision-r1';
    // Coordinator authority drives the task but never masquerades as an
    // implementation assignment. Exercise both roles whose own finish edge is
    // legal; coordinator restart continuity is covered at its authority gate.
    const roles = ['integration_owner', 'implementer'] as const;
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
          { sessionName: target.owner.sessionName, projectName: 'alpha' } as never,
          { resolveSessionIdentity: testIdentityResolver, registry: supervisionRegistryPort(registry) },
        );
        const finishResponse = await intent[SUPERVISION_MCP_TOOLS.INTENT]({
          intent: 'finish', taskId: target.taskId, assignmentId: target.assignmentId,
        });
        expect(finishResponse, JSON.stringify(finishResponse)).toMatchObject({
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

  it('send_message atomically refreshes a rotated exact continuation before task_update and finish', async () => {
    const registry = getSupervisionTaskRegistry();
    const taskId = 'existing-task-rotated-continuation';
    const assignmentId = 'rotated-continuation-assignment';
    const revision = 'rotated-continuation-r1';
    const stale = {
      ...identity('deck_alpha_w1', 'claude-code-sdk'),
      sessionInstanceId: 'instance-before-restart',
      runtimeEpoch: 'epoch-before-restart',
    };
    const brain = session('deck_alpha_brain');
    const worker = session('deck_alpha_w1');
    const staleExecutionBinding = persistedExecutionBinding(worker.name);
    staleExecutionBinding.actual = { ...staleExecutionBinding.actual, ...stale };
    expect(registry.createOrGet({
      projectName: 'alpha', taskId, classification: 'independent_top_level',
      objective: 'resume after runtime rotation', currentRevision: revision,
    })).toMatchObject({ ok: true });
    expect(registry.createAssignment({
      taskId, role: 'coordinator', identity: identity(brain.name), required: false,
    })).toMatchObject({ ok: true });
    expect(registry.createAssignment({
      taskId, assignmentId, role: 'implementer', identity: stale,
      scopeFiles: ['src/exact.ts'], auditRevision: revision,
      executionBinding: staleExecutionBinding,
    })).toMatchObject({ ok: true });
    expect(registry.updateAssignment({
      assignmentId, identity: stale, status: 'implementing', revision,
    })).toMatchObject({ ok: true });

    const dispatchMessage = vi.fn(async () => {
      // The durable row must be current BEFORE delivery. Otherwise a worker can
      // receive this append and immediately lose task_update to owner_mismatch.
      expect(registry.getAssignment(assignmentId)).toMatchObject({
        identity: {
          sessionName: worker.name,
          sessionInstanceId: worker.sessionInstanceId,
          runtimeEpoch: worker.runtimeEpoch,
          agentType: worker.agentType,
        },
        executionBinding: { actual: {
          sessionInstanceId: worker.sessionInstanceId,
          runtimeEpoch: worker.runtimeEpoch,
        } },
      });
      return undefined;
    });
    const request = {
      target: worker.name,
      message: 'continue after restart',
      idempotencyKey: 'rotated-continuation-once',
      task: { taskId, assignmentId, currentRevision: revision },
    } as const;
    const deps = {
      listSessions: () => [brain, worker], dispatchMessage,
      exactTargetOnly: true, ensureSupervisionAssignmentWorktree: ensureTestAssignmentWorktree,
    };
    const caller = {
      userId: 'u', sessionName: brain.name, projectName: 'alpha', projectRoot: '/work/alpha',
    };

    const sent = await dispatchSendMessage(caller, request, deps);
    if (sent.status !== 'accepted') throw new Error(JSON.stringify(sent));
    expect(sent).toMatchObject({
      status: 'accepted', taskId, assignmentId,
    });
    const liveIdentity = identity(worker.name, worker.agentType);
    expect(registry.updateAssignment({
      assignmentId, identity: liveIdentity, status: 'validated',
      revision, validationState: 'passed',
    })).toMatchObject({ ok: true });
    expect(registry.finishAssignment({
      assignmentId, identity: liveIdentity, revision,
    })).toMatchObject({ ok: true, value: { assignmentId, status: 'ready_for_audit' } });

    const generation = registry.getAssignment(assignmentId)!.generation;
    expect(await dispatchSendMessage(caller, request, deps)).toMatchObject({
      status: 'accepted', idempotentReplay: true, taskId, assignmentId,
    });
    expect(registry.getAssignment(assignmentId)!.generation).toBe(generation);
    expect(registry.listAssignments(taskId).filter((item) => item.role === 'implementer'))
      .toHaveLength(1);
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
      { sessionName: 'deck_alpha_w1', projectName: 'alpha' } as never, { resolveSessionIdentity: testIdentityResolver, registry: supervisionRegistryPort() },
    );
    const list: any = await own[SUPERVISION_MCP_TOOLS.LIST]({});
    expect(list.status).toBe('ok');
    expect(list.tasks).toHaveLength(1);
    expect(list.tasks[0]?.taskId).toBe((start as { taskId: string }).taskId);
    const get: any = await own[SUPERVISION_MCP_TOOLS.GET]({ taskId: (start as { taskId: string }).taskId });
    expect(get.status).toBe('ok');

    const other = createSupervisionMcpToolHandlers(
      { sessionName: 'deck_alpha_w2', projectName: 'alpha' } as never, { resolveSessionIdentity: testIdentityResolver, registry: supervisionRegistryPort() },
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
        { sessionName: owner.sessionName, projectName: 'alpha' } as never,
        { resolveSessionIdentity: testIdentityResolver, registry: port() },
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
        { resolveSessionIdentity: testIdentityResolver, registry: supervisionRegistryPort(registry) },
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
        classification: 'independent_top_level', currentRevision: auditRevision, now: 10,
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
      expect(registry.appendMatchingAuditReceipt({
        taskId: input.taskId,
        auditorAssignmentId: auditor.value.assignmentId,
        auditorIdentity: auditor.value.identity,
        auditorSessionName: auditor.value.identity.sessionName,
        attemptId,
        revision: auditRevision,
        receiptKind: 'final',
        verdict: input.auditorVerdict ?? 'REWORK',
        findings: `${input.taskId} exact audit receipt`,
        validations: [],
        now: 35,
      })).toMatchObject({ ok: true });
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
        { resolveSessionIdentity: testIdentityResolver, registry: supervisionRegistryPort(registry) },
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
      expect(registry.appendMatchingAuditReceipt({
        taskId: 'd-rework-split',
        auditorAssignmentId: reworkAuditor.value.assignmentId,
        auditorIdentity: reworkAuditor.value.identity,
        auditorSessionName: reworkAuditor.value.identity.sessionName,
        attemptId: 'd-rework-attempt', revision: 'revision-r2',
        receiptKind: 'final', verdict: 'REWORK', findings: 'exact R2 repair', validations: [], now: 2_500,
      })).toMatchObject({ ok: true });
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

  it('censuses NULL-project orphans on a bounded cursor and backfills only unique lineage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'supervision-null-project-census-'));
    const dbPath = join(dir, 'registry.sqlite');
    const liveIdentity = identity('deck_alpha_live_worker');
    let registry = new SupervisionTaskRegistry({
      dbPath,
      resolveLiveParticipants: (projectName) => projectName === 'alpha' ? [liveIdentity] : [],
    });
    try {
      for (const [taskId, owner] of [
        ['orphan-unique', liveIdentity],
        ['orphan-ambiguous', identity('deck_unknown_worker')],
      ] as const) {
        expect(registry.createOrGet({ taskId, projectName: 'alpha', objective: taskId })).toMatchObject({ ok: true });
        expect(registry.createAssignment({ taskId, role: 'implementer', identity: owner })).toMatchObject({ ok: true });
      }
      registry.close();
      const database = new DatabaseSync(dbPath);
      for (const taskId of ['orphan-unique', 'orphan-ambiguous']) {
        const row = database.prepare('SELECT payload_json AS payload FROM supervision_tasks WHERE task_id = ?')
          .get(taskId) as { payload: string };
        const payload = { ...JSON.parse(row.payload), projectName: '' };
        database.prepare('UPDATE supervision_tasks SET project_name = NULL, payload_json = ? WHERE task_id = ?')
          .run(JSON.stringify(payload), taskId);
      }
      database.close();

      registry = new SupervisionTaskRegistry({
        dbPath,
        resolveLiveParticipants: (projectName) => projectName === 'alpha' ? [liveIdentity] : [],
      });
      const normalPage = registry.reconcileHousekeeping({ mode: 'dryRun', projectName: 'alpha', limit: 1 });
      expect(normalPage).toMatchObject({ scanned: 0, hasMore: true, nextCursor: 'orphan:' });
      const firstOrphan = registry.reconcileHousekeeping({
        mode: 'dryRun', projectName: 'alpha', cursor: normalPage.nextCursor, limit: 1,
      });
      expect(firstOrphan).toMatchObject({ scanned: 1, hasMore: true, nextCursor: 'orphan:orphan-ambiguous' });
      expect(firstOrphan.orphanDiagnostics).toEqual([
        expect.objectContaining({ taskId: 'orphan-ambiguous', reason: 'orphan_project_ambiguous' }),
      ]);
      const secondOrphan = registry.reconcileHousekeeping({
        mode: 'dryRun', projectName: 'alpha', cursor: firstOrphan.nextCursor, limit: 1,
      });
      expect(secondOrphan.actions).toEqual([
        expect.objectContaining({
          taskId: 'orphan-unique', kind: 'backfill_orphan_project',
          projectName: 'alpha', reason: 'unique_live_session_lineage',
        }),
      ]);
      registry.reconcileHousekeeping({
        mode: 'apply', projectName: 'alpha', cursor: firstOrphan.nextCursor, limit: 1,
      });
      expect(registry.getTaskRecord('orphan-unique')).toMatchObject({ projectName: 'alpha' });
      expect(registry.getAssignment('orphan-unique')?.identity ?? registry.listAssignments('orphan-unique')[0]?.identity)
        .toMatchObject(liveIdentity);
      expect(registry.getTaskRecord('orphan-ambiguous')?.projectName).toBe('');

      registry.close();
      registry = new SupervisionTaskRegistry({
        dbPath,
        resolveLiveParticipants: (projectName) => projectName === 'alpha' ? [liveIdentity] : [],
      });
      expect(registry.getTaskRecord('orphan-unique')).toMatchObject({ projectName: 'alpha' });
    } finally {
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('continues past full project pages before recovering the observed legacy UUID row', () => {
    const database = new DatabaseSync(':memory:');
    const liveIdentity = identity('deck_cd_brain');
    const registry = new SupervisionTaskRegistry({
      database,
      resolveLiveParticipants: (projectName) => projectName === 'cd' ? [liveIdentity] : [],
    });
    const taskId = 'supervision_task_d7f73972-b5f0-4c5b-8335-93eb3de9ef7a';
    const assignmentId = 'supervision_assignment_d0d3e64a-263f-412c-9742-199cf6723186';
    try {
      for (const suffix of ['a', 'b']) {
        expect(registry.createOrGet({
          taskId: `project-page-${suffix}`, projectName: 'cd', objective: `project page ${suffix}`,
        })).toMatchObject({ ok: true });
      }
      expect(registry.createOrGet({ taskId, projectName: 'cd', objective: 'legacy UUID heartbeat' }))
        .toMatchObject({ ok: true });
      expect(registry.createAssignment({
        assignmentId, taskId, role: 'implementer', identity: liveIdentity,
      })).toMatchObject({ ok: true });

      const stored = database.prepare(
        'SELECT payload_json AS payload FROM supervision_tasks WHERE task_id = ?',
      ).get(taskId) as { payload: string };
      database.prepare(
        'UPDATE supervision_tasks SET project_name = NULL, payload_json = ? WHERE task_id = ?',
      ).run(JSON.stringify({ ...JSON.parse(stored.payload), projectName: '' }), taskId);

      // The observed first bounded page legitimately has no orphan action; its
      // cursor is the authority to keep scanning rather than redispatching the
      // invisible binding unchanged.
      const first = registry.reconcileHousekeeping({ mode: 'dryRun', projectName: 'cd', limit: 1 });
      expect(first).toMatchObject({ scanned: 1, hasMore: true, actionCounts: {} });
      expect(first.nextCursor).not.toMatch(/^orphan:/);
      const second = registry.reconcileHousekeeping({
        mode: 'dryRun', projectName: 'cd', cursor: first.nextCursor, limit: 1,
      });
      expect(second).toMatchObject({ scanned: 1, hasMore: true, nextCursor: 'orphan:', actionCounts: {} });

      const orphan = registry.reconcileHousekeeping({
        mode: 'dryRun', projectName: 'cd', cursor: second.nextCursor, limit: 1,
      });
      expect(orphan.actions).toEqual([expect.objectContaining({
        taskId, kind: 'backfill_orphan_project', projectName: 'cd', reason: 'unique_live_session_lineage',
      })]);
      expect(orphan.orphanDiagnostics).toEqual([expect.objectContaining({
        taskId, reason: 'orphan_project_backfill_ready', assignmentIds: [assignmentId],
      })]);

      registry.reconcileHousekeeping({
        mode: 'apply', projectName: 'cd', cursor: second.nextCursor, limit: 1,
      });
      expect(registry.getTaskRecord(taskId)).toMatchObject({ projectName: 'cd' });
      expect(registry.getAssignment(assignmentId)?.identity.sessionName).toBe('deck_cd_brain');
    } finally {
      registry.close();
      database.close();
    }
  });

  it('retires and archives a legacy active projection only when immutable finalization consumed its exact PASS', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = prepareStructuredFinalizationShape(registry, 'legacy-active-finalized-projection');
    seedFinalAuditReceipt(database, {
      receiptId: 'legacy-active-pass-receipt', taskId: shape.taskId,
      assignmentId: shape.auditor.assignmentId, attemptId: shape.attemptId,
      revision: shape.revision, verdict: 'PASS', senderIdentity: shape.auditor.identity, createdAt: 90,
    });
    expect(registry.finalizeIntegration({
      ...shape.finalization, ciResult: 'ci_not_configured',
      externalRunId: undefined, externalHeadSha: undefined, externalTaskId: undefined,
      identity: shape.owner.identity, now: 100,
    })).toMatchObject({ ok: true, value: { status: 'finalized' } });
    rewritePersistedTask(database, {
      ...registry.get(shape.taskId)!, status: 'ready_for_integration', archivedAt: undefined,
      archiveReason: undefined, updatedAt: 100,
    });
    rewritePersistedAssignment(database, {
      ...registry.getAssignment(shape.owner.assignmentId)!,
      status: 'implementing', leaseId: 'legacy-owner-lease', updatedAt: 100,
    });

    const dry = registry.reconcileHousekeeping({
      mode: 'dryRun', projectName: 'alpha', limit: 1, now: 30 * 24 * 60 * 60_000,
    });
    expect(dry).toMatchObject({ scanned: 1, hasMore: false });
    expect(dry.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: shape.taskId, assignmentId: shape.owner.assignmentId,
        kind: 'retire_consumed_assignment',
      }),
      expect.objectContaining({ taskId: shape.taskId, kind: 'repair_aggregate', toStatus: 'finalized' }),
      expect.objectContaining({ taskId: shape.taskId, kind: 'archive_terminal' }),
    ]));

    registry.reconcileHousekeeping({
      mode: 'apply', projectName: 'alpha', limit: 1, now: 30 * 24 * 60 * 60_000,
    });
    expect(registry.getAssignment(shape.owner.assignmentId)).toMatchObject({
      status: 'finalized', leaseId: '', auditRevision: shape.revision, auditAttemptId: shape.attemptId,
    });
    expect(registry.get(shape.taskId)).toMatchObject({
      status: 'finalized', archivedAt: 30 * 24 * 60 * 60_000,
      finalization: { revision: shape.revision, auditAttemptId: shape.attemptId },
    });
    expect(registry.reconcileHousekeeping({
      mode: 'apply', projectName: 'alpha', limit: 1, now: 30 * 24 * 60 * 60_000 + 1,
    }).actions).toEqual([]);
    registry.close();
    database.close();
  });
});

describe('tsk_4dd live RED: successor recovery blocked by a stale active auditor', () => {
  // Exact reproduction. tsk_4dd sat at ready_for_audit on R1 with active
  // auditor asg_4eo. Brain recovered task+implementer to rework, but the stale
  // R1 auditor stayed non-terminal and holding a lease, and the R1->R3 revision
  // recovery kept returning invalid_transition because `exactStaleShape`
  // requires `!activeAuditor`. Brain could not clear that auditor either
  // (task_recover -> role_forbidden, task_intent(cancel) -> not visible, exact
  // redelivery -> audit progress exists, unbound delivery -> ambiguous), so the
  // task was permanently wedged with no operator escape.
  it('retires the stale auditor atomically and binds the successor revision', () => {
    const dir = mkdtempSync(join(tmpdir(), 'supervision-stale-auditor-successor-'));
    const registry = new SupervisionTaskRegistry({ dbPath: join(dir, 'registry.sqlite') });
    try {
      const R1 = 'candidate-4dd-r1-aaaaaaaa';
      const R3 = 'candidate-4dd-r3-cccccccc';
      expect(registry.createOrGet({
        projectName: 'alpha', taskId: 'tsk-4dd', objective: 'stale auditor',
        classification: 'independent_top_level',
      }).ok).toBe(true);

      const impl = registry.createAssignment({
        assignmentId: 'asg-4dd-impl', taskId: 'tsk-4dd', role: 'implementer',
        identity: identity('deck_alpha_impl'), scopeFiles: ['src/a.ts'], claimMode: 'exclusive',
      });
      if (!impl.ok) throw new Error(impl.reason);
      const auditor = registry.createAssignment({
        assignmentId: 'asg-4eo', taskId: 'tsk-4dd', role: 'auditor',
        identity: identity('deck_alpha_auditor'), scopeFiles: [],
        auditAttemptId: 'attempt-4dd-r1', auditRevision: R1,
      });
      if (!auditor.ok) throw new Error(auditor.reason);

      expect(registry.updateTask({ taskId: 'tsk-4dd', status: 'delegated' }).ok).toBe(true);
      expect(registry.updateTask({ taskId: 'tsk-4dd', status: 'implementing' }).ok).toBe(true);
      expect(registry.updateAssignment({
        assignmentId: 'asg-4dd-impl', identity: identity('deck_alpha_impl'),
        revision: R1, auditRevision: R1,
      }).ok).toBe(true);
      expect(registry.getTaskRecord('tsk-4dd')!.currentRevision).toBe(R1);

      // The auditor is ACTIVE (non-terminal) on R1, exactly like asg_4eo.
      expect(registry.updateAssignment({
        assignmentId: 'asg-4eo', identity: identity('deck_alpha_auditor'),
        status: 'implementing', auditAttemptId: 'attempt-4dd-r1', auditRevision: R1,
      }).ok).toBe(true);
      const staleBefore = registry.getAssignment('asg-4eo')!;
      expect(['cancelled', 'finalized']).not.toContain(staleBefore.status);

      // tsk_4dd's real shape: the task reached ready_for_audit on R1 while the
      // auditor was live. Brain's successful step then moved it to rework.
      expect(registry.updateTask({ taskId: 'tsk-4dd', status: 'ready_for_audit' }).ok).toBe(true);
      expect(registry.updateTask({ taskId: 'tsk-4dd', status: 'auditing' }).ok).toBe(true);
      expect(registry.updateTask({ taskId: 'tsk-4dd', status: 'rework' }).ok).toBe(true);

      // The wedge: exact same-task successor recovery R1 -> R3.
      const recovered = registry.rebindTaskAssignmentRevision({
        taskId: 'tsk-4dd', assignmentId: 'asg-4dd-impl',
        fromRevision: R1, toRevision: R3,
        worktreeSnapshot: recoveryWorktreeSnapshot(['src/a.ts']),
        leaseAction: 'preserve', idempotencyKey: 'idem-4dd-r3',
        reason: 'brain successor recovery after material scope change',
      });
      expect(recovered).toMatchObject({ ok: true });
      expect(registry.getTaskRecord('tsk-4dd')!.currentRevision).toBe(R3);

      // The stale auditor is retired atomically, with R1 provenance preserved
      // verbatim -- never rebound onto R3, never given a verdict.
      const staleAfter = registry.getAssignment('asg-4eo')!;
      expect(staleAfter.status).toBe('cancelled');
      expect(staleAfter.auditRevision).toBe(R1);
      expect(staleAfter.auditAttemptId).toBe('attempt-4dd-r1');
      expect(staleAfter.identity.sessionName).toBe('deck_alpha_auditor');
      expect(staleAfter.verdict ?? '').not.toMatch(/PASS/i);

      // A fresh auditor for R3 is now permitted (duplicate guard must not fire).
      expect(registry.createAssignment({
        assignmentId: 'asg-4dd-auditor-r3', taskId: 'tsk-4dd', role: 'auditor',
        identity: identity('deck_alpha_auditor2'), scopeFiles: [],
        auditAttemptId: 'attempt-4dd-r3', auditRevision: R3,
      }).ok).toBe(true);

      // Idempotent replay: the same key must not retire the FRESH R3 auditor,
      // re-cancel the old one, or double-write events. Retirement is scoped to
      // the revision being superseded, so a replay after a new auditor exists
      // must leave that new auditor untouched.
      const eventsBeforeReplay = registry.listEvents('tsk-4dd').length;
      const replay = registry.rebindTaskAssignmentRevision({
        taskId: 'tsk-4dd', assignmentId: 'asg-4dd-impl',
        fromRevision: R1, toRevision: R3,
        worktreeSnapshot: recoveryWorktreeSnapshot(['src/a.ts']),
        leaseAction: 'preserve', idempotencyKey: 'idem-4dd-r3',
        reason: 'brain successor recovery after material scope change',
      });
      expect(replay).toMatchObject({ ok: true, replay: true });
      expect(registry.getAssignment('asg-4dd-auditor-r3')!.status).not.toBe('cancelled');
      expect(registry.getAssignment('asg-4eo')!.auditRevision).toBe(R1);
      expect(registry.listEvents('tsk-4dd')).toHaveLength(eventsBeforeReplay);
    } finally {
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('R3 P1-1: realistic ordinary successor shape', () => {
  // AUDIT REWORK. The R1/R2 successor test left task.currentRevision UNSET, so
  // it never reached the `bindsTaskRevision` gate that fires in production and
  // therefore proved nothing about the real shape. The production shape is:
  // task.currentRevision = R1 AND implementer.auditRevision = R1 AND
  // implementer.status = implementing. In that shape the bind is rejected
  // `old_revision` even though R2 is strictly newer -- verified live this
  // session when binding candidate-cp-deadlock-r2-45b2cc90 on tsk_4ft itself.
  it('binds R2 atomically with task.currentRevision set to R1', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    try {
      const taskId = 'task-realistic-successor';
      const assignmentId = `${taskId}-implementer`;
      const R1 = 'feature-cc8-r1-aaaaaaaa';
      const R2 = 'feature-cc8-r2-bbbbbbbb';
      const owner = identity('deck_owner_worker');
      expect(registry.createOrGet({
        taskId, projectName: 'alpha', classification: 'independent_top_level',
        objective: 'realistic successor bind',
      })).toMatchObject({ ok: true });
      expect(registry.createAssignment({
        assignmentId, taskId, role: 'implementer', identity: owner, scopeFiles: ['src/a.ts'],
      }).ok).toBe(true);
      expect(registry.updateTask({ taskId, status: 'delegated' }).ok).toBe(true);
      expect(registry.updateTask({ taskId, status: 'implementing' }).ok).toBe(true);
      // Bind R1 the ordinary way, which ALSO sets task.currentRevision = R1.
      expect(registry.updateAssignment({
        assignmentId, identity: owner, status: 'implementing', revision: R1, auditRevision: R1,
      }).ok).toBe(true);
      expect(registry.getTaskRecord(taskId)!.currentRevision).toBe(R1);
      expect(registry.getAssignment(assignmentId)!.status).toBe('implementing');

      // The real production request: strictly-new hash-anchored successor.
      const bound = registry.updateAssignment({
        assignmentId, identity: owner, revision: R2, auditRevision: R2,
      });
      expect(bound).toMatchObject({ ok: true });
      // Atomic: task and assignment both move, or neither does.
      expect(registry.getTaskRecord(taskId)!.currentRevision).toBe(R2);
      expect(registry.getAssignment(assignmentId)!.auditRevision).toBe(R2);
    } finally {
      registry.close();
      database.close();
    }
  });
});

describe('tsk_4ft R3 — P1 #2/#3/#4 recovery authority', () => {
  function auditTask(registry: SupervisionTaskRegistry, taskId: string, project = 'alpha') {
    const R1 = `${taskId}-r1-aaaaaaaa`;
    expect(registry.createOrGet({
      taskId, projectName: project, classification: 'independent_top_level', objective: 'r3 authority',
    }).ok).toBe(true);
    const impl = registry.createAssignment({
      assignmentId: `${taskId}-impl`, taskId, role: 'implementer',
      identity: identity(`deck_${project}_impl`), scopeFiles: ['src/a.ts'],
    });
    if (!impl.ok) throw new Error(impl.reason);
    expect(registry.updateTask({ taskId, status: 'delegated' }).ok).toBe(true);
    expect(registry.updateTask({ taskId, status: 'implementing' }).ok).toBe(true);
    expect(registry.updateAssignment({
      assignmentId: `${taskId}-impl`, identity: identity(`deck_${project}_impl`),
      revision: R1, auditRevision: R1,
    }).ok).toBe(true);
    return { R1 };
  }

  // P1 #3 — standalone Brain-authorized stale-auditor cancel. tsk_4dd wedged
  // because there was NO exposed operation to retire a live auditor on the SAME
  // revision; only the successor-revision path could do it.
  it('cancels an exact stale auditor on the same revision, preserving provenance', () => {
    const registry = makeRegistry();
    const { R1 } = auditTask(registry, 'r3-cancel');
    const auditor = registry.createAssignment({
      assignmentId: 'r3-cancel-auditor', taskId: 'r3-cancel', role: 'auditor',
      identity: identity('deck_alpha_auditor'), scopeFiles: [],
      auditAttemptId: 'r3-attempt-1', auditRevision: R1,
    });
    if (!auditor.ok) throw new Error(auditor.reason);
    expect(registry.updateAssignment({
      assignmentId: 'r3-cancel-auditor', identity: identity('deck_alpha_auditor'),
      status: 'implementing', auditAttemptId: 'r3-attempt-1', auditRevision: R1,
    }).ok).toBe(true);

    const cancelled = registry.cancelStaleAuditorAsProjectBrain({
      taskId: 'r3-cancel', auditorAssignmentId: 'r3-cancel-auditor',
      callerProjectName: 'alpha', reason: 'same-revision deadlock; retire stale auditor',
    });
    expect(cancelled).toMatchObject({ ok: true });
    const after = registry.getAssignment('r3-cancel-auditor')!;
    expect(after.status).toBe('cancelled');
    expect(after.leaseId).toBe('');                 // lease released
    expect(after.auditAttemptId).toBe('r3-attempt-1'); // provenance preserved
    expect(after.auditRevision).toBe(R1);
    expect(after.identity.sessionName).toBe('deck_alpha_auditor');
    expect(after.verdict ?? '').toBe('');            // NO verdict written
    registry.close();
  });

  it('refuses to cancel an auditor holding an accepted PASS', () => {
    const registry = makeRegistry();
    const { R1 } = auditTask(registry, 'r3-pass');
    const auditor = registry.createAssignment({
      assignmentId: 'r3-pass-auditor', taskId: 'r3-pass', role: 'auditor',
      identity: identity('deck_alpha_auditor'), scopeFiles: [],
      auditAttemptId: 'r3-pass-attempt', auditRevision: R1,
    });
    if (!auditor.ok) throw new Error(auditor.reason);
    expect(registry.updateAssignment({
      assignmentId: 'r3-pass-auditor', identity: identity('deck_alpha_auditor'),
      status: 'implementing', auditAttemptId: 'r3-pass-attempt', auditRevision: R1,
      verdict: 'PASS',
    }).ok).toBe(true);
    expect(registry.cancelStaleAuditorAsProjectBrain({
      taskId: 'r3-pass', auditorAssignmentId: 'r3-pass-auditor',
      callerProjectName: 'alpha', reason: 'attempt to retire a passed auditor',
    })).toMatchObject({ ok: false, reason: 'receipt_closed' });
    expect(registry.getAssignment('r3-pass-auditor')!.status).not.toBe('cancelled');
    registry.close();
  });

  // P1 #4 — authority layer. The registry is the authority of record and is
  // reachable from callers other than the MCP tool, so the project check must
  // live HERE, not only at the MCP entry point.
  it('denies cross-project stale-auditor cancel', () => {
    const registry = makeRegistry();
    const { R1 } = auditTask(registry, 'r3-xproj');
    const auditor = registry.createAssignment({
      assignmentId: 'r3-xproj-auditor', taskId: 'r3-xproj', role: 'auditor',
      identity: identity('deck_alpha_auditor'), scopeFiles: [],
      auditAttemptId: 'r3-xproj-attempt', auditRevision: R1,
    });
    if (!auditor.ok) throw new Error(auditor.reason);
    expect(registry.cancelStaleAuditorAsProjectBrain({
      taskId: 'r3-xproj', auditorAssignmentId: 'r3-xproj-auditor',
      callerProjectName: 'beta', reason: 'foreign project takeover attempt',
    })).toMatchObject({ ok: false, reason: 'owner_mismatch' });
    expect(registry.getAssignment('r3-xproj-auditor')!.status).not.toBe('cancelled');
    registry.close();
  });

  it('denies cross-project audit identity rebind at the registry layer', () => {
    const registry = makeRegistry();
    const { R1 } = auditTask(registry, 'r3-rebind-xproj');
    const auditor = registry.createAssignment({
      assignmentId: 'r3-rebind-xproj-auditor', taskId: 'r3-rebind-xproj', role: 'auditor',
      identity: identity('deck_alpha_auditor'), scopeFiles: [],
      auditAttemptId: 'r3-rb-attempt', auditRevision: R1,
    });
    if (!auditor.ok) throw new Error(auditor.reason);
    expect(registry.rebindAuditAssignment({
      taskId: 'r3-rebind-xproj', assignmentId: 'r3-rebind-xproj-auditor',
      identity: identity('deck_beta_thief'), callerProjectName: 'beta',
      reason: 'foreign project rebind attempt',
    })).toMatchObject({ ok: false, reason: 'owner_mismatch' });
    expect(registry.getAssignment('r3-rebind-xproj-auditor')!.identity.sessionName)
      .toBe('deck_alpha_auditor');
    registry.close();
  });

  // P1 #2 — restart / runtimeEpoch replacement for NON-auditor exact roles.
  it('rebinds an integration_owner across a runtimeEpoch change, preserving provenance', () => {
    const registry = makeRegistry();
    const { R1 } = auditTask(registry, 'r3-epoch');
    const owner = registry.createAssignment({
      assignmentId: 'r3-epoch-owner', taskId: 'r3-epoch', role: 'integration_owner',
      identity: identity('deck_alpha_owner'), scopeFiles: [],
      auditAttemptId: 'r3-epoch-attempt', auditRevision: R1,
    });
    if (!owner.ok) throw new Error(owner.reason);
    const replaced = { ...identity('deck_alpha_owner'), runtimeEpoch: 'epoch-after-restart' };
    const rebound = registry.rebindAuditAssignment({
      taskId: 'r3-epoch', assignmentId: 'r3-epoch-owner',
      identity: replaced, callerProjectName: 'alpha',
      reason: 'daemon restart replaced the runtime epoch',
    });
    expect(rebound).toMatchObject({ ok: true });
    const after = registry.getAssignment('r3-epoch-owner')!;
    expect(after.identity.runtimeEpoch).toBe('epoch-after-restart');
    expect(after.auditAttemptId).toBe('r3-epoch-attempt'); // provenance preserved
    expect(after.auditRevision).toBe(R1);
    expect(after.role).toBe('integration_owner');
    registry.close();
  });
});

describe('tsk_4iu live sequence: REWORK auditor stuck implementing blocks successor', () => {
  // tsk_4iu/asg_4ix: the R1 auditor recorded a FINAL REWORK verdict, but
  // task_finish returned old_audit_attempt, so asg_4mu stayed `implementing`
  // holding lease lse_4mu with verdict REWORK. That single orphaned auditor
  // then blocked R1->R2 successor binding (invalid_transition), and Brain could
  // not retire it (task_recover -> role_forbidden, task_intent cancel -> not
  // visible). A project Brain must be able to retire an exact stale auditor
  // even AFTER a final NON-PASS verdict, without destroying its history.
  it('retires a final-REWORK auditor, preserves its receipt, and unblocks the successor', () => {
    const registry = makeRegistry();
    const R1 = 'tsk-4iu-r1-aaaaaaaa';
    expect(registry.createOrGet({
      taskId: 'tsk-4iu', projectName: 'alpha', classification: 'independent_top_level', objective: 'stuck rework auditor',
    }).ok).toBe(true);
    const impl = registry.createAssignment({
      assignmentId: 'asg-4ix', taskId: 'tsk-4iu', role: 'implementer',
      identity: identity('deck_alpha_impl'), scopeFiles: ['src/a.ts'],
    });
    if (!impl.ok) throw new Error(impl.reason);
    const auditor = registry.createAssignment({
      assignmentId: 'asg-4mu', taskId: 'tsk-4iu', role: 'auditor',
      identity: identity('deck_alpha_auditor'), scopeFiles: [],
      auditAttemptId: 'attempt-4iu-r1', auditRevision: R1,
    });
    if (!auditor.ok) throw new Error(auditor.reason);
    expect(registry.updateTask({ taskId: 'tsk-4iu', status: 'delegated' }).ok).toBe(true);
    expect(registry.updateTask({ taskId: 'tsk-4iu', status: 'implementing' }).ok).toBe(true);
    expect(registry.updateAssignment({
      assignmentId: 'asg-4ix', identity: identity('deck_alpha_impl'), revision: R1, auditRevision: R1,
    }).ok).toBe(true);

    // Real tsk_4iu ordering: the auditor was already working (non-terminal)
    // when its FINAL REWORK verdict landed, and task_finish then failed with
    // old_audit_attempt, so it was never moved to a terminal state.
    expect(registry.updateAssignment({
      assignmentId: 'asg-4mu', identity: identity('deck_alpha_auditor'),
      status: 'implementing', auditAttemptId: 'attempt-4iu-r1', auditRevision: R1,
    }).ok).toBe(true);
    const receipt = registry.appendMatchingAuditReceipt({
      taskId: 'tsk-4iu', auditorAssignmentId: 'asg-4mu',
      attemptId: 'attempt-4iu-r1', revision: R1, receiptKind: 'final', verdict: 'REWORK',
      findings: 'R1 findings that must survive retirement',
      auditorIdentity: registry.getAssignment('asg-4mu')!.identity,
      auditorSessionName: 'deck_alpha_auditor', validations: [],
    });
    expect(receipt).toMatchObject({ ok: true });
    const stuck = registry.getAssignment('asg-4mu')!;
    expect(['cancelled', 'finalized']).not.toContain(stuck.status);

    // Brain retires it on the SAME object.
    expect(registry.cancelStaleAuditorAsProjectBrain({
      taskId: 'tsk-4iu', auditorAssignmentId: 'asg-4mu',
      callerProjectName: 'alpha', reason: 'final REWORK recorded but auditor left non-terminal',
    })).toMatchObject({ ok: true });
    const retired = registry.getAssignment('asg-4mu')!;
    expect(retired.status).toBe('cancelled');
    expect(retired.leaseId).toBe('');
    expect(retired.auditAttemptId).toBe('attempt-4iu-r1');
    expect(retired.auditRevision).toBe(R1);
    expect(retired.verdict ?? 'REWORK').toBe('REWORK'); // no PASS is ever synthesised
    // The append-only receipt and its findings survive retirement.
    const receipts = registry.listAuditReceipts('tsk-4iu');
    expect(receipts.some((r) => r.assignmentId === 'asg-4mu'
      && r.receiptKind === 'final' && r.verdict === 'REWORK'
      && r.findings === 'R1 findings that must survive retirement')).toBe(true);
    registry.close();
  });
});

// A task dispatched by Brain A may only be acted on by the EXACT persistent
// identity of the coordinator assignment bound to that task. `isProjectBrain`
// asks only "is this an unparented brain whose project matches", and
// finishAssignmentAsProjectBrain's sole authority check is
// `task.projectName !== callerProjectName` -- it receives no caller identity at
// all. So a SECOND main-session Brain in the same project (a cloned group, a
// replacement window) inherits authority over another Brain's task, which is
// exactly the substitution the invariant forbids. The same file already states
// the correct principle for execution clones: "arbitrary same-project siblings
// are NOT granted control".
describe('project-Brain finish authority is bound to the task coordinator', () => {
  const PROJECT = 'alpha';

  /** Task owned by Brain A with an auditor carrying an accepted final PASS. */
  function coordinatorBoundTask(taskId: string) {
    const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
    const brainA = identity(`deck_${PROJECT}_brain`);
    const worker = identity(`deck_${taskId}_worker`);
    const auditorIdentity = identity(`deck_${taskId}_auditor`, 'claude-code');
    const attemptId = `${taskId}-attempt`;
    const revision = `${taskId}-r1`;
    expect(registry.createOrGet({
      taskId, projectName: PROJECT, classification: 'independent_top_level',
      objective: 'coordinator-bound finish authority', currentRevision: revision,
    })).toMatchObject({ ok: true });
    // Brain A is the task's ORIGINAL coordinator -- the only legitimate authority.
    const coordinator = registry.createAssignment({
      assignmentId: `${taskId}-coordinator`, taskId, role: 'coordinator',
      identity: brainA, scopeFiles: [], required: false,
    });
    const implementer = registry.createAssignment({
      assignmentId: `${taskId}-implementer`, taskId, role: 'implementer',
      identity: worker, auditRevision: revision,
    });
    const auditor = registry.createAssignment({
      assignmentId: `${taskId}-auditor`, taskId, role: 'auditor', identity: auditorIdentity,
      auditAttemptId: attemptId, auditRevision: revision,
    });
    if (!coordinator.ok || !implementer.ok || !auditor.ok) throw new Error('fixture failed');
    for (const status of ['implementing', 'validated', 'ready_for_audit'] as const) {
      expect(registry.updateAssignment({
        assignmentId: implementer.value.assignmentId, identity: worker, status,
      })).toMatchObject({ ok: true });
    }
    expect(registry.appendMatchingAuditReceipt({
      taskId, auditorAssignmentId: auditor.value.assignmentId, attemptId, revision,
      receiptKind: 'final', verdict: 'PASS', auditorSessionName: auditorIdentity.sessionName,
      auditorIdentity, findings: 'accepted exact receipt',
      validations: [{ kind: 'test', label: 'focused', outcome: 'passed', summary: 'passed' }], now: 100,
    })).toMatchObject({ ok: true });
    return { registry, taskId, brainA, auditorAssignmentId: auditor.value.assignmentId };
  }

  it('refuses a DIFFERENT main-session Brain in the same project', () => {
    const f = coordinatorBoundTask('coord-bound-foreign');
    // Brain B: unparented brain, same project, same role, never this task's
    // coordinator. A cloned session group produces exactly this shape.
    const brainB = identity(`deck_${PROJECT}_clone_brain`);
    const before = registry0Snapshot(f.registry, f.taskId);
    expect(f.registry.finishAssignmentAsProjectBrain({
      assignmentId: f.auditorAssignmentId, callerProjectName: PROJECT,
      callerIdentity: brainB, now: 110,
    })).toMatchObject({ ok: false, reason: 'owner_mismatch' });
    expect(f.registry.get(f.taskId), 'a foreign Brain must not mutate the task').toEqual(before);
    f.registry.close();
  });

  it('accepts the same durable project/session across instance and epoch rotation', () => {
    const f = coordinatorBoundTask('coord-bound-reincarnated');
    // Runtime incarnation is fencing/observability metadata, not authority.
    const reincarnated = {
      ...f.brainA,
      sessionInstanceId: `${f.brainA.sessionInstanceId}-new`,
      runtimeEpoch: `${f.brainA.runtimeEpoch}-new`,
    };
    expect(f.registry.finishAssignmentAsProjectBrain({
      assignmentId: f.auditorAssignmentId, callerProjectName: PROJECT,
      callerIdentity: reincarnated, now: 110,
    })).toMatchObject({ ok: true, value: { status: 'finalized', leaseId: '' } });
    f.registry.close();
  });

  it('still lets the task\'s own coordinator finish', () => {
    const f = coordinatorBoundTask('coord-bound-owner');
    expect(f.registry.finishAssignmentAsProjectBrain({
      assignmentId: f.auditorAssignmentId, callerProjectName: PROJECT,
      callerIdentity: f.brainA, now: 110,
    })).toMatchObject({ ok: true, value: { status: 'finalized', leaseId: '' } });
    f.registry.close();
  });

  it('refuses a participant on the SAME task that is not its coordinator', () => {
    // Being bound to the task is not being its coordinator. Only the
    // coordinator assignment carries dispatch authority.
    const f = coordinatorBoundTask('coord-bound-participant');
    const worker = identity('deck_coord-bound-participant_worker');
    expect(f.registry.finishAssignmentAsProjectBrain({
      assignmentId: f.auditorAssignmentId, callerProjectName: PROJECT,
      callerIdentity: worker, now: 110,
    })).toMatchObject({ ok: false, reason: 'owner_mismatch' });
    f.registry.close();
  });

  it('fails closed on an unusable caller identity instead of throwing', () => {
    // An authority gate that raises on malformed input is a gate that can be
    // crashed past; every unusable shape must be an ordinary refusal.
    const malformed = [
      undefined,
      { ...identity('deck_coord-bound-unusable_brain'), sessionName: '' },
    ];
    for (const [index, bad] of malformed.entries()) {
      const f = coordinatorBoundTask(`coord-bound-unusable-${index}`);
      expect(() => f.registry.finishAssignmentAsProjectBrain({
        assignmentId: f.auditorAssignmentId, callerProjectName: PROJECT,
        callerIdentity: bad as never, now: 110,
      })).not.toThrow();
      expect(f.registry.finishAssignmentAsProjectBrain({
        assignmentId: f.auditorAssignmentId, callerProjectName: PROJECT,
        callerIdentity: bad as never, now: 110,
      })).toMatchObject({ ok: false, reason: 'owner_mismatch' });
      f.registry.close();
    }
  });

  it('does not require observational runtime metadata from the durable coordinator', () => {
    for (const bad of [
      { sessionInstanceId: '' },
      { runtimeEpoch: '' },
      { agentType: '' },
      { providerFamily: '' },
    ]) {
      const f = coordinatorBoundTask(`coord-bound-observational-${Object.keys(bad)[0]}`);
      expect(f.registry.finishAssignmentAsProjectBrain({
        assignmentId: f.auditorAssignmentId, callerProjectName: PROJECT,
        callerIdentity: { ...f.brainA, ...bad } as never, now: 110,
      })).toMatchObject({ ok: true, value: { status: 'finalized' } });
      f.registry.close();
    }
  });

  it('still refuses a foreign project outright', () => {
    const f = coordinatorBoundTask('coord-bound-project');
    expect(f.registry.finishAssignmentAsProjectBrain({
      assignmentId: f.auditorAssignmentId, callerProjectName: 'beta',
      callerIdentity: f.brainA, now: 110,
    })).toMatchObject({ ok: false, reason: 'owner_mismatch' });
    f.registry.close();
  });
});

/** Stable snapshot for no-mutation assertions. */
function registry0Snapshot(registry: SupervisionTaskRegistry, taskId: string) {
  return registry.get(taskId);
}

// R4 shipped an INERT coordinatorAssignmentId: it existed only on a test record
// literal, never in the schema or the mint, so the assertion proved nothing.
// This reads the value back out of the DURABLE store and compares it to the
// registry's actual coordinator assignment, so it cannot pass unless send-tool
// really stamps the authority.
describe('durable return authority carries the task coordinator assignment', () => {
  it("mints coordinatorAssignmentId from the task's own coordinator", async () => {
    const brain = session('deck_alpha_brain');
    const worker = session('deck_alpha_w1');
    const sessions = [brain, worker];
    const caller = { userId: 'u', sessionName: brain.name, projectName: 'alpha', projectRoot: '/work/alpha' };

    const sent = await dispatchSendMessage(caller, {
      target: worker.name,
      message: 'implement the bound task',
      reply: true,
      idempotencyKey: 'coordinator-authority-mint',
      task: { objective: 'coordinator authority mint' },
    }, {
      listSessions: () => sessions,
      dispatchMessage: vi.fn(),
      exactTargetOnly: true,
      // The worktree is not what this test is about; provisioning is stubbed so
      // the assertion is purely about the minted return authority.
      ensureSupervisionAssignmentWorktree: async () => ({ ok: true as const, worktreePath: '/tmp/mint', baseRevision: undefined }),
    });

    if (sent.status !== 'accepted') throw new Error(JSON.stringify(sent));
    const delegationId = sent.deliveries?.[0]?.delegationId;
    expect(delegationId, 'a reply-enabled send must mint a durable return').toBeTruthy();

    const taskId = (sent as { taskId?: string }).taskId;
    const coordinator = getSupervisionTaskRegistry().get(taskId!)?.assignments
      ?.find((assignment) => assignment.role === 'coordinator');
    expect(coordinator?.assignmentId, 'the new task must have a coordinator assignment').toBeTruthy();

    expect(
      getDelegationReplyStore().get(delegationId!)?.coordinatorAssignmentId,
      'the durable return must be bound to the ORIGINAL coordinator assignment',
    ).toBe(coordinator!.assignmentId);
  });
});

describe('legacy assignment finish drives convergence', () => {
  it('advances the aggregate after a successful legacy SUPERVISION_TASK_FINISH', async () => {
    // The legacy assignment-only finish is a SECOND production entry point, and
    // it committed then returned. Nothing carried the aggregate to its next
    // automatic step until the 60s watchdog ran, so a caller using this tool got
    // poll-paced progress while the intent path got event-paced progress.
    //
    // The dispatch is injected rather than resolved through the helper's lazy
    // `import('./send-tool.js')` for a specific reason: unobservable is
    // untestable. With the real import in place a mutant deleting this call
    // still passed every test, which is exactly how an unwired capability ships.
    const registry = getSupervisionTaskRegistry();
    const revision = 'legacy-finish-convergence-r1';
    expect(registry.createOrGet({
      projectName: 'alpha', taskId: 'legacy-finish-convergence',
      classification: 'independent_top_level',
      objective: 'legacy finish must converge', currentRevision: revision,
    })).toMatchObject({ ok: true });
    const workerIdentity = identity('deck_alpha_worker');
    const created = registry.createAssignment({
      taskId: 'legacy-finish-convergence', role: 'implementer',
      identity: workerIdentity, required: true,
      auditAttemptId: 'legacy-finish-attempt', auditRevision: revision,
    });
    if (!created.ok) throw new Error(created.reason);
    for (const status of ['implementing', 'validated', 'ready_for_audit'] as const) {
      expect(registry.updateAssignment({
        assignmentId: created.value.assignmentId, identity: workerIdentity,
        status, revision, auditAttemptId: 'legacy-finish-attempt', auditRevision: revision,
      }), status).toMatchObject({ ok: true });
    }

    const dispatchReadyAudit = vi.fn().mockResolvedValue({ status: 'dispatched' });
    const handlers = createMemoryMcpToolHandlers(
      { userId: 'u', sessionName: workerIdentity.sessionName, projectName: 'alpha', projectRoot: '/work/alpha' },
      {
        dispatchReadyAudit,
        sendDeps: { listSessions: () => [session('deck_alpha_brain'), session(workerIdentity.sessionName)] },
      },
    );

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FINISH]({
      assignmentId: created.value.assignmentId,
      revision,
      evidence: 'legacy finish',
    })).resolves.toMatchObject({ status: 'ok' });

    expect(dispatchReadyAudit, 'the legacy finish must drive convergence without a Brain call')
      .toHaveBeenCalledOnce();
    expect(dispatchReadyAudit).toHaveBeenCalledWith('legacy-finish-convergence');
  });

  it('never reports a legacy finish as failed because convergence threw', async () => {
    // The commit is authoritative. A convergence step that cannot run must not
    // turn a committed finish into an error the caller would retry.
    const registry = getSupervisionTaskRegistry();
    const revision = 'legacy-finish-throw-r1';
    expect(registry.createOrGet({
      projectName: 'alpha', taskId: 'legacy-finish-throw',
      classification: 'independent_top_level',
      objective: 'legacy finish stays authoritative', currentRevision: revision,
    })).toMatchObject({ ok: true });
    const workerIdentity = identity('deck_alpha_worker');
    const created = registry.createAssignment({
      taskId: 'legacy-finish-throw', role: 'implementer',
      identity: workerIdentity, required: true,
      auditAttemptId: 'legacy-throw-attempt', auditRevision: revision,
    });
    if (!created.ok) throw new Error(created.reason);
    for (const status of ['implementing', 'validated', 'ready_for_audit'] as const) {
      expect(registry.updateAssignment({
        assignmentId: created.value.assignmentId, identity: workerIdentity,
        status, revision, auditAttemptId: 'legacy-throw-attempt', auditRevision: revision,
      }), status).toMatchObject({ ok: true });
    }

    const dispatchReadyAudit = vi.fn().mockRejectedValue(new Error('transport down'));
    const handlers = createMemoryMcpToolHandlers(
      { userId: 'u', sessionName: workerIdentity.sessionName, projectName: 'alpha', projectRoot: '/work/alpha' },
      {
        dispatchReadyAudit,
        sendDeps: { listSessions: () => [session('deck_alpha_brain'), session(workerIdentity.sessionName)] },
      },
    );

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FINISH]({
      assignmentId: created.value.assignmentId, revision, evidence: 'legacy finish',
    })).resolves.toMatchObject({ status: 'ok' });
    expect(dispatchReadyAudit).toHaveBeenCalledOnce();
  });
});

describe('finalized-boundary forward control (tsk_5o7 guards)', () => {
  /**
   * A REAL finalized round, produced entirely through the production API: the
   * implementer/owner carry the exact PASS tuple that finalization consumed,
   * and `currentRevision` sits exactly on `finalization.revision`.
   *
   * `independent_top_level` matters: `integration_task` is exempt from the
   * forward-control boundary because it keeps its combined revision with the
   * integration handoff.
   */
  function finalizedRound(registry: SupervisionTaskRegistry, taskId: string) {
    const shape = prepareStructuredFinalizationShape(registry, taskId, {
      classification: 'independent_top_level',
    });
    expect(registry.finalizeIntegration({
      ...shape.finalization, identity: shape.owner.identity, now: 500,
    })).toMatchObject({ ok: true, value: { status: 'finalized' } });
    const task = registry.get(taskId)!;
    // The precondition the guards are anchored on. If either of these drifts,
    // every assertion below is testing something other than the boundary.
    expect(task.finalization?.revision, 'anchor: finalization covers currentRevision')
      .toBe(task.currentRevision);
    expect(
      registry.getAssignment(shape.implementer.assignmentId)?.status,
      'the consumed historical implementer must be NON-terminal, or guard 1 is masked',
    ).toBe('ready_for_integration');
    return shape;
  }

  /** Brain authorizes the next round's implementer on the finalized aggregate. */
  function authorizeSuccessor(
    registry: SupervisionTaskRegistry, taskId: string, suffix: string,
  ) {
    const successorIdentity = identity(`${taskId}-successor-${suffix}`);
    const created = registry.createAssignment({
      assignmentId: `${taskId}-successor-${suffix}`,
      taskId, role: 'implementer', required: true, identity: successorIdentity,
    });
    if (!created.ok) throw new Error(`authorize successor failed: ${created.reason}`);
    expect(registry.updateAssignment({
      assignmentId: created.value.assignmentId,
      identity: successorIdentity,
      status: 'implementing',
    }), 'the successor must be able to enter implementing').toMatchObject({ ok: true });
    return created.value;
  }

  it('lets the ONE newly authorized successor report its first revision past a finalized round', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = finalizedRound(registry, 'forward-control-exact');
    const successor = authorizeSuccessor(registry, shape.taskId, 'a');
    const finalizationBefore = registry.get(shape.taskId)!.finalization;
    const receiptsBefore = registry.listAuditReceipts(shape.taskId);
    const successorRevision = `${shape.taskId}-r2`;

    // Without the forward-control guard this is `old_revision`: the successor
    // has no auditRevision, so `bindsSuccessorRevision` cannot fire and the
    // plain revision-conflict check rejects the first revision it ever carries.
    // The round could be authorized but never reported -- a permanently wedged
    // aggregate.
    expect(registry.updateAssignment({
      assignmentId: successor.assignmentId,
      identity: successor.identity,
      revision: successorRevision,
    })).toMatchObject({ ok: true });

    const task = registry.get(shape.taskId)!;
    expect(task.currentRevision, 'the task must move onto the successor revision')
      .toBe(successorRevision);
    // Forward projection is not a rewrite: every closed byte survives.
    expect(task.finalization, 'finalization evidence must be carried through untouched')
      .toEqual(finalizationBefore);
    expect(task.commitSha).toBe('a'.repeat(40));
    expect(registry.listAuditReceipts(shape.taskId)).toEqual(receiptsBefore);
    registry.close();
    database.close();
  });

  it('refuses the forward advance once currentRevision has left the finalization anchor', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = finalizedRound(registry, 'forward-control-anchor');
    const successor = authorizeSuccessor(registry, shape.taskId, 'a');
    expect(registry.updateAssignment({
      assignmentId: successor.assignmentId,
      identity: successor.identity,
      revision: `${shape.taskId}-r2`,
    })).toMatchObject({ ok: true });

    // currentRevision is now r2 while finalization still covers r1. The
    // historical finalization record is NOT standing authority for an endless
    // r2 -> r3 -> ... chain, so the very next forward move must be refused.
    const before = registry.get(shape.taskId);
    const second = authorizeSuccessor(registry, shape.taskId, 'b');
    expect(registry.updateAssignment({
      assignmentId: second.assignmentId,
      identity: second.identity,
      revision: `${shape.taskId}-r3`,
    })).toMatchObject({ ok: false, reason: 'old_revision' });
    expect(registry.get(shape.taskId)!.currentRevision).toBe(before!.currentRevision);
    registry.close();
    database.close();
  });

  it('refuses two unconsumed active successors as ambiguous instead of picking one', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = finalizedRound(registry, 'forward-control-ambiguous');
    const first = authorizeSuccessor(registry, shape.taskId, 'a');
    authorizeSuccessor(registry, shape.taskId, 'b');
    const before = registry.get(shape.taskId);

    expect(registry.updateAssignment({
      assignmentId: first.assignmentId,
      identity: first.identity,
      revision: `${shape.taskId}-r2`,
    })).toMatchObject({ ok: false, reason: 'ambiguous_assignment' });
    expect(registry.get(shape.taskId)).toEqual(before);
    registry.close();
    database.close();
  });

  it('does not count the finalization-consumed historical implementer as a competing successor', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = finalizedRound(registry, 'forward-control-consumed');
    const successor = authorizeSuccessor(registry, shape.taskId, 'a');

    // The historical implementer is `ready_for_integration` (non-terminal) with
    // the exact attempt/revision/PASS tuple finalization consumed. Guard 1 is
    // what makes it history rather than a second live owner; without it this
    // exact call is `ambiguous_assignment` and no finalized task could ever
    // start another round.
    const historical = registry.getAssignment(shape.implementer.assignmentId)!;
    expect(historical).toMatchObject({
      required: true, role: 'implementer', status: 'ready_for_integration',
      verdict: 'PASS', crossVendorAuditPassed: true,
      auditAttemptId: shape.attemptId, auditRevision: shape.revision,
    });
    expect(registry.updateAssignment({
      assignmentId: successor.assignmentId,
      identity: successor.identity,
      revision: `${shape.taskId}-r2`,
    })).toMatchObject({ ok: true });
    registry.close();
    database.close();
  });

  it('repairs control on a finalized aggregate with exactly one unconsumed successor', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = finalizedRound(registry, 'control-repair-exact');
    const successor = authorizeSuccessor(registry, shape.taskId, 'a');
    const finalizationBefore = registry.get(shape.taskId)!.finalization;

    // Finalization closes the evidence it NAMES; it does not close the control
    // plane forever. Without the forward-control repair this is `receipt_closed`
    // purely because closed evidence exists, so a finalized aggregate could
    // never have its next round repaired by Brain at all.
    expect(registry.coordinateTaskAssignment({
      taskId: shape.taskId, assignmentId: successor.assignmentId,
      assignmentStatus: 'rework', leaseAction: 'preserve',
      idempotencyKey: 'control-repair-exact-successor',
      reason: 'repair the sole active successor on a finalized aggregate',
      now: 600,
    })).toMatchObject({ ok: true });
    expect(registry.getAssignment(successor.assignmentId)?.status).toBe('rework');
    expect(registry.get(shape.taskId)!.finalization, 'closed evidence must be untouched')
      .toEqual(finalizationBefore);
    registry.close();
    database.close();
  });

  it('refuses control repair once currentRevision has left the finalization anchor', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = finalizedRound(registry, 'control-repair-anchor');
    const successor = authorizeSuccessor(registry, shape.taskId, 'a');
    expect(registry.updateAssignment({
      assignmentId: successor.assignmentId, identity: successor.identity,
      revision: `${shape.taskId}-r2`,
    })).toMatchObject({ ok: true });
    const before = registry.get(shape.taskId);

    // The anchor is gone: finalization covers r1 while the task is on r2. The
    // historical record is not standing authority for repairing later rounds.
    expect(registry.coordinateTaskAssignment({
      taskId: shape.taskId, assignmentId: successor.assignmentId,
      assignmentStatus: 'rework', leaseAction: 'preserve',
      idempotencyKey: 'control-repair-drifted-anchor',
      reason: 'must not repair past the finalization anchor',
      now: 700,
    })).toMatchObject({ ok: false, reason: 'receipt_closed' });
    expect(registry.get(shape.taskId)).toEqual(before);
    registry.close();
    database.close();
  });

  it('refuses control repair when two unconsumed successors make the target ambiguous', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = finalizedRound(registry, 'control-repair-ambiguous');
    const first = authorizeSuccessor(registry, shape.taskId, 'a');
    authorizeSuccessor(registry, shape.taskId, 'b');
    const before = registry.get(shape.taskId);

    expect(registry.coordinateTaskAssignment({
      taskId: shape.taskId, assignmentId: first.assignmentId,
      assignmentStatus: 'rework', leaseAction: 'preserve',
      idempotencyKey: 'control-repair-ambiguous-successor',
      reason: 'ambiguity must be refused, not resolved by picking a row',
      now: 800,
    })).toMatchObject({ ok: false, reason: 'ambiguous_assignment' });
    expect(registry.get(shape.taskId)).toEqual(before);
    registry.close();
    database.close();
  });

  it('repairs the sole unconsumed successor revision on a finalized aggregate', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = finalizedRound(registry, 'revision-repair-exact');
    const successor = authorizeSuccessor(registry, shape.taskId, 'a');
    const finalizationBefore = registry.get(shape.taskId)!.finalization;

    // Every competitor here is finalization-consumed history: the R1 implementer
    // and integration owner both sit at `ready_for_integration` with the exact
    // consumed PASS tuple. Guard 1 is what makes the successor the SOLE active
    // implementer and keeps their PASS out of the live-conflict set.
    expect(registry.rebindTaskAssignmentRevision({
      taskId: shape.taskId, assignmentId: successor.assignmentId,
      fromRevision: shape.revision, toRevision: `${shape.taskId}-r2`,
      worktreeSnapshot: recoveryWorktreeSnapshot(shape.files),
      leaseAction: 'preserve', idempotencyKey: 'revision-repair-exact-successor',
      reason: 'bind the sole unconsumed successor past a finalized round',
      now: 600,
    })).toMatchObject({ ok: true });
    expect(registry.get(shape.taskId)!.finalization, 'closed evidence must be untouched')
      .toEqual(finalizationBefore);
    registry.close();
    database.close();
  });

  it('refuses revision repair once currentRevision has left the finalization anchor', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = finalizedRound(registry, 'revision-repair-anchor');
    const successor = authorizeSuccessor(registry, shape.taskId, 'a');
    expect(registry.updateAssignment({
      assignmentId: successor.assignmentId, identity: successor.identity,
      revision: `${shape.taskId}-r2`,
    })).toMatchObject({ ok: true });
    const before = registry.get(shape.taskId);

    // finalization covers r1, the task is on r2: the historical record is spent.
    expect(registry.rebindTaskAssignmentRevision({
      taskId: shape.taskId, assignmentId: successor.assignmentId,
      fromRevision: `${shape.taskId}-r2`, toRevision: `${shape.taskId}-r3`,
      worktreeSnapshot: recoveryWorktreeSnapshot(shape.files),
      leaseAction: 'preserve', idempotencyKey: 'revision-repair-drifted-anchor',
      reason: 'must not repair past the finalization anchor',
      now: 700,
    })).toMatchObject({ ok: false, reason: 'old_revision' });
    expect(registry.get(shape.taskId)).toEqual(before);
    registry.close();
    database.close();
  });

  it('keeps a non-required non-pointer assignment from advancing past finalization', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = finalizedRound(registry, 'forward-control-optional');
    const optionalIdentity = identity(`${shape.taskId}-optional`);
    const optional = registry.createAssignment({
      assignmentId: `${shape.taskId}-optional`, taskId: shape.taskId,
      role: 'implementer', required: false, identity: optionalIdentity,
    });
    if (!optional.ok) throw new Error(optional.reason);
    expect(registry.updateAssignment({
      assignmentId: optional.value.assignmentId, identity: optionalIdentity, status: 'implementing',
    })).toMatchObject({ ok: true });
    const before = registry.get(shape.taskId);

    expect(registry.updateAssignment({
      assignmentId: optional.value.assignmentId,
      identity: optionalIdentity,
      revision: `${shape.taskId}-r2`,
    })).toMatchObject({ ok: false, reason: 'owner_mismatch' });
    expect(registry.get(shape.taskId)).toEqual(before);
    registry.close();
    database.close();
  });
});

describe('cancelled implementation evidence adoption', () => {
  const frozenSnapshot = (files = ['src/late.ts']) => ({
    worktreePath: '/tmp/authoritative-cancelled-worktree/repo',
    headSha: 'c'.repeat(40),
    files: files.map((path, index) => ({ path, sha256: String(index + 1).repeat(64) })),
    stagedPaths: [],
    conflictedPaths: [],
    untrackedPaths: [],
  });

  function cancelledShape(registry: SupervisionTaskRegistry, suffix: string) {
    const taskId = `late-cancel-${suffix}`;
    const owner = identity(`deck_${suffix}_old`);
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', objective: 'preserve a late frozen implementation',
    })).toMatchObject({ ok: true });
    const old = registry.createAssignment({
      taskId, assignmentId: `${taskId}-old`, role: 'implementer', identity: owner,
      scopeFiles: ['src/late.ts'], required: true,
    });
    if (!old.ok) throw new Error(old.reason);
    expect(registry.applyTaskIntent({
      taskId, assignmentId: old.value.assignmentId, intent: 'cancel', toStatus: 'cancelled', now: 20,
    })).toMatchObject({ ok: true });
    return { taskId, owner, old: old.value };
  }

  it('deduplicates an exact late completion replay without appending a second receipt event', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = cancelledShape(registry, 'replay');
    const input = {
      taskId: shape.taskId, assignmentId: shape.old.assignmentId, identity: shape.owner,
      revision: 'late-replay-r1', worktreeSnapshot: frozenSnapshot(), now: 30,
    };
    const first = registry.recordCancelledCompletionEvidence(input);
    expect(first).toMatchObject({ ok: true, value: { status: 'pending' } });
    const eventCount = registry.listEvents(shape.taskId).length;
    expect(registry.recordCancelledCompletionEvidence({ ...input, now: 40 }))
      .toMatchObject({ ok: true, replay: true, value: { evidenceId: first.ok ? first.value.evidenceId : '' } });
    expect(registry.listCompletionEvidence(shape.taskId)).toHaveLength(1);
    expect(registry.listEvents(shape.taskId)).toHaveLength(eventCount);
    registry.close();
    database.close();
  });

  it('rejects the cancelled-only evidence lane while the original worker is still live', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const taskId = 'late-cancel-live-lane';
    const owner = identity('deck_live_lane_worker');
    expect(registry.createOrGet({ taskId, projectName: 'alpha', objective: 'live worker uses ordinary finish' }))
      .toMatchObject({ ok: true });
    const worker = registry.createAssignment({ taskId, role: 'implementer', identity: owner, required: true });
    if (!worker.ok) throw new Error(worker.reason);
    expect(registry.recordCancelledCompletionEvidence({
      taskId, assignmentId: worker.value.assignmentId, identity: owner,
      revision: 'live-r1', worktreeSnapshot: frozenSnapshot(), now: 30,
    })).toEqual({ ok: false, reason: 'invalid_transition' });
    expect(registry.listCompletionEvidence(taskId)).toEqual([]);
    registry.close();
    database.close();
  });

  it.each([
    ['empty manifest', { files: [] }],
    ['staged bytes', { stagedPaths: ['src/late.ts'] }],
    ['conflicted bytes', { conflictedPaths: ['src/late.ts'] }],
  ])('rejects late completion evidence with %s', (_label, override) => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = cancelledShape(registry, `invalid-${_label.replaceAll(' ', '-')}`);
    expect(registry.recordCancelledCompletionEvidence({
      taskId: shape.taskId, assignmentId: shape.old.assignmentId, identity: shape.owner,
      revision: 'invalid-r1', worktreeSnapshot: { ...frozenSnapshot(), ...override }, now: 30,
    })).toEqual({ ok: false, reason: 'manifest_mismatch' });
    expect(registry.listCompletionEvidence(shape.taskId)).toEqual([]);
    registry.close();
    database.close();
  });

  it('records late cancelled completion through the production task_finish ingress without reviving the worker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'supervision-late-finish-wire-'));
    const priorRoot = process.env.IMCODES_WORKTREES_ROOT;
    const priorNamespace = process.env.IMCODES_PROJECT_WORKTREE_NAMESPACE;
    process.env.IMCODES_WORKTREES_ROOT = root;
    process.env.IMCODES_PROJECT_WORKTREE_NAMESPACE = 'imcodes';
    try {
      const registry = getSupervisionTaskRegistry();
      const taskId = 'late-cancel-production-finish';
      const owner = identity('deck_late_finish_worker');
      expect(registry.createOrGet({
        taskId, projectName: 'alpha', classification: 'integration_task',
        objective: 'preserve task_finish after cancellation',
      })).toMatchObject({ ok: true });
      const assignment = registry.createAssignment({
        taskId, assignmentId: 'asg_late_finish', role: 'implementer', identity: owner, required: true,
      });
      if (!assignment.ok) throw new Error(assignment.reason);
      const repo = resolveSupervisionAssignmentWorktree({
        sessionName: owner.sessionName, assignmentId: assignment.value.assignmentId,
      });
      mkdirSync(repo, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: repo });
      writeFileSync(join(repo, 'late.ts'), 'base\n');
      execFileSync('git', ['add', 'late.ts'], { cwd: repo });
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], { cwd: repo });
      writeFileSync(join(repo, 'late.ts'), 'completed after cancellation\n');
      expect(registry.applyTaskIntent({
        taskId, assignmentId: assignment.value.assignmentId,
        intent: 'cancel', toStatus: 'cancelled', now: 20,
      })).toMatchObject({ ok: true });
      const handlers = createMemoryMcpToolHandlers({
        userId: 'u', sessionName: owner.sessionName,
        projectName: 'alpha', projectRoot: repo,
      }, { sendDeps: { listSessions: () => [session(owner.sessionName)] } });
      expect(await handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FINISH]({
        assignmentId: assignment.value.assignmentId,
        revision: 'late-cancel-r1', evidence: 'implementation completed after cancel',
      })).toMatchObject({ status: 'ok', item: { status: 'pending', revision: 'late-cancel-r1' } });
      expect(registry.getAssignment(assignment.value.assignmentId)).toMatchObject({
        status: 'cancelled', leaseId: '',
      });
      expect((registry.get(taskId) as any).completionEvidence).toEqual([
        expect.objectContaining({
          sourceAssignmentId: assignment.value.assignmentId,
          status: 'pending', revision: 'late-cancel-r1',
          files: [expect.objectContaining({ path: 'late.ts' })],
        }),
      ]);
    } finally {
      if (priorRoot === undefined) delete process.env.IMCODES_WORKTREES_ROOT;
      else process.env.IMCODES_WORKTREES_ROOT = priorRoot;
      if (priorNamespace === undefined) delete process.env.IMCODES_PROJECT_WORKTREE_NAMESPACE;
      else process.env.IMCODES_PROJECT_WORKTREE_NAMESPACE = priorNamespace;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps late file evidence immutable on the cancelled owner and auto-adopts it only into an untouched successor', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = cancelledShape(registry, 'adopt');
    const cancelledBefore = registry.getAssignment(shape.old.assignmentId)!;

    expect(registry.recordFileEvent({
      assignmentId: shape.old.assignmentId, identity: shape.owner,
      path: 'src/late-unscoped.ts', operation: 'modified', afterHash: '2'.repeat(64),
      idempotencyKey: 'late-file', now: 30,
    })).toMatchObject({ ok: true });
    expect(registry.getAssignment(shape.old.assignmentId)).toEqual(cancelledBefore);

    const recorded = (registry as any).recordCancelledCompletionEvidence({
      taskId: shape.taskId,
      assignmentId: shape.old.assignmentId,
      identity: shape.owner,
      revision: 'late-r1',
      worktreeSnapshot: frozenSnapshot(['src/late.ts', 'src/late-unscoped.ts']),
      evidence: 'frozen after cancellation',
      now: 40,
    });
    expect(recorded).toMatchObject({ ok: true, value: { status: 'pending' } });
    const evidenceId = recorded.value.evidenceId as string;

    const successorIdentity = identity('deck_adopt_successor');
    const successor = registry.createAssignment({
      taskId: shape.taskId, assignmentId: `${shape.taskId}-successor`,
      role: 'implementer', identity: successorIdentity, required: true, now: 50,
    });
    if (!successor.ok) throw new Error(successor.reason);

    const actions = registry.convergeLifecycle(60, {
      inspectAssignmentWorktree: (assignment: { assignmentId: string }) => assignment.assignmentId === successor.value.assignmentId
        ? frozenSnapshot([]) : undefined,
    } as any);
    expect(actions).toContainEqual({
      taskId: shape.taskId,
      assignmentId: successor.value.assignmentId,
      action: 'adopt_cancelled_completion_evidence',
    });
    expect((registry.get(shape.taskId) as any).completionEvidence).toEqual([
      expect.objectContaining({
        evidenceId, sourceAssignmentId: shape.old.assignmentId,
        adoptedByAssignmentId: successor.value.assignmentId, status: 'adopted', revision: 'late-r1',
      }),
    ]);
    expect(registry.getAssignment(shape.old.assignmentId)).toMatchObject({ status: 'cancelled', leaseId: '' });
    expect(registry.getAssignment(successor.value.assignmentId)).toMatchObject({
      status: 'delegated', blocker: expect.stringContaining(evidenceId),
      scopeFiles: ['src/late-unscoped.ts', 'src/late.ts'],
    });

    const events = registry.listEvents(shape.taskId).length;
    expect(registry.convergeLifecycle(70, {
      inspectAssignmentWorktree: () => frozenSnapshot([]),
    } as any)).not.toContainEqual(expect.objectContaining({ action: 'adopt_cancelled_completion_evidence' }));
    expect(registry.listEvents(shape.taskId)).toHaveLength(events);
    registry.close();
    database.close();
  });

  it('refuses auto-adoption when the successor has a file event even if its inspected manifest is empty', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = cancelledShape(registry, 'successor-file-event');
    const recorded = registry.recordCancelledCompletionEvidence({
      taskId: shape.taskId, assignmentId: shape.old.assignmentId, identity: shape.owner,
      revision: 'late-r1', worktreeSnapshot: frozenSnapshot(), now: 30,
    });
    if (!recorded.ok) throw new Error(recorded.reason);
    const successorIdentity = identity('deck_successor_file_event_worker');
    const successor = registry.createAssignment({
      taskId: shape.taskId, role: 'implementer', identity: successorIdentity, required: true, now: 40,
    });
    if (!successor.ok) throw new Error(successor.reason);
    expect(registry.recordFileEvent({
      assignmentId: successor.value.assignmentId, identity: successorIdentity,
      path: 'src/successor.ts', operation: 'modified', afterHash: '9'.repeat(64),
      idempotencyKey: 'successor-file-event', now: 45,
    })).toMatchObject({ ok: true });

    expect(registry.convergeLifecycle(50, {
      inspectAssignmentWorktree: () => frozenSnapshot([]),
    })).toContainEqual(expect.objectContaining({ action: 'request_cancelled_completion_evidence_decision' }));
    expect(registry.listCompletionEvidence(shape.taskId)).toEqual([
      expect.objectContaining({ evidenceId: recorded.value.evidenceId, status: 'pending' }),
    ]);
    expect(registry.getAssignment(successor.value.assignmentId)?.blocker ?? '')
      .not.toContain('"actionRequired":"adopt"');
    registry.close();
    database.close();
  });

  it('asks Brain exactly once when the replacement already has conflicting bytes', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = cancelledShape(registry, 'conflict');
    const recorded = (registry as any).recordCancelledCompletionEvidence({
      taskId: shape.taskId, assignmentId: shape.old.assignmentId, identity: shape.owner,
      revision: 'late-r1', worktreeSnapshot: frozenSnapshot(), now: 40,
    });
    expect(recorded.ok).toBe(true);
    const successor = registry.createAssignment({
      taskId: shape.taskId, assignmentId: `${shape.taskId}-successor`, role: 'implementer',
      identity: identity('deck_conflict_successor'), required: true, now: 50,
    });
    if (!successor.ok) throw new Error(successor.reason);
    rewritePersistedTask(database, {
      ...registry.get(shape.taskId)!, blocker: 'existing-unrelated-blocker', updatedAt: 55,
    });
    const inspect = () => ({
      ...frozenSnapshot(), files: [{ path: 'src/late.ts', sha256: '9'.repeat(64) }],
    });

    const first = registry.convergeLifecycle(60, { inspectAssignmentWorktree: inspect } as any);
    expect(first).toContainEqual(expect.objectContaining({
      taskId: shape.taskId, assignmentId: successor.value.assignmentId,
      action: 'request_cancelled_completion_evidence_decision',
    }));
    expect(registry.get(shape.taskId)).toMatchObject({
      blocker: expect.stringMatching(/adopt_or_discard.*existing-unrelated-blocker/),
    });
    const eventCount = registry.listEvents(shape.taskId).length;
    expect(registry.convergeLifecycle(70, { inspectAssignmentWorktree: inspect } as any))
      .not.toContainEqual(expect.objectContaining({ action: 'request_cancelled_completion_evidence_decision' }));
    expect(registry.listEvents(shape.taskId)).toHaveLength(eventCount);
    expect(registry.resolveCancelledCompletionEvidence({
      taskId: shape.taskId,
      evidenceId: recorded.value.evidenceId,
      targetAssignmentId: successor.value.assignmentId,
      decision: 'discard',
      reason: 'Brain selected the replacement bytes',
      now: 80,
    })).toMatchObject({ ok: true, value: { status: 'discarded' } });
    expect((registry.get(shape.taskId) as any).completionEvidence).toEqual([
      expect.objectContaining({ status: 'discarded', adoptedByAssignmentId: successor.value.assignmentId }),
    ]);
    expect(registry.get(shape.taskId)?.blocker).toBe('existing-unrelated-blocker');
    registry.close();
    database.close();
  });

  it('does not invent completion evidence for cancel-before-first-file, including after restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'supervision-cancel-before-file-'));
    const dbPath = join(dir, 'registry.sqlite');
    let registry = new SupervisionTaskRegistry({ dbPath });
    const shape = cancelledShape(registry, 'empty');
    expect((registry.get(shape.taskId) as any).completionEvidence ?? []).toEqual([]);
    registry.close();
    registry = new SupervisionTaskRegistry({ dbPath });
    expect((registry.get(shape.taskId) as any).completionEvidence ?? []).toEqual([]);
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['tsk_4d0', 'ready_for_integration', 'implementing', 'implementer', '0d0a9c5087b4b39fe2bf4aec44aba42e0908323f'],
    ['tsk_5o7', 'implementing', 'implementing', 'implementer', '740bff00b6d490a792afc971c697bc1db5b84b5d'],
    ['tsk_79u', 'ready_for_integration', 'implementing', 'integration_owner', '4a6b85dd50870edb2223ddbcbd6c8f7a9df3b534'],
    ['tsk_7l9', 'ready_for_integration', 'ready_for_integration', 'integration_owner', 'a3c610eef5997990a9bf608aa0b0d7401dc3a79b'],
  ] as const)(
    'records already-present PASS bytes for %s from its live projection without duplicate Git',
    (taskId, taskStatus, assignmentStatus, role, commitSha) => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const revision = 'r14-pass';
    const workerIdentity = identity('deck_already_present_worker');
    const auditorIdentity = identity('deck_already_present_auditor', 'claude-code-sdk');
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'independent_top_level',
      objective: 'converge shipped bytes', currentRevision: revision,
    })).toMatchObject({ ok: true });
    const worker = registry.createAssignment({
      taskId, assignmentId: `${taskId}-worker`, role, identity: workerIdentity,
      required: true,
    });
    if (!worker.ok) throw new Error(worker.reason);
    rewritePersistedTask(database, {
      ...registry.get(taskId)!, status: 'ready_for_audit', currentRevision: revision, updatedAt: 30,
    });
    const auditor = registry.createAssignment({
      taskId, assignmentId: `${taskId}-auditor`, role: 'auditor', identity: auditorIdentity,
      required: true, auditRevision: revision,
    });
    if (!auditor.ok) throw new Error(auditor.reason);
    rewritePersistedAssignment(database, {
      ...worker.value, status: assignmentStatus, auditRevision: revision,
      auditAttemptId: 'r14-attempt', verdict: 'PASS', crossVendorAuditPassed: true, updatedAt: 40,
    });
    rewritePersistedAssignment(database, {
      ...auditor.value, status: 'finalized', leaseId: '', auditRevision: revision,
      auditAttemptId: 'r14-attempt', verdict: 'PASS', updatedAt: 45,
    });
    seedFinalAuditReceipt(database, {
      receiptId: `${taskId}-pass-receipt`, taskId, assignmentId: auditor.value.assignmentId,
      attemptId: 'r14-attempt', revision, verdict: 'PASS', senderIdentity: auditorIdentity, createdAt: 46,
    });
    rewritePersistedTask(database, {
      ...registry.get(taskId)!, status: taskStatus, currentRevision: revision,
      ...(role === 'integration_owner' ? { integrationOwnerAssignmentId: worker.value.assignmentId } : {}),
      updatedAt: 50,
    });
    const inspection = {
      ...frozenSnapshot(['src/late.ts']), matchingRemoteCommitSha: commitSha,
      matchingRemoteRef: 'refs/remotes/origin/dev',
    };

    expect(registry.convergeLifecycle(60, { inspectAssignmentWorktree: () => inspection } as any))
      .toContainEqual({ taskId, assignmentId: worker.value.assignmentId, action: 'record_already_present_delivery' });
    expect(registry.get(taskId)).toMatchObject({
      status: 'ready_for_integration', commitSha,
      pushRemoteRef: 'refs/remotes/origin/dev',
      blocker: expect.stringContaining('structured_finalization_receipt'),
    });
    expect(registry.getAssignment(worker.value.assignmentId)).toMatchObject({
      status: 'ready_for_integration', leaseId: '', auditRevision: revision,
      auditAttemptId: 'r14-attempt', verdict: 'PASS', crossVendorAuditPassed: true,
    });
    expect(registry.get(taskId)).not.toHaveProperty('finalization');
    const events = registry.listEvents(taskId).length;
    expect(registry.convergeLifecycle(70, { inspectAssignmentWorktree: () => inspection } as any))
      .not.toContainEqual(expect.objectContaining({ action: 'record_already_present_delivery' }));
    expect(registry.listEvents(taskId)).toHaveLength(events);
    registry.close();
    database.close();
  });

  it('does not churn a zero-change ready_for_audit projection', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const taskId = 'zero-change-ready';
    expect(registry.createOrGet({ taskId, projectName: 'alpha', objective: 'zero change', currentRevision: 'zero-r1' }))
      .toMatchObject({ ok: true });
    const worker = registry.createAssignment({
      taskId, role: 'implementer', identity: identity('deck_zero_worker'), required: true,
    });
    if (!worker.ok) throw new Error(worker.reason);
    rewritePersistedAssignment(database, {
      ...worker.value, status: 'ready_for_audit', auditRevision: 'zero-r1',
      validationState: 'passed', updatedAt: 20,
    });
    rewritePersistedTask(database, {
      ...registry.get(taskId)!, status: 'ready_for_audit', currentRevision: 'zero-r1', updatedAt: 20,
    });
    const before = registry.listEvents(taskId).length;
    expect(registry.convergeLifecycle(30)).toEqual([]);
    expect(registry.convergeLifecycle(40)).toEqual([]);
    expect(registry.listEvents(taskId)).toHaveLength(before);
    registry.close();
    database.close();
  });

  it('binds tsk_7ax zero-byte validation to the authoritative base Git object and atomically opens audit', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const taskId = 'tsk_7ax';
    const reviewedBase = '5f3d543ace7e73b95e58849f890299cef93bd3c5';
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'integration_task', objective: 'read-only review',
    }))
      .toMatchObject({ ok: true });
    const worker = registry.createAssignment({
      taskId, assignmentId: 'asg_7b0', role: 'implementer',
      identity: identity('deck_zero_readonly_worker'), required: true,
      scopeFiles: ['src/reviewed.ts'],
    });
    if (!worker.ok) throw new Error(worker.reason);
    expect(registry.applyTaskIntent({
      taskId, assignmentId: worker.value.assignmentId, intent: 'start', toStatus: 'implementing',
    })).toMatchObject({ ok: true });
    expect(registry.applyTaskIntent({
      taskId, assignmentId: worker.value.assignmentId, intent: 'record_validation',
      validationState: 'passed', toStatus: 'validated',
    })).toMatchObject({ ok: true });

    expect(registry.convergeValidatedAssignment(worker.value.assignmentId, 50, () => ({
      worktreePath: '/tmp/tsk_7ax/asg_7b0/repo', headSha: reviewedBase,
      files: [], stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
    }))).toEqual([
      { taskId, assignmentId: worker.value.assignmentId, action: 'bind_zero_byte_base_revision' },
      { taskId, assignmentId: worker.value.assignmentId, action: 'project_validated_handoff' },
    ]);
    expect(registry.get(taskId)).toMatchObject({
      status: 'ready_for_audit', baseRevision: reviewedBase, currentRevision: reviewedBase,
    });
    expect(registry.getAssignment(worker.value.assignmentId)).toMatchObject({
      status: 'ready_for_audit', auditRevision: reviewedBase, leaseId: '', validationState: 'passed',
    });
    // Replay is stable; neither a synthetic revision nor a second event appears.
    const eventCount = registry.listEvents(taskId).length;
    expect(registry.convergeValidatedAssignment(worker.value.assignmentId, 60, () => ({
      worktreePath: '/tmp/tsk_7ax/asg_7b0/repo', headSha: reviewedBase,
      files: [], stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
    }))).toEqual([]);
    expect(registry.listEvents(taskId)).toHaveLength(eventCount);
    registry.close();
    database.close();
  });

  it('preserves the zero-byte base bind through the periodic restart backstop instead of overwriting it from a stale snapshot', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const taskId = 'tsk_7ax-periodic-restart';
    const reviewedBase = '5f3d543ace7e73b95e58849f890299cef93bd3c5';
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'integration_task', objective: 'restart read-only review',
    })).toMatchObject({ ok: true });
    const worker = registry.createAssignment({
      taskId, role: 'implementer', identity: identity('deck_zero_restart_worker'), required: true,
    });
    if (!worker.ok) throw new Error(worker.reason);
    expect(registry.applyTaskIntent({
      taskId, assignmentId: worker.value.assignmentId, intent: 'start', toStatus: 'implementing',
    })).toMatchObject({ ok: true });
    expect(registry.applyTaskIntent({
      taskId, assignmentId: worker.value.assignmentId, intent: 'record_validation',
      validationState: 'passed', toStatus: 'validated',
    })).toMatchObject({ ok: true });
    const inspect = () => ({
      worktreePath: '/tmp/tsk_7ax/restart/repo', headSha: reviewedBase,
      files: [], stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
    });

    expect(registry.convergeLifecycle(50, { inspectAssignmentWorktree: inspect }))
      .toEqual(expect.arrayContaining([
        { taskId, assignmentId: worker.value.assignmentId, action: 'bind_zero_byte_base_revision' },
        { taskId, assignmentId: worker.value.assignmentId, action: 'project_validated_handoff' },
      ]));
    expect(registry.get(taskId)).toMatchObject({
      status: 'ready_for_audit', baseRevision: reviewedBase, currentRevision: reviewedBase,
    });
    expect(registry.getAssignment(worker.value.assignmentId)).toMatchObject({
      status: 'ready_for_audit', auditRevision: reviewedBase, validationState: 'passed', leaseId: '',
    });
    const eventCount = registry.listEvents(taskId).length;
    expect(registry.convergeLifecycle(60, { inspectAssignmentWorktree: inspect })).toEqual([]);
    expect(registry.listEvents(taskId)).toHaveLength(eventCount);
    registry.close();
    database.close();
  });

  it('refuses to bind a missing revision when the validated worktree contains bytes', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const taskId = 'zero-byte-revision-negative';
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'integration_task', objective: 'do not invent revision',
    }))
      .toMatchObject({ ok: true });
    const worker = registry.createAssignment({
      taskId, role: 'implementer', identity: identity('deck_nonzero_worker'), required: true,
    });
    if (!worker.ok) throw new Error(worker.reason);
    for (const [intent, toStatus, validationState] of [
      ['start', 'implementing', undefined], ['record_validation', 'validated', 'passed'],
    ] as const) {
      expect(registry.applyTaskIntent({
        taskId, assignmentId: worker.value.assignmentId, intent, toStatus,
        ...(validationState ? { validationState } : {}),
      })).toMatchObject({ ok: true });
    }
    expect(registry.convergeValidatedAssignment(worker.value.assignmentId, 50, () => ({
      worktreePath: '/tmp/nonzero/repo', headSha: '5'.repeat(40),
      files: [{ path: 'src/change.ts', sha256: 'a'.repeat(64) }],
      stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
    }))).toEqual([]);
    expect(registry.get(taskId)).toMatchObject({ status: 'validated' });
    expect(registry.get(taskId)?.currentRevision).toBeUndefined();
    expect(registry.getAssignment(worker.value.assignmentId)?.auditRevision).toBeUndefined();
    registry.close();
    database.close();
  });

  it('applies a mixed orphan batch: valid backfills land, quarantine satisfies the project guard, and progress is recorded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'supervision-hk-orphan-'));
    const dbPath = join(dir, 'registry.sqlite');
    const registry = new SupervisionTaskRegistry({ dbPath });
    const db = new DatabaseSync(dbPath);

    // Orphans predate MIGRATION_3's project guard, which is why they exist at
    // all. The guard refuses to CREATE one, so the fixture reproduces the
    // legacy shape by lifting the trigger exactly as history did.
    const makeOrphan = (taskId: string) => {
      db.exec('DROP TRIGGER IF EXISTS supervision_tasks_project_guard_update');
      db.prepare('UPDATE supervision_tasks SET project_name = NULL WHERE task_id = ?').run(taskId);
      db.exec(`CREATE TRIGGER supervision_tasks_project_guard_update
               BEFORE UPDATE ON supervision_tasks
               FOR EACH ROW WHEN NEW.project_name IS NULL OR trim(NEW.project_name) = ''
               BEGIN SELECT RAISE(ABORT, 'supervision task project scope is required'); END;`);
    };
    const mkTask = (taskId: string, topLevelTaskId: string) => {
      const created = registry.createOrGet({
        taskId, topLevelTaskId, projectName: 'alpha',
        classification: topLevelTaskId === taskId ? 'independent_top_level' : 'integration_slice',
        objective: `objective ${taskId}`, now: 1_000,
      });
      expect(created).toMatchObject({ ok: true });
    };

    mkTask('hk-parent', 'hk-parent');           // keeps its scope; provides lineage
    mkTask('hk-backfill', 'hk-parent');         // orphan WITH lineage -> backfill
    mkTask('hk-quarantine', 'hk-quarantine');   // orphan WITHOUT lineage -> quarantine
    mkTask('hk-live', 'hk-live');               // orphan with a live assignment -> skipped
    const live = registry.createAssignment({
      taskId: 'hk-live', assignmentId: 'hk-live-asg', role: 'implementer',
      identity: identity('deck_hk_live'), now: 2_000,
    });
    if (!live.ok) throw new Error(live.reason);

    makeOrphan('hk-backfill');
    makeOrphan('hk-quarantine');
    makeOrphan('hk-live');

    const now = 5_000;
    // Today this throws 'supervision task project scope is required' from the
    // SQLite guard, discarding the backfill that had already succeeded.
    const applied = registry.reconcileHousekeeping({
      projectName: 'alpha', mode: 'apply', cursor: 'orphan:', limit: 25, now,
    });

    expect(applied.failedActions, 'no planned action may be unexecutable').toEqual([]);

    const scopeOf = (taskId: string) => (db
      .prepare('SELECT project_name AS projectName, status FROM supervision_tasks WHERE task_id = ?')
      .get(taskId) as { projectName: string | null; status: string });

    expect(
      scopeOf('hk-backfill'),
      'a backfill with authoritative lineage must land even though the batch also held a quarantine',
    ).toMatchObject({ projectName: 'alpha' });

    const quarantined = scopeOf('hk-quarantine');
    expect(
      quarantined.projectName,
      'quarantine must name the reserved scope so it satisfies the project guard',
    ).toBe(SUPERVISION_ORPHAN_QUARANTINE_SCOPE);
    expect(quarantined.status).toBe('blocked');
    expect(isReservedSupervisionProjectScope(quarantined.projectName)).toBe(true);
    expect(
      isReservedSupervisionProjectScope('alpha'),
      'the reserved scope must not be addressable as a caller project',
    ).toBe(false);

    expect(
      scopeOf('hk-live').projectName,
      'an orphan still holding a live assignment must not be quarantined',
    ).toBeNull();

    // Behavioural proof that the reserved scope does not route as a project:
    // a later pass scoped to the caller's real project no longer sees the
    // quarantined task at all.
    const rescan = registry.reconcileHousekeeping({
      projectName: 'alpha', mode: 'dryRun', cursor: 'orphan:', limit: 25, now: now + 1,
    });
    expect(
      [...rescan.actions.map((a) => a.taskId), ...rescan.orphanDiagnostics.map((d) => d.taskId)],
      'a quarantined task must leave the calling project surface entirely',
    ).not.toContain('hk-quarantine');

    const due = db.prepare(
      'SELECT next_due_at AS nextDueAt FROM supervision_housekeeping_state WHERE project_name = ?',
    ).get('alpha') as { nextDueAt: number } | undefined;
    expect(
      due?.nextDueAt ?? 0,
      'a pass that made progress must advance next_due_at or the scheduler re-picks it forever',
    ).toBeGreaterThan(now);

    db.close();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lets one unexecutable action fail alone: the rest still commit and the pass still records progress', () => {
    const dir = mkdtempSync(join(tmpdir(), 'supervision-hk-isolation-'));
    const dbPath = join(dir, 'registry.sqlite');
    const registry = new SupervisionTaskRegistry({ dbPath });
    const db = new DatabaseSync(dbPath);

    const makeOrphan = (taskId: string) => {
      db.exec('DROP TRIGGER IF EXISTS supervision_tasks_project_guard_update');
      db.prepare('UPDATE supervision_tasks SET project_name = NULL WHERE task_id = ?').run(taskId);
      db.exec(`CREATE TRIGGER supervision_tasks_project_guard_update
               BEFORE UPDATE ON supervision_tasks
               FOR EACH ROW WHEN NEW.project_name IS NULL OR trim(NEW.project_name) = ''
               BEGIN SELECT RAISE(ABORT, 'supervision task project scope is required'); END;`);
    };
    const mkTask = (taskId: string, topLevelTaskId: string) => {
      expect(registry.createOrGet({
        taskId, topLevelTaskId, projectName: 'gamma',
        classification: topLevelTaskId === taskId ? 'independent_top_level' : 'integration_slice',
        objective: `objective ${taskId}`, now: 1_000,
      })).toMatchObject({ ok: true });
    };

    mkTask('iso-parent', 'iso-parent');
    mkTask('iso-good', 'iso-parent');     // orphan with lineage -> backfill, must land
    mkTask('iso-poison', 'iso-poison');   // orphan without lineage -> quarantine, forced to fail
    makeOrphan('iso-good');
    makeOrphan('iso-poison');

    // A failure whose cause is INDEPENDENT of anything this change touches, so
    // the test proves the isolation contract itself rather than the quarantine
    // fix a second time. Any per-row write failure must behave this way.
    db.exec(`CREATE TRIGGER iso_poison_guard
             BEFORE UPDATE ON supervision_tasks
             FOR EACH ROW WHEN NEW.task_id = 'iso-poison'
             BEGIN SELECT RAISE(ABORT, 'poisoned row'); END;`);

    const now = 7_000;
    const applied = registry.reconcileHousekeeping({
      projectName: 'gamma', mode: 'apply', cursor: 'orphan:', limit: 25, now,
    });

    expect(
      applied.failedActions.map((failure) => failure.taskId),
      'the poisoned action must be reported, not thrown away and not thrown',
    ).toEqual(['iso-poison']);

    const good = db.prepare('SELECT project_name AS projectName FROM supervision_tasks WHERE task_id = ?')
      .get('iso-good') as { projectName: string | null };
    expect(
      good.projectName,
      'a valid action must not be rolled back by an unrelated failure in the same batch',
    ).toBe('gamma');

    const due = db.prepare(
      'SELECT next_due_at AS nextDueAt FROM supervision_housekeeping_state WHERE project_name = ?',
    ).get('gamma') as { nextDueAt: number } | undefined;
    expect(
      due?.nextDueAt ?? 0,
      'a failed action must not freeze the schedule',
    ).toBeGreaterThan(now);

    db.close();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports housekeeping authorization and feasibility as separate facts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'supervision-hk-feasible-'));
    const dbPath = join(dir, 'registry.sqlite');
    const registry = new SupervisionTaskRegistry({ dbPath });
    expect(registry.createOrGet({
      taskId: 'hk-feasible', topLevelTaskId: 'hk-feasible', projectName: 'beta',
      classification: 'independent_top_level', objective: 'feasibility', now: 1_000,
    })).toMatchObject({ ok: true });

    const dry = registry.reconcileHousekeeping({ projectName: 'beta', mode: 'dryRun', limit: 25, now: 2_000 });
    // Nothing has authorized this project to apply yet...
    expect(dry.applyAuthorized, 'authorization is about the caller').toBe(false);
    // ...but the plan it produced is executable, which is a different question.
    expect(dry.applyFeasible, 'feasibility is about the plan').toBe(true);

    registry.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
