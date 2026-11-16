import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import type { CapabilityService } from '../../shared/capability-management.js';
import {
  CAPABILITY_ERROR,
  CAPABILITY_MCP_TOOL_CONTRACTS,
  CAPABILITY_MCP_TOOL_NAMES,
} from '../../shared/capability-management.js';
import {
  MCP_TOOL_DISCOVERY_NAME,
} from '../../shared/mcp-tool-discovery.js';
import { MEMORY_MCP_SERVER_INSTRUCTIONS } from '../../shared/mcp-tool-distribution.js';
import { createMemoryMcpServer, mergeDefaultToolDeps } from '../../src/daemon/memory-mcp-server.js';
import { parseMcpRuntimeCallerFromEnv, type McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import { getDefaultMcpServers } from '../../src/agent/providers/getDefaultMcpServers.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../shared/memory-mcp-server-name.js';

function caller(overrides: Partial<McpRuntimeCaller> = {}): McpRuntimeCaller {
  return {
    userId: 'owner-1',
    namespace: { scope: 'user_private', userId: 'owner-1', projectId: 'project-1' },
    sessionName: 'deck_project_brain',
    projectName: 'project',
    projectRoot: '/tmp/project',
    serverId: 'server-1',
    providerId: 'codex-sdk',
    transport: 'in_process',
    ...overrides,
  };
}

function service(): CapabilityService {
  return {
    list: vi.fn(async () => ({ status: 'ok', items: [] })),
    install: vi.fn(async (input) => ({
      status: 'ok',
      operation: {
        id: 'op-1', kind: input.kind, state: 'queued', revision: 1, scope: input.scope,
        findings: [], providers: [], machines: [], hasScripts: false, hasExecutables: false,
        createdAt: 1, updatedAt: 1,
      },
    })),
    status: vi.fn(async () => ({ status: 'ok' })),
    manage: vi.fn(async () => ({ status: 'ok' })),
  };
}

async function withClient(
  runtimeCaller: McpRuntimeCaller,
  capabilityService: CapabilityService | undefined,
  run: (client: Client) => Promise<void>,
  extra: Pick<NonNullable<Parameters<typeof createMemoryMcpServer>[1]>, 'runAgentSkills' | 'runAgentMcp' | 'listAgentMcp' | 'searchAgentMcpRegistry'> = {},
): Promise<void> {
  const server = createMemoryMcpServer(runtimeCaller, { capabilityService, ...extra });
  const client = new Client({ name: 'capability-tools-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await client.callTool({
      name: MCP_TOOL_DISCOVERY_NAME,
      arguments: { query: 'group:capability-management' },
    });
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe('capability MCP tools', () => {
  it('advertises exactly the four capability tools on a registered FULL node', async () => {
    await withClient(caller(), service(), async (client) => {
      const tools = (await client.listTools()).tools;
      expect(client.getInstructions()).toBe(MEMORY_MCP_SERVER_INSTRUCTIONS);
      expect(client.getInstructions()).not.toContain('HIGHEST-PRIORITY IM.codes SERVICE ROUTING POLICY');
      const names = tools.map((tool) => tool.name);
      expect(names.filter((name) => name.startsWith('capability_'))).toEqual([...CAPABILITY_MCP_TOOL_NAMES]);
      for (const name of CAPABILITY_MCP_TOOL_NAMES) {
        const registered = tools.find((tool) => tool.name === name);
        expect(Object.keys(registered?.inputSchema.properties ?? {}).sort()).toEqual(
          Object.keys(CAPABILITY_MCP_TOOL_CONTRACTS[name].inputSchema.properties ?? {}).sort(),
        );
        expect(registered?.inputSchema.additionalProperties).toBe(false);
      }
      const manage = tools.find((tool) => tool.name === 'capability_manage');
      expect(manage?.inputSchema.properties?.action).toMatchObject({
        enum: expect.not.arrayContaining(['delete_credentials']),
      });
      const install = tools.find((tool) => tool.name === 'capability_install');
      expect(install?.description).toContain('compose source.kind=mcp_config');
      expect(install?.inputSchema.properties?.source).toMatchObject({
        properties: {
          kind: { description: expect.stringContaining('Use mcp_config') },
          mcpConfig: { description: expect.stringContaining('no installer URL') },
        },
      });
    });
  });

  it('does not require session owner identity and stays absent without the node service', async () => {
    await withClient(caller({ sessionName: null }), service(), async (client) => {
      expect((await client.listTools()).tools.map((tool) => tool.name))
        .toEqual(expect.arrayContaining([...CAPABILITY_MCP_TOOL_NAMES]));
      await expect(client.callTool({ name: 'capability_list', arguments: {} })).resolves.toMatchObject({
        structuredContent: { status: 'ok', items: [] },
      });
    });
    await withClient(caller(), undefined, async (client) => {
      expect((await client.listTools()).tools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining([...CAPABILITY_MCP_TOOL_NAMES]));
    });
  });

  it('does not add a session/runtime auth gate in front of registered-node operations', async () => {
    const resolveCapabilityIdentity = vi.fn(async () => null);
    const runtimeCaller = caller({
      userId: 'daemon-local',
      namespace: { scope: 'personal', projectId: 'forged-project' },
    });
    const server = createMemoryMcpServer(runtimeCaller, {
      capabilityService: service(),
      resolveCapabilityIdentity,
    });
    const client = new Client({ name: 'dynamic-capability-tools-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      await client.callTool({ name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: 'group:capability-management' } });
      expect((await client.listTools()).tools.map((tool) => tool.name))
        .toEqual(expect.arrayContaining([...CAPABILITY_MCP_TOOL_NAMES]));
      await expect(client.callTool({ name: 'capability_list', arguments: {} })).resolves.toMatchObject({
        structuredContent: { status: 'ok', items: [] },
      });
      await expect(client.callTool({
        name: 'capability_status', arguments: { capabilityId: 'skill-1', activate: true },
      })).resolves.toMatchObject({ structuredContent: { status: 'ok' } });
      expect(resolveCapabilityIdentity).not.toHaveBeenCalled();
      expect((await client.listTools()).tools.map((tool) => tool.name))
        .toEqual(expect.arrayContaining([...CAPABILITY_MCP_TOOL_NAMES]));
      await expect(client.callTool({ name: 'capability_list', arguments: {} })).resolves.toMatchObject({
        structuredContent: { status: 'ok', items: [] },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('refreshes capability_status on the same connection and retains an exact fallback for hosts that ignore list_changed', async () => {
    const capabilityService = service();
    let resolveChanged: ((names: string[]) => void) | undefined;
    const changed = new Promise<string[]>((resolve) => { resolveChanged = resolve; });
    const server = createMemoryMcpServer(caller(), { capabilityService });
    const client = new Client({ name: 'capability-self-refresh-test', version: '1' }, {
      listChanged: {
        tools: {
          debounceMs: 0,
          onChanged: (error, tools) => {
            if (!error && tools?.some((tool) => tool.name === 'capability_status')) {
              resolveChanged?.(tools.map((tool) => tool.name));
            }
          },
        },
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const bootstrap = (await client.listTools()).tools.map((tool) => tool.name);
      expect(bootstrap).not.toContain('capability_status');
      await client.callTool({
        name: MCP_TOOL_DISCOVERY_NAME,
        arguments: { query: 'capability_status' },
      });
      await expect(changed).resolves.toContain('capability_status');
      await expect(client.callTool({
        name: 'capability_status', arguments: { capabilityId: 'skill-1', activate: true },
      })).resolves.toMatchObject({ structuredContent: { status: 'ok' } });

      // A host that ignored the notification can still use the unchanged
      // bootstrap schema on this same connection; no second listTools call is
      // needed for this exact validated invocation.
      await expect(client.callTool({
        name: MCP_TOOL_DISCOVERY_NAME,
        arguments: {
          query: 'capability_status',
          fallbackCall: {
            name: 'capability_status',
            arguments: { capabilityId: 'skill-1', activate: true },
          },
        },
      })).resolves.toMatchObject({ structuredContent: { status: 'ok' } });
      expect(capabilityService.status).toHaveBeenCalledTimes(2);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('carries provider context for Skill resolution without making it a tool authorization gate', async () => {
    const config = getDefaultMcpServers({
      sessionKey: 'route-fallback',
      sessionName: 'deck_fallback_brain',
      projectName: 'fallback',
      serverId: 'server-1',
      providerId: 'codex-sdk',
      cwd: '/authority/project',
      contextNamespace: { scope: 'personal', projectId: 'github.com/acme/project' },
    })[IMCODES_MEMORY_MCP_SERVER_NAME];
    const runtimeCaller = parseMcpRuntimeCallerFromEnv(config.env);
    expect(runtimeCaller).toMatchObject({
      userId: 'daemon-local', sessionName: 'deck_fallback_brain',
      serverId: 'server-1', providerId: 'codex-sdk',
    });

    const resolveCapabilityIdentity = vi.fn(async () => null);
    const server = createMemoryMcpServer(runtimeCaller, {
      capabilityService: service(), resolveCapabilityIdentity,
    });
    const client = new Client({ name: 'provider-env-capability-tools-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      await client.callTool({ name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: 'group:capability-management' } });
      expect((await client.listTools()).tools.map((tool) => tool.name))
        .toEqual(expect.arrayContaining([...CAPABILITY_MCP_TOOL_NAMES]));
      await expect(client.callTool({ name: 'capability_list', arguments: {} })).resolves.toMatchObject({
        structuredContent: { status: 'ok', items: [] },
      });
      await expect(client.callTool({
        name: 'capability_status', arguments: { capabilityId: 'skill-1', activate: true },
      })).resolves.toMatchObject({ structuredContent: { status: 'ok' } });
      expect(resolveCapabilityIdentity).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('installs MCP servers into the agents\' own configs and requires explicit user intent for uninstall', async () => {
    const capabilityService = service();
    const runAgentMcp = vi.fn(async () => ({ ok: true, results: [{ agent: 'claude-code', ok: true }, { agent: 'codex', ok: true }] }));
    await withClient(caller(), capabilityService, async (client) => {
      const remote = await client.callTool({
        name: 'capability_install',
        arguments: {
          kind: 'mcp',
          source: { kind: 'url', value: 'https://mcp.example.test/rpc' },
          scope: 'account',
          idempotencyKey: 'add-mcp-1',
          displayName: 'example',
          userIntent: 'add this MCP',
        },
      });
      expect(remote.structuredContent).toMatchObject({ status: 'ok', server: 'example', agents: [{ agent: 'claude-code', ok: true }, { agent: 'codex', ok: true }] });
      expect(runAgentMcp).toHaveBeenLastCalledWith({ action: 'add', server: { name: 'example', transport: 'http', url: 'https://mcp.example.test/rpc' } });

      await client.callTool({
        name: 'capability_install',
        arguments: {
          kind: 'mcp',
          source: { kind: 'mcp_config', mcpConfig: { name: 'dbhub', transport: 'stdio', command: 'npx', args: ['-y', '@bytebase/dbhub'], env: { DSN: 'postgres://x' } } },
          scope: 'local',
          idempotencyKey: 'add-mcp-2',
        },
      });
      expect(runAgentMcp).toHaveBeenLastCalledWith({ action: 'add', server: { name: 'dbhub', transport: 'stdio', command: 'npx', args: ['-y', '@bytebase/dbhub'], env: { DSN: 'postgres://x' } } });

      const refused = await client.callTool({
        name: 'capability_install',
        arguments: { kind: 'mcp', source: { kind: 'mcp_config', mcpConfig: { name: 'x', transport: 'stdio', command: 'sh -c evil' } }, scope: 'local', idempotencyKey: 'add-mcp-3' },
      });
      expect(refused.structuredContent).toMatchObject({ status: 'error', reason: 'invalid_input' });
      expect(runAgentMcp).toHaveBeenCalledTimes(2);
      // Installs never go through the old managed store.
      expect(capabilityService.install).not.toHaveBeenCalled();

      const denied = await client.callTool({
        name: 'capability_manage',
        arguments: { action: 'uninstall', capabilityId: 'cap-1' },
      });
      expect(denied.structuredContent).toMatchObject({ status: 'error', reason: 'invalid_input' });
      expect(capabilityService.manage).not.toHaveBeenCalled();

      const uninstalled = await client.callTool({
        name: 'capability_manage',
        arguments: {
          action: 'uninstall',
          capabilityId: 'cap-1',
          userIntent: 'uninstall X',
        },
      });
      expect(uninstalled.structuredContent).toMatchObject({ status: 'ok' });
      expect(capabilityService.manage).toHaveBeenCalledWith(expect.objectContaining({
        action: 'uninstall',
        userIntent: 'uninstall X',
      }));
    }, { runAgentMcp });
  });

  it('installs a Skill into ~/.agents/skills on this machine, never through the managed store', async () => {
    const capabilityService = service();
    const runAgentSkills = vi.fn(async () => ({
      ok: true,
      output: 'Installed 2 skills',
      skills: [{ name: 'wecomcli-doc', description: '' }, { name: 'wecomcli-shared', description: '' }],
    }));
    await withClient(caller(), capabilityService, async (client) => {
      const installed = await client.callTool({
        name: 'capability_install',
        arguments: {
          kind: 'skill',
          source: { kind: 'repository', value: 'WeComTeam/wecom-cli' },
          scope: 'local',
          idempotencyKey: 'skill-1',
        },
      });
      expect(installed.structuredContent).toMatchObject({
        status: 'ok',
        installedTo: '~/.agents/skills',
        skills: ['wecomcli-doc', 'wecomcli-shared'],
      });
      expect(runAgentSkills).toHaveBeenCalledWith({ action: 'add', source: 'WeComTeam/wecom-cli' });
      expect(capabilityService.install).not.toHaveBeenCalled();

      const refused = await client.callTool({
        name: 'capability_install',
        arguments: { kind: 'skill', source: { kind: 'local_path', value: '/etc' }, scope: 'local', idempotencyKey: 'skill-2' },
      });
      expect(refused.structuredContent).toMatchObject({ status: 'error', reason: 'invalid_input' });
      expect(runAgentSkills).toHaveBeenCalledTimes(1);
    }, { runAgentSkills });
  });

  it('dispatches exact binding identities to management without accepting cross-owner schema drift', async () => {
    const capabilityService = service();
    await withClient(caller(), capabilityService, async (client) => {
      await client.callTool({
        name: 'capability_manage',
        arguments: { action: 'disable', capabilityId: 'authority-capability', bindingId: 'project-binding' },
      });
      expect(capabilityService.manage).toHaveBeenLastCalledWith(expect.objectContaining({
        capabilityId: 'authority-capability', bindingId: 'project-binding',
      }));

      const crossOwner = await client.callTool({
        name: 'capability_install',
        arguments: {
          kind: 'mcp', source: { kind: 'url', value: 'https://mcp.example.test/rpc' },
          scope: 'account', idempotencyKey: 'cross-owner-update', ownerId: 'owner-2',
        },
      });
      expect(crossOwner).toMatchObject({ isError: true });
      expect(capabilityService.install).not.toHaveBeenCalled();
    });
  });

  it('installs standard Streamable HTTP/SSE/stdio/mcp.json/OpenCode configs without requiring scope or idempotencyKey, respects providers, and surfaces partial success', async () => {
    const capabilityService = service();
    const runAgentMcp = vi.fn(async (req) => {
      if (req.server?.name === 'partial-srv') {
        return {
          ok: false,
          error: 'failed' as const,
          results: [
            { agent: 'claude-code', ok: true },
            { agent: 'cursor', ok: false, error: 'corrupt config' },
          ],
        };
      }
      return {
        ok: true,
        results: (req.agents ?? ['claude-code', 'codex']).map((agent: string) => ({ agent, ok: true })),
      };
    });

    await withClient(caller(), capabilityService, async (client) => {
      // 1. Minimal Streamable HTTP with streamable_http + no scope/idempotencyKey + smart URL host fallback ('mcp.context7.com' -> 'context7')
      const ctx7 = await client.callTool({
        name: 'capability_install',
        arguments: {
          kind: 'mcp',
          source: {
            kind: 'mcp_config',
            mcpConfig: { transport: 'streamable_http', url: 'https://mcp.context7.com/mcp' },
          },
        },
      });
      expect(ctx7.isError).toBe(false);
      expect(ctx7.structuredContent).toMatchObject({ status: 'ok', server: 'context7' });
      expect(runAgentMcp).toHaveBeenLastCalledWith({
        action: 'add',
        server: { name: 'context7', transport: 'http', url: 'https://mcp.context7.com/mcp' },
      });

      // 2. type='sse' + providers filter alias mapping
      const sseRes = await client.callTool({
        name: 'capability_install',
        arguments: {
          kind: 'mcp',
          source: { kind: 'mcp_config', mcpConfig: { name: 'events', type: 'sse', url: 'https://events.example.test/sse' } },
          providers: ['claude-code-sdk', 'gemini'],
        },
      });
      expect(sseRes.isError).toBe(false);
      expect(runAgentMcp).toHaveBeenLastCalledWith({
        action: 'add',
        server: { name: 'events', transport: 'sse', url: 'https://events.example.test/sse' },
        agents: ['claude-code', 'gemini-cli'],
      });

      // 3. Standard mcpServers wrapper + stdio package fallback (@upstash/context7-mcp -> context7-mcp)
      const wrapped = await client.callTool({
        name: 'capability_install',
        arguments: {
          kind: 'mcp',
          source: {
            kind: 'mcp_config',
            mcpConfig: {
              mcpServers: {
                '': {},
              },
            },
          },
        },
      });
      expect(wrapped.isError).toBe(true);

      const validWrapped = await client.callTool({
        name: 'capability_install',
        arguments: {
          kind: 'mcp',
          source: {
            kind: 'mcp_config',
            mcpConfig: {
              mcpServers: {
                sequential: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
              },
            },
          },
        },
      });
      expect(validWrapped.isError).toBe(false);
      expect(validWrapped.structuredContent).toMatchObject({ status: 'ok', server: 'sequential' });

      // 4. Multi-entry mcpServers fails closed
      const multiWrapped = await client.callTool({
        name: 'capability_install',
        arguments: {
          kind: 'mcp',
          source: {
            kind: 'mcp_config',
            mcpConfig: {
              mcpServers: {
                one: { command: 'npx', args: ['-y', 'a'] },
                two: { command: 'npx', args: ['-y', 'b'] },
              },
            },
          },
        },
      });
      expect(multiWrapped.isError).toBe(true);
      expect(multiWrapped.structuredContent).toMatchObject({ status: 'error', reason: 'invalid_input' });

      // 5. OpenCode command array + inferred package name (@upstash/context7-mcp -> context7-mcp)
      const opencode = await client.callTool({
        name: 'capability_install',
        arguments: {
          kind: 'mcp',
          source: {
            kind: 'mcp_config',
            mcpConfig: { type: 'local', command: ['npx', '-y', '@upstash/context7-mcp'] },
          },
        },
      });
      expect(opencode.isError).toBe(false);
      expect(opencode.structuredContent).toMatchObject({ status: 'ok', server: 'context7-mcp' });
      expect(runAgentMcp).toHaveBeenLastCalledWith({
        action: 'add',
        server: { name: 'context7-mcp', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
      });

      // 6. Actionable error when string command contains spaces/flags
      const spacedCmd = await client.callTool({
        name: 'capability_install',
        arguments: {
          kind: 'mcp',
          source: { kind: 'mcp_config', mcpConfig: { command: 'npx -y @upstash/context7-mcp' } },
        },
      });
      expect(spacedCmd.isError).toBe(true);
      expect(spacedCmd.structuredContent).toMatchObject({
        status: 'error',
        reason: 'invalid_input',
        error: expect.stringContaining('pass flags/packages in args'),
      });

      // 7. Partial agent success returns status='ok' with partial=true and detailed agents array
      const partial = await client.callTool({
        name: 'capability_install',
        arguments: {
          kind: 'mcp',
          source: { kind: 'mcp_config', mcpConfig: { name: 'partial-srv', url: 'https://partial.example.test/mcp' } },
        },
      });
      expect(partial.isError).toBe(false);
      expect(partial.structuredContent).toMatchObject({
        status: 'ok',
        partial: true,
        server: 'partial-srv',
        agents: [
          { agent: 'claude-code', ok: true },
          { agent: 'cursor', ok: false, error: 'corrupt config' },
        ],
      });

      // 8. Cleartext non-localhost HTTP URL fails closed
      const cleartext = await client.callTool({
        name: 'capability_install',
        arguments: {
          kind: 'mcp',
          source: { kind: 'mcp_config', mcpConfig: { name: 'insecure', url: 'http://example.com/mcp' } },
        },
      });
      expect(cleartext.isError).toBe(true);
      expect(cleartext.structuredContent).toMatchObject({ status: 'error', reason: 'invalid_input' });
    }, { runAgentMcp });
  });

  it('lists installed MCPs via listAgentMcp, searches official registry via searchRegistry, and uninstalls MCPs via runAgentMcp', async () => {
    const capabilityService = service();
    capabilityService.manage = vi.fn(async () => ({
      status: 'error' as const,
      reason: CAPABILITY_ERROR.NOT_FOUND,
      error: 'not in legacy store',
    }));
    const listAgentMcp = vi.fn(async () => ({
      servers: [
        {
          name: 'context7',
          transport: 'http' as const,
          url: 'https://mcp.context7.com/mcp',
          envNames: [],
          headerNames: [],
          agents: ['claude-code', 'codex'],
        },
        {
          name: 'imcodes-memory',
          transport: 'stdio' as const,
          command: 'imcodes',
          envNames: [],
          headerNames: [],
          agents: ['claude-code'],
        },
      ],
      agents: [{ agent: 'claude-code', displayName: 'Claude Code' }, { agent: 'codex', displayName: 'Codex' }],
    }));
    const searchAgentMcpRegistry = vi.fn(async (query: string) => [
      {
        id: 'io.upstash/context7',
        description: `Registry match for ${query}`,
        remote: { transport: 'http' as const, url: 'https://mcp.context7.com/mcp', headers: [] },
      },
    ]);
    const runAgentMcp = vi.fn(async (req) => {
      if (req.action === 'remove' && req.name === 'context7') {
        return { ok: true, results: [{ agent: 'claude-code', ok: true }, { agent: 'codex', ok: true }] };
      }
      return { ok: false, error: 'failed' as const, results: [] };
    });

    await withClient(caller(), capabilityService, async (client) => {
      // 1. Inventory list returns live installed MCPs + detectedAgents
      const listed = await client.callTool({ name: 'capability_list', arguments: { kind: 'mcp', query: 'context' } });
      expect(listed.isError).toBe(false);
      expect(listed.structuredContent).toMatchObject({
        status: 'ok',
        detectedAgents: [{ agent: 'claude-code', displayName: 'Claude Code' }, { agent: 'codex', displayName: 'Codex' }],
        items: [
          expect.objectContaining({
            id: 'mcp:context7',
            kind: 'mcp',
            name: 'context7',
            state: 'active',
            scope: 'local',
            transport: 'http',
            url: 'https://mcp.context7.com/mcp',
            agents: ['claude-code', 'codex'],
          }),
        ],
      });

      // 2. Registry lookup requires non-empty query
      const badRegistry = await client.callTool({ name: 'capability_list', arguments: { searchRegistry: true } });
      expect(badRegistry.isError).toBe(true);
      expect(badRegistry.structuredContent).toMatchObject({ status: 'error', reason: 'invalid_input' });

      // 3. Registry lookup succeeds
      const registryRes = await client.callTool({ name: 'capability_list', arguments: { searchRegistry: true, query: 'context7' } });
      expect(registryRes.isError).toBe(false);
      expect(searchAgentMcpRegistry).toHaveBeenCalledWith('context7');
      expect(registryRes.structuredContent).toMatchObject({
        status: 'ok',
        registry: true,
        query: 'context7',
        servers: [expect.objectContaining({ id: 'io.upstash/context7' })],
      });

      // 4. Explicit kind='mcp' uninstall removes via runAgentMcp
      const removed = await client.callTool({
        name: 'capability_manage',
        arguments: { action: 'uninstall', kind: 'mcp', name: 'context7', userIntent: 'uninstall context7 MCP' },
      });
      expect(removed.isError).toBe(false);
      expect(removed.structuredContent).toMatchObject({
        status: 'ok',
        removed: 'context7',
        agents: [{ agent: 'claude-code', ok: true }, { agent: 'codex', ok: true }],
      });
      expect(runAgentMcp).toHaveBeenCalledWith({ action: 'remove', name: 'context7' });

      // 5. Fallback uninstall when kind omitted and service.manage returns not_found
      const removedFallback = await client.callTool({
        name: 'capability_manage',
        arguments: { action: 'uninstall', name: 'context7', userIntent: 'remove context7' },
      });
      expect(removedFallback.isError).toBe(false);
      expect(removedFallback.structuredContent).toMatchObject({ status: 'ok', removed: 'context7' });

      // 6. imcodes-memory protection returns reserved_name
      const reserved = await client.callTool({
        name: 'capability_manage',
        arguments: { action: 'uninstall', kind: 'mcp', name: 'imcodes-memory', userIntent: 'remove imcodes-memory' },
      });
      expect(reserved.isError).toBe(true);
      expect(reserved.structuredContent).toMatchObject({ status: 'error', reason: 'reserved_name' });

      // 7. Unknown MCP server uninstall returns not_found
      const missing = await client.callTool({
        name: 'capability_manage',
        arguments: { action: 'uninstall', kind: 'mcp', name: 'does-not-exist', userIntent: 'remove missing' },
      });
      expect(missing.isError).toBe(true);
      expect(missing.structuredContent).toMatchObject({ status: 'error', reason: 'not_found' });
    }, { listAgentMcp, searchAgentMcpRegistry, runAgentMcp });

    // Offline/failing official MCP Registry returns typed error without crashing
    const failingRegistry = vi.fn(async () => { throw new Error('network timeout'); });
    await withClient(caller(), capabilityService, async (client) => {
      const offline = await client.callTool({ name: 'capability_list', arguments: { searchRegistry: true, query: 'context7' } });
      expect(offline.isError).toBe(true);
      expect(offline.structuredContent).toMatchObject({ status: 'error', reason: 'acquisition_failed', retryable: true });
    }, { searchAgentMcpRegistry: failingRegistry });
  });

  it('wires listAgentMcp and searchAgentMcpRegistry alongside default capabilityService in production', () => {
    const prodDeps = mergeDefaultToolDeps(caller(), {});
    expect(typeof prodDeps.capabilityService?.list).toBe('function');
    expect(typeof prodDeps.listAgentMcp).toBe('function');
    expect(typeof prodDeps.searchAgentMcpRegistry).toBe('function');

    const unitDeps = mergeDefaultToolDeps(caller(), { capabilityService: service() });
    expect(unitDeps.listAgentMcp).toBeUndefined();
    expect(unitDeps.searchAgentMcpRegistry).toBeUndefined();
  });
});
