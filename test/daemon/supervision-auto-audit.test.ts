import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENT_DELEGATION_PURPOSES } from '../../shared/agent-delegation.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import { normalizeSessionSupervisionSnapshot } from '../../shared/supervision-config.js';
import { buildSupervisionExecutionCapabilityId } from '../../shared/supervision-execution-pool.js';
import type { SendMessageId } from '../../shared/send-message-id.js';
import type { SessionRecord } from '../../src/store/session-store.js';
import {
  clearSendIdempotencyCacheForTests,
  dispatchReadyAudit,
  dispatchReadyIntegration,
  dispatchReadyAuditSweep,
  runSupervisionConvergenceTick,
  legacyExplicitAuditRecoveryAttempt,
  listSendTargets,
  __resetSupervisionConvergenceTickForTests,
  dispatchSendMessage,
  type SendMessageInput,
  type SendRuntimeCaller,
} from '../../src/daemon/send-tool.js';
import {
  SupervisionTaskRegistry,
  getSupervisionTaskRegistry,
  resetSupervisionTaskRegistryForTests,
  type PersistedSupervisionTaskAssignmentIdentity,
} from '../../src/daemon/supervision-state-store.js';
import {
  getTransportQueueStore,
  resetTransportQueueStoreForTests,
} from '../../src/daemon/transport-queue-store.js';
import { suppressSqliteExperimentalWarning } from '../../src/util/suppress-sqlite-warning.js';

const require = createRequire(import.meta.url);
suppressSqliteExperimentalWarning();
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

function identity(name: string, agentType = 'codex-sdk', providerFamily = 'openai'): PersistedSupervisionTaskAssignmentIdentity {
  return {
    sessionName: name,
    sessionInstanceId: `instance-${name}`,
    runtimeEpoch: `epoch-${name}`,
    agentType,
    providerFamily,
  };
}

function session(
  name: string,
  role: SessionRecord['role'],
  agentType = 'codex-sdk',
  providerFamily = 'openai',
): SessionRecord {
  return {
    name,
    sessionInstanceId: `instance-${name}`,
    runtimeEpoch: `epoch-${name}`,
    projectName: 'alpha',
    role,
    agentType,
    projectDir: '/work/alpha',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 2,
    requestedModel: providerFamily === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-5.6',
    activeModel: providerFamily === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-5.6',
    runtimeType: 'transport',
    ...(role === 'brain' ? {} : { parentSession: 'deck_alpha_brain', userCreated: true, label: name }),
  } as SessionRecord;
}

function automaticAttempt(taskId: string, revision: string): string {
  return `auto-audit-${createHash('sha256').update(`${taskId}\0${revision}`).digest('hex').slice(0, 24)}`;
}

function automaticMessageId(assignmentId: string, attemptId: string): SendMessageId {
  const hex = createHash('sha256').update(`auto-audit:${assignmentId}:${attemptId}`).digest('hex');
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return `send_message_${uuid}`;
}

function listTargetRecords(...targets: SessionRecord[]) {
  return () => ({
    status: 'ok' as const,
    executionPoolsState: 'configured' as const,
    appliedExecutionPool: 'primary' as const,
    items: targets.map((target) => ({
      target: target.name,
      label: target.label ?? null,
      sessionName: target.name,
      role: target.role,
      agentType: target.agentType,
      status: target.state,
      lastActiveAt: target.updatedAt,
      providerFamily: target.agentType.includes('claude') ? 'anthropic' : 'openai',
      availability: target.state === 'idle'
        ? 'ready' as const
        : target.state === 'running'
          ? 'busy' as const
          : 'offline' as const,
      eligiblePools: ['primary' as const],
      dispatchMode: target.state === 'idle'
        ? 'new_work' as const
        : target.state === 'running'
          ? 'queue_only' as const
          : 'unavailable' as const,
      limitGroup: target.agentType.includes('claude') ? 'claude' as const : 'codex' as const,
      replyCapable: target.agentType !== 'custom-transport-adapter',
    })),
  });
}

function makeReadyTask(options: {
  taskId?: string;
  revision?: string;
  auditPolicy?: 'auto_allow_degraded' | 'auto_strict_cross_vendor';
  registry?: SupervisionTaskRegistry;
} = {}) {
  const registry = options.registry ?? new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
  const taskId = options.taskId ?? 'auto-audit-task';
  const revision = options.revision ?? 'auto-audit-r1';
  expect(registry.createOrGet({
    taskId,
    projectName: 'alpha',
    classification: 'integration_task',
    objective: 'audit one exact revision',
    acceptance: ['dispatch exactly once'],
    currentRevision: revision,
    ...(options.auditPolicy ? { auditPolicy: options.auditPolicy } : {}),
  })).toMatchObject({ ok: true });
  expect(registry.createAssignment({
    taskId,
    role: 'coordinator',
    identity: identity('deck_alpha_brain'),
    required: false,
  })).toMatchObject({ ok: true });
  const worker = registry.createAssignment({
    taskId,
    role: 'implementer',
    identity: identity('deck_alpha_worker'),
    auditRevision: revision,
    scopeFiles: ['src/exact.ts'],
  });
  if (!worker.ok) throw new Error(worker.reason);
  for (const [intent, toStatus, validationState] of [
    ['start', 'implementing', undefined],
    ['record_validation', 'validated', 'passed'],
    ['open_audit', 'ready_for_audit', undefined],
  ] as const) {
    expect(registry.applyTaskIntent({
      taskId,
      assignmentId: worker.value.assignmentId,
      intent,
      toStatus,
      ...(validationState ? { validationState } : {}),
    })).toMatchObject({ ok: true });
  }
  return { registry, taskId, revision, worker: worker.value };
}

beforeEach(() => {
  resetSupervisionTaskRegistryForTests();
  resetTransportQueueStoreForTests();
  clearSendIdempotencyCacheForTests();
});

