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
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MEMORY_MCP_ENV_KEYS } from '../../shared/memory-mcp-env.js';
import { SUPERVISION_MCP_TOOLS } from '../../shared/supervision-mcp-tools.js';
import { MCP_TOOL_DISCOVERY_NAME } from '../../shared/mcp-tool-discovery.js';
import { createMemoryMcpServerFromEnv } from '../../src/daemon/memory-mcp-server.js';
import { createSupervisionRegistryPort } from '../../src/daemon/supervision-registry-port.js';
import {
  getSupervisionTaskRegistry,
  resetSupervisionTaskRegistryForTests,
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
      sessionName: SESSION,
      sessionInstanceId: `instance-${SESSION}`,
      runtimeEpoch: `epoch-${SESSION}`,
      agentType: 'codex-sdk',
      providerFamily: 'codex',
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
});
