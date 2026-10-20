import { mcpToolPayload } from '../helpers/mcp-tool-result.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import type { CapabilityService } from '../../shared/capability-management.js';
import { MCP_TOOL_DISCOVERY_NAME } from '../../shared/mcp-tool-discovery.js';
import { MEMORY_MCP_TOOL_NAMES as N } from '../../shared/memory-mcp-contracts.js';
import { PARTICIPANT_TURN_TOOL_POLICY, PARTICIPANT_TURN_TOOL_REFUSAL, isToolAllowedInParticipantTurn } from '../../shared/participant-turn-tool-policy.js';
import { createMemoryMcpServer, participantTurnFromAuthorityHook } from '../../src/daemon/memory-mcp-server.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';

const caller: McpRuntimeCaller = {
  userId: 'owner-1', namespace: { scope: 'user_private', userId: 'owner-1', projectId: 'project-1' }, sessionName: 'deck_project_brain',
  projectName: 'project', serverId: 'server-1', providerId: 'codex-sdk', transport: 'in_process',
};

it('the participant-only deny set is exactly exec_remote, including every registered and future tool', () => {
  const server = createMemoryMcpServer(caller, { capabilityService: {} as CapabilityService });
  const registered = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
  expect(registered.length).toBeGreaterThan(60);
  expect(Object.keys(PARTICIPANT_TURN_TOOL_POLICY)).toEqual([N.EXEC_REMOTE]);
  for (const name of [...registered, ...Object.values(N), 'future_registered_tool', 'EXEC_REMOTE', 'shell_session1', 'constructor', 'toString', '__proto__']) {
    expect(isToolAllowedInParticipantTurn(name), name).toBe(name !== N.EXEC_REMOTE);
  }
});

const origins = [
  ['participant', async () => true, true],
  ['owner', async () => false, false],
  ['unreachable authority', async () => { throw new Error('daemon unreachable'); }, true],
  ['missing turn hook', undefined, false],
] as const;

describe.each(origins)('%s origin', (_label, participantTurnRequired, denied) => {
  it.each([false, true])('only exec_remote is gated (fallback=%s); original schemas and unknown-name rejection remain', async (fallback) => {
    const resolveAlias = vi.fn(async () => ({ status: 'ok', found: false }));
    const capabilityList = vi.fn(async () => ({ status: 'ok', items: [] }));
    const execRemote = vi.fn(async () => ({ outcome: 'completed', ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false, truncated: false, durationMs: 1 }));
    const computerUseCall = vi.fn(async ({ tool }: { tool: string }) => ({ outcome: 'completed', result: { correlationId: 'cu-12345678', ok: true, tool, content: [], durationMs: 1 } }));
    const turn = participantTurnRequired ? vi.fn(participantTurnRequired) : undefined;
    const server = createMemoryMcpServer(caller, { participantTurnRequired: turn, capabilityService: { list: capabilityList } as never, machineDeps: {
      listMachines: async () => [], execRemote, computerUseCall,
    } as never }, { resolveAlias: resolveAlias as never });
    const client = new Client({ name: 'participant-turn-gate-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    const invoke = async (name: string, args: Record<string, unknown>) => {
      await client.callTool({ name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: name } });
      await client.listTools(); // cache advertised success schemas: real SDK output validation
      return client.callTool(fallback ? { name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: name, fallbackCall: { name, arguments: args } } } : { name, arguments: args });
    };
    try {
      const alias = await invoke('resolve_alias', { name: 'test-alias' });
      expect(alias.isError).not.toBe(true);
      expect(resolveAlias).toHaveBeenCalledTimes(1);
      for (const name of [N.CRON_LIST, N.SESSION_IDENTITY_GET, N.VERIFICATION_MACHINE_LIST, 'execution_pool_get', 'capability_list']) {
        const result = await invoke(name, {});
        expect(mcpToolPayload(result).reason, name).not.toBe(PARTICIPANT_TURN_TOOL_REFUSAL);
        expect(JSON.stringify(result), name).not.toContain('-32602');
      }
      expect(capabilityList).toHaveBeenCalledTimes(1);
      for (const tool of ['list_apps', 'shell_session1', 'click']) {
        const cu = await invoke(N.COMPUTER_USE_CALL, { machine: 'node-1', tool, arguments: {} });
        expect(cu.isError, tool).not.toBe(true);
      }
      expect(computerUseCall).toHaveBeenCalledTimes(3);
      expect(turn?.mock.calls.length ?? 0).toBe(0);
      const exec = await invoke(N.EXEC_REMOTE, { machine: 'node-1', command: 'id' });
      if (denied) {
        expect(exec.isError).toBe(true);
        expect(mcpToolPayload(exec)).toMatchObject({ reason: PARTICIPANT_TURN_TOOL_REFUSAL });
      } else expect(exec.isError).not.toBe(true);
      expect(execRemote).toHaveBeenCalledTimes(denied ? 0 : 1);
      expect(turn?.mock.calls.length ?? 0).toBe(turn ? 1 : 0);
      // No policy allow decision may mint a tool, accept a caller schema, or weaken its original schema.
      const unknown = await client.callTool({ name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: 'not_registered', fallbackCall: { name: 'not_registered', arguments: {} } } });
      expect(unknown.isError).toBe(true);
      expect(mcpToolPayload(unknown).reason).not.toBe(PARTICIPANT_TURN_TOOL_REFUSAL);
      expect((await client.callTool({ name: 'not_registered', arguments: {} })).isError).toBe(true);
      expect((await client.callTool({ name: 'resolve_alias', arguments: {} })).isError).toBe(true);
      expect(resolveAlias).toHaveBeenCalledTimes(1);
    } finally { await client.close(); await server.close(); }
  });
});

it('exec_remote rechecks every call as owner and participant turns alternate', async () => {
  let participant = true;
  const execRemote = vi.fn(async () => ({ outcome: 'not_dispatched', reason: 'exec_disabled', error: 'disabled' }));
  const server = createMemoryMcpServer(caller, { participantTurnRequired: async () => participant, machineDeps: { listMachines: async () => [], execRemote } as never });
  const client = new Client({ name: 'alternating-turn-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    await client.callTool({ name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: N.EXEC_REMOTE } });
    for (const origin of [true, false, true, false]) {
      participant = origin;
      const result = await client.callTool({ name: N.EXEC_REMOTE, arguments: { machine: 'node-1', command: 'id' } });
      expect(mcpToolPayload(result).reason).toBe(origin ? PARTICIPANT_TURN_TOOL_REFUSAL : 'exec_disabled');
    }
    expect(execRemote).toHaveBeenCalledTimes(2);
  } finally { await client.close(); await server.close(); }
});

it('unknown/missing authority fails closed for exec_remote and private projections without changing provenance', async () => {
  for (const answer of [{}, { ok: true }, { required: false }, { ok: false, required: false }, { ok: true, required: 'false' }, { ok: true, required: true, authority: null }]) {
    expect(await participantTurnFromAuthorityHook(async () => answer)()).toBe(true);
  }
  expect(await participantTurnFromAuthorityHook(async () => ({ ok: true, required: false, authority: null }))()).toBe(false);
  expect(await participantTurnFromAuthorityHook(async () => { throw new Error('unreachable'); })()).toBe(true);
});