describe('automatic supervision audit materialization', () => {
  function settleReadyTask(
    verdict: 'PASS' | 'REWORK',
    taskId?: string,
    registry?: SupervisionTaskRegistry,
  ) {
    const shape = makeReadyTask({
      taskId: taskId ?? `daemon-first-${verdict.toLowerCase()}`,
      auditPolicy: 'auto_strict_cross_vendor',
      ...(registry ? { registry } : {}),
    });
    const attemptId = automaticAttempt(shape.taskId, shape.revision);
    const auditor = shape.registry.createAssignment({
      taskId: shape.taskId, role: 'auditor', required: false,
      identity: identity(`deck_alpha_${verdict.toLowerCase()}_auditor`, 'claude-code-sdk', 'anthropic'),
      auditAttemptId: attemptId, auditRevision: shape.revision,
    });
    if (!auditor.ok) throw new Error(auditor.reason);
    expect(shape.registry.updateAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditor.value.identity,
      status: 'auditing', auditAttemptId: attemptId, auditRevision: shape.revision,
    })).toMatchObject({ ok: true });
    expect(shape.registry.appendMatchingAuditReceipt({
      taskId: shape.taskId, auditorAssignmentId: auditor.value.assignmentId,
      auditorIdentity: auditor.value.identity, auditorSessionName: auditor.value.identity.sessionName,
      attemptId, revision: shape.revision, receiptKind: 'final', verdict,
      findings: verdict === 'PASS' ? 'exact bytes pass' : 'repair exact finding', validations: [],
    })).toMatchObject({ ok: true });
    expect(shape.registry.finishAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditor.value.identity, revision: shape.revision,
    })).toMatchObject({ ok: true });
    return { ...shape, attemptId, auditor: auditor.value };
  }

  async function passAuthorizedReplayShape(taskId: string) {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = settleReadyTask('PASS', taskId, registry);
    const brain = session('deck_alpha_brain', 'brain');
    await expect(dispatchReadyIntegration(shape.taskId, {
      registry,
      listSessions: () => [brain, session('deck_alpha_worker', 'w1')],
      dispatch: vi.fn().mockResolvedValue({
        status: 'accepted',
        dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000091',
        messageId: 'send_message_00000000-0000-5000-a000-000000000091',
        deliveries: [{ target: brain.name, status: 'queued' }],
      }),
      hasDeliveryEvidence: () => false,
      inspectAssignmentWorktree: () => ({
        worktreePath: `/tmp/${taskId}/repo`, headSha: 'a'.repeat(40),
        files: [{ path: 'src/exact.ts', sha256: '1'.repeat(64) }],
        stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
      }),
    })).resolves.toMatchObject({ status: 'dispatched' });
    const owner = registry.get(taskId)!.assignments.find(
      (assignment) => assignment.role === 'integration_owner',
    )!;
    const demote = () => {
      const task = registry.getTaskRecord(taskId)!;
      const demotedTask = { ...task, status: 'implementing' as const, updatedAt: task.updatedAt + 1 };
      database.prepare(
        'UPDATE supervision_tasks SET status = ?, payload_json = ?, updated_at = ? WHERE task_id = ?',
      ).run(demotedTask.status, JSON.stringify(demotedTask), demotedTask.updatedAt, taskId);
      const currentOwner = registry.getAssignment(owner.assignmentId)!;
      const demotedOwner = {
        ...currentOwner, status: 'implementing' as const, updatedAt: currentOwner.updatedAt + 1,
      };
      database.prepare(
        'UPDATE supervision_task_assignments SET status = ?, payload_json = ?, updated_at = ? WHERE assignment_id = ?',
      ).run(demotedOwner.status, JSON.stringify(demotedOwner), demotedOwner.updatedAt, owner.assignmentId);
    };
    return { database, registry, shape, owner, demote };
  }

  it('exposes one project-authoritative primary pool to Brain and ordinary sub-sessions', () => {
    const brain = session('deck_alpha_brain', 'brain');
    const worker = session('deck_alpha_worker', 'w1');
    const auditor = session('deck_alpha_auditor', 'w2', 'claude-code-sdk', 'anthropic');
    const selected = {
      agentType: 'claude-code-sdk', providerFamily: 'anthropic',
      runtimeType: 'transport' as const, model: 'claude-sonnet-4-6',
    };
    brain.transportConfig = {
      supervision: normalizeSessionSupervisionSnapshot({
        mode: 'supervised_audit',
        executionPools: {
          state: 'configured',
          primaryDevelopmentPool: {
            configs: [{ ...selected, capabilityId: buildSupervisionExecutionCapabilityId(selected) }],
            controls: { maxSpawned: 1 },
          },
          economyTaskPool: { configs: [], controls: { maxSpawned: 0 } },
        },
      }),
    };
    worker.transportConfig = {
      supervision: normalizeSessionSupervisionSnapshot({
        mode: 'supervised_audit', executionPools: { state: 'legacy_unconfigured' },
      }),
    };
    const sessions = [brain, worker, auditor];
    const fromBrain = listSendTargets({
      userId: brain.name, sessionName: brain.name, projectName: 'alpha', projectRoot: '/work/alpha',
    }, { executionPool: 'primary' }, { listSessions: () => sessions });
    const fromWorker = listSendTargets({
      userId: worker.name, sessionName: worker.name, projectName: 'alpha', projectRoot: '/work/alpha',
    }, { executionPool: 'primary' }, { listSessions: () => sessions });
    expect(fromBrain).toMatchObject({ status: 'ok', executionPoolsState: 'configured' });
    expect(fromWorker).toMatchObject({ status: 'ok', executionPoolsState: 'configured' });
    if (fromBrain.status !== 'ok' || fromWorker.status !== 'ok') throw new Error('expected target list');
    expect(fromBrain.items.map((item) => item.target)).toEqual([auditor.name]);
    expect(fromWorker.items.map((item) => item.target)).toEqual([auditor.name]);
  });

  it('dispatches exact REWORK to the same implementer object and never creates a replacement', async () => {
    __resetSupervisionConvergenceTickForTests();
    const shape = settleReadyTask('REWORK');
    expect(shape.registry.get(shape.taskId)).toMatchObject({ status: 'rework' });
    const worker = session('deck_alpha_worker', 'w1');
    const dispatch = vi.fn().mockResolvedValue({
      status: 'accepted', dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000031',
      messageId: 'send_message_00000000-0000-5000-a000-000000000031',
      deliveries: [{ target: worker.name, status: 'queued' }],
    });
    const beforeIds = shape.registry.get(shape.taskId)!.assignments.map((assignment) => assignment.assignmentId);
    await expect(runSupervisionConvergenceTick({
      registry: shape.registry, listSessions: () => [session('deck_alpha_brain', 'brain'), worker],
      dispatch, hasDeliveryEvidence: () => false,
    })).resolves.toMatchObject({
      reworks: [expect.objectContaining({ status: 'dispatched', assignmentId: shape.worker.assignmentId })],
    });
    expect(shape.registry.getAssignment(shape.worker.assignmentId)).toMatchObject({
      status: 'implementing', auditAttemptId: shape.attemptId, auditRevision: shape.revision,
    });
    expect(shape.registry.get(shape.taskId)!.assignments.map((assignment) => assignment.assignmentId)).toEqual(beforeIds);
    expect(dispatch.mock.calls[0]![0]).toMatchObject({ sessionName: 'deck_alpha_brain' });
    expect(dispatch.mock.calls[0]![1].message).toContain(`assignmentId=${shape.worker.assignmentId}`);
    expect(dispatch.mock.calls[0]![1].task).toMatchObject({
      taskId: shape.taskId, assignmentId: shape.worker.assignmentId,
      currentRevision: shape.revision, auditRevision: shape.revision,
      auditAttemptId: shape.attemptId, executionPool: 'primary',
    });
  });

  it('materializes one integration owner and directly delivers the exact authoritative pathspec after PASS', async () => {
    const shape = settleReadyTask('PASS');
    const brain = session('deck_alpha_brain', 'brain');
    const worker = session('deck_alpha_worker', 'w1');
    let delivered = false;
    const dispatch = vi.fn().mockImplementation(async () => {
      delivered = true;
      return {
        status: 'accepted', dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000032',
        messageId: 'send_message_00000000-0000-5000-a000-000000000032',
        deliveries: [{ target: brain.name, status: 'queued' }],
      };
    });
    const deps = {
      registry: shape.registry,
      listSessions: () => [brain, worker],
      dispatch,
      hasDeliveryEvidence: () => delivered,
      inspectAssignmentWorktree: () => ({
        worktreePath: '/tmp/authoritative-worker/repo', headSha: 'a'.repeat(40),
        files: [{ path: 'src/exact.ts', sha256: '1'.repeat(64) }],
        stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
      }),
    };
    const first = await dispatchReadyIntegration(shape.taskId, deps);
    expect(first).toMatchObject({ status: 'dispatched' });
    const owners = shape.registry.get(shape.taskId)!.assignments.filter((assignment) => assignment.role === 'integration_owner');
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({
      identity: identity('deck_alpha_brain'), auditRevision: shape.revision,
      auditAttemptId: shape.attemptId, status: 'ready_for_integration',
      verdict: 'PASS', crossVendorAuditPassed: true,
    });
    expect(shape.registry.get(shape.taskId)).toMatchObject({
      status: 'ready_for_integration', integrationOwnerAssignmentId: owners[0]!.assignmentId,
    });
    expect(dispatch.mock.calls[0]![1].message).toContain('authoritativeWorktree=/tmp/authoritative-worker/repo');
    expect(dispatch.mock.calls[0]![1].message).toContain('- src/exact.ts');
    const receiptCount = shape.registry.listAuditReceipts(shape.taskId).length;
    await expect(dispatchReadyIntegration(shape.taskId, deps)).resolves.toMatchObject({ status: 'replayed' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(shape.registry.get(shape.taskId)!.assignments.filter((assignment) => assignment.role === 'integration_owner')).toHaveLength(1);
    expect(shape.registry.listAuditReceipts(shape.taskId)).toHaveLength(receiptCount);

    expect(shape.registry.finalizeIntegration({
      assignmentId: owners[0]!.assignmentId,
      identity: owners[0]!.identity,
      revision: shape.revision,
      auditAttemptId: shape.attemptId,
      auditRevision: shape.revision,
      verdict: 'PASS',
      ownedFiles: ['src/exact.ts'],
      integrationManifest: [{ path: 'src/exact.ts', sha256: '1'.repeat(64) }],
      integrationOwner: 'deck_alpha_brain',
      commitSha: 'a'.repeat(40),
      pushResult: 'already_present',
      pushRemoteRef: 'refs/remotes/origin/dev',
      stagedPaths: [], conflictedPaths: [], untrackedOtherOwnerPaths: [],
      ciResult: 'ci_not_configured',
    })).toMatchObject({ ok: true, value: { status: 'finalized' } });
    expect(shape.registry.getAssignment(shape.worker.assignmentId)).toMatchObject({
      status: 'ready_for_integration', auditAttemptId: shape.attemptId,
      auditRevision: shape.revision, verdict: 'PASS', crossVendorAuditPassed: true,
    });
  });

  it.each(['start', 'heartbeat', 'checkpoint'] as const)(
    'keeps an exact PASS integration round finalizable across %s and heals its stale projection',
    async (intent) => {
      const database = new DatabaseSync(':memory:');
      const registry = new SupervisionTaskRegistry({ database });
      const shape = settleReadyTask('PASS', `pass-owner-${intent}`, registry);
      const brain = session('deck_alpha_brain', 'brain');
      await expect(dispatchReadyIntegration(shape.taskId, {
        registry,
        listSessions: () => [brain, session('deck_alpha_worker', 'w1')],
        dispatch: vi.fn().mockResolvedValue({
          status: 'accepted',
          dispatchId: `send_dispatch_00000000-0000-4000-8000-0000000000${intent.length}`,
          messageId: `send_message_00000000-0000-5000-a000-0000000000${intent.length}`,
          deliveries: [{ target: brain.name, status: 'queued' }],
        }),
        hasDeliveryEvidence: () => false,
        inspectAssignmentWorktree: () => ({
          worktreePath: `/tmp/${shape.taskId}/repo`, headSha: 'a'.repeat(40),
          files: [{ path: 'src/exact.ts', sha256: '1'.repeat(64) }],
          stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
        }),
      })).resolves.toMatchObject({ status: 'dispatched' });

      const owner = registry.get(shape.taskId)!.assignments.find(
        (assignment) => assignment.role === 'integration_owner',
      )!;
      const receiptCount = registry.listAuditReceipts(shape.taskId).length;
      const coherentEventCount = registry.listEvents(shape.taskId).length;
      expect(registry.applyTaskIntent({
        taskId: shape.taskId,
        assignmentId: owner.assignmentId,
        intent,
        toStatus: intent === 'start' ? 'implementing' : null,
      })).toMatchObject({ ok: true, value: { status: 'ready_for_integration' } });
      expect(registry.get(shape.taskId)).toMatchObject({ status: 'ready_for_integration' });
      expect(registry.getAssignment(owner.assignmentId)).toMatchObject({ status: 'ready_for_integration' });
      if (intent === 'start') expect(registry.listEvents(shape.taskId)).toHaveLength(coherentEventCount);
      if (intent === 'heartbeat') {
        expect(registry.listEvents(shape.taskId)).toHaveLength(coherentEventCount + 1);
        expect(registry.getAssignment(owner.assignmentId)?.heartbeatAt).toEqual(expect.any(Number));
      }
      if (intent === 'checkpoint') {
        expect(registry.listEvents(shape.taskId).some(
          (event) => event.eventType === 'implementation_progress' && event.assignmentId === owner.assignmentId,
        )).toBe(true);
      }

      const task = registry.getTaskRecord(shape.taskId)!;
      const demotedTask = { ...task, status: 'implementing' as const, updatedAt: task.updatedAt + 1 };
      database.prepare(
        'UPDATE supervision_tasks SET status = ?, payload_json = ?, updated_at = ? WHERE task_id = ?',
      ).run(demotedTask.status, JSON.stringify(demotedTask), demotedTask.updatedAt, shape.taskId);
      const currentOwner = registry.getAssignment(owner.assignmentId)!;
      const demotedOwner = {
        ...currentOwner, status: 'implementing' as const, updatedAt: currentOwner.updatedAt + 1,
      };
      database.prepare(
        'UPDATE supervision_task_assignments SET status = ?, payload_json = ?, updated_at = ? WHERE assignment_id = ?',
      ).run(demotedOwner.status, JSON.stringify(demotedOwner), demotedOwner.updatedAt, owner.assignmentId);

      if (intent === 'start') {
        const conflictingTask = {
          ...demotedTask, commitSha: 'b'.repeat(40), updatedAt: demotedTask.updatedAt + 1,
        };
        database.prepare(
          'UPDATE supervision_tasks SET payload_json = ?, updated_at = ? WHERE task_id = ?',
        ).run(JSON.stringify(conflictingTask), conflictingTask.updatedAt, shape.taskId);
        expect(registry.applyTaskIntent({
          taskId: shape.taskId, assignmentId: owner.assignmentId, intent, toStatus: 'implementing',
        })).toEqual({ ok: false, reason: 'manifest_mismatch' });
        database.prepare(
          'UPDATE supervision_tasks SET payload_json = ?, updated_at = ? WHERE task_id = ?',
        ).run(JSON.stringify(demotedTask), demotedTask.updatedAt, shape.taskId);
      } else if (intent === 'heartbeat') {
        const unauditedOwner = {
          ...demotedOwner, verdict: undefined, crossVendorAuditPassed: undefined,
          updatedAt: demotedOwner.updatedAt + 1,
        };
        database.prepare(
          'UPDATE supervision_task_assignments SET payload_json = ?, updated_at = ? WHERE assignment_id = ?',
        ).run(JSON.stringify(unauditedOwner), unauditedOwner.updatedAt, owner.assignmentId);
        expect(registry.applyTaskIntent({
          taskId: shape.taskId, assignmentId: owner.assignmentId, intent, toStatus: null,
        })).toMatchObject({ ok: true, value: { status: 'implementing' } });
        expect(registry.getAssignment(owner.assignmentId)).toMatchObject({ status: 'implementing' });
        database.prepare(
          'UPDATE supervision_task_assignments SET payload_json = ?, updated_at = ? WHERE assignment_id = ?',
        ).run(JSON.stringify(demotedOwner), demotedOwner.updatedAt, owner.assignmentId);
      }

      expect(registry.applyTaskIntent({
        taskId: shape.taskId,
        assignmentId: owner.assignmentId,
        intent,
        toStatus: intent === 'start' ? 'implementing' : null,
      })).toMatchObject({ ok: true, value: { status: 'ready_for_integration' } });
      expect(registry.get(shape.taskId)).toMatchObject({ status: 'ready_for_integration' });
      expect(registry.getAssignment(owner.assignmentId)).toMatchObject({
        status: 'ready_for_integration',
        auditAttemptId: shape.attemptId,
        auditRevision: shape.revision,
        verdict: 'PASS',
        crossVendorAuditPassed: true,
      });
      expect(registry.listAuditReceipts(shape.taskId)).toHaveLength(receiptCount);
    },
  );

  it('refuses replay authority from a same-provider finalized auditor', async () => {
    const { database, registry, shape, owner, demote } = await passAuthorizedReplayShape(
      'pass-owner-same-provider-auditor',
    );
    const auditor = registry.getAssignment(shape.auditor.assignmentId)!;
    const sameProviderAuditor = {
      ...auditor,
      identity: { ...auditor.identity, providerFamily: owner.identity.providerFamily },
      updatedAt: auditor.updatedAt + 1,
    };
    database.prepare(
      'UPDATE supervision_task_assignments SET provider_family = ?, payload_json = ?, updated_at = ? WHERE assignment_id = ?',
    ).run(sameProviderAuditor.identity.providerFamily, JSON.stringify(sameProviderAuditor),
      sameProviderAuditor.updatedAt, auditor.assignmentId);
    demote();

    expect(registry.applyTaskIntent({
      taskId: shape.taskId, assignmentId: owner.assignmentId, intent: 'start', toStatus: 'implementing',
    })).toMatchObject({ ok: true, value: { status: 'implementing' } });
    expect(registry.getTaskRecord(shape.taskId)).toMatchObject({ status: 'implementing' });
    expect(registry.getAssignment(owner.assignmentId)).toMatchObject({ status: 'implementing' });
  });

  it('refuses replay when required lineage disagrees on the audited revision', async () => {
    const { database, registry, shape, owner, demote } = await passAuthorizedReplayShape(
      'pass-owner-lineage-mismatch',
    );
    const worker = registry.getAssignment(shape.worker.assignmentId)!;
    const mismatchedWorker = {
      ...worker, auditRevision: 'different-required-revision', updatedAt: worker.updatedAt + 1,
    };
    database.prepare(
      'UPDATE supervision_task_assignments SET audit_revision = ?, payload_json = ?, updated_at = ? WHERE assignment_id = ?',
    ).run(mismatchedWorker.auditRevision, JSON.stringify(mismatchedWorker),
      mismatchedWorker.updatedAt, worker.assignmentId);
    demote();

    expect(registry.applyTaskIntent({
      taskId: shape.taskId, assignmentId: owner.assignmentId, intent: 'start', toStatus: 'implementing',
    })).toMatchObject({ ok: true, value: { status: 'implementing' } });
    expect(registry.getTaskRecord(shape.taskId)).toMatchObject({ status: 'implementing' });
    expect(registry.getAssignment(owner.assignmentId)).toMatchObject({ status: 'implementing' });
  });

  it('fails closed when two live required integration owners are ambiguous', async () => {
    const { database, registry, shape, owner, demote } = await passAuthorizedReplayShape(
      'pass-owner-ambiguous-live-owners',
    );
    const second = registry.createAssignment({
      taskId: shape.taskId, role: 'integration_owner', required: true,
      identity: identity('deck_alpha_other_brain'),
      auditAttemptId: shape.attemptId, auditRevision: shape.revision,
    });
    if (!second.ok) throw new Error(second.reason);
    const liveSecond = {
      ...second.value,
      status: 'implementing' as const,
      verdict: 'PASS',
      crossVendorAuditPassed: true,
      updatedAt: second.value.updatedAt + 1,
    };
    database.prepare(
      'UPDATE supervision_task_assignments SET status = ?, verdict = ?, payload_json = ?, updated_at = ? WHERE assignment_id = ?',
    ).run(liveSecond.status, liveSecond.verdict, JSON.stringify(liveSecond),
      liveSecond.updatedAt, second.value.assignmentId);
    demote();

    expect(registry.applyTaskIntent({
      taskId: shape.taskId, assignmentId: owner.assignmentId, intent: 'start', toStatus: 'implementing',
    })).toEqual({ ok: false, reason: 'ambiguous_assignment' });
    expect(registry.getTaskRecord(shape.taskId)).toMatchObject({ status: 'implementing' });
    expect(registry.getAssignment(owner.assignmentId)).toMatchObject({ status: 'implementing' });
  });

  it('aligns one validated R1/R2 split before the ordinary finish handoff and keeps stale finish rejected', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const taskId = 'validated-revision-split';
    const r1 = 'validated-r1';
    const r2 = 'validated-r2';
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'independent_top_level',
      objective: 'align exact validated successor', currentRevision: r2,
    })).toMatchObject({ ok: true });
    const worker = registry.createAssignment({
      taskId, role: 'implementer', required: true, identity: identity('deck_alpha_worker'),
      scopeFiles: ['src/exact.ts'], auditRevision: r2,
    });
    if (!worker.ok) throw new Error(worker.reason);
    expect(registry.applyTaskIntent({
      taskId, assignmentId: worker.value.assignmentId,
      intent: 'start', toStatus: 'implementing',
    })).toMatchObject({ ok: true });
    expect(registry.applyTaskIntent({
      taskId, assignmentId: worker.value.assignmentId,
      intent: 'record_validation', toStatus: 'validated', validationState: 'passed',
    })).toMatchObject({ ok: true });
    const currentTask = registry.getTaskRecord(taskId)!;
    const splitTask = {
      ...currentTask, status: 'validated' as const, currentRevision: r1,
      validationState: 'passed' as const, updatedAt: currentTask.updatedAt + 1,
    };
    database.prepare(
      'UPDATE supervision_tasks SET status = ?, current_revision = ?, payload_json = ?, updated_at = ? WHERE task_id = ?',
    ).run(splitTask.status, r1, JSON.stringify(splitTask), splitTask.updatedAt, taskId);

    expect(registry.finishAssignment({
      assignmentId: worker.value.assignmentId, identity: worker.value.identity, revision: r2,
    })).toEqual({ ok: false, reason: 'old_revision' });
    expect(registry.convergeValidatedAssignment(worker.value.assignmentId, splitTask.updatedAt + 1))
      .toEqual([
        { taskId, assignmentId: worker.value.assignmentId, action: 'align_validated_revision' },
        { taskId, assignmentId: worker.value.assignmentId, action: 'project_validated_handoff' },
      ]);
    expect(registry.getTaskRecord(taskId)).toMatchObject({
      status: 'ready_for_audit', currentRevision: r2, validationState: 'passed',
    });
    expect(registry.getAssignment(worker.value.assignmentId)).toMatchObject({
      status: 'ready_for_audit', auditRevision: r2, validationState: 'passed', leaseId: '',
    });
    expect(registry.finishAssignment({
      assignmentId: worker.value.assignmentId, identity: worker.value.identity, revision: r1,
    })).toEqual({ ok: false, reason: 'old_revision' });
    const eventCount = registry.listEvents(taskId).length;
    expect(registry.convergeValidatedAssignment(worker.value.assignmentId, splitTask.updatedAt + 2)).toEqual([]);
    expect(registry.listEvents(taskId)).toHaveLength(eventCount);
  });

  it.each(['ambiguous implementer', 'conflicting external evidence'] as const)(
    'leaves a validated revision split untouched with %s',
    (conflict) => {
      const database = new DatabaseSync(':memory:');
      const registry = new SupervisionTaskRegistry({ database });
      const taskId = `validated-revision-split-${conflict.replaceAll(' ', '-')}`;
      const r1 = 'validated-r1';
      const r2 = 'validated-r2';
      expect(registry.createOrGet({
        taskId, projectName: 'alpha', classification: 'independent_top_level',
        objective: 'leave ambiguous successor untouched', currentRevision: r2,
      })).toMatchObject({ ok: true });
      const worker = registry.createAssignment({
        taskId, role: 'implementer', required: true, identity: identity('deck_alpha_worker'),
        scopeFiles: ['src/exact.ts'], auditRevision: r2,
      });
      if (!worker.ok) throw new Error(worker.reason);
      expect(registry.applyTaskIntent({
        taskId, assignmentId: worker.value.assignmentId, intent: 'start', toStatus: 'implementing',
      })).toMatchObject({ ok: true });
      expect(registry.applyTaskIntent({
        taskId, assignmentId: worker.value.assignmentId, intent: 'record_validation',
        toStatus: 'validated', validationState: 'passed',
      })).toMatchObject({ ok: true });
      if (conflict === 'ambiguous implementer') {
        expect(registry.createAssignment({
          taskId, role: 'implementer', required: true, identity: identity('deck_alpha_worker-two'),
          scopeFiles: ['src/other.ts'], auditRevision: r2,
        })).toMatchObject({ ok: true });
      } else {
        const current = registry.getAssignment(worker.value.assignmentId)!;
        const conflicted = { ...current, externalRunId: 'run-from-another-round' };
        database.prepare(
          'UPDATE supervision_task_assignments SET payload_json = ? WHERE assignment_id = ?',
        ).run(JSON.stringify(conflicted), current.assignmentId);
      }
      const currentTask = registry.getTaskRecord(taskId)!;
      const splitTask = {
        ...currentTask, status: 'validated' as const, currentRevision: r1,
        validationState: 'passed' as const, updatedAt: currentTask.updatedAt + 1,
      };
      database.prepare(
        'UPDATE supervision_tasks SET status = ?, current_revision = ?, payload_json = ?, updated_at = ? WHERE task_id = ?',
      ).run(splitTask.status, r1, JSON.stringify(splitTask), splitTask.updatedAt, taskId);

      expect(registry.convergeValidatedAssignment(worker.value.assignmentId, splitTask.updatedAt + 1)).toEqual([]);
      expect(registry.getTaskRecord(taskId)).toMatchObject({ status: 'validated', currentRevision: r1 });
      expect(registry.getAssignment(worker.value.assignmentId)).toMatchObject({ status: 'validated', auditRevision: r2 });
    },
  );

  it('repairs the exact validated revision split in the bounded sweep and is replay-idempotent', () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const taskId = 'validated-revision-split-sweep';
    const r1 = 'validated-sweep-r1';
    const r2 = 'validated-sweep-r2';
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'independent_top_level',
      objective: 'bounded split repair', currentRevision: r2,
    })).toMatchObject({ ok: true });
    const worker = registry.createAssignment({
      taskId, role: 'implementer', required: true, identity: identity('deck_alpha_worker'),
      scopeFiles: ['src/exact.ts'], auditRevision: r2,
    });
    if (!worker.ok) throw new Error(worker.reason);
    expect(registry.applyTaskIntent({
      taskId, assignmentId: worker.value.assignmentId, intent: 'start', toStatus: 'implementing',
    })).toMatchObject({ ok: true });
    expect(registry.applyTaskIntent({
      taskId, assignmentId: worker.value.assignmentId, intent: 'record_validation',
      toStatus: 'validated', validationState: 'passed',
    })).toMatchObject({ ok: true });
    const task = registry.getTaskRecord(taskId)!;
    const split = {
      ...task, currentRevision: r1, status: 'validated' as const,
      validationState: 'passed' as const, updatedAt: task.updatedAt + 1,
    };
    database.prepare(
      'UPDATE supervision_tasks SET status = ?, current_revision = ?, payload_json = ?, updated_at = ? WHERE task_id = ?',
    ).run(split.status, r1, JSON.stringify(split), split.updatedAt, taskId);

    expect(registry.convergeLifecycle(split.updatedAt + 1, { limit: 1 })).toEqual([
      { taskId, assignmentId: worker.value.assignmentId, action: 'align_validated_revision' },
      { taskId, assignmentId: worker.value.assignmentId, action: 'project_validated_handoff' },
    ]);
    const eventCount = registry.listEvents(taskId).length;
    expect(registry.convergeLifecycle(split.updatedAt + 2, { limit: 1 })).toEqual([]);
    expect(registry.listEvents(taskId)).toHaveLength(eventCount);
  });

  it('clears external execution evidence with the existing coordination audit reset', () => {
    const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
    const taskId = 'coordination-reset-external-evidence';
    const revision = 'coordination-reset-r1';
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'independent_top_level',
      objective: 'reset stale round metadata', currentRevision: revision,
    })).toMatchObject({ ok: true });
    const worker = registry.createAssignment({
      taskId, role: 'implementer', required: true, identity: identity('deck_alpha_worker'),
      auditRevision: revision,
    });
    if (!worker.ok) throw new Error(worker.reason);
    expect(registry.updateAssignment({
      assignmentId: worker.value.assignmentId, identity: worker.value.identity,
      status: 'implementing', revision, auditAttemptId: 'stale-attempt',
      externalRunId: 'run-stale', externalHeadSha: 'a'.repeat(40), externalTaskId: 'job-stale',
    })).toMatchObject({ ok: true });
    expect(registry.coordinateTaskAssignment({
      taskId, assignmentId: worker.value.assignmentId,
      taskStatus: 'implementing', assignmentStatus: 'rework', leaseAction: 'renew',
      idempotencyKey: 'reset-stale-round', reason: 'authorized same-object repair',
    })).toMatchObject({ ok: true });
    const reset = registry.getAssignment(worker.value.assignmentId)!;
    expect(reset).toMatchObject({ status: 'rework' });
    for (const field of [
      'auditAttemptId', 'auditRevision', 'verdict', 'externalRunId', 'externalHeadSha',
      'externalTaskId', 'crossVendorAuditPassed',
    ]) expect(reset).not.toHaveProperty(field);
  });

  it('redelivers an already-present PASS artifact already owned by the exact integration owner', async () => {
    const shape = settleReadyTask('PASS', 'tsk_79u-owner-projection');
    const brain = session('deck_alpha_brain', 'brain');
    const owner = shape.registry.createAssignment({
      taskId: shape.taskId, role: 'integration_owner', identity: identity(brain.name),
      required: true, auditAttemptId: shape.attemptId, auditRevision: shape.revision,
    });
    if (!owner.ok) throw new Error(owner.reason);
    for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing', 'passed', 'ready_for_integration'] as const) {
      expect(shape.registry.updateAssignment({
        assignmentId: owner.value.assignmentId, identity: owner.value.identity, status,
        auditAttemptId: shape.attemptId, auditRevision: shape.revision,
        ...(status === 'passed' || status === 'ready_for_integration'
          ? { verdict: 'PASS', crossVendorAuditPassed: true } : {}),
      })).toMatchObject({ ok: true });
    }
    expect(shape.registry.applyTaskIntent({
      taskId: shape.taskId, assignmentId: shape.worker.assignmentId,
      intent: 'cancel', toStatus: 'cancelled', note: 'already-present owner is authoritative',
    })).toMatchObject({ ok: true });
    const dispatch = vi.fn().mockResolvedValue({
      status: 'accepted',
      dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000079',
      messageId: 'send_message_00000000-0000-5000-a000-000000000079',
      deliveries: [{ target: brain.name, status: 'queued' }],
    });

    await expect(dispatchReadyIntegration(shape.taskId, {
      registry: shape.registry,
      listSessions: () => [brain, session('deck_alpha_worker', 'w1')],
      dispatch, hasDeliveryEvidence: () => false,
      inspectAssignmentWorktree: () => ({
        worktreePath: '/tmp/tsk_79u/asg_owner/repo', headSha: '4'.repeat(40),
        files: [{ path: 'src/exact.ts', sha256: '1'.repeat(64) }],
        stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
        matchingRemoteCommitSha: '4a6b85dd50870edb2223ddbcbd6c8f7a9df3b534',
        matchingRemoteRef: 'refs/remotes/origin/dev',
      }),
    })).resolves.toMatchObject({ status: 'dispatched', assignmentId: owner.value.assignmentId });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]![1].message).toContain('CI is optional smoke only');
  });

  it.each(['tsk_4d0', 'tsk_5o7', 'tsk_6xo', 'tsk_73e'])(
    'drives the observed %s ready_for_integration projection instead of heartbeating it',
    async (taskId) => {
      __resetSupervisionConvergenceTickForTests();
      const shape = settleReadyTask('PASS', taskId);
      const dispatch = vi.fn().mockResolvedValue({
        status: 'accepted', dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000033',
        messageId: 'send_message_00000000-0000-5000-a000-000000000033',
        deliveries: [{ target: 'deck_alpha_brain', status: 'queued' }],
      });
      await expect(runSupervisionConvergenceTick({
        registry: shape.registry,
        listSessions: () => [session('deck_alpha_brain', 'brain'), session('deck_alpha_worker', 'w1')],
        dispatch,
        hasDeliveryEvidence: () => false,
        inspectAssignmentWorktree: () => ({
          worktreePath: `/tmp/${taskId}/repo`, headSha: 'a'.repeat(40),
          files: [{ path: 'src/exact.ts', sha256: '1'.repeat(64) }],
          stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
        }),
      })).resolves.toMatchObject({
        integrations: [expect.objectContaining({ status: 'dispatched' })],
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
    },
  );

  it('snapshots supervised_audit policy on a new auditable task without preallocating an auditor', async () => {
    const selected = {
      agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport' as const, model: 'gpt-5.6',
    };
    const brain = session('deck_alpha_brain', 'brain');
    brain.transportConfig = {
      supervision: normalizeSessionSupervisionSnapshot({
        mode: 'supervised_audit',
        auditTargetSessionName: 'deck_alpha_auditor',
        executionPools: {
          state: 'configured',
          primaryDevelopmentPool: {
            configs: [{ ...selected, capabilityId: buildSupervisionExecutionCapabilityId(selected) }],
            controls: { maxSpawned: 2 },
          },
          economyTaskPool: { configs: [], controls: { maxSpawned: 0 } },
        },
      }),
    };
    const worker = session('deck_alpha_worker', 'w1');
    const result = await dispatchSendMessage({
      userId: brain.name, sessionName: brain.name, projectName: 'alpha', projectRoot: '/work/alpha',
    }, {
      target: worker.name,
      message: 'implement',
      idempotencyKey: 'policy-snapshot',
      task: { classification: 'integration_task', objective: 'implement one task', executionPool: 'primary' },
    }, {
      listSessions: () => [brain, worker],
      dispatchMessage: vi.fn().mockResolvedValue('queued'),
      ensureSupervisionAssignmentWorktree: async () => ({
        ok: true, worktreePath: '/worktree/repo', baseRevision: 'a'.repeat(40), created: true,
      }),
    });
    expect(result).toMatchObject({ status: 'accepted' });
    if (result.status !== 'accepted' || !result.taskId) throw new Error('task not created');
    const snapshot = getSupervisionTaskRegistry().get(result.taskId)!;
    expect(snapshot.auditPolicy).toBe('auto_allow_degraded');
    expect(snapshot.assignments.filter((item) => item.role === 'auditor')).toEqual([]);
    expect(snapshot.assignments.map((item) => item.role).sort()).toEqual(['coordinator', 'implementer']);
  });

  it('rejects an explicit Brain auditPolicy while session supervision is off', async () => {
    const selected = {
      agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport' as const, model: 'gpt-5.6',
    };
    const brain = session('deck_alpha_brain', 'brain');
    brain.transportConfig = {
      supervision: normalizeSessionSupervisionSnapshot({
        mode: 'off',
        executionPools: {
          state: 'configured',
          primaryDevelopmentPool: {
            configs: [{ ...selected, capabilityId: buildSupervisionExecutionCapabilityId(selected) }],
            controls: { maxSpawned: 2 },
          },
          economyTaskPool: { configs: [], controls: { maxSpawned: 0 } },
        },
      }),
    };
    const worker = session('deck_alpha_worker', 'w1');
    const result = await dispatchSendMessage({
      userId: brain.name, sessionName: brain.name, projectName: 'alpha', projectRoot: '/work/alpha',
    }, {
      target: worker.name,
      message: 'implement with explicit automatic audit',
      idempotencyKey: 'explicit-policy-new-task',
      task: {
        classification: 'independent_top_level',
        objective: 'explicit policy survives mode off',
        auditPolicy: 'auto_allow_degraded',
        executionPool: 'primary',
      },
    }, {
      listSessions: () => [brain, worker],
      dispatchMessage: vi.fn().mockResolvedValue('queued'),
      ensureSupervisionAssignmentWorktree: async () => ({
        ok: true, worktreePath: '/worktree/repo', baseRevision: 'a'.repeat(40), created: true,
      }),
    });
    expect(result).toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
      error: expect.stringContaining('requires supervised_audit mode'),
    });
    expect(getSupervisionTaskRegistry().list()).toEqual([]);
  });

  it('binds a missing policy only on an enabled exact Brain continuation and triggers the ready task once', async () => {
    const registry = getSupervisionTaskRegistry();
    const ready = makeReadyTask({ taskId: 'explicit-policy-recovery', registry });
    const selected = {
      agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport' as const, model: 'gpt-5.6',
    };
    const brain = session('deck_alpha_brain', 'brain');
    brain.transportConfig = {
      supervision: normalizeSessionSupervisionSnapshot({
        mode: 'supervised_audit',
        auditTargetSessionName: 'deck_alpha_auditor',
        executionPools: {
          state: 'configured',
          primaryDevelopmentPool: {
            configs: [{ ...selected, capabilityId: buildSupervisionExecutionCapabilityId(selected) }],
            controls: { maxSpawned: 2 },
          },
          economyTaskPool: { configs: [], controls: { maxSpawned: 0 } },
        },
      }),
    };
    const worker = session('deck_alpha_worker', 'w1');
    const dispatchReadyAudit = vi.fn().mockResolvedValue({ status: 'ignored', reason: 'test_hook' });
    const dispatchMessage = vi.fn().mockResolvedValue('queued');
    const result = await dispatchSendMessage({
      userId: brain.name, sessionName: brain.name, projectName: 'alpha', projectRoot: '/work/alpha',
    }, {
      target: worker.name,
      message: 'recover the same ready task',
      idempotencyKey: 'explicit-policy-ready-recovery',
      task: {
        taskId: ready.taskId,
        assignmentId: ready.worker.assignmentId,
        currentRevision: ready.revision,
        auditPolicy: 'auto_allow_degraded',
        executionPool: 'primary',
      },
    }, {
      listSessions: () => [brain, worker],
      dispatchMessage,
      dispatchReadyAudit,
      ensureSupervisionAssignmentWorktree: async () => ({
        ok: true, worktreePath: '/worktree/repo', baseRevision: 'a'.repeat(40), created: false,
      }),
    });
    expect(result).toMatchObject({ status: 'accepted', taskId: ready.taskId, assignmentId: ready.worker.assignmentId });
    expect(registry.get(ready.taskId)?.auditPolicy).toBe('auto_allow_degraded');
    expect(dispatchMessage).toHaveBeenCalledOnce();
    expect(dispatchReadyAudit).toHaveBeenCalledOnce();
    expect(dispatchReadyAudit).toHaveBeenCalledWith(ready.taskId);

    const conflict = await dispatchSendMessage({
      userId: brain.name, sessionName: brain.name, projectName: 'alpha', projectRoot: '/work/alpha',
    }, {
      target: worker.name,
      message: 'must not change the policy',
      idempotencyKey: 'explicit-policy-conflict',
      task: {
        taskId: ready.taskId,
        assignmentId: ready.worker.assignmentId,
        currentRevision: ready.revision,
        auditPolicy: 'auto_strict_cross_vendor',
        executionPool: 'primary',
      },
    }, {
      listSessions: () => [brain, worker],
      dispatchMessage,
    });
    expect(conflict).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED });
    expect(dispatchMessage).toHaveBeenCalledOnce();
  });

  it('does not bind or dispatch a ready task policy after automatic audit is turned off', async () => {
    const registry = getSupervisionTaskRegistry();
    const ready = makeReadyTask({ taskId: 'explicit-policy-off-recovery', registry });
    const selected = {
      agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport' as const, model: 'gpt-5.6',
    };
    const brain = session('deck_alpha_brain', 'brain');
    brain.transportConfig = {
      supervision: normalizeSessionSupervisionSnapshot({
        mode: 'off',
        executionPools: {
          state: 'configured',
          primaryDevelopmentPool: {
            configs: [{ ...selected, capabilityId: buildSupervisionExecutionCapabilityId(selected) }],
            controls: { maxSpawned: 2 },
          },
          economyTaskPool: { configs: [], controls: { maxSpawned: 0 } },
        },
      }),
    };
    const worker = session('deck_alpha_worker', 'w1');
    const dispatchReadyAudit = vi.fn();
    const dispatchMessage = vi.fn();
    const result = await dispatchSendMessage({
      userId: brain.name, sessionName: brain.name, projectName: 'alpha', projectRoot: '/work/alpha',
    }, {
      target: worker.name,
      message: 'must remain manual while automatic audit is off',
      idempotencyKey: 'explicit-policy-off-ready-recovery',
      task: {
        taskId: ready.taskId,
        assignmentId: ready.worker.assignmentId,
        currentRevision: ready.revision,
        auditPolicy: 'auto_allow_degraded',
        executionPool: 'primary',
      },
    }, {
      listSessions: () => [brain, worker],
      dispatchMessage,
      dispatchReadyAudit,
    });
    expect(result).toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
      error: expect.stringContaining('requires supervised_audit mode'),
    });
    expect(registry.get(ready.taskId)?.auditPolicy).toBeUndefined();
    expect(dispatchMessage).not.toHaveBeenCalled();
    expect(dispatchReadyAudit).not.toHaveBeenCalled();
  });

  it('converges repeated post-open and boot sweep calls on one assignment/attempt/message', async () => {
    const { registry, taskId, revision } = makeReadyTask({ auditPolicy: 'auto_allow_degraded' });
    const sessions = [
      session('deck_alpha_brain', 'brain'),
      session('deck_alpha_worker', 'w1'),
      session('deck_alpha_auditor', 'w2', 'claude-code-sdk', 'anthropic'),
    ];
    let hasEvidence = false;
    const dispatch = vi.fn(async (caller: SendRuntimeCaller, input: SendMessageInput) => {
      expect(caller).toMatchObject({ userId: 'deck_alpha_brain', sessionName: 'deck_alpha_brain' });
      expect(input.target).toBe('deck_alpha_auditor');
      expect(input.audit).toMatchObject({
        kind: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
        attemptId: automaticAttempt(taskId, revision),
        auditedSessionName: 'deck_alpha_worker',
      });
      expect(input.message).toContain('Authoritative implementer worktree: /tmp/authoritative-auto-audit/repo');
      expect(input.message).toContain('Do not inspect the auditor worktree');
      const created = registry.createAssignment({
        taskId,
        role: 'auditor',
        identity: identity('deck_alpha_auditor', 'claude-code-sdk', 'anthropic'),
        auditAttemptId: input.audit!.attemptId,
        auditRevision: revision,
        idempotencyKey: `send:${input.idempotencyKey}`,
      });
      if (!created.ok) throw new Error(created.reason);
      hasEvidence = true;
      return {
        status: 'accepted' as const,
        dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000000' as const,
        messageId: 'send_message_00000000-0000-5000-a000-000000000000' as SendMessageId,
        deliveries: [{ target: 'deck_alpha_auditor', status: 'queued' as const }],
        taskId,
        assignmentId: created.value.assignmentId,
      };
    });
    const deps = {
      registry,
      listSessions: () => sessions,
      listTargets: listTargetRecords(sessions[2]!),
      dispatch,
      hasDeliveryEvidence: () => hasEvidence,
      inspectAssignmentWorktree: () => ({
        worktreePath: '/tmp/authoritative-auto-audit/repo',
        headSha: 'a'.repeat(40),
        files: [{ path: 'src/exact.ts', sha256: '1'.repeat(64) }],
        stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
      }),
    };

    const first = await dispatchReadyAudit(taskId, deps);
    const second = await dispatchReadyAudit(taskId, deps);
    const swept = await dispatchReadyAuditSweep(deps);

    expect(first).toMatchObject({ status: 'dispatched', attemptId: automaticAttempt(taskId, revision) });
    expect(second).toMatchObject({ status: 'replayed', attemptId: automaticAttempt(taskId, revision) });
    expect(swept).toEqual([expect.objectContaining({ status: 'replayed' })]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(registry.listAssignments(taskId).filter((item) => item.role === 'auditor')).toHaveLength(1);
  });

  it('selects an authorized ready transport before spawn or a busy FIFO', async () => {
    const { registry, taskId } = makeReadyTask({ auditPolicy: 'auto_allow_degraded' });
    const worker = session('deck_alpha_worker', 'w1');
    const ready = session('deck_alpha_ready', 'w2', 'codex-sdk', 'openai');
    const busy = session('deck_alpha_busy', 'w2', 'claude-code-sdk', 'anthropic');
    busy.state = 'running';
    const dispatch = vi.fn().mockResolvedValue({
      status: 'accepted',
      dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000030',
      messageId: 'send_message_00000000-0000-5000-a000-000000000030',
      deliveries: [{ target: ready.name, status: 'queued' }],
      taskId,
      assignmentId: 'assignment-ready-auditor',
    });

    await expect(dispatchReadyAudit(taskId, {
      registry,
      listSessions: () => [session('deck_alpha_brain', 'brain'), worker, ready, busy],
      listTargets: listTargetRecords(worker, ready, busy),
      dispatch,
      hasDeliveryEvidence: () => false,
    })).resolves.toMatchObject({ status: 'dispatched', assignmentId: 'assignment-ready-auditor' });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      target: ready.name,
      task: expect.not.objectContaining({ autoProvision: true }),
    }));
  });

  it('persists policy and materializes the same audit after a SQLite reopen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'imcodes-auto-audit-reopen-'));
    const dbPath = join(root, 'registry.sqlite');
    let registry = new SupervisionTaskRegistry({ dbPath });
    try {
      const ready = makeReadyTask({ taskId: 'reopened-auto-audit', auditPolicy: 'auto_allow_degraded', registry });
      registry.close();
      registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.get(ready.taskId)?.auditPolicy).toBe('auto_allow_degraded');
      const dispatch = vi.fn(async (_caller: SendRuntimeCaller, input: SendMessageInput) => {
        const created = registry.createAssignment({
          taskId: ready.taskId,
          role: 'auditor',
          identity: identity('deck_alpha_auditor', 'claude-code-sdk', 'anthropic'),
          auditAttemptId: input.audit!.attemptId,
          auditRevision: ready.revision,
          idempotencyKey: `send:${input.idempotencyKey}`,
        });
        if (!created.ok) throw new Error(created.reason);
        return {
          status: 'accepted' as const,
          dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000000' as const,
          messageId: 'send_message_00000000-0000-5000-a000-000000000000' as SendMessageId,
          deliveries: [{ target: 'deck_alpha_auditor', status: 'queued' as const }],
          taskId: ready.taskId,
          assignmentId: created.value.assignmentId,
        };
      });
      await expect(dispatchReadyAuditSweep({
        registry,
        listSessions: () => [
          session('deck_alpha_brain', 'brain'),
          session('deck_alpha_worker', 'w1'),
          session('deck_alpha_auditor', 'w2', 'claude-code-sdk', 'anthropic'),
        ],
        listTargets: listTargetRecords(session('deck_alpha_auditor', 'w2', 'claude-code-sdk', 'anthropic')),
        dispatch,
        hasDeliveryEvidence: () => false,
      })).resolves.toEqual([expect.objectContaining({
        status: 'dispatched', attemptId: automaticAttempt(ready.taskId, ready.revision),
      })]);
      expect(dispatch).toHaveBeenCalledOnce();
    } finally {
      registry.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('auto-provisions before considering an existing busy cross-vendor auditor', async () => {
    const { registry, taskId } = makeReadyTask({ auditPolicy: 'auto_allow_degraded' });
    const sessions = [
      session('deck_alpha_brain', 'brain'),
      session('deck_alpha_worker', 'w1'),
      session('deck_alpha_busy_auditor', 'w2', 'claude-code-sdk', 'anthropic'),
    ];
    const dispatch = vi.fn().mockResolvedValue({
      status: 'accepted',
      dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000000',
      messageId: 'send_message_00000000-0000-5000-a000-000000000000',
      deliveries: [{ target: 'deck_alpha_spawned_auditor', status: 'queued' }],
      taskId,
      assignmentId: 'assignment-spawned-auditor',
    });
    const result = await dispatchReadyAudit(taskId, {
      registry,
      listSessions: () => sessions,
      listTargets: () => ({
        status: 'ok',
        executionPoolsState: 'configured',
        appliedExecutionPool: 'primary',
        items: [{
          target: 'deck_alpha_busy_auditor',
          label: 'busy auditor',
          sessionName: 'deck_alpha_busy_auditor',
          role: 'w2',
          agentType: 'claude-code-sdk',
          status: 'busy',
          lastActiveAt: 2,
          providerFamily: 'anthropic',
          availability: 'busy',
          eligiblePools: ['primary'],
          dispatchMode: 'queue_only',
          limitGroup: 'claude',
          replyCapable: true,
        }],
      }),
      dispatch,
      hasDeliveryEvidence: () => false,
    });
    expect(result).toMatchObject({ status: 'dispatched', assignmentId: 'assignment-spawned-auditor' });
    expect(dispatch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      task: expect.objectContaining({ autoProvision: true }),
      internalDurableQueue: true,
    }));
    expect(dispatch.mock.calls[0]![1]).not.toHaveProperty('target');
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('delegates spawning to the existing exact provider/model/preset pool provisioner', async () => {
    const registry = getSupervisionTaskRegistry();
    const { taskId } = makeReadyTask({ auditPolicy: 'auto_allow_degraded', registry });
    const selected = {
      agentType: 'claude-code-sdk', providerFamily: 'anthropic', runtimeType: 'transport' as const,
      model: 'claude-sonnet-4-6', capabilityId: '',
    };
    selected.capabilityId = buildSupervisionExecutionCapabilityId(selected);
    const brain = session('deck_alpha_brain', 'brain');
    brain.transportConfig = {
      supervision: normalizeSessionSupervisionSnapshot({
        mode: 'supervised_audit',
        executionPools: {
          state: 'configured',
          primaryDevelopmentPool: { configs: [selected], controls: { maxSpawned: 2 } },
          economyTaskPool: { configs: [], controls: { maxSpawned: 0 } },
        },
      }),
    };
    const worker = session('deck_alpha_worker', 'w1');
    const spawned = session('deck_alpha_spawned', 'w2', selected.agentType, selected.providerFamily);
    let sessions = [brain, worker];
    const provisionSupervisionTarget = vi.fn(async (request) => {
      expect(request).toMatchObject({
        parentSessionName: brain.name,
        pool: 'primary',
        auditedSessionName: worker.name,
        provenance: 'automatic_supervision',
      });
      sessions = [brain, worker, spawned];
      return {
        ok: true as const,
        target: spawned,
        evidence: {
          selectedPool: 'audit' as const,
          selectedConfig: selected,
          origin: 'spawned' as const,
          provisionAttemptId: 'supervision_provision_exact',
          createdSessionName: spawned.name,
        },
        auditRoutingReason: 'cross_vendor_preferred' as const,
      };
    });
    const dispatchMessage = vi.fn().mockResolvedValue('queued');
    const ensureSupervisionAssignmentWorktree = vi.fn(async (input: { assignmentId: string }) => ({
      ok: true as const,
      worktreePath: `/worktrees/${input.assignmentId}/repo`,
      baseRevision: 'a'.repeat(40),
      created: true,
    }));
    const dispatch = (caller: SendRuntimeCaller, input: SendMessageInput) => dispatchSendMessage(caller, input, {
      listSessions: () => sessions,
      provisionSupervisionTarget,
      dispatchMessage,
      ensureSupervisionAssignmentWorktree,
    });

    await expect(dispatchReadyAudit(taskId, {
      registry,
      listSessions: () => sessions,
      listTargets: () => ({
        status: 'ok', executionPoolsState: 'configured', appliedExecutionPool: 'primary', items: [],
      }),
      dispatch,
      hasDeliveryEvidence: () => false,
    })).resolves.toMatchObject({ status: 'dispatched' });
    expect(provisionSupervisionTarget).toHaveBeenCalledOnce();
    expect(ensureSupervisionAssignmentWorktree).toHaveBeenCalledOnce();
    expect(dispatchMessage).toHaveBeenCalledOnce();
    expect(registry.listAssignments(taskId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'auditor',
        identity: expect.objectContaining({
          sessionName: spawned.name,
          agentType: selected.agentType,
          providerFamily: selected.providerFamily,
        }),
        executionBinding: expect.objectContaining({
          origin: 'spawned',
          requested: expect.objectContaining({
            capabilityId: selected.capabilityId,
            agentType: selected.agentType,
            providerFamily: selected.providerFamily,
            runtimeType: selected.runtimeType,
          }),
        }),
      }),
    ]));
  });

  it('uses a busy same-family FIFO only after auto-provision is explicitly capacity-blocked', async () => {
    const { registry, taskId } = makeReadyTask({ auditPolicy: 'auto_allow_degraded' });
    const sessions = [
      session('deck_alpha_brain', 'brain'),
      session('deck_alpha_worker', 'w1'),
      session('deck_alpha_busy_peer', 'w2'),
    ];
    const dispatch = vi.fn(async (_caller: SendRuntimeCaller, input: SendMessageInput) => input.target
      ? {
          status: 'accepted' as const,
          dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000000' as const,
          messageId: 'send_message_00000000-0000-5000-a000-000000000000' as SendMessageId,
          deliveries: [{ target: input.target, status: 'queued' as const }],
          taskId,
          assignmentId: 'assignment-busy-peer',
        }
      : {
          status: 'error' as const,
          reason: 'validation_failed' as const,
          error: 'supervision target provisioning blocked: max_spawned',
          provisioning: { selectedPool: 'audit' as const, failureReason: 'max_spawned' as const },
        });
    await expect(dispatchReadyAudit(taskId, {
      registry,
      listSessions: () => sessions,
      listTargets: () => ({
        status: 'ok', executionPoolsState: 'configured', appliedExecutionPool: 'primary',
        items: [{
          target: 'deck_alpha_busy_peer', label: null, sessionName: 'deck_alpha_busy_peer', role: 'w2',
          agentType: 'codex-sdk', status: 'busy', lastActiveAt: 2, providerFamily: 'openai',
          availability: 'busy', eligiblePools: ['primary'], dispatchMode: 'queue_only',
          limitGroup: 'codex', replyCapable: true,
        }],
      }),
      dispatch,
      hasDeliveryEvidence: () => false,
    })).resolves.toMatchObject({ status: 'dispatched', assignmentId: 'assignment-busy-peer' });
    expect(dispatch).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({
      task: expect.objectContaining({ autoProvision: true }),
    }));
    expect(dispatch.mock.calls[0]![1]).not.toHaveProperty('target');
    expect(dispatch).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({
      target: 'deck_alpha_busy_peer',
      task: expect.not.objectContaining({ autoProvision: true }),
    }));

    const strict = makeReadyTask({ taskId: 'strict-busy-peer', auditPolicy: 'auto_strict_cross_vendor' });
    const strictDispatch = vi.fn(async (_caller: SendRuntimeCaller, input: SendMessageInput) => input.audit
      ? {
          status: 'error' as const,
          reason: 'validation_failed' as const,
          error: 'supervision target provisioning blocked: max_spawned',
          provisioning: { selectedPool: 'audit' as const, failureReason: 'max_spawned' as const },
        }
      : {
          status: 'accepted' as const,
          dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000001' as const,
          messageId: input.internalMessageId!,
          deliveries: [{ target: 'deck_alpha_brain', status: 'queued' as const }],
        });
    await expect(dispatchReadyAudit(strict.taskId, {
      registry: strict.registry,
      listSessions: () => sessions,
      listTargets: () => ({
        status: 'ok', executionPoolsState: 'configured', appliedExecutionPool: 'primary',
        items: [{
          target: 'deck_alpha_busy_peer', label: null, sessionName: 'deck_alpha_busy_peer', role: 'w2',
          agentType: 'codex-sdk', status: 'busy', lastActiveAt: 2, providerFamily: 'openai',
          availability: 'busy', eligiblePools: ['primary'], dispatchMode: 'queue_only',
          limitGroup: 'codex', replyCapable: true,
        }],
      }),
      dispatch: strictDispatch,
      hasDeliveryEvidence: () => false,
    })).resolves.toMatchObject({
      status: 'blocked',
      reason: 'supervision target provisioning blocked: max_spawned',
      reported: true,
    });
    expect(strictDispatch).toHaveBeenCalledTimes(2);
    expect(strictDispatch.mock.calls[1]![1]).toMatchObject({ target: 'deck_alpha_brain' });
    expect(strictDispatch.mock.calls[1]![1]).not.toHaveProperty('audit');
  });

  it('ignores a preferred process candidate and selects the eligible transport target', async () => {
    const { registry, taskId } = makeReadyTask({ auditPolicy: 'auto_allow_degraded' });
    const processPeer = session('deck_alpha_process', 'w2', 'claude-code', 'anthropic');
    processPeer.runtimeType = 'process';
    const transportPeer = session('deck_alpha_transport', 'w2');
    const sessions = [session('deck_alpha_brain', 'brain'), session('deck_alpha_worker', 'w1'), processPeer, transportPeer];
    const dispatch = vi.fn().mockResolvedValue({
      status: 'accepted',
      dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000010',
      messageId: 'send_message_00000000-0000-5000-a000-000000000010',
      deliveries: [{ target: transportPeer.name, status: 'queued' }],
      taskId,
      assignmentId: 'assignment-transport-auditor',
    });

    await expect(dispatchReadyAudit(taskId, {
      registry,
      listSessions: () => sessions,
      listTargets: listTargetRecords(processPeer, transportPeer),
      dispatch,
      hasDeliveryEvidence: () => false,
    })).resolves.toMatchObject({ status: 'dispatched', assignmentId: 'assignment-transport-auditor' });
    expect(dispatch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      target: transportPeer.name,
      internalDurableQueue: true,
    }));
  });

  it('reuses the production send path with live cross-vendor routing and durable deterministic delivery', async () => {
    const registry = getSupervisionTaskRegistry();
    const { taskId, revision } = makeReadyTask({
      taskId: 'production-auto-audit',
      auditPolicy: 'auto_allow_degraded',
      registry,
    });
    const openai = {
      agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport' as const, model: 'gpt-5.6',
    };
    const anthropic = {
      agentType: 'claude-code-sdk', providerFamily: 'anthropic', runtimeType: 'transport' as const, model: 'claude-sonnet-4-6',
    };
    const brain = session('deck_alpha_brain', 'brain');
    brain.transportConfig = {
      supervision: normalizeSessionSupervisionSnapshot({
        mode: 'supervised_audit',
        auditTargetSessionName: 'deck_alpha_auditor',
        executionPools: {
          state: 'configured',
          primaryDevelopmentPool: {
            configs: [
              { ...openai, capabilityId: buildSupervisionExecutionCapabilityId(openai) },
              { ...anthropic, capabilityId: buildSupervisionExecutionCapabilityId(anthropic) },
            ],
            controls: { maxSpawned: 2 },
          },
          economyTaskPool: { configs: [], controls: { maxSpawned: 0 } },
        },
      }),
    };
    const worker = session('deck_alpha_worker', 'w1');
    const auditor = session('deck_alpha_auditor', 'w2', 'claude-code-sdk', 'anthropic');
    const sessions = [brain, worker, auditor];
    const dispatchMessage = vi.fn().mockResolvedValue('queued');
    const dispatch = (caller: SendRuntimeCaller, input: SendMessageInput) => dispatchSendMessage(caller, input, {
      listSessions: () => sessions,
      dispatchMessage,
      provisionSupervisionTarget: async () => ({
        ok: true,
        target: auditor,
        evidence: {
          selectedPool: 'audit',
          selectedConfig: { ...anthropic, capabilityId: buildSupervisionExecutionCapabilityId(anthropic) },
          origin: 'reused',
        },
        auditRoutingReason: 'cross_vendor_preferred',
      }),
      ensureSupervisionAssignmentWorktree: async ({ assignmentId }) => ({
        ok: true,
        worktreePath: `/worktrees/${assignmentId}/repo`,
        baseRevision: 'a'.repeat(40),
        created: true,
      }),
    });

    const result = await dispatchReadyAudit(taskId, {
      registry,
      listSessions: () => sessions,
      listTargets: listTargetRecords(auditor),
      dispatch,
      hasDeliveryEvidence: () => false,
    });

    expect(result, JSON.stringify(result)).toMatchObject({ status: 'dispatched', attemptId: automaticAttempt(taskId, revision) });
    expect(dispatchMessage).toHaveBeenCalledOnce();
    const options = dispatchMessage.mock.calls[0]![2];
    expect(options).toMatchObject({
      durableQueue: true,
      supervision: { taskId, assignmentId: result.status === 'dispatched' ? result.assignmentId : '' },
    });
    expect(options.messageId).toMatch(/^send_message_[0-9a-f-]{36}$/);
    expect(registry.get(result.status === 'dispatched' ? taskId : '')?.assignments)
      .toEqual(expect.arrayContaining([expect.objectContaining({
        role: 'auditor',
        identity: expect.objectContaining({ sessionName: auditor.name }),
        auditAttemptId: automaticAttempt(taskId, revision),
        auditRevision: revision,
        auditRoutingReason: 'cross_vendor_preferred',
      })]));
    expect(dispatchMessage.mock.calls[0]![1]).toContain('"automaticAudit":true');
    expect(dispatchMessage.mock.calls[0]![1]).toContain('peer_audit_reply');
  });

  it('recovers the assignment-before-enqueue crash with the same target and strict policy', async () => {
    const { registry, taskId, revision } = makeReadyTask({ auditPolicy: 'auto_strict_cross_vendor' });
    const attemptId = automaticAttempt(taskId, revision);
    const auditor = registry.createAssignment({
      taskId,
      role: 'auditor',
      identity: identity('deck_alpha_auditor', 'claude-code-sdk', 'anthropic'),
      auditAttemptId: attemptId,
      auditRevision: revision,
      idempotencyKey: `send:auto-audit:${taskId}:${revision}`,
    });
    if (!auditor.ok) throw new Error(auditor.reason);
    const dispatch = vi.fn(async (_caller: SendRuntimeCaller, input: SendMessageInput) => ({
      status: 'accepted' as const,
      dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000000' as const,
      messageId: 'send_message_00000000-0000-5000-a000-000000000000' as SendMessageId,
      deliveries: [{ target: input.target!, status: 'queued' as const }],
      taskId,
      assignmentId: auditor.value.assignmentId,
    }));
    const result = await dispatchReadyAudit(taskId, {
      registry,
      listSessions: () => [
        session('deck_alpha_brain', 'brain'),
        session('deck_alpha_worker', 'w1'),
        session('deck_alpha_auditor', 'w2', 'claude-code-sdk', 'anthropic'),
      ],
      dispatch,
      hasDeliveryEvidence: () => false,
    });
    expect(result).toMatchObject({ status: 'dispatched', assignmentId: auditor.value.assignmentId, attemptId });
    expect(dispatch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      target: 'deck_alpha_auditor',
      audit: expect.objectContaining({ strictCrossVendor: true }),
      task: expect.not.objectContaining({ autoProvision: true }),
      internalDurableQueue: true,
    }));
  });

  it('treats reopened transport pending evidence as the same visible automatic delivery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'imcodes-auto-audit-transport-pending-'));
    vi.stubEnv('IMCODES_TRANSPORT_QUEUE_DB_PATH', join(root, 'queue.sqlite'));
    resetTransportQueueStoreForTests();
    const { registry, taskId, revision } = makeReadyTask({ auditPolicy: 'auto_allow_degraded' });
    const attemptId = automaticAttempt(taskId, revision);
    const created = registry.createAssignment({
      taskId,
      role: 'auditor',
      identity: identity('deck_alpha_auditor', 'claude-code-sdk', 'anthropic'),
      auditAttemptId: attemptId,
      auditRevision: revision,
      idempotencyKey: `send:auto-audit:${taskId}:${revision}`,
    });
    if (!created.ok) throw new Error(created.reason);
    const messageId = automaticMessageId(created.value.assignmentId, attemptId);
    const auditor = session('deck_alpha_auditor', 'w2', 'claude-code-sdk', 'anthropic');
    getTransportQueueStore().enqueue({
      sessionName: auditor.name,
      clientMessageId: messageId,
      commandId: messageId,
      text: 'bounded automatic audit brief',
    });
    resetTransportQueueStoreForTests();
    const dispatch = vi.fn();

    try {
      await expect(dispatchReadyAudit(taskId, {
        registry,
        listSessions: () => [session('deck_alpha_brain', 'brain'), session('deck_alpha_worker', 'w1'), auditor],
        dispatch,
      })).resolves.toMatchObject({ status: 'replayed', assignmentId: created.value.assignmentId, messageId });
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      resetTransportQueueStoreForTests();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('boot-recovers a pre-provider handoff and resends the same deterministic id once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'imcodes-auto-audit-handoff-restart-'));
    vi.stubEnv('IMCODES_TRANSPORT_QUEUE_DB_PATH', join(root, 'queue.sqlite'));
    resetTransportQueueStoreForTests();
    const { registry, taskId, revision } = makeReadyTask({ auditPolicy: 'auto_allow_degraded' });
    const attemptId = automaticAttempt(taskId, revision);
    const auditorName = 'deck_alpha_opencode_auditor';
    const created = registry.createAssignment({
      taskId,
      role: 'auditor',
      identity: identity(auditorName, 'opencode-sdk', 'openai'),
      auditAttemptId: attemptId,
      auditRevision: revision,
      idempotencyKey: `send:auto-audit:${taskId}:${revision}`,
    });
    if (!created.ok) throw new Error(created.reason);
    const messageId = automaticMessageId(created.value.assignmentId, attemptId);
    const store = getTransportQueueStore();
    store.enqueue({
      sessionName: auditorName,
      clientMessageId: messageId,
      commandId: messageId,
      text: 'bounded automatic audit brief',
      now: 100,
    });
    store.markHandoffInFlight(auditorName, [messageId], 60_000, 200);
    const dispatch = vi.fn(async (_caller: SendRuntimeCaller, input: SendMessageInput) => {
      expect(input.internalMessageId).toBe(messageId);
      getTransportQueueStore().finalizeSent(auditorName, messageId, undefined, 300);
      return {
        status: 'accepted' as const,
        dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000020' as const,
        messageId,
        deliveries: [{ target: auditorName, status: 'queued' as const }],
        taskId,
        assignmentId: created.value.assignmentId,
      };
    });
    const auditor = session(auditorName, 'w2', 'opencode-sdk', 'openai');
    const deps = {
      registry,
      listSessions: () => [session('deck_alpha_brain', 'brain'), session('deck_alpha_worker', 'w1'), auditor],
      listTargets: listTargetRecords(auditor),
      dispatch,
      now: () => 201,
    };

    try {
      await expect(dispatchReadyAuditSweep(deps)).resolves.toEqual([
        expect.objectContaining({ status: 'dispatched', assignmentId: created.value.assignmentId, messageId }),
      ]);
      await expect(dispatchReadyAuditSweep(deps)).resolves.toEqual([
        expect.objectContaining({ status: 'replayed', assignmentId: created.value.assignmentId, messageId }),
      ]);
      expect(dispatch).toHaveBeenCalledOnce();
      expect(getTransportQueueStore().hasDeliveryTombstone(auditorName, messageId)).toBe(true);
    } finally {
      resetTransportQueueStoreForTests();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a live authorized transport without replyCapable or provider durable-id claims', async () => {
    const { registry, taskId } = makeReadyTask({ auditPolicy: 'auto_allow_degraded' });
    const transport = session('deck_alpha_custom', 'w2', 'custom-transport-adapter', 'openai');
    const dispatch = vi.fn().mockResolvedValue({
      status: 'accepted',
      dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000021',
      messageId: 'send_message_00000000-0000-5000-a000-000000000021',
      deliveries: [{ target: transport.name, status: 'queued' }],
      taskId,
      assignmentId: 'assignment-live-transport-auditor',
    });

    await expect(dispatchReadyAudit(taskId, {
      registry,
      listSessions: () => [session('deck_alpha_brain', 'brain'), session('deck_alpha_worker', 'w1'), transport],
      listTargets: listTargetRecords(transport),
      dispatch,
      hasDeliveryEvidence: () => false,
    })).resolves.toMatchObject({ status: 'dispatched', assignmentId: 'assignment-live-transport-auditor' });
    expect(dispatch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ target: transport.name }));
  });

  it('never materializes an auditor for a policy-less task during boot recovery (tsk_5ny)', async () => {
    // tsk_5ny. With supervision off/manual a task is created with NO auditPolicy.
    // Boot recovery must not retroactively adopt a default policy and hand the
    // task an auditor it never asked for: "no policy" is a durable fact, not a
    // gap to be repaired on the next daemon start.
    const manual = makeReadyTask({ taskId: 'boot-sweep-manual-task' });
    const automatic = makeReadyTask({
      taskId: 'boot-sweep-automatic-task',
      auditPolicy: 'auto_allow_degraded',
      registry: manual.registry,
    });
    expect(manual.registry.get(manual.taskId)?.auditPolicy).toBeUndefined();
    expect(manual.registry.get(automatic.taskId)?.auditPolicy).toBe('auto_allow_degraded');

    const dispatched: string[] = [];
    const swept = await dispatchReadyAuditSweep({
      registry: manual.registry,
      listSessions: () => [],
      dispatch: (async (...args: unknown[]) => {
        dispatched.push(String((args[1] as { target?: string } | undefined)?.target ?? 'unknown'));
        return { ok: false };
      }) as never,
    });

    // CONTRACT REVISED (tsk_byk). This used to assert the policy-less task was
    // not SELECTED at all. An actionable dead end is now deliberately selected,
    // so it can be REPORTED once instead of sitting silently stuck. The
    // load-bearing half is unchanged and still pinned below: selection must
    // never turn into an auditor. Selection is reported, never materialised.
    expect(swept).toHaveLength(2);
    const manualResult = swept.find((result) => result.status === 'blocked'
      && result.reason === 'missing_audit_policy');
    expect(manualResult, 'the actionable dead end is selected and reported').toBeTruthy();
    expect(
      swept.some((result) => result.status === 'dispatched' || result.status === 'replayed'
        ? false
        : result.status === 'blocked' && result.reason === 'manual_policy'),
      'a selected task is never reported as manual_policy',
    ).toBe(false);
    const auditors = manual.registry.get(manual.taskId)?.assignments
      .filter((assignment) => assignment.role === 'auditor') ?? [];
    expect(auditors, 'boot sweep must not create an auditor without a policy').toEqual([]);
  });

  it('leaves legacy/manual tasks and a Brain-routed live fallback untouched', async () => {
    // CONTRACT REVISED (tsk_byk): this shape is an ACTIONABLE dead end, so it
    // is reported rather than silently ignored. With no live sessions supplied
    // there is no coordinator to notify, which is why reported is false -- the
    // task is still stuck, and saying so is the point. A genuinely manual or
    // non-actionable task keeps `ignored`/`manual_policy`; that is pinned in
    // "actionable missing audit policy emits one durable blocker" below.
    const legacy = makeReadyTask();
    await expect(dispatchReadyAudit(legacy.taskId, { registry: legacy.registry }))
      .resolves.toEqual({ status: 'blocked', reason: 'missing_audit_policy', reported: false });

    const automatic = makeReadyTask({ taskId: 'manual-fallback-task', auditPolicy: 'auto_allow_degraded' });
    const manual = automatic.registry.createAssignment({
      taskId: automatic.taskId,
      role: 'auditor',
      identity: identity('deck_alpha_auditor', 'claude-code-sdk', 'anthropic'),
      auditAttemptId: 'brain-manual-attempt',
      auditRevision: automatic.revision,
    });
    if (!manual.ok) throw new Error(manual.reason);
    const dispatch = vi.fn();
    await expect(dispatchReadyAudit(automatic.taskId, {
      registry: automatic.registry,
      listSessions: () => [
        session('deck_alpha_brain', 'brain'),
        session('deck_alpha_worker', 'w1'),
        session('deck_alpha_auditor', 'w2', 'claude-code-sdk', 'anthropic'),
      ],
      dispatch,
    })).resolves.toMatchObject({
      status: 'replayed', assignmentId: manual.value.assignmentId, attemptId: 'brain-manual-attempt',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('asks Brain exactly once for the same ambiguity across repeated ticks and changes no authority', async () => {
    // Genuine ambiguity is a Brain decision, but it must be asked ONCE: the
    // dedupe key has to be derived from (task, revision, exactError) so a
    // repeated tick or a restart recognises the question it already sent.
    // Evidence here is keyed by the exact messageId, so a drifting key shows up
    // as a second request rather than being masked by a boolean flag.
    const { registry, taskId, revision } = makeReadyTask({ auditPolicy: 'auto_strict_cross_vendor' });
    const second = registry.createAssignment({
      taskId, role: 'implementer', identity: identity('deck_alpha_worker2'),
      auditRevision: revision, scopeFiles: ['src/other.ts'],
    });
    if (!second.ok) throw new Error(second.reason);
    expect(registry.updateAssignment({
      assignmentId: second.value.assignmentId, identity: second.value.identity,
      status: 'ready_for_audit', revision, auditRevision: revision,
    } as never)).toMatchObject({ ok: true });

    const delivered = new Set<string>();
    const dispatch = vi.fn(async (_caller: SendRuntimeCaller, input: SendMessageInput) => {
      expect(input.audit).toBeUndefined(); // never an audit envelope: this is a question
      delivered.add(String(input.internalMessageId));
      return {
        status: 'accepted' as const,
        dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000000' as const,
        messageId: input.internalMessageId!,
        deliveries: [{ target: 'deck_alpha_brain', status: 'queued' as const }],
      };
    });
    const deps = {
      registry,
      listSessions: () => [
        session('deck_alpha_brain', 'brain'),
        session('deck_alpha_worker', 'w1'),
        session('deck_alpha_auditor', 'w2', 'claude-code-sdk', 'anthropic'),
      ],
      listTargets: listTargetRecords(session('deck_alpha_auditor', 'w2', 'claude-code-sdk', 'anthropic')),
      dispatch,
      hasDeliveryEvidence: (_s: string, messageId: SendMessageId) => delivered.has(String(messageId)),
    };

    const before = JSON.stringify(registry.get(taskId));
    const first = await dispatchReadyAudit(taskId, deps);
    const secondRun = await dispatchReadyAudit(taskId, deps);
    const third = await dispatchReadyAudit(taskId, deps);

    expect(first.status).toBe('blocked');
    expect(secondRun.status).toBe('blocked');
    expect(third.status).toBe('blocked');
    // ONE question, not one per tick.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(delivered.size).toBe(1);
    // And nothing was decided while waiting for the answer.
    expect(JSON.stringify(registry.get(taskId))).toBe(before);
  });

  it('leaves process-only candidates unmaterialized and reports one durable Brain blocker', async () => {
    const { registry, taskId } = makeReadyTask({ auditPolicy: 'auto_allow_degraded' });
    let blockerDelivered = false;
    const processPeer = session('deck_alpha_process', 'w2', 'claude-code', 'anthropic');
    processPeer.runtimeType = 'process';
    const offlineTransport = session('deck_alpha_offline', 'w2', 'claude-code-sdk', 'anthropic');
    offlineTransport.state = 'stopped';
    const dispatch = vi.fn(async (_caller: SendRuntimeCaller, input: SendMessageInput) => {
      if (input.audit) {
        expect(input.task).toMatchObject({ autoProvision: true });
        return {
          status: 'error' as const,
          reason: 'validation_failed' as const,
          error: 'supervision target provisioning blocked: no_selected_config',
          provisioning: { selectedPool: 'audit' as const, failureReason: 'no_selected_config' as const },
        };
      }
      const report = JSON.parse(input.message) as Record<string, unknown>;
      expect(Object.keys(report)).toEqual([
        'taskId', 'assignmentId', 'exactError', 'completedSafeWork', 'recommendedNextAction',
      ]);
      expect(report).toMatchObject({
        taskId,
        exactError: 'supervision target provisioning blocked: no_selected_config',
      });
      blockerDelivered = true;
      return {
        status: 'accepted' as const,
        dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000000' as const,
        messageId: input.internalMessageId!,
        deliveries: [{ target: 'deck_alpha_brain', status: 'queued' as const }],
      };
    });
    const deps = {
      registry,
      listSessions: () => [
        session('deck_alpha_brain', 'brain'), session('deck_alpha_worker', 'w1'), processPeer, offlineTransport,
      ],
      listTargets: listTargetRecords(processPeer, offlineTransport),
      dispatch,
      hasDeliveryEvidence: (_sessionName: string, _messageId: SendMessageId) => blockerDelivered,
    };
    await expect(dispatchReadyAudit(taskId, deps)).resolves.toMatchObject({
      status: 'blocked', reason: 'supervision target provisioning blocked: no_selected_config', reported: true,
    });
    await expect(dispatchReadyAudit(taskId, deps)).resolves.toMatchObject({
      status: 'blocked', reason: 'supervision target provisioning blocked: no_selected_config', reported: true,
    });
    expect(dispatch).toHaveBeenCalledTimes(3); // two deterministic provision attempts; one deduped blocker delivery
    expect(registry.listAssignments(taskId).filter((item) => item.role === 'auditor')).toEqual([]);
  });
});

describe('periodic supervision convergence tick', () => {
  /**
   * CC8 tsk_569 / CC9 tsk_5gi shape: the task is durably ready_for_audit with a
   * clear lease, but the only auditor on record is a finalized REWORK from an
   * OLDER revision. A boot-only sweep leaves this stranded forever while the
   * implementer keeps receiving meaningless heartbeats.
   */
  function staleReworkAuditor(registry: SupervisionTaskRegistry, taskId: string, staleRevision: string) {
    const stale = registry.createAssignment({
      taskId, role: 'auditor', required: false,
      identity: identity('deck_alpha_stale_auditor', 'claude-code-sdk', 'anthropic'),
      auditAttemptId: automaticAttempt(taskId, staleRevision),
      auditRevision: staleRevision,
    });
    if (!stale.ok) throw new Error(stale.reason);
    // The real shape is a CLOSED auditor from the previous revision: it carries
    // a REWORK verdict and is finalized, so it neither blocks a new auditor nor
    // satisfies the current revision.
    for (const status of ['auditing', 'rework'] as const) {
      expect(registry.updateAssignment({
        assignmentId: stale.value.assignmentId,
        identity: stale.value.identity,
        status,
        auditAttemptId: automaticAttempt(taskId, staleRevision),
        auditRevision: staleRevision,
        ...(status === 'rework' ? { verdict: 'REWORK' } : {}),
      } as never), `stale auditor -> ${status}`).toMatchObject({ ok: true });
    }
    expect(registry.finishAssignment({
      assignmentId: stale.value.assignmentId,
      identity: stale.value.identity,
      revision: staleRevision,
    })).toMatchObject({ ok: true });
    return registry.getAssignment(stale.value.assignmentId)!;
  }

  it('mutates NO lifecycle state when the exact attempt already has an accepted final receipt', async () => {
    // R12 audit P1: the preflight ran AFTER the implementer alignment write, so
    // a replay that correctly reported `final_receipt_recorded` had already
    // moved the owner implementing -> ready_for_audit. The next successor bind
    // then failed with `old_revision`. Readiness must never be inferred without
    // durable validation/handoff evidence, and a no-op must write nothing.
    __resetSupervisionConvergenceTickForTests();
    const { registry, taskId, revision } = makeReadyTask({ auditPolicy: 'auto_strict_cross_vendor' });
    const attemptId = automaticAttempt(taskId, revision);
    // The implementer is deliberately still `implementing` with no anchor: the
    // shape the alignment block would rewrite.
    const owner = registry.get(taskId)!.assignments.find((a) => a.role === 'implementer')!;
    expect(registry.coordinateTaskAssignment({
      taskId, assignmentId: owner.assignmentId, assignmentStatus: 'implementing',
      leaseAction: 'renew', idempotencyKey: 'preflight-shape', reason: 'return to implementer',
    } as never)).toMatchObject({ ok: true });
    expect(registry.getAssignment(owner.assignmentId)!.status).toBe('implementing');
    const auditor = registry.createAssignment({
      taskId, role: 'auditor', required: false,
      identity: identity('deck_alpha_auditor', 'claude-code-sdk', 'anthropic'),
      auditAttemptId: attemptId, auditRevision: revision,
    });
    if (!auditor.ok) throw new Error(auditor.reason);
    expect(registry.updateAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditor.value.identity,
      status: 'auditing', auditAttemptId: attemptId, auditRevision: revision,
    } as never)).toMatchObject({ ok: true });
    expect(registry.appendMatchingAuditReceipt({
      taskId, auditorAssignmentId: auditor.value.assignmentId,
      auditorIdentity: auditor.value.identity,
      auditorSessionName: auditor.value.identity.sessionName,
      attemptId, revision, receiptKind: 'final', verdict: 'REWORK',
      findings: 'already decided', validations: [],
    } as never)).toMatchObject({ ok: true });

    const before = JSON.stringify(registry.get(taskId));
    const sessions = [
      session('deck_alpha_brain', 'brain'),
      session('deck_alpha_worker', 'w1'),
      session('deck_alpha_auditor', 'w2', 'claude-code-sdk', 'anthropic'),
    ];
    const dispatch = vi.fn(async () => { throw new Error('must not dispatch'); });
    const result = await dispatchReadyAudit(taskId, {
      registry, listSessions: () => sessions,
      listTargets: listTargetRecords(sessions[2]!), dispatch,
      hasDeliveryEvidence: () => false,
    });

    expect(result).toMatchObject({ status: 'ignored', reason: 'final_receipt_recorded' });
    expect(dispatch).not.toHaveBeenCalled();
    // The decisive assertion: not one byte of lifecycle state moved.
    expect(JSON.stringify(registry.get(taskId))).toBe(before);
    expect(registry.getAssignment(owner.assignmentId)!.status).toBe('implementing');
  });

  it('no-ops before doing any work when the exact attempt already has an accepted final receipt', async () => {
    // tsk_4d0/asg_6h3 shape: a queued replay/heartbeat arrived for an attempt
    // whose auditor had ALREADY filed an accepted final PASS. The audit was
    // re-run end to end and only discovered at the very last step, via
    // attempt_mismatch on peer_audit_reply. The daemon must recognise the
    // closed receipt up front and deterministically do nothing.
    __resetSupervisionConvergenceTickForTests();
    const { registry, taskId, revision } = makeReadyTask({ auditPolicy: 'auto_strict_cross_vendor' });
    const attemptId = automaticAttempt(taskId, revision);
    const auditor = registry.createAssignment({
      taskId, role: 'auditor', required: false,
      identity: identity('deck_alpha_auditor', 'claude-code-sdk', 'anthropic'),
      auditAttemptId: attemptId, auditRevision: revision,
    });
    if (!auditor.ok) throw new Error(auditor.reason);
    expect(registry.updateAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditor.value.identity,
      status: 'auditing', auditAttemptId: attemptId, auditRevision: revision,
    } as never)).toMatchObject({ ok: true });
    expect(registry.appendMatchingAuditReceipt({
      taskId, auditorAssignmentId: auditor.value.assignmentId,
      auditorIdentity: auditor.value.identity,
      auditorSessionName: auditor.value.identity.sessionName,
      attemptId, revision, receiptKind: 'final', verdict: 'PASS',
      findings: 'exact frozen bytes verified', validations: [],
    } as never)).toMatchObject({ ok: true });
    // Deliberately do NOT run convergence first: a queued replay can arrive
    // before the tick that closes the auditor, and the preflight must not
    // depend on that ordering.
    expect(registry.getAssignment(auditor.value.assignmentId)!.status).toBe('auditing');
    expect(registry.get(taskId)!.status).toBe('ready_for_audit');

    const sessions = [
      session('deck_alpha_brain', 'brain'),
      session('deck_alpha_worker', 'w1'),
      session('deck_alpha_auditor', 'w2', 'claude-code-sdk', 'anthropic'),
    ];
    const dispatch = vi.fn(async () => { throw new Error('must not dispatch a second audit'); });
    const deps = {
      registry, listSessions: () => sessions,
      listTargets: listTargetRecords(sessions[2]!), dispatch,
      hasDeliveryEvidence: () => false,
    };

    const result = await dispatchReadyAudit(taskId, deps);

    expect(dispatch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'ignored', reason: 'final_receipt_recorded' });
    // No replacement auditor and no second attempt were minted.
    const auditors = registry.get(taskId)!.assignments.filter((a) => a.role === 'auditor');
    expect(auditors).toHaveLength(1);
    expect(auditors[0]!.auditAttemptId).toBe(attemptId);
    expect(registry.listAuditReceipts(taskId)).toHaveLength(1);
  });

  it('dispatches directly to the exact auditor with no live Brain coordinator session', async () => {
    // tsk_4d0 shape. The normal automatic path must not depend on a Brain
    // session being live: the daemon owns selection and delivery, and Brain is
    // only an exception path. Previously this blocked with
    // `automatic audit requires the live same-project Brain coordinator`,
    // which is what forced the manual two-step relay.
    __resetSupervisionConvergenceTickForTests();
    const { registry, taskId, revision } = makeReadyTask({ auditPolicy: 'auto_strict_cross_vendor' });
    const sessions = [
      session('deck_alpha_worker', 'w1'),
      session('deck_alpha_auditor', 'w2', 'claude-code-sdk', 'anthropic'),
    ];
    let evidence = false;
    const dispatch = vi.fn(async (_c: SendRuntimeCaller, input: SendMessageInput) => {
      const created = registry.createAssignment({
        taskId, role: 'auditor', required: false,
        identity: identity('deck_alpha_auditor', 'claude-code-sdk', 'anthropic'),
        auditAttemptId: input.audit!.attemptId,
        auditRevision: revision,
        idempotencyKey: `send:${input.idempotencyKey}`,
      });
      if (!created.ok) throw new Error(created.reason);
      evidence = true;
      return {
        status: 'accepted' as const,
        dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000000' as const,
        messageId: 'send_message_00000000-0000-5000-a000-000000000000' as SendMessageId,
        deliveries: [{ target: 'deck_alpha_auditor', status: 'queued' as const }],
        taskId,
        assignmentId: created.value.assignmentId,
      };
    });
    const deps = {
      registry, listSessions: () => sessions,
      listTargets: listTargetRecords(sessions[1]!), dispatch,
      hasDeliveryEvidence: () => evidence,
    };

    const first = await runSupervisionConvergenceTick(deps);

    expect(first.audits).toEqual([
      expect.objectContaining({ status: 'dispatched', attemptId: automaticAttempt(taskId, revision) }),
    ]);
    // Exactly one envelope, delivered straight to the auditor -- no Brain relay.
    expect(dispatch).toHaveBeenCalledTimes(1);
    const delivered = dispatch.mock.calls[0]![1];
    expect(delivered.target).toBe('deck_alpha_auditor');
    expect(delivered.audit?.attemptId).toBe(automaticAttempt(taskId, revision));
    expect(sessions.some((entry) => entry.name.endsWith('_brain'))).toBe(false);

    // Repeated ticks keep the SAME attempt and do not re-deliver.
    const second = await runSupervisionConvergenceTick(deps);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(second.audits).toEqual([
      expect.objectContaining({ attemptId: automaticAttempt(taskId, revision) }),
    ]);
  });

  it('redelivers one stale delegated auditor to the exact same assignment and attempt', async () => {
    const { registry, taskId, revision } = makeReadyTask({ auditPolicy: 'auto_strict_cross_vendor' });
    const attemptId = automaticAttempt(taskId, revision);
    const auditor = registry.createAssignment({
      taskId, role: 'auditor', required: false,
      identity: identity('deck_alpha_auditor', 'claude-code-sdk', 'anthropic'),
      auditAttemptId: attemptId, auditRevision: revision,
      idempotencyKey: `send:auto-audit:${taskId}:${revision}`,
      now: 100,
    });
    if (!auditor.ok) throw new Error(auditor.reason);
    const sessions = [
      session('deck_alpha_brain', 'brain'),
      session('deck_alpha_worker', 'w1'),
      session('deck_alpha_auditor', 'w2', 'claude-code-sdk', 'anthropic'),
    ];
    let evidenceChecks = 0;
    const dispatch = vi.fn(async (_caller: SendRuntimeCaller, input: SendMessageInput) => ({
      status: 'accepted' as const,
      dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000099' as const,
      messageId: input.internalMessageId!,
      deliveries: [{ target: sessions[2]!.name, status: 'queued' as const }],
      taskId,
      assignmentId: auditor.value.assignmentId,
    }));

    await expect(dispatchReadyAudit(taskId, {
      registry,
      listSessions: () => sessions,
      listTargets: listTargetRecords(sessions[2]!),
      dispatch,
      now: () => 100 + 11 * 60_000,
      // The original exact delivery was consumed; the distinct deterministic
      // redelivery id has no receipt yet.
      hasDeliveryEvidence: () => ++evidenceChecks === 1,
    })).resolves.toMatchObject({
      status: 'dispatched', assignmentId: auditor.value.assignmentId, attemptId,
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]![1]).toMatchObject({
      target: sessions[2]!.name,
      task: { assignmentId: auditor.value.assignmentId, auditAttemptId: attemptId, auditRevision: revision },
      audit: { attemptId },
    });
  });

  it('routes tsk_79u from the authoritative coordinator pool instead of the worker legacy snapshot', async () => {
    const { registry, taskId, revision } = makeReadyTask({
      taskId: 'tsk_79u', auditPolicy: 'auto_strict_cross_vendor',
    });
    const brain = session('deck_alpha_brain', 'brain');
    const worker = session('deck_alpha_worker', 'w1');
    const auditor = session('deck_alpha_auditor', 'w2', 'claude-code-sdk', 'anthropic');
    worker.transportConfig = {
      supervision: normalizeSessionSupervisionSnapshot({
        mode: 'supervised_audit', executionPools: { state: 'legacy_unconfigured' },
      }),
    };
    const selected = {
      agentType: 'claude-code-sdk', providerFamily: 'anthropic',
      runtimeType: 'transport' as const, model: 'claude-sonnet-4-6',
    };
    brain.transportConfig = {
      supervision: normalizeSessionSupervisionSnapshot({
        mode: 'supervised_audit',
        executionPools: {
          state: 'configured',
          primaryDevelopmentPool: {
            configs: [{ ...selected, capabilityId: buildSupervisionExecutionCapabilityId(selected) }],
            controls: { maxSpawned: 1 },
          },
          economyTaskPool: { configs: [], controls: { maxSpawned: 0 } },
        },
      }),
    };
    const sessions = [brain, worker, auditor];
    const listTargets = vi.fn((caller: SendRuntimeCaller) => {
      if (caller.sessionName !== brain.name) {
        return { status: 'ok' as const, executionPoolsState: 'legacy_unconfigured' as const, items: [] };
      }
      return listTargetRecords(auditor)();
    });
    const dispatch = vi.fn(async (_caller: SendRuntimeCaller, input: SendMessageInput) => {
      const created = registry.createAssignment({
        taskId, role: 'auditor', required: false,
        identity: identity(auditor.name, 'claude-code-sdk', 'anthropic'),
        auditAttemptId: input.audit!.attemptId, auditRevision: revision,
        idempotencyKey: `send:${input.idempotencyKey}`,
      });
      if (!created.ok) throw new Error(created.reason);
      return {
        status: 'accepted' as const,
        dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000079' as const,
        messageId: 'send_message_00000000-0000-5000-a000-000000000079' as SendMessageId,
        deliveries: [{ target: auditor.name, status: 'queued' as const }],
        taskId, assignmentId: created.value.assignmentId,
      };
    });

    await expect(dispatchReadyAudit(taskId, {
      registry, listSessions: () => sessions, listTargets, dispatch,
      hasDeliveryEvidence: () => false,
    })).resolves.toMatchObject({ status: 'dispatched' });
    expect(listTargets).toHaveBeenCalledTimes(1);
    expect(listTargets.mock.calls[0]![0]).toMatchObject({ sessionName: brain.name });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]![0]).toMatchObject({ sessionName: brain.name });
    expect(dispatch.mock.calls[0]![1]).toMatchObject({ target: auditor.name });
  });

  it('dispatches a ready_for_audit task from the periodic tick, not only the boot sweep', async () => {
    __resetSupervisionConvergenceTickForTests();
    const { registry, taskId, revision } = makeReadyTask({ auditPolicy: 'auto_strict_cross_vendor' });
    staleReworkAuditor(registry, taskId, `${revision}-older`);
    const sessions = [
      session('deck_alpha_brain', 'brain'),
      session('deck_alpha_worker', 'w1'),
      session('deck_alpha_auditor', 'w2', 'claude-code-sdk', 'anthropic'),
    ];
    let evidence = false;
    const dispatch = vi.fn(async (_c: SendRuntimeCaller, input: SendMessageInput) => {
      const created = registry.createAssignment({
        taskId, role: 'auditor', required: false,
        identity: identity('deck_alpha_auditor', 'claude-code-sdk', 'anthropic'),
        auditAttemptId: input.audit!.attemptId,
        auditRevision: revision,
        idempotencyKey: `send:${input.idempotencyKey}`,
      });
      if (!created.ok) throw new Error(created.reason);
      evidence = true;
      return {
        status: 'accepted' as const,
        dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000000' as const,
        messageId: 'send_message_00000000-0000-5000-a000-000000000000' as SendMessageId,
        deliveries: [{ target: 'deck_alpha_auditor', status: 'queued' as const }],
        taskId,
        assignmentId: created.value.assignmentId,
      };
    });
    const deps = {
      registry, listSessions: () => sessions,
      listTargets: listTargetRecords(sessions[2]!), dispatch,
      hasDeliveryEvidence: () => evidence,
    };

    const first = await runSupervisionConvergenceTick(deps);

    expect(first.audits).toEqual([
      expect.objectContaining({ status: 'dispatched', attemptId: automaticAttempt(taskId, revision) }),
    ]);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('runs the SAME convergence at boot as the periodic tick', async () => {
    // The boot pass and the tick had drifted into two selection rules: boot
    // selected only `auditPolicy` tasks and never ran `convergeLifecycle` at
    // all, so after a restart a stale coordinator epoch, an unprojected
    // revision, a passed validation or an already-recorded receipt sat
    // untouched until the first 60s watchdog. Restart must converge the same
    // set the tick converges, or daemon restart becomes a manual progress gate.
    __resetSupervisionConvergenceTickForTests();
    const { registry, taskId, revision } = makeReadyTask({ auditPolicy: 'auto_strict_cross_vendor' });
    const converge = vi.spyOn(registry, 'convergeLifecycle');
    const sessions = [
      session('deck_alpha_brain', 'brain'),
      session('deck_alpha_worker', 'w1'),
      session('deck_alpha_auditor', 'w2', 'claude-code-sdk', 'anthropic'),
    ];
    let evidence = false;
    const dispatch = vi.fn(async (_c: SendRuntimeCaller, input: SendMessageInput) => {
      const created = registry.createAssignment({
        taskId, role: 'auditor', required: false,
        identity: identity('deck_alpha_auditor', 'claude-code-sdk', 'anthropic'),
        auditAttemptId: input.audit!.attemptId,
        auditRevision: revision,
        idempotencyKey: `send:${input.idempotencyKey}`,
      });
      if (!created.ok) throw new Error(created.reason);
      evidence = true;
      return {
        status: 'accepted' as const,
        dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000000' as const,
        messageId: 'send_message_00000000-0000-5000-a000-000000000000' as SendMessageId,
        deliveries: [{ target: 'deck_alpha_auditor', status: 'queued' as const }],
        taskId,
        assignmentId: created.value.assignmentId,
      };
    });

    await expect(dispatchReadyAuditSweep({
      registry, listSessions: () => sessions,
      listTargets: listTargetRecords(sessions[2]!), dispatch,
      hasDeliveryEvidence: () => evidence,
    })).resolves.toEqual([
      expect.objectContaining({ status: 'dispatched', attemptId: automaticAttempt(taskId, revision) }),
    ]);
    expect(converge, 'the boot pass must run lifecycle convergence, not only dispatch')
      .toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('stays idempotent across repeated ticks and never reuses the older revision attempt', async () => {
    __resetSupervisionConvergenceTickForTests();
    const { registry, taskId, revision } = makeReadyTask({ auditPolicy: 'auto_allow_degraded' });
    const staleRevision = `${revision}-older`;
    staleReworkAuditor(registry, taskId, staleRevision);
    const sessions = [
      session('deck_alpha_brain', 'brain'),
      session('deck_alpha_worker', 'w1'),
      session('deck_alpha_auditor', 'w2', 'claude-code-sdk', 'anthropic'),
    ];
    let evidence = false;
    const dispatch = vi.fn(async (_c: SendRuntimeCaller, input: SendMessageInput) => {
      const created = registry.createAssignment({
        taskId, role: 'auditor', required: false,
        identity: identity('deck_alpha_auditor', 'claude-code-sdk', 'anthropic'),
        auditAttemptId: input.audit!.attemptId,
        auditRevision: revision,
        idempotencyKey: `send:${input.idempotencyKey}`,
      });
      if (!created.ok) throw new Error(created.reason);
      evidence = true;
      return {
        status: 'accepted' as const,
        dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000000' as const,
        messageId: 'send_message_00000000-0000-5000-a000-000000000000' as SendMessageId,
        deliveries: [{ target: 'deck_alpha_auditor', status: 'queued' as const }],
        taskId,
        assignmentId: created.value.assignmentId,
      };
    });
    const deps = {
      registry, listSessions: () => sessions,
      listTargets: listTargetRecords(sessions[2]!), dispatch,
      hasDeliveryEvidence: () => evidence,
    };

    await runSupervisionConvergenceTick(deps);
    const second = await runSupervisionConvergenceTick(deps);

    expect(second.audits).toEqual([expect.objectContaining({ status: 'replayed' })]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    // The stale REWORK attempt must never be reused for the current revision.
    const dispatched = dispatch.mock.calls[0]![1].audit!.attemptId;
    expect(dispatched).toBe(automaticAttempt(taskId, revision));
    expect(dispatched).not.toBe(automaticAttempt(taskId, staleRevision));
  });

  it('never mints or dispatches an auditor for a task without an audit policy', async () => {
    __resetSupervisionConvergenceTickForTests();
    const { registry, taskId } = makeReadyTask();
    const sessions = [
      session('deck_alpha_brain', 'brain'),
      session('deck_alpha_worker', 'w1'),
      session('deck_alpha_auditor', 'w2', 'claude-code-sdk', 'anthropic'),
    ];
    // CONTRACT REVISED (tsk_byk) in form, NOT in substance. The invariant this
    // test exists for -- a policy-less task never gets an auditor minted or an
    // audit dispatched -- is unchanged and asserted below. What changed is that
    // an actionable dead end now emits one durable BLOCKER to Brain, so the
    // mock records calls instead of throwing on any call at all, and the
    // assertion distinguishes an audit dispatch from a blocker report.
    const dispatch = vi.fn(async () => ({
      status: 'accepted' as const,
      dispatchId: 'send_dispatch_00000000-0000-4000-8000-0000000000c1',
      messageId: 'send_message_00000000-0000-5000-a000-0000000000c1' as SendMessageId,
      deliveries: [{ target: 'deck_alpha_brain', status: 'queued' as const }],
    }));
    const deps = {
      registry, listSessions: () => sessions,
      listTargets: listTargetRecords(sessions[2]!),
      dispatch: dispatch as never,
      hasDeliveryEvidence: () => false,
    };

    const result = await runSupervisionConvergenceTick(deps);

    expect(
      result.audits.some((audit) => audit.status === 'dispatched' || audit.status === 'replayed'),
      'no audit may be dispatched without a policy',
    ).toBe(false);
    expect(
      dispatch.mock.calls.some((call) => Boolean((call as unknown as [unknown, { audit?: unknown }])[1]?.audit)),
      'any dispatch here must be a blocker report, never an audit',
    ).toBe(false);
    expect(registry.listAssignments(taskId).filter((a) => a.role === 'auditor')).toEqual([]);
  });

  it('delivers one durable structured Brain request for conflicting cancelled completion evidence', async () => {
    __resetSupervisionConvergenceTickForTests();
    const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
    const taskId = 'cancelled-evidence-conflict-wire';
    expect(registry.createOrGet({ taskId, projectName: 'alpha', objective: 'preserve late frozen bytes' }))
      .toMatchObject({ ok: true });
    expect(registry.createAssignment({
      taskId, role: 'coordinator', required: false, identity: identity('deck_alpha_brain'),
    })).toMatchObject({ ok: true });
    const source = registry.createAssignment({
      taskId, role: 'implementer', required: true, identity: identity('deck_alpha_old'),
    });
    if (!source.ok) throw new Error(source.reason);
    expect(registry.applyTaskIntent({
      taskId, assignmentId: source.value.assignmentId, intent: 'cancel', toStatus: 'cancelled', now: 10,
    })).toMatchObject({ ok: true });
    const recorded = registry.recordCancelledCompletionEvidence({
      taskId, assignmentId: source.value.assignmentId, identity: source.value.identity,
      revision: 'late-r1', now: 20,
      worktreeSnapshot: {
        worktreePath: '/tmp/cancelled-source/repo', headSha: 'a'.repeat(40),
        files: [{ path: 'src/late.ts', sha256: '1'.repeat(64) }],
        stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
      },
    });
    if (!recorded.ok) throw new Error(recorded.reason);
    const successor = registry.createAssignment({
      taskId, role: 'implementer', required: true, identity: identity('deck_alpha_successor'),
    });
    if (!successor.ok) throw new Error(successor.reason);
    expect(registry.convergeLifecycle(30, {
      inspectAssignmentWorktree: () => ({
        worktreePath: '/tmp/successor/repo', headSha: 'b'.repeat(40),
        files: [{ path: 'src/late.ts', sha256: '9'.repeat(64) }],
        stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
      }),
    })).toContainEqual(expect.objectContaining({ action: 'request_cancelled_completion_evidence_decision' }));

    let delivered = false;
    const dispatch = vi.fn(async (_caller: SendRuntimeCaller, input: SendMessageInput) => {
      expect(input.target).toBe('deck_alpha_brain');
      expect(JSON.parse(input.message)).toMatchObject({
        taskId, actionRequired: 'adopt_or_discard', evidenceId: recorded.value.evidenceId,
        successorAssignmentId: successor.value.assignmentId,
      });
      delivered = true;
      return {
        status: 'accepted' as const,
        dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000042' as const,
        messageId: input.internalMessageId!,
        deliveries: [{ target: input.target!, status: 'queued' as const }],
      };
    });
    const deps = {
      registry,
      listSessions: () => [
        session('deck_alpha_brain', 'brain'), session('deck_alpha_successor', 'w2'),
      ],
      dispatch,
      hasDeliveryEvidence: () => delivered,
      runScheduledWorktreeGcBatch: vi.fn().mockResolvedValue({ status: 'cooldown' }),
    };
    await runSupervisionConvergenceTick(deps);
    await runSupervisionConvergenceTick(deps);
    expect(dispatch).toHaveBeenCalledTimes(1);
    registry.close();
  });

  it('wires every bounded convergence tick to the existing persistent worktree GC scheduler', async () => {
    __resetSupervisionConvergenceTickForTests();
    const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
    const runScheduledWorktreeGcBatch = vi.fn().mockResolvedValue({ status: 'cooldown' });
    await expect(runSupervisionConvergenceTick({
      registry,
      now: () => 79,
      listSessions: () => [],
      runScheduledWorktreeGcBatch,
    })).resolves.toMatchObject({ converged: [], audits: [] });
    expect(runScheduledWorktreeGcBatch).toHaveBeenCalledOnce();
    expect(runScheduledWorktreeGcBatch).toHaveBeenCalledWith(79);
    registry.close();
  });

  it('is re-entrancy guarded so overlapping ticks cannot double dispatch', async () => {
    __resetSupervisionConvergenceTickForTests();
    const { registry, taskId, revision } = makeReadyTask({ auditPolicy: 'auto_allow_degraded' });
    const sessions = [
      session('deck_alpha_brain', 'brain'),
      session('deck_alpha_worker', 'w1'),
      session('deck_alpha_auditor', 'w2', 'claude-code-sdk', 'anthropic'),
    ];
    let evidence = false;
    const dispatch = vi.fn(async (_c: SendRuntimeCaller, input: SendMessageInput) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const created = registry.createAssignment({
        taskId, role: 'auditor', required: false,
        identity: identity('deck_alpha_auditor', 'claude-code-sdk', 'anthropic'),
        auditAttemptId: input.audit!.attemptId,
        auditRevision: revision,
        idempotencyKey: `send:${input.idempotencyKey}`,
      });
      if (!created.ok) throw new Error(created.reason);
      evidence = true;
      return {
        status: 'accepted' as const,
        dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000000' as const,
        messageId: 'send_message_00000000-0000-5000-a000-000000000000' as SendMessageId,
        deliveries: [{ target: 'deck_alpha_auditor', status: 'queued' as const }],
        taskId,
        assignmentId: created.value.assignmentId,
      };
    });
    const deps = {
      registry, listSessions: () => sessions,
      listTargets: listTargetRecords(sessions[2]!), dispatch,
      hasDeliveryEvidence: () => evidence,
    };

    const [a, b] = await Promise.all([
      runSupervisionConvergenceTick(deps),
      runSupervisionConvergenceTick(deps),
    ]);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect([a.skipped, b.skipped].filter(Boolean)).toHaveLength(1);
  });
});

describe('legacy explicit-audit recovery (tsk_569 shape)', () => {
  const LEGACY_ATTEMPT = 'remote-desktop-media-stall-audit-20260903-r5-532fc509';

  /**
   * Exactly tsk_569: ready_for_audit at r5.532fc509, task has NO auditPolicy,
   * one required implementer already bound to that revision AND carrying an
   * explicit human-minted attempt, and only an older finalized REWORK auditor.
   * The explicit attempt is a pre-existing audit intent; a missing task-level
   * policy must not strand it forever.
   */
  function legacyShape(options: { attemptId?: string | null; implementerRevision?: string } = {}) {
    const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
    const taskId = 'tsk_569';
    const revision = 'r5.532fc509';
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'integration_task',
      objective: 'legacy explicit audit', currentRevision: revision,
    })).toMatchObject({ ok: true });
    expect(registry.createAssignment({
      taskId, role: 'coordinator', identity: identity('deck_alpha_brain'), required: false,
    })).toMatchObject({ ok: true });
    const worker = registry.createAssignment({
      taskId, role: 'implementer', identity: identity('deck_alpha_worker'),
      scopeFiles: ['src/exact.ts'],
      auditRevision: options.implementerRevision ?? revision,
      ...(options.attemptId === null ? {} : { auditAttemptId: options.attemptId ?? LEGACY_ATTEMPT }),
    } as never);
    if (!worker.ok) throw new Error(worker.reason);
    for (const [intent, toStatus] of [
      ['start', 'implementing'], ['record_validation', 'validated'], ['open_audit', 'ready_for_audit'],
    ] as const) {
      registry.applyTaskIntent({
        taskId, assignmentId: worker.value.assignmentId, intent,
        ...(intent === 'record_validation' ? { validationState: 'passed' } : {}),
        identity: worker.value.identity, toStatus,
      } as never);
    }
    return { registry, taskId, revision, worker: worker.value };
  }

  it('recovers the EXISTING explicit attempt rather than minting a canonical one', () => {
    const { registry, taskId, revision } = legacyShape();
    expect(registry.getTaskRecord(taskId)!.auditPolicy ?? null).toBeNull();

    const recovered = legacyExplicitAuditRecoveryAttempt(registry.get(taskId)!, registry);

    expect(recovered).toBe(LEGACY_ATTEMPT);
    // It must NEVER be replaced by the canonical auto attempt.
    expect(recovered).not.toBe(automaticAttempt(taskId, revision));
  });

  it('does not recover a task that has neither a policy nor an existing attempt', () => {
    const { registry, taskId } = legacyShape({ attemptId: null });

    expect(legacyExplicitAuditRecoveryAttempt(registry.get(taskId)!, registry)).toBeUndefined();
  });

  it('fails closed when the implementer attempt belongs to an older revision', () => {
    const { registry, taskId } = legacyShape({ implementerRevision: 'r4.older' });

    expect(legacyExplicitAuditRecoveryAttempt(registry.get(taskId)!, registry)).toBeUndefined();
  });

  it('fails closed when more than one required implementer could own the attempt', () => {
    const { registry, taskId, revision } = legacyShape();
    const second = registry.createAssignment({
      taskId, role: 'implementer', identity: identity('deck_alpha_second'),
      scopeFiles: ['src/other.ts'], auditRevision: revision, auditAttemptId: 'another-attempt',
    } as never);
    if (!second.ok) throw new Error(second.reason);

    expect(legacyExplicitAuditRecoveryAttempt(registry.get(taskId)!, registry)).toBeUndefined();
  });

  it('stops recovering once a live auditor already exists for the same revision', () => {
    const { registry, taskId, revision } = legacyShape();
    const auditor = registry.createAssignment({
      taskId, role: 'auditor', required: false, identity: identity('deck_alpha_auditor', 'claude-code-sdk', 'anthropic'),
      auditAttemptId: LEGACY_ATTEMPT, auditRevision: revision,
    } as never);
    if (!auditor.ok) throw new Error(auditor.reason);

    // Restart/replay must be a no-op, not a second materialization.
    expect(legacyExplicitAuditRecoveryAttempt(registry.get(taskId)!, registry)).toBeUndefined();
  });

  it('routes the recovered attempt through the periodic tick, never a canonical one', async () => {
    __resetSupervisionConvergenceTickForTests();
    const { registry, taskId, revision } = legacyShape();
    const sessions = [
      session('deck_alpha_brain', 'brain'),
      session('deck_alpha_worker', 'w1'),
      session('deck_alpha_auditor', 'w2', 'claude-code-sdk', 'anthropic'),
    ];
    let evidence = false;
    const dispatch = vi.fn(async (_c: SendRuntimeCaller, input: SendMessageInput) => {
      const created = registry.createAssignment({
        taskId, role: 'auditor', required: false,
        identity: identity('deck_alpha_auditor', 'claude-code-sdk', 'anthropic'),
        auditAttemptId: input.audit!.attemptId,
        auditRevision: revision,
        idempotencyKey: `send:${input.idempotencyKey}`,
      });
      if (!created.ok) throw new Error(created.reason);
      evidence = true;
      return {
        status: 'accepted' as const,
        dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000000' as const,
        messageId: 'send_message_00000000-0000-5000-a000-000000000000' as SendMessageId,
        deliveries: [{ target: 'deck_alpha_auditor', status: 'queued' as const }],
        taskId,
        assignmentId: created.value.assignmentId,
      };
    });
    const deps = {
      registry, listSessions: () => sessions,
      listTargets: listTargetRecords(sessions[2]!), dispatch,
      hasDeliveryEvidence: () => evidence,
    };

    const first = await runSupervisionConvergenceTick(deps);
    const second = await runSupervisionConvergenceTick(deps);

    // The pre-existing human attempt is routed as-is; no canonical attempt and
    // no auditPolicy is ever written to the task.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]![1].audit!.attemptId).toBe(LEGACY_ATTEMPT);
    expect(dispatch.mock.calls[0]![1].audit!.attemptId).not.toBe(automaticAttempt(taskId, revision));
    expect(registry.getTaskRecord(taskId)!.auditPolicy ?? null).toBeNull();
    expect(first.audits.concat(second.audits).some((a) => a.status === 'dispatched')).toBe(true);
    // Replay is a no-op, not a second auditor.
    expect(registry.listAssignments(taskId).filter((a) => a.role === 'auditor')).toHaveLength(1);
  });

  it('is stable across a restart: the same attempt is recovered, never a new one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'legacy-audit-'));
    const dbPath = join(dir, 'state.sqlite');
    try {
      let registry = new SupervisionTaskRegistry({ dbPath });
      const taskId = 'tsk_569';
      const revision = 'r5.532fc509';
      expect(registry.createOrGet({
        taskId, projectName: 'alpha', classification: 'integration_task',
        objective: 'legacy explicit audit', currentRevision: revision,
      })).toMatchObject({ ok: true });
      const worker = registry.createAssignment({
        taskId, role: 'implementer', identity: identity('deck_alpha_worker'),
        scopeFiles: ['src/exact.ts'], auditRevision: revision, auditAttemptId: LEGACY_ATTEMPT,
      } as never);
      if (!worker.ok) throw new Error(worker.reason);
      for (const [intent, toStatus] of [
        ['start', 'implementing'], ['record_validation', 'validated'], ['open_audit', 'ready_for_audit'],
      ] as const) {
        registry.applyTaskIntent({
          taskId, assignmentId: worker.value.assignmentId, intent,
          ...(intent === 'record_validation' ? { validationState: 'passed' } : {}),
          identity: worker.value.identity, toStatus,
        } as never);
      }
      const first = legacyExplicitAuditRecoveryAttempt(registry.get(taskId)!, registry);

      registry = new SupervisionTaskRegistry({ dbPath });
      const second = legacyExplicitAuditRecoveryAttempt(registry.get(taskId)!, registry);

      expect(first).toBe(LEGACY_ATTEMPT);
      expect(second).toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('R5: deterministic implementer/revision alignment before materialization', () => {
  /**
   * tsk_5oc shape: a valid REWORK closed round one, implementation resumed, and
   * the task is ready_for_audit again with exactly ONE non-terminal implementer
   * and an unambiguous currentRevision -- yet the strict filter demanded
   * status==='ready_for_audit' AND auditRevision===revision on the assignment,
   * found nothing, and returned
   * `automatic audit requires one exact ready implementer revision`.
   */
  function resumedAfterRework(revision = 'r5-resumed') {
    const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
    const taskId = 'tsk_5oc_shape';
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'integration_task',
      objective: 'resumed after rework', currentRevision: revision,
      auditPolicy: 'auto_strict_cross_vendor',
    })).toMatchObject({ ok: true });
    expect(registry.createAssignment({
      taskId, role: 'coordinator', identity: identity('deck_alpha_brain'), required: false,
    })).toMatchObject({ ok: true });
    const worker = registry.createAssignment({
      taskId, role: 'implementer', identity: identity('deck_alpha_worker'),
      auditRevision: revision, scopeFiles: ['src/exact.ts'],
    } as never);
    if (!worker.ok) throw new Error(worker.reason);
    // Round one ran and came back REWORK; implementation then resumed, so the
    // assignment sits at `implementing` while the TASK is ready_for_audit.
    for (const status of ['implementing', 'ready_for_audit', 'auditing', 'rework', 'implementing'] as const) {
      expect(registry.updateAssignment({
        assignmentId: worker.value.assignmentId, identity: worker.value.identity, status,
        auditRevision: revision,
        ...(status === 'rework' ? { verdict: 'REWORK' } : {}),
      } as never), `worker -> ${status}`).toMatchObject({ ok: true });
    }
    expect(registry.updateTask({ taskId, status: 'ready_for_audit' } as never)).toMatchObject({ ok: true });
    expect(registry.getTaskRecord(taskId)!.status).toBe('ready_for_audit');
    expect(registry.getAssignment(worker.value.assignmentId)!.status).toBe('implementing');
    return { registry, taskId, revision, worker: worker.value };
  }

  it('aligns the unique non-terminal implementer and materializes exactly one auditor', async () => {
    const { registry, taskId, revision, worker } = resumedAfterRework();
    const sessions = [
      session('deck_alpha_brain', 'brain'),
      session('deck_alpha_worker', 'w1'),
      session('deck_alpha_auditor', 'w2', 'claude-code-sdk', 'anthropic'),
    ];
    let evidence = false;
    const dispatch = vi.fn(async (_c: SendRuntimeCaller, input: SendMessageInput) => {
      // A blocker report also rides dispatch but carries no audit envelope.
      if (!input.audit) {
        return {
          status: 'accepted' as const,
          dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000000' as const,
          messageId: 'send_message_00000000-0000-5000-a000-000000000001' as SendMessageId,
          deliveries: [{ target: 'deck_alpha_brain', status: 'queued' as const }],
        };
      }
      const created = registry.createAssignment({
        taskId, role: 'auditor', required: false,
        identity: identity('deck_alpha_auditor', 'claude-code-sdk', 'anthropic'),
        auditAttemptId: input.audit.attemptId, auditRevision: revision,
        idempotencyKey: `send:${input.idempotencyKey}`,
      });
      if (!created.ok) throw new Error(created.reason);
      evidence = true;
      return {
        status: 'accepted' as const,
        dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000000' as const,
        messageId: 'send_message_00000000-0000-5000-a000-000000000000' as SendMessageId,
        deliveries: [{ target: 'deck_alpha_auditor', status: 'queued' as const }],
        taskId, assignmentId: created.value.assignmentId,
      };
    });

    const result = await dispatchReadyAudit(taskId, {
      registry, listSessions: () => sessions,
      listTargets: listTargetRecords(sessions[2]!), dispatch,
      hasDeliveryEvidence: () => evidence,
    });

    expect(result).toMatchObject({ status: 'dispatched', attemptId: automaticAttempt(taskId, revision) });
    // The projection was aligned atomically on the SAME assignment.
    const aligned = registry.getAssignment(worker.assignmentId)!;
    expect(aligned.assignmentId).toBe(worker.assignmentId);
    expect(aligned.auditRevision).toBe(revision);
    expect(registry.listAssignments(taskId).filter((a) => a.role === 'auditor')).toHaveLength(1);
  });

  it('refuses to align an implementer that is pinned to a different revision', () => {
    // Exactly one non-terminal implementer, but it carries a DIFFERENT revision.
    // Aligning it would silently move audited-scope bytes across a revision
    // boundary, so this must fail closed rather than converge.
    const { registry, taskId, revision, worker } = resumedAfterRework();
    expect(registry.updateAssignment({
      assignmentId: worker.assignmentId, identity: worker.identity,
      revision: `${revision}-other`, auditRevision: `${revision}-other`,
    } as never)).toMatchObject({ ok: true });
    expect(registry.getAssignment(worker.assignmentId)!.auditRevision).toBe(`${revision}-other`);
    expect(registry.updateTask({ taskId, status: 'ready_for_audit' } as never)).toMatchObject({ ok: true });

    return dispatchReadyAudit(taskId, {
      registry,
      listSessions: () => [session('deck_alpha_brain', 'brain'), session('deck_alpha_worker', 'w1')],
      listTargets: listTargetRecords(session('deck_alpha_brain', 'brain')),
      dispatch: vi.fn(async (_c: SendRuntimeCaller, input: SendMessageInput) => {
        if (input.audit) throw new Error('must not materialize across a revision boundary');
        return {
          status: 'accepted' as const,
          dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000000' as const,
          messageId: 'send_message_00000000-0000-5000-a000-000000000001' as SendMessageId,
          deliveries: [{ target: 'deck_alpha_brain', status: 'queued' as const }],
        };
      }) as never,
      hasDeliveryEvidence: () => false,
    }).then((result) => {
      expect(result).toMatchObject({ status: 'blocked' });
      // The pinned revision must be left exactly as it was.
      expect(registry.getAssignment(worker.assignmentId)!.auditRevision).toBe(`${revision}-other`);
      expect(registry.listAssignments(taskId).filter((a) => a.role === 'auditor')).toEqual([]);
    });
  });

  it('still fails closed when two non-terminal implementers make the choice ambiguous', async () => {
    const { registry, taskId, revision } = resumedAfterRework();
    const second = registry.createAssignment({
      taskId, role: 'implementer', identity: identity('deck_alpha_second'),
      auditRevision: revision, scopeFiles: ['src/other.ts'],
    } as never);
    if (!second.ok) throw new Error(second.reason);
    expect(registry.updateAssignment({
      assignmentId: second.value.assignmentId, identity: second.value.identity, status: 'implementing',
      auditRevision: revision,
    } as never)).toMatchObject({ ok: true });
    const sessions = [session('deck_alpha_brain', 'brain'), session('deck_alpha_worker', 'w1')];
    const dispatch = vi.fn(async (_c: SendRuntimeCaller, input: SendMessageInput) => {
      if (input.audit) throw new Error('must not materialize an auditor on ambiguity');
      return {
        status: 'accepted' as const,
        dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000000' as const,
        messageId: 'send_message_00000000-0000-5000-a000-000000000001' as SendMessageId,
        deliveries: [{ target: 'deck_alpha_brain', status: 'queued' as const }],
      };
    });

    const result = await dispatchReadyAudit(taskId, {
      registry, listSessions: () => sessions,
      listTargets: listTargetRecords(sessions[0]!), dispatch: dispatch as never,
      hasDeliveryEvidence: () => false,
    });

    expect(result).toMatchObject({ status: 'blocked' });
    expect(dispatch.mock.calls.some((call) => Boolean(call[1].audit))).toBe(false);
    expect(registry.listAssignments(taskId).filter((a) => a.role === 'auditor')).toEqual([]);
  });
});

