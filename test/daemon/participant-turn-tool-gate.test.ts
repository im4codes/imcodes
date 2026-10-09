/**
 * tsk_854675e1e2: while a shared-session PARTICIPANT's message drives the turn, the agent answers on the owner's machine with the owner's
 * tools. Only the machine tools followed the participant's own access; cron (jobs that later run as the owner), the owner's aliases and
 * pins, memory writes and preferences, restart/close/model of other sessions, capability installs and pair lifecycle all ran with the
 * owner's authority. The MCP server now refuses every tool the policy does not list, for a participant turn only.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import type { CapabilityService } from '../../shared/capability-management.js';
import { MCP_TOOL_DISCOVERY_NAME } from '../../shared/mcp-tool-discovery.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import {
  PARTICIPANT_TURN_TOOL_POLICY,
  PARTICIPANT_TURN_TOOL_REFUSAL,
  isToolAllowedInParticipantTurn,
} from '../../shared/participant-turn-tool-policy.js';
import { createMemoryMcpServer, participantTurnFromAuthorityHook } from '../../src/daemon/memory-mcp-server.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';

function caller(): McpRuntimeCaller {
  return {
    userId: 'owner-1', namespace: { scope: 'user_private', userId: 'owner-1', projectId: 'project-1' }, sessionName: 'deck_project_brain',
    projectName: 'project', projectRoot: '/tmp/project', serverId: 'server-1', providerId: 'codex-sdk', transport: 'in_process',
  };
}

const capabilityService: CapabilityService = {
  list: vi.fn(async () => ({ status: 'ok', items: [] })),
  install: vi.fn(async () => ({ status: 'ok' })),
  status: vi.fn(async () => ({ status: 'ok' })),
  manage: vi.fn(async () => ({ status: 'ok' })),
} as unknown as CapabilityService;

describe('participant-turn tool policy', () => {
  it('classifies every tool the server registers, and every named tool constant (a new tool cannot slip through unclassified)', () => {
    const server = createMemoryMcpServer(caller(), { capabilityService });
    const registered = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    expect(registered.length).toBeGreaterThan(60);
    const unclassified = registered.filter((name) => !(name in PARTICIPANT_TURN_TOOL_POLICY));
    expect(unclassified, `unclassified tools: ${unclassified.join(', ')}`).toEqual([]);
    for (const name of Object.values(MEMORY_MCP_TOOL_NAMES)) expect(name in PARTICIPANT_TURN_TOOL_POLICY, name).toBe(true);
  });

  it('refuses an unlisted tool and lets the agent-to-agent, read and discovery tools through', () => {
    expect(isToolAllowedInParticipantTurn('a_tool_added_next_year')).toBe(false);
    for (const allowed of ['send_message', 'send_list_targets', 'delegation_reply', 'search_memory', 'list_machines', 'mcp_tool_search']) {
      expect(isToolAllowedInParticipantTurn(allowed), allowed).toBe(true);
    }
    for (const denied of ['cron_create', 'cron_create_self', 'resolve_alias', 'save_alias', 'pin_message', 'list_message_pins', 'save_preference',
      'update_memory', 'delete_memory', 'session_restart', 'session_close', 'session_model', 'send_stop', 'capability_install', 'capability_manage',
      'pair_create', 'session_identity_set', 'execution_pool_set', 'verification_machine_set',
      // tsk_9a8c291594: execute-class machine tools never run on a participant-started turn.
      'exec_remote', 'send_file_to_machine', 'fetch_file_from_machine', 'computer_use_call']) {
      expect(isToolAllowedInParticipantTurn(denied), denied).toBe(false);
    }
  });
});

async function withClient(
  participantTurnRequired: (() => Promise<boolean>) | undefined,
  exact: { resolveAlias?: ReturnType<typeof vi.fn> },
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const server = createMemoryMcpServer(caller(), { ...(participantTurnRequired ? { participantTurnRequired } : {}) }, {
    ...(exact.resolveAlias ? { resolveAlias: exact.resolveAlias as never } : {}),
  });
  const client = new Client({ name: 'participant-turn-gate-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await client.callTool({ name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: 'group:aliases-pins' } });
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe('participant-turn gate on the MCP server', () => {
  it('refuses a denied tool on a participant turn before the tool runs, and allows an owner turn', async () => {
    const resolveAlias = vi.fn(async () => ({ status: 'ok', found: true, alias: { name: 'prod-db', value: 'secret-host' } }));
    await withClient(async () => true, { resolveAlias }, async (client) => {
      const result = await client.callTool({ name: 'resolve_alias', arguments: { name: 'prod-db' } });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ status: 'error', reason: PARTICIPANT_TURN_TOOL_REFUSAL });
      expect(JSON.stringify(result)).not.toContain('secret-host');
      expect(resolveAlias).not.toHaveBeenCalled();
      // A tool on the allow list still answers.
      const search = await client.callTool({ name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: 'resolve_alias' } });
      expect(search.isError).not.toBe(true);
    });
    await withClient(async () => false, { resolveAlias }, async (client) => {
      const result = await client.callTool({ name: 'resolve_alias', arguments: { name: 'prod-db' } });
      expect(result.isError).not.toBe(true);
      expect(resolveAlias).toHaveBeenCalledTimes(1);
    });
  });

  it('asks per call (the turn changes with every message) and fails closed when the turn cannot be established', async () => {
    const resolveAlias = vi.fn(async () => ({ status: 'ok', found: false }));
    let participant = true;
    await withClient(async () => participant, { resolveAlias }, async (client) => {
      expect((await client.callTool({ name: 'resolve_alias', arguments: { name: 'a' } })).isError).toBe(true);
      participant = false;
      expect((await client.callTool({ name: 'resolve_alias', arguments: { name: 'a' } })).isError).not.toBe(true);
    });
    await withClient(async () => { throw new Error('daemon unreachable'); }, { resolveAlias }, async (client) => {
      const result = await client.callTool({ name: 'resolve_alias', arguments: { name: 'a' } });
      expect(result.structuredContent).toMatchObject({ reason: PARTICIPANT_TURN_TOOL_REFUSAL });
    });
  });

  it('adds no gate where the session has no daemon turn context (unscoped callers, tests)', async () => {
    const resolveAlias = vi.fn(async () => ({ status: 'ok', found: false }));
    await withClient(undefined, { resolveAlias }, async (client) => {
      expect((await client.callTool({ name: 'resolve_alias', arguments: { name: 'a' } })).isError).not.toBe(true);
    });
  });
});

describe('execute-class machine tools on a participant-started turn (tsk_9a8c291594)', () => {
  it('exec_remote, send/fetch file and computer_use_call are refused BEFORE they run; an owner turn reaches them', async () => {
    const execRemote = vi.fn(async () => ({ outcome: 'completed', ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false, truncated: false, durationMs: 1 }));
    const computerUseCall = vi.fn(async () => ({ outcome: 'completed', result: { correlationId: 'cu-12345678', ok: true, tool: 'list_apps', content: [], durationMs: 1 } }));
    const sendFileToMachine = vi.fn(async () => ({ ok: true }));
    const fetchFileFromMachine = vi.fn(async () => ({ ok: true }));
    const machineDeps = {
      listMachines: async () => [{ name: 'node-1', displayName: 'Node', os: 'linux', online: true, execEnabled: true, role: 'controlled' }],
      execRemote, computerUseCall, sendFileToMachine, fetchFileFromMachine,
    };
    const calls: Array<[string, Record<string, unknown>]> = [
      ['exec_remote', { machine: 'node-1', command: 'id' }],
      ['computer_use_call', { machine: 'node-1', tool: 'list_apps' }],
      ['send_file_to_machine', { machine: 'node-1', sourcePath: '/tmp/a' }],
      ['fetch_file_from_machine', { machine: 'node-1', sourcePath: '/tmp/a', destinationPath: '/tmp/b' }],
    ];
    for (const [participantTurn, expectRefused] of [[true, true], [false, false]] as const) {
      const server = createMemoryMcpServer(caller(), { participantTurnRequired: async () => participantTurn, machineDeps: machineDeps as never });
      const client = new Client({ name: 'machine-gate-test', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        for (const [name, args] of calls) {
          // A group is published on demand (one at a time): publish the one this tool belongs to.
          await client.callTool({ name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: `group:${name === 'exec_remote' ? 'managed-machines' : 'file-transfer-computer-use'}` } });
          const result = await client.callTool({ name, arguments: args });
          if (expectRefused) {
            expect(result.structuredContent, name).toMatchObject({ status: 'error', reason: PARTICIPANT_TURN_TOOL_REFUSAL });
          } else {
            expect((result.structuredContent as { reason?: string } | undefined)?.reason, name).not.toBe(PARTICIPANT_TURN_TOOL_REFUSAL);
          }
        }
      } finally {
        await client.close();
        await server.close();
      }
      expect(execRemote).toHaveBeenCalledTimes(expectRefused ? 0 : 1);
      expect(computerUseCall).toHaveBeenCalledTimes(expectRefused ? 0 : 1);
    }
  });
});

describe('participantTurnFromAuthorityHook (the production answer to "whose turn is this")', () => {
  it('is a participant turn when the daemon says required, or cannot say', async () => {
    expect(await participantTurnFromAuthorityHook(async () => ({ ok: true, required: true, authority: 'token' }))()).toBe(true);
    expect(await participantTurnFromAuthorityHook(async () => ({ ok: true, required: true, authority: null }))()).toBe(true);
    expect(await participantTurnFromAuthorityHook(async () => ({ ok: true, required: false, authority: null }))()).toBe(false);
    expect(await participantTurnFromAuthorityHook(async () => { throw new Error('shared_machine_authority_unavailable'); })()).toBe(true);
    expect(await participantTurnFromAuthorityHook(async () => ({}))()).toBe(false);
  });
});
