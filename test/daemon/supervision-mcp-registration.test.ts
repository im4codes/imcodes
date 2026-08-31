import { beforeEach, describe, expect, it } from 'vitest';
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
    identity: { sessionName: string };
  }>>();
  applied: any[] = [];
  recovered: any[] = [];
  rebound: any[] = [];
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
      assignments: explicit ?? (this.participants.get(taskId) ?? []).map((sessionName, index) => ({
        assignmentId: `${taskId}-assignment-${index}`,
        role: 'implementer', status: this.statuses.get(taskId) ?? 'planned', leaseId: 'lease',
        identity: { sessionName },
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
  rebindTaskAssignmentRevision(input: any) {
    this.revisionRebound.push(input);
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
  const server = createMemoryMcpServer(CALLER, {}, {}, {
    registry,
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
  await client.callTool({ name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: '*' } });
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
    const server = createMemoryMcpServer(CALLER, {}, {}, { registry, isAdmin: () => true });
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
    const handlers = createSupervisionMcpToolHandlers(CALLER, { registry, isAdmin: () => true });
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
    const handlers = createSupervisionMcpToolHandlers(CALLER, { registry, isAdmin: () => true });
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
      identity: { sessionName: 'deck_cd_brain' },
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
      identity: { sessionName: 'deck_cd_brain' },
    }]);
    const audit = await call(SUPERVISION_MCP_TOOLS.INTENT, {
      intent: 'open_audit', taskId: 'tsk_a', assignmentId: 'rework-owner',
    });
    expect(audit).toMatchObject({
      status: 'ok', intent: 'open_audit', fromStatus: 'validated', toStatus: 'ready_for_audit',
    });
  });

  it('refuses integration_slice open_audit at the production MCP handler before registry mutation', async () => {
    registry.classifications.set('tsk_a', 'integration_slice');
    registry.statuses.set('tsk_a', 'validated');
    registry.assignmentStates.set('tsk_a', [{
      assignmentId: 'slice-worker', role: 'implementer', status: 'validated', leaseId: 'slice-lease',
      identity: { sessionName: 'deck_cd_brain' },
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
        identity: { sessionName: 'deck_cd_brain' },
      },
      {
        assignmentId: 'historical-auditor', role: 'auditor', status: 'auditing', leaseId: 'audit-lease',
        auditAttemptId: 'historical-attempt', identity: { sessionName: 'deck_historical_auditor' },
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
        identity: { sessionName: 'deck_cd_brain' },
      },
      {
        assignmentId: 'drifted-worker', role: 'implementer', status: 'validated', leaseId: 'worker-lease',
        identity: { sessionName: 'deck_same_worker' },
      },
      {
        assignmentId: 'accepted-auditor', role: 'auditor', status: 'passed', leaseId: 'audit-lease',
        auditAttemptId: 'accepted-attempt', identity: { sessionName: 'deck_auditor' },
      },
    ]);
    const live = {
      sessionName: 'deck_same_worker', sessionInstanceId: 'new-instance', runtimeEpoch: 'new-epoch',
      agentType: 'codex-sdk', providerFamily: 'openai', projectName: 'codedeck',
    };
    const brain = createSupervisionMcpToolHandlers(CALLER, {
      registry,
      isProjectBrain: () => true,
      resolveSessionIdentity: (name) => name === live.sessionName ? live : undefined,
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
    const owner = {
      sessionName: CALLER.sessionName!, sessionInstanceId: 'replacement-instance', runtimeEpoch: 'replacement-epoch',
      agentType: 'codex-sdk', providerFamily: 'openai',
    };
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
      const server = createMemoryMcpServer(CALLER, {}, {}, { registry: port, isAdmin: () => true });
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

  it('gives the live project Brain the project-wide authority used by the console snapshot', async () => {
    const brain = createSupervisionMcpToolHandlers(CALLER, {
      registry,
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
    const brain = createSupervisionMcpToolHandlers(CALLER, { registry, isProjectBrain: () => true });
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
    const participant = createSupervisionMcpToolHandlers(CALLER, { registry });
    expect(await participant[SUPERVISION_MCP_TOOLS.RECOVER](request))
      .toMatchObject({ status: 'error', reason: 'forbidden' });
    expect(registry.coordinated).toEqual([]);

    const brain = createSupervisionMcpToolHandlers(CALLER, {
      registry, isProjectBrain: () => true,
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
    const crossProjectTargetBrain = createSupervisionMcpToolHandlers(CALLER, {
      registry, isProjectBrain: () => true,
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
    const brain = createSupervisionMcpToolHandlers(CALLER, {
      registry, isProjectBrain: () => true,
    });
    expect(await brain[SUPERVISION_MCP_TOOLS.RECOVER]({
      taskId: 'tsk_a', assignmentId: 'tsk_a-assignment-0',
      taskStatus: 'rework', assignmentStatus: 'rework',
      leaseAction: 'preserve',
      idempotencyKey: 'cross-project-refused', reason: 'must stay project-scoped',
    })).toMatchObject({ status: 'error', reason: 'forbidden' });
    expect(registry.coordinated).toEqual([]);
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
    const participant = createSupervisionMcpToolHandlers(CALLER, { registry });
    expect(await participant[SUPERVISION_MCP_TOOLS.RECOVER](request))
      .toMatchObject({ status: 'error', reason: 'forbidden' });
    expect(registry.revisionRebound).toEqual([]);

    const brain = createSupervisionMcpToolHandlers(CALLER, {
      registry, isProjectBrain: () => true,
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
      sessionName: 'deck_production_recovery_worker',
      sessionInstanceId: 'instance-production-recovery-worker',
      runtimeEpoch: 'epoch-production-recovery-worker',
      agentType: 'codex-sdk', providerFamily: 'openai',
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
        auditRevision: toRevision, scopeFiles, leaseId: expect.stringMatching(/^supervision_lease_/),
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
    const participant = createSupervisionMcpToolHandlers(CALLER, {
      registry,
      resolveSessionIdentity: () => liveIdentity,
    });
    expect(await participant[SUPERVISION_MCP_TOOLS.RECOVER]({
      taskId: 'tsk_a', assignmentId: 'auditor-a', rebindSessionName: liveIdentity.sessionName,
      reason: 'authorized device replacement',
    })).toMatchObject({ status: 'error', reason: 'forbidden' });
    expect(registry.rebound).toEqual([]);

    const brain = createSupervisionMcpToolHandlers(CALLER, {
      registry,
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
      reason: 'authorized device replacement',
    }]);
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
    const participant = createSupervisionMcpToolHandlers(CALLER, { registry });
    expect(await participant[SUPERVISION_MCP_TOOLS.RECOVER]({
      taskId: 'tsk_a', toStatus: 'recovered', reason: 'repair cascade',
    })).toMatchObject({ status: 'error', reason: 'forbidden' });
    const projectBrain = createSupervisionMcpToolHandlers(CALLER, {
      registry, isProjectBrain: () => true,
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
      assignments: [{ identity: { sessionName: 'deck_cd_brain' } }],
    });
    const projectBrain = createSupervisionMcpToolHandlers(CALLER, {
      registry, isProjectBrain: () => true,
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
    const handlers = createSupervisionMcpToolHandlers(CALLER, {
      registry,
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
