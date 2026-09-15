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
import { createMemoryMcpServer } from '../../src/daemon/memory-mcp-server.js';
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
): Promise<void> {
  const server = createMemoryMcpServer(runtimeCaller, { capabilityService });
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
      expect(client.getInstructions()).toBeUndefined();
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

  it('starts one install operation and requires explicit user intent for uninstall', async () => {
    const capabilityService = service();
    await withClient(caller(), capabilityService, async (client) => {
      const installed = await client.callTool({
        name: 'capability_install',
        arguments: {
          kind: 'skill',
          source: { kind: 'url', value: 'https://example.test/skill.zip' },
          scope: 'account',
          idempotencyKey: 'install-1',
          userIntent: 'install this Skill',
        },
      });
      expect(installed.structuredContent).toMatchObject({ status: 'ok', operation: { id: 'op-1', state: 'queued' } });
      expect(capabilityService.install).toHaveBeenCalledTimes(1);

      await client.callTool({
        name: 'capability_install',
        arguments: {
          kind: 'mcp',
          source: { kind: 'url', value: 'https://mcp.example.test/rpc' },
          scope: 'account',
          idempotencyKey: 'add-mcp-1',
          userIntent: 'add this MCP',
        },
      });
      expect(capabilityService.install).toHaveBeenLastCalledWith(expect.objectContaining({
        kind: 'mcp',
        userIntent: 'add this MCP',
      }));

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
    });
  });

  it('dispatches exact update and binding identities without accepting cross-owner schema drift', async () => {
    const capabilityService = service();
    vi.mocked(capabilityService.install).mockImplementation(async (input) => input.capabilityId === 'missing-capability'
      ? { status: 'error', reason: CAPABILITY_ERROR.NOT_FOUND, error: 'not found' }
      : {
        status: 'ok', operation: {
          id: 'update-op', kind: input.kind, state: 'queued', revision: 1, scope: input.scope,
          findings: [], providers: [], machines: [], hasScripts: false, hasExecutables: false,
          createdAt: 1, updatedAt: 1,
        },
      });
    await withClient(caller(), capabilityService, async (client) => {
      const exact = {
        kind: 'skill', source: { kind: 'url', value: 'https://example.test/skill.tgz' },
        scope: 'account', idempotencyKey: 'exact-update', capabilityId: 'authority-capability', bindingId: 'authority-binding',
      } as const;
      const updated = await client.callTool({ name: 'capability_install', arguments: exact });
      expect(updated.structuredContent).toMatchObject({ status: 'ok', operation: { id: 'update-op' } });
      expect(capabilityService.install).toHaveBeenLastCalledWith(expect.objectContaining({
        capabilityId: 'authority-capability', bindingId: 'authority-binding', idempotencyKey: 'exact-update',
      }));

      const missing = await client.callTool({
        name: 'capability_install', arguments: { ...exact, capabilityId: 'missing-capability', idempotencyKey: 'missing-update' },
      });
      expect(missing.structuredContent).toMatchObject({ status: 'error', reason: CAPABILITY_ERROR.NOT_FOUND });
      expect(capabilityService.install).toHaveBeenCalledTimes(2);

      await client.callTool({
        name: 'capability_manage',
        arguments: { action: 'disable', capabilityId: 'authority-capability', bindingId: 'project-binding' },
      });
      expect(capabilityService.manage).toHaveBeenLastCalledWith(expect.objectContaining({
        capabilityId: 'authority-capability', bindingId: 'project-binding',
      }));

      const crossOwner = await client.callTool({
        name: 'capability_install',
        arguments: { ...exact, ownerId: 'owner-2', idempotencyKey: 'cross-owner-update' },
      });
      expect(crossOwner).toMatchObject({ isError: true });
      expect(capabilityService.install).toHaveBeenCalledTimes(2);
    });
  });
});
