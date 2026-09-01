import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENT_DELEGATION_PURPOSES } from '../../shared/agent-delegation.js';
import { normalizeSessionSupervisionSnapshot } from '../../shared/supervision-config.js';
import { buildSupervisionExecutionCapabilityId } from '../../shared/supervision-execution-pool.js';
import type { SendMessageId } from '../../shared/send-message-id.js';
import type { SessionRecord } from '../../src/store/session-store.js';
import {
  clearSendIdempotencyCacheForTests,
  dispatchReadyAudit,
  dispatchReadyAuditSweep,
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