/**
 * tsk_byk behaviour 1 — an actionable ready_for_audit dead end.
 *
 * A validated task that reaches ready_for_audit with NO auditPolicy was
 * refused SILENTLY: dispatchReadyAudit returned ignored/manual_policy and the
 * sweep pre-filtered the task out entirely, so neither the event-driven wire
 * nor the periodic tick ever reported it. Neither refusal is wrong in
 * isolation -- the defect is that the only path able to SUPPLY the missing
 * policy is unreachable in that state, so the task sits forever with no
 * auditor and no signal. It now emits exactly one durable, Brain-resolvable
 * blocker, while a genuinely manual or not-yet-actionable task keeps the old
 * silent `ignored` semantics.
 */
describe('actionable missing audit policy emits one durable blocker', () => {
  const brain = () => session('deck_alpha_brain', 'brain');
  const worker = () => session('deck_alpha_worker', 'w1');

  function acceptedDispatch() {
    return vi.fn().mockResolvedValue({
      status: 'accepted',
      dispatchId: 'send_dispatch_00000000-0000-4000-8000-0000000000b1',
      messageId: 'send_message_00000000-0000-5000-a000-0000000000b1',
      deliveries: [{ target: 'deck_alpha_brain', status: 'queued' }],
    });
  }

  it('reports missing_audit_policy instead of silently ignoring the task', async () => {
    const shape = makeReadyTask({ taskId: 'byk-actionable' });
    const dispatch = acceptedDispatch();
    const result = await dispatchReadyAudit(shape.taskId, {
      registry: shape.registry,
      listSessions: () => [brain(), worker()],
      dispatch,
      hasDeliveryEvidence: () => false,
    });
    expect(result, 'an actionable dead end must not be reported as ignored')
      .toMatchObject({ status: 'blocked', reason: 'missing_audit_policy', reported: true });
    expect(dispatch, 'exactly one durable blocker').toHaveBeenCalledTimes(1);
    const sent = dispatch.mock.calls[0]![1];
    expect(sent.target).toBe('deck_alpha_brain');
    expect(sent.message).toContain(shape.taskId);
    expect(sent.message).toContain('missing_audit_policy');
    expect(sent.internalDurableQueue).toBe(true);
    expect(shape.registry.listAssignments(shape.taskId).filter((a) => a.role === 'auditor'))
      .toEqual([]);
  });

  it('emits the blocker only once when durable delivery evidence already exists', async () => {
    const shape = makeReadyTask({ taskId: 'byk-once' });
    const dispatch = acceptedDispatch();
    const deps = {
      registry: shape.registry,
      listSessions: () => [brain(), worker()],
      dispatch,
      hasDeliveryEvidence: () => true,
    };
    const first = await dispatchReadyAudit(shape.taskId, deps);
    const second = await dispatchReadyAudit(shape.taskId, deps);
    expect(first).toMatchObject({ status: 'blocked', reason: 'missing_audit_policy', reported: true });
    expect(second).toMatchObject({ status: 'blocked', reason: 'missing_audit_policy', reported: true });
    expect(dispatch, 'delivery evidence must suppress a repeat blocker').not.toHaveBeenCalled();
  });

  it('keeps silent ignored semantics for a NON-actionable policy-less task', async () => {
    // Not ready_for_audit: nothing is owed here, so a blocker would be noise.
    const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
    expect(registry.createOrGet({
      taskId: 'byk-not-actionable', projectName: 'alpha', classification: 'integration_task',
      objective: 'idle', acceptance: ['none'], currentRevision: 'r1',
    })).toMatchObject({ ok: true });
    const dispatch = acceptedDispatch();
    const result = await dispatchReadyAudit('byk-not-actionable', {
      registry, listSessions: () => [brain(), worker()], dispatch, hasDeliveryEvidence: () => false,
    });
    expect(result).toMatchObject({ status: 'ignored' });
    expect(dispatch, 'a non-actionable task must emit no blocker').not.toHaveBeenCalled();
  });

  it('stays silent once an auditor already exists for the exact revision', async () => {
    const shape = makeReadyTask({ taskId: 'byk-has-auditor' });
    const auditor = shape.registry.createAssignment({
      taskId: shape.taskId, role: 'auditor', required: false,
      identity: identity('deck_alpha_auditor', 'claude-code-sdk', 'anthropic'),
      auditAttemptId: 'manual-attempt-1', auditRevision: shape.revision,
    });
    if (!auditor.ok) throw new Error(auditor.reason);
    const dispatch = acceptedDispatch();
    const result = await dispatchReadyAudit(shape.taskId, {
      registry: shape.registry, listSessions: () => [brain(), worker()], dispatch,
      hasDeliveryEvidence: () => false,
    });
    expect(result, 'a live auditor means nothing is stuck')
      .not.toMatchObject({ reason: 'missing_audit_policy' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('sweep SELECTS the actionable dead end and reports it', async () => {
    const shape = makeReadyTask({ taskId: 'byk-sweep-actionable' });
    const dispatch = acceptedDispatch();
    const swept = await dispatchReadyAuditSweep({
      registry: shape.registry,
      listSessions: () => [brain(), worker()],
      dispatch,
      hasDeliveryEvidence: () => false,
    });
    expect(
      swept.some((r) => r.status === 'blocked' && r.reason === 'missing_audit_policy'),
      'the sweep must SELECT the actionable dead end, not pre-filter it away',
    ).toBe(true);
  });
});

/**
 * tsk_byk behaviour 2 — legacy exact-PASS tasks stranded with ZERO coordinators.
 *
 * dispatchReadyIntegration hard-required exactly one live Brain coordinator
 * before it would materialise the integration owner. Legacy tasks created
 * before coordinator attribution existed have an exact current-revision final
 * PASS receipt, one required cross-vendor-PASS implementer and a clean
 * worktree, but ZERO coordinator rows -- so they can never integrate and
 * nothing reports why.
 *
 * The recovery is deliberately last: every existing PASS / revision / attempt /
 * receipt / clean-worktree gate runs FIRST and unchanged, and only then, when
 * there are no coordinator rows at all and exactly one compatible project Brain
 * exists, is a single non-required coordinator minted with a deterministic
 * idempotency key. The unchanged integration-owner path then runs. Ambiguous or
 * absent Brain, slices, missing PASS, and a dirty worktree create nothing.
 */
describe('zero-coordinator legacy integration recovery', () => {
  function zeroCoordinatorPassShape(taskId: string) {
    const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
    const revision = `${taskId}-r1`;
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'integration_task',
      objective: 'legacy integration with no coordinator row',
      acceptance: ['integrate exact PASS bytes'], currentRevision: revision,
      auditPolicy: 'auto_strict_cross_vendor',
    })).toMatchObject({ ok: true });
    // NOTE: deliberately NO coordinator assignment is created.
    const worker = registry.createAssignment({
      taskId, role: 'implementer', identity: identity('deck_alpha_worker'),
      auditRevision: revision, scopeFiles: ['src/exact.ts'],
    });
    if (!worker.ok) throw new Error(worker.reason);
    for (const [intent, toStatus, validationState] of [
      ['start', 'implementing', undefined],
      ['record_validation', 'validated', 'passed'],
      ['open_audit', 'ready_for_audit', undefined],
    ] as const) {
      expect(registry.applyTaskIntent({
        taskId, assignmentId: worker.value.assignmentId, intent, toStatus,
        ...(validationState ? { validationState } : {}),
      })).toMatchObject({ ok: true });
    }
    const attemptId = automaticAttempt(taskId, revision);
    const auditor = registry.createAssignment({
      taskId, role: 'auditor', required: false,
      identity: identity('deck_alpha_pass_auditor', 'claude-code-sdk', 'anthropic'),
      auditAttemptId: attemptId, auditRevision: revision,
    });
    if (!auditor.ok) throw new Error(auditor.reason);
    expect(registry.updateAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditor.value.identity,
      status: 'auditing', auditAttemptId: attemptId, auditRevision: revision,
    })).toMatchObject({ ok: true });
    expect(registry.appendMatchingAuditReceipt({
      taskId, auditorAssignmentId: auditor.value.assignmentId,
      auditorIdentity: auditor.value.identity, auditorSessionName: auditor.value.identity.sessionName,
      attemptId, revision, receiptKind: 'final', verdict: 'PASS',
      findings: 'exact bytes pass', validations: [],
    })).toMatchObject({ ok: true });
    expect(registry.finishAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditor.value.identity, revision,
    })).toMatchObject({ ok: true });
    expect(
      registry.listAssignments(taskId).filter((a) => a.role === 'coordinator'),
      'fixture must have ZERO coordinator rows',
    ).toEqual([]);
    return { registry, taskId, revision, attemptId, worker: worker.value };
  }

  const cleanWorktree = () => ({
    worktreePath: '/tmp/legacy/repo', headSha: 'a'.repeat(40),
    files: [{ path: 'src/exact.ts', sha256: '1'.repeat(64) }],
    stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
  });

  function acceptedDispatch() {
    return vi.fn().mockResolvedValue({
      status: 'accepted',
      dispatchId: 'send_dispatch_00000000-0000-4000-8000-0000000000b2',
      messageId: 'send_message_00000000-0000-5000-a000-0000000000b2',
      deliveries: [{ target: 'deck_alpha_brain', status: 'queued' }],
    });
  }

  it('recovers the sole project Brain coordinator and runs the unchanged owner path', async () => {
    const shape = zeroCoordinatorPassShape('byk-legacy-zero-coord');
    const brain = session('deck_alpha_brain', 'brain');
    const result = await dispatchReadyIntegration(shape.taskId, {
      registry: shape.registry,
      listSessions: () => [brain, session('deck_alpha_worker', 'w1')],
      dispatch: acceptedDispatch(),
      hasDeliveryEvidence: () => false,
      inspectAssignmentWorktree: cleanWorktree,
    });
    expect(result, 'a legacy zero-coordinator PASS task must integrate').toMatchObject({ status: 'dispatched' });
    const coordinators = shape.registry.listAssignments(shape.taskId)
      .filter((a) => a.role === 'coordinator');
    expect(coordinators, 'exactly one recovered coordinator').toHaveLength(1);
    expect(coordinators[0]).toMatchObject({
      identity: expect.objectContaining({ sessionName: 'deck_alpha_brain' }),
      required: false,
    });
    const owners = shape.registry.listAssignments(shape.taskId)
      .filter((a) => a.role === 'integration_owner');
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({
      auditRevision: shape.revision, auditAttemptId: shape.attemptId,
      status: 'ready_for_integration', verdict: 'PASS', crossVendorAuditPassed: true,
    });
  });

  it('creates no duplicate coordinator or owner on replay', async () => {
    const shape = zeroCoordinatorPassShape('byk-legacy-replay');
    const brain = session('deck_alpha_brain', 'brain');
    let delivered = false;
    const deps = {
      registry: shape.registry,
      listSessions: () => [brain, session('deck_alpha_worker', 'w1')],
      dispatch: vi.fn(async () => {
        delivered = true;
        return {
          status: 'accepted' as const,
          dispatchId: 'send_dispatch_00000000-0000-4000-8000-0000000000b3',
          messageId: 'send_message_00000000-0000-5000-a000-0000000000b3' as SendMessageId,
          deliveries: [{ target: brain.name, status: 'queued' as const }],
        };
      }),
      hasDeliveryEvidence: () => delivered,
      inspectAssignmentWorktree: cleanWorktree,
    };
    await expect(dispatchReadyIntegration(shape.taskId, deps as never)).resolves.toMatchObject({ status: 'dispatched' });
    await expect(dispatchReadyIntegration(shape.taskId, deps as never)).resolves.toMatchObject({ status: 'replayed' });
    expect(shape.registry.listAssignments(shape.taskId).filter((a) => a.role === 'coordinator')).toHaveLength(1);
    expect(shape.registry.listAssignments(shape.taskId).filter((a) => a.role === 'integration_owner')).toHaveLength(1);
  });

  it('fails closed and creates nothing when the project Brain is ambiguous', async () => {
    const shape = zeroCoordinatorPassShape('byk-legacy-ambiguous');
    const result = await dispatchReadyIntegration(shape.taskId, {
      registry: shape.registry,
      listSessions: () => [
        session('deck_alpha_brain', 'brain'),
        session('deck_alpha_brain_two', 'brain'),
        session('deck_alpha_worker', 'w1'),
      ],
      dispatch: acceptedDispatch(),
      hasDeliveryEvidence: () => false,
      inspectAssignmentWorktree: cleanWorktree,
    });
    expect(result).toMatchObject({ status: 'blocked' });
    expect(shape.registry.listAssignments(shape.taskId).filter((a) => a.role === 'coordinator')).toEqual([]);
    expect(shape.registry.listAssignments(shape.taskId).filter((a) => a.role === 'integration_owner')).toEqual([]);
  });

  it('fails closed and creates nothing when no project Brain exists', async () => {
    const shape = zeroCoordinatorPassShape('byk-legacy-no-brain');
    const result = await dispatchReadyIntegration(shape.taskId, {
      registry: shape.registry,
      listSessions: () => [session('deck_alpha_worker', 'w1')],
      dispatch: acceptedDispatch(),
      hasDeliveryEvidence: () => false,
      inspectAssignmentWorktree: cleanWorktree,
    });
    expect(result).toMatchObject({ status: 'blocked' });
    expect(shape.registry.listAssignments(shape.taskId).filter((a) => a.role === 'coordinator')).toEqual([]);
    expect(shape.registry.listAssignments(shape.taskId).filter((a) => a.role === 'integration_owner')).toEqual([]);
  });

  it('creates NOTHING when the worktree is dirty, even with a valid Brain', async () => {
    // Ordering guard. The coordinator gate sits ABOVE the manifest gate, so a
    // naive fix would mint a coordinator before discovering the worktree is
    // unusable. Recovery must run only after every existing gate has passed.
    const shape = zeroCoordinatorPassShape('byk-legacy-dirty');
    const result = await dispatchReadyIntegration(shape.taskId, {
      registry: shape.registry,
      listSessions: () => [session('deck_alpha_brain', 'brain'), session('deck_alpha_worker', 'w1')],
      dispatch: acceptedDispatch(),
      hasDeliveryEvidence: () => false,
      inspectAssignmentWorktree: () => ({
        ...cleanWorktree(), stagedPaths: ['src/exact.ts'],
      }),
    });
    expect(result).toMatchObject({ status: 'blocked', reason: 'authoritative implementation manifest unavailable' });
    expect(
      shape.registry.listAssignments(shape.taskId).filter((a) => a.role === 'coordinator'),
      'a dirty worktree must not mint a coordinator',
    ).toEqual([]);
  });

  it('never enters the fallback when a live coordinator already exists', async () => {
    const shape = zeroCoordinatorPassShape('byk-legacy-has-coord');
    expect(shape.registry.createAssignment({
      taskId: shape.taskId, role: 'coordinator', required: false,
      identity: identity('deck_alpha_brain'),
    })).toMatchObject({ ok: true });
    const brain = session('deck_alpha_brain', 'brain');
    await expect(dispatchReadyIntegration(shape.taskId, {
      registry: shape.registry,
      listSessions: () => [brain, session('deck_alpha_worker', 'w1')],
      dispatch: acceptedDispatch(),
      hasDeliveryEvidence: () => false,
      inspectAssignmentWorktree: cleanWorktree,
    })).resolves.toMatchObject({ status: 'dispatched' });
    expect(
      shape.registry.listAssignments(shape.taskId).filter((a) => a.role === 'coordinator'),
      'the pre-existing coordinator must be reused, never duplicated',
    ).toHaveLength(1);
  });

  it('mints the recovered coordinator with the exact deterministic idempotency key', async () => {
    // R1 shipped this key UNPROVEN: stripping it left every test green, because
    // the created coordinator row itself makes the next call take the live
    // path, so replay never re-exercises the key through behaviour alone. The
    // key is still the guard for a crash between the registry write and the
    // next read, so it is asserted where it is actually observable -- on the
    // create INPUT at the production call site -- rather than inferred from a
    // downstream row count that cannot see it.
    const shape = zeroCoordinatorPassShape('byk-legacy-idempotency-key');
    const creates: Array<Record<string, unknown>> = [];
    const recordingRegistry = new Proxy(shape.registry, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === 'createAssignment' && typeof value === 'function') {
          return (input: Record<string, unknown>) => {
            creates.push(input);
            return (value as (arg: unknown) => unknown).call(target, input);
          };
        }
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    }) as typeof shape.registry;

    const brain = session('deck_alpha_brain', 'brain');
    await expect(dispatchReadyIntegration(shape.taskId, {
      registry: recordingRegistry,
      listSessions: () => [brain, session('deck_alpha_worker', 'w1')],
      dispatch: vi.fn().mockResolvedValue({
        status: 'accepted',
        dispatchId: 'send_dispatch_00000000-0000-4000-8000-0000000000b6',
        messageId: 'send_message_00000000-0000-5000-a000-0000000000b6',
        deliveries: [{ target: brain.name, status: 'queued' }],
      }),
      hasDeliveryEvidence: () => false,
      inspectAssignmentWorktree: cleanWorktree,
    })).resolves.toMatchObject({ status: 'dispatched' });

    const coordinatorCreate = creates.find((input) => input.role === 'coordinator');
    expect(coordinatorCreate, 'the recovery must go through registry.createAssignment').toBeTruthy();
    expect(
      coordinatorCreate!.idempotencyKey,
      'a recovered coordinator must carry the exact deterministic key, so a replay '
        + 'that races the row read cannot mint a second coordinator',
    ).toBe(`auto-integration-coordinator:${shape.taskId}:${shape.revision}`);
    expect(coordinatorCreate!.required, 'recovered coordinator is non-blocking').toBe(false);
  });
});

