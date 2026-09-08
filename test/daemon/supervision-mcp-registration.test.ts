import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMemoryMcpServer } from '../../src/daemon/memory-mcp-server.js';
import {
  SUPERVISION_MCP_TOOLS, SUPERVISION_MCP_REGISTERED_TOOLS,
  SUPERVISION_MCP_PENDING_CONSOLIDATION, SUPERVISION_MCP_FORBIDDEN_ARG_NAMES,
} from '../../shared/supervision-mcp-tools.js';
import { MEMORY_MCP_TOOL_NAMES, MEMORY_MCP_TOOL_NAME_LIST } from '../../shared/memory-mcp-contracts.js';
import { MCP_TOOL_DISCOVERY_NAME } from '../../shared/mcp-tool-discovery.js';
import {
  createSupervisionMcpToolHandlers,
  type SupervisionRegistryPort,
} from '../../src/daemon/supervision-mcp-tools.js';
import { SUPERVISION_INTENTS } from '../../src/daemon/supervision-intent-ops.js';
import {
  SUPERVISION_BRAIN_COORDINATION_RECOVERY_STATUSES,
  SUPERVISION_RECOVERY_LEASE_ACTIONS,
  SUPERVISION_TASK_LIFECYCLE_STATUSES, SUPERVISION_TASK_RECOVERY_TARGET_STATUSES,
  SUPERVISION_TASK_REGISTRY_EVENT_TYPES,
} from '../../shared/supervision-config.js';
import { SUPERVISION_CONSOLE_VALIDATION_STATES } from '../../shared/supervision-task-console.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import { SupervisionTaskRegistry } from '../../src/daemon/supervision-state-store.js';

const CALLER = {
  userId: 'u1', serverId: 's1', projectName: 'codedeck',
  sessionName: 'deck_cd_brain', transport: 'stdio',
} as unknown as McpRuntimeCaller;

/**
 * Participation is an exact 5-field identity now, so the fake registry's rows and
 * the injected resolver must agree on the SAME identity for a given name.
 */
const testIdentity = (sessionName: string) => ({
  sessionName,
  sessionInstanceId: `instance-${sessionName}`,
  runtimeEpoch: `epoch-${sessionName}`,
  agentType: 'codex-sdk',
  providerFamily: 'openai',
});
const testResolveSessionIdentity = (sessionName: string) => ({
  ...testIdentity(sessionName), projectName: 'codedeck',
});

/** Records what the production dispatch actually reached. */
class FakeRegistry implements SupervisionRegistryPort {
  statuses = new Map<string, string>([['tsk_a', 'planned'], ['tsk_other', 'planned']]);
  classifications = new Map<string, string>([['tsk_a', 'integration_task'], ['tsk_other', 'integration_task']]);
  /** tsk_a belongs to the caller; tsk_other belongs to someone else. */
  participants = new Map<string, string[]>([
    ['tsk_a', ['deck_cd_brain']],
    ['tsk_other', ['deck_someone_else']],
  ]);
  assignmentStates = new Map<string, Array<{
    assignmentId: string; role: string; status: string; leaseId: string; auditAttemptId?: string;
    auditRevision?: string; verdict?: string; generation?: number;
    executionBinding?: any;
    identity: { sessionName: string; sessionInstanceId?: string; runtimeEpoch?: string; agentType?: string; providerFamily?: string };
  }>>();
  currentRevisions = new Map<string, string>();
  applied: any[] = [];
  recovered: any[] = [];
  rebound: any[] = [];
  orphanedAuditorRebound: any[] = [];
  implementerRebound: any[] = [];
  revisionRebound: any[] = [];
  coordinated: any[] = [];
  finished: any[] = [];
  housekeepingCalls: any[] = [];
  listCalls: any[] = [];
  item(taskId: string) {
    const explicit = this.assignmentStates.get(taskId);
    return {
      taskId,
      projectName: 'codedeck',
      classification: this.classifications.get(taskId),
      status: this.statuses.get(taskId),
      currentRevision: this.currentRevisions.get(taskId),
      assignments: explicit ?? (this.participants.get(taskId) ?? []).map((sessionName, index) => ({
        assignmentId: `${taskId}-assignment-${index}`,
        role: 'implementer', status: this.statuses.get(taskId) ?? 'planned', leaseId: 'lease',
        identity: testIdentity(sessionName),
      })),
    };
  }
  getStatus(taskId: string) { return this.statuses.get(taskId); }
  applyIntent(input: any) { this.applied.push(input); this.statuses.set(input.taskId, input.toStatus ?? this.statuses.get(input.taskId)!); }
  finishAssignment(input: any) {
    this.finished.push(input);
    return { ok: true as const, value: { assignmentId: input.assignmentId, status: 'ready_for_audit', leaseId: '' } };
  }
  list(filter: any) {
    this.listCalls.push(filter);
    // Mirrors the registry: an owner filter NARROWS, it does not authorize.
    return [...this.statuses.keys()]
      .filter((id) => !filter.ownerSessionName || (this.participants.get(id) ?? []).includes(filter.ownerSessionName))
      .map((id) => this.item(id));
  }
  get(taskId: string) { return this.statuses.has(taskId) ? this.item(taskId) : undefined; }
  recover(input: any) { this.recovered.push(input); this.statuses.set(input.taskId, input.toStatus); }
  rebindAuditAssignment(input: any) {
    this.rebound.push(input);
    return { ok: true as const, value: { assignmentId: input.assignmentId } };
  }
  recoverOrphanedDelegatedAuditor(input: any) {
    this.orphanedAuditorRebound.push(input);
    return { ok: true as const, value: { assignmentId: input.assignmentId } };
  }
  rebindValidatedImplementerAssignment(input: any) {
    this.implementerRebound.push(input);
    return { ok: true as const, value: { assignmentId: input.assignmentId } };
  }
  rebindTaskAssignmentRevision(input: any) {
    this.revisionRebound.push(input);
    this.currentRevisions.set(input.taskId, input.toRevision);
    const assignments = this.item(input.taskId).assignments.map((assignment) => (
      assignment.assignmentId === input.assignmentId
        ? {
          ...assignment,
          status: 'implementing',
          auditRevision: input.toRevision,
          auditAttemptId: undefined,
          verdict: undefined,
        }
        : assignment
    ));
    this.assignmentStates.set(input.taskId, assignments as NonNullable<ReturnType<FakeRegistry['item']>['assignments']> as never);
    return { ok: true as const, value: { taskId: input.taskId } };
  }
  coordinateTaskAssignment(input: any) {
    this.coordinated.push(input);
    return { ok: true as const, value: { taskId: input.taskId } };
  }
  housekeeping(input: any) {
    this.housekeepingCalls.push(input);
    return { mode: input.mode, scanned: 2, activeCount: 1, archivedCount: 1, actions: [] };
  }
}

let registry: FakeRegistry;
let client: Client;
let worktreeGcCalls: Array<Record<string, unknown>>;

async function connect(isAdmin = true) {
  registry = new FakeRegistry();
  worktreeGcCalls = [];
  const server = createMemoryMcpServer(CALLER, {}, {}, { resolveSessionIdentity: testResolveSessionIdentity, registry,
    isAdmin: () => isAdmin,
    worktreeGc: async (input) => {
      worktreeGcCalls.push(input);
      return {
        mode: input.mode,
        scanned: 1,
        deleted: 0,
        retained: 1,
        registryAvailable: true,
        entries: [{ assignmentId: 'assignment-a', action: 'retain', reason: 'unique_evidence' }],
      };
    },
  });
  client = new Client({ name: 'supervision-reg-test', version: '0.1.0' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientT), server.connect(serverT)]);
  await client.callTool({ name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: 'group:supervision' } });
}

async function call(name: string, args: Record<string, unknown>) {
  const res: any = await client.callTool({ name, arguments: args });
  return res.structuredContent as Record<string, unknown>;
}

beforeEach(async () => { await connect(); });

