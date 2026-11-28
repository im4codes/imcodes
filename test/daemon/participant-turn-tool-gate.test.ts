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

const DENIED_PARTICIPANT_TOOLS: readonly string[] = [];

it('participant turns allow capability install/manage and leave cross-device, alias, and other tools governed by their own server/actor checks', () => {
  const server = createMemoryMcpServer(caller, { capabilityService: {} as CapabilityService });
  const registered = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
  expect(registered.length).toBeGreaterThan(60);
  expect(Object.keys(PARTICIPANT_TURN_TOOL_POLICY).sort()).toEqual([...DENIED_PARTICIPANT_TOOLS].sort());
  for (const name of [
    ...registered,
    'capability_install',
    'capability_manage',
    'capability_list',
    'capability_status',
    'future_registered_tool',
    'constructor',
    'toString',
    '__proto__',
  ]) {
    expect(isToolAllowedInParticipantTurn(name), name).toBe(true);
  }
});

const origins = [
  ['participant', async () => true, false],
  ['owner', async () => false, false],
  ['unreachable authority', async () => { throw new Error('daemon unreachable'); }, false],
  ['missing turn hook', undefined, false],
] as const;

describe.each(origins)('%s origin', (_label, participantTurnRequired, denied) => {
  it.each([false, true])('allows capability_install/manage while leaving cross-device & alias tools governed by server admission (fallback=%s)', async (fallback) => {
    const resolveAlias = vi.fn(async () => ({ status: 'ok', found: false }));
    const capabilityList = vi.fn(async () => ({ status: 'ok', items: [] }));
    const runAgentMcp = vi.fn(async () => ({ ok: true as const, results: [{ agent: 'codex', ok: true }] }));
    const manageCap = vi.fn(async () => ({ status: 'ok' as const }));
    const execRemote = vi.fn(async () => ({ outcome: 'completed', ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false, truncated: false, durationMs: 1 }));
    const computerUseCall = vi.fn(async ({ tool }: { tool: string }) => ({ outcome: 'completed', result: { correlationId: 'cu-12345678', ok: true, tool, content: [], durationMs: 1 } }));
    const openPortForward = vi.fn(async () => ({
      ok: true as const,
      tunnel: {
        tunnelId: 't1',
        listenNode: 'node-0',
        listenHost: '127.0.0.1',
        listenPort: 1234,
        localEndpoint: '127.0.0.1:1234',
        targetNode: '1234567890',
        targetHost: '127.0.0.1',
        targetPort: 8080,
        expiresAt: Date.now() + 60_000,
        transportMode: 'relay' as const,
      },
    }));
    const turn = participantTurnRequired ? vi.fn(participantTurnRequired) : undefined;
    const server = createMemoryMcpServer(caller, {
      participantTurnRequired: turn,
      capabilityService: { list: capabilityList, install: vi.fn(), manage: manageCap, status: vi.fn() } as never,
      runAgentMcp,
      machineDeps: {
        listMachines: async () => [],
        execRemote,
        computerUseCall,
        portForwardOpen: openPortForward,
      } as never,
    }, { resolveAlias: resolveAlias as never });
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

      const capInstall = await invoke('capability_install', {
        kind: 'mcp',
        source: { kind: 'url', value: 'https://mcp.example.com' },
      });
      expect(Boolean(capInstall.isError)).toBe(denied);
      if (denied) {
        expect(mcpToolPayload(capInstall).reason).toBe(PARTICIPANT_TURN_TOOL_REFUSAL);
        expect(runAgentMcp).not.toHaveBeenCalled();
      } else {
        expect(runAgentMcp).toHaveBeenCalledTimes(1);
      }

      const capManage = await invoke('capability_manage', {
        action: 'enable',
        capabilityId: 'cap-1',
        bindingId: 'bind-1',
      });
      expect(Boolean(capManage.isError)).toBe(denied);
      if (denied) {
        expect(mcpToolPayload(capManage).reason).toBe(PARTICIPANT_TURN_TOOL_REFUSAL);
        expect(manageCap).not.toHaveBeenCalled();
      } else {
        expect(manageCap).toHaveBeenCalledTimes(1);
      }

      const pf = await invoke(N.PORT_FORWARD_OPEN, { targetNode: '1234567890', targetPort: 8080 });
      expect(pf.isError).not.toBe(true);
      expect(openPortForward).toHaveBeenCalledTimes(1);

      for (const name of [N.CRON_LIST, N.SESSION_IDENTITY_GET, N.VERIFICATION_MACHINE_LIST, 'execution_pool_get', 'capability_list']) {
        const result = await invoke(name, {});
        expect(mcpToolPayload(result).reason, name).not.toBe(PARTICIPANT_TURN_TOOL_REFUSAL);
        expect(JSON.stringify(result), name).not.toContain('-32602');
      }
      expect(capabilityList).toHaveBeenCalledTimes(1);

      for (const tool of ['list_apps', 'shell_session1', 'click']) {
        const cu = await invoke(N.COMPUTER_USE_CALL, { machine: '1234567890', tool, arguments: {} });
        expect(cu.isError, tool).not.toBe(true);
      }
      expect(computerUseCall).toHaveBeenCalledTimes(3);

      const exec = await invoke(N.EXEC_REMOTE, { machine: '1234567890', command: 'id' });
      expect(exec.isError).not.toBe(true);
      expect(execRemote).toHaveBeenCalledTimes(1);

      // No policy allow decision may mint a tool, accept a caller schema, or weaken its original schema.
      const unknown = await client.callTool({ name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: 'not_registered', fallbackCall: { name: 'not_registered', arguments: {} } } });
      expect(unknown.isError).toBe(true);
      expect(mcpToolPayload(unknown).reason).not.toBe(PARTICIPANT_TURN_TOOL_REFUSAL);
      expect((await client.callTool({ name: 'not_registered', arguments: {} })).isError).toBe(true);
      expect((await client.callTool({ name: 'resolve_alias', arguments: {} })).isError).toBe(true);
    } finally { await client.close(); await server.close(); }
  });
});

it('capability_install allows both owner and participant turns as turns alternate', async () => {
  let participant = true;
  const runAgentMcp = vi.fn(async () => ({ ok: true as const, results: [] }));
  const server = createMemoryMcpServer(caller, {
    participantTurnRequired: async () => participant,
    capabilityService: { list: vi.fn(), install: vi.fn(), manage: vi.fn(), status: vi.fn() } as never,
    runAgentMcp,
  });
  const client = new Client({ name: 'alternating-turn-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    await client.callTool({ name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: 'capability_install' } });
    for (const origin of [true, false, true, false]) {
      participant = origin;
      const result = await client.callTool({
        name: 'capability_install',
        arguments: { kind: 'mcp', source: { kind: 'url', value: 'https://mcp.example.com' } },
      });
      expect(result.isError).not.toBe(true);
    }
    expect(runAgentMcp).toHaveBeenCalledTimes(4);
  } finally { await client.close(); await server.close(); }
});

it('unknown/missing authority fails closed for exec_remote and private projections without changing provenance', async () => {
  for (const answer of [{}, { ok: true }, { required: false }, { ok: false, required: false }, { ok: true, required: 'false' }, { ok: true, required: true, authority: null }]) {
    expect(await participantTurnFromAuthorityHook(async () => answer)()).toBe(true);
  }
  expect(await participantTurnFromAuthorityHook(async () => ({ ok: true, required: false, authority: null }))()).toBe(false);
  expect(await participantTurnFromAuthorityHook(async () => { throw new Error('unreachable'); })()).toBe(true);
});