describe('zero-coordinator recovery refuses conflicting historical provenance', () => {
  it('creates nothing when another live Brain already appears in the task lineage', async () => {
    // Exactly ONE Brain owns project alpha, so uniqueAuthoritativeProjectBrain
    // resolves cleanly and the ambiguity gate does NOT fire. What blocks here is
    // provenance: the task's own lineage names a different live Brain (one that
    // owns another project), so adopting the alpha Brain would silently rewrite
    // whose authority this task executed under.
    const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
    const taskId = 'byk-legacy-provenance';
    const revision = `${taskId}-r1`;
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'integration_task',
      objective: 'legacy task whose lineage names a foreign Brain',
      acceptance: ['refuse silent re-attribution'], currentRevision: revision,
      auditPolicy: 'auto_strict_cross_vendor',
    })).toMatchObject({ ok: true });
    const worker = registry.createAssignment({
      taskId, role: 'implementer', identity: identity('deck_beta_brain'),
      auditRevision: revision, scopeFiles: ['src/exact.ts'],
    });
    if (!worker.ok) throw new Error(worker.reason);
    for (const [intent, toStatus, validationState] of [
      ['start', 'implementing', undefined],
      ['record_validation', 'validated', 'passed'],
      ['open_audit', 'ready_for_audit', undefined],
    ] as const) {
      expect(registry.applyTaskIntent({
        taskId, assignmentId: worker.value.assignmentId, intent, toStatus,
        ...(validationState ? { validationState } : {}),
      })).toMatchObject({ ok: true });
    }
    const attemptId = automaticAttempt(taskId, revision);
    const auditor = registry.createAssignment({
      taskId, role: 'auditor', required: false,
      identity: identity('deck_alpha_pass_auditor', 'claude-code-sdk', 'anthropic'),
      auditAttemptId: attemptId, auditRevision: revision,
    });
    if (!auditor.ok) throw new Error(auditor.reason);
    expect(registry.updateAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditor.value.identity,
      status: 'auditing', auditAttemptId: attemptId, auditRevision: revision,
    })).toMatchObject({ ok: true });
    expect(registry.appendMatchingAuditReceipt({
      taskId, auditorAssignmentId: auditor.value.assignmentId,
      auditorIdentity: auditor.value.identity, auditorSessionName: auditor.value.identity.sessionName,
      attemptId, revision, receiptKind: 'final', verdict: 'PASS',
      findings: 'exact bytes pass', validations: [],
    })).toMatchObject({ ok: true });
    expect(registry.finishAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditor.value.identity, revision,
    })).toMatchObject({ ok: true });
    expect(registry.listAssignments(taskId).filter((a) => a.role === 'coordinator')).toEqual([]);

    // One alpha Brain (the only candidate) plus a live Brain owning project
    // beta, whose session name appears in this task's implementer lineage.
    const alphaBrain = session('deck_alpha_brain', 'brain');
    const betaBrain = { ...session('deck_beta_brain', 'brain'), projectName: 'beta' } as SessionRecord;
    const result = await dispatchReadyIntegration(taskId, {
      registry,
      listSessions: () => [alphaBrain, betaBrain],
      dispatch: vi.fn().mockResolvedValue({
        status: 'accepted',
        dispatchId: 'send_dispatch_00000000-0000-4000-8000-0000000000b4',
        messageId: 'send_message_00000000-0000-5000-a000-0000000000b4',
        deliveries: [{ target: 'deck_alpha_brain', status: 'queued' }],
      }),
      hasDeliveryEvidence: () => false,
      inspectAssignmentWorktree: () => ({
        worktreePath: '/tmp/legacy/repo', headSha: 'a'.repeat(40),
        files: [{ path: 'src/exact.ts', sha256: '1'.repeat(64) }],
        stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
      }),
    });
    expect(result).toMatchObject({ status: 'blocked' });
    expect(
      registry.listAssignments(taskId).filter((a) => a.role === 'coordinator'),
      'conflicting provenance must never mint a coordinator',
    ).toEqual([]);
    expect(registry.listAssignments(taskId).filter((a) => a.role === 'integration_owner')).toEqual([]);
  });
});

