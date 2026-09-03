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
  dispatchReadyAuditSweep,
  runSupervisionConvergenceTick,
  legacyExplicitAuditRecoveryAttempt,
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

    // The policy-less task must not be SELECTED by the sweep at all. Asserting
    // only "no auditor was created" is vacuous: dispatchReadyAudit independently
    // rejects a policy-less task with manual_policy, so that assertion holds even
    // if the sweep wrongly selects it. Pin the selection itself.
    expect(swept).toHaveLength(1);
    expect(swept.some((result) => result.reason === 'manual_policy')).toBe(false);
    const auditors = manual.registry.get(manual.taskId)?.assignments
      .filter((assignment) => assignment.role === 'auditor') ?? [];
    expect(auditors, 'boot sweep must not create an auditor without a policy').toEqual([]);
  });

  it('leaves legacy/manual tasks and a Brain-routed live fallback untouched', async () => {
    const legacy = makeReadyTask();
    await expect(dispatchReadyAudit(legacy.taskId, { registry: legacy.registry }))
      .resolves.toEqual({ status: 'ignored', reason: 'manual_policy' });

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
    const dispatch = vi.fn(async () => { throw new Error('must not dispatch without a policy'); });
    const deps = {
      registry, listSessions: () => sessions,
      listTargets: listTargetRecords(sessions[2]!),
      dispatch: dispatch as never,
      hasDeliveryEvidence: () => false,
    };

    const result = await runSupervisionConvergenceTick(deps);

    expect(result.audits).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(registry.listAssignments(taskId).filter((a) => a.role === 'auditor')).toEqual([]);
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
