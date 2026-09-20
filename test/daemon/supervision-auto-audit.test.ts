import { createHash } from 'node:crypto';
import { SUPERVISION_UNBOUND_REVISION } from '../../shared/supervision-mcp-tools.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_DELEGATION_PURPOSES,
  AGENT_DELEGATION_REPLY_STATUSES,
} from '../../shared/agent-delegation.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import {
  normalizeSessionSupervisionSnapshot,
  SUPERVISION_ORPHANED_AUTOMATIC_AUDITOR_REBIND_SOURCE,
} from '../../shared/supervision-config.js';
import { AUDIT_SEVERITY_DEFINITIONS, AUDIT_SEVERITY_LEVELS } from '../../shared/audit-convergence.js';
import { buildSupervisionExecutionCapabilityId } from '../../shared/supervision-execution-pool.js';
import {
  deterministicAutomaticAuditDeliveryMessageId,
  deterministicSendMessageId,
  type SendMessageId,
} from '../../shared/send-message-id.js';
import { removeSession, upsertSession, type SessionRecord } from '../../src/store/session-store.js';
import {
  authorizeQueuedSupervisionHeartbeatDelivery,
  resolveQueuedSupervisionHeartbeatDelivery,
} from '../../src/daemon/supervision-participant-delivery.js';
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
  resolveAutomaticAuditCrossVendorAvailability,
  resolveSelectedSupervisionExecutionBinding,
  type SendMessageInput,
  type SendRuntimeCaller,
} from '../../src/daemon/send-tool.js';
import {
  createSupervisionMcpToolHandlers,
  type SupervisionRegistryPort,
} from '../../src/daemon/supervision-mcp-tools.js';
import { SUPERVISION_MCP_TOOLS } from '../../shared/supervision-mcp-tools.js';
import { retireExactSupersededAuditDelivery } from '../../src/daemon/supervision-registry-port.js';
import { resolvePeerAuditProviderFamily } from '../../src/daemon/peer-audit-candidates.js';
import { resolveEffectiveProjectName } from '../../shared/session-scope.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
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
import {
  clearAllResend,
  drainResend,
  enqueueResend,
  getResendCount,
  RESEND_DISPATCH_CONTROL,
} from '../../src/daemon/transport-resend-queue.js';
import {
  getDelegationReplyStore,
  resetDelegationReplyStoreForTests,
} from '../../src/daemon/delegation-reply-store.js';
import { suppressSqliteExperimentalWarning } from '../../src/util/suppress-sqlite-warning.js';
import {
  __auditTargetReservationsForTests,
  __resetAuditTargetReservationsForTests,
  AUDIT_TARGET_RESERVATION_TTL_MS,
} from '../../src/daemon/supervision-audit-target-reservations.js';
import {
  applySupervisionIntegrationBundle,
  freezeSupervisionIntegrationBundle,
} from '../../src/daemon/supervision-integration-bundle.js';

const require = createRequire(import.meta.url);
suppressSqliteExperimentalWarning();
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
const bundleRoots: string[] = [];

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

/** Raw persisted validation rewrite for task + one assignment (undefined stamp = legacy row). */
function stampValidation(
  database: InstanceType<typeof DatabaseSync>,
  taskId: string,
  assignmentId: string,
  taskStamp: string | undefined,
  ownerStamp: string | undefined,
  shape: { taskStatus?: string; ownerStatus?: string; revision?: string } = {},
): void {
  const taskRow = database.prepare('SELECT payload_json AS payload FROM supervision_tasks WHERE task_id = ?')
    .get(taskId) as { payload: string };
  const task = JSON.parse(taskRow.payload) as Record<string, unknown>;
  delete task.validatedRevision;
  Object.assign(task, { validationState: 'passed' },
    taskStamp ? { validatedRevision: taskStamp } : {},
    shape.taskStatus ? { status: shape.taskStatus } : {},
    shape.revision ? { currentRevision: shape.revision } : {});
  database.prepare('UPDATE supervision_tasks SET status = ?, current_revision = ?, validation_state = ?, payload_json = ? WHERE task_id = ?')
    .run(task.status as string, (task.currentRevision as string) ?? null, 'passed', JSON.stringify(task), taskId);
  const ownerRow = database.prepare('SELECT payload_json AS payload FROM supervision_task_assignments WHERE assignment_id = ?')
    .get(assignmentId) as { payload: string };
  const owner = JSON.parse(ownerRow.payload) as Record<string, unknown>;
  delete owner.validatedRevision;
  Object.assign(owner, { validationState: 'passed' },
    ownerStamp ? { validatedRevision: ownerStamp } : {},
    shape.ownerStatus ? { status: shape.ownerStatus } : {},
    shape.revision ? { auditRevision: shape.revision } : {});
  database.prepare('UPDATE supervision_task_assignments SET status = ?, audit_revision = ?, validation_state = ?, payload_json = ? WHERE assignment_id = ?')
    .run(owner.status as string, (owner.auditRevision as string) ?? null, 'passed', JSON.stringify(owner), assignmentId);
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
  /** Which session holds the implementer assignment this audit is about. */
  implementerSession?: string;
  /** The implementer's full identity, when its runtime family matters. */
  implementerIdentity?: PersistedSupervisionTaskAssignmentIdentity;
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
    identity: options.implementerIdentity ?? identity(options.implementerSession ?? 'deck_alpha_worker'),
    auditRevision: revision,
    scopeFiles: ['src/exact.ts'],
  });
  if (!worker.ok) throw new Error(worker.reason);
  for (const [intent, toStatus, validationState] of [
    ['start', 'implementing', undefined],
    ['record_validation', 'validated', 'passed'],
    ['open_audit', 'ready_for_audit', undefined],
  ] as const) {
    expect(registry.applyTaskIntent({ expectedRevision: (registry.getTaskRecord(taskId)?.currentRevision ?? SUPERVISION_UNBOUND_REVISION),
      taskId,
      assignmentId: worker.value.assignmentId,
      intent,
      toStatus,
      ...(validationState ? { validationState } : {}),
    })).toMatchObject({ ok: true });
  }
  const bundleRoot = mkdtempSync(join(tmpdir(), 'imcodes-auto-audit-bundle-'));
  bundleRoots.push(bundleRoot);
  const source = join(bundleRoot, 'source');
  mkdirSync(join(source, 'src'), { recursive: true });
  writeFileSync(join(source, 'src/exact.ts'), 'exact-after-bytes\n');
  const frozen = freezeSupervisionIntegrationBundle({
    taskId,
    assignmentId: worker.value.assignmentId,
    revision,
    scopeFiles: ['src/exact.ts'],
    bundleRoot: join(bundleRoot, 'bundles'),
    snapshot: {
      worktreePath: source,
      headSha: 'a'.repeat(40),
      files: [{
        path: 'src/exact.ts',
        sha256: createHash('sha256').update('exact-after-bytes\n').digest('hex'),
      }],
      stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
    },
  });
  if (!frozen.ok) throw new Error(frozen.reason);
  expect(registry.bindIntegrationBundle({
    taskId,
    assignmentId: worker.value.assignmentId,
    identity: worker.value.identity,
    revision,
    bundle: frozen.bundle,
  })).toMatchObject({ ok: true });
  return { registry, taskId, revision, worker: worker.value };
}