describe('zero-coordinator recovery is limited to the ZERO-row legacy shape', () => {
  it('stays closed when coordinator rows exist but none are live', async () => {
    // Distinct from the legacy shape. A task that HAS coordinator attribution
    // whose Brain is merely offline is NOT a legacy zero-row task: adopting a
    // different Brain here would re-attribute live authority rather than
    // recover missing authority. It must stay blocked and mint nothing, even
    // though exactly one other project Brain is available to adopt.
    const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
    const taskId = 'byk-legacy-stale-coord';
    const revision = `${taskId}-r1`;
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'integration_task',
      objective: 'coordinator row exists but its Brain is offline',
      acceptance: ['never re-attribute live authority'], currentRevision: revision,
      auditPolicy: 'auto_strict_cross_vendor',
    })).toMatchObject({ ok: true });
    expect(registry.createAssignment({
      taskId, role: 'coordinator', required: false, identity: identity('deck_alpha_offline_brain'),
    })).toMatchObject({ ok: true });
    const worker = registry.createAssignment({
      taskId, role: 'implementer', identity: identity('deck_alpha_worker'),
      auditRevision: revision, scopeFiles: ['src/exact.ts'],
    });
    if (!worker.ok) throw new Error(worker.reason);
    for (const [intent, toStatus, validationState] of [
      ['start', 'implementing', undefined],
      ['record_validation', 'validated', 'passed'],
      ['open_audit', 'ready_for_audit', undefined],
    ] as const) {
      expect(registry.applyTaskIntent({
        taskId, assignmentId: worker.value.assignmentId, intent, toStatus,
        ...(validationState ? { validationState } : {}),
      })).toMatchObject({ ok: true });
    }
    const attemptId = automaticAttempt(taskId, revision);
    const auditor = registry.createAssignment({
      taskId, role: 'auditor', required: false,
      identity: identity('deck_alpha_pass_auditor', 'claude-code-sdk', 'anthropic'),
      auditAttemptId: attemptId, auditRevision: revision,
    });
    if (!auditor.ok) throw new Error(auditor.reason);
    expect(registry.updateAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditor.value.identity,
      status: 'auditing', auditAttemptId: attemptId, auditRevision: revision,
    })).toMatchObject({ ok: true });
    expect(registry.appendMatchingAuditReceipt({
      taskId, auditorAssignmentId: auditor.value.assignmentId,
      auditorIdentity: auditor.value.identity, auditorSessionName: auditor.value.identity.sessionName,
      attemptId, revision, receiptKind: 'final', verdict: 'PASS',
      findings: 'exact bytes pass', validations: [],
    })).toMatchObject({ ok: true });
    expect(registry.finishAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditor.value.identity, revision,
    })).toMatchObject({ ok: true });

    // The recorded coordinator's Brain is absent; a DIFFERENT alpha Brain is live.
    const result = await dispatchReadyIntegration(taskId, {
      registry,
      listSessions: () => [session('deck_alpha_brain', 'brain'), session('deck_alpha_worker', 'w1')],
      dispatch: vi.fn().mockResolvedValue({
        status: 'accepted',
        dispatchId: 'send_dispatch_00000000-0000-4000-8000-0000000000b5',
        messageId: 'send_message_00000000-0000-5000-a000-0000000000b5',
        deliveries: [{ target: 'deck_alpha_brain', status: 'queued' }],
      }),
      hasDeliveryEvidence: () => false,
      inspectAssignmentWorktree: () => ({
        worktreePath: '/tmp/legacy/repo', headSha: 'a'.repeat(40),
        files: [{ path: 'src/exact.ts', sha256: '1'.repeat(64) }],
        stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
      }),
    });
    expect(result).toMatchObject({
      status: 'blocked', reason: 'integration requires one exact live Brain coordinator',
    });
    expect(
      registry.listAssignments(taskId).filter((a) => a.role === 'coordinator'),
      'an existing coordinator row must never be supplemented by a recovered one',
    ).toHaveLength(1);
    expect(registry.listAssignments(taskId).filter((a) => a.role === 'integration_owner')).toEqual([]);
  });
});
