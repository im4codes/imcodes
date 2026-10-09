import { mcpToolPayload } from '../helpers/mcp-tool-result.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryMcpServer, type MemoryMcpServerCatalogOptions } from '../../src/daemon/memory-mcp-server.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import type { MemoryMcpToolDeps } from '../../src/daemon/memory-mcp-tools.js';
import { MemoryMcpResourceGuard } from '../../src/daemon/memory-mcp-resource-guard.js';
import { MCP_TOOL_DISCOVERY_NAME } from '../../shared/mcp-tool-discovery.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import { PARTICIPANT_TURN_TOOL_REFUSAL } from '../../shared/participant-turn-tool-policy.js';
import { MEMORY_MCP_RESOURCE_ERROR } from '../../shared/session-resource-lifecycle.js';
import { CONTROLLED_NODE_ID_MIN } from '../../shared/controlled-node-identity.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';

const caller: McpRuntimeCaller = {
  userId: 'sdk-owner', namespace: { scope: 'user_private', userId: 'sdk-owner', projectId: 'sdk-project' },
  sessionName: 'deck_e2e_sdk_brain', projectName: 'sdk-project', projectRoot: '/var/tmp/imcodes-test-sdk',
  serverId: 'sdk-server', providerId: 'codex-sdk', transport: 'in_process',
};
const NODE = CONTROLLED_NODE_ID_MIN;
const machineDeps = () => ({
  listMachines: vi.fn(async () => [{ name: NODE, online: true, execEnabled: true, role: NODE_ROLE.CONTROLLED }]),
  computerUseCall: vi.fn(async ({ tool }: { tool: string }) => ({ outcome: 'completed' as const,
    result: { correlationId: 'sdk-correlation-123', ok: true, tool, content: [], durationMs: 1 } })),
  execRemote: vi.fn(async () => ({ outcome: 'not_dispatched' as const })),
});

type Invocation = [string, Record<string, unknown>];
const executeCalls: Invocation[] = [
  [MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE, { machine: NODE, command: 'id' }],
  [MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_CALL, { machine: NODE, tool: 'shell_session1', arguments: { command: 'id', shell: 'sh' } }],
  [MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_CALL, { machine: NODE, tool: 'list_apps', arguments: {} }],
  [MEMORY_MCP_TOOL_NAMES.SEND_FILE_TO_MACHINE, { machine: NODE, sourcePath: '/var/tmp/imcodes-test-sdk/a' }],
  [MEMORY_MCP_TOOL_NAMES.FETCH_FILE_FROM_MACHINE, { machine: NODE, sourcePath: '/var/tmp/imcodes-test-sdk/a', destinationPath: '/var/tmp/imcodes-test-sdk/b' }],
];


async function withClient(
  deps: MemoryMcpToolDeps,
  run: (client: Client) => Promise<void>,
  options: MemoryMcpServerCatalogOptions = {},
): Promise<void> {
  const server = createMemoryMcpServer({ ...caller, ...(options.resourceGuard ? { transport: 'stdio' } : {}) }, deps, {}, {}, options);
  const client = new Client({ name: 'sdk-error-boundary-client', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  try { await run(client); } finally { await client.close(); await server.close(); }
}

async function invoke(client: Client, [name, args]: Invocation, fallback: boolean): Promise<CallToolResult> {
  await client.callTool({ name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: name } });
  // Critical causal condition: cache the actual advertised outputSchema. A
  // Client that never lists tools does not exercise its output validator.
  const listed = await client.listTools();
  expect(listed.tools.find((tool) => tool.name === name)?.outputSchema).toBeDefined();
  return await client.callTool(fallback ? {
    name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: name, fallbackCall: { name, arguments: args } },
  } : { name, arguments: args }) as CallToolResult;
}

describe.each([false, true])('real SDK typed-error interoperability (fallback=%s)', (fallback) => {
  it.each(executeCalls)('participant %s refuses cleanly, preserves typed reason, never dispatches (%j)', async (name, args) => {
    const deps = machineDeps();
    await withClient({ machineDeps: deps, participantTurnRequired: async () => true }, async (client) => {
      const result = await invoke(client, [name, args], fallback);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(mcpToolPayload(result)).toMatchObject({ status: 'error', reason: PARTICIPANT_TURN_TOOL_REFUSAL });
    });
    expect(deps.computerUseCall).not.toHaveBeenCalled();
    expect(deps.execRemote).not.toHaveBeenCalled();
  });

  it.each(executeCalls)('handler dependency error for %s is usable typed JSON, not client -32602 (%j)', async (name, args) => {
    await withClient({}, async (client) => {
      const result = await invoke(client, [name, args], fallback);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(mcpToolPayload(result)).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.FEATURE_DISABLED });
    });
  });

  it('list_machines control-plane failure preserves reason while a valid list still satisfies its schema', async () => {
    await withClient({ machineDeps: { listMachines: async () => { throw new Error('network down'); } } }, async (client) => {
      const result = await invoke(client, [MEMORY_MCP_TOOL_NAMES.LIST_MACHINES, {}], fallback);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(mcpToolPayload(result).reason).toBe(MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE);
    });
    await withClient({ machineDeps: machineDeps() }, async (client) => {
      const result = await invoke(client, [MEMORY_MCP_TOOL_NAMES.LIST_MACHINES, {}], fallback);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ status: 'ok', machines: [{ name: NODE }] });
    });
  });

  it('owner computer_use and docs success stay structured and schema-valid', async () => {
    await withClient({ machineDeps: machineDeps(), participantTurnRequired: async () => false }, async (client) => {
      const result = await invoke(client, [MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_CALL, { machine: NODE, tool: 'list_apps' }], fallback);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ status: 'ok', outcome: 'completed' });
      const docs = await invoke(client, [MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_DOCS, { topic: 'overview' }], fallback);
      expect(docs.isError).not.toBe(true);
      expect(docs.structuredContent).toMatchObject({ status: 'ok', topic: 'overview' });
    });
  });

  it('resource admission refusal remains a tool error, without calling the handler', async () => {
    const deps = machineDeps();
    const guard = new MemoryMcpResourceGuard({ maxConcurrent: 1, maxRssBytes: 1, requestTimeoutMs: 1000, memoryUsage: () => ({ rss: 2 }) });
    await withClient({ machineDeps: deps }, async (client) => {
      // stdio resource guard gates discovery as well; the static catalog
      // hydrates output validators before the intentionally overloaded call.
      await client.listTools();
      const result = await client.callTool(fallback ? {
        name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: MEMORY_MCP_TOOL_NAMES.LIST_MACHINES,
          fallbackCall: { name: MEMORY_MCP_TOOL_NAMES.LIST_MACHINES, arguments: {} } },
      } : { name: MEMORY_MCP_TOOL_NAMES.LIST_MACHINES, arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(MEMORY_MCP_RESOURCE_ERROR.MEMORY_LIMIT);
      expect(deps.listMachines).not.toHaveBeenCalled();
    }, { resourceGuard: guard, toolCatalogMode: 'static_full' });
  });
});
