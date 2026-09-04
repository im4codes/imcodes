/**
 * The supervision MCP tools must be BOUND to the real registry in production.
 *
 * They were not. `createMemoryMcpServerFromEnv()` constructed the server with
 * three arguments, so the fourth (`supervisionToolDeps`) fell back to `{}` and
 * every call answered `unavailable: supervision registry not bound`. The tools
 * were published on the surface and permanently inert — a shape no unit test of
 * the handlers could catch, because every handler test injected its own port.
 *
 * These tests therefore go through the REAL construction path.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// Supervision authority now resolves the caller's LIVE identity from the daemon
// session store. These tests exercise the PRODUCTION entry point, so the caller
// must exist as a live session; the real store is the user's sessions.json and
// must never be written by a test.
const LIVE_CALLER = vi.hoisted(() => ({
  name: 'deck_alpha_brain',
  role: 'w1' as const,
  projectName: 'alpha',
  agentType: 'codex-sdk',
  sessionInstanceId: 'instance-deck_alpha_brain',
  runtimeEpoch: 'epoch-deck_alpha_brain',
  state: 'idle',
  projectDir: '/work/alpha',
}));
vi.mock('../../src/store/session-store.js', () => ({
  listSessions: () => [LIVE_CALLER],
  getSession: (name: string) => (name === LIVE_CALLER.name ? LIVE_CALLER : undefined),
  upsertSession: () => {},
}));
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MEMORY_MCP_ENV_KEYS } from '../../shared/memory-mcp-env.js';
import { SUPERVISION_MCP_TOOLS } from '../../shared/supervision-mcp-tools.js';
import { MCP_TOOL_DISCOVERY_NAME } from '../../shared/mcp-tool-discovery.js';
import { createMemoryMcpServerFromEnv } from '../../src/daemon/memory-mcp-server.js';
import { createSupervisionRegistryPort } from '../../src/daemon/supervision-registry-port.js';
import { resolvePeerAuditProviderFamily } from '../../src/daemon/peer-audit-candidates.js';
import {
  getSupervisionTaskRegistry,
  resetSupervisionTaskRegistryForTests,
  setSupervisionLiveParticipantsResolver,
} from '../../src/daemon/supervision-state-store.js';

const SESSION = 'deck_alpha_brain';
const namespace = { scope: 'user_private', userId: 'user-1', projectId: 'repo-1' };

function serverEnv() {
  return {
    [MEMORY_MCP_ENV_KEYS.USER_ID]: 'user-1',
    [MEMORY_MCP_ENV_KEYS.NAMESPACE]: JSON.stringify(namespace),
    [MEMORY_MCP_ENV_KEYS.SESSION_NAME]: SESSION,
    [MEMORY_MCP_ENV_KEYS.PROJECT_NAME]: 'alpha',
    [MEMORY_MCP_ENV_KEYS.PROJECT_ROOT]: '/work/alpha',
  };
}

/** Connect a client to the server built by the PRODUCTION entry point. */
async function connectProductionServer() {
  const server = createMemoryMcpServerFromEnv({ env: serverEnv() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'supervision-binding-test', version: '0.1.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  await client.callTool({
    name: MCP_TOOL_DISCOVERY_NAME,
    arguments: { query: SUPERVISION_MCP_TOOLS.LIST },
  });
  return { client, close: () => client.close() };
}

