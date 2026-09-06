import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const live = vi.hoisted(() => ({ sessions: [] as Array<Record<string, unknown>> }));
vi.mock('../../src/store/session-store.js', () => ({
  listSessions: () => live.sessions,
  getSession: (name: string) => live.sessions.find((session) => session.name === name),
  upsertSession: () => undefined,
}));

import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { normalizeSessionSupervisionSnapshot } from '../../shared/supervision-config.js';
import { buildSupervisionExecutionCapabilityId } from '../../shared/supervision-execution-pool.js';
import { SUPERVISION_MCP_TOOLS } from '../../shared/supervision-mcp-tools.js';
import type { SessionRecord } from '../../src/store/session-store.js';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';
import { submitPeerAuditReply, clearPeerAuditReplyIngressRateLimits } from '../../src/daemon/peer-audit-reply-ingress.js';
import '../../src/daemon/delegation-reply-ingress.js';
import {
  clearSendIdempotencyCacheForTests,
  dispatchReadyAudit,
  dispatchReadyIntegration,
  dispatchSendMessage,
  runSupervisionConvergenceTick,
  __resetSupervisionConvergenceTickForTests,
  type SendMessageInput,
  type SendRuntimeCaller,
} from '../../src/daemon/send-tool.js';
import { createSupervisionMcpToolDeps, createSupervisionRegistryPort } from '../../src/daemon/supervision-registry-port.js';
import { createSupervisionMcpToolHandlers } from '../../src/daemon/supervision-mcp-tools.js';
import { resolveSupervisionAssignmentWorktree } from '../../src/daemon/supervision-worktree-inspector.js';
import {
  getSupervisionTaskRegistry,
  resetSupervisionTaskRegistryForTests,
} from '../../src/daemon/supervision-state-store.js';
import { resetDelegationReplyStoreForTests } from '../../src/daemon/delegation-reply-store.js';
import { resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function session(
  name: string,
  role: SessionRecord['role'],
  projectDir: string,
  agentType: SessionRecord['agentType'],
): SessionRecord {
  return {
    name,
    sessionInstanceId: `instance-${name}`,
    runtimeEpoch: `epoch-${name}`,
    projectName: 'alpha',
    role,
    agentType,
    projectDir,
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 2,
    requestedModel: agentType === 'claude-code-sdk' ? 'claude-sonnet-4-6' : 'gpt-5.6-sol',
    activeModel: agentType === 'claude-code-sdk' ? 'claude-sonnet-4-6' : 'gpt-5.6-sol',
    runtimeType: 'transport',
    ...(role === 'brain' ? {} : { parentSession: 'deck_alpha_brain', userCreated: true, label: name }),
  } as SessionRecord;
}

function targetDirectory(auditor: SessionRecord) {
  return () => ({
    status: 'ok' as const,
    executionPoolsState: 'configured' as const,
    appliedExecutionPool: 'primary' as const,
    items: [{
      target: auditor.name,
      label: auditor.label ?? null,
      sessionName: auditor.name,
      role: auditor.role,
      agentType: auditor.agentType,
      status: auditor.state,
      lastActiveAt: auditor.updatedAt,
      providerFamily: 'anthropic',
      availability: 'ready' as const,
      eligiblePools: ['primary' as const],
      dispatchMode: 'new_work' as const,
      limitGroup: 'claude' as const,
      replyCapable: true,
    }],
  });
}

function createRepo() {
  const root = mkdtempSync(join(tmpdir(), 'imcodes-supervision-e2e-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const remote = join(root, 'remote.git');
  execFileSync('mkdir', ['-p', repo]);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'IM.codes E2E');
  git(repo, 'config', 'user.email', 'e2e@im.codes');
  writeFileSync(join(repo, 'README.md'), '# E2E fixture\n');
  git(repo, 'add', '--', 'README.md');
  git(repo, 'commit', '-qm', 'initial');
  git(repo, 'branch', '-M', 'dev');
  git(root, 'init', '--bare', '-q', remote);
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-qu', 'origin', 'dev');
  return { root, repo, remote, base: git(repo, 'rev-parse', 'HEAD') };
}

function configureSessions(repo: string) {
  const brain = session('deck_alpha_brain', 'brain', repo, 'codex-sdk');
  const worker = session('deck_alpha_w1', 'w1', repo, 'codex-sdk');
  const auditor = session('deck_alpha_w2', 'w2', repo, 'claude-code-sdk');
  const openai = {
    agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport' as const, model: 'gpt-5.6-sol',
  };
  const anthropic = {
    agentType: 'claude-code-sdk', providerFamily: 'anthropic', runtimeType: 'transport' as const, model: 'claude-sonnet-4-6',
  };
  brain.transportConfig = {
    supervision: normalizeSessionSupervisionSnapshot({
      mode: 'supervised_audit',
      auditTargetSessionName: auditor.name,
      executionPools: {
        state: 'configured',
        primaryDevelopmentPool: {
          configs: [openai, anthropic].map((config) => ({
            ...config, capabilityId: buildSupervisionExecutionCapabilityId(config),
          })),
          controls: { maxSpawned: 2 },
        },
        economyTaskPool: { configs: [], controls: { maxSpawned: 0 } },
      },
    }),
  };
  live.sessions = [brain, worker, auditor] as Array<Record<string, unknown>>;
  return { brain, worker, auditor, sessions: [brain, worker, auditor] };
}

function caller(record: SessionRecord): SendRuntimeCaller {
  return {
    userId: record.name,
    sessionName: record.name,
    projectName: 'alpha',
    projectRoot: record.projectDir,
  };
}

beforeEach(() => {
  resetSupervisionTaskRegistryForTests();
  resetDelegationReplyStoreForTests();
  resetTransportQueueStoreForTests();
  clearSendIdempotencyCacheForTests();
  clearPeerAuditReplyIngressRateLimits();
  __resetSupervisionConvergenceTickForTests();
});

afterEach(() => {
  resetSupervisionTaskRegistryForTests();
  resetDelegationReplyStoreForTests();
  resetTransportQueueStoreForTests();
  delete process.env.IMCODES_WORKTREES_ROOT;
  delete process.env.IMCODES_SUPERVISION_BUNDLES_ROOT;
  live.sessions = [];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('E2E: automatic supervision progression lifecycle', () => {
  it('runs README implementation -> immutable freeze -> one cross-vendor audit -> PASS -> integration -> commit/push -> finalized', async () => {
    const shape = createRepo();
    process.env.IMCODES_WORKTREES_ROOT = join(shape.root, 'worktrees');
    process.env.IMCODES_SUPERVISION_BUNDLES_ROOT = join(shape.root, 'bundles');
    const { brain, worker, auditor, sessions } = configureSessions(shape.repo);
    const delivered = vi.fn().mockResolvedValue('queued');
    const send = (from: SendRuntimeCaller, input: SendMessageInput) => dispatchSendMessage(from, input, {
      listSessions: () => sessions,
      dispatchMessage: delivered,
      exactTargetOnly: true,
    });

    const created = await send(caller(brain), {
      target: worker.name,
      message: 'Add one meaningful README sentence and validate it.',
      reply: true,
      idempotencyKey: 'e2e-readme-lifecycle',
      task: {
        classification: 'independent_top_level',
        objective: 'exercise the complete automatic supervision lifecycle',
        acceptance: ['one strict cross-vendor audit', 'exact PASS bytes are committed and pushed'],
        ownedFiles: ['README.md'],
        baseRevision: shape.base,
        auditPolicy: 'auto_strict_cross_vendor',
      },
    });
    expect(created).toMatchObject({ status: 'accepted', taskId: expect.any(String), assignmentId: expect.any(String) });
    if (created.status !== 'accepted' || !created.taskId || !created.assignmentId) throw new Error('task dispatch failed');

    const registry = getSupervisionTaskRegistry();
    const worktree = resolveSupervisionAssignmentWorktree({
      sessionName: worker.name, assignmentId: created.assignmentId,
    });
    writeFileSync(join(worktree, 'README.md'), '# E2E fixture\n\nAutomatic supervision progresses exact validated work.\n');
    const revision = `readme-e2e-r1-${createHash('sha256').update(readFileSync(join(worktree, 'README.md'))).digest('hex').slice(0, 12)}`;

    const workerMemory = createMemoryMcpToolHandlers(caller(worker), {
      sendDeps: { listSessions: () => sessions },
    });
    await expect(workerMemory[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_UPDATE]({
      assignmentId: created.assignmentId, revision, verdict: 'IMPLEMENTATION_COMPLETE',
    })).resolves.toMatchObject({ status: 'ok' });

    const auditDispatch = (taskId: string) => dispatchReadyAudit(taskId, {
      registry,
      listSessions: () => sessions,
      listTargets: targetDirectory(auditor),
      dispatch: send,
      hasDeliveryEvidence: () => false,
    });
    const workerIntent = createSupervisionMcpToolHandlers(
      // Deliberately omit projectName: the production resolver must supply it.
      { sessionName: worker.name } as never,
      {
        ...createSupervisionMcpToolDeps(),
        registry: createSupervisionRegistryPort(),
        dispatchReadyAudit: auditDispatch,
      },
    );
    await expect(workerIntent[SUPERVISION_MCP_TOOLS.INTENT]({
      intent: 'start', taskId: created.taskId, assignmentId: created.assignmentId,
    })).resolves.toMatchObject({ status: 'ok', toStatus: 'implementing' });
    await expect(workerIntent[SUPERVISION_MCP_TOOLS.INTENT]({
      intent: 'record_validation', validationState: 'passed',
      taskId: created.taskId, assignmentId: created.assignmentId,
    })).resolves.toMatchObject({ status: 'ok', toStatus: 'ready_for_audit' });

    const afterValidation = registry.get(created.taskId)!;
    expect(afterValidation.integrationBundle).toMatchObject({
      taskId: created.taskId, sourceAssignmentId: created.assignmentId, revision,
      files: [{ path: 'README.md', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }],
    });
    let auditors = registry.listAssignments(created.taskId).filter((assignment) => assignment.role === 'auditor');
    expect(auditors).toHaveLength(1);
    const auditAssignment = auditors[0]!;
    expect(auditAssignment.identity.providerFamily).toBe('anthropic');
    expect(auditAssignment.auditRevision).toBe(revision);

    // Replaying the event and the periodic sweep must reuse the same auditor.
    await expect(auditDispatch(created.taskId)).resolves.toMatchObject({ status: 'replayed' });
    await runSupervisionConvergenceTick({
      registry, listSessions: () => sessions, listTargets: targetDirectory(auditor),
      dispatch: send, hasDeliveryEvidence: () => true,
    });
    auditors = registry.listAssignments(created.taskId).filter((assignment) => assignment.role === 'auditor');
    expect(auditors).toHaveLength(1);

    const auditorMemory = createMemoryMcpToolHandlers(caller(auditor), {
      sendDeps: { listSessions: () => sessions },
      peerAuditReply: (envelope) => submitPeerAuditReply({
        rawBody: JSON.stringify(envelope), senderSessionName: auditor.name, now: Date.now(),
      }) as never,
    });
    const passReply = await auditorMemory[MEMORY_MCP_TOOL_NAMES.PEER_AUDIT_REPLY]({
      taskId: created.taskId,
      assignmentId: auditAssignment.assignmentId,
      attemptId: auditAssignment.auditAttemptId,
      revision,
      receiptKind: 'final',
      verdict: 'PASS',
      findings: 'README bytes and lifecycle evidence verified.',
      validations: [{ kind: 'test', label: 'README lifecycle E2E', outcome: 'passed', summary: 'Exact frozen README bytes passed.' }],
    });
    expect(passReply, JSON.stringify(passReply)).toMatchObject({ status: 'ok' });
    expect(registry.get(created.taskId)).toMatchObject({ status: 'ready_for_integration' });
    expect(registry.getAssignment(created.assignmentId)).toMatchObject({
      status: 'ready_for_integration', verdict: 'PASS', crossVendorAuditPassed: true,
      auditRevision: revision, auditAttemptId: auditAssignment.auditAttemptId,
    });

    const integration = await dispatchReadyIntegration(created.taskId, {
      registry, listSessions: () => sessions, dispatch: send, hasDeliveryEvidence: () => false,
    });
    expect(integration).toMatchObject({ status: 'dispatched', assignmentId: expect.any(String) });
    if (integration.status !== 'dispatched') throw new Error(`integration dispatch failed: ${integration.status}`);
    const owner = registry.getAssignment(integration.assignmentId)!;
    expect(owner).toMatchObject({
      role: 'integration_owner', status: 'ready_for_integration', verdict: 'PASS',
      auditRevision: revision, auditAttemptId: auditAssignment.auditAttemptId,
    });
    expect(registry.listAssignments(created.taskId).filter((assignment) => assignment.role === 'integration_owner')).toHaveLength(1);

    const integrationWorktree = resolveSupervisionAssignmentWorktree({
      sessionName: brain.name, assignmentId: owner.assignmentId,
    });
    expect(readFileSync(join(integrationWorktree, 'README.md'), 'utf8')).toContain('Automatic supervision progresses');
    git(integrationWorktree, 'config', 'user.name', 'IM.codes E2E');
    git(integrationWorktree, 'config', 'user.email', 'e2e@im.codes');
    git(integrationWorktree, 'add', '--', 'README.md');
    git(integrationWorktree, 'commit', '-qm', 'docs: e2e automatic supervision');
    const commitSha = git(integrationWorktree, 'rev-parse', 'HEAD');
    git(integrationWorktree, 'push', '-q', 'origin', 'HEAD:refs/heads/e2e-delivery');
    expect(git(shape.remote, 'rev-parse', 'refs/heads/e2e-delivery')).toBe(commitSha);

    const bundle = registry.getTaskRecord(created.taskId)!.integrationBundle!;
    const brainMemory = createMemoryMcpToolHandlers(caller(brain), {
      sendDeps: { listSessions: () => sessions },
    });
    const finalization = {
      assignmentId: owner.assignmentId,
      revision,
      auditAttemptId: auditAssignment.auditAttemptId,
      auditRevision: revision,
      verdict: 'PASS',
      ownedFiles: ['README.md'],
      integrationManifest: bundle.files.flatMap((file) => file.deleted || !file.sha256 ? [] : [{ path: file.path, sha256: file.sha256 }]),
      integrationOwner: brain.name,
      commitSha,
      pushResult: 'pushed',
      pushRemoteRef: 'refs/heads/e2e-delivery',
      stagedPaths: ['README.md'],
      conflictedPaths: [],
      untrackedOtherOwnerPaths: [],
      ciResult: 'ci_not_configured',
      evidence: 'local bare-remote push verified',
    } as const;
    await expect(brainMemory[MEMORY_MCP_TOOL_NAMES.SUPERVISION_INTEGRATION_FINALIZE](finalization))
      .resolves.toMatchObject({ status: 'ok', idempotentReplay: false, item: { status: 'finalized', commitSha } });
    await expect(brainMemory[MEMORY_MCP_TOOL_NAMES.SUPERVISION_INTEGRATION_FINALIZE](finalization))
      .resolves.toMatchObject({ status: 'ok', idempotentReplay: true, item: { status: 'finalized', commitSha } });
    expect(registry.list({ projectName: 'alpha' }).some((task) => task.taskId === created.taskId)).toBe(false);
    expect(registry.list({ projectName: 'alpha', history: true })).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: created.taskId, status: 'finalized', pushRemoteRef: 'refs/heads/e2e-delivery' }),
    ]));
    expect(registry.listAssignments(created.taskId).every((assignment) => assignment.leaseId === '')).toBe(true);
    expect(registry.listFileClaims(created.taskId)).toEqual([]);
    expect(await auditDispatch(created.taskId)).toMatchObject({ status: 'ignored' });
  });

  it('routes REWORK back to the same implementer and resumes without creating a replacement object', async () => {
    const shape = createRepo();
    process.env.IMCODES_WORKTREES_ROOT = join(shape.root, 'worktrees');
    process.env.IMCODES_SUPERVISION_BUNDLES_ROOT = join(shape.root, 'bundles');
    const { brain, worker, auditor, sessions } = configureSessions(shape.repo);
    const send = (from: SendRuntimeCaller, input: SendMessageInput) => dispatchSendMessage(from, input, {
      listSessions: () => sessions, dispatchMessage: vi.fn().mockResolvedValue('queued'), exactTargetOnly: true,
    });
    const registry = getSupervisionTaskRegistry();
    const created = await send(caller(brain), {
      target: worker.name, message: 'Implement then repair the README.', reply: true,
      idempotencyKey: 'e2e-readme-rework',
      task: {
        classification: 'independent_top_level', objective: 'exercise exact REWORK continuation',
        acceptance: ['REWORK returns to the same assignment'], ownedFiles: ['README.md'],
        baseRevision: shape.base, auditPolicy: 'auto_strict_cross_vendor',
      },
    });
    if (created.status !== 'accepted' || !created.taskId || !created.assignmentId) throw new Error('task dispatch failed');
    const worktree = resolveSupervisionAssignmentWorktree({ sessionName: worker.name, assignmentId: created.assignmentId });
    writeFileSync(join(worktree, 'README.md'), '# E2E fixture\n\nFirst attempt.\n');
    const revision = 'readme-rework-r1';
    const workerMemory = createMemoryMcpToolHandlers(caller(worker), { sendDeps: { listSessions: () => sessions } });
    await workerMemory[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_UPDATE]({
      assignmentId: created.assignmentId, revision, verdict: 'IMPLEMENTATION_COMPLETE',
    });
    const auditDispatch = (taskId: string) => dispatchReadyAudit(taskId, {
      registry, listSessions: () => sessions, listTargets: targetDirectory(auditor),
      dispatch: send, hasDeliveryEvidence: () => false,
    });
    const intent = createSupervisionMcpToolHandlers(caller(worker) as never, {
      ...createSupervisionMcpToolDeps(), registry: createSupervisionRegistryPort(), dispatchReadyAudit: auditDispatch,
    });
    await intent[SUPERVISION_MCP_TOOLS.INTENT]({ intent: 'start', taskId: created.taskId, assignmentId: created.assignmentId });
    await intent[SUPERVISION_MCP_TOOLS.INTENT]({
      intent: 'record_validation', validationState: 'passed', taskId: created.taskId, assignmentId: created.assignmentId,
    });
    const audit = registry.listAssignments(created.taskId).find((assignment) => assignment.role === 'auditor')!;
    const auditorMemory = createMemoryMcpToolHandlers(caller(auditor), {
      sendDeps: { listSessions: () => sessions },
      peerAuditReply: (envelope) => submitPeerAuditReply({
        rawBody: JSON.stringify(envelope), senderSessionName: auditor.name, now: Date.now(),
      }) as never,
    });
    const reworkReply = await auditorMemory[MEMORY_MCP_TOOL_NAMES.PEER_AUDIT_REPLY]({
      taskId: created.taskId, assignmentId: audit.assignmentId,
      attemptId: audit.auditAttemptId, revision, receiptKind: 'final', verdict: 'REWORK',
      findings: 'Add the missing operator-facing detail.',
      validations: [{ kind: 'test', label: 'README review', outcome: 'failed', summary: 'Detail is missing.' }],
    });
    expect(reworkReply, JSON.stringify(reworkReply)).toMatchObject({ status: 'ok' });
    expect(registry.get(created.taskId)).toMatchObject({ status: 'rework' });
    expect(registry.getAssignment(created.assignmentId)).toMatchObject({ status: 'rework', verdict: 'REWORK' });
    const assignmentIds = registry.listAssignments(created.taskId).map((assignment) => assignment.assignmentId);

    const resumed = await runSupervisionConvergenceTick({
      registry, listSessions: () => sessions, dispatch: send, hasDeliveryEvidence: () => false,
    });
    expect(resumed.reworks).toEqual([
      expect.objectContaining({ status: 'dispatched', assignmentId: created.assignmentId }),
    ]);
    expect(registry.getAssignment(created.assignmentId)).toMatchObject({ status: 'implementing' });
    expect(registry.listAssignments(created.taskId).map((assignment) => assignment.assignmentId)).toEqual(assignmentIds);
    expect(registry.listAssignments(created.taskId).filter((assignment) => assignment.role === 'implementer')).toHaveLength(1);
  });
});