describe('production MCP registration', () => {
  it('publishes every supervision tool on the REAL server surface', async () => {
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name);
    for (const tool of SUPERVISION_MCP_REGISTERED_TOOLS) {
      expect(names, tool).toContain(tool);
    }
    const intent = listed.tools.find((tool) => tool.name === SUPERVISION_MCP_TOOLS.INTENT);
    expect(intent?.inputSchema).toMatchObject({
      properties: { rebindSessionName: { type: 'string' } },
    });
  });

  it('CONSOLIDATED: the legacy family no longer publishes list/get', async () => {
    // Post-merge: nothing is pending, and the legacy names are gone from the
    // memory contract list, so the audited handlers own them outright.
    expect(SUPERVISION_MCP_PENDING_CONSOLIDATION).toEqual([]);
    expect(Object.values(MEMORY_MCP_TOOL_NAMES)).not.toContain('supervision_task_list');
    expect(Object.values(MEMORY_MCP_TOOL_NAMES)).not.toContain('supervision_task_get');
    expect(MEMORY_MCP_TOOL_NAME_LIST as readonly string[]).not.toContain('supervision_task_list');
  });

  it('a duplicate legacy registration would CRASH server construction', () => {
    // Guards the collision that made this merge necessary: two registrations of
    // the same tool name throw at construction rather than silently shadowing.
    const server = createMemoryMcpServer(CALLER, {}, {}, { resolveSessionIdentity: testResolveSessionIdentity, registry, isAdmin: () => true });
    expect(() => (server as any).registerTool(
      SUPERVISION_MCP_TOOLS.LIST, { description: 'dup', inputSchema: {} }, async () => ({} as never),
    )).toThrow(/already registered/);
  });

  it('routes supervision_task_intent through dispatch into the audited store', async () => {
    const out = await call(SUPERVISION_MCP_TOOLS.INTENT, { intent: 'start', taskId: 'tsk_a' });
    expect(out).toMatchObject({ status: 'ok', intent: 'start', fromStatus: 'planned', toStatus: 'implementing' });
    // Proof it reached the store, not just a schema.
    expect(registry.applied).toEqual([{
      taskId: 'tsk_a', assignmentId: 'tsk_a-assignment-0', intent: 'start', toStatus: 'implementing',
      validationState: undefined, note: undefined,
    }]);
    expect(registry.statuses.get('tsk_a')).toBe('implementing');
  });

  it('keeps the audited list/get handlers reachable for the consolidation edit', () => {
    // Handler-level, not dispatch-level: the name is still owned by the legacy
    // registration, so this proves the audited implementation is ready without
    // pretending it is currently the production route.
    const handlers = createSupervisionMcpToolHandlers(CALLER, { resolveSessionIdentity: testResolveSessionIdentity, registry, isAdmin: () => true });
    expect(typeof handlers[SUPERVISION_MCP_TOOLS.LIST]).toBe('function');
    expect(typeof handlers[SUPERVISION_MCP_TOOLS.GET]).toBe('function');
  });

  it('makes a model-supplied status INERT through the real dispatch (layer 1: stripped)', async () => {
    // The published schema does not declare `status`, so the SDK's zod layer
    // strips it before dispatch. The request therefore succeeds as a plain
    // intent and the smuggled status has no effect whatsoever.
    const out = await call(SUPERVISION_MCP_TOOLS.INTENT, { intent: 'start', taskId: 'tsk_a', status: 'finalized' });
    expect(out).toMatchObject({ status: 'ok', toStatus: 'implementing' });
    expect(registry.statuses.get('tsk_a')).toBe('implementing');
    expect(registry.statuses.get('tsk_a')).not.toBe('finalized');
    // Nothing the model sent as `status` reached the store.
    expect(registry.applied).toEqual([{
      taskId: 'tsk_a', assignmentId: 'tsk_a-assignment-0', intent: 'start', toStatus: 'implementing',
      validationState: undefined, note: undefined,
    }]);
  });

  it('REJECTS a model-supplied status at the handler (layer 2: defence in depth)', async () => {
    // If a future schema change or a direct handler caller lets `status`
    // through, the audited state machine refuses it before any other check.
    const handlers = createSupervisionMcpToolHandlers(CALLER, { resolveSessionIdentity: testResolveSessionIdentity, registry, isAdmin: () => true });
    const out = await handlers[SUPERVISION_MCP_TOOLS.INTENT]({
      intent: 'start', taskId: 'tsk_a', status: 'finalized',
    });
    expect(out).toMatchObject({ status: 'error', reason: 'model_supplied_status' });
    expect(registry.applied).toEqual([]);
    expect(registry.statuses.get('tsk_a')).toBe('planned');
  });

  it('refuses an illegal transition through dispatch and leaves the store untouched', async () => {
    registry.statuses.set('tsk_a', 'finalized');
    const out = await call(SUPERVISION_MCP_TOOLS.INTENT, { intent: 'open_audit', taskId: 'tsk_a' });
    expect(out).toMatchObject({ status: 'error', reason: 'illegal_transition' });
    expect(registry.applied).toEqual([]);
  });

  it('uses assignment lifecycle for assignment-scoped recovery intents when the aggregate is stale', async () => {
    registry.statuses.set('tsk_a', 'ready_for_audit');
    registry.assignmentStates.set('tsk_a', [{
      assignmentId: 'rework-owner', role: 'integration_owner', status: 'rework', leaseId: '',
      identity: testIdentity('deck_cd_brain'),
    }]);

    const validation = await call(SUPERVISION_MCP_TOOLS.INTENT, {
      intent: 'record_validation', taskId: 'tsk_a', assignmentId: 'rework-owner',
      validationState: 'passed',
    });
    expect(validation).toMatchObject({
      status: 'ok', intent: 'record_validation', fromStatus: 'rework', toStatus: 'validated',
    });
    expect(registry.applied.at(-1)).toMatchObject({
      taskId: 'tsk_a', assignmentId: 'rework-owner', intent: 'record_validation',
      toStatus: 'validated', validationState: 'passed',
    });

    registry.statuses.set('tsk_a', 'ready_for_audit');
    registry.assignmentStates.set('tsk_a', [{
      assignmentId: 'rework-owner', role: 'integration_owner', status: 'validated', leaseId: '',
      identity: testIdentity('deck_cd_brain'),
    }]);
    const audit = await call(SUPERVISION_MCP_TOOLS.INTENT, {
      intent: 'open_audit', taskId: 'tsk_a', assignmentId: 'rework-owner',
    });
    expect(audit).toMatchObject({
      status: 'ok', intent: 'open_audit', fromStatus: 'validated', toStatus: 'ready_for_audit',
    });
  });

  it('runs automatic audit materialization only after a successful open_audit commit', async () => {
    const directRegistry = new FakeRegistry();
    directRegistry.statuses.set('tsk_a', 'validated');
    directRegistry.assignmentStates.set('tsk_a', [{
      assignmentId: 'worker-a', role: 'implementer', status: 'validated', leaseId: 'lease-a',
      identity: testIdentity('deck_cd_brain'),
    }]);
    const dispatchReadyAudit = vi.fn().mockResolvedValue({ status: 'dispatched' });
    const handlers = createSupervisionMcpToolHandlers(CALLER, {
      resolveSessionIdentity: testResolveSessionIdentity,
      registry: directRegistry,
      dispatchReadyAudit,
    });

    await expect(handlers[SUPERVISION_MCP_TOOLS.INTENT]({
      intent: 'open_audit', taskId: 'tsk_a', assignmentId: 'worker-a',
    })).resolves.toMatchObject({ status: 'ok', toStatus: 'ready_for_audit' });
    expect(directRegistry.applied).toHaveLength(1);
    expect(dispatchReadyAudit).toHaveBeenCalledOnce();
    expect(dispatchReadyAudit).toHaveBeenCalledWith('tsk_a');

    // A same-revision replay is a convergence event, not a second state
    // transition. The production handler must run the idempotent dispatcher
    // again so a durable delivery whose registry row was lost can be adopted.
    directRegistry.statuses.set('tsk_a', 'ready_for_audit');
    directRegistry.assignmentStates.set('tsk_a', [{
      assignmentId: 'worker-a', role: 'implementer', status: 'ready_for_audit', leaseId: '',
      identity: testIdentity('deck_cd_brain'),
    }]);
    await expect(handlers[SUPERVISION_MCP_TOOLS.INTENT]({
      intent: 'open_audit', taskId: 'tsk_a', assignmentId: 'worker-a',
    })).resolves.toMatchObject({
      status: 'ok', fromStatus: 'ready_for_audit', toStatus: 'ready_for_audit',
    });
    expect(dispatchReadyAudit).toHaveBeenCalledTimes(2);
    expect(dispatchReadyAudit).toHaveBeenLastCalledWith('tsk_a');

    directRegistry.statuses.set('tsk_a', 'finalized');
    directRegistry.assignmentStates.set('tsk_a', [{
      assignmentId: 'worker-a', role: 'implementer', status: 'finalized', leaseId: '',
      identity: testIdentity('deck_cd_brain'),
    }]);
    await expect(handlers[SUPERVISION_MCP_TOOLS.INTENT]({
      intent: 'open_audit', taskId: 'tsk_a', assignmentId: 'worker-a',
    })).resolves.toMatchObject({ status: 'error' });
    expect(dispatchReadyAudit).toHaveBeenCalledTimes(2);
  });

  it('carries the aggregate forward automatically after a successful implementer finish', async () => {
    // The finish COMMIT is the event that can leave a task ready for its next
    // automatic step. Both finish paths used to return immediately, so nothing
    // advanced the aggregate until the 60s implementation watchdog ran -- and a
    // restart in between widened that to the next boot sweep. Progress must be
    // driven by the event, not by polling. Deleting the wire fails this test.
    const directRegistry = new FakeRegistry();
    directRegistry.statuses.set('tsk_a', 'auditing');
    directRegistry.assignmentStates.set('tsk_a', [{
      assignmentId: 'worker-a', role: 'implementer', status: 'auditing', leaseId: 'lease-a',
      identity: testIdentity('deck_cd_brain'),
    }]);
    const dispatchReadyAudit = vi.fn().mockResolvedValue({ status: 'dispatched' });
    const handlers = createSupervisionMcpToolHandlers(CALLER, {
      resolveSessionIdentity: testResolveSessionIdentity,
      registry: directRegistry,
      dispatchReadyAudit,
    });

    await expect(handlers[SUPERVISION_MCP_TOOLS.INTENT]({
      intent: 'finish', taskId: 'tsk_a', assignmentId: 'worker-a',
    })).resolves.toMatchObject({ status: 'ok', intent: 'finish' });
    expect(directRegistry.finished, 'the finish itself must still commit').toHaveLength(1);
    expect(dispatchReadyAudit, 'finish must drive convergence without a Brain call')
      .toHaveBeenCalledOnce();
    expect(dispatchReadyAudit).toHaveBeenCalledWith('tsk_a');
  });

  it('never reports a finish as failed because downstream convergence threw', async () => {
    // The commit is authoritative. A convergence step that cannot run is the
    // dispatcher's problem (it owns a durable blocker report and the boot sweep
    // retries); it must never turn a committed finish into an error the caller
    // would retry into a second attempt.
    const directRegistry = new FakeRegistry();
    directRegistry.statuses.set('tsk_a', 'auditing');
    directRegistry.assignmentStates.set('tsk_a', [{
      assignmentId: 'worker-a', role: 'implementer', status: 'auditing', leaseId: 'lease-a',
      identity: testIdentity('deck_cd_brain'),
    }]);
    const dispatchReadyAudit = vi.fn().mockRejectedValue(new Error('transport down'));
    const handlers = createSupervisionMcpToolHandlers(CALLER, {
      resolveSessionIdentity: testResolveSessionIdentity,
      registry: directRegistry,
      dispatchReadyAudit,
    });

    await expect(handlers[SUPERVISION_MCP_TOOLS.INTENT]({
      intent: 'finish', taskId: 'tsk_a', assignmentId: 'worker-a',
    })).resolves.toMatchObject({ status: 'ok', intent: 'finish' });
    expect(dispatchReadyAudit).toHaveBeenCalledOnce();
  });

  it('refuses integration_slice open_audit at the production MCP handler before registry mutation', async () => {
    registry.classifications.set('tsk_a', 'integration_slice');
    registry.statuses.set('tsk_a', 'validated');
    registry.assignmentStates.set('tsk_a', [{
      assignmentId: 'slice-worker', role: 'implementer', status: 'validated', leaseId: 'slice-lease',
      identity: testIdentity('deck_cd_brain'),
    }]);
    const out = await call(SUPERVISION_MCP_TOOLS.INTENT, {
      intent: 'open_audit', taskId: 'tsk_a', assignmentId: 'slice-worker',
    });
    expect(out).toMatchObject({ status: 'error', reason: 'role_forbidden' });
    expect(registry.applied).toEqual([]);
    expect(registry.assignmentStates.get('tsk_a')).toHaveLength(1);
  });

  it('keeps a historical already-bound slice audit compatible without allowing a new auditor row', async () => {
    registry.classifications.set('tsk_a', 'integration_slice');
    registry.statuses.set('tsk_a', 'validated');
    registry.assignmentStates.set('tsk_a', [
      {
        assignmentId: 'slice-worker', role: 'implementer', status: 'validated', leaseId: 'slice-lease',
        identity: testIdentity('deck_cd_brain'),
      },
      {
        assignmentId: 'historical-auditor', role: 'auditor', status: 'auditing', leaseId: 'audit-lease',
        auditAttemptId: 'historical-attempt', identity: testIdentity('deck_historical_auditor'),
      },
    ]);
    const out = await call(SUPERVISION_MCP_TOOLS.INTENT, {
      intent: 'open_audit', taskId: 'tsk_a', assignmentId: 'slice-worker',
    });
    expect(out).toMatchObject({ status: 'ok', toStatus: 'ready_for_audit' });
    expect(registry.applied).toHaveLength(1);
    expect(registry.assignmentStates.get('tsk_a')).toHaveLength(2);
  });

  it('routes only a same-project Brain exact finish to auditor cleanup or same-session identity rebind', async () => {
    registry.statuses.set('tsk_a', 'validated');
    registry.assignmentStates.set('tsk_a', [
      {
        assignmentId: 'brain-coordinator', role: 'coordinator', status: 'delegated', leaseId: 'brain-lease',
        identity: testIdentity('deck_cd_brain'),
      },
      {
        assignmentId: 'drifted-worker', role: 'implementer', status: 'validated', leaseId: 'worker-lease',
        identity: testIdentity('deck_same_worker'),
      },
      {
        assignmentId: 'accepted-auditor', role: 'auditor', status: 'passed', leaseId: 'audit-lease',
        auditAttemptId: 'accepted-attempt', identity: testIdentity('deck_auditor'),
      },
    ]);
    const live = {
      sessionName: 'deck_same_worker', sessionInstanceId: 'new-instance', runtimeEpoch: 'new-epoch',
      agentType: 'codex-sdk', providerFamily: 'openai', projectName: 'codedeck',
    };
    const brain = createSupervisionMcpToolHandlers(CALLER, {
      registry,
      isProjectBrain: () => true,
      // The rebind target resolves to the LIVE replacement; every other name --
      // including the caller, who must be provably this task's coordinator --
      // resolves through the shared fixture resolver.
      resolveSessionIdentity: (name) => (name === live.sessionName ? live : testResolveSessionIdentity(name)),
    });
    expect(await brain[SUPERVISION_MCP_TOOLS.INTENT]({
      intent: 'finish', taskId: 'tsk_a', assignmentId: 'drifted-worker',
      rebindSessionName: live.sessionName,
    })).toMatchObject({ status: 'ok', toStatus: 'ready_for_audit' });
    expect(registry.finished.at(-1)).toEqual({
      assignmentId: 'drifted-worker', callerSessionName: 'deck_cd_brain', callerProjectName: 'codedeck',
      projectBrain: true,
      rebindIdentity: {
        sessionName: live.sessionName, sessionInstanceId: live.sessionInstanceId,
        runtimeEpoch: live.runtimeEpoch, agentType: live.agentType, providerFamily: live.providerFamily,
      },
      rebindProjectName: 'codedeck',
    });

    expect(await brain[SUPERVISION_MCP_TOOLS.INTENT]({
      intent: 'finish', taskId: 'tsk_a', assignmentId: 'accepted-auditor',
    })).toMatchObject({ status: 'ok' });
    expect(registry.finished.at(-1)).toEqual({
      assignmentId: 'accepted-auditor', callerSessionName: 'deck_cd_brain',
      callerProjectName: 'codedeck', projectBrain: true,
    });

    const before = registry.finished.length;
    registry.item = (taskId: string) => ({
      taskId, projectName: 'other-project', classification: 'integration_task', status: 'validated',
      assignments: registry.assignmentStates.get(taskId) ?? [],
    });
    expect(await brain[SUPERVISION_MCP_TOOLS.INTENT]({
      intent: 'finish', taskId: 'tsk_a', assignmentId: 'drifted-worker',
      rebindSessionName: live.sessionName,
    })).toMatchObject({ status: 'error', reason: 'identity_rejected' });
    expect(registry.finished).toHaveLength(before);
  });
});