async function callList(client: Client): Promise<Record<string, unknown>> {
  const res = await client.callTool({ name: SUPERVISION_MCP_TOOLS.LIST, arguments: {} });
  return (res as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}

/** A task the caller participates in, so LIST has something real to project. */
function seedTaskOwnedByCaller(taskKey: string, scopeFiles: string[] = []): string {
  const registry = getSupervisionTaskRegistry();
  const task = registry.createOrGet({ objective: `objective ${taskKey}`, idempotencyKey: taskKey });
  if (!task.ok) throw new Error(`seed failed: ${task.reason}`);
  const assignment = registry.createAssignment({
    taskId: task.value.taskId,
    role: 'implementer',
    identity: {
      sessionName: LIVE_CALLER.name,
      sessionInstanceId: LIVE_CALLER.sessionInstanceId,
      runtimeEpoch: LIVE_CALLER.runtimeEpoch,
      agentType: LIVE_CALLER.agentType,
      providerFamily: resolvePeerAuditProviderFamily(LIVE_CALLER as never),
    },
    scopeFiles,
    idempotencyKey: taskKey,
  });
  if (!assignment.ok) throw new Error(`assignment failed: ${assignment.reason}`);
  return task.value.taskId;
}

beforeEach(() => resetSupervisionTaskRegistryForTests());
afterEach(() => resetSupervisionTaskRegistryForTests());

describe('supervision registry binding', () => {
  it('binds the real registry through the production server entry point', async () => {
    const taskId = seedTaskOwnedByCaller('binding-1');
    const { client, close } = await connectProductionServer();
    try {
      const result = await callList(client);
      // The exact regression: this used to be
      // { status: 'error', reason: 'unavailable' }.
      expect(result.reason).not.toBe('unavailable');
      expect(result.status).toBe('ok');
      expect((result.tasks as { taskId: string }[]).map((t) => t.taskId)).toContain(taskId);
    } finally {
      await close();
    }
  });

  it('stays bound across a registry reopen, as happens on daemon restart', async () => {
    seedTaskOwnedByCaller('binding-before-restart');
    const port = createSupervisionRegistryPort();
    expect(port.list({ ownerSessionName: SESSION }).length).toBeGreaterThan(0);

    // Simulate the restart: the singleton is closed and the database reopened.
    // A port that captured the registry once would now hold a CLOSED handle and
    // report itself bound while failing -- strictly worse than the unbound
    // error, because it fails silently.
    resetSupervisionTaskRegistryForTests();
    const reseededTaskId = seedTaskOwnedByCaller('binding-after-restart');

    const rows = port.list({ ownerSessionName: SESSION });
    expect(rows.map((row) => (row as { taskId: string }).taskId)).toContain(reseededTaskId);
    // 'delegated', not 'planned': creating the assignment advances the task.
    // Reading it through the port at all is the point -- a stale handle could
    // not answer.
    expect(port.getStatus(reseededTaskId)).toBe('delegated');
  });

  it('keeps the production registry bound while overlapping scopes remain claim-free', async () => {
    const firstTaskId = seedTaskOwnedByCaller('overlap-first', ['src/shared.ts']);
    const secondTaskId = seedTaskOwnedByCaller('overlap-second', ['src/shared.ts']);
    const registry = getSupervisionTaskRegistry();
    expect(registry.get(firstTaskId)?.fileClaims).toEqual([]);
    expect(registry.get(secondTaskId)?.fileClaims).toEqual([]);
    expect(registry.findByFile('src/shared.ts')).toEqual([]);

    const { client, close } = await connectProductionServer();
    try {
      const result = await callList(client);
      expect(result.status).toBe('ok');
      expect((result.tasks as { taskId: string }[]).map((task) => task.taskId))
        .toEqual(expect.arrayContaining([firstTaskId, secondTaskId]));
    } finally {
      await close();
    }
  });

  it('binds bounded housekeeping to the current real registry rather than a captured handle', () => {
    seedTaskOwnedByCaller('housekeeping-before-reopen');
    const port = createSupervisionRegistryPort();
    expect(port.housekeeping({ mode: 'dryRun', projectName: '__legacy_unscoped__', limit: 1 })).toMatchObject({
      mode: 'dryRun', scanned: 1, applyAuthorized: false,
    });
    resetSupervisionTaskRegistryForTests();
    seedTaskOwnedByCaller('housekeeping-after-reopen');
    expect(port.housekeeping({ mode: 'dryRun', projectName: '__legacy_unscoped__', limit: 10 })).toMatchObject({
      mode: 'dryRun', scanned: expect.any(Number), applyAuthorized: false,
    });
  });

  it('wires the live-participant resolver through the MCP construction path, not only lifecycle.startup', async () => {
    // R13 audit P1: the resolver was registered ONLY in lifecycle.startup().
    // `imcodes memory mcp` runs as a SEPARATE process with its own module
    // state, so in the process that actually serves supervision tools the
    // resolver stayed undefined, restart identity convergence never ran, and a
    // rotated same-name owner was refused with owner_mismatch in production
    // while the startup-based test stayed green.
    setSupervisionLiveParticipantsResolver(undefined); // a fresh MCP process
    resetSupervisionTaskRegistryForTests();
    const registry = getSupervisionTaskRegistry();
    const taskId = 'tsk_mcp_rotate';
    expect(registry.createOrGet({
      taskId, projectName: LIVE_CALLER.projectName, classification: 'independent_top_level',
      objective: 'mcp resolver wiring', currentRevision: 'rev-mcp-1',
    } as never)).toMatchObject({ ok: true });
    const stale = {
      sessionName: LIVE_CALLER.name,
      sessionInstanceId: 'instance-before',
      runtimeEpoch: 'epoch-before',
      agentType: LIVE_CALLER.agentType,
      providerFamily: resolvePeerAuditProviderFamily(LIVE_CALLER as never),
    };
    const owner = registry.createAssignment({
      taskId, role: 'implementer', identity: stale, scopeFiles: ['src/exact.ts'],
    } as never);
    if (!owner.ok) throw new Error('owner: ' + owner.reason);
    const rotated = {
      ...stale,
      sessionInstanceId: LIVE_CALLER.sessionInstanceId,
      runtimeEpoch: LIVE_CALLER.runtimeEpoch,
    };

    // Before the MCP server is constructed the process has no resolver at all.
    expect(registry.updateAssignment({
      assignmentId: owner.value.assignmentId, identity: rotated, status: 'implementing',
    } as never)).toMatchObject({ ok: false, reason: 'owner_mismatch' });

    // Going through the REAL MCP construction path must wire it.
    const { close } = await connectProductionServer();
    try {
      expect(registry.updateAssignment({
        assignmentId: owner.value.assignmentId, identity: rotated, status: 'implementing',
      } as never)).toMatchObject({ ok: true });
      const bound = registry.getAssignment(owner.value.assignmentId)!;
      expect(bound.assignmentId).toBe(owner.value.assignmentId); // same object
      expect(bound.identity.runtimeEpoch).toBe(LIVE_CALLER.runtimeEpoch);

      // Fail-closed still holds for an identity the daemon does not observe.
      expect(registry.updateAssignment({
        assignmentId: owner.value.assignmentId,
        identity: { ...stale, sessionInstanceId: 'ghost', runtimeEpoch: 'ghost-epoch' },
        status: 'implementing',
      } as never)).toMatchObject({ ok: false, reason: 'owner_mismatch' });
      // ...and for a same-name candidate whose agent/provider differ.
      expect(registry.updateAssignment({
        assignmentId: owner.value.assignmentId,
        identity: { ...rotated, agentType: 'claude-code-sdk', providerFamily: 'anthropic' },
        status: 'implementing',
      } as never)).toMatchObject({ ok: false, reason: 'owner_mismatch' });
    } finally {
      await close();
    }
  });
});
