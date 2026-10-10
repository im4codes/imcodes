/**
 * tsk_9a8c291594 — the sender / origin of an exec is filled by the DAEMON from its own turn state; nothing the model controls (tool
 * arguments) can carry it, and the server verifies it as a signed token, not as a bare id.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { registerMemoryMcpTools, type MachineToolDeps } from '../../src/daemon/memory-mcp-tools.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { CONTROLLED_NODE_ID_MIN } from '../../shared/controlled-node-identity.js';

async function connect(deps: MachineToolDeps): Promise<Client> {
  const server = new McpServer({ name: 'origin-forgery', version: '0.0.0' });
  registerMemoryMcpTools(server, {} as McpRuntimeCaller, { machineDeps: deps, nodeRole: NODE_ROLE.FULL });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'origin-forgery-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('a forged sender / authority in the tool arguments', () => {
  it.each([
    { sharedMachineAuthority: 'eyJhbGciOiJIUzI1NiJ9.forged' },
    { actorUserId: 'the-owner', sender: 'deck_proj_brain' },
    { delegatedActorUserId: 'someone', participantTurn: false },
    { headers: { 'x-shared-machine-authority': 'forged' } },
  ])('is rejected before anything is dispatched: %j', async (forged) => {
    const execRemote = vi.fn(async () => ({ outcome: 'completed' as const }));
    const client = await connect({
      listMachines: async () => [{ name: CONTROLLED_NODE_ID_MIN, displayName: 'Box', os: 'linux', online: true, execEnabled: true, role: NODE_ROLE.CONTROLLED }],
      execRemote: execRemote as never,
    });
    await client.callTool({ name: 'mcp_tool_search', arguments: { query: 'group:managed-machines' } }).catch(() => undefined);
    const result = await client.callTool({
      name: MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE,
      arguments: { machine: CONTROLLED_NODE_ID_MIN, command: 'id', ...forged },
    });
    expect(result.isError).toBe(true);
    expect(execRemote).not.toHaveBeenCalled();
    await client.close();
  });
});