describe('replacement implementer recovery through the real MCP server', () => {
  it.each(['start', 'claim'] as const)('advances one leased delegated replacement with %s under an already-implementing aggregate after SQLite reopen', async (intent) => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-replacement-implementer-'));
    const dbPath = join(dir, 'supervision-state.sqlite');
    const taskId = 'replacement-same-logical-task';
    const replacementId = 'replacement-implementer';
    // The caller must BE this identity to act on it now, so the fixture uses the
    // same deterministic identity the injected resolver returns for that name.
    const owner = testIdentity(CALLER.sessionName!);
    try {
      let actual = new SupervisionTaskRegistry({ dbPath });
      expect(actual.createOrGet({
        taskId, projectName: 'codedeck', classification: 'independent_top_level', objective: 'resume same task',
      }).ok).toBe(true);
      const old = actual.createAssignment({
        assignmentId: 'superseded-implementer', taskId, role: 'implementer', identity: owner,
        scopeFiles: ['src/a.ts'],
      });
      const replacement = actual.createAssignment({
        assignmentId: replacementId, taskId, role: 'implementer', identity: owner,
        scopeFiles: ['src/a.ts'],
      });
      if (!old.ok || !replacement.ok) throw new Error('fixture assignments failed');
      const replacementLease = replacement.value.leaseId;
      expect(actual.updateTask({ taskId, status: 'implementing' }).ok).toBe(true);
      expect(actual.applyTaskIntent({
        taskId, assignmentId: old.value.assignmentId, intent: 'cancel', toStatus: 'cancelled',
        note: 'superseded',
      })).toMatchObject({ ok: true });
      expect(actual.get(taskId)).toMatchObject({
        status: 'implementing',
        assignments: expect.arrayContaining([
          expect.objectContaining({ assignmentId: old.value.assignmentId, status: 'cancelled', leaseId: '' }),
          expect.objectContaining({ assignmentId: replacementId, status: 'delegated', leaseId: replacementLease }),
        ]),
      });
      actual.close();

      actual = new SupervisionTaskRegistry({ dbPath });
      const before = actual.get(taskId)!;
      const port: SupervisionRegistryPort = {
        getStatus: (id) => actual.get(id)?.status,
        applyIntent: (input) => actual.applyTaskIntent(input),
        finishAssignment: ({ assignmentId, callerSessionName }) => actual.finishAssignment({
          assignmentId, callerSessionName,
        }),
        list: (filter) => actual.list(filter as never) as never,
        get: (id) => actual.get(id) as never,
        recover: (input) => actual.recoverTask(input),
      };
      const server = createMemoryMcpServer(CALLER, {}, {}, { resolveSessionIdentity: testResolveSessionIdentity, registry: port, isAdmin: () => true });
      const mcpClient = new Client({ name: 'replacement-implementer-test', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
      try {
        const response = await mcpClient.callTool({
          name: SUPERVISION_MCP_TOOLS.INTENT,
          arguments: { intent, taskId, assignmentId: replacementId },
        });
        expect(response.structuredContent).toMatchObject({
          status: 'ok', fromStatus: 'delegated', toStatus: 'implementing',
        });
      } finally {
        await mcpClient.close();
        await server.close();
      }

      const after = actual.get(taskId)!;
      expect(after.status).toBe('implementing');
      expect(after.assignments).toHaveLength(before.assignments.length);
      expect(after.assignments).toEqual(expect.arrayContaining([
        expect.objectContaining({ assignmentId: replacementId, status: 'implementing', leaseId: replacementLease }),
        expect.objectContaining({ assignmentId: old.value.assignmentId, status: 'cancelled', leaseId: '' }),
      ]));
      actual.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('list/get visibility guards', () => {
  // Dispatch-level: post-consolidation these names route through the real
  // production server, so every assertion below crosses client.callTool.
  const handlers = () => ({
    [SUPERVISION_MCP_TOOLS.LIST]: (args: any) => call(SUPERVISION_MCP_TOOLS.LIST, args),
    [SUPERVISION_MCP_TOOLS.GET]: (args: any) => call(SUPERVISION_MCP_TOOLS.GET, args),
  } as any);

  it('LIST defaults to the caller scope and returns only its own tasks', async () => {
    const out: any = await handlers()[SUPERVISION_MCP_TOOLS.LIST]({});
    expect(out.status).toBe('ok');
    expect(out.ownerScope).toBe('caller_default');
    expect(out.tasks.map((t: any) => t.taskId)).toEqual(['tsk_a']);
    expect(registry.listCalls[0]).toMatchObject({ ownerSessionName: 'deck_cd_brain' });
  });

  it('uses one durable participant predicate before a delegated implementer starts', async () => {
    const taskId = 'legacy-delegated-readable';
    const assignmentId = 'legacy-delegated-readable-implementer';
    const sessionName = 'deck_sub_cc1';
    registry.statuses.set(taskId, 'delegated');
    registry.participants.set(taskId, [sessionName]);
    registry.assignmentStates.set(taskId, [{
      assignmentId, role: 'implementer', status: 'delegated', leaseId: 'legacy-lease',
      identity: testIdentity(sessionName),
    }]);
    const caller = { ...CALLER, sessionName, projectName: sessionName };
    const handlers = createSupervisionMcpToolHandlers(caller, {
      registry,
      resolveSessionIdentity: (name) => name === sessionName
        ? { ...testIdentity(sessionName), projectName: 'codedeck' }
        : undefined,
    });

    const beforeGet = await handlers[SUPERVISION_MCP_TOOLS.GET]({ taskId });
    const beforeList: any = await handlers[SUPERVISION_MCP_TOOLS.LIST]({});
    expect(beforeGet).toMatchObject({
      status: 'ok',
      task: { taskId, status: 'delegated', assignments: [expect.objectContaining({ assignmentId, status: 'delegated' })] },
    });
    expect(beforeList.tasks.map((task: any) => task.taskId)).toContain(taskId);

    await expect(handlers[SUPERVISION_MCP_TOOLS.INTENT]({
      intent: 'start', taskId, assignmentId,
    })).resolves.toMatchObject({ status: 'ok', fromStatus: 'delegated', toStatus: 'implementing' });
  });

  it('gives the live project Brain the project-wide authority used by the console snapshot', async () => {
    const brain = createSupervisionMcpToolHandlers(CALLER, { resolveSessionIdentity: testResolveSessionIdentity, registry,
      isProjectBrain: () => true,
    });
    const listed: any = await brain[SUPERVISION_MCP_TOOLS.LIST]({});
    expect(listed).toMatchObject({ status: 'ok', ownerScope: 'project_brain' });
    expect(listed.tasks.map((task: any) => task.taskId).sort()).toEqual(['tsk_a', 'tsk_other']);
    expect(registry.listCalls.at(-1)).toMatchObject({ projectName: 'codedeck' });
    expect(await brain[SUPERVISION_MCP_TOOLS.GET]({ taskId: 'tsk_other' }))
      .toMatchObject({ status: 'ok', task: { taskId: 'tsk_other', projectName: 'codedeck' } });
  });

  it('threads explicit history filters without changing the default list surface', async () => {
    const brain = createSupervisionMcpToolHandlers(CALLER, { resolveSessionIdentity: testResolveSessionIdentity, registry, isProjectBrain: () => true });
    const defaultList: any = await brain[SUPERVISION_MCP_TOOLS.LIST]({});
    expect(defaultList.count).toBe(defaultList.tasks.length);
    expect(registry.listCalls.at(-1)).not.toHaveProperty('includeArchived');
    const history: any = await brain[SUPERVISION_MCP_TOOLS.LIST]({ history: true, cursor: 'tsk_0', limit: 25 });
    expect(history.count).toBe(history.tasks.length);
    expect(registry.listCalls.at(-1)).toMatchObject({
      projectName: 'codedeck', history: true, cursor: 'tsk_0', limit: 25,
    });
    expect(await brain[SUPERVISION_MCP_TOOLS.LIST]({ history: true, includeArchived: true }))
      .toMatchObject({ status: 'error', reason: 'validation_failed' });
  });

  it('LIST with an explicit target the caller does not participate in returns NOTHING', async () => {
    const out: any = await handlers()[SUPERVISION_MCP_TOOLS.LIST]({ target: 'deck_someone_else' });
    expect(out.status).toBe('ok');
    expect(out.tasks).toEqual([]);
  });

  it('post-filters even when the underlying store returns foreign rows', async () => {
    // Store deliberately ignores the owner filter; the guard must still hold.
    registry.list = (filter: any) => { registry.listCalls.push(filter); return [registry.item('tsk_other')]; };
    const out: any = await handlers()[SUPERVISION_MCP_TOOLS.LIST]({});
    expect(out.tasks).toEqual([]);
  });

  it('accepts target as the legacy alias and refuses a conflicting pair', async () => {
    const aliased: any = await handlers()[SUPERVISION_MCP_TOOLS.LIST]({ target: 'deck_cd_brain' });
    expect(aliased.ownerScope).toBe('target');
    expect(aliased.tasks.map((t: any) => t.taskId)).toEqual(['tsk_a']);
    const conflict: any = await handlers()[SUPERVISION_MCP_TOOLS.LIST]({
      target: 'deck_cd_brain', ownerSessionName: 'deck_someone_else',
    });
    expect(conflict).toMatchObject({ status: 'error', reason: 'conflicting_owner_filter' });
    const agreeing: any = await handlers()[SUPERVISION_MCP_TOOLS.LIST]({
      target: 'deck_cd_brain', ownerSessionName: 'deck_cd_brain',
    });
    expect(agreeing.status).toBe('ok');
  });

  it('GET refuses a foreign task with NO existence oracle', async () => {
    const h = handlers();
    const own: any = await h[SUPERVISION_MCP_TOOLS.GET]({ taskId: 'tsk_a' });
    expect(own).toMatchObject({ status: 'ok' });
    const foreign: any = await h[SUPERVISION_MCP_TOOLS.GET]({ taskId: 'tsk_other' });
    const missing: any = await h[SUPERVISION_MCP_TOOLS.GET]({ taskId: 'tsk_does_not_exist' });
    expect(foreign).toMatchObject({ status: 'error', reason: 'identity_rejected' });
    // Byte-identical: existing-but-forbidden is indistinguishable from absent.
    expect(foreign).toEqual(missing);
  });

  it('refuses everything when the caller has no session identity', async () => {
    // Handler-level by necessity: the production server always binds a caller.
    const anon = createSupervisionMcpToolHandlers({} as never, { registry, isAdmin: () => true });
    expect(await anon[SUPERVISION_MCP_TOOLS.GET]({ taskId: 'tsk_a' }))
      .toMatchObject({ status: 'error', reason: 'identity_rejected' });
    expect((await anon[SUPERVISION_MCP_TOOLS.LIST]({}) as any).tasks).toEqual([]);
  });
});

describe('coordinator-authorized implementer handoff', () => {
  // Reproduces the exact production call. The authoritative Brain asked to
  // rebind the SAME active implementer (tsk_hn8/asg_hn9) onto a live CC session
  // and was answered `owner_mismatch`, so the coordinator-authorized handoff
  // was pushed back onto the owner it was meant to replace.
  const ccTarget = {
    sessionName: 'deck_sub_3l6z4l39', sessionInstanceId: 'instance-cc', runtimeEpoch: 'epoch-cc',
    agentType: 'claude-code-sdk', providerFamily: 'anthropic', projectName: 'codedeck',
  };
  const request = {
    taskId: 'tsk_a',
    assignmentId: 'tsk_a-assignment-0',
    rebindSessionName: ccTarget.sessionName,
    expectedRevision: 'c558e38a18a93efe65ebbbed39367039b7197f90',
    ownedFiles: ['src/one.ts', 'src/two.ts'],
    evidenceManifestSha256: 'ac5e9d0eeaab9975641efda5803f9858ea11ad128927e8ebb9ebd757edffbba8',
    reason: 'coordinator-authorized handoff of the active implementer',
  } as const;

  it('routes the Brain call through coordinator recovery, not the implementer owner check', async () => {
    const reg = new FakeRegistry();
    const brain = createSupervisionMcpToolHandlers(CALLER, {
      registry: reg as never, isProjectBrain: () => true,
      resolveSessionIdentity: (name) => (name === ccTarget.sessionName ? ccTarget : undefined),
    });

    expect(await brain[SUPERVISION_MCP_TOOLS.RECOVER](request)).toMatchObject({
      status: 'ok', taskId: request.taskId, assignmentId: request.assignmentId, replay: false,
    });

    // It must reach the coordinator transaction carrying the authority this
    // branch established — the owner check is never what decides this call.
    expect(reg.implementerRebound).toHaveLength(1);
    expect(reg.implementerRebound[0]).toMatchObject({
      taskId: request.taskId,
      assignmentId: request.assignmentId,
      expectedRevision: request.expectedRevision,
      ownedFiles: request.ownedFiles,
      evidenceManifestSha256: request.evidenceManifestSha256,
      identity: { sessionName: ccTarget.sessionName },
      coordinatorAuthorization: {
        targetProjectName: 'codedeck',
        coordinatorSessionName: CALLER.sessionName,
      },
    });
  });

  it('refuses a non-coordinator caller, a foreign-project target and a dead target', async () => {
    const participant = createSupervisionMcpToolHandlers(CALLER, {
      registry: new FakeRegistry() as never,
      resolveSessionIdentity: (name) => (name === ccTarget.sessionName ? ccTarget : undefined),
    });
    expect(await participant[SUPERVISION_MCP_TOOLS.RECOVER](request))
      .toMatchObject({ status: 'error', reason: 'forbidden' });

    // The implementer branch computed the task project but never compared it,
    // so a coordinator could name a target belonging to another project.
    const foreignReg = new FakeRegistry();
    const foreignTargetBrain = createSupervisionMcpToolHandlers(CALLER, {
      registry: foreignReg as never, isProjectBrain: () => true,
      // Only the TARGET is foreign. Returning it for the caller's own session
      // too would fail the call for the unrelated reason that the coordinator
      // itself looked cross-project.
      resolveSessionIdentity: (name) => (name === ccTarget.sessionName
        ? { ...ccTarget, projectName: 'other-project' }
        : testResolveSessionIdentity(name)),
    });
    expect(await foreignTargetBrain[SUPERVISION_MCP_TOOLS.RECOVER](request))
      .toMatchObject({ status: 'error', reason: 'identity_rejected' });
    expect(foreignReg.implementerRebound, 'nothing is written before every check passes').toEqual([]);

    const deadReg = new FakeRegistry();
    const deadTargetBrain = createSupervisionMcpToolHandlers(CALLER, {
      registry: deadReg as never, isProjectBrain: () => true,
      resolveSessionIdentity: (name) => (name === ccTarget.sessionName
        ? undefined : testResolveSessionIdentity(name)),
    });
    expect(await deadTargetBrain[SUPERVISION_MCP_TOOLS.RECOVER](request))
      .toMatchObject({ status: 'error', reason: 'identity_rejected' });
    expect(deadReg.implementerRebound).toEqual([]);
  });
});

describe('administrative recover', () => {
  it('lets only the authoritative same-project Brain atomically repair coordination state, scope, lease, and live identity', async () => {
    const liveIdentity = {
      sessionName: 'deck_recovered_worker', sessionInstanceId: 'instance-recovered', runtimeEpoch: 'epoch-recovered',
      agentType: 'codex-sdk', providerFamily: 'openai', projectName: 'codedeck',
    };
    const request = {
      taskId: 'tsk_a', assignmentId: 'tsk_a-assignment-0',
      taskStatus: 'rework', assignmentStatus: 'rework',
      scopeFiles: ['src/one.ts', 'src/two.ts'], leaseAction: 'clear',
      rebindSessionName: liveIdentity.sessionName,
      idempotencyKey: 'repair-tsk-a-r1', reason: 'repair misprojected REWORK owner',
    } as const;
    const participant = createSupervisionMcpToolHandlers(CALLER, { resolveSessionIdentity: testResolveSessionIdentity, registry });
    expect(await participant[SUPERVISION_MCP_TOOLS.RECOVER](request))
      .toMatchObject({ status: 'error', reason: 'forbidden' });
    expect(registry.coordinated).toEqual([]);

    const brain = createSupervisionMcpToolHandlers(CALLER, { registry, isProjectBrain: () => true,
      resolveSessionIdentity: (name) => name === liveIdentity.sessionName ? liveIdentity : undefined,
    });
    expect(await brain[SUPERVISION_MCP_TOOLS.RECOVER](request)).toEqual({
      status: 'ok', taskId: 'tsk_a', assignmentId: 'tsk_a-assignment-0', replay: false,
    });
    expect(registry.coordinated).toEqual([{
      taskId: 'tsk_a', assignmentId: 'tsk_a-assignment-0',
      taskStatus: 'rework', assignmentStatus: 'rework',
      scopeFiles: ['src/one.ts', 'src/two.ts'], leaseAction: 'clear',
      identity: {
        sessionName: liveIdentity.sessionName,
        sessionInstanceId: liveIdentity.sessionInstanceId,
        runtimeEpoch: liveIdentity.runtimeEpoch,
        agentType: liveIdentity.agentType,
        providerFamily: liveIdentity.providerFamily,
      },
      idempotencyKey: 'repair-tsk-a-r1', reason: 'repair misprojected REWORK owner',
    }]);

    registry.coordinated = [];
    expect(await brain[SUPERVISION_MCP_TOOLS.RECOVER]({
      ...request, rebindSessionName: 'missing-live-runtime',
    })).toMatchObject({ status: 'error', reason: 'identity_rejected' });
    expect(await brain[SUPERVISION_MCP_TOOLS.RECOVER]({
      ...request, fromRevision: 'r1', toRevision: 'r2', ownedFiles: ['src/one.ts'],
      evidenceManifestSha256: 'a'.repeat(64),
    })).toMatchObject({ status: 'error', reason: 'validation_failed' });
    expect(registry.coordinated).toEqual([]);

    const foreignIdentity = { ...liveIdentity, sessionName: 'deck_foreign_worker', projectName: 'other-project' };
    const crossProjectTargetBrain = createSupervisionMcpToolHandlers(CALLER, { registry, isProjectBrain: () => true,
      resolveSessionIdentity: () => foreignIdentity,
    });
    expect(await crossProjectTargetBrain[SUPERVISION_MCP_TOOLS.RECOVER]({
      ...request,
      rebindSessionName: foreignIdentity.sessionName,
      idempotencyKey: 'cross-project-rebind-refused',
    })).toMatchObject({ status: 'error', reason: 'forbidden' });
    expect(registry.coordinated).toEqual([]);
  });

  it('does not let a project Brain coordinate an assignment across project scope', async () => {
    registry.item = (taskId: string) => ({
      taskId, projectName: 'other-project', status: 'ready_for_audit', assignments: [],
    });
    const brain = createSupervisionMcpToolHandlers(CALLER, { resolveSessionIdentity: testResolveSessionIdentity, registry, isProjectBrain: () => true,
    });
    expect(await brain[SUPERVISION_MCP_TOOLS.RECOVER]({
      taskId: 'tsk_a', assignmentId: 'tsk_a-assignment-0',
      taskStatus: 'rework', assignmentStatus: 'rework',
      leaseAction: 'preserve',
      idempotencyKey: 'cross-project-refused', reason: 'must stay project-scoped',
    })).toMatchObject({ status: 'error', reason: 'forbidden' });
    expect(registry.coordinated).toEqual([]);
  });

  it('does not let an exact predecessor REWORK receipt short-circuit a successor revision bind', async () => {
    const assignmentId = 'successor-recovery-assignment';
    let state: any = {
      taskId: 'successor-recovery-task', projectName: 'codedeck', status: 'rework', currentRevision: 'revision-r1',
      assignments: [{
        assignmentId, role: 'implementer', status: 'ready_for_audit', leaseId: '',
        auditAttemptId: 'audit-r1', auditRevision: 'revision-r1', verdict: 'REWORK',
        identity: testIdentity('deck_successor_worker'),
      }],
    };
    const convergeExactReworkAssignment = vi.fn(() => {
      state = { ...state, assignments: state.assignments.map((item: any) => (
        item.assignmentId === assignmentId ? { ...item, status: 'rework', leaseId: 'lease-r1' } : item
      )) };
      return { ok: true };
    });
    const rebindTaskAssignmentRevision = vi.fn((input: any) => {
      state = {
        ...state, currentRevision: input.toRevision,
        assignments: state.assignments.map((item: any) => item.assignmentId === assignmentId ? {
          ...item, status: 'implementing', leaseId: 'lease-r2', auditRevision: input.toRevision,
          auditAttemptId: undefined, verdict: undefined,
        } : item),
      };
      return { ok: true as const };
    });
    const port = {
      getStatus: () => state.status, applyIntent: () => undefined,
      list: () => [state], get: () => state, recover: () => undefined,
      convergeExactReworkAssignment, rebindTaskAssignmentRevision,
    } as unknown as SupervisionRegistryPort;
    const brain = createSupervisionMcpToolHandlers(CALLER, {
      registry: port, isProjectBrain: () => true, resolveSessionIdentity: testResolveSessionIdentity,
    });

    await expect(brain[SUPERVISION_MCP_TOOLS.RECOVER]({
      taskId: state.taskId, assignmentId, fromRevision: 'revision-r1', toRevision: 'revision-r2',
      leaseAction: 'renew', idempotencyKey: 'bind-successor-r2', reason: 'bind the successor revision',
    })).resolves.toMatchObject({
      status: 'ok', taskId: state.taskId, assignmentId,
      fromRevision: 'revision-r1', toRevision: 'revision-r2', replay: false,
    });
    expect(convergeExactReworkAssignment).not.toHaveBeenCalled();
    expect(rebindTaskAssignmentRevision).toHaveBeenCalledTimes(1);
  });

  it('routes a Brain revision recovery that also PINS the current revision to the revision lane', async () => {
    // Production shape: a careful Brain adds `expectedRevision` for optimistic
    // concurrency on top of a revision recovery. `expectedRevision` was treated
    // as the implementer branch's exclusive signal, so this call was claimed by
    // a branch sitting ABOVE the revision lane and rejected with an
    // implementer-shaped `validation_failed` naming rebindSessionName/ownedFiles/
    // evidenceManifestSha256 -- fields this request never had any reason to send.
    // The more precisely the Brain pinned its request, the more certainly it was
    // misrouted, which is why this looked like a schema error rather than a
    // dispatcher defect.
    const assignmentId = 'pinned-successor-assignment';
    const state: any = {
      taskId: 'tsk_pinned', projectName: 'codedeck', status: 'rework',
      currentRevision: 'revision-r1', classification: 'independent_top_level',
      assignments: [{
        assignmentId, role: 'implementer', status: 'rework', required: true,
        auditRevision: 'revision-r1', leaseId: 'lease-r1', generation: 1,
        identity: testIdentity('deck_successor_worker'),
      }],
    };
    const rebindTaskAssignmentRevision = vi.fn(() => ({ ok: true as const }));
    const port = {
      getStatus: () => state.status, applyIntent: () => undefined,
      list: () => [state], get: () => state, recover: () => undefined,
      convergeExactReworkAssignment: vi.fn(() => ({ ok: true as const })),
      rebindTaskAssignmentRevision,
    } as unknown as SupervisionRegistryPort;
    const brain = createSupervisionMcpToolHandlers(CALLER, {
      registry: port, isProjectBrain: () => true, resolveSessionIdentity: testResolveSessionIdentity,
    });

    const response = await brain[SUPERVISION_MCP_TOOLS.RECOVER]({
      taskId: state.taskId, assignmentId,
      fromRevision: 'revision-r1', toRevision: 'revision-r2',
      expectedRevision: 'revision-r1',
      leaseAction: 'renew', idempotencyKey: 'pinned-successor-r2',
      reason: 'bind the successor revision while pinning the observed current one',
    });
    expect(
      JSON.stringify(response),
      'the pinned revision recovery must not be answered with the implementer schema',
    ).not.toContain('implementer identity recovery requires');
    expect(rebindTaskAssignmentRevision, 'it reaches the revision lane').toHaveBeenCalledTimes(1);
  });

  it('routes pinned completion-evidence and auditor-shaped recoveries away from the implementer schema', async () => {
    // Same defect class as the pinned revision recovery: `expectedRevision` is
    // shared optimistic-concurrency metadata, so every OTHER recovery shape that
    // pinned it was answered with the implementer branch's schema error.
    const state: any = {
      taskId: 'tsk_pinned_other', projectName: 'codedeck', status: 'rework',
      currentRevision: 'revision-r1', classification: 'independent_top_level',
      assignments: [{
        assignmentId: 'pinned-other-assignment', role: 'implementer', status: 'rework',
        required: true, auditRevision: 'revision-r1', leaseId: 'lease-r1', generation: 1,
        identity: testIdentity('deck_successor_worker'),
      }],
    };
    const resolveCompletionEvidence = vi.fn(() => ({ ok: true as const }));
    const port = {
      getStatus: () => state.status, applyIntent: () => undefined,
      list: () => [state], get: () => state, recover: () => undefined,
      resolveCompletionEvidence,
    } as unknown as SupervisionRegistryPort;
    const brain = createSupervisionMcpToolHandlers(CALLER, {
      registry: port, isProjectBrain: () => true, resolveSessionIdentity: testResolveSessionIdentity,
    });

    const completion = await brain[SUPERVISION_MCP_TOOLS.RECOVER]({
      taskId: state.taskId, evidenceId: 'evidence-1',
      targetAssignmentId: 'pinned-other-assignment',
      completionEvidenceDecision: 'adopt', expectedRevision: 'revision-r1',
      reason: 'adopt the completion evidence while pinning the observed revision',
    });
    expect(JSON.stringify(completion), 'completion evidence keeps its own schema')
      .not.toContain('implementer identity recovery requires');
    expect(resolveCompletionEvidence, 'it reaches the completion-evidence lane').toHaveBeenCalledTimes(1);

    // An auditor-shaped call that misses one of the orphaned-auditor branch's
    // required fields must be answered in AUDIT terms, not told to supply
    // implementer evidence it has no business producing.
    const auditor = await brain[SUPERVISION_MCP_TOOLS.RECOVER]({
      taskId: state.taskId, assignmentId: 'pinned-other-assignment',
      auditAttemptId: 'attempt-1', expectedRevision: 'revision-r1',
      reason: 'recover the delegated auditor',
    });
    expect(JSON.stringify(auditor), 'auditor recovery is never answered with the implementer schema')
      .not.toContain('implementer identity recovery requires');
  });

  it('immediately refreezes and dispatches an already-validated pre-persisted successor', async () => {
    const assignmentId = 'validated-successor-assignment';
    const state: any = {
      taskId: 'validated-successor-task', projectName: 'codedeck',
      status: 'ready_for_audit', currentRevision: 'revision-r2', validationState: 'passed',
      assignments: [{
        assignmentId, role: 'implementer', status: 'ready_for_audit', leaseId: '',
        auditRevision: 'revision-r2', validationState: 'passed',
        identity: testIdentity('deck_validated_successor_worker'),
      }],
    };
    const convergeValidatedAssignment = vi.fn().mockResolvedValue([{
      taskId: state.taskId, assignmentId, action: 'project_validated_handoff',
    }]);
    const dispatchReadyAudit = vi.fn().mockResolvedValue({ status: 'accepted' });
    const port = {
      getStatus: () => state.status, applyIntent: () => undefined,
      list: () => [state], get: () => state, recover: () => undefined,
      rebindTaskAssignmentRevision: vi.fn(() => ({ ok: true as const })),
      convergeValidatedAssignment,
    } as unknown as SupervisionRegistryPort;
    const brain = createSupervisionMcpToolHandlers(CALLER, {
      registry: port, isProjectBrain: () => true,
      resolveSessionIdentity: testResolveSessionIdentity, dispatchReadyAudit,
    });

    await expect(brain[SUPERVISION_MCP_TOOLS.RECOVER]({
      taskId: state.taskId, assignmentId,
      fromRevision: 'revision-r1', toRevision: 'revision-r2',
      leaseAction: 'preserve', idempotencyKey: 'recover-validated-successor-r2',
      reason: 'clear the exact stale predecessor bundle and converge R2',
    })).resolves.toMatchObject({
      status: 'ok', taskId: state.taskId, assignmentId, toRevision: 'revision-r2',
    });
    expect(convergeValidatedAssignment).toHaveBeenCalledOnce();
    expect(convergeValidatedAssignment).toHaveBeenCalledWith({ taskId: state.taskId, assignmentId });
    expect(dispatchReadyAudit).toHaveBeenCalledOnce();
    expect(dispatchReadyAudit).toHaveBeenCalledWith(state.taskId);
  });

  it('does not dispatch when the recovered successor bundle cannot be refrozen', async () => {
    const assignmentId = 'unfrozen-successor-assignment';
    const state: any = {
      taskId: 'unfrozen-successor-task', projectName: 'codedeck',
      status: 'ready_for_audit', currentRevision: 'revision-r2', validationState: 'passed',
      assignments: [{
        assignmentId, role: 'implementer', status: 'ready_for_audit', leaseId: '',
        auditRevision: 'revision-r2', validationState: 'passed',
        identity: testIdentity('deck_unfrozen_successor_worker'),
      }],
    };
    const convergeValidatedAssignment = vi.fn().mockResolvedValue({
      ok: false as const, reason: 'manifest_mismatch',
    });
    const dispatchReadyAudit = vi.fn();
    const port = {
      getStatus: () => state.status, applyIntent: () => undefined,
      list: () => [state], get: () => state, recover: () => undefined,
      rebindTaskAssignmentRevision: vi.fn(() => ({ ok: true as const })),
      convergeValidatedAssignment,
    } as unknown as SupervisionRegistryPort;
    const brain = createSupervisionMcpToolHandlers(CALLER, {
      registry: port, isProjectBrain: () => true,
      resolveSessionIdentity: testResolveSessionIdentity, dispatchReadyAudit,
    });

    await expect(brain[SUPERVISION_MCP_TOOLS.RECOVER]({
      taskId: state.taskId, assignmentId,
      fromRevision: 'revision-r1', toRevision: 'revision-r2',
      leaseAction: 'preserve', idempotencyKey: 'recover-unfrozen-successor-r2',
      reason: 'fail closed until the exact R2 bundle can be refrozen',
    })).resolves.toMatchObject({
      status: 'ok', toRevision: 'revision-r2', pendingConvergence: 'manifest_mismatch',
    });
    expect(convergeValidatedAssignment).toHaveBeenCalledOnce();
    expect(dispatchReadyAudit).not.toHaveBeenCalled();
  });

  it('fails closed when a successful revision rebind does not satisfy authoritative postconditions', async () => {
    const assignmentId = 'false-success-assignment';
    const state = {
      taskId: 'false-success-task', projectName: 'codedeck', status: 'rework', currentRevision: 'revision-r1',
      assignments: [{
        assignmentId, role: 'implementer', status: 'rework', leaseId: 'lease-r1',
        auditAttemptId: 'audit-r1', auditRevision: 'revision-r1', verdict: 'REWORK',
        identity: testIdentity('deck_false_success_worker'),
      }],
    };
    const rebindTaskAssignmentRevision = vi.fn(() => ({ ok: true as const }));
    const port = {
      getStatus: () => state.status, applyIntent: () => undefined,
      list: () => [state], get: () => state, recover: () => undefined,
      rebindTaskAssignmentRevision,
    } as unknown as SupervisionRegistryPort;
    const brain = createSupervisionMcpToolHandlers(CALLER, {
      registry: port, isProjectBrain: () => true, resolveSessionIdentity: testResolveSessionIdentity,
    });

    await expect(brain[SUPERVISION_MCP_TOOLS.RECOVER]({
      taskId: state.taskId, assignmentId, fromRevision: 'revision-r1', toRevision: 'revision-r2',
      leaseAction: 'renew', idempotencyKey: 'false-success-r2', reason: 'reject a false successful rebind',
    })).resolves.toEqual({
      status: 'error', reason: 'invalid_transition',
      detail: 'revision recovery postcondition failed: authoritative successor state is not bound',
    });
    expect(rebindTaskAssignmentRevision).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['task revision', 'revision-r1', 'revision-r2', undefined, undefined],
    ['assignment revision', 'revision-r2', 'revision-r1', undefined, undefined],
    ['predecessor audit evidence', 'revision-r2', 'revision-r2', 'audit-r1', 'REWORK'],
  ])('checks the authoritative %s after a successful revision rebind', async (
    _postcondition, currentRevision, auditRevision, auditAttemptId, verdict,
  ) => {
    const assignmentId = `postread-${_postcondition}`;
    let reads = 0;
    const before = {
      taskId: 'postread-task', projectName: 'codedeck', status: 'rework', currentRevision: 'revision-r1',
      assignments: [{
        assignmentId, role: 'implementer', status: 'rework', leaseId: 'lease-r1',
        auditAttemptId: 'audit-r1', auditRevision: 'revision-r1', verdict: 'REWORK',
        identity: testIdentity('deck_postread_worker'),
      }],
    };
    const after = {
      ...before, currentRevision,
      assignments: [{ ...before.assignments[0], auditRevision, auditAttemptId, verdict }],
    };
    const port = {
      getStatus: () => before.status, applyIntent: () => undefined,
      list: () => [before], get: () => reads++ === 0 ? before : after, recover: () => undefined,
      rebindTaskAssignmentRevision: () => ({ ok: true as const }),
    } as unknown as SupervisionRegistryPort;
    const brain = createSupervisionMcpToolHandlers(CALLER, {
      registry: port, isProjectBrain: () => true, resolveSessionIdentity: testResolveSessionIdentity,
    });

    await expect(brain[SUPERVISION_MCP_TOOLS.RECOVER]({
      taskId: before.taskId, assignmentId, fromRevision: 'revision-r1', toRevision: 'revision-r2',
      leaseAction: 'renew', idempotencyKey: `postread-${_postcondition}`,
      reason: `reject incomplete ${_postcondition} postcondition`,
    })).resolves.toMatchObject({ status: 'error', reason: 'invalid_transition' });
  });

  it('keeps same-revision exact REWORK receipt convergence idempotent', async () => {
    const assignmentId = 'same-revision-assignment';
    let state: any = {
      taskId: 'same-revision-task', projectName: 'codedeck', status: 'rework', currentRevision: 'revision-r1',
      assignments: [{
        assignmentId, role: 'implementer', status: 'ready_for_audit', leaseId: '',
        auditAttemptId: 'audit-r1', auditRevision: 'revision-r1', verdict: undefined,
        identity: testIdentity('deck_same_revision_worker'),
      }],
    };
    const convergeExactReworkAssignment = vi.fn(() => {
      state = { ...state, assignments: [{
        ...state.assignments[0], status: 'rework', leaseId: 'lease-r1', verdict: 'REWORK',
      }] };
      return { ok: true };
    });
    const rebindTaskAssignmentRevision = vi.fn();
    const port = {
      getStatus: () => state.status, applyIntent: () => undefined,
      list: () => [state], get: () => state, recover: () => undefined,
      convergeExactReworkAssignment, rebindTaskAssignmentRevision,
    } as unknown as SupervisionRegistryPort;
    const brain = createSupervisionMcpToolHandlers(CALLER, {
      registry: port, isProjectBrain: () => true, resolveSessionIdentity: testResolveSessionIdentity,
    });

    await expect(brain[SUPERVISION_MCP_TOOLS.RECOVER]({
      taskId: state.taskId, assignmentId, fromRevision: 'revision-r1', toRevision: 'revision-r1',
      leaseAction: 'renew', idempotencyKey: 'same-revision-r1', reason: 'repair the current revision split',
    })).resolves.toMatchObject({
      status: 'ok', taskId: state.taskId, assignmentId,
      toRevision: 'revision-r1', converged: 'exact_rework_receipt', replay: false,
    });
    expect(convergeExactReworkAssignment).toHaveBeenCalledTimes(1);
    expect(rebindTaskAssignmentRevision).not.toHaveBeenCalled();
  });

  it('rebinds one same-object revision only through Brain/admin authority and the strict production schema', async () => {
    const request = {
      taskId: 'tsk_a', assignmentId: 'tsk_a-assignment-0',
      fromRevision: 'gc-r1', toRevision: 'gc-r3',
      ownedFiles: ['src/daemon/supervision-worktree-gc.ts'],
      scopeFiles: ['src/daemon/supervision-worktree-gc.ts', 'test/daemon/authorized-extra.test.ts'],
      leaseAction: 'renew', idempotencyKey: 'bind-gc-r3-same-object',
      evidenceManifestSha256: 'a'.repeat(64),
      reason: 'bind the frozen R3 evidence to the original assignment',
    };
    const participant = createSupervisionMcpToolHandlers(CALLER, { resolveSessionIdentity: testResolveSessionIdentity, registry });
    expect(await participant[SUPERVISION_MCP_TOOLS.RECOVER](request))
      .toMatchObject({ status: 'error', reason: 'forbidden' });
    expect(registry.revisionRebound).toEqual([]);

    const brain = createSupervisionMcpToolHandlers(CALLER, { resolveSessionIdentity: testResolveSessionIdentity, registry, isProjectBrain: () => true,
    });
    expect(await brain[SUPERVISION_MCP_TOOLS.RECOVER](request)).toEqual({
      status: 'ok', taskId: 'tsk_a', assignmentId: 'tsk_a-assignment-0',
      fromRevision: 'gc-r1', toRevision: 'gc-r3', replay: false,
    });
    expect(registry.revisionRebound).toEqual([request]);

    registry.revisionRebound = [];
    const {
      ownedFiles: _omitted,
      scopeFiles: _scopeOmitted,
      evidenceManifestSha256: _evidenceOmitted,
      ...metadataFree
    } = request;
    expect(await brain[SUPERVISION_MCP_TOOLS.RECOVER](metadataFree)).toMatchObject({
      status: 'ok', toRevision: 'gc-r3', replay: false,
    });
    expect(registry.revisionRebound).toEqual([metadataFree]);

    registry.revisionRebound = [];
    expect(await brain[SUPERVISION_MCP_TOOLS.RECOVER]({
      ...metadataFree, ownedFiles: [], scopeFiles: [],
    })).toMatchObject({ status: 'ok', toRevision: 'gc-r3', replay: false });
    expect(registry.revisionRebound).toEqual([{ ...metadataFree, ownedFiles: [], scopeFiles: [] }]);

    registry.revisionRebound = [];
    expect(await brain[SUPERVISION_MCP_TOOLS.RECOVER]({
      ...metadataFree, evidenceManifestSha256: 'stale provenance only',
    })).toMatchObject({ status: 'ok', toRevision: 'gc-r3', replay: false });
    expect(registry.revisionRebound).toEqual([{
      ...metadataFree, evidenceManifestSha256: 'stale provenance only',
    }]);

    registry.revisionRebound = [];
    expect(await call(SUPERVISION_MCP_TOOLS.RECOVER, request)).toEqual({
      status: 'ok', taskId: 'tsk_a', assignmentId: 'tsk_a-assignment-0',
      fromRevision: 'gc-r1', toRevision: 'gc-r3', replay: false,
    });
    expect(registry.revisionRebound).toEqual([request]);

    registry.revisionRebound = [];
    for (const missing of ['assignmentId', 'toRevision', 'leaseAction', 'idempotencyKey'] as const) {
      const malformed = { ...request } as Record<string, unknown>;
      delete malformed[missing];
      const result: any = await client.callTool({
        name: SUPERVISION_MCP_TOOLS.RECOVER, arguments: malformed,
      });
      expect(result.isError, missing).toBe(true);
    }
    expect(registry.revisionRebound).toEqual([]);
  });

  it('runs the production recovery handler atomically from cleared lease and scope superset to exact owned evidence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-recovery-handler-'));
    const dbPath = join(dir, 'supervision-state.sqlite');
    const realRegistry = new SupervisionTaskRegistry({ dbPath });
    const taskId = 'production-recovery-handler';
    const assignmentId = `${taskId}-implementer`;
    const fromRevision = 'production-recovery-r1';
    const toRevision = 'production-recovery-r2';
    const ownedFiles = ['src/one.ts', 'test/one.test.ts'];
    const scopeFiles = [...ownedFiles, 'test/authorized-extra.test.ts'].sort();
    const worker = {
      ...testIdentity('deck_production_recovery_worker'),
    };
    try {
      expect(realRegistry.createOrGet({
        taskId, projectName: 'codedeck', classification: 'independent_top_level',
        objective: 'exercise the real recovery handler', currentRevision: fromRevision,
      })).toMatchObject({ ok: true });
      expect(realRegistry.createAssignment({
        assignmentId, taskId, role: 'implementer', identity: worker, scopeFiles,
        auditRevision: fromRevision,
      })).toMatchObject({ ok: true });
      expect(realRegistry.updateTask({ taskId, status: 'delegated' })).toMatchObject({ ok: true });
      expect(realRegistry.updateTask({ taskId, status: 'implementing' })).toMatchObject({ ok: true });
      expect(realRegistry.updateAssignment({
        assignmentId, identity: worker, status: 'implementing', revision: fromRevision,
        auditRevision: fromRevision,
      })).toMatchObject({ ok: true });
      for (const [index, path] of ownedFiles.entries()) {
        expect(realRegistry.recordFileEvent({
          assignmentId, identity: worker, path, operation: 'modify',
          idempotencyKey: `${taskId}-file-${index}`,
        })).toMatchObject({ ok: true });
      }
      const productionRegistry = {
        getStatus: (id: string) => realRegistry.get(id)?.status,
        applyIntent: (input: any) => realRegistry.applyTaskIntent(input),
        list: (input: any) => realRegistry.list(input),
        get: (id: string) => realRegistry.get(id),
        recover: (input: any) => realRegistry.recoverTask(input),
        coordinateTaskAssignment: (input: any) => realRegistry.coordinateTaskAssignment(input),
        rebindTaskAssignmentRevision: (input: any) => realRegistry.rebindTaskAssignmentRevision({
          ...input,
          worktreeSnapshot: {
            worktreePath: '/tmp/production-recovery-handler/repo',
            headSha: 'a'.repeat(40),
            files: ownedFiles.map((path) => ({ path, sha256: 'b'.repeat(64) })),
            stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
          },
        }),
      } as unknown as SupervisionRegistryPort;
      const production = createSupervisionMcpToolHandlers(CALLER, {
        resolveSessionIdentity: testResolveSessionIdentity,
        registry: productionRegistry, isProjectBrain: () => true,
      });
      expect(await production[SUPERVISION_MCP_TOOLS.RECOVER]({
        taskId, assignmentId, leaseAction: 'clear',
        idempotencyKey: 'production-handler-clear-lease',
        reason: 'reproduce the stale empty-lease state',
      })).toMatchObject({ status: 'ok', replay: false });
      expect(realRegistry.getAssignment(assignmentId)?.leaseId).toBe('');

      const recovery = {
        taskId, assignmentId, fromRevision, toRevision, ownedFiles, scopeFiles,
        leaseAction: 'renew', idempotencyKey: 'production-handler-bind-r2',
        evidenceManifestSha256: 'f'.repeat(64),
        reason: 'bind exact frozen evidence and renew the lease atomically',
      };
      expect(await production[SUPERVISION_MCP_TOOLS.RECOVER](recovery)).toMatchObject({
        status: 'ok', taskId, assignmentId, fromRevision, toRevision, replay: false,
      });
      expect(realRegistry.getTaskRecord(taskId)).toMatchObject({ currentRevision: toRevision });
      expect(realRegistry.getAssignment(assignmentId)).toMatchObject({
        auditRevision: toRevision, scopeFiles, leaseId: expect.stringMatching(/^(?:lse|supervision_lease)_/),
      });
    } finally {
      realRegistry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rebinds an existing auditor only through project-Brain authority and live daemon identity', async () => {
    const liveIdentity = {
      sessionName: 'deck_sub_rebound', sessionInstanceId: 'instance-rebound', runtimeEpoch: 'epoch-rebound',
      agentType: 'codex-sdk', providerFamily: 'openai', projectName: 'codedeck',
    };
    const participant = createSupervisionMcpToolHandlers(CALLER, { registry,
      resolveSessionIdentity: () => liveIdentity,
    });
    expect(await participant[SUPERVISION_MCP_TOOLS.RECOVER]({
      taskId: 'tsk_a', assignmentId: 'auditor-a', rebindSessionName: liveIdentity.sessionName,
      reason: 'authorized device replacement',
    })).toMatchObject({ status: 'error', reason: 'forbidden' });
    expect(registry.rebound).toEqual([]);

    const brain = createSupervisionMcpToolHandlers(CALLER, { registry,
      isProjectBrain: () => true,
      resolveSessionIdentity: (name) => name === liveIdentity.sessionName ? liveIdentity : undefined,
    });
    expect(await brain[SUPERVISION_MCP_TOOLS.RECOVER]({
      taskId: 'tsk_a', assignmentId: 'auditor-a', rebindSessionName: 'missing-runtime',
      reason: 'must bind observed runtime',
    })).toMatchObject({ status: 'error', reason: 'identity_rejected' });
    expect(await brain[SUPERVISION_MCP_TOOLS.RECOVER]({
      taskId: 'tsk_a', assignmentId: 'auditor-a', rebindSessionName: liveIdentity.sessionName,
      reason: 'authorized device replacement',
    })).toEqual({
      status: 'ok', taskId: 'tsk_a', assignmentId: 'auditor-a',
      rebindSessionName: liveIdentity.sessionName, replay: false,
    });
    expect(registry.rebound).toEqual([{
      taskId: 'tsk_a', assignmentId: 'auditor-a', identity: {
        sessionName: liveIdentity.sessionName,
        sessionInstanceId: liveIdentity.sessionInstanceId,
        runtimeEpoch: liveIdentity.runtimeEpoch,
        agentType: liveIdentity.agentType,
        providerFamily: liveIdentity.providerFamily,
      },
      // Load-bearing: proves the task's project is threaded down to the
      // registry, so the authority check cannot be bypassed by callers that
      // reach the registry without going through this MCP entry point.
      callerProjectName: 'codedeck',
      reason: 'authorized device replacement',
    }]);
  });

  it('reopens a Brain-cancelled undelivered auditor on the SAME attempt with one complete selected binding', async () => {
    const taskId = 'tsk_d4d';
    const assignmentId = 'asg_dlt';
    const revision = 'post-pass-successor-owner-retirement-cx1-r1-eb2b2965f045';
    const auditAttemptId = 'auto-audit-30656902ee6c14fbdcb2751b';
    registry.statuses.set(taskId, 'ready_for_audit');
    registry.currentRevisions.set(taskId, revision);
    registry.assignmentStates.set(taskId, [
      {
        assignmentId: 'asg_d4d_coord', role: 'coordinator', status: 'delegated', leaseId: '',
        identity: testIdentity('deck_cd_brain'),
      },
      {
        assignmentId: 'asg_d4h', role: 'implementer', status: 'ready_for_audit', leaseId: '',
        auditRevision: revision,
        identity: testIdentity('deck_d4d_implementer'),
      },
      {
        assignmentId, role: 'auditor', status: 'cancelled', leaseId: '', generation: 7,
        auditAttemptId, auditRevision: revision,
        identity: {
          ...testIdentity('deck_d4d_live_cc9'),
          agentType: 'claude-code-sdk', providerFamily: 'anthropic',
        },
        executionBinding: {
          pool: 'primary', origin: 'reused',
          requested: {
            capabilityId: 'supervision-exec-v1:transport:cursor-headless:cursor:Auto',
            agentType: 'cursor-headless', providerFamily: 'cursor', runtimeType: 'transport', model: 'Auto',
          },
          actual: {
            ...testIdentity('deck_d4d_live_cc9'),
            agentType: 'claude-code-sdk', providerFamily: 'anthropic', runtimeType: 'process', model: 'Auto',
          },
        },
      },
    ]);
    const originalItem = registry.item.bind(registry);
    registry.item = (id: string) => ({
      ...originalItem(id),
      auditPolicy: id === taskId ? 'auto_strict_cross_vendor' : undefined,
      validationState: id === taskId ? 'passed' : undefined,
    });
    const replacement = {
      sessionName: 'deck_d4d_live_cc9',
      sessionInstanceId: 'instance-deck_d4d_live_cc9',
      runtimeEpoch: 'epoch-deck_d4d_live_cc9',
      agentType: 'claude-code-sdk',
      providerFamily: 'anthropic',
      projectName: 'codedeck',
    };
    const replacementBinding = {
      pool: 'primary' as const,
      requested: {
        capabilityId: 'supervision-exec-v1:transport:claude-code-sdk:anthropic:sonnet',
        agentType: 'claude-code-sdk', providerFamily: 'anthropic',
        runtimeType: 'transport' as const, model: 'sonnet',
      },
      actual: {
        sessionName: replacement.sessionName,
        sessionInstanceId: replacement.sessionInstanceId,
        runtimeEpoch: replacement.runtimeEpoch,
        agentType: replacement.agentType,
        providerFamily: replacement.providerFamily,
        runtimeType: 'transport' as const,
        model: 'sonnet',
      },
      origin: 'reused' as const,
    };
    const dispatchReadyAudit = vi.fn().mockResolvedValue({
      status: 'dispatched', assignmentId, auditAttemptId,
    });
    const retireSupersededAuditDelivery = vi.fn().mockReturnValue(true);
    const handlers = createSupervisionMcpToolHandlers(CALLER, {
      registry,
      isProjectBrain: () => true,
      resolveSessionIdentity: (name) => name === replacement.sessionName ? replacement : undefined,
      resolveRecoveryExecutionBinding: (name) => name === replacement.sessionName ? replacementBinding : undefined,
      dispatchReadyAudit,
      retireSupersededAuditDelivery,
    });

    const result = await handlers[SUPERVISION_MCP_TOOLS.RECOVER]({
      taskId,
      assignmentId,
      rebindSessionName: replacement.sessionName,
      expectedRevision: revision,
      auditAttemptId,
      idempotencyKey: `orphan-auditor:${taskId}:${assignmentId}:${auditAttemptId}`,
      reason: 'old auditor target is no longer discoverable',
    });

    expect(result).toMatchObject({
      status: 'ok', taskId, assignmentId,
      rebindSessionName: replacement.sessionName,
      expectedRevision: revision,
      auditAttemptId,
      auditTrigger: { status: 'dispatched', assignmentId },
    });
    expect(registry.orphanedAuditorRebound).toEqual([
      expect.objectContaining({
        taskId, assignmentId, expectedRevision: revision, auditAttemptId,
        expectedGeneration: 7,
        identity: expect.objectContaining({ sessionName: replacement.sessionName }),
        executionBinding: replacementBinding,
        callerProjectName: 'codedeck',
      }),
    ]);
    expect(retireSupersededAuditDelivery).toHaveBeenCalledWith({
      sessionName: 'deck_d4d_live_cc9',
      messageId: expect.stringMatching(/^send_message_/),
      recipient: {
        sessionInstanceId: 'instance-deck_d4d_live_cc9',
        runtimeEpoch: 'epoch-deck_d4d_live_cc9',
      },
    });
    expect(dispatchReadyAudit).toHaveBeenCalledOnce();
    expect(dispatchReadyAudit).toHaveBeenCalledWith(taskId);
    expect(registry.rebound, 'must not use the loose legacy audit-rebind branch').toEqual([]);
    expect(registry.implementerRebound, 'must not use implementer evidence recovery').toEqual([]);
  });

  it('fails closed before rebind when exact superseded audit delivery cannot be retired', async () => {
    const taskId = 'tsk_5w9';
    const assignmentId = 'asg_e7r';
    const revision = 'successor-revision-projection-cc3-r3-01c155d603b8';
    const auditAttemptId = 'auto-audit-c73d9296ca7a631a8d5ff136';
    registry.statuses.set(taskId, 'ready_for_audit');
    registry.currentRevisions.set(taskId, revision);
    registry.assignmentStates.set(taskId, [
      {
        assignmentId: 'asg_worker', role: 'implementer', status: 'ready_for_audit', leaseId: '',
        auditRevision: revision, identity: testIdentity('deck_worker'),
      },
      {
        assignmentId, role: 'auditor', status: 'auditing', leaseId: '', generation: 3,
        auditAttemptId, auditRevision: revision,
        identity: { ...testIdentity('deck_stale'), agentType: 'claude-code-sdk', providerFamily: 'anthropic' },
      },
    ]);
    const originalItem = registry.item.bind(registry);
    registry.item = (id: string) => ({
      ...originalItem(id), auditPolicy: id === taskId ? 'auto_strict_cross_vendor' : undefined,
      validationState: id === taskId ? 'passed' : undefined,
    });
    const replacement = {
      ...testResolveSessionIdentity('deck_live'),
      agentType: 'claude-code-sdk', providerFamily: 'anthropic',
    };
    const handlers = createSupervisionMcpToolHandlers(CALLER, {
      registry, isProjectBrain: () => true,
      resolveSessionIdentity: () => replacement,
      retireSupersededAuditDelivery: vi.fn().mockReturnValue(false),
      dispatchReadyAudit: vi.fn(),
    });

    await expect(handlers[SUPERVISION_MCP_TOOLS.RECOVER]({
      taskId, assignmentId, rebindSessionName: replacement.sessionName,
      expectedRevision: revision, auditAttemptId, idempotencyKey: 'exact-retire-failed',
      reason: 'old queue identity does not match',
    })).resolves.toMatchObject({ status: 'error', reason: 'identity_rejected' });
    expect(registry.orphanedAuditorRebound).toEqual([]);
  });

  it('rebinds a validated required implementer through the live same-session identity and frozen evidence', async () => {
    const liveIdentity = {
      sessionName: 'deck_cd_brain', sessionInstanceId: 'instance-restarted', runtimeEpoch: 'epoch-restarted',
      // Production identities always carry the project (the type requires it,
      // and the auditor branch has always compared it). The fixture omitted it
      // only because the implementer branch never looked.
      agentType: 'codex-sdk', providerFamily: 'openai', projectName: 'codedeck',
    };
    const successorBinding = {
      pool: 'primary' as const,
      requested: {
        capabilityId: 'supervision-exec-v1:transport:codex-sdk:openai:gpt-5.6',
        agentType: 'codex-sdk', providerFamily: 'openai',
        runtimeType: 'transport' as const, model: 'gpt-5.6',
      },
      actual: {
        sessionName: liveIdentity.sessionName,
        sessionInstanceId: liveIdentity.sessionInstanceId,
        runtimeEpoch: liveIdentity.runtimeEpoch,
        agentType: 'codex-sdk', providerFamily: 'openai',
        runtimeType: 'transport' as const, model: 'gpt-5.6',
      },
      origin: 'reused' as const,
    };
    const request = {
      taskId: 'tsk_a', assignmentId: 'tsk_a-assignment-0',
      rebindSessionName: liveIdentity.sessionName,
      expectedRevision: 'validated-r2',
      ownedFiles: ['src/daemon/supervision-state-store.ts'],
      evidenceManifestSha256: 'b'.repeat(64),
      reason: 'same object stale runtime recovery',
    };
    const participant = createSupervisionMcpToolHandlers(CALLER, {
      registry,
      resolveSessionIdentity: () => liveIdentity,
    });
    expect(await participant[SUPERVISION_MCP_TOOLS.RECOVER](request))
      .toMatchObject({ status: 'error', reason: 'forbidden' });
    expect(registry.implementerRebound).toEqual([]);

    const brain = createSupervisionMcpToolHandlers(CALLER, {
      registry,
      isProjectBrain: () => true,
      resolveSessionIdentity: (name) => name === liveIdentity.sessionName ? liveIdentity : undefined,
      // The successor's OWN selected binding, resolved from the live pool. The
      // incumbent's describes the runtime being replaced, so it can never stand
      // in for it.
      resolveRecoveryExecutionBinding: (name) => (
        name === liveIdentity.sessionName ? successorBinding : undefined
      ),
    });
    expect(await brain[SUPERVISION_MCP_TOOLS.RECOVER]({ ...request, rebindSessionName: 'missing' }))
      .toMatchObject({ status: 'error', reason: 'identity_rejected' });
    expect(await brain[SUPERVISION_MCP_TOOLS.RECOVER](request)).toEqual({
      status: 'ok', taskId: request.taskId, assignmentId: request.assignmentId,
      rebindSessionName: liveIdentity.sessionName, expectedRevision: request.expectedRevision,
      leaseAction: 'preserve', replay: false,
    });
    expect(registry.implementerRebound).toEqual([{
      taskId: request.taskId, assignmentId: request.assignmentId, identity: liveIdentity,
      expectedRevision: request.expectedRevision, ownedFiles: request.ownedFiles,
      evidenceManifestSha256: request.evidenceManifestSha256, reason: request.reason,
      // Absent from the request, so the transaction is told the default
      // explicitly rather than left to infer it.
      leaseAction: 'preserve',
      // The authority this branch established is now handed to the transaction
      // so it can re-derive the project instead of trusting the caller. A
      // same-session recovery carries it too and is unaffected by it.
      coordinatorAuthorization: {
        targetProjectName: 'codedeck', coordinatorSessionName: CALLER.sessionName,
      },
      // Forwarded so the transaction can persist the complete canonical tuple
      // instead of blending the incumbent's capability into the successor's row.
      executionBinding: successorBinding,
    }]);

    registry.implementerRebound = [];
    for (const missing of ['assignmentId', 'rebindSessionName', 'expectedRevision', 'ownedFiles', 'evidenceManifestSha256'] as const) {
      const malformed = { ...request } as Record<string, unknown>;
      delete malformed[missing];
      const result: any = await client.callTool({
        name: SUPERVISION_MCP_TOOLS.RECOVER, arguments: malformed,
      });
      const business = result.content?.find((entry: { type?: string }) => entry.type === 'text')?.text;
      const rejected = result.isError === true
        || (typeof business === 'string' && JSON.parse(business).status === 'error');
      expect(rejected, `${missing}: ${JSON.stringify(result)}`).toBe(true);
    }
    expect(registry.implementerRebound).toEqual([]);
  });

  it('is authorized, enum-restricted and transition-checked', async () => {
    const out = await call(SUPERVISION_MCP_TOOLS.RECOVER, { taskId: 'tsk_a', toStatus: 'recovered', reason: 'wedged' });
    expect(out).toMatchObject({ status: 'ok', fromStatus: 'planned', toStatus: 'recovered' });
    expect(registry.recovered).toEqual([{ taskId: 'tsk_a', toStatus: 'recovered', reason: 'wedged' }]);
  });

  it('is FORBIDDEN for a non-admin caller', async () => {
    await connect(false);
    const out = await call(SUPERVISION_MCP_TOOLS.RECOVER, { taskId: 'tsk_a', toStatus: 'recovered', reason: 'x' });
    expect(out).toMatchObject({ status: 'error', reason: 'forbidden' });
    expect(registry.recovered).toEqual([]);
  });

  it('allows only the live same-project Brain to request evidence-derived cancelled recovery', async () => {
    registry.statuses.set('tsk_a', 'cancelled');
    registry.recover = (input: any) => {
      registry.recovered.push(input);
      registry.statuses.set(input.taskId, 'ready_for_integration');
      return { ok: true as const, value: { status: 'ready_for_integration' } };
    };
    const participant = createSupervisionMcpToolHandlers(CALLER, { resolveSessionIdentity: testResolveSessionIdentity, registry });
    expect(await participant[SUPERVISION_MCP_TOOLS.RECOVER]({
      taskId: 'tsk_a', toStatus: 'recovered', reason: 'repair cascade',
    })).toMatchObject({ status: 'error', reason: 'forbidden' });
    const projectBrain = createSupervisionMcpToolHandlers(CALLER, { resolveSessionIdentity: testResolveSessionIdentity, registry, isProjectBrain: () => true,
    });
    expect(await projectBrain[SUPERVISION_MCP_TOOLS.RECOVER]({
      taskId: 'tsk_a', toStatus: 'recovered', reason: 'repair cascade',
    })).toEqual({
      status: 'ok', taskId: 'tsk_a', fromStatus: 'cancelled', toStatus: 'ready_for_integration',
    });
    expect(registry.recovered).toEqual([{
      taskId: 'tsk_a', toStatus: 'recovered', reason: 'repair cascade',
    }]);
  });

  it('does not let a project Brain use cancelled recovery across project scope', async () => {
    registry.statuses.set('tsk_a', 'cancelled');
    registry.item = (taskId: string) => ({
      taskId,
      projectName: 'other-project',
      assignments: [{ identity: testIdentity('deck_cd_brain') }],
    });
    const projectBrain = createSupervisionMcpToolHandlers(CALLER, { resolveSessionIdentity: testResolveSessionIdentity, registry, isProjectBrain: () => true,
    });
    expect(await projectBrain[SUPERVISION_MCP_TOOLS.RECOVER]({
      taskId: 'tsk_a', toStatus: 'recovered', reason: 'must not cross project',
    })).toMatchObject({ status: 'error', reason: 'forbidden' });
    expect(await projectBrain[SUPERVISION_MCP_TOOLS.RECOVER]({
      taskId: 'missing-task', toStatus: 'recovered', reason: 'must not reveal existence',
    })).toEqual(await projectBrain[SUPERVISION_MCP_TOOLS.RECOVER]({
      taskId: 'tsk_a', toStatus: 'recovered', reason: 'must not cross project',
    }));
    expect(registry.recovered).toEqual([]);
  });

  it('rejects every lifecycle status outside the shared recovery contract on the real server', async () => {
    for (const bad of SUPERVISION_TASK_LIFECYCLE_STATUSES.filter(
      (status) => !(SUPERVISION_TASK_RECOVERY_TARGET_STATUSES as readonly string[]).includes(status),
    )) {
      const res: any = await client.callTool({
        name: SUPERVISION_MCP_TOOLS.RECOVER, arguments: { taskId: 'tsk_a', toStatus: bad, reason: 'x' },
      });
      expect(res.isError, bad).toBe(true);
    }
    expect(registry.recovered).toEqual([]);
  });

  it('cannot move an already-terminal task', async () => {
    registry.statuses.set('tsk_a', 'pushed');
    const out = await call(SUPERVISION_MCP_TOOLS.RECOVER, { taskId: 'tsk_a', toStatus: 'blocked', reason: 'x' });
    expect(out).toMatchObject({ status: 'error', reason: 'illegal_transition' });
    expect(registry.recovered).toEqual([]);
  });
});

describe('durable coordinator authority after daemon state loss', () => {
  it('keeps the same project coordinator able to list, get and recover after SQLite reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'supervision-brain-authority-reopen-'));
    const dbPath = join(dir, 'registry.sqlite');
    let durable = new SupervisionTaskRegistry({ dbPath });
    const taskId = 'tsk_restart_authority';
    const coordinatorId = 'asg_restart_coordinator';
    const implementerId = 'asg_restart_implementer';
    try {
      expect(durable.createOrGet({
        taskId, projectName: 'codedeck', classification: 'integration_task',
        objective: 'retain coordinator authority across daemon restart',
      })).toMatchObject({ ok: true });
      expect(durable.createAssignment({
        taskId, assignmentId: coordinatorId, role: 'coordinator', required: false,
        identity: { ...testIdentity('deck_cd_brain'), runtimeEpoch: 'epoch-before-restart' },
      })).toMatchObject({ ok: true });
      expect(durable.createAssignment({
        taskId, assignmentId: implementerId, role: 'implementer',
        identity: testIdentity('deck_worker'), scopeFiles: ['src/exact.ts'],
      })).toMatchObject({ ok: true });
      durable.close();
      durable = new SupervisionTaskRegistry({ dbPath });

      // Production failure window: the stdio caller survives with its stable
      // project/session binding while the reopened daemon session registry has
      // not yet made the rotated runtime identity observable.
      const port: SupervisionRegistryPort = {
        getStatus: (id) => durable.get(id)?.status,
        applyIntent: (input) => durable.applyTaskIntent(input),
        list: (filter) => durable.list(filter as never) as never,
        get: (id) => durable.get(id) as never,
        recover: (input) => durable.recoverTask(input),
        coordinateTaskAssignment: (input) => durable.coordinateTaskAssignment(input),
        housekeeping: (input) => durable.housekeeping(input),
      };
      const handlers = createSupervisionMcpToolHandlers(CALLER, {
        registry: port,
        isAdmin: () => false,
        isProjectBrain: () => false,
        resolveSessionIdentity: () => undefined,
      });
      await expect(handlers[SUPERVISION_MCP_TOOLS.GET]({ taskId }))
        .resolves.toMatchObject({ status: 'ok', task: { taskId } });
      await expect(handlers[SUPERVISION_MCP_TOOLS.LIST]({}))
        .resolves.toMatchObject({ status: 'ok', count: 1, tasks: [{ taskId }] });
      const coordinatorRenewal = {
        taskId, assignmentId: coordinatorId,
        leaseAction: 'renew', idempotencyKey: 'restart-coordinator-renew-once',
        reason: 'same coordinator renews its durable lease after runtime rotation',
      };
      const concurrent = await Promise.all([
        handlers[SUPERVISION_MCP_TOOLS.RECOVER](coordinatorRenewal),
        handlers[SUPERVISION_MCP_TOOLS.RECOVER](coordinatorRenewal),
      ]);
      expect(concurrent).toEqual([
        expect.objectContaining({ status: 'ok', taskId, assignmentId: coordinatorId }),
        expect.objectContaining({ status: 'ok', taskId, assignmentId: coordinatorId }),
      ]);
      expect(concurrent.filter((result) => result.replay === true)).toHaveLength(1);
      await expect(handlers[SUPERVISION_MCP_TOOLS.RECOVER]({
        taskId, assignmentId: implementerId,
        taskStatus: 'implementing', assignmentStatus: 'implementing',
        leaseAction: 'renew', idempotencyKey: 'restart-authority-recover-once',
        reason: 'same coordinator resumes the exact assignment after runtime rotation',
      })).resolves.toMatchObject({ status: 'ok', taskId, assignmentId: implementerId });

      expect(durable.listAssignments(taskId).filter((item) => item.role === 'coordinator'))
        .toHaveLength(1);
      expect(durable.listAssignments(taskId).filter((item) => item.role === 'implementer'))
        .toHaveLength(1);
    } finally {
      durable.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps foreign, same-name cross-project and conflicting observed identities fail-closed', async () => {
    registry.statuses.set('tsk_authority', 'implementing');
    registry.participants.set('tsk_authority', ['deck_cd_brain']);
    registry.assignmentStates.set('tsk_authority', [{
      assignmentId: 'asg_authority_coordinator', role: 'coordinator', status: 'delegated', leaseId: 'lease',
      identity: testIdentity('deck_cd_brain'),
    }]);
    const args = {
      taskId: 'tsk_authority', assignmentId: 'asg_authority_coordinator',
      leaseAction: 'renew', idempotencyKey: 'must-fail', reason: 'unauthorized probe',
    };
    for (const [caller, liveIdentity] of [
      [{ ...CALLER, sessionName: 'deck_foreign' }, undefined],
      [{ ...CALLER, projectName: 'other-project' }, undefined],
      [CALLER, { ...testResolveSessionIdentity('deck_cd_brain'), projectName: 'other-project' }],
      [CALLER, { ...testResolveSessionIdentity('deck_forged'), projectName: 'codedeck' }],
    ] as const) {
      const handlers = createSupervisionMcpToolHandlers(caller as McpRuntimeCaller, {
        registry, isAdmin: () => false, isProjectBrain: () => false,
        resolveSessionIdentity: () => liveIdentity,
      });
      await expect(handlers[SUPERVISION_MCP_TOOLS.GET]({ taskId: 'tsk_authority' }))
        .resolves.toMatchObject({ status: 'error', reason: 'identity_rejected' });
      await expect(handlers[SUPERVISION_MCP_TOOLS.RECOVER](args))
        .resolves.toMatchObject({ status: 'error', reason: 'forbidden' });
    }
    expect(registry.coordinated).toEqual([]);
  });
});

describe('bounded housekeeping administration', () => {
  it('keeps dryRun/apply admin-only and forwards the bounded cursor contract', async () => {
    const out: any = await call(SUPERVISION_MCP_TOOLS.HOUSEKEEPING, {
      mode: 'dryRun', cursor: 'tsk_0', limit: 25,
    });
    expect(out).toMatchObject({
      status: 'ok',
      result: { mode: 'dryRun', scanned: 2, activeCount: 1, archivedCount: 1 },
      worktrees: {
        mode: 'dryRun', scanned: 1, deleted: 0, retained: 1, registryAvailable: true,
      },
    });
    expect(registry.housekeepingCalls).toEqual([{
      mode: 'dryRun', projectName: 'codedeck', cursor: 'tsk_0', limit: 25,
    }]);
    expect(worktreeGcCalls).toEqual([{
      mode: 'dryRun', projectName: 'codedeck', cursor: 'tsk_0', limit: 25,
    }]);

    await connect(false);
    expect(await call(SUPERVISION_MCP_TOOLS.HOUSEKEEPING, { mode: 'apply' }))
      .toMatchObject({ status: 'error', reason: 'forbidden' });
    expect(registry.housekeepingCalls).toEqual([]);
    expect(worktreeGcCalls).toEqual([]);
  });

  it('keeps registry housekeeping authoritative when physical GC is not bound', async () => {
    const handlers = createSupervisionMcpToolHandlers(CALLER, { resolveSessionIdentity: testResolveSessionIdentity, registry,
      isAdmin: () => true,
      isProjectBrain: () => true,
    });
    const out = await handlers[SUPERVISION_MCP_TOOLS.HOUSEKEEPING]({ mode: 'dryRun' });
    expect(out).toMatchObject({
      status: 'ok',
      result: { mode: 'dryRun', scanned: 2 },
      worktrees: {
        mode: 'dryRun', registryAvailable: false,
        diagnostics: [{ code: 'worktree_gc_not_bound' }],
      },
    });
  });
});

describe('published schema enums match the fixed constants exactly', () => {
  it('derives intent, status, validation and recovery enums from contract constants', async () => {
    const listed = await client.listTools();
    const byName = new Map(listed.tools.map((t) => [t.name, t.inputSchema as any]));
    const intent = byName.get(SUPERVISION_MCP_TOOLS.INTENT);
    expect(intent.properties.intent.enum).toEqual([...SUPERVISION_INTENTS]);
    expect(intent.properties.validationState.enum).toEqual([...SUPERVISION_CONSOLE_VALIDATION_STATES]);
    expect(byName.get(SUPERVISION_MCP_TOOLS.RECOVER).properties.toStatus.enum)
      .toEqual([...SUPERVISION_TASK_RECOVERY_TARGET_STATUSES]);
    expect(byName.get(SUPERVISION_MCP_TOOLS.RECOVER).properties.taskStatus.enum)
      .toEqual([...SUPERVISION_BRAIN_COORDINATION_RECOVERY_STATUSES]);
    expect(byName.get(SUPERVISION_MCP_TOOLS.RECOVER).properties.assignmentStatus.enum)
      .toEqual([...SUPERVISION_BRAIN_COORDINATION_RECOVERY_STATUSES]);
    expect(byName.get(SUPERVISION_MCP_TOOLS.RECOVER).properties).toEqual(expect.objectContaining({
      fromRevision: expect.any(Object),
      toRevision: expect.any(Object),
      expectedRevision: expect.any(Object),
      ownedFiles: expect.any(Object),
      evidenceManifestSha256: expect.any(Object),
      scopeFiles: expect.any(Object),
      leaseAction: expect.objectContaining({ enum: [...SUPERVISION_RECOVERY_LEASE_ACTIONS] }),
      idempotencyKey: expect.any(Object),
    }));
    expect(byName.get(SUPERVISION_MCP_TOOLS.RECOVER).properties).not.toHaveProperty('clearLease');
    expect(byName.get(SUPERVISION_MCP_TOOLS.HOUSEKEEPING).properties.mode.enum)
      .toEqual(['dryRun', 'apply']);
    expect(byName.get(SUPERVISION_MCP_TOOLS.LIST).properties.limit.maximum).toBe(100);
    // The recovery enum must never include a shipped terminal.
    for (const shipped of ['finalized', 'pushed']) {
      expect(SUPERVISION_TASK_RECOVERY_TARGET_STATUSES as readonly string[], shipped).not.toContain(shipped);
    }
  });

  it('never publishes a forbidden argument name on a model-facing tool', async () => {
    const listed = await client.listTools();
    for (const tool of listed.tools) {
      if (tool.name !== SUPERVISION_MCP_TOOLS.INTENT) continue;
      const props = Object.keys(((tool.inputSchema as any).properties) ?? {});
      for (const forbidden of SUPERVISION_MCP_FORBIDDEN_ARG_NAMES) {
        expect(props, `${tool.name}.${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('publishes no event type as an intent or status', async () => {
    const listed = await client.listTools();
    const eventOnly = SUPERVISION_TASK_REGISTRY_EVENT_TYPES.filter(
      (e) => !(SUPERVISION_TASK_LIFECYCLE_STATUSES as readonly string[]).includes(e));
    const intent = listed.tools.find((t) => t.name === SUPERVISION_MCP_TOOLS.INTENT)!;
    for (const e of eventOnly) {
      expect((intent.inputSchema as any).properties.intent.enum, e).not.toContain(e);
    }
  });
});

// R5 gap found by the cross-vendor auditor: rebindAuthorizedOrigin had ZERO
// production callers. The capability was proven in isolation while the real
// authorized coordinator rebind still stranded every pending return. This test
// asserts the WIRE itself -- that the rebind success path invokes the advance
// with the exact authority tuple -- so deleting the call makes it RED.
describe('an authorized coordinator rebind advances the returns it owns', () => {
  const TASK = 'tsk_wire';
  const COORD_ASSIGNMENT = 'asg_wire_coordinator';

  function wiredHandlers(advance: ReturnType<typeof vi.fn>) {
    const registry = new FakeRegistry();
    registry.statuses.set(TASK, 'implementing');
    registry.classifications.set(TASK, 'independent_top_level');
    registry.participants.set(TASK, ['deck_cd_brain']);
    registry.assignmentStates.set(TASK, [{
      assignmentId: COORD_ASSIGNMENT, role: 'coordinator', status: 'delegated', leaseId: 'lease',
      identity: testIdentity('deck_cd_brain'),
    }]);
    return { registry, handlers: createSupervisionMcpToolHandlers(CALLER, {
      resolveSessionIdentity: testResolveSessionIdentity,
      registry,
      isProjectBrain: () => true,
      advancePendingRepliesForReboundCoordinator: advance,
    } as never) };
  }

  it('invokes the advance with the exact task + coordinator assignment + rebound origin', async () => {
    const advance = vi.fn(() => 1);
    const { handlers } = wiredHandlers(advance);

    const result = await handlers[SUPERVISION_MCP_TOOLS.RECOVER]({
      taskId: TASK,
      assignmentId: COORD_ASSIGNMENT,
      rebindSessionName: 'deck_cd_brain',
      leaseAction: 'preserve',
      idempotencyKey: 'wire-1',
      reason: 'daemon restart rotated the coordinator runtime',
    });

    expect(result).toMatchObject({ status: 'ok' });
    expect(advance, 'the rebind success path must carry the pending returns with it').toHaveBeenCalledWith({
      taskId: TASK,
      coordinatorAssignmentId: COORD_ASSIGNMENT,
      origin: {
        sessionName: 'deck_cd_brain',
        sessionInstanceId: testIdentity('deck_cd_brain').sessionInstanceId,
        runtimeEpoch: testIdentity('deck_cd_brain').runtimeEpoch,
      },
    });
  });

  it('does not advance returns when the rebound assignment is not a coordinator', async () => {
    const advance = vi.fn(() => 0);
    const registry = new FakeRegistry();
    registry.statuses.set(TASK, 'implementing');
    registry.classifications.set(TASK, 'independent_top_level');
    registry.participants.set(TASK, ['deck_cd_brain']);
    registry.assignmentStates.set(TASK, [{
      assignmentId: 'asg_wire_worker', role: 'implementer', status: 'implementing', leaseId: 'lease',
      identity: testIdentity('deck_cd_brain'),
    }]);
    const handlers = createSupervisionMcpToolHandlers(CALLER, {
      resolveSessionIdentity: testResolveSessionIdentity,
      registry,
      isProjectBrain: () => true,
      advancePendingRepliesForReboundCoordinator: advance,
    } as never);

    await handlers[SUPERVISION_MCP_TOOLS.RECOVER]({
      taskId: TASK,
      assignmentId: 'asg_wire_worker',
      rebindSessionName: 'deck_cd_brain',
      leaseAction: 'preserve',
      idempotencyKey: 'wire-2',
      reason: 'worker rebind must not move coordinator returns',
    });

    expect(advance).not.toHaveBeenCalled();
  });
});