beforeEach(() => {
  for (const root of bundleRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  resetSupervisionTaskRegistryForTests();
  resetTransportQueueStoreForTests();
  resetDelegationReplyStoreForTests();
  clearSendIdempotencyCacheForTests();
  // Auditor claims live for the daemon's lifetime by design, so one test's
  // claim would otherwise keep a peer out of the next test's ready pool.
  __resetAuditTargetReservationsForTests();
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

  function settleReadyTaskWithUnchangedBundle(taskId: string) {
    const root = mkdtempSync(join(tmpdir(), 'integration-unchanged-real-path-'));
    bundleRoots.push(root);
    const repository = join(root, 'repository');
    const implementer = join(root, 'implementer');
    const integration = join(root, 'integration');
    mkdirSync(join(repository, 'src'), { recursive: true });
    execFileSync('git', ['init', '-q', repository]);
    execFileSync('git', ['-C', repository, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', repository, 'config', 'user.name', 'Test']);
    writeFileSync(join(repository, 'src/changed.ts'), 'before\n');
    writeFileSync(join(repository, 'src/unchanged.ts'), 'already desired\n');
    execFileSync('git', ['-C', repository, 'add', '--', 'src/changed.ts', 'src/unchanged.ts']);
    execFileSync('git', ['-C', repository, 'commit', '-qm', 'base']);
    const headSha = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['-C', repository, 'worktree', 'add', '--detach', implementer, headSha]);
    execFileSync('git', ['-C', repository, 'worktree', 'add', '--detach', integration, headSha]);
    writeFileSync(join(implementer, 'src/changed.ts'), 'after\n');

    const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
    const revision = `${taskId}-r1`;
    expect(registry.createOrGet({
      taskId,
      projectName: 'alpha',
      classification: 'integration_task',
      objective: 'dispatch the exact PASS integration bundle',
      acceptance: ['include unchanged scoped paths'],
      baseRevision: headSha,
      currentRevision: revision,
      auditPolicy: 'auto_strict_cross_vendor',
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
      scopeFiles: ['src/changed.ts', 'src/unchanged.ts'],
    });
    if (!worker.ok) throw new Error(worker.reason);
    for (const [intent, toStatus, validationState] of [
      ['start', 'implementing', undefined],
      ['record_validation', 'validated', 'passed'],
      ['open_audit', 'ready_for_audit', undefined],
    ] as const) {
      expect(registry.applyTaskIntent({
        expectedRevision: revision,
        taskId,
        assignmentId: worker.value.assignmentId,
        intent,
        toStatus,
        ...(validationState ? { validationState } : {}),
      })).toMatchObject({ ok: true });
    }
    const files = [
      { path: 'src/changed.ts', sha256: createHash('sha256').update('after\n').digest('hex'), mode: 0o644 as const },
      { path: 'src/unchanged.ts', sha256: createHash('sha256').update('already desired\n').digest('hex'), mode: 0o644 as const },
    ];
    const frozen = freezeSupervisionIntegrationBundle({
      taskId,
      assignmentId: worker.value.assignmentId,
      revision,
      scopeFiles: files.map((file) => file.path),
      bundleRoot: join(root, 'bundles'),
      snapshot: {
        worktreePath: implementer,
        headSha,
        files,
        stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
      },
    });
    if (!frozen.ok) throw new Error(frozen.reason);
    expect(registry.bindIntegrationBundle({
      taskId,
      assignmentId: worker.value.assignmentId,
      identity: worker.value.identity,
      revision,
      bundle: frozen.bundle,
    })).toMatchObject({ ok: true });
    const attemptId = automaticAttempt(taskId, revision);
    const auditor = registry.createAssignment({
      taskId,
      role: 'auditor',
      required: false,
      identity: identity('deck_alpha_pass_auditor', 'claude-code-sdk', 'anthropic'),
      auditAttemptId: attemptId,
      auditRevision: revision,
    });
    if (!auditor.ok) throw new Error(auditor.reason);
    expect(registry.updateAssignment({
      assignmentId: auditor.value.assignmentId,
      identity: auditor.value.identity,
      status: 'auditing',
      auditAttemptId: attemptId,
      auditRevision: revision,
    })).toMatchObject({ ok: true });
    expect(registry.appendMatchingAuditReceipt({
      taskId,
      auditorAssignmentId: auditor.value.assignmentId,
      auditorIdentity: auditor.value.identity,
      auditorSessionName: auditor.value.identity.sessionName,
      attemptId,
      revision,
      receiptKind: 'final',
      verdict: 'PASS',
      findings: 'exact bytes pass',
      validations: [],
    })).toMatchObject({ ok: true });
    expect(registry.finishAssignment({
      assignmentId: auditor.value.assignmentId,
      identity: auditor.value.identity,
      revision,
    })).toMatchObject({ ok: true });
    return { registry, taskId, revision, attemptId, worker: worker.value, integration, frozen: frozen.bundle };
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
    expect(dispatch.mock.calls[0]![1].internalSuppressTimeline).toBe(true);
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
    expect(dispatch.mock.calls[0]![1].message).toContain('authoritativeBundle=/tmp/authoritative-worker/repo');
    expect(dispatch.mock.calls[0]![1].message).toContain('- src/exact.ts');
    expect(dispatch.mock.calls[0]![1].internalQueueSupervisionReference).toEqual({
      kind: 'exact_integration', taskId: shape.taskId,
      assignmentId: owners[0]!.assignmentId, revision: shape.revision,
    });
    expect(dispatch.mock.calls[0]![1].internalSuppressTimeline).toBe(true);
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
      integrationManifest: shape.registry.getTaskRecord(shape.taskId)!.integrationBundle!.files
        .filter((file): file is { path: string; sha256: string } => file.deleted !== true && Boolean(file.sha256))
        .map((file) => ({ path: file.path, sha256: file.sha256 })),
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

  it('prepares an unchanged-scope bundle and queues one hidden exact integration message to a busy Brain', async () => {
    __resetSupervisionConvergenceTickForTests();
    const shape = settleReadyTaskWithUnchangedBundle('integration-unchanged-real-path');
    const brain = { ...session('deck_alpha_brain', 'brain'), state: 'running' as const };
    const worker = session('deck_alpha_worker', 'w1');
    let delivered = false;
    const dispatch = vi.fn().mockResolvedValue({
      status: 'accepted',
      dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000034',
      messageId: 'send_message_00000000-0000-5000-a000-000000000034',
      deliveries: [{ target: brain.name, status: 'queued' }],
    });
    const deps = {
      registry: shape.registry,
      listSessions: () => [brain, worker],
      dispatch,
      hasDeliveryEvidence: () => delivered,
      ensureIntegrationWorktree: vi.fn(async () => ({
        ok: true as const,
        worktreePath: shape.integration,
        baseRevision: shape.frozen.headSha,
        created: false,
      })),
      runScheduledWorktreeGcBatch: vi.fn(async () => undefined),
    };

    await expect(runSupervisionConvergenceTick(deps)).resolves.toMatchObject({
      integrations: [expect.objectContaining({ status: 'dispatched' })],
    });
    const owner = shape.registry.get(shape.taskId)!.assignments.find(
      (assignment) => assignment.role === 'integration_owner',
    )!;
    expect(owner.status).toBe('ready_for_integration');
    expect(owner.blocker).toBeUndefined();
    const expectedMessageId = deterministicSendMessageId(
      `auto-integration:${owner.assignmentId}:${shape.revision}:${shape.attemptId}`,
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]![1]).toMatchObject({
      internalMessageId: expectedMessageId,
      internalDurableQueue: true,
      internalSuppressTimeline: true,
    });
    const pathspec = dispatch.mock.calls[0]![1].message.split('\n')
      .slice(dispatch.mock.calls[0]![1].message.split('\n').indexOf('Exact pathspec:') + 1)
      .filter((line: string) => line.startsWith('- '))
      .map((line: string) => line.slice(2));
    expect(pathspec).toEqual(shape.frozen.files.map((file) => file.path));
    expect(pathspec).toContain('src/unchanged.ts');

    delivered = true;
    await expect(runSupervisionConvergenceTick(deps)).resolves.toMatchObject({
      integrations: [expect.objectContaining({ status: 'replayed', messageId: expectedMessageId })],
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(shape.registry.get(shape.taskId)!.assignments.filter(
      (assignment) => assignment.role === 'integration_owner',
    )).toHaveLength(1);
  });

  it('records one bounded durable owner blocker when integration preparation is rejected', async () => {
    const shape = settleReadyTaskWithUnchangedBundle('integration-visible-prepare-blocker');
    const brain = session('deck_alpha_brain', 'brain');
    const worker = session('deck_alpha_worker', 'w1');
    const dispatch = vi.fn().mockResolvedValue({
      status: 'accepted',
      dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000035',
      messageId: 'send_message_00000000-0000-5000-a000-000000000035',
      deliveries: [{ target: brain.name, status: 'queued' }],
    });
    let reject = true;
    const deps = {
      registry: shape.registry,
      listSessions: () => [brain, worker],
      dispatch,
      hasDeliveryEvidence: () => false,
      ensureIntegrationWorktree: vi.fn(async () => ({
        ok: true as const,
        worktreePath: shape.integration,
        baseRevision: shape.frozen.headSha,
        created: false,
      })),
      applyIntegrationBundle: vi.fn((_input: Parameters<typeof applySupervisionIntegrationBundle>[0]) => (
        reject
          ? { ok: false as const, reason: 'target_conflict' as const, path: 'src/unchanged.ts' }
          : { ok: true as const, replay: false }
      )),
    };

    await expect(dispatchReadyIntegration(shape.taskId, deps)).resolves.toEqual({
      status: 'blocked',
      reason: 'integration bundle apply rejected: target_conflict:src/unchanged.ts',
      reported: true,
    });
    const owner = shape.registry.get(shape.taskId)!.assignments.find(
      (assignment) => assignment.role === 'integration_owner',
    )!;
    expect(JSON.parse(shape.registry.getAssignment(owner.assignmentId)!.blocker!)).toMatchObject({
      kind: 'automatic_integration_dispatch',
      taskId: shape.taskId,
      assignmentId: owner.assignmentId,
      revision: shape.revision,
      reason: 'integration bundle apply rejected: target_conflict:src/unchanged.ts',
    });
    const blockedEvents = () => shape.registry.listEvents(shape.taskId).filter((event) => (
      event.assignmentId === owner.assignmentId
      && event.eventType === 'blocked'
      && event.payload?.source === 'automatic_integration_dispatch_blocked'
    ));
    expect(blockedEvents()).toHaveLength(1);
    await expect(dispatchReadyIntegration(shape.taskId, deps)).resolves.toMatchObject({
      status: 'blocked', reported: true,
    });
    expect(blockedEvents()).toHaveLength(1);
    expect(dispatch).not.toHaveBeenCalled();

    reject = false;
    await expect(dispatchReadyIntegration(shape.taskId, deps)).resolves.toMatchObject({ status: 'dispatched' });
    expect(shape.registry.getAssignment(owner.assignmentId)?.status).toBe('ready_for_integration');
    expect(shape.registry.getAssignment(owner.assignmentId)?.blocker).toBeUndefined();
    expect(shape.registry.listEvents(shape.taskId)).toContainEqual(expect.objectContaining({
      assignmentId: owner.assignmentId,
      eventType: 'recovered',
      payload: expect.objectContaining({ source: 'automatic_integration_dispatch_recovered' }),
    }));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('re-arms the same cancelled stale owner for the current PASS and provisions from bundle head', async () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = settleReadyTask('PASS', 'incident-thirteen-stale-owner', registry);
    const brain = session('deck_alpha_brain', 'brain');
    const worker = session('deck_alpha_worker', 'w1');
    const oldRevision = 'rejected-r7';
    const oldAttempt = 'rejected-r7-attempt';
    const stale = shape.registry.createAssignment({
      taskId: shape.taskId, role: 'integration_owner', required: true,
      identity: identity(brain.name), scopeFiles: ['src/exact.ts'],
      auditAttemptId: oldAttempt, auditRevision: oldRevision,
      idempotencyKey: 'historical-r7-owner',
    });
    if (!stale.ok) throw new Error(stale.reason);
    expect(shape.registry.applyTaskIntent({
      taskId: shape.taskId, assignmentId: stale.value.assignmentId,
      intent: 'cancel', toStatus: 'cancelled', note: 'retire rejected R7 owner',
    })).toMatchObject({ ok: true });
    expect(shape.registry.updateTask({
      taskId: shape.taskId, baseRevision: 'c'.repeat(40),
    })).toMatchObject({ ok: true });
    // Reproduce the persisted incident shape: cancellation revoked the lease,
    // but a crash left the task's owner pointer on the historical row.
    const pointedTask = shape.registry.getTaskRecord(shape.taskId)!;
    database.prepare('UPDATE supervision_tasks SET payload_json = ? WHERE task_id = ?').run(
      JSON.stringify({ ...pointedTask, integrationOwnerAssignmentId: stale.value.assignmentId }),
      shape.taskId,
    );
    expect(shape.registry.getAssignment(stale.value.assignmentId)).toMatchObject({
      status: 'cancelled', leaseId: '', identity: identity(brain.name),
    });
    expect(shape.registry.getTaskRecord(shape.taskId)).toMatchObject({
      integrationOwnerAssignmentId: stale.value.assignmentId,
    });
    expect(shape.registry.createAssignment({
      taskId: shape.taskId, role: 'integration_owner', required: true,
      identity: identity(brain.name), scopeFiles: ['src/exact.ts'],
      auditAttemptId: oldAttempt, auditRevision: oldRevision,
      idempotencyKey: 'historical-r7-owner',
    })).toEqual({ ok: false, reason: 'receipt_closed' });
    const integrationRoot = mkdtempSync(join(tmpdir(), 'incident-thirteen-owner-'));
    bundleRoots.push(integrationRoot);
    const ensureIntegrationWorktree = vi.fn(async (input: { baseRevision: string; assignmentId: string }) => ({
      ok: true as const,
      worktreePath: integrationRoot,
      baseRevision: input.baseRevision,
      created: true,
    }));
    const applyIntegrationBundle = vi.fn(() => ({ ok: true as const }));
    const dispatch = vi.fn().mockResolvedValue({
      status: 'accepted',
      dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000133',
      messageId: 'send_message_00000000-0000-5000-a000-000000000133',
      deliveries: [{ target: brain.name, status: 'queued' }],
    });
    const beforeIds = shape.registry.listAssignments(shape.taskId).map((row) => row.assignmentId);

    const result = await dispatchReadyIntegration(shape.taskId, {
      registry: shape.registry,
      listSessions: () => [brain, worker],
      dispatch,
      hasDeliveryEvidence: () => false,
      ensureIntegrationWorktree: ensureIntegrationWorktree as never,
      applyIntegrationBundle,
    });
    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'dispatched', assignmentId: stale.value.assignmentId,
    });

    expect(shape.registry.listAssignments(shape.taskId).map((row) => row.assignmentId)).toEqual(beforeIds);
    expect(shape.registry.getAssignment(stale.value.assignmentId)).toMatchObject({
      status: 'ready_for_integration', auditRevision: shape.revision,
      auditAttemptId: shape.attemptId, verdict: 'PASS', crossVendorAuditPassed: true,
    });
    expect(ensureIntegrationWorktree).toHaveBeenCalledWith(expect.objectContaining({
      assignmentId: stale.value.assignmentId,
      baseRevision: shape.registry.getTaskRecord(shape.taskId)!.integrationBundle!.headSha,
    }));
    expect(ensureIntegrationWorktree.mock.calls[0]![0].baseRevision).not.toBe('c'.repeat(40));
    expect(applyIntegrationBundle).toHaveBeenCalledWith(expect.objectContaining({
      worktreePath: integrationRoot,
    }));
  });

  it('authorizes an exact integration wake across the Brain runtime epoch rotation', async () => {
    const registry = getSupervisionTaskRegistry();
    const shape = settleReadyTask('PASS', 'integration-epoch-rotation', registry);
    const brain = session('deck_alpha_brain', 'brain');
    const worker = session('deck_alpha_worker', 'w1');
    upsertSession(brain);
    upsertSession(worker);
    const dispatch = vi.fn().mockResolvedValue({
      status: 'accepted',
      dispatchId: 'send_dispatch_00000000-0000-4000-8000-0000000000e1',
      messageId: 'send_message_00000000-0000-5000-a000-0000000000e1',
      deliveries: [{ target: brain.name, status: 'queued' }],
    });
    try {
      await expect(dispatchReadyIntegration(shape.taskId, {
        registry,
        listSessions: () => [brain, worker],
        dispatch,
        hasDeliveryEvidence: () => false,
        inspectAssignmentWorktree: () => ({
          worktreePath: '/tmp/integration-epoch-rotation/repo', headSha: 'a'.repeat(40),
          files: [{ path: 'src/exact.ts', sha256: '1'.repeat(64) }],
          stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
        }),
      })).resolves.toMatchObject({ status: 'dispatched' });
      const sent = dispatch.mock.calls[0]![1];
      const reference = sent.internalQueueSupervisionReference;
      const messageId = sent.internalMessageId!;
      const owner = registry.get(shape.taskId)!.assignments.find(
        (assignment) => assignment.role === 'integration_owner',
      )!;
      upsertSession({ ...brain, runtimeEpoch: `${brain.runtimeEpoch}-rotated`, updatedAt: brain.updatedAt + 1 });

      expect(authorizeQueuedSupervisionHeartbeatDelivery({
        targetSessionName: brain.name,
        clientMessageId: sent.internalMessageId,
        text: sent.message,
        supervisionReference: reference,
      })).toBe(true);
      expect(registry.getAssignment(owner.assignmentId)?.identity.runtimeEpoch)
        .toBe(brain.runtimeEpoch);

      const queued = enqueueResend(brain.name, {
        text: sent.message,
        commandId: messageId,
        clientMessageId: messageId,
        supervisionReference: reference,
        queuedAt: Date.now(),
      });
      expect(queued).toMatchObject({ accepted: true });
      const delivered: string[] = [];
      const deliver = async (entry: Parameters<typeof enqueueResend>[1]) => {
        const admission = resolveQueuedSupervisionHeartbeatDelivery({
          targetSessionName: brain.name,
          clientMessageId: entry.clientMessageId ?? entry.commandId ?? '',
          text: entry.text,
          supervisionReference: entry.supervisionReference,
        });
        if (admission === 'retry') return RESEND_DISPATCH_CONTROL.RETRY;
        if (admission === 'stale') return RESEND_DISPATCH_CONTROL.STALE;
        delivered.push(entry.clientMessageId ?? entry.commandId ?? '');
        return 'sent' as const;
      };

      removeSession(brain.name);
      await expect(drainResend(brain.name, deliver)).resolves.toBe(0);
      expect(getResendCount(brain.name)).toBe(1);
      expect(getTransportQueueStore().hasDeliveryTombstone(brain.name, messageId))
        .toBe(false);

      upsertSession({ ...brain, state: 'stopped', updatedAt: brain.updatedAt + 2 });
      await expect(drainResend(brain.name, deliver)).resolves.toBe(0);
      expect(getResendCount(brain.name)).toBe(1);
      expect(getTransportQueueStore().hasDeliveryTombstone(brain.name, messageId))
        .toBe(false);

      upsertSession({ ...brain, state: 'idle', updatedAt: brain.updatedAt + 3 });
      await expect(drainResend(brain.name, deliver)).resolves.toBe(1);
      await expect(drainResend(brain.name, deliver)).resolves.toBe(0);
      expect(delivered).toEqual([messageId]);
      expect(getResendCount(brain.name)).toBe(0);
      expect(registry.applyTaskIntent({
        taskId: shape.taskId,
        assignmentId: owner.assignmentId,
        intent: 'cancel',
        toStatus: 'cancelled',
        note: 'terminal owner cannot retain queued integration authority',
      })).toMatchObject({ ok: true });
      upsertSession({ ...brain, state: 'stopped', updatedAt: brain.updatedAt + 2 });
      expect(resolveQueuedSupervisionHeartbeatDelivery({
        targetSessionName: brain.name,
        clientMessageId: sent.internalMessageId,
        text: sent.message,
        supervisionReference: reference,
      })).toBe('stale');
    } finally {
      clearAllResend();
      removeSession(brain.name);
      removeSession(worker.name);
    }
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

  it('aligns one validated R1/R2 split before the ordinary finish handoff and keeps stale finish rejected', async () => {
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
    expect(registry.applyTaskIntent({ expectedRevision: (registry.getTaskRecord(taskId)?.currentRevision ?? SUPERVISION_UNBOUND_REVISION),
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
    expect(await registry.convergeValidatedAssignment(worker.value.assignmentId, splitTask.updatedAt + 1))
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
    expect(await registry.convergeValidatedAssignment(worker.value.assignmentId, splitTask.updatedAt + 2)).toEqual([]);
    expect(registry.listEvents(taskId)).toHaveLength(eventCount);
  });

  it.each(['ambiguous implementer', 'conflicting external evidence'] as const)(
    'leaves a validated revision split untouched with %s',
    async (conflict) => {
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
      expect(registry.applyTaskIntent({ expectedRevision: (registry.getTaskRecord(taskId)?.currentRevision ?? SUPERVISION_UNBOUND_REVISION),
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

      expect(await registry.convergeValidatedAssignment(worker.value.assignmentId, splitTask.updatedAt + 1)).toEqual([]);
      expect(registry.getTaskRecord(taskId)).toMatchObject({ status: 'validated', currentRevision: r1 });
      expect(registry.getAssignment(worker.value.assignmentId)).toMatchObject({ status: 'validated', auditRevision: r2 });
    },
  );

  it('repairs the exact validated revision split in the bounded sweep and is replay-idempotent', async () => {
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
    expect(registry.applyTaskIntent({ expectedRevision: (registry.getTaskRecord(taskId)?.currentRevision ?? SUPERVISION_UNBOUND_REVISION),
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

    expect(await registry.convergeLifecycle(split.updatedAt + 1, { limit: 1 })).toEqual([
      { taskId, assignmentId: worker.value.assignmentId, action: 'align_validated_revision' },
      { taskId, assignmentId: worker.value.assignmentId, action: 'project_validated_handoff' },
    ]);
    const eventCount = registry.listEvents(taskId).length;
    expect(await registry.convergeLifecycle(split.updatedAt + 2, { limit: 1 })).toEqual([]);
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
      expect(input.message).toContain('Authoritative immutable integration bundle: /tmp/authoritative-auto-audit/repo');
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

  it('repairs a stale implementing aggregate around one already-running exact audit without duplication', async () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = makeReadyTask({
      taskId: 'tsk_n27_live_projection',
      auditPolicy: 'auto_strict_cross_vendor',
      registry,
    });
    const attemptId = automaticAttempt(shape.taskId, shape.revision);
    const brain = session('deck_alpha_brain', 'brain');
    const worker = session('deck_alpha_worker', 'w1');
    const auditorSession = session('deck_alpha_auditor', 'w2', 'claude-code-sdk', 'anthropic');
    expect(registry.updateAssignment({
      assignmentId: shape.worker.assignmentId,
      identity: shape.worker.identity,
      status: 'ready_for_audit',
      auditAttemptId: attemptId,
      auditRevision: shape.revision,
    })).toMatchObject({ ok: true });
    const auditor = registry.createAssignment({
      taskId: shape.taskId,
      role: 'auditor',
      required: false,
      identity: identity(auditorSession.name, 'claude-code-sdk', 'anthropic'),
      auditAttemptId: attemptId,
      auditRevision: shape.revision,
    });
    if (!auditor.ok) throw new Error(auditor.reason);
    expect(registry.updateAssignment({
      assignmentId: auditor.value.assignmentId,
      identity: auditor.value.identity,
      status: 'implementing',
      auditAttemptId: attemptId,
      auditRevision: shape.revision,
    })).toMatchObject({ ok: true });

    // Exact live incident: every revision/validation/auditor fact is durable,
    // but the aggregate was left behind at implementing.
    const exact = registry.getTaskRecord(shape.taskId)!;
    database.prepare(
      'UPDATE supervision_tasks SET status = ?, payload_json = ? WHERE task_id = ?',
    ).run('implementing', JSON.stringify({ ...exact, status: 'implementing' }), shape.taskId);
    const beforeIds = registry.listAssignments(shape.taskId).map((row) => row.assignmentId);
    const beforeImplementerGeneration = registry.getAssignment(shape.worker.assignmentId)!.generation;
    const beforeAuditorGeneration = registry.getAssignment(auditor.value.assignmentId)!.generation;
    const dispatch = vi.fn();

    const result = await runSupervisionConvergenceTick({
      registry,
      listSessions: () => [brain, worker, auditorSession],
      listTargets: listTargetRecords(auditorSession),
      dispatch,
      hasDeliveryEvidence: () => true,
      limit: 10,
    });

    expect(result.converged).toEqual(expect.arrayContaining([expect.objectContaining({
      taskId: shape.taskId,
      assignmentId: auditor.value.assignmentId,
      action: 'repair_ready_audit_aggregate',
    })]));
    expect(registry.getTaskRecord(shape.taskId)).toMatchObject({
      status: 'ready_for_audit',
      currentRevision: shape.revision,
      validationState: 'passed',
      validatedRevision: shape.revision,
    });
    expect(registry.listAssignments(shape.taskId).map((row) => row.assignmentId)).toEqual(beforeIds);
    expect(registry.getAssignment(shape.worker.assignmentId)).toMatchObject({
      status: 'ready_for_audit', generation: beforeImplementerGeneration,
      auditAttemptId: attemptId, auditRevision: shape.revision,
    });
    expect(registry.getAssignment(auditor.value.assignmentId)).toMatchObject({
      status: 'implementing', generation: beforeAuditorGeneration,
      auditAttemptId: attemptId, auditRevision: shape.revision,
    });
    expect(result.audits).toEqual([expect.objectContaining({
      status: 'replayed', assignmentId: auditor.value.assignmentId, attemptId,
    })]);
    expect(dispatch).not.toHaveBeenCalled();
    registry.close();
  });

  it('leaves a stale aggregate closed when the running auditor names a different attempt', async () => {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    const shape = makeReadyTask({
      taskId: 'tsk_n27_mismatched_projection',
      auditPolicy: 'auto_strict_cross_vendor',
      registry,
    });
    const implementerAttempt = automaticAttempt(shape.taskId, shape.revision);
    expect(registry.updateAssignment({
      assignmentId: shape.worker.assignmentId,
      identity: shape.worker.identity,
      status: 'ready_for_audit',
      auditAttemptId: implementerAttempt,
      auditRevision: shape.revision,
    })).toMatchObject({ ok: true });
    const auditor = registry.createAssignment({
      taskId: shape.taskId,
      role: 'auditor',
      required: false,
      identity: identity('deck_alpha_mismatched_auditor', 'claude-code-sdk', 'anthropic'),
      auditAttemptId: `${implementerAttempt}-other`,
      auditRevision: shape.revision,
    });
    if (!auditor.ok) throw new Error(auditor.reason);
    expect(registry.updateAssignment({
      assignmentId: auditor.value.assignmentId,
      identity: auditor.value.identity,
      status: 'implementing',
      auditAttemptId: `${implementerAttempt}-other`,
      auditRevision: shape.revision,
    })).toMatchObject({ ok: true });
    const exact = registry.getTaskRecord(shape.taskId)!;
    database.prepare(
      'UPDATE supervision_tasks SET status = ?, payload_json = ? WHERE task_id = ?',
    ).run('implementing', JSON.stringify({ ...exact, status: 'implementing' }), shape.taskId);

    const before = registry.get(shape.taskId);
    await expect(registry.convergeLifecycle(500, { limit: 10 })).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'repair_ready_audit_aggregate' })]),
    );
    expect(registry.get(shape.taskId)).toEqual(before);
    registry.close();
  });

  it('mints a fresh redelivery id once a dispatched audit that left no delivery evidence at all goes stale (tsk_uzm/asg_v0r regression)', async () => {
    // Real incident: an already-dispatched auditor assignment (tsk_uzm/asg_v0r)
    // sat completely untouched for ~2.4 hours, well past the 10-minute
    // AUDITOR_STALE_REDELIVERY_MS budget, because the staleness/redelivery
    // check used to be gated on `hasExistingEvidence` alone. When the very
    // first send never left any recorded delivery evidence at all (the
    // strictly harder "never landed in the first place" case, not "landed
    // then the assignee went quiet"), the code fell straight through to
    // reusing the exact same original `internalMessageId` forever. Every 60s
    // convergence tick genuinely re-ran this function -- `internalMessageId`
    // + `internalDurableQueue: true` exist specifically to make repeat calls
    // idempotent, so each retry was silently treated as "already handled"
    // and never produced a real new delivery attempt.
    function messageIdOf(result: { status: string; messageId?: SendMessageId }): SendMessageId | undefined {
      return result.messageId;
    }
    const { registry, taskId, revision } = makeReadyTask({ auditPolicy: 'auto_allow_degraded' });
    const sessions = [
      session('deck_alpha_brain', 'brain'),
      session('deck_alpha_worker', 'w1'),
      session('deck_alpha_auditor', 'w2', 'claude-code-sdk', 'anthropic'),
    ];
    // `registry.createAssignment` stamps `updatedAt`/`createdAt` from the
    // real wall clock internally (it does not accept an injected `now`), so
    // the fake clock this test advances must start near real epoch time --
    // an arbitrary small fake epoch would make `now - existingAudit.updatedAt`
    // permanently negative and never cross the staleness threshold.
    let now = Date.now();
    let assignmentId: string | undefined;
    const attemptId = automaticAttempt(taskId, revision);
    const dispatch = vi.fn(async (_caller: SendRuntimeCaller, input: SendMessageInput) => {
      if (!assignmentId) {
        const created = registry.createAssignment({
          taskId,
          role: 'auditor',
          identity: identity('deck_alpha_auditor', 'claude-code-sdk', 'anthropic'),
          auditAttemptId: input.audit!.attemptId,
          auditRevision: revision,
          idempotencyKey: `send:${input.idempotencyKey}`,
        });
        if (!created.ok) throw new Error(created.reason);
        assignmentId = created.value.assignmentId;
      }
      return {
        status: 'accepted' as const,
        dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000000' as const,
        messageId: (input.internalMessageId ?? automaticMessageId(assignmentId, attemptId)) as SendMessageId,
        deliveries: [{ target: 'deck_alpha_auditor', status: 'queued' as const }],
        taskId,
        assignmentId,
      };
    });
    const deps = {
      registry,
      listSessions: () => sessions,
      listTargets: listTargetRecords(sessions[2]!),
      dispatch,
      // The exact incident condition: never ANY recorded delivery evidence,
      // for the whole scenario -- not "evidence exists but is stale".
      hasDeliveryEvidence: () => false,
      now: () => now,
      inspectAssignmentWorktree: () => ({
        worktreePath: '/tmp/authoritative-auto-audit/repo',
        headSha: 'a'.repeat(40),
        files: [{ path: 'src/exact.ts', sha256: '1'.repeat(64) }],
        stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
      }),
    };

    const first = await dispatchReadyAudit(taskId, deps);
    expect(first).toMatchObject({ status: 'dispatched', attemptId });
    const originalMessageId = messageIdOf(first);
    expect(originalMessageId).toBeTruthy();

    // Well within the redelivery window (5 of the 10 minutes): must keep
    // using the exact same message id. Redelivering this early would be its
    // own false-positive bug -- a genuinely slow but real first attempt must
    // not be treated as abandoned.
    now += 5 * 60_000;
    const stillFresh = await dispatchReadyAudit(taskId, deps);
    expect(messageIdOf(stillFresh)).toBe(originalMessageId);

    // Past the 10-minute AUDITOR_STALE_REDELIVERY_MS budget with STILL zero
    // delivery evidence -- exactly the tsk_uzm/asg_v0r incident shape. This
    // must now mint a genuinely new redelivery id instead of perpetually
    // resending the original one that never actually landed.
    now += 6 * 60_000;
    const redelivered = await dispatchReadyAudit(taskId, deps);
    expect(redelivered).toMatchObject({ status: 'dispatched', assignmentId, attemptId });
    const redeliveredMessageId = messageIdOf(redelivered);
    expect(redeliveredMessageId).toBeTruthy();
    expect(
      redeliveredMessageId,
      'a stale never-evidenced dispatch must get a fresh message id, not the same one forever',
    ).not.toBe(originalMessageId);
    expect(redeliveredMessageId)
      .toBe(deterministicSendMessageId(`auto-audit-redelivery:${assignmentId}:${attemptId}`));
    // Redelivery reuses the SAME durable assignment; it must never mint a
    // second logical auditor row for the same revision.
    expect(registry.listAssignments(taskId).filter((item) => item.role === 'auditor')).toHaveLength(1);
  });

  it('adopts one exact durable audit delivery when its auditor row was not materialized (tsk_f1x)', async () => {
    const { registry, taskId, revision } = makeReadyTask({
      taskId: 'tsk_f1x',
      revision: 'supervision-preamble-headroom-cx5-r1-789e8604748b',
      auditPolicy: 'auto_strict_cross_vendor',
    });
    const brain = session('deck_alpha_brain', 'brain');
    const worker = session('deck_alpha_worker', 'w1');
    const auditor = session('deck_alpha_cc11', 'w2', 'claude-code-sdk', 'anthropic');
    const attemptId = automaticAttempt(taskId, revision);
    const assignmentId = 'asg_f1x_durable_auditor';
    const messageId = deterministicAutomaticAuditDeliveryMessageId(assignmentId, attemptId, 1);
    getDelegationReplyStore().create({
      taskId,
      assignmentId,
      purpose: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
      auditAttemptId: attemptId,
      auditRevision: revision,
      auditedSessionName: worker.name,
      messageId,
      origin: {
        sessionName: brain.name,
        sessionInstanceId: brain.sessionInstanceId!,
        runtimeEpoch: brain.runtimeEpoch!,
      },
      target: {
        sessionName: auditor.name,
        sessionInstanceId: auditor.sessionInstanceId!,
        runtimeEpoch: auditor.runtimeEpoch!,
      },
      dispatchId: 'dispatch-f1x-durable',
      now: 100,
    });
    const dispatch = vi.fn();
    const deps = {
      registry,
      listSessions: () => [brain, worker, auditor],
      listTargets: listTargetRecords(auditor),
      dispatch,
    };

    const first = await dispatchReadyAudit(taskId, deps);
    const second = await dispatchReadyAudit(taskId, deps);

    expect(first).toEqual({ status: 'replayed', assignmentId, attemptId, messageId });
    expect(second).toEqual(first);
    expect(dispatch, 'the already-durable brief must not be redelivered').not.toHaveBeenCalled();
    expect(registry.listAssignments(taskId).filter((item) => item.role === 'auditor')).toEqual([
      expect.objectContaining({
        assignmentId,
        taskId,
        role: 'auditor',
        auditAttemptId: attemptId,
        auditRevision: revision,
        identity: expect.objectContaining({ sessionName: auditor.name }),
      }),
    ]);
  });

  it('converges tsk_3xl stale delivery claims onto its one existing auditor authority', async () => {
    const { registry, taskId, revision } = makeReadyTask({
      taskId: 'tsk_3xl',
      revision: 'macos-rd-readiness-principal-fence-cc8-r1-84f249317662',
      auditPolicy: 'auto_allow_degraded',
    });
    const brain = session('deck_alpha_brain', 'brain');
    const worker = session('deck_alpha_worker', 'w1');
    const auditor = session('deck_alpha_auditor', 'w2');
    const attemptId = automaticAttempt(taskId, revision);
    const assignmentId = 'asg_aon';
    const created = registry.createAssignment({
      assignmentId,
      taskId,
      role: 'auditor',
      required: true,
      identity: {
        ...identity(auditor.name),
        sessionInstanceId: 'stale-auditor-instance',
        runtimeEpoch: 'stale-auditor-epoch',
      },
      auditAttemptId: attemptId,
      auditRevision: revision,
    });
    if (!created.ok) throw new Error(created.reason);
    const rebound = registry.rebindAuditAssignment({
      taskId,
      assignmentId,
      identity: identity(auditor.name),
      callerProjectName: 'alpha',
      reason: 'tsk_3xl exact runtime recovery',
      expectedGeneration: created.value.generation,
      expectedAttemptId: attemptId,
      expectedRevision: revision,
    });
    if (!rebound.ok) throw new Error(rebound.reason);
    const messageId = deterministicAutomaticAuditDeliveryMessageId(
      assignmentId,
      attemptId,
      rebound.value.generation,
    );
    const store = getDelegationReplyStore();
    const stale = store.create({
      taskId,
      assignmentId,
      purpose: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
      auditAttemptId: attemptId,
      auditRevision: revision,
      auditedSessionName: worker.name,
      messageId: deterministicAutomaticAuditDeliveryMessageId(
        assignmentId, attemptId, created.value.generation,
      ),
      dispatchId: 'dispatch-tsk-3xl-stale',
      origin: {
        sessionName: brain.name,
        sessionInstanceId: 'stale-brain-instance',
        runtimeEpoch: 'stale-brain-epoch',
      },
      target: {
        sessionName: auditor.name,
        sessionInstanceId: 'stale-auditor-instance',
        runtimeEpoch: 'stale-auditor-epoch',
      },
      now: 100,
    });
    const staleRedelivery = store.create({
      taskId,
      assignmentId,
      purpose: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
      auditAttemptId: attemptId,
      auditRevision: revision,
      auditedSessionName: worker.name,
      messageId: deterministicSendMessageId(`auto-audit-redelivery:${assignmentId}:${attemptId}`),
      dispatchId: 'dispatch-tsk-3xl-stale-redelivery',
      origin: {
        sessionName: brain.name,
        sessionInstanceId: 'second-stale-brain-instance',
        runtimeEpoch: 'second-stale-brain-epoch',
      },
      target: {
        sessionName: auditor.name,
        sessionInstanceId: auditor.sessionInstanceId!,
        runtimeEpoch: auditor.runtimeEpoch!,
      },
      now: 101,
    });
    const current = store.create({
      taskId,
      assignmentId,
      purpose: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
      auditAttemptId: attemptId,
      auditRevision: revision,
      auditedSessionName: worker.name,
      messageId,
      dispatchId: 'dispatch-tsk-3xl-current',
      origin: {
        sessionName: brain.name,
        sessionInstanceId: brain.sessionInstanceId!,
        runtimeEpoch: brain.runtimeEpoch!,
      },
      target: {
        sessionName: auditor.name,
        sessionInstanceId: auditor.sessionInstanceId!,
        runtimeEpoch: auditor.runtimeEpoch!,
      },
      now: 102,
    });
    const dispatch = vi.fn();

    await expect(dispatchReadyAudit(taskId, {
      registry,
      listSessions: () => [worker, auditor],
      listTargets: listTargetRecords(auditor),
      dispatch,
    })).resolves.toEqual({ status: 'replayed', assignmentId, attemptId, messageId });

    expect(dispatch, 'the exact existing delivery must not be sent twice').not.toHaveBeenCalled();
    expect(store.get(stale.record.delegationId)?.status).toBe(AGENT_DELEGATION_REPLY_STATUSES.EXPIRED);
    expect(store.get(staleRedelivery.record.delegationId)?.status)
      .toBe(AGENT_DELEGATION_REPLY_STATUSES.EXPIRED);
    expect(store.get(current.record.delegationId)?.status).toBe(AGENT_DELEGATION_REPLY_STATUSES.PENDING);
    expect(store.matchPendingAuditAuthority({
      taskId,
      assignmentId,
      auditAttemptId: attemptId,
      auditRevision: revision,
      sender: {
        sessionName: auditor.name,
        sessionInstanceId: auditor.sessionInstanceId!,
        runtimeEpoch: auditor.runtimeEpoch!,
      },
    })?.delegationId).toBe(current.record.delegationId);
    expect(registry.listAssignments(taskId).filter((item) => item.role === 'auditor'))
      .toHaveLength(1);
  });

  it.each([
    ['origin', 'stale-brain-instance', 'stale-brain-epoch'],
    ['target', 'stale-auditor-instance', 'stale-auditor-epoch'],
  ] as const)(
    'handles %s runtime identity drift without weakening auditor authority',
    async (driftedSide, staleSessionInstanceId, staleRuntimeEpoch) => {
      const { registry, taskId, revision } = makeReadyTask({
        taskId: `tsk_3xl-${driftedSide}-identity-drift`,
        auditPolicy: 'auto_allow_degraded',
      });
      const brain = session('deck_alpha_brain', 'brain');
      const worker = session('deck_alpha_worker', 'w1');
      const auditor = session('deck_alpha_auditor', 'w2');
      const attemptId = automaticAttempt(taskId, revision);
      const assignmentId = `asg_aon_${driftedSide}`;
      const created = registry.createAssignment({
        assignmentId,
        taskId,
        role: 'auditor',
        required: true,
        identity: identity(auditor.name),
        auditAttemptId: attemptId,
        auditRevision: revision,
      });
      if (!created.ok) throw new Error(created.reason);
      const exactOrigin = {
        sessionName: brain.name,
        sessionInstanceId: brain.sessionInstanceId!,
        runtimeEpoch: brain.runtimeEpoch!,
      };
      const exactTarget = {
        sessionName: auditor.name,
        sessionInstanceId: auditor.sessionInstanceId!,
        runtimeEpoch: auditor.runtimeEpoch!,
      };
      const store = getDelegationReplyStore();
      const delivery = store.create({
        taskId,
        assignmentId,
        purpose: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
        auditAttemptId: attemptId,
        auditRevision: revision,
        auditedSessionName: worker.name,
        messageId: deterministicAutomaticAuditDeliveryMessageId(
          assignmentId, attemptId, created.value.generation,
        ),
        dispatchId: `dispatch-tsk-3xl-${driftedSide}-identity-drift`,
        origin: driftedSide === 'origin'
          ? { ...exactOrigin, sessionInstanceId: staleSessionInstanceId, runtimeEpoch: staleRuntimeEpoch }
          : exactOrigin,
        target: driftedSide === 'target'
          ? { ...exactTarget, sessionInstanceId: staleSessionInstanceId, runtimeEpoch: staleRuntimeEpoch }
          : exactTarget,
        now: 100,
      });
      const delegationRowsBefore = [store.get(delivery.record.delegationId)];
      const dispatch = vi.fn();

      const result = await dispatchReadyAudit(taskId, {
        registry,
        listSessions: () => [worker, auditor],
        listTargets: listTargetRecords(auditor),
        dispatch,
      });
      expect(dispatch).not.toHaveBeenCalled();
      if (driftedSide === 'origin') {
        expect(result).toEqual({
          status: 'replayed',
          assignmentId,
          attemptId,
          messageId: delivery.record.messageId,
        });
        expect(store.get(delivery.record.delegationId)).toMatchObject({
          origin: exactOrigin,
          target: exactTarget,
          status: AGENT_DELEGATION_REPLY_STATUSES.PENDING,
        });
      } else {
        expect(result).toMatchObject({
          status: 'blocked',
          reason: 'multiple durable audit deliveries claim the exact attempt and revision',
        });
        expect([store.get(delivery.record.delegationId)]).toEqual(delegationRowsBefore);
      }
    },
  );

  it('does not adopt a stale-origin delivery from a superseded message generation', () => {
    const brain = session('deck_alpha_brain', 'brain');
    const worker = session('deck_alpha_worker', 'w1');
    const auditor = session('deck_alpha_auditor', 'w2');
    const taskId = 'tsk_3xl-stale-origin-superseded-message';
    const assignmentId = 'asg_aon_stale_origin_superseded';
    const attemptId = automaticAttempt(taskId, 'revision-stale-origin-superseded');
    const revision = 'revision-stale-origin-superseded';
    const currentMessageId = deterministicAutomaticAuditDeliveryMessageId(
      assignmentId, attemptId, 2,
    );
    const supersededMessageId = deterministicAutomaticAuditDeliveryMessageId(
      assignmentId, attemptId, 1,
    );
    const currentOrigin = {
      sessionName: brain.name,
      sessionInstanceId: brain.sessionInstanceId!,
      runtimeEpoch: brain.runtimeEpoch!,
    };
    const currentTarget = {
      sessionName: auditor.name,
      sessionInstanceId: auditor.sessionInstanceId!,
      runtimeEpoch: auditor.runtimeEpoch!,
    };
    const store = getDelegationReplyStore();
    const stale = store.create({
      taskId,
      assignmentId,
      purpose: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
      auditAttemptId: attemptId,
      auditRevision: revision,
      auditedSessionName: worker.name,
      messageId: supersededMessageId,
      dispatchId: 'dispatch-stale-origin-superseded-message',
      origin: {
        ...currentOrigin,
        sessionInstanceId: 'stale-brain-instance',
        runtimeEpoch: 'stale-brain-epoch',
      },
      target: currentTarget,
      now: 100,
    });
    const before = store.get(stale.record.delegationId);

    expect(store.findPendingAuditDelivery({
      taskId,
      auditAttemptId: attemptId,
      auditRevision: revision,
      auditedSessionName: worker.name,
      assignmentAuthority: {
        assignmentId,
        messageId: currentMessageId,
        supersededMessageIds: [supersededMessageId],
        origins: [currentOrigin],
        target: currentTarget,
      },
      now: 200,
    })).toEqual({ status: 'ambiguous' });
    expect(store.get(stale.record.delegationId)).toEqual(before);
  });

  it('does not choose between two canonical stale-origin delivery claims', () => {
    const brain = session('deck_alpha_brain', 'brain');
    const worker = session('deck_alpha_worker', 'w1');
    const auditor = session('deck_alpha_auditor', 'w2');
    const taskId = 'tsk_3xl-stale-origin-canonical-ambiguity';
    const assignmentId = 'asg_aon_stale_origin_ambiguity';
    const revision = 'revision-stale-origin-ambiguity';
    const attemptId = automaticAttempt(taskId, revision);
    const messageId = deterministicAutomaticAuditDeliveryMessageId(assignmentId, attemptId, 1);
    const currentOrigin = {
      sessionName: brain.name,
      sessionInstanceId: brain.sessionInstanceId!,
      runtimeEpoch: brain.runtimeEpoch!,
    };
    const currentTarget = {
      sessionName: auditor.name,
      sessionInstanceId: auditor.sessionInstanceId!,
      runtimeEpoch: auditor.runtimeEpoch!,
    };
    const store = getDelegationReplyStore();
    const createStale = (suffix: string, now: number) => store.create({
      taskId,
      assignmentId,
      purpose: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
      auditAttemptId: attemptId,
      auditRevision: revision,
      auditedSessionName: worker.name,
      messageId,
      dispatchId: `dispatch-stale-origin-${suffix}`,
      origin: {
        ...currentOrigin,
        sessionInstanceId: `stale-brain-instance-${suffix}`,
        runtimeEpoch: `stale-brain-epoch-${suffix}`,
      },
      target: currentTarget,
      now,
    });
    const first = createStale('one', 100);
    const second = createStale('two', 101);
    const before = [
      store.get(first.record.delegationId),
      store.get(second.record.delegationId),
    ];

    expect(store.findPendingAuditDelivery({
      taskId,
      auditAttemptId: attemptId,
      auditRevision: revision,
      auditedSessionName: worker.name,
      assignmentAuthority: {
        assignmentId,
        messageId,
        supersededMessageIds: [],
        origins: [currentOrigin],
        target: currentTarget,
      },
      now: 200,
    })).toEqual({ status: 'ambiguous' });
    expect([
      store.get(first.record.delegationId),
      store.get(second.record.delegationId),
    ]).toEqual(before);
  });

  it('keeps different assignment claims for one attempt fail-closed as true ambiguity', async () => {
    const { registry, taskId, revision } = makeReadyTask({
      taskId: 'tsk_3xl-true-ambiguity',
      auditPolicy: 'auto_allow_degraded',
    });
    const brain = session('deck_alpha_brain', 'brain');
    const worker = session('deck_alpha_worker', 'w1');
    const auditor = session('deck_alpha_auditor', 'w2');
    const attemptId = automaticAttempt(taskId, revision);
    const assignmentId = 'asg_aon';
    const created = registry.createAssignment({
      assignmentId,
      taskId,
      role: 'auditor',
      required: true,
      identity: identity(auditor.name),
      auditAttemptId: attemptId,
      auditRevision: revision,
    });
    if (!created.ok) throw new Error(created.reason);
    const store = getDelegationReplyStore();
    const exactIdentity = {
      origin: {
        sessionName: brain.name,
        sessionInstanceId: brain.sessionInstanceId!,
        runtimeEpoch: brain.runtimeEpoch!,
      },
      target: {
        sessionName: auditor.name,
        sessionInstanceId: auditor.sessionInstanceId!,
        runtimeEpoch: auditor.runtimeEpoch!,
      },
      purpose: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
      auditAttemptId: attemptId,
      auditRevision: revision,
      auditedSessionName: worker.name,
      taskId,
    } as const;
    const current = store.create({
      ...exactIdentity,
      assignmentId,
      messageId: deterministicAutomaticAuditDeliveryMessageId(
        assignmentId, attemptId, created.value.generation,
      ),
      dispatchId: 'dispatch-tsk-3xl-authoritative',
      now: 100,
    });
    const conflicting = store.create({
      ...exactIdentity,
      assignmentId: 'asg_foreign_claim',
      // Deliberately reuse the existing object's delivery id: assignment
      // authority, not message equality, must keep this a true ambiguity.
      messageId: current.record.messageId,
      dispatchId: 'dispatch-tsk-3xl-conflicting',
      now: 101,
    });
    const dispatch = vi.fn();

    await expect(dispatchReadyAudit(taskId, {
      registry,
      listSessions: () => [worker, auditor],
      listTargets: listTargetRecords(auditor),
      dispatch,
    })).resolves.toMatchObject({
      status: 'blocked',
      reason: 'multiple durable audit deliveries claim the exact attempt and revision',
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(store.get(current.record.delegationId)?.status).toBe(AGENT_DELEGATION_REPLY_STATUSES.PENDING);
    expect(store.get(conflicting.record.delegationId)?.status).toBe(AGENT_DELEGATION_REPLY_STATUSES.PENDING);
  });

  it.each([
    ['tsk_d4d', 'post-pass-successor-owner-retirement-cx1-r1-eb2b2965f045'],
    ['tsk_djb', 'provider-route-restart-hydration-cx5-r1-ea6185551042'],
  ])('boot-materializes exactly one strict auditor for archived live %s without refinish', async (taskId, revision) => {
    const root = mkdtempSync(join(tmpdir(), `imcodes-${taskId}-zero-auditor-`));
    const dbPath = join(root, 'registry.sqlite');
    let registry = new SupervisionTaskRegistry({ dbPath });
    try {
      makeReadyTask({ taskId, revision, auditPolicy: 'auto_strict_cross_vendor', registry });
      registry.close();

      // Exact production drift: task_get reads the live ready_for_audit row,
      // while an obsolete retention marker used to hide it from the
      // status-filtered list that drives boot/tick materialization.
      const database = new DatabaseSync(dbPath);
      const row = database.prepare(
        'SELECT payload_json AS payloadJson FROM supervision_tasks WHERE task_id = ?',
      ).get(taskId) as { payloadJson: string };
      database.prepare('UPDATE supervision_tasks SET payload_json = ? WHERE task_id = ?')
        .run(JSON.stringify({ ...JSON.parse(row.payloadJson), archivedAt: 1 }), taskId);
      database.close();

      registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.get(taskId)).toMatchObject({
        taskId, status: 'ready_for_audit', validationState: 'passed',
        currentRevision: revision, auditPolicy: 'auto_strict_cross_vendor', archivedAt: 1,
      });
      expect(registry.list({ status: 'ready_for_audit' }).map((task) => task.taskId)).toContain(taskId);

      const brain = session('deck_alpha_brain', 'brain');
      const worker = session('deck_alpha_worker', 'w1');
      const auditor = session(`deck_alpha_${taskId}_auditor`, 'w2', 'claude-code-sdk', 'anthropic');
      let evidence = false;
      const dispatch = vi.fn(async (_caller: SendRuntimeCaller, input: SendMessageInput) => {
        const created = registry.createAssignment({
          taskId, role: 'auditor', required: false,
          identity: identity(auditor.name, 'claude-code-sdk', 'anthropic'),
          auditAttemptId: input.audit!.attemptId, auditRevision: revision,
          idempotencyKey: `send:${input.idempotencyKey}`,
        });
        if (!created.ok) throw new Error(created.reason);
        evidence = true;
        return {
          status: 'accepted' as const,
          dispatchId: 'send_dispatch_00000000-0000-4000-8000-0000000000d4' as const,
          messageId: 'send_message_00000000-0000-5000-a000-0000000000d4' as SendMessageId,
          deliveries: [{ target: auditor.name, status: 'queued' as const }],
          taskId, assignmentId: created.value.assignmentId,
        };
      });
      const deps = {
        registry,
        listSessions: () => [brain, worker, auditor],
        listTargets: listTargetRecords(auditor),
        dispatch,
        hasDeliveryEvidence: () => evidence,
      };

      __resetSupervisionConvergenceTickForTests();
      await expect(dispatchReadyAuditSweep(deps)).resolves.toEqual([
        expect.objectContaining({ status: 'dispatched', attemptId: automaticAttempt(taskId, revision) }),
      ]);
      __resetSupervisionConvergenceTickForTests();
      await expect(runSupervisionConvergenceTick(deps)).resolves.toMatchObject({
        audits: [expect.objectContaining({ status: 'replayed', attemptId: automaticAttempt(taskId, revision) })],
      });
      expect(dispatch).toHaveBeenCalledOnce();
      expect(registry.listAssignments(taskId).filter((item) => item.role === 'implementer')).toHaveLength(1);
      expect(registry.listAssignments(taskId).filter((item) => item.role === 'auditor')).toHaveLength(1);
      expect(registry.listAuditReceipts(taskId)).toEqual([]);
    } finally {
      registry.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets the exact Brain recover no_selected_config with one fresh strict cross-vendor auditor', async () => {
    const registry = getSupervisionTaskRegistry();
    const { taskId, revision, worker } = makeReadyTask({
      taskId: 'zero-auditor-no-selected-config',
      revision: 'zero-auditor-no-selected-config-r1',
      auditPolicy: 'auto_strict_cross_vendor',
      registry,
    });
    const brain = session('deck_alpha_brain', 'brain');
    brain.transportConfig = {
      supervision: normalizeSessionSupervisionSnapshot({
        mode: 'supervised_audit', executionPools: { state: 'legacy_unconfigured' },
      }),
    };
    const implementer = session('deck_alpha_worker', 'w1');
    const auditor = session('deck_alpha_exact_route', 'w2', 'claude-code-sdk', 'anthropic');
    const attemptId = automaticAttempt(taskId, revision);
    const beforeImplementer = registry.getAssignment(worker.assignmentId);
    const dispatchMessage = vi.fn().mockResolvedValue({ status: 'queued' });

    let blockerDelivered = false;
    await expect(dispatchReadyAudit(taskId, {
      registry,
      listSessions: () => [brain, implementer, auditor],
      listTargets: listTargetRecords(),
      dispatch: vi.fn(async (_caller: SendRuntimeCaller, input: SendMessageInput) => {
        if (input.audit) {
          return {
            status: 'error' as const,
            reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
            error: 'supervision target provisioning blocked: no_selected_config',
          };
        }
        blockerDelivered = true;
        return {
          status: 'accepted' as const,
          dispatchId: 'send_dispatch_00000000-0000-4000-8000-0000000000d5' as const,
          messageId: input.internalMessageId!,
          deliveries: [{ target: brain.name, status: 'queued' as const }],
        };
      }),
      hasDeliveryEvidence: () => blockerDelivered,
    })).resolves.toMatchObject({
      status: 'blocked', reason: 'supervision target provisioning blocked: no_selected_config',
    });
    const durableBlocker = registry.get(taskId)!.blocker!;
    expect(JSON.parse(durableBlocker)).toMatchObject({
      kind: 'automatic_audit_routing', taskId, assignmentId: worker.assignmentId,
      revision, attemptId, exactError: 'supervision target provisioning blocked: no_selected_config',
      disposition: 'waiting_for_brain',
    });
    expect(registry.getAssignment(worker.assignmentId)?.blocker).toBe(durableBlocker);

    const recoveryInput = (): SendMessageInput => ({
      target: auditor.name,
      message: 'recover the exact zero-auditor task',
      reply: true,
      idempotencyKey: `exact-zero-auditor:${taskId}:${revision}`,
      newWorkload: true,
      audit: {
        kind: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
        attemptId,
        auditedSessionName: implementer.name,
        strictCrossVendor: true,
      },
      task: {
        taskId,
        currentRevision: revision,
        auditRevision: revision,
        auditAttemptId: attemptId,
        auditPolicy: 'auto_strict_cross_vendor',
        executionPool: 'primary',
      },
    });
    const recoveryDeps = {
      listSessions: () => [brain, implementer, auditor],
      dispatchMessage,
      ensureSupervisionAssignmentWorktree: async ({ assignmentId }: { assignmentId: string }) => ({
        ok: true as const, worktreePath: `/tmp/${assignmentId}/repo`, baseRevision: undefined,
      }),
    };

    const first = await dispatchSendMessage({
      userId: brain.name, sessionName: brain.name, projectName: 'alpha', projectRoot: '/work/alpha',
    }, recoveryInput(), recoveryDeps);

    expect(first, JSON.stringify(first)).toMatchObject({
      status: 'accepted', taskId, assignmentId: expect.any(String),
    });
    const assignments = registry.listAssignments(taskId);
    expect(assignments.filter((item) => item.role === 'implementer')).toEqual([
      expect.objectContaining({ assignmentId: worker.assignmentId }),
    ]);
    expect(registry.getAssignment(worker.assignmentId)).toMatchObject({
      assignmentId: beforeImplementer!.assignmentId,
      identity: beforeImplementer!.identity,
      status: beforeImplementer!.status,
      auditRevision: beforeImplementer!.auditRevision,
      scopeFiles: beforeImplementer!.scopeFiles,
    });
    expect(registry.get(taskId)).not.toHaveProperty('blocker');
    expect(registry.getAssignment(worker.assignmentId)).not.toHaveProperty('blocker');
    expect(assignments.filter((item) => item.role === 'auditor')).toEqual([
      expect.objectContaining({
        auditAttemptId: attemptId,
        auditRevision: revision,
        identity: expect.objectContaining({ sessionName: auditor.name, providerFamily: 'anthropic' }),
      }),
    ]);

    const replay = await dispatchSendMessage({
      userId: brain.name, sessionName: brain.name, projectName: 'alpha', projectRoot: '/work/alpha',
    }, recoveryInput(), recoveryDeps);
    expect(replay).toMatchObject({ status: 'accepted', idempotentReplay: true, taskId });
    expect(registry.listAssignments(taskId).filter((item) => item.role === 'auditor')).toHaveLength(1);
    expect(dispatchMessage).toHaveBeenCalledOnce();
  });

  it('repairs a partially-converged selected auditor binding and dispatches the SAME object once', async () => {
    const registry = getSupervisionTaskRegistry();
    const ready = makeReadyTask({
      taskId: 'existing-auditor-selected-cross-vendor',
      revision: 'existing-auditor-selected-cross-vendor-r1',
      auditPolicy: 'auto_allow_degraded',
      registry,
    });
    const attemptId = 'auto-audit-existing-selected-r1';
    // Production shape: assignment identity and the binding's identity fields
    // already point at the selected CC. Only requested/model/runtimeType are
    // stale, so identity-only drift detection cannot see the corruption.
    const oldAuditorIdentity = identity('deck_alpha_selected_cc', 'claude-code-sdk', 'anthropic');
    const auditor = registry.createAssignment({
      taskId: ready.taskId,
      role: 'auditor',
      required: false,
      identity: oldAuditorIdentity,
      auditAttemptId: attemptId,
      auditRevision: ready.revision,
      auditRoutingReason: 'same_family_degraded',
      auditDegradedReason: 'cross_vendor_limited',
      executionBinding: {
        pool: 'primary',
        origin: 'reused',
        requested: {
          capabilityId: 'supervision-exec-v1:transport:cursor-headless:cursor:Auto',
          agentType: 'cursor-headless', providerFamily: 'cursor', runtimeType: 'transport', model: 'Auto',
        },
        actual: {
          ...oldAuditorIdentity, runtimeType: 'process', model: 'Auto',
        },
      },
    });
    if (!auditor.ok) throw new Error(auditor.reason);

    const brain = session('deck_alpha_brain', 'brain');
    const cx = {
      agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport' as const, model: 'gpt-5.6',
    };
    const cc = {
      agentType: 'claude-code-sdk', providerFamily: 'anthropic',
      runtimeType: 'transport' as const, model: 'claude-sonnet-4-6',
    };
    brain.transportConfig = {
      supervision: normalizeSessionSupervisionSnapshot({
        mode: 'supervised_audit',
        executionPools: {
          state: 'configured',
          primaryDevelopmentPool: {
            configs: [
              { ...cx, capabilityId: buildSupervisionExecutionCapabilityId(cx) },
              { ...cc, capabilityId: buildSupervisionExecutionCapabilityId(cc) },
            ],
            controls: { maxSpawned: 2 },
          },
          economyTaskPool: { configs: [], controls: { maxSpawned: 0 } },
        },
      }),
    };
    const implementer = session('deck_alpha_worker', 'w1');
    const replacement = session('deck_alpha_selected_cc', 'w2', 'claude-code-sdk', 'anthropic');
    const dispatchMessage = vi.fn().mockResolvedValue({ status: 'queued' });

    const result = await dispatchSendMessage({
      userId: brain.name, sessionName: brain.name, projectName: 'alpha', projectRoot: '/work/alpha',
    }, {
      target: replacement.name,
      message: 'resume the exact strict audit on selected CC',
      reply: true,
      idempotencyKey: 'existing-selected-cross-vendor-rebind',
      audit: {
        kind: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
        attemptId,
        auditedSessionName: implementer.name,
        strictCrossVendor: true,
      },
      task: {
        taskId: ready.taskId,
        assignmentId: auditor.value.assignmentId,
        currentRevision: ready.revision,
        auditRevision: ready.revision,
        auditAttemptId: attemptId,
        auditPolicy: 'auto_allow_degraded',
        executionPool: 'primary',
      },
    }, {
      listSessions: () => [brain, implementer, replacement],
      dispatchMessage,
      ensureSupervisionAssignmentWorktree: async () => ({
        ok: true, worktreePath: '/tmp/existing-selected-cross-vendor/repo',
        baseRevision: 'a'.repeat(40), created: false,
      }),
      hasDeliveryEvidence: () => false,
    });

    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'accepted', taskId: ready.taskId, assignmentId: auditor.value.assignmentId,
    });
    expect(registry.listAssignments(ready.taskId).filter((item) => item.role === 'auditor')).toHaveLength(1);
    expect(registry.getAssignment(auditor.value.assignmentId)).toMatchObject({
      assignmentId: auditor.value.assignmentId,
      generation: 2,
      auditAttemptId: attemptId,
      auditRevision: ready.revision,
      identity: identity(replacement.name, 'claude-code-sdk', 'anthropic'),
      auditRoutingReason: 'cross_vendor_preferred',
      executionBinding: {
        pool: 'primary',
        requested: {
          capabilityId: buildSupervisionExecutionCapabilityId(cc),
          ...cc,
          model: 'sonnet',
        },
        actual: {
          sessionName: replacement.name,
          sessionInstanceId: replacement.sessionInstanceId,
          runtimeEpoch: replacement.runtimeEpoch,
          agentType: 'claude-code-sdk',
          providerFamily: 'anthropic',
          runtimeType: 'transport',
          model: 'claude-sonnet-4-6',
        },
      },
    });
    expect(registry.getAssignment(auditor.value.assignmentId)).not.toHaveProperty('auditDegradedReason');
    expect(dispatchMessage).toHaveBeenCalledOnce();
  });

  it('keeps an existing strict auditor fail-closed when CC is not pool-selected', async () => {
    const registry = getSupervisionTaskRegistry();
    const ready = makeReadyTask({
      taskId: 'existing-auditor-unselected-cc',
      revision: 'existing-auditor-unselected-cc-r1',
      auditPolicy: 'auto_allow_degraded',
      registry,
    });
    const attemptId = 'auto-audit-existing-unselected-r1';
    const existing = registry.createAssignment({
      taskId: ready.taskId, role: 'auditor', required: false,
      identity: identity('deck_alpha_old_cx_auditor'),
      auditAttemptId: attemptId, auditRevision: ready.revision,
    });
    if (!existing.ok) throw new Error(existing.reason);
    const brain = session('deck_alpha_brain', 'brain');
    const selectedCx = {
      agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport' as const, model: 'gpt-5.6',
    };
    brain.transportConfig = {
      supervision: normalizeSessionSupervisionSnapshot({
        mode: 'supervised_audit',
        executionPools: {
          state: 'configured',
          primaryDevelopmentPool: {
            configs: [{ ...selectedCx, capabilityId: buildSupervisionExecutionCapabilityId(selectedCx) }],
            controls: { maxSpawned: 2 },
          },
          economyTaskPool: { configs: [], controls: { maxSpawned: 0 } },
        },
      }),
    };
    const implementer = session('deck_alpha_worker', 'w1');
    const unselectedCc = session('deck_alpha_unselected_cc', 'w2', 'claude-code-sdk', 'anthropic');
    const before = registry.getAssignment(existing.value.assignmentId);
    const dispatchMessage = vi.fn();
    const result = await dispatchSendMessage({
      userId: brain.name, sessionName: brain.name, projectName: 'alpha', projectRoot: '/work/alpha',
    }, {
      target: unselectedCc.name, message: 'must remain fail closed', reply: true,
      // This is the daemon-owned automatic route, not a user's explicit Brain
      // selection. Automatic sends must never enter the manual Brain override.
      automaticSupervision: true,
      audit: {
        kind: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
        attemptId, auditedSessionName: implementer.name, strictCrossVendor: true,
      },
      task: {
        taskId: ready.taskId, assignmentId: existing.value.assignmentId,
        currentRevision: ready.revision, auditRevision: ready.revision,
        auditAttemptId: attemptId, auditPolicy: 'auto_allow_degraded', executionPool: 'primary',
      },
    }, { listSessions: () => [brain, implementer, unselectedCc], dispatchMessage });

    expect(result).toMatchObject({
      status: 'error', reason: MCP_ERROR_REASONS.IDENTITY_REJECTED,
      error: 'task execution pool rejected target: unselected_config',
    });
    expect(registry.getAssignment(existing.value.assignmentId)).toEqual(before);
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it.each([
    'wrong_attempt',
    'wrong_revision',
    'conflicting_policy',
    'same_vendor',
    'non_brain',
  ] as const)('keeps no_selected_config fail-closed for %s', async (variant) => {
    const registry = getSupervisionTaskRegistry();
    const taskId = `zero-auditor-reject-${variant}`;
    const revision = `${taskId}-r1`;
    const ready = makeReadyTask({ taskId, revision, auditPolicy: 'auto_strict_cross_vendor', registry });
    const brain = session('deck_alpha_brain', 'brain');
    brain.transportConfig = {
      supervision: normalizeSessionSupervisionSnapshot({
        mode: 'supervised_audit', executionPools: { state: 'legacy_unconfigured' },
      }),
    };
    const implementer = session('deck_alpha_worker', 'w1');
    const target = variant === 'same_vendor'
      ? session('deck_alpha_same_vendor', 'w2', 'codex-sdk', 'openai')
      : session('deck_alpha_cross_vendor', 'w2', 'claude-code-sdk', 'anthropic');
    const caller = variant === 'non_brain'
      ? session('deck_alpha_not_brain', 'w3')
      : brain;
    const requestedRevision = variant === 'wrong_revision' ? `${revision}-wrong` : revision;
    const attemptId = variant === 'wrong_attempt'
      ? `auto-audit-${'f'.repeat(24)}`
      : automaticAttempt(taskId, requestedRevision);
    const result = await dispatchSendMessage({
      userId: caller.name, sessionName: caller.name, projectName: 'alpha', projectRoot: '/work/alpha',
    }, {
      target: target.name,
      message: 'must stay fail closed',
      reply: true,
      idempotencyKey: `reject-zero-auditor:${variant}`,
      newWorkload: true,
      // Keep the automatic route distinguishable from a user's explicit exact
      // target choice: only the latter may use manual Brain authority.
      automaticSupervision: true,
      audit: {
        kind: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
        attemptId,
        auditedSessionName: implementer.name,
        strictCrossVendor: true,
      },
      task: {
        taskId,
        currentRevision: requestedRevision,
        auditRevision: requestedRevision,
        auditAttemptId: attemptId,
        auditPolicy: variant === 'conflicting_policy'
          ? 'auto_allow_degraded'
          : 'auto_strict_cross_vendor',
        executionPool: 'primary',
      },
    }, {
      listSessions: () => [brain, ...(caller.name === brain.name ? [] : [caller]), implementer, target],
      dispatchMessage: vi.fn(),
      ensureSupervisionAssignmentWorktree: async ({ assignmentId }) => ({
        ok: true as const, worktreePath: `/tmp/${assignmentId}/repo`, baseRevision: undefined,
      }),
    });
    expect(result).toMatchObject({ status: 'error' });
    expect(registry.listAssignments(taskId).filter((item) => item.role === 'auditor')).toEqual([]);
    expect(registry.getAssignment(ready.worker.assignmentId)).toMatchObject({
      status: 'ready_for_audit', auditRevision: revision,
    });
  });

  it('keeps the recoverable routing blocker durable across restart and clears only its exact CAS token', () => {
    const root = mkdtempSync(join(tmpdir(), 'imcodes-zero-auditor-routing-blocker-'));
    const dbPath = join(root, 'registry.sqlite');
    let registry = new SupervisionTaskRegistry({ dbPath });
    try {
      const ready = makeReadyTask({
        taskId: 'zero-auditor-routing-restart',
        revision: 'zero-auditor-routing-restart-r1',
        auditPolicy: 'auto_strict_cross_vendor',
        registry,
      });
      const blocker = JSON.stringify({
        kind: 'automatic_audit_routing',
        taskId: ready.taskId,
        assignmentId: ready.worker.assignmentId,
        revision: ready.revision,
        attemptId: automaticAttempt(ready.taskId, ready.revision),
        exactError: 'supervision target provisioning blocked: no_selected_config',
        disposition: 'waiting_for_brain',
      });
      expect(registry.recordAutomaticAuditRoutingBlocker({
        taskId: ready.taskId, assignmentId: ready.worker.assignmentId, blocker, now: 100,
      })).toMatchObject({ ok: true });
      registry.close();
      registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.get(ready.taskId)?.blocker).toBe(blocker);
      expect(registry.getAssignment(ready.worker.assignmentId)?.blocker).toBe(blocker);

      expect(registry.clearAutomaticAuditRoutingBlocker({
        taskId: ready.taskId,
        assignmentId: ready.worker.assignmentId,
        blocker: `${blocker}-not-the-CAS-token`,
        now: 200,
      })).toMatchObject({ ok: true, replay: true });
      expect(registry.get(ready.taskId)?.blocker).toBe(blocker);
      expect(registry.clearAutomaticAuditRoutingBlocker({
        taskId: ready.taskId, assignmentId: ready.worker.assignmentId, blocker, now: 300,
      })).toMatchObject({ ok: true });
      registry.close();
      registry = new SupervisionTaskRegistry({ dbPath });
      expect(registry.get(ready.taskId)).not.toHaveProperty('blocker');
      expect(registry.getAssignment(ready.worker.assignmentId)).not.toHaveProperty('blocker');
    } finally {
      registry.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('classifies a mirrored non-JSON automatic-audit blocker as stale authority', () => {
    const registry = getSupervisionTaskRegistry();
    const ready = makeReadyTask({
      taskId: 'malformed-automatic-audit-authority',
      revision: 'malformed-automatic-audit-authority-r1',
      auditPolicy: 'auto_strict_cross_vendor',
      registry,
    });
    const brain = session('deck_alpha_brain', 'brain');
    const malformedBlocker = 'waiting on CI logs; will retry';
    upsertSession(brain);
    try {
      expect(registry.recordAutomaticAuditRoutingBlocker({
        taskId: ready.taskId,
        assignmentId: ready.worker.assignmentId,
        blocker: malformedBlocker,
        now: 100,
      })).toMatchObject({ ok: true });
      expect(registry.getTaskRecord(ready.taskId)?.blocker).toBe(malformedBlocker);
      expect(registry.getAssignment(ready.worker.assignmentId)?.blocker).toBe(malformedBlocker);

      expect(resolveQueuedSupervisionHeartbeatDelivery({
        targetSessionName: brain.name,
        clientMessageId: deterministicSendMessageId(
          `automatic-audit-blocker:${ready.taskId}:${ready.revision}:malformed`,
        ),
        text: malformedBlocker,
        supervisionReference: {
          kind: 'implementation_blocker',
          taskId: ready.taskId,
          assignmentId: ready.worker.assignmentId,
          revision: ready.revision,
          exactError: 'automatic audit routing is blocked',
        },
      })).toBe('stale');
    } finally {
      removeSession(brain.name);
    }
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

  it('carries the exact selected cross-vendor auditor config from routing into pool validation', async () => {
    const { registry, taskId, revision } = makeReadyTask({
      taskId: 'exact-cross-vendor-config',
      revision: 'exact-cross-vendor-config-r1',
      auditPolicy: 'auto_strict_cross_vendor',
    });
    const brain = session('deck_alpha_brain', 'brain');
    const worker = session('deck_alpha_worker', 'w1');
    const auditor = session('deck_alpha_cc', 'w2', 'claude-code-sdk', 'anthropic');
    auditor.activeModel = 'claude-sonnet-5';
    auditor.requestedModel = 'sonnet';
    const anthropic = {
      agentType: 'claude-code-sdk', providerFamily: 'anthropic',
      runtimeType: 'transport' as const, model: 'sonnet',
    };
    const openai = {
      agentType: 'codex-sdk', providerFamily: 'openai',
      runtimeType: 'transport' as const, model: 'gpt-5.6-sol',
    };
    const configuredWithoutLiveSession = {
      agentType: 'codex-sdk', providerFamily: 'openai',
      runtimeType: 'transport' as const, model: 'gpt-5.6-terra',
    };
    brain.transportConfig = {
      supervision: normalizeSessionSupervisionSnapshot({
        mode: 'supervised_audit',
        executionPools: {
          state: 'configured',
          primaryDevelopmentPool: {
            configs: [
              { ...openai, capabilityId: buildSupervisionExecutionCapabilityId(openai) },
              { ...anthropic, capabilityId: buildSupervisionExecutionCapabilityId(anthropic) },
              {
                ...configuredWithoutLiveSession,
                capabilityId: buildSupervisionExecutionCapabilityId(configuredWithoutLiveSession),
              },
            ],
            controls: { maxSpawned: 2 },
          },
          economyTaskPool: { configs: [], controls: { maxSpawned: 0 } },
        },
      }),
    };
    const calls: SendMessageInput[] = [];
    const dispatch = vi.fn(async (_caller: SendRuntimeCaller, input: SendMessageInput) => {
      calls.push(input);
      return {
        status: 'accepted' as const,
        assignmentId: 'asg_exact_cross_vendor',
        messageId: 'send_message_00000000-0000-5000-a000-00000000c055' as SendMessageId,
      };
    });

    await expect(dispatchReadyAudit(taskId, {
      registry,
      listSessions: () => [brain, worker, auditor],
      listTargets: () => listSendTargets({
        userId: brain.name, sessionName: brain.name, projectName: 'alpha', projectRoot: '/work/alpha',
      }, { executionPool: 'primary', limit: 100 }, { listSessions: () => [brain, worker, auditor] }),
      dispatch,
      hasDeliveryEvidence: () => false,
    })).resolves.toMatchObject({ status: 'dispatched' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.target).toBe(auditor.name);
    expect(calls[0]?.task?.requestedExecutionType).toEqual({
      ...anthropic,
      capabilityId: buildSupervisionExecutionCapabilityId(anthropic),
    });
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

    const beforeAssignments = registry.listAssignments(taskId).map((assignment) => ({
      assignmentId: assignment.assignmentId,
      role: assignment.role,
      status: assignment.status,
      identity: assignment.identity,
      auditRevision: assignment.auditRevision,
    }));
    const first = await dispatchReadyAudit(taskId, deps);
    const secondRun = await dispatchReadyAudit(taskId, deps);
    const third = await dispatchReadyAudit(taskId, deps);

    expect(first.status).toBe('blocked');
    expect(secondRun.status).toBe('blocked');
    expect(third.status).toBe('blocked');
    // ONE question, not one per tick.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(delivered.size).toBe(1);
    // The question itself is now durable authority for its queued row, while
    // role/status/identity/revision ownership remains unchanged.
    expect(registry.listAssignments(taskId).map((assignment) => ({
      assignmentId: assignment.assignmentId,
      role: assignment.role,
      status: assignment.status,
      identity: assignment.identity,
      auditRevision: assignment.auditRevision,
    }))).toEqual(beforeAssignments);
    const durable = registry.get(taskId)!;
    expect(durable.blocker).toBe(durable.assignments.find(
      (assignment) => assignment.assignmentId !== second.value.assignmentId && assignment.role === 'implementer',
    )?.blocker);
    expect(JSON.parse(durable.blocker!)).toMatchObject({
      kind: 'automatic_audit_routing', taskId, revision,
      exactError: 'automatic audit requires one exact ready implementer revision',
    });
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
        'kind', 'taskId', 'assignmentId', 'revision', 'attemptId', 'exactError',
        'completedSafeWork', 'recommendedNextAction', 'disposition',
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
    expect(registry.get(taskId)?.blocker).toBe(registry.getAssignment(
      registry.listAssignments(taskId).find((item) => item.role === 'implementer')!.assignmentId,
    )?.blocker);
    expect(JSON.parse(registry.get(taskId)!.blocker!)).toMatchObject({
      kind: 'automatic_audit_routing', disposition: 'waiting_for_brain',
      exactError: 'supervision target provisioning blocked: no_selected_config',
    });
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

  it('dispatches a FRESH auditor when a legitimate re-audit request lands after a final receipt on the SAME revision (tsk_uh4)', async () => {
    // Live bug, reproduced 3 times today (tsk_udb, tsk_u7q, tsk_ug1):
    // automaticAuditAttemptId is deterministic on (taskId, revision) alone, so
    // a coordinator/implementer who legitimately re-opens audit on the exact
    // same, unchanged revision (record_validation + open_audit again -- e.g.
    // after correcting acceptance criteria) produces the SAME attemptId as
    // the one an OLDER final receipt already decided. Before the fix,
    // `decidedByFinalReceipt` could not tell that apart from a stale replay
    // of the SAME already-decided delivery (the R12/tsk_4d0 case the two
    // tests above protect) and silently reused the stale verdict forever --
    // no new auditAttemptId, no heartbeat, nothing. The only reliable
    // workaround was manufacturing a fake new commit just to change the
    // revision hash.
    __resetSupervisionConvergenceTickForTests();
    const { registry, taskId, revision } = makeReadyTask({ auditPolicy: 'auto_strict_cross_vendor' });
    const attemptId = automaticAttempt(taskId, revision);
    const implementerId = registry.get(taskId)!.assignments.find((a) => a.role === 'implementer')!.assignmentId;

    // An auditor already ran this EXACT attempt+revision and filed a REWORK
    // final receipt -- the task's real prior audit round.
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
      findings: 'first pass: needs rework', validations: [],
    } as never)).toMatchObject({ ok: true });
    // Auditor finalized, exactly like a real closed REWORK round.
    for (const status of ['rework'] as const) {
      expect(registry.updateAssignment({
        assignmentId: auditor.value.assignmentId, identity: auditor.value.identity,
        status, auditAttemptId: attemptId, auditRevision: revision, verdict: 'REWORK',
      } as never)).toMatchObject({ ok: true });
    }
    expect(registry.finishAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditor.value.identity, revision,
    })).toMatchObject({ ok: true });

    const sessions = [
      session('deck_alpha_brain', 'brain'),
      session('deck_alpha_worker', 'w1'),
      session('deck_alpha_auditor', 'w2', 'claude-code-sdk', 'anthropic'),
    ];
    const dispatched: SendMessageInput[] = [];
    const dispatch = vi.fn(async (_c: SendRuntimeCaller, input: SendMessageInput) => {
      dispatched.push(input);
      const created = registry.createAssignment({
        taskId, role: 'auditor', required: false,
        identity: identity('deck_alpha_second_auditor', 'claude-code-sdk', 'anthropic'),
        auditAttemptId: input.audit!.attemptId,
        auditRevision: revision,
        idempotencyKey: `send:${input.idempotencyKey}`,
      });
      if (!created.ok) throw new Error(created.reason);
      return {
        status: 'accepted' as const,
        dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000001' as const,
        messageId: 'send_message_00000000-0000-5000-a000-000000000001' as SendMessageId,
        deliveries: [{ target: 'deck_alpha_second_auditor', status: 'queued' as const }],
        taskId,
        assignmentId: created.value.assignmentId,
      };
    });
    const deps = {
      registry, listSessions: () => [...sessions, session('deck_alpha_second_auditor', 'w3', 'claude-code-sdk', 'anthropic')],
      listTargets: listTargetRecords(sessions[2]!), dispatch,
      hasDeliveryEvidence: () => dispatched.length > 0,
    };

    // Finalizing the REWORK auditor derives the task to 'rework', same as a
    // real closed round -- confirms this is the realistic starting shape,
    // not a fabricated one.
    expect(registry.get(taskId)!.status).toBe('rework');

    // The legitimate re-request: record_validation(passed) + open_audit on
    // the implementer, exactly what a coordinator/implementer calls to ask
    // for a fresh look -- the revision never changes.
    expect(registry.applyTaskIntent({
      expectedRevision: revision, taskId, assignmentId: implementerId,
      intent: 'record_validation', toStatus: 'validated', validationState: 'passed',
    })).toMatchObject({ ok: true });
    expect(registry.applyTaskIntent({
      expectedRevision: revision, taskId, assignmentId: implementerId,
      intent: 'open_audit', toStatus: 'ready_for_audit',
    })).toMatchObject({ ok: true });
    expect(registry.get(taskId)!.status).toBe('ready_for_audit');
    expect(registry.getAssignment(implementerId)!.status).toBe('ready_for_audit');

    const after = await dispatchReadyAudit(taskId, deps);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(after).not.toMatchObject({ status: 'ignored', reason: 'final_receipt_recorded' });
    // A genuinely NEW auditor now exists for this exact (still unchanged)
    // revision -- the fresh dispatch this whole task exists to guarantee.
    const auditors = registry.get(taskId)!.assignments.filter((a) => a.role === 'auditor');
    expect(auditors).toHaveLength(2);
    expect(auditors.some((a) => a.status !== 'rework' && a.status !== 'finalized')).toBe(true);
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

  it('redelivers tsk_csx/asg_cuw once when delegated has no visible acceptance/claim/receipt', async () => {
    const taskId = 'tsk_csx';
    const revision = 'rtc-isolation-phase1-design-cc2-r1-09fd88feeb36';
    const { registry } = makeReadyTask({ taskId, revision, auditPolicy: 'auto_strict_cross_vendor' });
    const attemptId = 'auto-audit-213feddb83db7a1d8cdf4eb6';
    const auditor = registry.createAssignment({
      assignmentId: 'asg_cuw',
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
    let activeClaim = false;
    const dispatch = vi.fn(async (_caller: SendRuntimeCaller, input: SendMessageInput) => {
      activeClaim = true;
      return {
        status: 'accepted' as const,
        dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000099' as const,
        messageId: input.internalMessageId!,
        deliveries: [{ target: sessions[2]!.name, status: 'queued' as const }],
        taskId,
        assignmentId: auditor.value.assignmentId,
      };
    });
    const deps = {
      registry,
      listSessions: () => sessions,
      listTargets: listTargetRecords(sessions[2]!),
      dispatch,
      now: () => 100 + 11 * 60_000,
      // The original exact delivery was consumed; the distinct deterministic
      // redelivery id has no receipt yet.
      hasDeliveryEvidence: () => ++evidenceChecks === 1,
      hasActiveAuditExecutionClaim: () => activeClaim,
    };

    await expect(dispatchReadyAudit(taskId, deps)).resolves.toMatchObject({
      status: 'dispatched', assignmentId: auditor.value.assignmentId, attemptId,
    });
    evidenceChecks = 0;
    await expect(dispatchReadyAudit(taskId, deps)).resolves.toMatchObject({
      status: 'replayed', assignmentId: auditor.value.assignmentId, attemptId,
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]![1]).toMatchObject({
      target: sessions[2]!.name,
      task: { assignmentId: auditor.value.assignmentId, auditAttemptId: attemptId, auditRevision: revision },
      audit: { attemptId },
    });
  });

  it('reopens a Brain-cancelled undelivered auditor with one complete selected binding', async () => {
    const taskId = 'tsk_d4d';
    const revision = 'post-pass-successor-owner-retirement-cx1-r1-eb2b2965f045';
    const attemptId = 'auto-audit-30656902ee6c14fbdcb2751b';
    const { registry } = makeReadyTask({ taskId, revision, auditPolicy: 'auto_strict_cross_vendor' });
    const brain = session('deck_alpha_brain', 'brain');
    const oldIdentity = identity('deck_alpha_live_cc9', 'claude-code-sdk', 'anthropic');
    const staleRequested = {
      agentType: 'cursor-headless', providerFamily: 'cursor', runtimeType: 'transport' as const, model: 'Auto',
    };
    const auditor = registry.createAssignment({
      assignmentId: 'asg_dlt', taskId, role: 'auditor', required: false,
      identity: oldIdentity, auditAttemptId: attemptId, auditRevision: revision,
      executionBinding: {
        pool: 'primary', origin: 'reused',
        requested: { ...staleRequested, capabilityId: buildSupervisionExecutionCapabilityId(staleRequested) },
        actual: { ...oldIdentity, runtimeType: 'process', model: 'Auto' },
      },
      idempotencyKey: `send:auto-audit:${taskId}:${revision}`, now: 100,
    });
    if (!auditor.ok) throw new Error(auditor.reason);
    expect(registry.cancelStaleAuditorAsProjectBrain({
      taskId, auditorAssignmentId: auditor.value.assignmentId, callerProjectName: 'alpha',
      reason: 'undelivered split Cursor binding cannot reach selected CC', now: 150,
    })).toMatchObject({ ok: true, value: { status: 'cancelled' } });
    const replacement = identity('deck_alpha_live_cc10', 'claude-code-sdk', 'anthropic');
    const selected = {
      agentType: 'claude-code-sdk', providerFamily: 'anthropic', runtimeType: 'transport' as const,
      model: 'claude-sonnet-4-6',
    };
    const replacementBinding = {
      pool: 'primary' as const,
      requested: { ...selected, capabilityId: buildSupervisionExecutionCapabilityId(selected) },
      actual: { ...replacement, runtimeType: 'transport' as const, model: selected.model },
      origin: 'reused' as const,
    };
    const messageId = automaticMessageId(auditor.value.assignmentId, attemptId);
    const replacementMessageId = deterministicAutomaticAuditDeliveryMessageId(
      auditor.value.assignmentId, attemptId, auditor.value.generation + 1,
    );
    const supersededDelivery = getDelegationReplyStore().create({
      taskId,
      assignmentId: auditor.value.assignmentId,
      purpose: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
      auditAttemptId: attemptId,
      auditRevision: revision,
      auditedSessionName: 'deck_alpha_worker',
      messageId,
      dispatchId: 'dispatch-old-auditor-target-before-registry-rebind',
      origin: identity(brain.name),
      target: oldIdentity,
      now: 175,
    });

    expect(registry.recoverOrphanedDelegatedAuditor({
      taskId,
      assignmentId: auditor.value.assignmentId,
      identity: replacement,
      executionBinding: replacementBinding,
      expectedGeneration: auditor.value.generation,
      expectedRevision: revision,
      auditAttemptId: attemptId,
      callerProjectName: 'alpha',
      supersededDeliveryMessageId: messageId,
      deliveryMessageId: replacementMessageId,
      idempotencyKey: `orphan-rebind:${taskId}:${auditor.value.assignmentId}:${attemptId}`,
      reason: 'old auditor target is no longer discoverable and has no visible acceptance',
      now: 200,
    })).toMatchObject({
      ok: true,
      value: {
        assignmentId: auditor.value.assignmentId,
        auditAttemptId: attemptId,
        auditRevision: revision,
        generation: 2,
        identity: replacement,
        executionBinding: replacementBinding,
      },
    });
    expect(registry.recoverOrphanedDelegatedAuditor({
      taskId,
      assignmentId: auditor.value.assignmentId,
      identity: replacement,
      executionBinding: replacementBinding,
      expectedGeneration: auditor.value.generation,
      expectedRevision: revision,
      auditAttemptId: attemptId,
      callerProjectName: 'alpha',
      supersededDeliveryMessageId: messageId,
      deliveryMessageId: replacementMessageId,
      idempotencyKey: `orphan-rebind:${taskId}:${auditor.value.assignmentId}:${attemptId}`,
      reason: 'old auditor target is no longer discoverable and has no visible acceptance',
      now: 300,
    })).toMatchObject({ ok: true, replay: true });

    const worker = session('deck_alpha_worker', 'w1');
    const liveAuditor = session(replacement.sessionName, 'w2', 'claude-code-sdk', 'anthropic');
    let replacementEvidence = false;
    const dispatch = vi.fn(async (_caller: SendRuntimeCaller, input: SendMessageInput) => {
      expect(input.internalMessageId).toBe(replacementMessageId);
      expect(input.task).toMatchObject({
        taskId, assignmentId: auditor.value.assignmentId,
        auditAttemptId: attemptId, auditRevision: revision,
      });
      replacementEvidence = true;
      return {
        status: 'accepted' as const,
        dispatchId: 'send_dispatch_00000000-0000-4000-8000-0000000000d6' as const,
        messageId: input.internalMessageId!,
        deliveries: [{ target: liveAuditor.name, status: 'queued' as const }],
        taskId,
        assignmentId: auditor.value.assignmentId,
      };
    });
    const deps = {
      registry,
      listSessions: () => [brain, worker, liveAuditor],
      listTargets: listTargetRecords(liveAuditor),
      dispatch,
      hasDeliveryEvidence: (sessionName: string, candidate: SendMessageId) => (
        candidate === replacementMessageId
        && sessionName === liveAuditor.name
        && replacementEvidence
      ),
      hasVisibleAuditAcceptance: () => replacementEvidence,
      // Same fixture clock as the `recoverOrphanedDelegatedAuditor` call just
      // above (`now: 300`): the dispatch tick below fires essentially
      // immediately after that rebind, exactly like production (both use the
      // real wall clock there). Without this, staleness is now evaluated
      // even with zero delivery evidence yet (the fix under test), and the
      // real `Date.now()` default minus this fixture's tiny `updatedAt: 300`
      // would look like months of elapsed time -- an artifact of the fixture
      // clock, not a real stale-redelivery scenario.
      now: () => 300,
    };
    await expect(dispatchReadyAudit(taskId, deps)).resolves.toMatchObject({
      status: 'dispatched', assignmentId: auditor.value.assignmentId, attemptId,
      messageId: replacementMessageId,
    });
    await expect(dispatchReadyAudit(taskId, deps)).resolves.toMatchObject({
      status: 'replayed', assignmentId: auditor.value.assignmentId, attemptId,
      messageId: replacementMessageId,
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(getDelegationReplyStore().get(supersededDelivery.record.delegationId)?.status)
      .toBe(AGENT_DELEGATION_REPLY_STATUSES.EXPIRED);
    expect(registry.listAssignments(taskId).filter((item) => item.role === 'auditor')).toEqual([
      expect.objectContaining({
        assignmentId: auditor.value.assignmentId,
        auditAttemptId: attemptId,
        auditRevision: revision,
        identity: replacement,
      }),
    ]);
    expect(registry.listAuditReceipts(taskId)).toEqual([]);
    expect(registry.listEvents(taskId).filter((event) => event.assignmentId === auditor.value.assignmentId)
      .map((event) => event.payload?.source)).toEqual(expect.arrayContaining([
        'brain_authorized_stale_auditor_cancel',
        SUPERVISION_ORPHANED_AUTOMATIC_AUDITOR_REBIND_SOURCE,
      ]));

    const genericTaskId = `${taskId}-generic-cancel`;
    const generic = makeReadyTask({
      registry, taskId: genericTaskId, revision, auditPolicy: 'auto_strict_cross_vendor',
    });
    const genericAuditor = registry.createAssignment({
      taskId: genericTaskId, role: 'auditor', identity: oldIdentity,
      auditAttemptId: `${attemptId}-generic`, auditRevision: revision,
      executionBinding: {
        pool: 'primary', origin: 'reused',
        requested: { ...staleRequested, capabilityId: buildSupervisionExecutionCapabilityId(staleRequested) },
        actual: { ...oldIdentity, runtimeType: 'transport', model: 'Auto' },
      },
    });
    if (!genericAuditor.ok) throw new Error(genericAuditor.reason);
    expect(registry.applyTaskIntent({
      taskId: genericTaskId, assignmentId: genericAuditor.value.assignmentId,
      intent: 'cancel', toStatus: 'cancelled', note: 'ordinary owner cancellation',
    })).toMatchObject({ ok: true });
    expect(registry.recoverOrphanedDelegatedAuditor({
      taskId: genericTaskId, assignmentId: genericAuditor.value.assignmentId,
      identity: replacement, executionBinding: replacementBinding,
      expectedGeneration: genericAuditor.value.generation, expectedRevision: revision,
      auditAttemptId: `${attemptId}-generic`, callerProjectName: 'alpha',
      supersededDeliveryMessageId: automaticMessageId(genericAuditor.value.assignmentId, `${attemptId}-generic`),
      deliveryMessageId: deterministicAutomaticAuditDeliveryMessageId(
        genericAuditor.value.assignmentId, `${attemptId}-generic`, genericAuditor.value.generation + 1,
      ),
      idempotencyKey: 'must-not-revive-generic-cancel', reason: 'not Brain-authorized', now: 400,
    })).toEqual({ ok: false, reason: 'invalid_transition' });
    expect(registry.getAssignment(genericAuditor.value.assignmentId)).toMatchObject({ status: 'cancelled' });
    expect(generic.worker.assignmentId).toBeTruthy();
  });

  it('recovers tsk_mnq/asg_n06 in place when the openai auditor is no longer pool-selected and only a same-family transport is (auto_allow_degraded)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-degraded-auditor-rebind-'));
    const dbPath = join(dir, 'registry.sqlite');
    const taskId = 'tsk_mnq';
    const assignmentId = 'asg_n06';
    const revision = 'mnq-degraded-auditor-recovery-r1';
    // The daemon derives the automatic attempt from task + revision; each task
    // below carries its own exact derived attempt, as tsk_mnq does in production.
    const attemptFor = (id: string) => automaticAttempt(id, revision);
    const attemptId = attemptFor(taskId);
    const brain = session('deck_alpha_brain', 'brain');
    const worker = session('deck_alpha_worker', 'w1', 'claude-code-sdk', 'anthropic');
    // Live and reply-capable, but its configuration is no longer selected by the pool.
    const staleCodex = session('deck_alpha_codex_auditor', 'w2');
    const selectedCc = session('deck_alpha_cc_auditor', 'w3', 'claude-code-sdk', 'anthropic');
    const liveCodex = session('deck_alpha_codex_live', 'w4');
    const ccConfig = {
      agentType: 'claude-code-sdk', providerFamily: 'anthropic', runtimeType: 'transport' as const, model: 'claude-sonnet-4-6',
    };
    const codexConfig = {
      agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport' as const, model: 'gpt-5.6',
    };
    const selectPool = (...configs: Array<typeof ccConfig | typeof codexConfig>) => {
      brain.transportConfig = {
        supervision: normalizeSessionSupervisionSnapshot({
          mode: 'supervised_audit',
          executionPools: {
            state: 'configured',
            primaryDevelopmentPool: {
              configs: configs.map((config) => ({ ...config, capabilityId: buildSupervisionExecutionCapabilityId(config) })),
              controls: { maxSpawned: 1 },
            },
            economyTaskPool: { configs: [], controls: { maxSpawned: 0 } },
          },
        }),
      };
    };
    selectPool(ccConfig);
    const sessions = [brain, worker, staleCodex, selectedCc];
    const listTargets: typeof listSendTargets = (caller, input) => (
      listSendTargets(caller, input, { listSessions: () => sessions })
    );
    const implementerIdentity = identity(worker.name, 'claude-code-sdk', 'anthropic');
    let registry = new SupervisionTaskRegistry({ database: new DatabaseSync(dbPath) });
    const queueCancels: Array<[string, string, { sessionInstanceId: string; runtimeEpoch: string }]> = [];
    const replacementMessageId = deterministicAutomaticAuditDeliveryMessageId(assignmentId, attemptId, 2);
    let replacementDelivered = false;
    const dispatch = vi.fn(async (_caller: SendRuntimeCaller, input: SendMessageInput) => {
      replacementDelivered = true;
      return {
        status: 'accepted' as const,
        dispatchId: 'send_dispatch_00000000-0000-4000-8000-0000000000f7' as const,
        messageId: input.internalMessageId!,
        deliveries: [{ target: input.target!, status: 'queued' as const }],
        taskId: input.task!.taskId!,
        assignmentId: input.task!.assignmentId!,
      };
    });
    const readyDeps = {
      get registry() { return registry; },
      listSessions: () => sessions,
      listTargets,
      dispatch,
      hasDeliveryEvidence: (sessionName: string, candidate: SendMessageId) => (
        replacementDelivered && sessionName === selectedCc.name && candidate === replacementMessageId
      ),
      hasVisibleAuditAcceptance: () => replacementDelivered,
    };
    // Production wiring shape, with the session list injected.
    const handlers = () => createSupervisionMcpToolHandlers({
      userId: brain.name, sessionName: brain.name, projectName: 'alpha', projectRoot: '/work/alpha',
    } as unknown as McpRuntimeCaller, {
      registry: {
        get: (id: string) => registry.get(id),
        recoverOrphanedDelegatedAuditor: (input: Parameters<SupervisionTaskRegistry['recoverOrphanedDelegatedAuditor']>[0]) => (
          registry.recoverOrphanedDelegatedAuditor(input)
        ),
      } as unknown as SupervisionRegistryPort,
      isProjectBrain: () => true,
      resolveSessionIdentity: (name: string) => {
        const live = sessions.find((candidate) => candidate.name === name);
        return live ? {
          sessionName: live.name,
          sessionInstanceId: live.sessionInstanceId!,
          runtimeEpoch: live.runtimeEpoch!,
          agentType: live.agentType,
          providerFamily: resolvePeerAuditProviderFamily(live),
          projectName: resolveEffectiveProjectName(live, sessions)!,
        } : undefined;
      },
      resolveAuditorRecoveryBinding: (name: string) => {
        const live = sessions.find((candidate) => candidate.name === name);
        return live ? resolveSelectedSupervisionExecutionBinding('alpha', sessions, live) : undefined;
      },
      resolveAuditorRecoveryCrossVendorAvailability: (input) => (
        resolveAutomaticAuditCrossVendorAvailability(input, { listSessions: () => sessions, listTargets })
      ),
      retireSupersededAuditDelivery: (input) => retireExactSupersededAuditDelivery({
        cancelQueuedMessage: (sessionName: string, messageId: string, recipient: { sessionInstanceId: string; runtimeEpoch: string }) => {
          queueCancels.push([sessionName, messageId, recipient]);
          return { status: 'accepted' } as never;
        },
      }, input),
      dispatchReadyAudit: (id: string) => dispatchReadyAudit(id, readyDeps),
    });
    const arrangeOrphanedAuditor = (id: string, auditPolicy: 'auto_allow_degraded' | 'auto_strict_cross_vendor' | undefined, exactAssignmentId?: string) => {
      makeReadyTask({ taskId: id, revision, ...(auditPolicy ? { auditPolicy } : {}), registry, implementerIdentity });
      const stale = identity(staleCodex.name);
      const created = registry.createAssignment({
        ...(exactAssignmentId ? { assignmentId: exactAssignmentId } : {}),
        taskId: id, role: 'auditor', required: false, identity: stale,
        auditAttemptId: attemptFor(id), auditRevision: revision,
        executionBinding: {
          pool: 'primary', origin: 'reused',
          requested: { ...codexConfig, capabilityId: buildSupervisionExecutionCapabilityId(codexConfig) },
          actual: { ...stale, runtimeType: 'transport', model: codexConfig.model },
        },
        idempotencyKey: `send:auto-audit:${id}:${revision}`, now: 100,
      });
      if (!created.ok) throw new Error(created.reason);
      return created.value;
    };
    const request = (id: string, auditorId: string, rebindSessionName: string) => ({
      taskId: id, assignmentId: auditorId, rebindSessionName, expectedRevision: revision, auditAttemptId: attemptFor(id),
      idempotencyKey: `orphan-auditor:${id}:${auditorId}:${attemptFor(id)}`,
      reason: 'openai auditor is live but no longer selected by the execution pool',
    });
    try {
      const before = arrangeOrphanedAuditor(taskId, 'auto_allow_degraded', assignmentId);
      expect(before).toMatchObject({ assignmentId, status: 'delegated', generation: 1 });
      // The production shape: the old target is listed but no longer pool-eligible.
      const listed = listTargets({ userId: brain.name, sessionName: brain.name, projectName: 'alpha', projectRoot: '/work/alpha' },
        { executionPool: 'primary' });
      expect(listed.status === 'ok' && listed.items.find((item) => item.target === staleCodex.name)).toBeFalsy();
      expect(resolveSelectedSupervisionExecutionBinding('alpha', sessions, staleCodex)).toBeUndefined();

      await expect(handlers()[SUPERVISION_MCP_TOOLS.RECOVER](request(taskId, assignmentId, selectedCc.name))).resolves.toMatchObject({
        status: 'ok', taskId, assignmentId, auditAttemptId: attemptId, expectedRevision: revision,
        auditRoutingReason: 'same_family_degraded',
        auditDegradedReason: 'no_cross_vendor_configured',
        replay: false,
        auditTrigger: { status: 'dispatched', assignmentId, attemptId, messageId: replacementMessageId },
      });
      // The superseded exact delivery is retired from the old target, once.
      expect(queueCancels).toEqual([[
        staleCodex.name,
        deterministicAutomaticAuditDeliveryMessageId(assignmentId, attemptId, 1),
        { sessionInstanceId: staleCodex.sessionInstanceId, runtimeEpoch: staleCodex.runtimeEpoch },
      ]]);
      // The SAME deterministic audit delivery goes to the new identity, once, never strict.
      expect(dispatch).toHaveBeenCalledOnce();
      expect(dispatch.mock.calls[0]![1]).toMatchObject({
        target: selectedCc.name,
        internalMessageId: replacementMessageId,
        task: { taskId, assignmentId, auditAttemptId: attemptId, auditRevision: revision },
        audit: { attemptId, auditedSessionName: worker.name },
      });
      expect(dispatch.mock.calls[0]![1].audit).not.toHaveProperty('strictCrossVendor');
      const recovered = registry.getAssignment(assignmentId)!;
      expect(recovered).toMatchObject({
        assignmentId, taskId, role: 'auditor', status: 'delegated',
        auditAttemptId: attemptId, auditRevision: revision, generation: 2,
        identity: identity(selectedCc.name, 'claude-code-sdk', 'anthropic'),
        // The complete selected binding, as persisted (undefined fields do not survive storage).
        executionBinding: JSON.parse(JSON.stringify(resolveSelectedSupervisionExecutionBinding('alpha', sessions, selectedCc))),
        auditRoutingReason: 'same_family_degraded',
        auditDegradedReason: 'no_cross_vendor_configured',
      });
      expect(registry.listAssignments(taskId).filter((item) => item.role === 'auditor')).toHaveLength(1);
      expect(registry.listAuditReceipts(taskId)).toEqual([]);
      const rebindEvents = () => registry.listEvents(taskId).filter((event) => (
        event.assignmentId === assignmentId && event.payload?.source === 'orphaned_automatic_auditor_rebind'
      ));
      expect(rebindEvents()).toEqual([expect.objectContaining({
        payload: expect.objectContaining({
          auditPolicy: 'auto_allow_degraded',
          auditRoutingReason: 'same_family_degraded',
          auditDegradedReason: 'no_cross_vendor_configured',
          priorGeneration: 1, targetGeneration: 2,
          supersededSessionName: staleCodex.name, targetSessionName: selectedCc.name,
        }),
      })]);

      // Replay, then replay across a restart: same object, nothing retired or re-sent.
      await expect(handlers()[SUPERVISION_MCP_TOOLS.RECOVER](request(taskId, assignmentId, selectedCc.name)))
        .resolves.toMatchObject({ status: 'ok', replay: true, auditRoutingReason: 'same_family_degraded' });
      registry.close();
      registry = new SupervisionTaskRegistry({ database: new DatabaseSync(dbPath) });
      await expect(handlers()[SUPERVISION_MCP_TOOLS.RECOVER](request(taskId, assignmentId, selectedCc.name)))
        .resolves.toMatchObject({
          status: 'ok', replay: true,
          auditRoutingReason: 'same_family_degraded', auditDegradedReason: 'no_cross_vendor_configured',
        });
      expect(queueCancels).toHaveLength(1);
      expect(dispatch).toHaveBeenCalledOnce();
      expect(registry.getAssignment(assignmentId)).toMatchObject({ generation: 2, auditRoutingReason: 'same_family_degraded' });
      expect(rebindEvents()).toHaveLength(1);

      // Strict tasks stay closed in the identical pool, and are left untouched.
      const strictTaskId = `${taskId}-strict`;
      const strictAuditor = arrangeOrphanedAuditor(strictTaskId, 'auto_strict_cross_vendor');
      await expect(handlers()[SUPERVISION_MCP_TOOLS.RECOVER](
        request(strictTaskId, strictAuditor.assignmentId, selectedCc.name),
      )).resolves.toMatchObject({
        status: 'error', reason: 'identity_rejected', detail: expect.stringContaining('strict_cross_vendor_required'),
      });
      expect(registry.getAssignment(strictAuditor.assignmentId)).toMatchObject({
        generation: 1, identity: identity(staleCodex.name),
      });
      expect(registry.getAssignment(strictAuditor.assignmentId)).not.toHaveProperty('auditRoutingReason');
      // The registry refuses the same-family strict rebind on its own, even with a forged statement.
      expect(registry.recoverOrphanedDelegatedAuditor({
        taskId: strictTaskId, assignmentId: strictAuditor.assignmentId,
        identity: identity(selectedCc.name, 'claude-code-sdk', 'anthropic'),
        executionBinding: resolveSelectedSupervisionExecutionBinding('alpha', sessions, selectedCc),
        auditRoutingReason: 'same_family_degraded', auditDegradedReason: 'no_cross_vendor_configured',
        expectedGeneration: 1, expectedRevision: revision, auditAttemptId: attemptFor(strictTaskId), callerProjectName: 'alpha',
        supersededDeliveryMessageId: deterministicAutomaticAuditDeliveryMessageId(strictAuditor.assignmentId, attemptFor(strictTaskId), 1),
        deliveryMessageId: deterministicAutomaticAuditDeliveryMessageId(strictAuditor.assignmentId, attemptFor(strictTaskId), 2),
        idempotencyKey: 'forged-degraded-statement', reason: 'forged', now: 500,
      })).toEqual({ ok: false, reason: 'invalid_transition' });

      // Nor may the registry degrade an audit onto the audited implementer itself.
      const selfTaskId = `${taskId}-self`;
      const selfAuditor = arrangeOrphanedAuditor(selfTaskId, 'auto_allow_degraded');
      expect(registry.recoverOrphanedDelegatedAuditor({
        taskId: selfTaskId, assignmentId: selfAuditor.assignmentId,
        identity: implementerIdentity,
        executionBinding: resolveSelectedSupervisionExecutionBinding('alpha', sessions, worker),
        auditRoutingReason: 'same_family_degraded', auditDegradedReason: 'no_cross_vendor_configured',
        expectedGeneration: 1, expectedRevision: revision, auditAttemptId: attemptFor(selfTaskId), callerProjectName: 'alpha',
        supersededDeliveryMessageId: deterministicAutomaticAuditDeliveryMessageId(selfAuditor.assignmentId, attemptFor(selfTaskId), 1),
        deliveryMessageId: deterministicAutomaticAuditDeliveryMessageId(selfAuditor.assignmentId, attemptFor(selfTaskId), 2),
        idempotencyKey: 'self-audit', reason: 'must not audit itself', now: 600,
      })).toEqual({ ok: false, reason: 'invalid_transition' });

      // A degraded task still requires a usable cross-vendor target when one is selected.
      selectPool(ccConfig, codexConfig);
      sessions.push(liveCodex);
      // ...but an already-completed degraded rebind stays an idempotent replay:
      // the durable record, not the moved pool, decides.
      await expect(handlers()[SUPERVISION_MCP_TOOLS.RECOVER](request(taskId, assignmentId, selectedCc.name)))
        .resolves.toMatchObject({ status: 'ok', replay: true, auditRoutingReason: 'same_family_degraded' });
      expect(queueCancels).toHaveLength(1);
      expect(dispatch).toHaveBeenCalledOnce();
      const crossTaskId = `${taskId}-cross`;
      const crossAuditor = arrangeOrphanedAuditor(crossTaskId, 'auto_allow_degraded');
      await expect(handlers()[SUPERVISION_MCP_TOOLS.RECOVER](
        request(crossTaskId, crossAuditor.assignmentId, selectedCc.name),
      )).resolves.toMatchObject({
        status: 'error', reason: 'identity_rejected', detail: expect.stringContaining('cross_vendor_target_available'),
      });
      await expect(handlers()[SUPERVISION_MCP_TOOLS.RECOVER](
        request(crossTaskId, crossAuditor.assignmentId, liveCodex.name),
      )).resolves.toMatchObject({ status: 'ok', auditRoutingReason: 'cross_vendor_preferred' });
      expect(registry.getAssignment(crossAuditor.assignmentId)).toMatchObject({
        generation: 2, identity: identity(liveCodex.name), auditRoutingReason: 'cross_vendor_preferred',
      });
      expect(registry.getAssignment(crossAuditor.assignmentId)?.auditDegradedReason).toBeUndefined();

      // A task without an automatic audit policy keeps current-dev cross-vendor
      // recovery, and still never degrades to the same family.
      const unpolicedTaskId = `${taskId}-unpoliced`;
      const unpolicedAuditor = arrangeOrphanedAuditor(unpolicedTaskId, undefined);
      const unpolicedRequest = (target: typeof liveCodex, key: string) => ({
        taskId: unpolicedTaskId, assignmentId: unpolicedAuditor.assignmentId,
        identity: identity(target.name, target.agentType, resolvePeerAuditProviderFamily(target)),
        executionBinding: resolveSelectedSupervisionExecutionBinding('alpha', sessions, target),
        expectedGeneration: 1, expectedRevision: revision, auditAttemptId: attemptFor(unpolicedTaskId), callerProjectName: 'alpha',
        supersededDeliveryMessageId: deterministicAutomaticAuditDeliveryMessageId(unpolicedAuditor.assignmentId, attemptFor(unpolicedTaskId), 1),
        deliveryMessageId: deterministicAutomaticAuditDeliveryMessageId(unpolicedAuditor.assignmentId, attemptFor(unpolicedTaskId), 2),
        idempotencyKey: key, reason: 'unpoliced orphaned auditor', now: 700,
      });
      expect(registry.recoverOrphanedDelegatedAuditor({
        ...unpolicedRequest(selectedCc, 'unpoliced-same-family'),
        auditRoutingReason: 'same_family_degraded', auditDegradedReason: 'no_cross_vendor_configured',
      })).toEqual({ ok: false, reason: 'invalid_transition' });
      expect(registry.recoverOrphanedDelegatedAuditor(unpolicedRequest(liveCodex, 'unpoliced-cross-vendor'))).toMatchObject({
        ok: true,
        value: { generation: 2, identity: identity(liveCodex.name), auditRoutingReason: 'cross_vendor_preferred' },
      });
    } finally {
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers auditing tsk_5w9/asg_e7r in place and replays exactly after restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-auditing-rebind-'));
    const dbPath = join(dir, 'registry.sqlite');
    const taskId = 'tsk_5w9';
    const revision = 'successor-revision-projection-cc3-r3-01c155d603b8';
    const attemptId = 'auto-audit-c73d9296ca7a631a8d5ff136';
    const assignmentId = 'asg_e7r';
    const oldIdentity = identity('deck_sub_stale_cc3', 'claude-code-sdk', 'anthropic');
    const replacement = identity('deck_sub_live_cc3', 'claude-code-sdk', 'anthropic');
    const idempotencyKey = `orphan-auditor:${taskId}:${assignmentId}:${attemptId}`;
    const messageId = automaticMessageId(assignmentId, attemptId);
    let registry = new SupervisionTaskRegistry({ database: new DatabaseSync(dbPath) });
    try {
      makeReadyTask({ taskId, revision, auditPolicy: 'auto_strict_cross_vendor', registry });
      const created = registry.createAssignment({
        assignmentId, taskId, role: 'auditor', required: false, identity: oldIdentity,
        auditAttemptId: attemptId, auditRevision: revision,
        idempotencyKey: `send:auto-audit:${taskId}:${revision}`, now: 100,
      });
      if (!created.ok) throw new Error(created.reason);
      expect(registry.updateAssignment({
        assignmentId, identity: oldIdentity, status: 'auditing',
        auditAttemptId: attemptId, auditRevision: revision, now: 110,
      })).toMatchObject({ ok: true });
      const before = registry.getAssignment(assignmentId)!;

      const request = {
        taskId, assignmentId, identity: replacement,
        expectedGeneration: before.generation,
        expectedRevision: revision, auditAttemptId: attemptId,
        callerProjectName: 'alpha', supersededDeliveryMessageId: messageId,
        deliveryMessageId: deterministicAutomaticAuditDeliveryMessageId(
          assignmentId, attemptId, before.generation + 1,
        ),
        idempotencyKey, reason: 'transport queue unavailable without durable delivery evidence', now: 200,
      };
      expect(registry.recoverOrphanedDelegatedAuditor(request)).toMatchObject({
        ok: true,
        value: {
          assignmentId, status: 'delegated', generation: before.generation + 1,
          auditAttemptId: attemptId, auditRevision: revision, identity: replacement,
        },
      });
      expect(registry.listAuditReceipts(taskId)).toEqual([]);
      expect(registry.listAssignments(taskId).filter((item) => item.role === 'auditor')).toHaveLength(1);
      expect(registry.listEvents(taskId).filter((event) => (
        event.eventType === 'recovered'
        && event.assignmentId === assignmentId
        && event.payload?.source === 'orphaned_automatic_auditor_rebind'
      ))).toHaveLength(1);

      registry.close();
      registry = new SupervisionTaskRegistry({ database: new DatabaseSync(dbPath) });
      expect(registry.recoverOrphanedDelegatedAuditor({ ...request, now: 300 })).toMatchObject({
        ok: true, replay: true,
        value: { assignmentId, status: 'delegated', generation: before.generation + 1, identity: replacement },
      });
      expect(registry.listEvents(taskId).filter((event) => (
        event.eventType === 'recovered'
        && event.assignmentId === assignmentId
        && event.payload?.source === 'orphaned_automatic_auditor_rebind'
      ))).toHaveLength(1);
    } finally {
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts progress-only auditing recovery but rejects a stale generation and a formal receipt', () => {
    const taskId = 'tsk_5w9-progress';
    const revision = 'successor-revision-projection-cc3-r3-01c155d603b8';
    const attemptId = 'auto-audit-c73d9296ca7a631a8d5ff136';
    const assignmentId = 'asg_e7r';
    const { registry } = makeReadyTask({ taskId, revision, auditPolicy: 'auto_strict_cross_vendor' });
    const oldIdentity = identity('deck_sub_stale_cc3', 'claude-code-sdk', 'anthropic');
    const firstTarget = identity('deck_sub_live_cc3', 'claude-code-sdk', 'anthropic');
    const secondTarget = identity('deck_sub_other_cc3', 'claude-code-sdk', 'anthropic');
    const created = registry.createAssignment({
      assignmentId, taskId, role: 'auditor', required: false, identity: oldIdentity,
      auditAttemptId: attemptId, auditRevision: revision, now: 100,
    });
    if (!created.ok) throw new Error(created.reason);
    expect(registry.appendMatchingAuditReceipt({
      taskId, auditorAssignmentId: assignmentId, auditorIdentity: oldIdentity,
      auditorSessionName: oldIdentity.sessionName, attemptId, revision,
      receiptKind: 'progress', findings: 'claimed but transport delivery was never durable', validations: [], now: 110,
    })).toMatchObject({ ok: true, value: { receiptKind: 'progress' } });
    const before = registry.getAssignment(assignmentId)!;
    const common = {
      taskId, assignmentId, expectedGeneration: before.generation,
      expectedRevision: revision, auditAttemptId: attemptId, callerProjectName: 'alpha',
      supersededDeliveryMessageId: automaticMessageId(assignmentId, attemptId),
      deliveryMessageId: deterministicAutomaticAuditDeliveryMessageId(
        assignmentId, attemptId, before.generation + 1,
      ),
      reason: 'recover exact active round without replacing its assignment or attempt',
    };
    expect(registry.recoverOrphanedDelegatedAuditor({
      ...common, identity: firstTarget, idempotencyKey: 'recover-first', now: 200,
    })).toMatchObject({ ok: true, value: { status: 'delegated', identity: firstTarget } });
    expect(registry.recoverOrphanedDelegatedAuditor({
      ...common, identity: secondTarget, idempotencyKey: 'recover-stale-generation', now: 210,
    })).toEqual({ ok: false, reason: 'conflicting_replay' });
    expect(registry.getAssignment(assignmentId)).toMatchObject({
      identity: firstTarget, generation: before.generation + 1,
    });

    expect(registry.updateAssignment({
      assignmentId, identity: firstTarget, status: 'auditing',
      auditAttemptId: attemptId, auditRevision: revision, now: 220,
    })).toMatchObject({ ok: true });
    expect(registry.appendMatchingAuditReceipt({
      taskId, auditorAssignmentId: assignmentId, auditorIdentity: firstTarget,
      auditorSessionName: firstTarget.sessionName, attemptId, revision,
      receiptKind: 'final', verdict: 'REWORK', findings: 'formal finding', validations: [], now: 230,
    })).toMatchObject({ ok: true, value: { receiptKind: 'final', verdict: 'REWORK' } });
    expect(registry.recoverOrphanedDelegatedAuditor({
      ...common,
      expectedGeneration: registry.getAssignment(assignmentId)!.generation,
      identity: secondTarget, idempotencyKey: 'recover-after-final', now: 240,
    })).toEqual({ ok: false, reason: 'receipt_closed' });
  });

  it('evidence-binds Brain recovery to one unstarted auditor and fails closed after work, receipt, or scope drift', () => {
    const setup = (suffix: string) => {
      const taskId = `evidence-auditor-recovery-${suffix}`;
      const revision = `evidence-auditor-recovery-${suffix}-r1`;
      const attemptId = `auto-audit-evidence-${suffix}`;
      const ready = makeReadyTask({ taskId, revision, auditPolicy: 'auto_strict_cross_vendor' });
      const blocker = `rate-limited:${suffix}`;
      expect(ready.registry.recordAutomaticAuditRoutingBlocker({
        taskId, assignmentId: ready.worker.assignmentId, blocker, now: 90,
      })).toMatchObject({ ok: true });
      const oldIdentity = identity(`deck_alpha_old_auditor_${suffix}`, 'claude-code-sdk', 'anthropic');
      const auditor = ready.registry.createAssignment({
        taskId, role: 'auditor', required: true, identity: oldIdentity,
        scopeFiles: ['src/exact.ts'], auditAttemptId: attemptId, auditRevision: revision, now: 100,
      });
      if (!auditor.ok) throw new Error(auditor.reason);
      const target = identity(`deck_alpha_new_auditor_${suffix}`, 'claude-code-sdk', 'anthropic');
      const selected = {
        agentType: 'claude-code-sdk', providerFamily: 'anthropic', runtimeType: 'transport' as const,
        model: 'claude-sonnet-4-6',
      };
      const executionBinding = {
        pool: 'primary' as const,
        requested: { ...selected, capabilityId: buildSupervisionExecutionCapabilityId(selected) },
        actual: { ...target, runtimeType: 'transport' as const, model: selected.model },
        origin: 'reused' as const,
      };
      const bundle = ready.registry.getTaskRecord(taskId)!.integrationBundle!;
      const request = {
        taskId, assignmentId: auditor.value.assignmentId, identity: target, executionBinding,
        expectedGeneration: auditor.value.generation, expectedRevision: revision, auditAttemptId: attemptId,
        callerProjectName: 'alpha',
        supersededDeliveryMessageId: automaticMessageId(auditor.value.assignmentId, attemptId),
        deliveryMessageId: deterministicAutomaticAuditDeliveryMessageId(
          auditor.value.assignmentId, attemptId, auditor.value.generation + 1,
        ),
        idempotencyKey: `evidence-rebind:${suffix}`, reason: 'bound auditor rate limited before starting',
        ownedFiles: ['src/exact.ts'], evidenceManifestSha256: bundle.manifestSha256, now: 200,
      };
      return { ...ready, attemptId, auditor: auditor.value, oldIdentity, target, bundle, request };
    };

    const accepted = setup('accepted');
    const bundleBefore = accepted.registry.getTaskRecord(accepted.taskId)!.integrationBundle;
    expect(accepted.registry.recoverOrphanedDelegatedAuditor(accepted.request)).toMatchObject({
      ok: true,
      value: {
        assignmentId: accepted.auditor.assignmentId, status: 'delegated',
        generation: accepted.auditor.generation + 1, auditAttemptId: accepted.attemptId,
        auditRevision: accepted.revision, scopeFiles: ['src/exact.ts'], identity: accepted.target,
      },
    });
    expect(accepted.registry.getTaskRecord(accepted.taskId)?.blocker).toBeUndefined();
    expect(accepted.registry.getTaskRecord(accepted.taskId)?.integrationBundle).toEqual(bundleBefore);
    expect(accepted.registry.getAssignment(accepted.worker.assignmentId)?.blocker).toBeUndefined();
    expect(accepted.registry.listAssignments(accepted.taskId).filter((row) => row.role === 'auditor')).toHaveLength(1);
    expect(accepted.registry.listAuditReceipts(accepted.taskId)).toEqual([]);
    expect(accepted.registry.recoverOrphanedDelegatedAuditor(accepted.request))
      .toMatchObject({ ok: true, replay: true });

    const started = setup('started');
    expect(started.registry.updateAssignment({
      assignmentId: started.auditor.assignmentId, identity: started.oldIdentity,
      status: 'auditing', auditAttemptId: started.attemptId, auditRevision: started.revision, now: 150,
    })).toMatchObject({ ok: true });
    expect(started.registry.recoverOrphanedDelegatedAuditor(started.request))
      .toEqual({ ok: false, reason: 'invalid_transition' });
    expect(started.registry.getAssignment(started.auditor.assignmentId)?.identity).toEqual(started.oldIdentity);

    const received = setup('receipt');
    expect(received.registry.appendMatchingAuditReceipt({
      taskId: received.taskId, auditorAssignmentId: received.auditor.assignmentId,
      auditorIdentity: received.oldIdentity, auditorSessionName: received.oldIdentity.sessionName,
      attemptId: received.attemptId, revision: received.revision, receiptKind: 'progress',
      findings: 'audit work has started', validations: [], now: 150,
    })).toMatchObject({ ok: true });
    expect(received.registry.recoverOrphanedDelegatedAuditor(received.request))
      .toEqual({ ok: false, reason: 'receipt_closed' });
    expect(received.registry.getAssignment(received.auditor.assignmentId)?.identity).toEqual(received.oldIdentity);

    const changed = setup('changed');
    expect(changed.registry.recoverOrphanedDelegatedAuditor({
      ...changed.request, ownedFiles: ['src/foreign.ts'],
    })).toEqual({ ok: false, reason: 'manifest_mismatch' });
    expect(changed.registry.getAssignment(changed.auditor.assignmentId)?.identity).toEqual(changed.oldIdentity);

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
      inspectAssignmentWorktree: () => ({
        worktreePath: '/tmp/legacy-explicit/repo', headSha: 'a'.repeat(40),
        files: [{ path: 'src/exact.ts', sha256: '1'.repeat(64) }],
        stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
      }),
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
    expect(await registry.convergeLifecycle(30, {
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
      registry.applyTaskIntent({ expectedRevision: (registry.getTaskRecord(taskId)?.currentRevision ?? SUPERVISION_UNBOUND_REVISION),
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
      inspectAssignmentWorktree: () => ({
        worktreePath: '/tmp/legacy-explicit-recovery/repo', headSha: 'a'.repeat(40),
        files: [{ path: 'src/exact.ts', sha256: '1'.repeat(64) }],
        stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
      }),
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
        registry.applyTaskIntent({ expectedRevision: (registry.getTaskRecord(taskId)?.currentRevision ?? SUPERVISION_UNBOUND_REVISION),
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
  function resumedAfterRework(revision = 'r5-resumed', validation: 'exact' | 'none' = 'exact') {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
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
    if (validation === 'exact') {
      // The resumed bytes were validated for THIS revision; only the lifecycle
      // projection is stale. Written raw so the owner stays `implementing`.
      stampValidation(database, taskId, worker.value.assignmentId, revision, revision);
    }
    return { registry, taskId, revision, worker: worker.value };
  }

  it('does not align or materialize a resumed owner whose current revision was never validated', async () => {
    const { registry, taskId, worker } = resumedAfterRework('r5-unvalidated', 'none');
    const sessions = [session('deck_alpha_brain', 'brain'), session('deck_alpha_worker', 'w1')];
    const dispatch = vi.fn(async (_c: SendRuntimeCaller, input: SendMessageInput) => {
      if (input.audit) throw new Error('must not materialize an unvalidated successor');
      return {
        status: 'accepted' as const,
        dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000000' as const,
        messageId: 'send_message_00000000-0000-5000-a000-000000000001' as SendMessageId,
        deliveries: [{ target: 'deck_alpha_brain', status: 'queued' as const }],
      };
    });
    const before = registry.getAssignment(worker.assignmentId)!;
    const result = await dispatchReadyAudit(taskId, {
      registry, listSessions: () => sessions,
      listTargets: listTargetRecords(sessions[0]!), dispatch: dispatch as never,
      hasDeliveryEvidence: () => false,
    });
    expect(result).toMatchObject({ status: 'blocked' });
    // n23 caller-revision authority persists the deterministic routing
    // blocker before dispatch.  That is the only permitted mutation here;
    // the unvalidated owner must not be lifecycle-aligned or materialized.
    const after = registry.getAssignment(worker.assignmentId)!;
    expect({ ...after, blocker: before.blocker, updatedAt: before.updatedAt }).toEqual(before);
    expect(JSON.parse(after.blocker!)).toMatchObject({
      kind: 'automatic_audit_routing',
      taskId,
      assignmentId: worker.assignmentId,
      revision: 'r5-unvalidated',
      exactError: 'automatic audit requires one exact ready implementer revision',
    });
    expect(registry.listAssignments(taskId).filter((a) => a.role === 'auditor')).toEqual([]);
  });

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
      inspectAssignmentWorktree: () => ({
        worktreePath: '/tmp/rework-successor/repo', headSha: 'a'.repeat(40),
        files: [{ path: 'src/exact.ts', sha256: '1'.repeat(64) }],
        stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
      }),
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
    expect(sent.internalQueueSupervisionReference).toEqual({
      kind: 'implementation_blocker', taskId: shape.taskId,
      assignmentId: expect.any(String), revision: shape.revision, exactError: 'missing_audit_policy',
    });
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
      expect(registry.applyTaskIntent({ expectedRevision: (registry.getTaskRecord(taskId)?.currentRevision ?? SUPERVISION_UNBOUND_REVISION),
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
    expect(result).toMatchObject({
      status: 'blocked', reason: 'authoritative immutable integration bundle unavailable or mismatched',
    });
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
      expect(registry.applyTaskIntent({ expectedRevision: (registry.getTaskRecord(taskId)?.currentRevision ?? SUPERVISION_UNBOUND_REVISION),
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
      expect(registry.applyTaskIntent({ expectedRevision: (registry.getTaskRecord(taskId)?.currentRevision ?? SUPERVISION_UNBOUND_REVISION),
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

/**
 * tsk_cic — auditPolicy is TASK authority, not a message.
 *
 * Binding a missing policy used to ride on the implementation-delivery path:
 * every task-bearing send requires exactly one dispatchable target and then
 * validates that target against the project's execution pool BEFORE the
 * registry is touched, and the bind itself is only reachable as a task
 * continuation. So a historical ready_for_audit task could not acquire a policy
 * once its frozen implementer drifted -- model no longer pool-selected, or a
 * rotated identity epoch -- and the observed workaround was a manual
 * SAME-assignment identity rebind, after which delivery still failed.
 *
 * The bind is now a CONTROL-PLANE operation: it runs before any
 * dispatchable-target, execution-pool or continuation-identity check, delivers
 * nothing, mutates no implementer state, and then reuses the ONE existing
 * dispatchReadyAudit trigger to materialise exactly one fresh auditor.
 */
describe('control-plane auditPolicy bind (tsk_cic)', () => {
  const selectedPoolConfig = {
    agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport' as const, model: 'gpt-5.6',
  };

  function brainWith(mode: 'supervised_audit' | 'off', poolModel = selectedPoolConfig.model) {
    const brain = session('deck_alpha_brain', 'brain');
    const config = { ...selectedPoolConfig, model: poolModel };
    brain.transportConfig = {
      supervision: normalizeSessionSupervisionSnapshot({
        mode,
        auditTargetSessionName: 'deck_alpha_auditor',
        executionPools: {
          state: 'configured',
          primaryDevelopmentPool: {
            configs: [{ ...config, capabilityId: buildSupervisionExecutionCapabilityId(config) }],
            controls: { maxSpawned: 2 },
          },
          economyTaskPool: { configs: [], controls: { maxSpawned: 0 } },
        },
      }),
    };
    return brain;
  }

  const brainCaller = {
    userId: 'deck_alpha_brain', sessionName: 'deck_alpha_brain',
    projectName: 'alpha', projectRoot: '/work/alpha',
  };

  function bindInput(taskId: string, revision: string, policy = 'auto_allow_degraded' as const) {
    return {
      target: 'deck_alpha_worker',
      message: 'bind the missing audit policy',
      task: {
        taskId,
        currentRevision: revision,
        auditPolicy: policy,
        executionPool: 'primary' as const,
      },
    };
  }

  it('binds on a task whose frozen implementer is NO LONGER pool-selected', async () => {
    // The exact observed shape: the pool selects gpt-5.6, the frozen implementer
    // runs a model that is no longer selected. Today this dies at the execution
    // pool gate with unselected_config, long before the registry is reached.
    const registry = getSupervisionTaskRegistry();
    const ready = makeReadyTask({ taskId: 'cic-unselected-model', registry });
    const brain = brainWith('supervised_audit', 'gpt-5.6');
    const drifted = session('deck_alpha_worker', 'w1');
    drifted.activeModel = 'retired-model-9';
    drifted.requestedModel = 'retired-model-9';
    const dispatchMessage = vi.fn();
    const dispatchReadyAudit = vi.fn().mockResolvedValue({ status: 'ignored', reason: 'test_hook' });

    const result = await dispatchSendMessage(brainCaller, bindInput(ready.taskId, ready.revision), {
      listSessions: () => [brain, drifted],
      dispatchMessage,
      dispatchReadyAudit,
    });

    expect(result, 'a drifted implementer must not block task authority').toMatchObject({
      status: 'accepted', taskId: ready.taskId,
    });
    expect(registry.get(ready.taskId)?.auditPolicy).toBe('auto_allow_degraded');
    expect(dispatchMessage, 'a control-plane bind delivers nothing').not.toHaveBeenCalled();
    expect(dispatchReadyAudit, 'the ONE existing trigger still runs').toHaveBeenCalledWith(ready.taskId);
    if (result.status !== 'accepted') throw new Error('expected accepted');
    expect(result.deliveries, 'no fabricated delivery record').toEqual([]);
    expect(result.controlPlane).toMatchObject({
      operation: 'audit_policy_bind', auditPolicy: 'auto_allow_degraded', policyBound: 'newly_bound',
    });
  });

  it('binds on a task whose frozen implementer identity epoch is stale', async () => {
    const registry = getSupervisionTaskRegistry();
    const ready = makeReadyTask({ taskId: 'cic-stale-epoch', registry });
    const brain = brainWith('supervised_audit');
    const rotated = session('deck_alpha_worker', 'w1');
    rotated.runtimeEpoch = 'epoch-rotated-after-restart';
    rotated.sessionInstanceId = 'instance-rotated-after-restart';
    const dispatchMessage = vi.fn();
    const dispatchReadyAudit = vi.fn().mockResolvedValue({ status: 'ignored', reason: 'test_hook' });

    const result = await dispatchSendMessage(brainCaller, bindInput(ready.taskId, ready.revision), {
      listSessions: () => [brain, rotated],
      dispatchMessage,
      dispatchReadyAudit,
    });

    expect(result, 'a rotated epoch must not require a manual rebind first')
      .toMatchObject({ status: 'accepted', taskId: ready.taskId });
    expect(registry.get(ready.taskId)?.auditPolicy).toBe('auto_allow_degraded');
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('lets the unique authoritative legacy Brain bind strict policy with no coordinator row', async () => {
    const registry = getSupervisionTaskRegistry();
    const taskId = 'legacy-no-coordinator-policy-bind';
    const revision = 'legacy-no-coordinator-policy-bind-r1';
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'integration_task',
      objective: 'recover the existing audit round', currentRevision: revision,
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
      expect(registry.applyTaskIntent({ expectedRevision: (registry.getTaskRecord(taskId)?.currentRevision ?? SUPERVISION_UNBOUND_REVISION),
        taskId, assignmentId: worker.value.assignmentId, intent, toStatus,
        ...(validationState ? { validationState } : {}),
      })).toMatchObject({ ok: true });
    }
    expect(registry.listAssignments(taskId).filter((item) => item.role === 'coordinator')).toEqual([]);
    const beforeWorker = registry.getAssignment(worker.value.assignmentId);
    const brain = brainWith('supervised_audit');
    const implementer = session('deck_alpha_worker', 'w1');
    const dispatchMessage = vi.fn();
    const dispatchReadyAudit = vi.fn().mockImplementation(async () => {
      const created = registry.createAssignment({
        taskId, role: 'auditor', required: false,
        identity: identity('deck_alpha_unique_cc', 'claude-code-sdk', 'anthropic'),
        auditAttemptId: automaticAttempt(taskId, revision), auditRevision: revision,
        idempotencyKey: `legacy-zero-coordinator:${taskId}:${revision}`,
      });
      if (!created.ok) throw new Error(created.reason);
      return { status: 'dispatched', assignmentId: created.value.assignmentId };
    });

    const result = await dispatchSendMessage(brainCaller, {
      target: implementer.name,
      message: 'bind strict policy on the SAME legacy task',
      task: {
        taskId, currentRevision: revision,
        auditPolicy: 'auto_strict_cross_vendor', executionPool: 'primary',
      },
    }, {
      listSessions: () => [brain, implementer],
      dispatchMessage,
      dispatchReadyAudit,
    });

    expect(result).toMatchObject({
      status: 'accepted', taskId,
      controlPlane: {
        operation: 'audit_policy_bind', auditPolicy: 'auto_strict_cross_vendor',
        policyBound: 'newly_bound', auditTrigger: 'invoked',
      },
    });
    expect(registry.get(taskId)?.auditPolicy).toBe('auto_strict_cross_vendor');
    expect(registry.getAssignment(worker.value.assignmentId)).toEqual(beforeWorker);
    expect(registry.listAssignments(taskId).filter((item) => item.role === 'coordinator')).toEqual([]);
    expect(registry.listAssignments(taskId).filter((item) => item.role === 'auditor')).toHaveLength(1);
    expect(dispatchReadyAudit).toHaveBeenCalledOnce();
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('mutates NO implementer state and no historical evidence', async () => {
    const registry = getSupervisionTaskRegistry();
    const ready = makeReadyTask({ taskId: 'cic-no-mutation', registry });
    const before = registry.getAssignment(ready.worker.assignmentId)!;
    const beforeSnapshot = JSON.stringify({
      identity: before.identity, executionBinding: before.executionBinding, status: before.status,
      leaseId: before.leaseId, scopeFiles: before.scopeFiles, auditRevision: before.auditRevision,
    });
    const beforeRevision = registry.get(ready.taskId)!.currentRevision;
    const beforeReceipts = registry.listAuditReceipts(ready.taskId).length;

    const drifted = session('deck_alpha_worker', 'w1');
    drifted.activeModel = 'retired-model-9';
    await dispatchSendMessage(brainCaller, bindInput(ready.taskId, ready.revision), {
      listSessions: () => [brainWith('supervised_audit'), drifted],
      dispatchMessage: vi.fn(),
      dispatchReadyAudit: vi.fn().mockResolvedValue({ status: 'ignored', reason: 'test_hook' }),
    });

    const after = registry.getAssignment(ready.worker.assignmentId)!;
    expect(JSON.stringify({
      identity: after.identity, executionBinding: after.executionBinding, status: after.status,
      leaseId: after.leaseId, scopeFiles: after.scopeFiles, auditRevision: after.auditRevision,
    }), 'the bind must not touch implementer identity/binding/status/lease/scope/revision').toBe(beforeSnapshot);
    expect(registry.get(ready.taskId)!.currentRevision).toBe(beforeRevision);
    expect(registry.listAuditReceipts(ready.taskId)).toHaveLength(beforeReceipts);
  });

  it('is idempotent on replay: no second policy write, no duplicate auditor', async () => {
    const registry = getSupervisionTaskRegistry();
    const ready = makeReadyTask({ taskId: 'cic-idempotent', registry });
    const brain = brainWith('supervised_audit');
    const drifted = session('deck_alpha_worker', 'w1');
    drifted.activeModel = 'retired-model-9';
    const deps = () => ({
      listSessions: () => [brain, drifted],
      dispatchMessage: vi.fn(),
      dispatchReadyAudit: vi.fn().mockResolvedValue({ status: 'ignored', reason: 'test_hook' }),
    });

    const first = await dispatchSendMessage(brainCaller, bindInput(ready.taskId, ready.revision), deps());
    const second = await dispatchSendMessage(brainCaller, bindInput(ready.taskId, ready.revision), deps());

    expect(first).toMatchObject({ status: 'accepted' });
    expect(second).toMatchObject({ status: 'accepted' });
    if (second.status !== 'accepted') throw new Error('expected accepted');
    expect(second.controlPlane, 'a replay reports already_bound rather than rebinding')
      .toMatchObject({ policyBound: 'already_bound' });
    expect(registry.get(ready.taskId)?.auditPolicy).toBe('auto_allow_degraded');
    expect(registry.listAssignments(ready.taskId).filter((a) => a.role === 'auditor')).toEqual([]);
  });

  it('lets the unique live same-project Brain bind policy despite an older coordinator row', async () => {
    const registry = getSupervisionTaskRegistry();
    const ready = makeReadyTask({ taskId: 'cic-wrong-brain', registry });
    // A DIFFERENT Brain session, not merely a rotated epoch: epoch rotation is
    // deliberately tolerated by supervisionIdentityMatches (that is the whole
    // point of identity convergence), so only a different session isolates the
    // exact-coordinator half of this gate.
    const impostor = brainWith('supervised_audit');
    impostor.name = 'deck_alpha_other_brain';
    const impostorCaller = {
      userId: impostor.name, sessionName: impostor.name,
      projectName: 'alpha', projectRoot: '/work/alpha',
    };
    const drifted = session('deck_alpha_worker', 'w1');
    drifted.activeModel = 'retired-model-9';
    // Addressable by the impostor, so target resolution cannot be what refuses.
    drifted.parentSession = impostor.name;
    const dispatchReadyAudit = vi.fn();
    const result = await dispatchSendMessage(impostorCaller, bindInput(ready.taskId, ready.revision), {
      listSessions: () => [impostor, drifted],
      dispatchMessage: vi.fn(),
      dispatchReadyAudit,
    });
    expect(result).toMatchObject({ status: 'accepted' });
    expect(registry.get(ready.taskId)?.auditPolicy).toBe('auto_allow_degraded');
    expect(dispatchReadyAudit).toHaveBeenCalledOnce();
  });

  it('keeps the older-coordinator veto removal closed when project Brain authority is ambiguous', async () => {
    const registry = getSupervisionTaskRegistry();
    const ready = makeReadyTask({ taskId: 'cic-ambiguous-brain', registry });
    const callerBrain = brainWith('supervised_audit');
    callerBrain.name = 'deck_alpha_new_brain';
    const competingBrain = brainWith('supervised_audit');
    competingBrain.name = 'deck_alpha_other_live_brain';
    competingBrain.sessionInstanceId = 'instance-other-live-brain';
    competingBrain.runtimeEpoch = 'epoch-other-live-brain';
    const drifted = session('deck_alpha_worker', 'w1');
    drifted.activeModel = 'retired-model-9';
    drifted.parentSession = callerBrain.name;
    const dispatchReadyAudit = vi.fn();
    const result = await dispatchSendMessage({
      userId: callerBrain.name, sessionName: callerBrain.name,
      projectName: 'alpha', projectRoot: '/work/alpha',
    }, bindInput(ready.taskId, ready.revision), {
      listSessions: () => [callerBrain, competingBrain, drifted],
      dispatchMessage: vi.fn(), dispatchReadyAudit,
    });
    expect(result).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.IDENTITY_REJECTED });
    expect(registry.get(ready.taskId)?.auditPolicy).toBeUndefined();
    expect(dispatchReadyAudit).not.toHaveBeenCalled();
  });

  describe('zero-write refusals', () => {
    async function refuse(overrides: {
      taskId: string; revision?: string; policy?: 'auto_allow_degraded' | 'auto_strict_cross_vendor';
      mode?: 'supervised_audit' | 'off'; caller?: typeof brainCaller; sessions?: SessionRecord[];
    }) {
      const drifted = session('deck_alpha_worker', 'w1');
      drifted.activeModel = 'retired-model-9';
      const dispatchReadyAudit = vi.fn();
      const dispatchMessage = vi.fn();
      const result = await dispatchSendMessage(
        overrides.caller ?? brainCaller,
        bindInput(overrides.taskId, overrides.revision ?? 'unused-revision', overrides.policy),
        {
          listSessions: () => overrides.sessions ?? [brainWith(overrides.mode ?? 'supervised_audit'), drifted],
          dispatchMessage,
          dispatchReadyAudit,
        },
      );
      return { result, dispatchReadyAudit, dispatchMessage };
    }

    it('refuses a non-Brain caller', async () => {
      const registry = getSupervisionTaskRegistry();
      const ready = makeReadyTask({ taskId: 'cic-not-brain', registry });
      const worker = session('deck_alpha_worker', 'w1');
      const { result, dispatchReadyAudit } = await refuse({
        taskId: ready.taskId, revision: ready.revision,
        caller: { userId: worker.name, sessionName: worker.name, projectName: 'alpha', projectRoot: '/work/alpha' },
      });
      expect(result).toMatchObject({ status: 'error' });
      expect(registry.get(ready.taskId)?.auditPolicy).toBeUndefined();
      expect(dispatchReadyAudit).not.toHaveBeenCalled();
    });

    it('refuses a stale/incorrect currentRevision', async () => {
      const registry = getSupervisionTaskRegistry();
      const ready = makeReadyTask({ taskId: 'cic-old-revision', registry });
      const { result, dispatchReadyAudit } = await refuse({
        taskId: ready.taskId, revision: 'some-older-revision',
      });
      expect(result).toMatchObject({ status: 'error' });
      expect(registry.get(ready.taskId)?.auditPolicy).toBeUndefined();
      expect(dispatchReadyAudit).not.toHaveBeenCalled();
    });

    it('refuses when supervision mode is off', async () => {
      const registry = getSupervisionTaskRegistry();
      const ready = makeReadyTask({ taskId: 'cic-mode-off', registry });
      const { result, dispatchReadyAudit } = await refuse({
        taskId: ready.taskId, revision: ready.revision, mode: 'off',
      });
      expect(result).toMatchObject({ status: 'error' });
      expect(registry.get(ready.taskId)?.auditPolicy).toBeUndefined();
      expect(dispatchReadyAudit).not.toHaveBeenCalled();
    });

    it('refuses a conflicting policy and never overwrites the bound one', async () => {
      const registry = getSupervisionTaskRegistry();
      const ready = makeReadyTask({
        taskId: 'cic-conflict', auditPolicy: 'auto_allow_degraded', registry,
      });
      const { result, dispatchReadyAudit } = await refuse({
        taskId: ready.taskId, revision: ready.revision, policy: 'auto_strict_cross_vendor',
      });
      expect(result).toMatchObject({ status: 'error' });
      expect(registry.get(ready.taskId)?.auditPolicy).toBe('auto_allow_degraded');
      expect(dispatchReadyAudit).not.toHaveBeenCalled();
    });

    it('refuses once an auditor already holds the exact revision', async () => {
      const registry = getSupervisionTaskRegistry();
      const ready = makeReadyTask({ taskId: 'cic-has-auditor', registry });
      expect(registry.createAssignment({
        taskId: ready.taskId, role: 'auditor', required: false,
        identity: identity('deck_alpha_auditor', 'claude-code-sdk', 'anthropic'),
        auditAttemptId: 'manual-attempt-cic', auditRevision: ready.revision,
      })).toMatchObject({ ok: true });
      const { result, dispatchReadyAudit } = await refuse({
        taskId: ready.taskId, revision: ready.revision,
      });
      expect(result).toMatchObject({ status: 'error' });
      expect(registry.get(ready.taskId)?.auditPolicy).toBeUndefined();
      expect(dispatchReadyAudit).not.toHaveBeenCalled();
    });
  });
});

describe('control-plane auditPolicy bind refuses a settled revision (tsk_cic)', () => {
  it('refuses once a FINAL receipt exists for the exact revision, even with no live auditor', async () => {
    // The auditor is finalized, so the live-auditor gate does NOT fire; what must
    // refuse here is the settled-receipt gate. Attaching a policy to a revision
    // whose verdict is already recorded would retroactively change the terms the
    // audit was decided under.
    const registry = getSupervisionTaskRegistry();
    const ready = makeReadyTask({ taskId: 'cic-settled-receipt', registry });
    const attemptId = 'manual-attempt-cic-settled';
    const auditor = registry.createAssignment({
      taskId: ready.taskId, role: 'auditor', required: false,
      identity: identity('deck_alpha_settled_auditor', 'claude-code-sdk', 'anthropic'),
      auditAttemptId: attemptId, auditRevision: ready.revision,
    });
    if (!auditor.ok) throw new Error(auditor.reason);
    expect(registry.updateAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditor.value.identity,
      status: 'auditing', auditAttemptId: attemptId, auditRevision: ready.revision,
    })).toMatchObject({ ok: true });
    expect(registry.appendMatchingAuditReceipt({
      taskId: ready.taskId, auditorAssignmentId: auditor.value.assignmentId,
      auditorIdentity: auditor.value.identity, auditorSessionName: auditor.value.identity.sessionName,
      attemptId, revision: ready.revision, receiptKind: 'final', verdict: 'PASS',
      findings: 'already decided', validations: [],
    })).toMatchObject({ ok: true });
    expect(registry.finishAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditor.value.identity, revision: ready.revision,
    })).toMatchObject({ ok: true });
    expect(
      registry.listAssignments(ready.taskId).filter((a) => (
        a.role === 'auditor' && !['rework', 'cancelled', 'finalized'].includes(a.status)
      )),
      'no LIVE auditor remains, so only the receipt gate can refuse',
    ).toEqual([]);

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
    const dispatchReadyAudit = vi.fn();
    const result = await dispatchSendMessage({
      userId: brain.name, sessionName: brain.name, projectName: 'alpha', projectRoot: '/work/alpha',
    }, {
      target: worker.name,
      message: 'bind after the verdict landed',
      task: {
        taskId: ready.taskId, currentRevision: ready.revision,
        auditPolicy: 'auto_allow_degraded', executionPool: 'primary' as const,
      },
    }, { listSessions: () => [brain, worker], dispatchMessage: vi.fn(), dispatchReadyAudit });

    expect(result).toMatchObject({ status: 'error' });
    expect(registry.get(ready.taskId)?.auditPolicy, 'zero write on a settled revision').toBeUndefined();
    expect(dispatchReadyAudit).not.toHaveBeenCalled();
  });
});

describe('audit redelivery when the policy is already persisted (tsk_bzp shape)', () => {
  it('accepts an exact audit continuation that restates the persisted policy, without duplicating the auditor', async () => {
    // tsk_bzp: auditPolicy was already persisted AND an exact auditor/attempt
    // already existed, yet an exact continuation carrying audit metadata was
    // refused with "must be bound by a task continuation before audit dispatch",
    // while the identical append WITHOUT audit metadata succeeded. The client
    // was echoing back the policy it had just read, which is a no-op restatement
    // rather than a bind, so refusing it broke redelivery after a refresh.
    const registry = getSupervisionTaskRegistry();
    const ready = makeReadyTask({
      taskId: 'bzp-restate-policy', auditPolicy: 'auto_strict_cross_vendor', registry,
    });
    const attemptId = 'auto-audit-637b02fa1eeb0677207ea76d';
    const auditorSession = session('deck_alpha_auditor', 'w2', 'claude-code-sdk', 'anthropic');
    const existingAuditor = registry.createAssignment({
      taskId: ready.taskId, role: 'auditor', required: true,
      identity: identity('deck_alpha_auditor', 'claude-code-sdk', 'anthropic'),
      auditAttemptId: attemptId, auditRevision: ready.revision,
    });
    if (!existingAuditor.ok) throw new Error(existingAuditor.reason);

    const selected = {
      agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport' as const, model: 'gpt-5.6',
    };
    const auditorCapability = {
      agentType: 'claude-code-sdk', providerFamily: 'anthropic',
      runtimeType: 'transport' as const, model: 'claude-sonnet-4-6',
    };
    const brain = session('deck_alpha_brain', 'brain');
    brain.transportConfig = {
      supervision: normalizeSessionSupervisionSnapshot({
        mode: 'supervised_audit',
        auditTargetSessionName: auditorSession.name,
        executionPools: {
          state: 'configured',
          primaryDevelopmentPool: {
            // The audit TARGET is the auditor, so its capability must also be
            // pool-selected for the ordinary target/pool gate to admit the send.
            configs: [
              { ...selected, capabilityId: buildSupervisionExecutionCapabilityId(selected) },
              { ...auditorCapability, capabilityId: buildSupervisionExecutionCapabilityId(auditorCapability) },
            ],
            controls: { maxSpawned: 2 },
          },
          economyTaskPool: { configs: [], controls: { maxSpawned: 0 } },
        },
      }),
    };
    const worker = session('deck_alpha_worker', 'w1');
    const auditorsBefore = registry.listAssignments(ready.taskId).filter((a) => a.role === 'auditor').length;

    const result = await dispatchSendMessage({
      userId: brain.name, sessionName: brain.name, projectName: 'alpha', projectRoot: '/work/alpha',
    }, {
      target: auditorSession.name,
      message: 'continue the exact existing audit',
      reply: true,
      audit: {
        kind: 'supervision_audit',
        attemptId,
        auditedSessionName: worker.name,
      },
      task: {
        taskId: ready.taskId,
        assignmentId: existingAuditor.value.assignmentId,
        currentRevision: ready.revision,
        auditRevision: ready.revision,
        auditAttemptId: attemptId,
        // The client echoes back the policy it just read. Identical to persisted.
        auditPolicy: 'auto_strict_cross_vendor',
        executionPool: 'primary' as const,
      },
    }, {
      listSessions: () => [brain, worker, auditorSession],
      dispatchMessage: vi.fn().mockResolvedValue('queued'),
      ensureSupervisionAssignmentWorktree: async () => ({
        ok: true, worktreePath: '/worktree/repo', baseRevision: 'a'.repeat(40), created: false,
      }),
    });

    // POSITIVE assertion on purpose. An earlier draft asserted only "not the
    // policy error", which passed vacuously while the call was actually failing
    // for an unrelated fixture reason. Requiring acceptance cannot pass unless
    // the redelivery genuinely succeeds.
    expect(
      result,
      'restating the already-persisted policy must not block an exact audit continuation',
    ).toMatchObject({ status: 'accepted', taskId: ready.taskId });
    expect(
      registry.listAssignments(ready.taskId).filter((a) => a.role === 'auditor'),
      'redelivery must never mint a duplicate auditor',
    ).toHaveLength(auditorsBefore);
    expect(registry.get(ready.taskId)?.auditPolicy).toBe('auto_strict_cross_vendor');
  });

  it('still refuses audit metadata carrying a CONFLICTING policy', async () => {
    // Single-variable control: byte-for-byte the same setup as the restatement
    // case above -- same existing auditor, same attempt, same target -- with ONLY
    // the policy value changed. The relaxation is exact-value only, so a
    // different policy alongside audit metadata is still a bind attempt.
    const registry = getSupervisionTaskRegistry();
    const ready = makeReadyTask({
      taskId: 'bzp-conflicting-policy', auditPolicy: 'auto_strict_cross_vendor', registry,
    });
    const attemptId = 'auto-audit-637b02fa1eeb0677207ea76d';
    const auditorSession = session('deck_alpha_auditor', 'w2', 'claude-code-sdk', 'anthropic');
    const existingAuditor = registry.createAssignment({
      taskId: ready.taskId, role: 'auditor', required: true,
      identity: identity('deck_alpha_auditor', 'claude-code-sdk', 'anthropic'),
      auditAttemptId: attemptId, auditRevision: ready.revision,
    });
    if (!existingAuditor.ok) throw new Error(existingAuditor.reason);
    const selected = {
      agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport' as const, model: 'gpt-5.6',
    };
    const auditorCapability = {
      agentType: 'claude-code-sdk', providerFamily: 'anthropic',
      runtimeType: 'transport' as const, model: 'claude-sonnet-4-6',
    };
    const brain = session('deck_alpha_brain', 'brain');
    brain.transportConfig = {
      supervision: normalizeSessionSupervisionSnapshot({
        mode: 'supervised_audit',
        auditTargetSessionName: auditorSession.name,
        executionPools: {
          state: 'configured',
          primaryDevelopmentPool: {
            // The audit TARGET is the auditor, so its capability must also be
            // pool-selected for the ordinary target/pool gate to admit the send.
            configs: [
              { ...selected, capabilityId: buildSupervisionExecutionCapabilityId(selected) },
              { ...auditorCapability, capabilityId: buildSupervisionExecutionCapabilityId(auditorCapability) },
            ],
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
      target: auditorSession.name,
      message: 'conflicting policy alongside audit metadata',
      reply: true,
      audit: { kind: 'supervision_audit', attemptId, auditedSessionName: worker.name },
      task: {
        taskId: ready.taskId,
        assignmentId: existingAuditor.value.assignmentId,
        currentRevision: ready.revision,
        auditRevision: ready.revision,
        auditAttemptId: attemptId,
        auditPolicy: 'auto_allow_degraded',
        executionPool: 'primary' as const,
      },
    }, {
      listSessions: () => [brain, worker, auditorSession],
      dispatchMessage: vi.fn().mockResolvedValue('queued'),
      ensureSupervisionAssignmentWorktree: async () => ({
        ok: true, worktreePath: '/worktree/repo', baseRevision: 'a'.repeat(40), created: false,
      }),
    });

    expect(result).toMatchObject({
      status: 'error',
      error: 'task auditPolicy must be bound by a task continuation before audit dispatch',
    });
    expect(registry.get(ready.taskId)?.auditPolicy).toBe('auto_strict_cross_vendor');
  });
});

describe('automatic audit fan-out across ready auditors', () => {
  const acceptingDispatch = () => {
    let seq = 0;
    return vi.fn(async (_caller: unknown, input: { target?: string }) => {
      seq += 1;
      return {
        status: 'accepted' as const,
        assignmentId: `asg_auto_${seq}`,
        messageId: `msg_${seq}`,
        target: input.target,
      };
    });
  };

  /** Every target this dispatch was actually asked to send to. */
  const targetsOf = (dispatch: ReturnType<typeof acceptingDispatch>) => dispatch.mock.calls
    .map((call) => (call[1] as { target?: string }).target);

  it('gives two different tasks two different ready auditors', async () => {
    // The reported failure: separate audits all chose the same ready peer,
    // because availability had not moved by the time the second one looked.
    // Three of four then queued behind one session while peers sat idle.
    const brain = session('deck_alpha_brain', 'brain');
    const worker = session('deck_alpha_worker', 'w1');
    const first = session('deck_alpha_aud_a', 'w2', 'claude-code-sdk', 'anthropic');
    const second = session('deck_alpha_aud_b', 'w3', 'claude-code-sdk', 'anthropic');
    const sessions = [brain, worker, first, second];
    const dispatch = acceptingDispatch();

    const one = makeReadyTask({ taskId: 'tsk_one', revision: 'rev-one', auditPolicy: 'auto_strict_cross_vendor' });
    const two = makeReadyTask({ taskId: 'tsk_two', revision: 'rev-two', auditPolicy: 'auto_strict_cross_vendor' });
    const deps = (registry: unknown) => ({
      registry,
      listSessions: () => sessions,
      listTargets: listTargetRecords(first, second),
      dispatch,
    });

    // Dispatched without letting either settle first: the listing still says
    // both peers are ready when the second route looks.
    await Promise.all([
      dispatchReadyAudit('tsk_one', deps(one.registry) as never),
      dispatchReadyAudit('tsk_two', deps(two.registry) as never),
    ]);

    const chosen = targetsOf(dispatch).filter(Boolean);
    expect(chosen).toHaveLength(2);
    expect(new Set(chosen).size, 'both audits piled onto one ready auditor').toBe(2);
  });

  it('keeps a same-task continuation on its own session even when that session is busy', async () => {
    // Continuing a task is not a routing decision. It must append to the exact
    // session that already holds the assignment, and a busy one queues rather
    // than handing the work to a different peer.
    const brain = session('deck_alpha_brain', 'brain');
    const worker = session('deck_alpha_worker', 'w1');
    const busyOwner = { ...session('deck_alpha_aud_a', 'w2', 'claude-code-sdk', 'anthropic'), state: 'running' as const };
    const idlePeer = session('deck_alpha_aud_b', 'w3', 'claude-code-sdk', 'anthropic');
    const { registry, taskId, revision } = makeReadyTask({ taskId: 'tsk_same', revision: 'rev-same', auditPolicy: 'auto_strict_cross_vendor' });
    const attemptId = automaticAttempt(taskId, revision);
    expect(registry.createAssignment({
      assignmentId: 'asg_existing_auditor',
      taskId,
      role: 'auditor',
      required: true,
      identity: identity(busyOwner.name),
      auditAttemptId: attemptId,
      auditRevision: revision,
    })).toMatchObject({ ok: true });
    const dispatch = acceptingDispatch();

    await dispatchReadyAudit(taskId, {
      registry,
      listSessions: () => [brain, worker, busyOwner, idlePeer],
      listTargets: listTargetRecords(busyOwner, idlePeer),
      dispatch,
    } as never);

    // The idle peer is RIGHT THERE and must still not be used.
    expect(targetsOf(dispatch)).toEqual([busyOwner.name]);
  });

  it('releases a claimed auditor when the dispatch fails', async () => {
    // A refused dispatch routed nothing, so it may not keep a ready peer out
    // of the pool: failing the audit closed must not also fail capacity closed.
    const brain = session('deck_alpha_brain', 'brain');
    const worker = session('deck_alpha_worker', 'w1');
    const only = session('deck_alpha_aud_a', 'w2', 'claude-code-sdk', 'anthropic');
    const sessions = [brain, worker, only];
    const failing = vi.fn(async () => ({ status: 'error' as const, error: 'transport refused' }));
    const one = makeReadyTask({ taskId: 'tsk_fail', revision: 'rev-fail', auditPolicy: 'auto_strict_cross_vendor' });

    await dispatchReadyAudit('tsk_fail', {
      registry: one.registry,
      listSessions: () => sessions,
      listTargets: listTargetRecords(only),
      dispatch: failing,
    } as never);
    expect(__auditTargetReservationsForTests(), 'a failed dispatch kept holding its auditor')
      .toEqual([]);

    // And the next task can still have it.
    const dispatch = acceptingDispatch();
    const two = makeReadyTask({ taskId: 'tsk_after', revision: 'rev-after', auditPolicy: 'auto_strict_cross_vendor' });
    await dispatchReadyAudit('tsk_after', {
      registry: two.registry,
      listSessions: () => sessions,
      listTargets: listTargetRecords(only),
      dispatch,
    } as never);
    expect(targetsOf(dispatch)).toEqual([only.name]);
  });

  it('hands a claimed auditor back once it stops reporting ready', async () => {
    // Release is structural, not event-driven: a claim only bridges the lag in
    // the availability signal. When the audit finishes or is cancelled the
    // session reports ready again and is immediately selectable -- which also
    // means a lost terminal event cannot strand it.
    const brain = session('deck_alpha_brain', 'brain');
    const worker = session('deck_alpha_worker', 'w1');
    const auditor = session('deck_alpha_aud_a', 'w2', 'claude-code-sdk', 'anthropic');
    const dispatch = acceptingDispatch();
    const one = makeReadyTask({ taskId: 'tsk_hold', revision: 'rev-hold', auditPolicy: 'auto_strict_cross_vendor' });
    await dispatchReadyAudit('tsk_hold', {
      registry: one.registry,
      listSessions: () => [brain, worker, auditor],
      listTargets: listTargetRecords(auditor),
      dispatch,
    } as never);
    expect(__auditTargetReservationsForTests().map((item) => item.target)).toEqual([auditor.name]);

    // The auditor is now busy with that audit, so the listing excludes it from
    // the ready set and the claim is redundant.
    const busy = { ...auditor, state: 'running' as const };
    const two = makeReadyTask({ taskId: 'tsk_next', revision: 'rev-next', auditPolicy: 'auto_strict_cross_vendor' });
    await dispatchReadyAudit('tsk_next', {
      registry: two.registry,
      listSessions: () => [brain, worker, busy],
      listTargets: listTargetRecords(busy),
      dispatch,
    } as never);
    expect(__auditTargetReservationsForTests(), 'the claim outlived the ready signal')
      .toEqual([]);
  });

  /**
   * One pool, one shared registry, and dispatch that refuses to spawn.
   *
   * The refusal matters: it is what forces the routing order to be OBSERVABLE.
   * A route with a ready peer sends once, with a target; a route without one
   * must try the pool first and only then fall back, so the sequence of
   * attempts says which branch was taken -- which is the only way to tell a
   * legitimate FIFO fallback from having handed out a claimed auditor twice.
   */
  function spawnRefusingDispatch() {
    const attempts: Array<{ target?: string; autoProvision: boolean }> = [];
    let seq = 0;
    const dispatch = vi.fn(async (
      _caller: unknown,
      input: { target?: string; task?: { autoProvision?: boolean } },
    ) => {
      const autoProvision = input.task?.autoProvision === true;
      attempts.push({ target: input.target, autoProvision });
      if (autoProvision) {
        return {
          status: 'error' as const,
          error: 'no capacity',
          provisioning: { failureReason: 'max_spawned' as const },
        };
      }
      seq += 1;
      return {
        status: 'accepted' as const,
        assignmentId: `asg_auto_${seq}`,
        messageId: `msg_${seq}`,
        target: input.target,
      };
    });
    return { dispatch, attempts };
  }

  it('does not release one task\'s auditor just because another task may not use it', async () => {
    // The exact three-task race. Task B's implementer IS task A's auditor, so
    // B's candidate pool cannot contain that session at all. Pruning claims
    // against B's own filtered pool therefore read "not ready" and handed A's
    // live claim back -- and task C, which CAN see it, took it straight away.
    const brain = session('deck_alpha_brain', 'brain');
    const implA = session('deck_alpha_w_a', 'w1');
    const implC = session('deck_alpha_w_c', 'w4');
    const audS = session('deck_alpha_aud_s', 'w2', 'claude-code-sdk', 'anthropic');
    const audT = session('deck_alpha_aud_t', 'w3', 'claude-code-sdk', 'anthropic');
    // Cross-vendor for task B, whose implementer is itself an anthropic peer.
    const audU = session('deck_alpha_aud_u', 'w5');
    const sessions = [brain, implA, implC, audS, audT, audU];
    const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
    const { dispatch, attempts } = spawnRefusingDispatch();
    const deps = {
      registry,
      listSessions: () => sessions,
      listTargets: listTargetRecords(audS, audT, audU),
      dispatch,
    };

    for (const [taskId, revision, implementerSession] of [
      ['tsk_a', 'rev-a', implA.name],
      // Task B is implemented BY the session task A is auditing with.
      ['tsk_b', 'rev-b', audS.name],
      ['tsk_c', 'rev-c', implC.name],
    ] as const) {
      makeReadyTask({
        taskId, revision, registry, implementerSession,
        auditPolicy: 'auto_strict_cross_vendor',
      });
    }

    await dispatchReadyAudit('tsk_a', deps as never);
    await dispatchReadyAudit('tsk_b', deps as never);
    // A took the first cross-vendor peer; B, which may not use its own
    // implementer, took the only peer that is cross-vendor for it.
    expect(attempts.map((attempt) => attempt.target)).toEqual([audS.name, audU.name]);
    // The claim B could not even consider must still be A's.
    expect(
      __auditTargetReservationsForTests().find((item) => item.target === audS.name)?.ownerKey,
      'task B released an auditor it was never allowed to route to',
    ).toBe(automaticAttempt('tsk_a', 'rev-a'));

    // C can see audS and would take it first by name. It must get the peer
    // that is actually free instead of the one already auditing for A.
    await dispatchReadyAudit('tsk_c', deps as never);
    expect(attempts.slice(2), 'a live claim was handed to a second audit')
      .toEqual([{ target: audT.name, autoProvision: false }]);
  });

  it('queues onto a claimed ready auditor rather than blocking the audit', async () => {
    // A ready peer that another route has claimed was in NEITHER pool: not
    // selectable as ready, and missing from the busy fallback. So once every
    // ready peer was claimed, the one auto-provision attempt refusing for
    // capacity left nothing at all and the audit blocked -- even though that
    // peer is exactly a queueable transport, which is what the durable FIFO
    // fallback is for.
    const brain = session('deck_alpha_brain', 'brain');
    const implA = session('deck_alpha_w_a', 'w1');
    const implC = session('deck_alpha_w_c', 'w4');
    const only = session('deck_alpha_aud_s', 'w2', 'claude-code-sdk', 'anthropic');
    const sessions = [brain, implA, implC, only];
    const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
    const { dispatch, attempts } = spawnRefusingDispatch();
    const deps = {
      registry,
      listSessions: () => sessions,
      listTargets: listTargetRecords(only),
      dispatch,
    };
    makeReadyTask({
      taskId: 'tsk_a', revision: 'rev-a', registry,
      implementerSession: implA.name, auditPolicy: 'auto_strict_cross_vendor',
    });
    makeReadyTask({
      taskId: 'tsk_c', revision: 'rev-c', registry,
      implementerSession: implC.name, auditPolicy: 'auto_strict_cross_vendor',
    });

    await dispatchReadyAudit('tsk_a', deps as never);
    expect(attempts).toEqual([{ target: only.name, autoProvision: false }]);

    const outcome = await dispatchReadyAudit('tsk_c', deps as never);
    // Order intact: ready first, then one spawn attempt, and only then FIFO.
    expect(attempts.slice(1)).toEqual([
      { target: undefined, autoProvision: true },
      { target: only.name, autoProvision: false },
    ]);
    expect(outcome.status, 'a fully-claimed pool blocked instead of queueing')
      .not.toBe('blocked');
  });

  /**
   * Record what an ACCEPTED dispatch durably records in production: an auditor
   * assignment bound to one exact session and one exact attempt. The dispatch
   * these tests use is a mock, so it writes nothing on its own.
   */
  function recordAcceptedAuditor(
    registry: SupervisionTaskRegistry,
    input: { assignmentId: string; taskId: string; revision: string; target: string },
  ): void {
    expect(registry.createAssignment({
      assignmentId: input.assignmentId,
      taskId: input.taskId,
      role: 'auditor',
      required: true,
      identity: identity(input.target),
      auditAttemptId: automaticAttempt(input.taskId, input.revision),
      auditRevision: input.revision,
    })).toMatchObject({ ok: true });
  }

  it.each([
    ['a daemon restart drops every in-memory claim', 'restart' as const],
    ['the readiness signal lags for longer than the claim TTL', 'stale_ready' as const],
  ])('keeps a live audit\'s auditor out of the ready pool when %s', async (_label, kind) => {
    // A claim is a cache of a durable fact -- an auditor assignment bound to a
    // session. Treating the cache as the fact meant a restart forgot it, and a
    // TTL expired it while the readiness signal it exists to bridge was still
    // lagging. Both hand the same auditor to a second audit.
    const brain = session('deck_alpha_brain', 'brain');
    const implA = session('deck_alpha_w_a', 'w1');
    const implC = session('deck_alpha_w_c', 'w4');
    const audS = session('deck_alpha_aud_s', 'w2', 'claude-code-sdk', 'anthropic');
    const audT = session('deck_alpha_aud_t', 'w3', 'claude-code-sdk', 'anthropic');
    const sessions = [brain, implA, implC, audS, audT];
    const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
    const { dispatch, attempts } = spawnRefusingDispatch();
    const base = 1_700_000_000_000;
    let now = base;
    const deps = {
      registry,
      listSessions: () => sessions,
      // The peer STILL reports ready: that lag is the whole problem.
      listTargets: listTargetRecords(audS, audT),
      dispatch,
      now: () => now,
    };

    makeReadyTask({
      taskId: 'tsk_a', revision: 'rev-a', registry,
      implementerSession: implA.name, auditPolicy: 'auto_strict_cross_vendor',
    });
    makeReadyTask({
      taskId: 'tsk_c', revision: 'rev-c', registry,
      implementerSession: implC.name, auditPolicy: 'auto_strict_cross_vendor',
    });

    await dispatchReadyAudit('tsk_a', deps as never);
    expect(attempts.map((attempt) => attempt.target)).toEqual([audS.name]);
    recordAcceptedAuditor(registry, {
      assignmentId: 'asg_auditor_a', taskId: 'tsk_a', revision: 'rev-a', target: audS.name,
    });

    if (kind === 'restart') {
      // A new process starts with nothing in memory.
      __resetAuditTargetReservationsForTests();
      expect(__auditTargetReservationsForTests()).toEqual([]);
    } else {
      // Long past the TTL, with the listing still insisting the peer is ready.
      now = base + AUDIT_TARGET_RESERVATION_TTL_MS * 5;
    }

    await dispatchReadyAudit('tsk_c', deps as never);
    // Rebuilt from the durable assignment, not from this process's memory.
    expect(
      __auditTargetReservationsForTests().find((item) => item.target === audS.name)?.ownerKey,
      'the live audit lost its auditor claim',
    ).toBe(automaticAttempt('tsk_a', 'rev-a'));
    expect(attempts.slice(1), 'a busy auditor was handed a second concurrent audit')
      .toEqual([{ target: audT.name, autoProvision: false }]);
  });

  it('gives the auditor back as soon as its assignment stops being live', async () => {
    // The other half of reconstructing claims from the durable record: a claim
    // that outlives its audit is an invented capacity cap. When the assignment
    // leaves the live set the session is free again, with no terminal event
    // and no timer needed.
    const brain = session('deck_alpha_brain', 'brain');
    const implA = session('deck_alpha_w_a', 'w1');
    const implB = session('deck_alpha_w_b', 'w5');
    const implC = session('deck_alpha_w_c', 'w4');
    const only = session('deck_alpha_aud_s', 'w2', 'claude-code-sdk', 'anthropic');
    const sessions = [brain, implA, implB, implC, only];
    const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
    const { dispatch, attempts } = spawnRefusingDispatch();
    const deps = {
      registry,
      listSessions: () => sessions,
      listTargets: listTargetRecords(only),
      dispatch,
    };
    for (const [taskId, revision, implementerSession] of [
      ['tsk_a', 'rev-a', implA.name],
      ['tsk_b', 'rev-b', implB.name],
      ['tsk_c', 'rev-c', implC.name],
    ] as const) {
      makeReadyTask({
        taskId, revision, registry, implementerSession,
        auditPolicy: 'auto_strict_cross_vendor',
      });
    }

    await dispatchReadyAudit('tsk_a', deps as never);
    recordAcceptedAuditor(registry, {
      assignmentId: 'asg_auditor_a', taskId: 'tsk_a', revision: 'rev-a', target: only.name,
    });
    expect(registry.listActiveAuditTargets()).toEqual([
      { sessionName: only.name, attemptId: automaticAttempt('tsk_a', 'rev-a') },
    ]);

    // A second route confirms the claim against the durable record. It finds
    // the only peer taken and queues, which is the correct outcome here.
    await dispatchReadyAudit('tsk_b', deps as never);
    expect(attempts.slice(1)).toEqual([
      { target: undefined, autoProvision: true },
      { target: only.name, autoProvision: false },
    ]);

    // That audit is called off, so nothing is auditing on that session.
    expect(registry.applyTaskIntent({
      taskId: 'tsk_a', assignmentId: 'asg_auditor_a', intent: 'cancel', toStatus: 'cancelled',
    })).toMatchObject({ ok: true });
    expect(registry.listActiveAuditTargets()).toEqual([]);

    await dispatchReadyAudit('tsk_c', deps as never);
    expect(attempts.slice(3), 'a cancelled audit kept holding its auditor')
      .toEqual([{ target: only.name, autoProvision: false }]);
  });

  it('queues onto a busy auditor only after ready and auto-provision are exhausted', async () => {
    // Ordering, stated as the sequence of attempts rather than as prose: with
    // no ready peer the pool gets one spawn attempt, and the busy peer is the
    // durable-FIFO fallback only after that attempt refuses for capacity.
    const brain = session('deck_alpha_brain', 'brain');
    const worker = session('deck_alpha_worker', 'w1');
    const busy = { ...session('deck_alpha_aud_a', 'w2', 'claude-code-sdk', 'anthropic'), state: 'running' as const };
    const attempts: Array<{ target?: string; autoProvision?: boolean }> = [];
    const dispatch = vi.fn(async (_caller: unknown, input: { target?: string; task?: { autoProvision?: boolean } }) => {
      attempts.push({ target: input.target, autoProvision: input.task?.autoProvision });
      if (attempts.length === 1) {
        return {
          status: 'error' as const,
          error: 'no capacity',
          provisioning: { failureReason: 'max_spawned' as const },
        };
      }
      return { status: 'accepted' as const, assignmentId: 'asg_busy', messageId: 'msg_busy' };
    });
    const { registry } = makeReadyTask({ taskId: 'tsk_order', revision: 'rev-order', auditPolicy: 'auto_strict_cross_vendor' });

    await dispatchReadyAudit('tsk_order', {
      registry,
      listSessions: () => [brain, worker, busy],
      listTargets: listTargetRecords(busy),
      dispatch,
    } as never);

    expect(attempts).toEqual([
      { target: undefined, autoProvision: true },
      { target: busy.name, autoProvision: undefined },
    ]);
  });

  it('rebinds one existing unselected auditor to an exact selected cross-vendor target', async () => {
    const brain = session('deck_alpha_brain', 'brain');
    const worker = session('deck_alpha_worker', 'w1');
    worker.activeModel = 'gpt-5.6-sol';
    const stale = session('deck_alpha_auto_audit', 'w2', 'codex-sdk', 'openai');
    stale.activeModel = 'gpt-6-astra';
    const selected = session('deck_alpha_cc', 'w2', 'claude-code-sdk', 'anthropic');
    selected.activeModel = 'claude-sonnet-5';
    selected.requestedModel = 'sonnet';
    const sonnet = {
      agentType: 'claude-code-sdk', providerFamily: 'anthropic',
      runtimeType: 'transport' as const, model: 'sonnet',
    };
    const sol = {
      agentType: 'codex-sdk', providerFamily: 'openai',
      runtimeType: 'transport' as const, model: 'gpt-5.6-sol',
    };
    const terra = {
      agentType: 'codex-sdk', providerFamily: 'openai',
      runtimeType: 'transport' as const, model: 'gpt-5.6-terra',
    };
    brain.transportConfig = {
      supervision: normalizeSessionSupervisionSnapshot({
        mode: 'supervised_audit',
        executionPools: {
          state: 'configured',
          primaryDevelopmentPool: {
            configs: [sonnet, sol, terra].map((config) => ({
              ...config, capabilityId: buildSupervisionExecutionCapabilityId(config),
            })),
            controls: { maxSpawned: 2 },
          },
          economyTaskPool: { configs: [], controls: { maxSpawned: 0 } },
        },
      }),
    };
    const { registry, revision } = makeReadyTask({
      taskId: 'tsk_unselected_existing_recovery',
      revision: 'unselected-existing-r1',
      auditPolicy: 'auto_allow_degraded',
    });
    const attemptId = automaticAttempt('tsk_unselected_existing_recovery', revision);
    const auditor = registry.createAssignment({
      taskId: 'tsk_unselected_existing_recovery', role: 'auditor', required: true,
      identity: identity(stale.name, 'codex-sdk', 'openai'),
      auditAttemptId: attemptId, auditRevision: revision,
    });
    if (!auditor.ok) throw new Error(auditor.reason);
    const calls: SendMessageInput[] = [];
    const dispatch = vi.fn(async (_caller: unknown, input: SendMessageInput) => {
      calls.push(input);
      return {
        status: 'accepted' as const,
        assignmentId: auditor.value.assignmentId,
        messageId: 'send_message_00000000-0000-5000-a000-00000000feed' as SendMessageId,
      };
    });

    await expect(dispatchReadyAudit('tsk_unselected_existing_recovery', {
      registry,
      listSessions: () => [brain, worker, stale, selected],
      listTargets: listTargetRecords(selected),
      dispatch: dispatch as never,
      hasDeliveryEvidence: () => false,
      inspectAssignmentWorktree: () => ({
        worktreePath: '/tmp/unselected-existing/repo', headSha: 'a'.repeat(40),
        files: [{ path: 'src/exact.ts', sha256: '1'.repeat(64) }],
        stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
      }),
    })).resolves.toMatchObject({
      status: 'dispatched', assignmentId: auditor.value.assignmentId, attemptId,
    });
    expect(calls.map((input) => input.target)).toEqual([selected.name]);
    expect(calls[0]?.task).toMatchObject({
      taskId: 'tsk_unselected_existing_recovery',
      assignmentId: auditor.value.assignmentId,
      auditAttemptId: attemptId,
      auditRevision: revision,
      requestedExecutionType: {
        ...sonnet,
        capabilityId: buildSupervisionExecutionCapabilityId(sonnet),
      },
    });
    expect(calls[0]?.audit).toMatchObject({ strictCrossVendor: true });
    expect(registry.listAssignments('tsk_unselected_existing_recovery').filter((item) => item.role === 'auditor'))
      .toHaveLength(1);
  });
});

/**
 * P1-2 (audit auto-audit-b870aa76): the real freeze/open-audit boundary.
 *
 * dispatchReadyAudit (live) and the startup/periodic sweep gated only on the
 * ready_for_audit projection, so a successor whose only PASS stamp belonged to
 * the predecessor -- or carried no stamp at all -- froze a bundle, minted an
 * auditor/attempt and delivered it. Both the task AND the selected owner must
 * attest the exact current revision.
 */
describe('freeze/open-audit boundary requires exact current-revision validation authority', () => {
  const R1 = 'freeze-authority-r1';
  const R2 = 'freeze-authority-r2';
  const sessions = () => [
    session('deck_alpha_brain', 'brain'),
    session('deck_alpha_worker', 'w1'),
    session('deck_alpha_auditor', 'w2', 'claude-code-sdk', 'anthropic'),
  ];

  function validatedPredecessor(taskId: string) {
    const database = new DatabaseSync(':memory:');
    const registry = new SupervisionTaskRegistry({ database });
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'integration_task',
      objective: 'freeze only exact validated bytes', currentRevision: R1,
      auditPolicy: 'auto_strict_cross_vendor',
    })).toMatchObject({ ok: true });
    expect(registry.createAssignment({
      taskId, role: 'coordinator', identity: identity('deck_alpha_brain'), required: false,
    })).toMatchObject({ ok: true });
    const worker = registry.createAssignment({
      taskId, role: 'implementer', identity: identity('deck_alpha_worker'),
      auditRevision: R1, scopeFiles: ['src/exact.ts'],
    });
    if (!worker.ok) throw new Error(worker.reason);
    for (const [intent, toStatus, validationState] of [
      ['start', 'implementing', undefined],
      ['record_validation', 'validated', 'passed'],
    ] as const) {
      expect(registry.applyTaskIntent({ expectedRevision: (registry.getTaskRecord(taskId)?.currentRevision ?? SUPERVISION_UNBOUND_REVISION),
        taskId, assignmentId: worker.value.assignmentId, intent, toStatus,
        ...(validationState ? { validationState } : {}),
      })).toMatchObject({ ok: true });
    }
    expect(registry.getAssignment(worker.value.assignmentId)).toMatchObject({ validatedRevision: R1 });
    return { database, registry, taskId, worker: worker.value };
  }

  function harness(
    registry: SupervisionTaskRegistry,
    taskId: string,
    revision: string,
    hooks: {
      onInspect?: () => void;
      onAuditDispatch?: () => void;
      onListTargets?: () => void;
      snapshotFiles?: Array<{ path: string; sha256: string }>;
    } = {},
  ) {
    let evidence = false;
    const inspect = vi.fn(() => {
      hooks.onInspect?.();
      return {
        worktreePath: `/tmp/${taskId}/repo`, headSha: 'a'.repeat(40),
        files: hooks.snapshotFiles ?? [{ path: 'src/exact.ts', sha256: '1'.repeat(64) }],
        stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
      };
    });
    const dispatch = vi.fn(async (_c: SendRuntimeCaller, input: SendMessageInput) => {
      if (!input.audit) {
        return {
          status: 'accepted' as const,
          dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000000' as const,
          messageId: 'send_message_00000000-0000-5000-a000-0000000000c1' as SendMessageId,
          deliveries: [{ target: 'deck_alpha_brain', status: 'queued' as const }],
        };
      }
      hooks.onAuditDispatch?.();
      // Models the real send path: the auditor/attempt is materialized under the
      // registry lock with the carried authority snapshot.
      const created = registry.createAssignment({
        taskId, role: 'auditor', required: false,
        identity: identity('deck_alpha_auditor', 'claude-code-sdk', 'anthropic'),
        auditAttemptId: input.audit.attemptId, auditRevision: revision,
        validationAuthority: input.internalAuditValidationAuthority,
        idempotencyKey: `send:${input.idempotencyKey}`,
      });
      if (!created.ok) {
        return {
          status: 'error' as const,
          reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
          error: `task registry rejected assignment: ${created.reason}`,
        };
      }
      evidence = true;
      return {
        status: 'accepted' as const,
        dispatchId: 'send_dispatch_00000000-0000-4000-8000-000000000000' as const,
        messageId: 'send_message_00000000-0000-5000-a000-0000000000c0' as SendMessageId,
        deliveries: [{ target: 'deck_alpha_auditor', status: 'queued' as const }],
        taskId, assignmentId: created.value.assignmentId,
      };
    });
    const all = sessions();
    const records = listTargetRecords(all[2]!);
    const listTargets = vi.fn((...args: unknown[]) => {
      hooks.onListTargets?.();
      return (records as (...a: unknown[]) => ReturnType<typeof records>)(...args);
    });
    const deps = {
      registry, listSessions: () => all,
      listTargets: listTargets as never, dispatch: dispatch as never,
      hasDeliveryEvidence: () => evidence,
      inspectAssignmentWorktree: inspect,
      runScheduledWorktreeGcBatch: async () => {},
    };
    const assertNothingMaterialized = () => {
      expect(dispatch.mock.calls.some((call) => Boolean(call[1].audit)), 'no audit delivery').toBe(false);
      expect(inspect, 'no worktree snapshot/freeze').not.toHaveBeenCalled();
      expect(registry.listAssignments(taskId).filter((a) => a.role === 'auditor'), 'no auditor').toEqual([]);
      expect(registry.getTaskRecord(taskId)!.integrationBundle, 'no bundle bind').toBeUndefined();
      expect(registry.getAssignment(
        registry.listAssignments(taskId).find((a) => a.role === 'implementer')!.assignmentId,
      )!.auditAttemptId, 'no attempt').toBeUndefined();
    };
    return { deps, dispatch, inspect, listTargets, assertNothingMaterialized };
  }

  const refused = [
    ['unstamped legacy successor', undefined, undefined],
    ['predecessor-stamped task and owner', R1, R1],
    ['split: task exact, owner predecessor', R2, R1],
    ['split: owner exact, task predecessor', R1, R2],
    ['split: task exact, owner unstamped', R2, undefined],
    ['split: owner exact, task unstamped', undefined, R2],
  ] as const;

  it.each(refused)('live dispatch refuses %s', async (_label, taskStamp, ownerStamp) => {
    const shape = validatedPredecessor(`freeze-live-${String(taskStamp)}-${String(ownerStamp)}`);
    stampValidation(shape.database, shape.taskId, shape.worker.assignmentId, taskStamp, ownerStamp, {
      taskStatus: 'ready_for_audit', ownerStatus: 'ready_for_audit', revision: R2,
    });
    const h = harness(shape.registry, shape.taskId, R2);
    const result = await dispatchReadyAudit(shape.taskId, h.deps);
    expect(result).toMatchObject({
      status: 'blocked', reason: 'automatic audit requires validation passed for the exact current revision',
    });
    h.assertNothingMaterialized();
  });

  it.each(refused)('boot sweep refuses %s', async (_label, taskStamp, ownerStamp) => {
    __resetSupervisionConvergenceTickForTests();
    const shape = validatedPredecessor(`freeze-sweep-${String(taskStamp)}-${String(ownerStamp)}`);
    stampValidation(shape.database, shape.taskId, shape.worker.assignmentId, taskStamp, ownerStamp, {
      taskStatus: 'ready_for_audit', ownerStatus: 'ready_for_audit', revision: R2,
    });
    const h = harness(shape.registry, shape.taskId, R2);
    const audits = await dispatchReadyAuditSweep(h.deps);
    expect(audits, 'the sweep selects the successor and refuses it at the boundary').toEqual([
      expect.objectContaining({
        status: 'blocked', reason: 'automatic audit requires validation passed for the exact current revision',
      }),
    ]);
    h.assertNothingMaterialized();
  });

  it('dispatches exactly when task and owner both attest the current revision (live and sweep)', async () => {
    const live = validatedPredecessor('freeze-exact-live');
    stampValidation(live.database, live.taskId, live.worker.assignmentId, R2, R2, {
      taskStatus: 'ready_for_audit', ownerStatus: 'ready_for_audit', revision: R2,
    });
    const liveHarness = harness(live.registry, live.taskId, R2);
    await expect(dispatchReadyAudit(live.taskId, liveHarness.deps))
      .resolves.toMatchObject({ status: 'dispatched', attemptId: automaticAttempt(live.taskId, R2) });

    __resetSupervisionConvergenceTickForTests();
    const swept = validatedPredecessor('freeze-exact-sweep');
    stampValidation(swept.database, swept.taskId, swept.worker.assignmentId, R2, R2, {
      taskStatus: 'ready_for_audit', ownerStatus: 'ready_for_audit', revision: R2,
    });
    const sweepHarness = harness(swept.registry, swept.taskId, R2);
    const audits = await dispatchReadyAuditSweep(sweepHarness.deps);
    expect(audits).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'dispatched' })]));
  });

  it('projects the audit artifact onto assignment scope before composing the immutable handoff', async () => {
    const shape = validatedPredecessor('freeze-scope-projection');
    stampValidation(shape.database, shape.taskId, shape.worker.assignmentId, R2, R2, {
      taskStatus: 'ready_for_audit', ownerStatus: 'ready_for_audit', revision: R2,
    });
    const h = harness(shape.registry, shape.taskId, R2, {
      snapshotFiles: [
        { path: 'src/exact.ts', sha256: '1'.repeat(64) },
        { path: 'native/windows/unclaimed.ps1', sha256: '2'.repeat(64) },
      ],
    });
    await expect(dispatchReadyAudit(shape.taskId, h.deps))
      .resolves.toMatchObject({ status: 'dispatched' });
    const auditCall = h.dispatch.mock.calls.find((call) => Boolean(call[1].audit));
    expect(auditCall?.[1].message).toContain('- src/exact.ts');
    expect(auditCall?.[1].message).not.toContain('native/windows/unclaimed.ps1');
  });

  it('carries the current scopeFiles, the configured blocking severities and every definition in the audit brief', async () => {
    const shape = validatedPredecessor('brief-scope-and-severity');
    // touchedFiles is non-empty and differs from the durable scope: the brief must
    // still list the whole current scope, including an unchanged scoped path.
    expect(shape.registry.recordFileEvent({
      assignmentId: shape.worker.assignmentId, path: 'test/exact.test.ts', operation: 'modify',
      identity: identity('deck_alpha_worker'),
    })).toMatchObject({ ok: true });
    expect(shape.registry.get(shape.taskId)?.touchedFiles.length).toBeGreaterThan(0);
    stampValidation(shape.database, shape.taskId, shape.worker.assignmentId, R2, R2, {
      taskStatus: 'ready_for_audit', ownerStatus: 'ready_for_audit', revision: R2,
    });
    const scopeFiles = shape.registry.getAssignment(shape.worker.assignmentId)!.scopeFiles;
    expect(scopeFiles).toEqual(expect.arrayContaining(['src/exact.ts', 'test/exact.test.ts']));
    const h = harness(shape.registry, shape.taskId, R2);
    const brain = h.deps.listSessions().find((candidate) => candidate.role === 'brain')!;
    const supervision = normalizeSessionSupervisionSnapshot({
      ...((brain.transportConfig as { supervision?: object } | undefined)?.supervision ?? { mode: 'supervised_audit' }),
      auditBlockingSeverities: ['P2', 'P0'],
    });
    brain.transportConfig = { ...(brain.transportConfig ?? {}), supervision };
    await expect(dispatchReadyAudit(shape.taskId, h.deps)).resolves.toMatchObject({ status: 'dispatched' });
    const message = String(h.dispatch.mock.calls.find((call) => Boolean(call[1].audit))?.[1].message);
    expect(message).toContain('Blocking severities (current configuration): P0, P2.');
    expect(message).toContain('Non-blocking severities: P1, P3, P4.');
    for (const level of AUDIT_SEVERITY_LEVELS) {
      expect(message).toContain(`- ${level}: ${AUDIT_SEVERITY_DEFINITIONS[level]}`);
    }
    const scopeSection = message.slice(message.indexOf('Assignment scopeFiles (current durable scope):'));
    for (const file of scopeFiles) expect(scopeSection).toContain(`- ${file}`);
  });

  it('defaults a legacy Brain snapshot without the setting to P0-only in the audit brief', async () => {
    const shape = validatedPredecessor('brief-legacy-severity');
    stampValidation(shape.database, shape.taskId, shape.worker.assignmentId, R2, R2, {
      taskStatus: 'ready_for_audit', ownerStatus: 'ready_for_audit', revision: R2,
    });
    const h = harness(shape.registry, shape.taskId, R2);
    await expect(dispatchReadyAudit(shape.taskId, h.deps)).resolves.toMatchObject({ status: 'dispatched' });
    const message = String(h.dispatch.mock.calls.find((call) => Boolean(call[1].audit))?.[1].message);
    expect(message).toContain('Blocking severities (current configuration): P0.');
    expect(message).toContain('Non-blocking severities: P1, P2, P3, P4.');
    expect(message).toContain('Assignment scopeFiles (current durable scope):\n- src/exact.ts');
  });

  const revoke = (registry: SupervisionTaskRegistry, taskId: string, assignmentId: string) => () => {
    expect(registry.applyTaskIntent({ expectedRevision: (registry.getTaskRecord(taskId)?.currentRevision ?? SUPERVISION_UNBOUND_REVISION),
      taskId, assignmentId, intent: 'record_validation', toStatus: null, validationState: 'failed',
    })).toMatchObject({ ok: true });
  };

  function exactReady(taskId: string) {
    const shape = validatedPredecessor(taskId);
    stampValidation(shape.database, shape.taskId, shape.worker.assignmentId, R2, R2, {
      taskStatus: 'ready_for_audit', ownerStatus: 'ready_for_audit', revision: R2,
    });
    return shape;
  }

  it.each(['live', 'boot sweep'] as const)(
    '%s: validation revoked while the worktree is inspected/frozen materializes nothing',
    async (path) => {
      __resetSupervisionConvergenceTickForTests();
      const shape = exactReady(`freeze-revoke-inspect-${path.replace(' ', '-')}`);
      const h = harness(shape.registry, shape.taskId, R2, {
        onInspect: revoke(shape.registry, shape.taskId, shape.worker.assignmentId),
      });
      const results = path === 'live'
        ? [await dispatchReadyAudit(shape.taskId, h.deps)]
        : await dispatchReadyAuditSweep(h.deps);
      expect(results).toEqual([expect.objectContaining({
        status: 'blocked', reason: 'automatic audit requires validation passed for the exact current revision',
      })]);
      expect(h.inspect).toHaveBeenCalledTimes(1);
      // Refused right after the freeze step: no auditor target is even selected/claimed.
      expect(h.listTargets, 'no auditor selection after revocation').not.toHaveBeenCalled();
      expect(h.dispatch.mock.calls.some((call) => Boolean(call[1].audit)), 'no audit delivery').toBe(false);
      expect(shape.registry.listAssignments(shape.taskId).filter((a) => a.role === 'auditor')).toEqual([]);
      expect(shape.registry.getTaskRecord(shape.taskId)!.integrationBundle).toBeUndefined();
      expect(shape.registry.getAssignment(shape.worker.assignmentId)!.auditAttemptId).toBeUndefined();
    },
  );

  it.each(['live', 'boot sweep'] as const)(
    '%s: validation revoked during auditor selection is refused before any delivery',
    async (path) => {
      __resetSupervisionConvergenceTickForTests();
      const shape = exactReady(`freeze-revoke-select-${path.replace(' ', '-')}`);
      const h = harness(shape.registry, shape.taskId, R2, {
        onListTargets: revoke(shape.registry, shape.taskId, shape.worker.assignmentId),
      });
      const results = path === 'live'
        ? [await dispatchReadyAudit(shape.taskId, h.deps)]
        : await dispatchReadyAuditSweep(h.deps);
      expect(results).toEqual([expect.objectContaining({
        status: 'blocked', reason: 'automatic audit requires validation passed for the exact current revision',
      })]);
      expect(h.listTargets).toHaveBeenCalled();
      expect(h.dispatch.mock.calls.some((call) => Boolean(call[1].audit)), 'nothing delivered').toBe(false);
      expect(shape.registry.listAssignments(shape.taskId).filter((a) => a.role === 'auditor')).toEqual([]);
    },
  );

  it.each(['live', 'boot sweep'] as const)(
    '%s: validation revoked after the last check refuses auditor/attempt materialization under lock',
    async (path) => {
      __resetSupervisionConvergenceTickForTests();
      const shape = exactReady(`freeze-revoke-dispatch-${path.replace(' ', '-')}`);
      const h = harness(shape.registry, shape.taskId, R2, {
        onAuditDispatch: revoke(shape.registry, shape.taskId, shape.worker.assignmentId),
      });
      const results = path === 'live'
        ? [await dispatchReadyAudit(shape.taskId, h.deps)]
        : await dispatchReadyAuditSweep(h.deps);
      expect(results).toEqual([expect.objectContaining({
        status: 'blocked', reason: 'task registry rejected assignment: stale_audit_revision',
      })]);
      const auditCall = h.dispatch.mock.calls.find((call) => Boolean(call[1].audit));
      expect(auditCall?.[1].internalAuditValidationAuthority, 'the authority snapshot is carried').toEqual(expect.any(String));
      expect(shape.registry.listAssignments(shape.taskId).filter((a) => a.role === 'auditor')).toEqual([]);
      expect(shape.registry.getAssignment(shape.worker.assignmentId)!.auditAttemptId).toBeUndefined();
    },
  );

  it('replays an already-dispatched exact audit without minting a second auditor (replay control)', async () => {
    const shape = exactReady('freeze-exact-replay');
    const h = harness(shape.registry, shape.taskId, R2);
    await expect(dispatchReadyAudit(shape.taskId, h.deps)).resolves.toMatchObject({ status: 'dispatched' });
    await expect(dispatchReadyAudit(shape.taskId, h.deps)).resolves.toMatchObject({ status: 'replayed' });
    expect(shape.registry.listAssignments(shape.taskId).filter((a) => a.role === 'auditor')).toHaveLength(1);
  });

  it('keeps legacy unstamped compatibility only without any successor transition evidence', async () => {
    const shape = validatedPredecessor('freeze-legacy-no-successor');
    stampValidation(shape.database, shape.taskId, shape.worker.assignmentId, undefined, undefined, {
      taskStatus: 'ready_for_audit', ownerStatus: 'ready_for_audit',
    });
    const h = harness(shape.registry, shape.taskId, R1);
    await expect(dispatchReadyAudit(shape.taskId, h.deps))
      .resolves.toMatchObject({ status: 'dispatched', attemptId: automaticAttempt(shape.taskId, R1) });
  });

  it('the real send path refuses to materialize an auditor from a revoked authority snapshot', async () => {
    const registry = getSupervisionTaskRegistry();
    const { taskId, revision, worker } = makeReadyTask({
      taskId: 'send-path-authority', revision: 'send-path-authority-r1',
      auditPolicy: 'auto_strict_cross_vendor', registry,
    });
    const brain = session('deck_alpha_brain', 'brain');
    brain.transportConfig = {
      supervision: normalizeSessionSupervisionSnapshot({
        mode: 'supervised_audit', executionPools: { state: 'legacy_unconfigured' },
      }),
    };
    const implementer = session('deck_alpha_worker', 'w1');
    const auditor = session('deck_alpha_exact_route', 'w2', 'claude-code-sdk', 'anthropic');
    const attemptId = automaticAttempt(taskId, revision);
    const dispatchMessage = vi.fn().mockResolvedValue({ status: 'queued' });
    const authority = registry.readyAuditValidationAuthoritySnapshot({
      taskId, assignmentId: worker.assignmentId, revision, allowLegacy: true,
    });
    expect(authority).toEqual(expect.any(String));
    const input = (key: string, snapshot: string | undefined): SendMessageInput => ({
      target: auditor.name,
      message: 'automatic audit',
      reply: true,
      idempotencyKey: key,
      newWorkload: true,
      internalAuditValidationAuthority: snapshot,
      audit: {
        kind: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
        attemptId, auditedSessionName: implementer.name, strictCrossVendor: true,
      },
      task: {
        taskId, currentRevision: revision, auditRevision: revision, auditAttemptId: attemptId,
        auditPolicy: 'auto_strict_cross_vendor', executionPool: 'primary',
      },
    });
    const deps = {
      listSessions: () => [brain, implementer, auditor],
      dispatchMessage,
      ensureSupervisionAssignmentWorktree: async ({ assignmentId }: { assignmentId: string }) => ({
        ok: true as const, worktreePath: `/tmp/${assignmentId}/repo`, baseRevision: undefined,
      }),
    };
    const caller = { userId: brain.name, sessionName: brain.name, projectName: 'alpha', projectRoot: '/work/alpha' };
    // Same production shape as the exact no_selected_config recovery: the
    // automatic route recorded its durable routing blocker first.
    let blockerDelivered = false;
    await expect(dispatchReadyAudit(taskId, {
      registry,
      listSessions: () => [brain, implementer, auditor],
      listTargets: listTargetRecords(),
      dispatch: vi.fn(async (_c: SendRuntimeCaller, sent: SendMessageInput) => {
        if (sent.audit) {
          return {
            status: 'error' as const,
            reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
            error: 'supervision target provisioning blocked: no_selected_config',
          };
        }
        blockerDelivered = true;
        return {
          status: 'accepted' as const,
          dispatchId: 'send_dispatch_00000000-0000-4000-8000-0000000000e5' as const,
          messageId: sent.internalMessageId!,
          deliveries: [{ target: brain.name, status: 'queued' as const }],
        };
      }),
      hasDeliveryEvidence: () => blockerDelivered,
    })).resolves.toMatchObject({ status: 'blocked' });

    // A snapshot that no longer matches the durable authority (here: the owner
    // stamp it rested on differs from the locked row) must mint nothing, even
    // though every other recovery gate still passes.
    const moved = JSON.parse(authority!) as { owner: { validatedRevision: string | null } };
    moved.owner.validatedRevision = `${revision}-predecessor`;
    const refused = await dispatchSendMessage(caller, input('send-path-authority-moved', JSON.stringify(moved)), deps);
    expect(refused).toMatchObject({ status: 'error', error: expect.stringContaining('stale_audit_revision') });
    expect(registry.listAssignments(taskId).filter((item) => item.role === 'auditor')).toEqual([]);
    expect(dispatchMessage).not.toHaveBeenCalled();

    // Positive control: the exact current snapshot materializes one auditor.
    const fresh = registry.readyAuditValidationAuthoritySnapshot({
      taskId, assignmentId: worker.assignmentId, revision, allowLegacy: true,
    });
    expect(fresh).toBe(authority);
    const accepted = await dispatchSendMessage(caller, input('send-path-authority-fresh', fresh), deps);
    expect(accepted, JSON.stringify(accepted)).toMatchObject({ status: 'accepted', taskId });
    expect(registry.listAssignments(taskId).filter((item) => item.role === 'auditor')).toHaveLength(1);
  });
});
